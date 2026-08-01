// P2P peer-sync layer: outbound delivery of chat messages, reactions, and
// typing indicators to known peers via PeerStream over circuit relay.
//
// Peer addresses are derived from the standard relay multiaddr + peerId.
// This works for all peers using node.xorein.com as their relay.
import type { Libp2p } from 'libp2p';
import { callFamily } from '../families/peerstream.js';
import { MAX_FRAME_BYTES } from '../families/peerstream.js';
import { PROTOCOLS } from '../families/families.js';
import {
  isTrustedPeerCircuitMultiaddr,
  isTrustedRelayMultiaddr,
  RELAY_MULTIADDR,
} from '../transport/node.js';
import { getState } from '../state/store.js';
import { resolveFeatureFlag } from '../../config/featureFlags.js';
import type { PrekeyBundle } from '../seal/bundle.js';
import type { XoreinRuntimeMessage } from '../../types.js';
import type { HistoryCoverage } from './swarmHistory.js';
import type { SignedPeerRecord } from './peerDiscovery.js';
import {
  decryptHistoryReplica,
  encryptHistoryReplica,
  historyReplicaNamespace,
  type EncryptedHistoryReplica,
} from './replica.js';
import {
  createRoutedRequest,
  openRoutedResponse,
  type RoutedRequest,
} from './routedRequest.js';

// Derive the expected circuit address for a peer using the standard relay.
function circuitAddr(peerId: string, relayMultiaddr = RELAY_MULTIADDR): string {
  return `${relayMultiaddr}/p2p-circuit/p2p/${peerId}`;
}

// The WebRTC-upgradeable form of a peer's circuit address: dialing this lets DCUtR
// hole-punch the relayed connection up to a direct browser↔browser WebRTC link.
// Only used when the `directTransport` flag is on (the /webrtc transport is loaded).
export function webrtcCircuitAddr(peerId: string, relayMultiaddr = RELAY_MULTIADDR): string {
  return `${relayMultiaddr}/p2p-circuit/webrtc/p2p/${peerId}`;
}

/** True when an address is a WebRTC-upgradeable circuit address. */
function isWebrtcCircuit(addr: string): boolean {
  return addr.includes('/p2p-circuit/webrtc/');
}

function isPeerCircuitAddress(addr: unknown, peerId: string): addr is string {
  return isTrustedPeerCircuitMultiaddr(addr, peerId);
}

/**
 * Choose the best dial address for a peer from the addresses it advertised.
 * Pure so the selection policy is unit-testable. With `directOn`, a
 * WebRTC-upgradeable circuit address wins (DCUtR can hole-punch it to a direct
 * link); otherwise any circuit address; otherwise a synthesized PLAIN circuit
 * fallback against the default relay.
 *
 * COMPAT: the synthesized fallback is deliberately NEVER the /webrtc form. A
 * peer that supports the WebRTC transport advertises its /webrtc circuit addr
 * (presence/join payloads), so the advertised branch covers it; a peer running
 * an older build has no /webrtc listener at all, and dialing the synthesized
 * /webrtc form at it fails outright with no retry — first contact (invite
 * join to the owner, friend request by peer id) would silently degrade to the
 * mailbox/local-stub path.
 */
export function selectPeerAddr(
  advertised: string[],
  peerId: string,
  relayMultiaddr: string,
  directOn: boolean,
): string {
  if (directOn) {
    const wrtc = advertised.find(a => isPeerCircuitAddress(a, peerId) && isWebrtcCircuit(a));
    if (wrtc) return wrtc;
  }
  const anyCircuit = advertised.find(a => isPeerCircuitAddress(a, peerId));
  if (anyCircuit) return anyCircuit;
  return circuitAddr(peerId, isTrustedRelayMultiaddr(relayMultiaddr) ? relayMultiaddr : RELAY_MULTIADDR);
}

function jsonBytes(obj: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (bytes.length > MAX_FRAME_BYTES) throw new RangeError('peer sync payload exceeds frame limit');
  return bytes;
}

/**
 * Resolve as soon as one bounded route branch produces a usable answer.
 *
 * Route fan-out used to be sequential. One silent neighbor could therefore
 * consume the whole route TTL before a healthy next hop was even asked. All
 * branches are already capped at four and carry the same opaque, signed route,
 * so racing them is bounded and does not expose the inner operation.
 */
function firstNonNull<T>(attempts: Array<Promise<T | null>>): Promise<T | null> {
  if (!attempts.length) return Promise.resolve(null);
  return new Promise(resolve => {
    let remaining = attempts.length;
    let settled = false;
    for (const attempt of attempts) {
      void attempt.then(value => {
        if (settled) return;
        if (value !== null) {
          settled = true;
          resolve(value);
          return;
        }
        remaining--;
        if (remaining === 0) {
          settled = true;
          resolve(null);
        }
      }, () => {
        if (settled) return;
        remaining--;
        if (remaining === 0) {
          settled = true;
          resolve(null);
        }
      });
    }
  });
}

function replicaDiversityKey(addresses: string[]): string {
  for (const address of addresses) {
    const ip4 = address.match(/\/ip4\/(\d+)\.(\d+)\./);
    if (ip4) return `ip4:${ip4[1]}.${ip4[2]}`;
    const ip6 = address.match(/\/ip6\/([^/]+)/);
    if (ip6) return `ip6:${ip6[1].split(':').slice(0, 3).join(':')}`;
    const dns = address.match(/\/dns(?:4|6)?\/([^/]+)/);
    if (dns) {
      const labels = dns[1].toLowerCase().split('.');
      return `dns:${labels.slice(-2).join('.')}`;
    }
  }
  return 'unknown';
}

/**
 * Deterministically spread replicas across independently addressed nodes.
 * Archivists win ties; a message-id rotation prevents every record choosing
 * the same first three machines when many nodes are available.
 */
export function selectReplicaTargets(
  messageId: string,
  maxAttempts = 8,
): string[] {
  const candidates = Object.values(getState().peers)
    .filter(peer => peer.role === 'archivist' || peer.role === 'relay')
    .sort((a, b) => {
      const tierA = a.role === 'archivist' ? 0 : 1;
      const tierB = b.role === 'archivist' ? 0 : 1;
      return tierA - tierB || a.peer_id.localeCompare(b.peer_id);
    });
  if (!candidates.length) return [];
  let seed = 0;
  for (let i = 0; i < messageId.length; i++) seed = ((seed * 33) ^ messageId.charCodeAt(i)) >>> 0;
  const offset = seed % candidates.length;
  const rotated = [...candidates.slice(offset), ...candidates.slice(0, offset)];
  const distinct: typeof rotated = [];
  const duplicateDomains: typeof rotated = [];
  const seenDomains = new Set<string>();
  for (const peer of rotated) {
    const key = replicaDiversityKey(peer.addresses ?? []);
    if (key !== 'unknown' && !seenDomains.has(key)) {
      seenDomains.add(key);
      distinct.push(peer);
    } else {
      duplicateDomains.push(peer);
    }
  }
  return [...distinct, ...duplicateDomains]
    .slice(0, Math.max(1, Math.min(16, maxAttempts)))
    .map(peer => peer.peer_id);
}

// ── PeerSync ───────────────────────────────────────────────────────────────

export class PeerSync {
  private node: Libp2p | null = null;
  private relayMultiaddr: string;
  // Override map: when a peer has announced a different address
  private peerAddrs = new Map<string, string>();

  constructor(relayMultiaddr = RELAY_MULTIADDR) {
    this.relayMultiaddr = isTrustedRelayMultiaddr(relayMultiaddr) ? relayMultiaddr : RELAY_MULTIADDR;
  }

  setNode(node: Libp2p): void { this.node = node; }

  /** Update the default relay used to derive a peer's fallback circuit address. */
  setRelay(relayMultiaddr: string): void {
    if (isTrustedRelayMultiaddr(relayMultiaddr)) this.relayMultiaddr = relayMultiaddr;
  }

  /** PeerID pinned by the currently selected relay multiaddr. */
  activeRelayPeerId(): string | null {
    if (!isTrustedRelayMultiaddr(this.relayMultiaddr)) return null;
    const parts = this.relayMultiaddr.split('/p2p/');
    return parts.length > 1 ? parts.at(-1) || null : null;
  }

  /** This node's own reachable circuit addresses (which relay(s) we're on). */
  localCircuitAddrs(): string[] {
    if (!this.node) return [];
    const self = this.node.peerId.toString();
    const circuits = this.node.getMultiaddrs().map(m => m.toString()).filter(s => isPeerCircuitAddress(s, self));
    if (!resolveFeatureFlag('directTransport')) return circuits;
    // Advertise the WebRTC-upgradeable variant of each circuit addr ALONGSIDE
    // the plain form. The /webrtc listener is live whenever directTransport is
    // on, but getMultiaddrs() only reflects the manually-added relay
    // reservation's plain circuit addr — so without this, no peer ever learns
    // we support WebRTC, no direct link is ever dialed, and nothing survives
    // relay loss. Peers on old builds simply ignore the extra addr (their
    // selectPeerAddr picks the plain circuit form).
    const webrtc = circuits
      .filter(s => !s.includes('/webrtc'))
      .map(s => s.replace('/p2p-circuit/', '/p2p-circuit/webrtc/'));
    return [...circuits, ...webrtc.filter(w => !circuits.includes(w))];
  }

  /**
   * Fetch a peer's signed Seal prekey bundle over the relay circuit (the
   * `seal.bundle` op). Returns null if the peer is unreachable or serves no
   * bundle — the caller must then keep the DM local rather than send plaintext.
   */
  async fetchBundle(peerId: string): Promise<PrekeyBundle | null> {
    if (!this.node) return null;
    const resp = await callFamily(
      this.node, this.addrOf(peerId), PROTOCOLS.seal, 'seal.bundle',
      new Uint8Array(0), crypto.randomUUID(),
    ).catch(() => null);
    if (resp?.payload) try {
      const data = JSON.parse(new TextDecoder().decode(resp.payload)) as { ok?: boolean; bundle?: PrekeyBundle };
      if (data?.ok && data.bundle) return data.bundle;
    } catch {
      // Fall through to the encrypted peer-router path.
    }
    const routed = await this.routeRequest<{ ok?: boolean; bundle?: PrekeyBundle }>(
      peerId, PROTOCOLS.seal, 'seal.bundle', {},
    );
    return routed?.ok && routed.bundle ? routed.bundle : null;
  }

  /** Record a peer's actual circuit address (used when they dial us first). */
  registerPeer(peerId: string, addr?: string): void {
    const resolved = addr && isPeerCircuitAddress(addr, peerId)
      ? addr
      : circuitAddr(peerId, this.relayMultiaddr);
    this.peerAddrs.set(peerId, resolved);
  }

  private addrOf(peerId: string): string {
    // 1) an ADVERTISED /webrtc circuit address (presence/join payloads) when
    //    direct transport is on — the peer has PROVEN WebRTC support, and this
    //    form is what lets the transport upgrade to a direct link that
    //    survives relay loss. It must win over the observed override below,
    //    which pins the plain circuit form forever after the first inbound
    //    dial and would otherwise keep every future dial relayed.
    // 2) an address the peer told us directly (inbound dial),
    // 3) a circuit address the peer advertised — encodes THEIR relay, so
    //    cross-relay delivery works,
    // 4) fall back to the default relay (PLAIN circuit — never guess /webrtc
    //    support for an unknown peer; see selectPeerAddr).
    const directOn = resolveFeatureFlag('directTransport');
    const advertised = getState().peers?.[peerId]?.addresses ?? [];
    if (directOn) {
      const wrtc = advertised.find(a => isPeerCircuitAddress(a, peerId) && isWebrtcCircuit(a));
      if (wrtc) return wrtc;
    }
    const direct = this.peerAddrs.get(peerId);
    if (direct) return direct;
    return selectPeerAddr(advertised, peerId, this.relayMultiaddr, directOn);
  }

  private get localPeerId(): string {
    return this.node?.peerId.toString() ?? '';
  }

  private connectedAddress(peerId: string): string | null {
    if (!this.node) return null;
    const connection = this.node.getConnections()
      .find(candidate => candidate.remotePeer?.toString() === peerId);
    return connection?.remoteAddr?.toString() ?? null;
  }

  private routeNeighbors(excluded: ReadonlySet<string>): Array<{ peerId: string; address: string }> {
    if (!this.node) return [];
    const unique = new Map<string, string>();
    for (const connection of this.node.getConnections()) {
      const peerId = connection.remotePeer?.toString();
      const address = connection.remoteAddr?.toString();
      if (!peerId || !address || excluded.has(peerId)) continue;
      const role = getState().peers[peerId]?.role;
      // Dedicated infrastructure does not run the browser peer-router. Keep
      // fan-out on ordinary clients that already have live authenticated paths.
      if (role === 'relay' || role === 'archivist' || role === 'bootstrap') continue;
      unique.set(peerId, address);
    }
    return [...unique].slice(0, 4).map(([peerId, address]) => ({ peerId, address }));
  }

  private async sendRouteHop(
    address: string,
    request: RoutedRequest,
  ): Promise<{ ok?: boolean; response_ciphertext?: string; error?: string } | null> {
    if (!this.node) return null;
    try {
      const response = await callFamily(
        this.node,
        address,
        PROTOCOLS.peer,
        'peer.route',
        jsonBytes(request),
        crypto.randomUUID(),
      );
      if (!response?.payload) return null;
      const decoded = JSON.parse(new TextDecoder().decode(response.payload)) as unknown;
      return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
        ? decoded as { ok?: boolean; response_ciphertext?: string; error?: string }
        : null;
    } catch {
      return null;
    }
  }

  /**
   * Route an operation across the live peer graph when the target is not
   * directly dialable. The inner request and response remain pairwise encrypted.
   */
  async routeRequest<T = Record<string, unknown>>(
    targetPeerId: string,
    protocol: string,
    operation: string,
    payload: Record<string, unknown>,
  ): Promise<T | null> {
    if (!this.node || !targetPeerId || targetPeerId === this.localPeerId) return null;
    const request = createRoutedRequest(targetPeerId, { protocol, operation, payload });
    if (!request) return null;
    const excluded = new Set([this.localPeerId]);
    const direct = this.connectedAddress(targetPeerId);
    const neighbors = [
      ...(direct ? [{ peerId: targetPeerId, address: direct }] : []),
      ...this.routeNeighbors(excluded).filter(peer => peer.peerId !== targetPeerId),
    ].slice(0, 4);
    return firstNonNull(neighbors.map(async neighbor => {
      const response = await this.sendRouteHop(neighbor.address, request);
      if (!response?.ok || typeof response.response_ciphertext !== 'string') return null;
      const opened = openRoutedResponse<T>(request, response.response_ciphertext);
      return opened;
    }));
  }

  /**
   * Continue a verified route received from `previousPeerId`. Called only by
   * the inbound peer.route handler after signature/replay/path validation.
   */
  async forwardRoutedRequest(
    request: RoutedRequest,
    previousPeerId: string,
  ): Promise<{ ok?: boolean; response_ciphertext?: string; error?: string }> {
    if (!this.node || request.path.length >= request.max_hops) {
      return { ok: false, error: 'hop_limit' };
    }
    const forwarded: RoutedRequest = {
      ...request,
      path: [...request.path, this.localPeerId],
    };
    const excluded = new Set([...forwarded.path, previousPeerId]);
    const direct = this.connectedAddress(request.target_peer_id);
    const neighbors = [
      ...(direct ? [{ peerId: request.target_peer_id, address: direct }] : []),
      ...this.routeNeighbors(excluded).filter(peer => peer.peerId !== request.target_peer_id),
    ].slice(0, 4);
    const response = await firstNonNull(neighbors.map(async neighbor => {
      const response = await this.sendRouteHop(neighbor.address, forwarded);
      return response?.ok && typeof response.response_ciphertext === 'string'
        ? response
        : null;
    }));
    return response ?? { ok: false, error: 'no_route' };
  }

  /** Gossip signed peer records with a currently reachable peer or node. */
  async exchangePeersAt(
    peerAddress: string,
    knownPeerIds: string[] = [],
  ): Promise<SignedPeerRecord[] | null> {
    if (!this.node) return null;
    try {
      const resp = await callFamily(
        this.node,
        peerAddress,
        PROTOCOLS.peer,
        'peer.exchange',
        jsonBytes({ known_peer_ids: knownPeerIds.slice(0, 200) }),
        crypto.randomUUID(),
      );
      if (!resp?.payload) return null;
      const decoded = JSON.parse(new TextDecoder().decode(resp.payload)) as unknown;
      const values = Array.isArray(decoded)
        ? decoded
        : decoded && typeof decoded === 'object' && Array.isArray((decoded as { peers?: unknown[] }).peers)
          ? (decoded as { peers: unknown[] }).peers
          : null;
      return values as SignedPeerRecord[] | null;
    } catch {
      return null;
    }
  }

  async exchangePeersWith(
    peerId: string,
    knownPeerIds: string[] = [],
  ): Promise<SignedPeerRecord[] | null> {
    if (!peerId || peerId === this.localPeerId) return null;
    return this.exchangePeersAt(this.addrOf(peerId), knownPeerIds);
  }

  /**
   * Store an opaque, blinded-token mailbox body at the active support relay.
   * The request runs over the existing Noise-authenticated libp2p connection;
   * no unauthenticated browser HTTP mutation endpoint is involved.
   */
  async storeMailboxAtRelay(
    mailboxToken: string,
    body: string,
    deliveryId: string = crypto.randomUUID(),
  ): Promise<boolean> {
    if (!this.node || !isTrustedRelayMultiaddr(this.relayMultiaddr)) return false;
    try {
      const resp = await callFamily(
        this.node,
        this.relayMultiaddr,
        PROTOCOLS.peer,
        'peer.relay.store',
        jsonBytes({
          mailbox_token: mailboxToken,
          id: deliveryId,
          body,
        }),
        crypto.randomUUID(),
      );
      if (resp.error || !resp.payload) return false;
      const decoded = JSON.parse(new TextDecoder().decode(resp.payload)) as { queued?: unknown };
      return decoded.queued === true;
    } catch {
      return false;
    }
  }

  /**
   * Drain opaque mailbox bodies from the active support relay. `null` means
   * the peer service was unavailable; an empty array is a successful drain.
   */
  async drainMailboxAtRelay(mailboxTokens: string[]): Promise<string[] | null> {
    if (!this.node || !isTrustedRelayMultiaddr(this.relayMultiaddr)) return null;
    try {
      const resp = await callFamily(
        this.node,
        this.relayMultiaddr,
        PROTOCOLS.peer,
        'peer.relay.drain',
        jsonBytes({ mailbox_tokens: mailboxTokens }),
        crypto.randomUUID(),
      );
      if (resp.error || !resp.payload) return null;
      const decoded = JSON.parse(new TextDecoder().decode(resp.payload)) as {
        entries?: Array<{ body?: unknown }>;
      };
      if (!Array.isArray(decoded.entries) || decoded.entries.length > 100) return null;
      const bodies: string[] = [];
      for (const entry of decoded.entries) {
        if (typeof entry?.body !== 'string') return null;
        bodies.push(entry.body);
      }
      return bodies;
    } catch {
      return null;
    }
  }

  /**
   * Store one recipient-addressed sealed packet on the selected support node.
   * The node validates the daily token against `recipientPeerId`, but cannot
   * decrypt or forge the packet body.
   */
  async storeInboxAtRelay(
    recipientPeerId: string,
    inboxToken: string,
    body: string,
    deliveryId: string = crypto.randomUUID(),
  ): Promise<boolean> {
    if (!this.node || !isTrustedRelayMultiaddr(this.relayMultiaddr)) return false;
    try {
      const resp = await callFamily(
        this.node,
        this.relayMultiaddr,
        PROTOCOLS.peer,
        'peer.inbox.store',
        jsonBytes({
          recipient_peer_id: recipientPeerId,
          token: inboxToken,
          id: deliveryId,
          body,
        }),
        crypto.randomUUID(),
      );
      if (resp.error || !resp.payload) return false;
      const decoded = JSON.parse(new TextDecoder().decode(resp.payload)) as {
        ok?: unknown;
        queued?: unknown;
      };
      return decoded.queued === true && decoded.ok !== false;
    } catch {
      return false;
    }
  }

  /**
   * Read recipient-inbox packets from the selected node, optionally
   * acknowledging packets that were already applied locally. Requests stay
   * split into four-token batches for compatibility with older Xorein relays.
   */
  async drainInboxAtRelay(
    inboxTokens: string[],
    acknowledgeIds: string[] = [],
  ): Promise<string[] | null> {
    if (!this.node || !isTrustedRelayMultiaddr(this.relayMultiaddr)) return null;
    const bodies: string[] = [];
    let answered = false;
    const ackBatches = acknowledgeIds.length > 0
      ? Array.from(
        { length: Math.ceil(acknowledgeIds.length / 64) },
        (_, index) => acknowledgeIds.slice(index * 64, (index + 1) * 64),
      )
      : [[]];
    for (let offset = 0; offset < inboxTokens.length; offset += 4) {
      for (const ackBatch of ackBatches) {
        try {
          const resp = await callFamily(
            this.node,
            this.relayMultiaddr,
            PROTOCOLS.peer,
            'peer.inbox.drain',
            jsonBytes({
              tokens: inboxTokens.slice(offset, offset + 4),
              ...(ackBatch.length > 0 ? { acknowledge_ids: ackBatch } : {}),
            }),
            crypto.randomUUID(),
          );
          if (resp.error || !resp.payload) continue;
          const decoded = JSON.parse(new TextDecoder().decode(resp.payload)) as {
            entries?: Array<{ body?: unknown }>;
          };
          if (!Array.isArray(decoded.entries) || decoded.entries.length > 100) continue;
          const batch: string[] = [];
          for (const entry of decoded.entries) {
            if (typeof entry?.body !== 'string') {
              batch.length = 0;
              break;
            }
            batch.push(entry.body);
          }
          answered = true;
          bodies.push(...batch);
        } catch {
          // Try the remaining token windows; another provider may still answer.
        }
      }
    }
    return answered ? bodies : null;
  }

  /**
   * Publish our reachable addresses under a member-secret rendezvous namespace.
   * Xorein binds the registration to the Noise-authenticated local PeerID.
   */
  async registerRendezvousAtRelay(
    namespace: string,
    addrs: string[],
    ttlSeconds = 7200,
  ): Promise<boolean> {
    if (!this.node || !isTrustedRelayMultiaddr(this.relayMultiaddr)) return false;
    try {
      const resp = await callFamily(
        this.node,
        this.relayMultiaddr,
        PROTOCOLS.peer,
        'peer.rendezvous.register',
        jsonBytes({ namespace, addrs, ttl_seconds: ttlSeconds }),
        crypto.randomUUID(),
      );
      if (resp.error || !resp.payload) return false;
      const decoded = JSON.parse(new TextDecoder().decode(resp.payload)) as { ok?: unknown };
      return decoded.ok === true;
    } catch {
      return false;
    }
  }

  /**
   * Discover reachable members through the authenticated relay protocol.
   * `null` means this relay does not provide rendezvous.
   */
  async discoverRendezvousAtRelay(
    namespace: string,
    limit = 50,
  ): Promise<Array<{ peer_id: string; addrs: string[]; ttl_remaining_seconds: number }> | null> {
    if (!this.node || !isTrustedRelayMultiaddr(this.relayMultiaddr)) return null;
    try {
      const resp = await callFamily(
        this.node,
        this.relayMultiaddr,
        PROTOCOLS.peer,
        'peer.rendezvous.discover',
        jsonBytes({ namespace, limit }),
        crypto.randomUUID(),
      );
      if (resp.error || !resp.payload) return null;
      const decoded = JSON.parse(new TextDecoder().decode(resp.payload)) as { peers?: unknown };
      if (!Array.isArray(decoded.peers) || decoded.peers.length > 200) return null;
      const peers: Array<{ peer_id: string; addrs: string[]; ttl_remaining_seconds: number }> = [];
      for (const value of decoded.peers) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        const peer = value as { peer_id?: unknown; addrs?: unknown; ttl_remaining_seconds?: unknown };
        if (typeof peer.peer_id !== 'string'
          || !Array.isArray(peer.addrs)
          || peer.addrs.some(address => typeof address !== 'string')
          || typeof peer.ttl_remaining_seconds !== 'number') return null;
        peers.push({
          peer_id: peer.peer_id,
          addrs: peer.addrs as string[],
          ttl_remaining_seconds: peer.ttl_remaining_seconds,
        });
      }
      return peers;
    } catch {
      return null;
    }
  }

  /** Authenticate a candidate address and learn its current role/capabilities. */
  async peerInfoAt(peerAddress: string): Promise<{
    peer_id?: string;
    role?: string;
    addresses?: string[];
    capabilities?: string[];
  } | null> {
    if (!this.node) return null;
    try {
      const resp = await callFamily(
        this.node,
        peerAddress,
        PROTOCOLS.peer,
        'peer.info',
        new Uint8Array(0),
        crypto.randomUUID(),
      );
      if (!resp?.payload) return null;
      const decoded = JSON.parse(new TextDecoder().decode(resp.payload)) as unknown;
      return decoded && typeof decoded === 'object' && !Array.isArray(decoded)
        ? decoded as { peer_id?: string; role?: string; addresses?: string[]; capabilities?: string[] }
        : null;
    } catch {
      return null;
    }
  }

  // ── Server join (pull manifest/channels/history from the owner) ─────────

  /**
   * Dial the server owner over the relay circuit and request to join, returning
   * the owner-served snapshot `{ ok, server, messages }` (or null if unreachable).
   * This is the joiner half of P2P invite-join.
   */
  async joinServer(
    ownerPeerId: string,
    serverId: string,
    displayName?: string,
    inviteToken?: string,
  ): Promise<{ ok?: boolean; error?: string; server?: unknown; messages?: unknown[]; addresses?: string[] } | null> {
    if (!this.node) return null;
    const payload = {
      server_id: serverId,
      peer_id: this.localPeerId,
      display_name: displayName,
      invite_token: inviteToken,
      // Advertise our reachable circuit addresses so the owner can reach us back
      // even if we're on a different relay.
      addresses: this.localCircuitAddrs(),
    };
    try {
      const resp = await callFamily(
        this.node,
        this.addrOf(ownerPeerId),
        PROTOCOLS.sync,
        'sync.join',
        jsonBytes(payload),
        crypto.randomUUID(),
      );
      if (resp.payload) {
        return JSON.parse(new TextDecoder().decode(resp.payload)) as {
          ok?: boolean; error?: string; server?: unknown; messages?: unknown[]; addresses?: string[];
        };
      }
    } catch {
      // Try the live peer graph below.
    }
    return this.routeRequest(
      ownerPeerId, PROTOCOLS.sync, 'sync.join', payload,
    );
  }

  /**
   * Pull a page of older history for a server we already belong to, from any
   * reachable member (owner or a peer). `before` is a created_at ISO cursor
   * (exclusive); the responder returns up to `limit` messages that precede it plus
   * a `has_more` flag. Returns null if the peer is unreachable or declined.
   */
  async pullHistory(
    fromPeerId: string,
    serverId: string,
    channelId: string,
    before: string,
    beforeId: string,
    limit: number,
    inviteToken?: string,
  ): Promise<{ ok?: boolean; messages?: unknown[]; has_more?: boolean } | null> {
    if (!this.node || fromPeerId === this.localPeerId) return null;
    const payload = {
      server_id: serverId,
      channel_id: channelId,
      peer_id: this.localPeerId,
      before,
      before_id: beforeId,
      limit,
      invite_token: inviteToken,
      addresses: this.localCircuitAddrs(),
    };
    try {
      const resp = await callFamily(
        this.node,
        this.addrOf(fromPeerId),
        PROTOCOLS.sync,
        'sync.pull',
        jsonBytes(payload),
        crypto.randomUUID(),
      );
      if (!resp?.payload) return null;
      return JSON.parse(new TextDecoder().decode(resp.payload)) as { ok?: boolean; messages?: unknown[]; has_more?: boolean };
    } catch {
      return this.routeRequest(fromPeerId, PROTOCOLS.sync, 'sync.pull', payload);
    }
  }

  /** Ask one member/node which signed records it can serve for this page. */
  async historyCoverage(
    fromPeerId: string,
    serverId: string,
    channelId: string,
    before: string,
    beforeId: string,
    limit: number,
  ): Promise<HistoryCoverage | null> {
    if (!this.node || fromPeerId === this.localPeerId) return null;
    try {
      const role = getState().peers[fromPeerId]?.role;
      if (role === 'relay' || role === 'archivist') {
        const namespace = historyReplicaNamespace(serverId, channelId);
        if (!namespace) return null;
        const resp = await callFamily(
          this.node,
          this.addrOf(fromPeerId),
          PROTOCOLS.sync,
          'sync.replica.coverage',
          jsonBytes({ namespace, before, before_id: beforeId, limit }),
          crypto.randomUUID(),
        );
        if (!resp?.payload) return null;
        const data = JSON.parse(new TextDecoder().decode(resp.payload)) as HistoryCoverage;
        return data.ok && Array.isArray(data.entries) ? data : null;
      }
      const payload = {
        server_id: serverId,
        channel_id: channelId,
        before,
        before_id: beforeId,
        limit,
        addresses: this.localCircuitAddrs(),
      };
      const resp = await callFamily(
        this.node,
        this.addrOf(fromPeerId),
        PROTOCOLS.sync,
        'sync.coverage',
        jsonBytes(payload),
        crypto.randomUUID(),
      );
      if (!resp?.payload) return null;
      return JSON.parse(new TextDecoder().decode(resp.payload)) as HistoryCoverage;
    } catch {
      const role = getState().peers[fromPeerId]?.role;
      if (role === 'relay' || role === 'archivist') return null;
      return this.routeRequest(fromPeerId, PROTOCOLS.sync, 'sync.coverage', {
        server_id: serverId,
        channel_id: channelId,
        before,
        before_id: beforeId,
        limit,
        addresses: this.localCircuitAddrs(),
      });
    }
  }

  /** Fetch the exact IDs assigned to this provider by the swarm scheduler. */
  async fetchHistoryRecords(
    fromPeerId: string,
    serverId: string,
    channelId: string,
    messageIds: string[],
  ): Promise<XoreinRuntimeMessage[] | null> {
    if (!this.node || fromPeerId === this.localPeerId || !messageIds.length) return null;
    try {
      const role = getState().peers[fromPeerId]?.role;
      if (role === 'relay' || role === 'archivist') {
        const namespace = historyReplicaNamespace(serverId, channelId);
        if (!namespace) return null;
        const resp = await callFamily(
          this.node,
          this.addrOf(fromPeerId),
          PROTOCOLS.sync,
          'sync.replica.fetch',
          jsonBytes({ namespace, message_ids: messageIds.slice(0, 100) }),
          crypto.randomUUID(),
        );
        if (!resp?.payload) return null;
        const data = JSON.parse(new TextDecoder().decode(resp.payload)) as {
          ok?: boolean;
          replicas?: EncryptedHistoryReplica[];
        };
        if (!data.ok || !Array.isArray(data.replicas)) return null;
        return data.replicas
          .map(replica => decryptHistoryReplica(replica, serverId, channelId))
          .filter((message): message is XoreinRuntimeMessage => message !== null);
      }
      const resp = await callFamily(
        this.node,
        this.addrOf(fromPeerId),
        PROTOCOLS.sync,
        'sync.fetch',
        jsonBytes({
          server_id: serverId,
          channel_id: channelId,
          message_ids: messageIds.slice(0, 100),
          addresses: this.localCircuitAddrs(),
        }),
        crypto.randomUUID(),
      );
      if (!resp?.payload) return null;
      const data = JSON.parse(new TextDecoder().decode(resp.payload)) as {
        ok?: boolean;
        messages?: XoreinRuntimeMessage[];
      };
      return data.ok && Array.isArray(data.messages) ? data.messages : null;
    } catch {
      const role = getState().peers[fromPeerId]?.role;
      if (role === 'relay' || role === 'archivist') return null;
      const routed = await this.routeRequest<{
        ok?: boolean;
        messages?: XoreinRuntimeMessage[];
      }>(fromPeerId, PROTOCOLS.sync, 'sync.fetch', {
        server_id: serverId,
        channel_id: channelId,
        message_ids: messageIds.slice(0, 100),
        addresses: this.localCircuitAddrs(),
      });
      return routed?.ok && Array.isArray(routed.messages) ? routed.messages : null;
    }
  }

  /**
   * Store one freshly encrypted author-signed history record on an untrusted
   * support node. A true result means only "this node acknowledged a copy".
   */
  async storeHistoryReplica(
    nodePeerId: string,
    message: XoreinRuntimeMessage,
  ): Promise<boolean> {
    if (!this.node || nodePeerId === this.localPeerId) return false;
    const role = getState().peers[nodePeerId]?.role;
    if (role !== 'relay' && role !== 'archivist') return false;
    const replica = encryptHistoryReplica(message);
    if (!replica) return false;
    try {
      const resp = await callFamily(
        this.node,
        this.addrOf(nodePeerId),
        PROTOCOLS.sync,
        'sync.replica.store',
        jsonBytes({ namespace: replica.namespace, replicas: [replica] }),
        crypto.randomUUID(),
      );
      if (!resp?.payload) return false;
      const result = JSON.parse(new TextDecoder().decode(resp.payload)) as {
        ok?: boolean;
        accepted_count?: number;
        duplicate_count?: number;
        rejected_count?: number;
      };
      return result.ok === true
        && (Number(result.accepted_count) + Number(result.duplicate_count)) >= 1
        && Number(result.rejected_count ?? 0) === 0;
    } catch {
      return false;
    }
  }

  /**
   * Repair one record toward three node-held copies. Failed nodes are skipped
   * and later candidates are tried; periodic engine scans retry deficits when
   * new infrastructure appears.
   */
  async repairHistoryReplica(
    message: XoreinRuntimeMessage,
    targetCopies = 3,
  ): Promise<{ acknowledgements: number; attempted: number }> {
    const target = Math.max(1, Math.min(5, Math.floor(targetCopies)));
    const candidates = selectReplicaTargets(message.id, Math.max(8, target));
    let acknowledgements = 0;
    let attempted = 0;
    for (const peerId of candidates) {
      if (acknowledgements >= target) break;
      attempted++;
      if (await this.storeHistoryReplica(peerId, message)) acknowledgements++;
    }
    return { acknowledgements, attempted };
  }

  // ── Outbound: broadcast to scope members ───────────────────────────────

  /**
   * Deliver one payload to all scope members except self. Returns the peer ids
   * that could NOT be reached (so the caller can fall back to the offline mailbox).
   */
  async broadcastToScope(
    memberPeerIds: string[],
    protocol: string,
    operation: string,
    payload: unknown,
  ): Promise<string[]> {
    if (!this.node) return memberPeerIds.filter(p => p !== this.localPeerId);
    const self = this.localPeerId;
    const targets = memberPeerIds.filter(p => p !== self);
    const undelivered: string[] = [];
    await Promise.allSettled(
      targets.map(async peerId => {
        try {
          await callFamily(
            this.node!,
            this.addrOf(peerId),
            protocol,
            operation,
            jsonBytes(payload),
            crypto.randomUUID(),
          );
        } catch {
          const routed = payload && typeof payload === 'object' && !Array.isArray(payload)
            ? await this.routeRequest<Record<string, unknown>>(
              peerId, protocol, operation, payload as Record<string, unknown>,
            )
            : null;
          if (routed?.ok !== true) undelivered.push(peerId);
        }
      }),
    );
    return undelivered;
  }

  /**
   * Deliver one (already-encrypted) payload to a single peer over the chat
   * family. Returns true on success, false if the peer was unreachable.
   */
  async sendToPeer(peerId: string, protocol: string, operation: string, payload: unknown): Promise<boolean> {
    if (!this.node || peerId === this.localPeerId) return false;
    try {
      await callFamily(this.node, this.addrOf(peerId), protocol, operation, jsonBytes(payload), crypto.randomUUID());
      return true;
    } catch {
      const routed = payload && typeof payload === 'object' && !Array.isArray(payload)
        ? await this.routeRequest<Record<string, unknown>>(
          peerId, protocol, operation, payload as Record<string, unknown>,
        )
        : null;
      return routed?.ok === true;
    }
  }

  /**
   * Request/response to a single peer: send one payload and parse the peer's JSON
   * response payload. Returns null if unreachable or the response is empty/invalid.
   * Used by the voice mesh (offer→answer, presence→state).
   */
  async requestPeer<T = Record<string, unknown>>(
    peerId: string,
    protocol: string,
    operation: string,
    payload: unknown,
  ): Promise<T | null> {
    if (!this.node || peerId === this.localPeerId) return null;
    try {
      const resp = await callFamily(this.node, this.addrOf(peerId), protocol, operation, jsonBytes(payload), crypto.randomUUID());
      if (!resp?.payload) return null;
      return JSON.parse(new TextDecoder().decode(resp.payload)) as T;
    } catch {
      return payload && typeof payload === 'object' && !Array.isArray(payload)
        ? this.routeRequest<T>(peerId, protocol, operation, payload as Record<string, unknown>)
        : null;
    }
  }

  /**
   * Request/response fan-out to many peers (except self). Returns one entry per
   * peer that replied with a parseable JSON payload. Unreachable/empty peers are
   * dropped. Used to discover who is already in a voice channel.
   */
  async requestScope<T = Record<string, unknown>>(
    memberPeerIds: string[],
    protocol: string,
    operation: string,
    payload: unknown,
  ): Promise<Array<{ peerId: string; response: T }>> {
    if (!this.node) return [];
    const self = this.localPeerId;
    const targets = Array.from(new Set(memberPeerIds)).filter(p => p && p !== self);
    const out: Array<{ peerId: string; response: T }> = [];
    await Promise.allSettled(
      targets.map(async peerId => {
        const response = await this.requestPeer<T>(peerId, protocol, operation, payload);
        if (response) out.push({ peerId, response });
      }),
    );
    return out;
  }

  /** Send a chat message to all channel members. */
  async broadcastChatMessage(opts: {
    memberPeerIds: string[];
    messageId: string;
    scopeId: string;
    scopeType: 'channel' | 'dm';
    senderPeerId: string;
    body: string;
  }): Promise<void> {
    // This legacy helper used to put a UTF-8 message body directly on the
    // PeerStream. Keeping a callable plaintext path makes future callers able
    // to bypass the encrypted mutation pipeline by accident. The production
    // path sends a mode-specific secure envelope through broadcastToScope.
    void opts;
    throw new Error('plaintext chat broadcast disabled; send an encrypted envelope');
  }

  /** Broadcast a reaction event as a notify.push to all scope members. */
  async broadcastReaction(opts: {
    memberPeerIds: string[];
    scopeId: string;
    messageId: string;
    emoji: string;
    fromPeerId: string;
    action: 'add' | 'remove';
  }): Promise<void> {
    await this.broadcastToScope(opts.memberPeerIds, PROTOCOLS.notify, 'notify.push', {
      kind: 'reaction',
      scope_id: opts.scopeId,
      message_id: opts.messageId,
      emoji: opts.emoji,
      from_peer_id: opts.fromPeerId,
      action: opts.action,
      timestamp: new Date().toISOString(),
    });
  }

  /** Broadcast a typing indicator (via presence.update) to scope members. */
  async broadcastTyping(opts: {
    memberPeerIds: string[];
    peerId: string;
    scopeId: string;
    isTyping: boolean;
    /** Actual user status to propagate alongside the typing flag. Defaults to 'online'. */
    status?: string;
    status_text?: string;
  }): Promise<void> {
    // Ride our profile (display name + avatar) along with presence so peers learn
    // it opportunistically — this is how a custom avatar reaches everyone.
    const profile = getState().identity?.profile ?? {};
    await this.broadcastToScope(opts.memberPeerIds, PROTOCOLS.presence, 'presence.update', {
      peer_id: opts.peerId,
      status: opts.status ?? 'online',
      ...(opts.status_text !== undefined ? { status_text: opts.status_text } : {}),
      is_typing: opts.isTyping,
      typing_in_scope: opts.isTyping ? opts.scopeId : undefined,
      updated_at: new Date().toISOString(),
      ...(profile.display_name ? { display_name: profile.display_name } : {}),
      ...(profile.avatar ? { avatar: profile.avatar } : {}),
      // Advertise our circuit addresses so members on other relays can reach us.
      addresses: this.localCircuitAddrs(),
    });
  }
}
