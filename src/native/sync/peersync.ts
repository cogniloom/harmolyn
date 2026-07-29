// P2P peer-sync layer: outbound delivery of chat messages, reactions, and
// typing indicators to known peers via PeerStream over circuit relay.
//
// Peer addresses are derived from the standard relay multiaddr + peerId.
// This works for all peers using node.xorein.com as their relay.
import type { Libp2p } from 'libp2p';
import { callFamily } from '../families/peerstream.js';
import { MAX_FRAME_BYTES } from '../families/peerstream.js';
import { PROTOCOLS } from '../families/families.js';
import { RELAY_MULTIADDR } from '../transport/node.js';
import { getState } from '../state/store.js';
import { resolveFeatureFlag } from '../../config/featureFlags.js';
import type { PrekeyBundle } from '../seal/bundle.js';
import { hasControlCharacters } from '../security/limits.js';

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
  return typeof addr === 'string'
    && addr.length <= 1024
    && !hasControlCharacters(addr)
    && addr.includes('/p2p-circuit')
    && addr.endsWith(`/p2p/${peerId}`);
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
  return circuitAddr(peerId, relayMultiaddr);
}

function jsonBytes(obj: unknown): Uint8Array {
  const bytes = new TextEncoder().encode(JSON.stringify(obj));
  if (bytes.length > MAX_FRAME_BYTES) throw new RangeError('peer sync payload exceeds frame limit');
  return bytes;
}

// ── PeerSync ───────────────────────────────────────────────────────────────

export class PeerSync {
  private node: Libp2p | null = null;
  private relayMultiaddr: string;
  // Override map: when a peer has announced a different address
  private peerAddrs = new Map<string, string>();

  constructor(relayMultiaddr = RELAY_MULTIADDR) {
    this.relayMultiaddr = relayMultiaddr;
  }

  setNode(node: Libp2p): void { this.node = node; }

  /** Update the default relay used to derive a peer's fallback circuit address. */
  setRelay(relayMultiaddr: string): void { this.relayMultiaddr = relayMultiaddr; }

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
    if (!resp?.payload) return null;
    try {
      const data = JSON.parse(new TextDecoder().decode(resp.payload)) as { ok?: boolean; bundle?: PrekeyBundle };
      return data?.ok && data.bundle ? data.bundle : null;
    } catch {
      return null;
    }
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
    const resp = await callFamily(
      this.node,
      this.addrOf(ownerPeerId),
      PROTOCOLS.sync,
      'sync.join',
      jsonBytes({
        server_id: serverId,
        peer_id: this.localPeerId,
        display_name: displayName,
        invite_token: inviteToken,
        // Advertise our reachable circuit addresses so the owner can reach us back
        // even if we're on a different relay.
        addresses: this.localCircuitAddrs(),
      }),
      crypto.randomUUID(),
    );
    if (!resp.payload) return null;
    try {
      return JSON.parse(new TextDecoder().decode(resp.payload)) as { ok?: boolean; error?: string; server?: unknown; messages?: unknown[]; addresses?: string[] };
    } catch {
      return null;
    }
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
    try {
      const resp = await callFamily(
        this.node,
        this.addrOf(fromPeerId),
        PROTOCOLS.sync,
        'sync.pull',
        jsonBytes({
          server_id: serverId,
          channel_id: channelId,
          peer_id: this.localPeerId,
          before,
          before_id: beforeId,
          limit,
          invite_token: inviteToken,
          addresses: this.localCircuitAddrs(),
        }),
        crypto.randomUUID(),
      );
      if (!resp?.payload) return null;
      return JSON.parse(new TextDecoder().decode(resp.payload)) as { ok?: boolean; messages?: unknown[]; has_more?: boolean };
    } catch {
      return null;
    }
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
      targets.map(peerId =>
        callFamily(
          this.node!,
          this.addrOf(peerId),
          protocol,
          operation,
          jsonBytes(payload),
          crypto.randomUUID(),
        ).catch(() => { undelivered.push(peerId); }),
      ),
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
      return false;
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
      return null;
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
