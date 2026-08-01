// Browser-native libp2p node for the xorein P2P network.
//
// Uses WebSocket for the initial relay connection (browser→node) and
// circuit-relay-v2 for browser↔browser relayed connections.
// The Noise prologue must match the Go xorein node exactly for handshakes to succeed.
import { createLibp2p } from 'libp2p';
import { webSockets } from '@libp2p/websockets';
import { webTransport } from '@libp2p/webtransport';
import { webRTC } from '@libp2p/webrtc';
import { circuitRelayTransport } from '@libp2p/circuit-relay-v2';
import { dcutr } from '@libp2p/dcutr';
import { noise } from '@chainsafe/libp2p-noise';
import { yamux } from '@chainsafe/libp2p-yamux';
import { identify } from '@libp2p/identify';
import { ping } from '@libp2p/ping';
import { multiaddr } from '@multiformats/multiaddr';
import { peerIdFromString } from '@libp2p/peer-id';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { resolveFeatureFlag } from '../../config/featureFlags.js';
import { isPrivateNetworkHostname } from '../../lib/trustedOrigin.js';
import { supportNodeOrigin } from '../nodeOrigin.js';
import { hasControlCharacters } from '../security/limits.js';
import { AETHER_NOISE_PROLOGUE } from './prologue.js';
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import type { Multiaddr } from '@multiformats/multiaddr';
import type { XoreinIdentity } from '../identity/identity.js';

// Minimal slice of @libp2p/circuit-relay-v2 ReservationStore needed to call addRelay().
// Using a local interface avoids the deep dist/ import (not in the package exports map)
// while still providing type safety over the `as any` approach.
interface CircuitRelayReservationStore {
  addRelay(peerId: PeerId, type: 'discovered' | 'configured'): Promise<unknown>;
  removeEventListener?(type: string, listener: EventListener): void;
}
interface CircuitRelayTransport {
  readonly [Symbol.toStringTag]: string;
  reservationStore: CircuitRelayReservationStore;
}
interface CircuitRelayListener {
  reservationStore?: CircuitRelayReservationStore;
  getAddrs(): Multiaddr[];
  close(): Promise<void>;
  _onAddRelayPeer?: EventListener;
}
interface InternalTransportManager {
  getTransports(): unknown[];
  getListeners(): unknown[];
  listen(addrs: Multiaddr[]): Promise<void>;
}
interface InternalAddressManager {
  removeObservedAddr(addr: Multiaddr): void;
}
interface InternalNodeComponents {
  transportManager?: InternalTransportManager;
  addressManager?: InternalAddressManager;
}

export type { Libp2p } from 'libp2p';

// The xorein relay node's peer ID. Override at build time via VITE_RELAY_PEER_ID so
// staging/testnet builds can target a different relay without a code change. Update
// the default if the production node identity is rotated.
export const RELAY_PEER_ID: string =
  import.meta.env.VITE_RELAY_PEER_ID ?? '12D3KooWGWC3A4KawRYn9Mcyt9LjDg6TS7vF5uju7v6gTFsrEBS4';

// Full multiaddr browsers use to reach the relay. Override via VITE_RELAY_MULTIADDR.
// Default: Traefik TLS → WS → relay node (port 9999).
export const RELAY_MULTIADDR: string =
  import.meta.env.VITE_RELAY_MULTIADDR ?? `/dns4/node.xorein.com/tcp/9999/wss/p2p/${RELAY_PEER_ID}`;

// How long to wait for the relay dial + Noise + yamux handshake (ms).
const RELAY_DIAL_TIMEOUT_MS = 30_000;

// How long to wait for the circuit relay HOP reservation after dialing (ms).
const RELAY_RESERVATION_TIMEOUT_MS = 30_000;

export interface XoreinNodeOptions {
  /** Override the relay multiaddr (for testing against a local node). */
  relayMultiaddr?: string;
  /**
   * Relay addresses that are explicitly trusted for circuit paths. This is
   * supplied by the transport manager from the configured failover list; a
   * peer-advertised circuit is never trusted merely because it ends in a peer
   * ID.
   */
  trustedRelayMultiaddrs?: string[];
  /** Mutable exact-address allow-list for signed discovery candidates under probe. */
  dialableCandidateMultiaddrs?: Set<string>;
  /** Mutable relay allow-list; confirmed relays may be added after node creation. */
  dialableRelayMultiaddrs?: Set<string>;
  /** Use an existing identity so the libp2p PeerID is stable across sessions. */
  identity?: XoreinIdentity;
}

const MAX_RELAY_MULTIADDR_BYTES = 1024;

/**
 * Validate a relay address before it can become an outbound dial target.
 * Public relays must use encrypted WebSockets or QUIC/WebTransport. Plain
 * WebSockets are accepted on loopback/private LANs (libp2p Noise still encrypts
 * and authenticates the stream). The final /p2p component
 * is required so Noise authenticates the expected relay peer instead of an
 * arbitrary endpoint.
 */
export function isTrustedRelayMultiaddr(value: unknown, expectedPeerId?: string): value is string {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw || raw.length > MAX_RELAY_MULTIADDR_BYTES || hasControlCharacters(raw)) return false;

  try {
    const components = multiaddr(raw).getComponents();
    const peer = components.at(-1);
    if (!peer || peer.name !== 'p2p' || typeof peer.value !== 'string' || !peer.value) return false;
    if (expectedPeerId && peer.value !== expectedPeerId) return false;
    if (components.some(component => component.name === 'p2p-circuit')) return false;

    const host = components.find(component =>
      component.name === 'ip4' || component.name === 'ip6' ||
      component.name === 'dns4' || component.name === 'dns6');
    if (!host || typeof host.value !== 'string') return false;

    const names = new Set(components.map(component => component.name));
    const encryptedTransport = names.has('wss') || names.has('quic-v1') || names.has('webtransport');
    const localPlaintext = names.has('ws') && isPrivateNetworkHostname(host.value);
    if (!encryptedTransport && !localPlaintext) return false;
    if ((names.has('ws') || names.has('wss')) && !names.has('tcp')) return false;
    if ((names.has('quic-v1') || names.has('webtransport')) && !names.has('udp')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Validate a peer-advertised circuit address before it is stored or dialed.
 * The relay prefix must itself be a trusted, authenticated relay address; the
 * final peer component is bound to the authenticated peer that advertised it.
 * This keeps malformed or attacker-selected address-book entries from becoming
 * arbitrary outbound multiaddr dials.
 */
export function isTrustedPeerCircuitMultiaddr(value: unknown, expectedPeerId?: string): value is string {
  if (typeof value !== 'string') return false;
  const raw = value.trim();
  if (!raw || raw.length > MAX_RELAY_MULTIADDR_BYTES || hasControlCharacters(raw)) return false;

  try {
    const components = multiaddr(raw).getComponents();
    const circuitIndex = components.findIndex(component => component.name === 'p2p-circuit');
    if (circuitIndex <= 0) return false;

    const finalPeer = components.at(-1);
    if (!finalPeer || finalPeer.name !== 'p2p' || typeof finalPeer.value !== 'string' || !finalPeer.value) {
      return false;
    }
    if (expectedPeerId && finalPeer.value !== expectedPeerId) return false;

    const suffix = components.slice(circuitIndex + 1).map(component => component.name);
    if (!(suffix.length === 1 && suffix[0] === 'p2p')
      && !(suffix.length === 2 && suffix[0] === 'webrtc' && suffix[1] === 'p2p')) {
      return false;
    }

    const relayPrefix = raw.slice(0, raw.indexOf('/p2p-circuit'));
    return isTrustedRelayMultiaddr(relayPrefix);
  } catch {
    return false;
  }
}

/**
 * Create a browser libp2p node configured for the xorein P2P network.
 *
 * NOTE: we do NOT put the relay in `addresses.listen`. The @libp2p/circuit-relay-v2
 * listener has a hard-coded 5-second timeout (DEFAULT_RESERVATION_COMPLETION_TIMEOUT)
 * that fires inside listen(), is not configurable via the public API (createListener()
 * doesn't forward the init options to the CircuitRelayTransportListener constructor),
 * and permanently adds the peer to a bloom filter on failure — preventing any retry.
 * Instead, we use `/p2p-circuit` (auto-discovery placeholder) and then call
 * reserveCircuitRelay() explicitly with a 30-second timeout after the node starts.
 */
export async function createXoreinNode(opts: XoreinNodeOptions = {}) {
  const requestedRelay = opts.relayMultiaddr?.trim();
  if (requestedRelay && !isTrustedRelayMultiaddr(requestedRelay)) {
    throw new Error('xorein relay address is missing, malformed, or insecure');
  }
  if (!isTrustedRelayMultiaddr(RELAY_MULTIADDR)) {
    throw new Error('built-in xorein relay address is missing, malformed, or insecure');
  }
  const bootstrapRelay = requestedRelay || RELAY_MULTIADDR;
  const initialRelays = [
    bootstrapRelay,
    ...(opts.trustedRelayMultiaddrs ?? []),
  ].filter((relay, index, all): relay is string =>
    isTrustedRelayMultiaddr(relay) && all.indexOf(relay) === index,
  );
  const dialableCandidates = opts.dialableCandidateMultiaddrs ?? new Set<string>();
  const configuredRelays = opts.dialableRelayMultiaddrs ?? new Set<string>();
  for (const relay of initialRelays) {
    configuredRelays.add(relay);
    dialableCandidates.add(relay);
  }
  const privateKey = opts.identity
    ? await generateKeyPairFromSeed('Ed25519', opts.identity.edSeed)
    : undefined;

  // Direct WebRTC transport + DCUtR hole-punching, opt-in via `directTransport`.
  // When on, we also listen on `/p2p-circuit/webrtc` so a relayed connection can be
  // upgraded to a direct browser↔browser WebRTC connection via DCUtR. Ships dark
  // until a 2nd relay + gateway rendezvous exist (see the flag comment).
  const directOn = resolveFeatureFlag('directTransport');

  const node = await createLibp2p({
    ...(privateKey ? { privateKey } : {}),
    addresses: {
      // Bare /p2p-circuit uses CircuitSearch mode (no automatic timeout dial).
      // With direct transport on, also advertise a /webrtc listener over the circuit
      // so DCUtR can upgrade relayed → direct.
      listen: directOn ? ['/p2p-circuit', '/p2p-circuit/webrtc'] : ['/p2p-circuit'],
    },
    transports: [
      webSockets(),
      webTransport(),
      ...(directOn ? [webRTC()] : []),
      circuitRelayTransport({
        // 30s for the actual HOP reservation exchange once connected.
        reservationCompletionTimeout: RELAY_RESERVATION_TIMEOUT_MS,
      }),
    ],
    connectionEncrypters: [
      noise({ prologueBytes: AETHER_NOISE_PROLOGUE }),
    ],
    streamMuxers: [yamux()],
    connectionGater: {
      // The browser only needs to dial the configured relay and authenticated
      // circuit paths. Never let a peer-provided address turn the client into
      // an arbitrary outbound dialer (or leak the user's network location to a
      // malicious address book entry).
      denyDialMultiaddr: (addr) => {
        const text = addr.toString();
        const configuredRelay = dialableCandidates.has(text);
        const circuit = [...configuredRelays].some(relay =>
          text.startsWith(`${relay}/p2p-circuit`) && /\/p2p\/[^/]+$/.test(text),
        );
        // A direct relay dial is only valid when it targets the pinned relay
        // identity. Circuit paths may target another peer, but only through a
        // relay that the local user/operator explicitly configured.
        return !(configuredRelay || circuit);
      },
    },
    services: {
      identify: identify(),
      ping: ping(),
      // DCUtR (Direct Connection Upgrade through Relay): coordinates the
      // simultaneous-open hole punch that turns a relayed circuit into a direct
      // WebRTC connection. Only meaningful alongside the /webrtc listener above.
      ...(directOn ? { dcutr: dcutr() } : {}),
    },
  });

  await node.start();

  // NOTE: relay reservation is intentionally NOT started here.
  // XoreinTransportManager.connectOnce() calls reserveAnyRelay() after this
  // returns, and is the single owner of relay reservation (Bug 21 fix).
  // Starting it here too caused duplicate concurrent reservations that produced
  // ambiguous relay selection and wasted the 30s dial budget twice.

  return node;
}

/**
 * Explicitly dial the relay and make a circuit-relay-v2 HOP reservation.
 * Returns true if a circuit address was obtained, false on timeout/failure.
 *
 * This bypasses the @libp2p/circuit-relay-v2 listener's non-configurable
 * 5-second timeout by dialing the relay ourselves and then calling addRelay()
 * on the reservation store with a proper 30-second budget.
 */
export async function reserveCircuitRelay(node: Libp2p, relayMultiaddr?: string): Promise<boolean> {
  const relayText = relayMultiaddr ?? RELAY_MULTIADDR;
  if (!isTrustedRelayMultiaddr(relayText)) return false;
  const relayMa = multiaddr(relayText);

  try {
    // Dial the relay with a generous timeout.
    const dialSignal = AbortSignal.timeout(RELAY_DIAL_TIMEOUT_MS);
    const conn = await node.dial(relayMa, { signal: dialSignal });

    // Access the circuit relay transport's reservation store to trigger a
    // proper HOP reservation now that we have a live connection.
    // `node.components` is not on the Libp2p interface type (it's internal to the
    // concrete libp2p class), so we access it via a typed narrowing helper that
    // confines the `unknown` cast to this one spot. CircuitRelayTransport is a
    // local interface that types only the properties we actually use.
    const nodeComponents = (node as unknown as { components?: InternalNodeComponents }).components;
    if (nodeComponents?.transportManager) {
      const transports = nodeComponents.transportManager.getTransports();
      const circuitTransport = transports.find(
        (t): t is CircuitRelayTransport =>
          typeof t === 'object' && t !== null &&
          (t as CircuitRelayTransport)[Symbol.toStringTag] === '@libp2p/circuit-relay-v2-transport',
      );

      if (circuitTransport?.reservationStore) {
        // Use 'discovered' type so the reservation ID matches what the CircuitSearch
        // listener registered via reserveRelay() during node.start(). With 'configured'
        // type, the reservation has no id, and _onAddRelayPeer skips addedRelay(),
        // leaving node.getMultiaddrs() empty.
        try {
          await circuitTransport.reservationStore.addRelay(conn.remotePeer, 'discovered');
        } catch (error) {
          // @libp2p/circuit-relay-v2 normally releases the one CircuitSearch
          // reservation when the relay connection closes. Chromium can report a
          // peer disconnect without the matching connection id reaching the
          // reservation store, leaving the dead relay in that single slot. In
          // that case addRelay rejects every healthy replacement with
          // HadEnoughRelaysError. Rebuild only the circuit listener and retry;
          // the libp2p node, identity, protocol handlers, and direct WebRTC peer
          // connections all remain alive.
          if (!isHadEnoughRelaysError(error)
            || !(await rebuildCircuitSearchListener(node, circuitTransport))) {
            throw error;
          }
          await circuitTransport.reservationStore.addRelay(conn.remotePeer, 'discovered');
        }
      } else {
        // No public reservation store is available in this libp2p build.
      }
    }

    // Wait up to 10s for the circuit address to actually appear in getMultiaddrs().
    for (let i = 0; i < 20; i++) {
      const addrs = circuitAddrsForRelay(node, relayText);
      if (addrs.length > 0) {
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    const finalAddrs = circuitAddrsForRelay(node, relayText);
    const ok = finalAddrs.length > 0;

    // Best-effort: also dial the WebTransport (QUIC) addr so future protocol
    // streams can use the QUIC path when available.
    dialWebTransport(node).catch(() => undefined);

    return ok;
  } catch {
    return false;
  }
}

function isHadEnoughRelaysError(error: unknown): boolean {
  return error instanceof Error && error.name === 'HadEnoughRelaysError';
}

/**
 * Recover the library's single CircuitSearch slot after an abrupt relay loss.
 * This deliberately touches only the circuit listener. Restarting the whole
 * libp2p node would destroy independent browser-to-browser connections.
 */
async function rebuildCircuitSearchListener(
  node: Libp2p,
  circuitTransport: CircuitRelayTransport,
): Promise<boolean> {
  const components = (node as unknown as { components?: InternalNodeComponents }).components;
  const transportManager = components?.transportManager;
  if (!transportManager) return false;

  const listener = transportManager.getListeners().find(
    (candidate): candidate is CircuitRelayListener =>
      typeof candidate === 'object' && candidate !== null
      && (candidate as CircuitRelayListener).reservationStore === circuitTransport.reservationStore
      && typeof (candidate as CircuitRelayListener).getAddrs === 'function'
      && typeof (candidate as CircuitRelayListener).close === 'function',
  );
  if (!listener) return false;

  // CircuitRelayTransportListener.close() clears its local address array but
  // does not remove already-confirmed observed addresses in this library
  // release. Remove them explicitly so a dead relay can never make a later
  // reservation look successful.
  for (const addr of listener.getAddrs()) {
    components?.addressManager?.removeObservedAddr(addr);
  }

  // The upstream listener removes only its relay:removed callback on close.
  // Detach the created-reservation callback too so repeated relay failures do
  // not accumulate closed listener instances.
  if (listener._onAddRelayPeer && circuitTransport.reservationStore.removeEventListener) {
    circuitTransport.reservationStore.removeEventListener(
      'relay:created-reservation',
      listener._onAddRelayPeer,
    );
  }

  await listener.close();
  // close() announces removal in a queued microtask; let the transport manager
  // delete the old listener before creating the replacement.
  await Promise.resolve();
  await transportManager.listen([multiaddr('/p2p-circuit')]);
  return true;
}

/**
 * Dial the relay's WebTransport (QUIC) multiaddr in the background.
 * On success, libp2p will prefer the QUIC connection for future streams.
 * Failure is silent — WSS remains the fallback.
 */
async function dialWebTransport(node: Libp2p): Promise<void> {
  const addrs = await fetchRelayAddrs();
  const wtAddr = addrs.find(a =>
    a.includes('/quic-v1/webtransport/') && isTrustedRelayMultiaddr(a, RELAY_PEER_ID),
  );
  if (!wtAddr) return;
  try {
    const signal = AbortSignal.timeout(15_000);
    await node.dial(multiaddr(wtAddr), { signal });
  } catch {
    // WSS remains the fallback path.
  }
}

/**
 * Return the full list of circuit multiaddrs this node is reachable at.
 * Empty until the relay reservation is established.
 */
export function circuitAddrs(node: { getMultiaddrs(): { toString(): string }[] }): string[] {
  return node.getMultiaddrs()
    .map(ma => ma.toString())
    .filter(s => s.includes('p2p-circuit'));
}

/** Return only circuit addresses issued by the requested, Noise-pinned relay. */
export function circuitAddrsForRelay(
  node: { getMultiaddrs(): { toString(): string }[] },
  relayMultiaddr: string,
): string[] {
  if (!isTrustedRelayMultiaddr(relayMultiaddr)) return [];
  try {
    const peer = multiaddr(relayMultiaddr).getComponents().at(-1);
    if (peer?.name !== 'p2p' || typeof peer.value !== 'string') return [];
    const marker = `/p2p/${peer.value}/p2p-circuit`;
    return circuitAddrs(node).filter(address => address.includes(marker));
  } catch {
    return [];
  }
}

/**
 * Fetch the relay node's advertised multiaddrs from the control endpoint,
 * including any WebTransport multiaddrs. The browser should try dialing
 * the WebTransport addr in addition to the WSS relay addr, since WebTransport
 * uses QUIC and has lower latency than WSS.
 *
 * Returns an empty array if the endpoint is unavailable or returns unexpected data.
 */
export async function fetchRelayAddrs(opts: { localOnly?: boolean } = {}): Promise<string[]> {
  try {
    const origin = supportNodeOrigin();
    if (!origin) return [];
    const supportUrl = new URL(origin);
    const localSupport = isPrivateNetworkHostname(supportUrl.hostname);
    // A local support node owns the local relay identity, which may be freshly
    // generated and therefore cannot match the production build-time pin. Public
    // support nodes remain pinned to RELAY_PEER_ID. The multiaddr validator still
    // enforces a complete address whose final PeerID is Noise-authenticated.
    if (opts.localOnly && !localSupport) return [];
    const expectedPeerId = localSupport ? undefined : RELAY_PEER_ID;
    const resp = await fetch(`${origin}/v1/relay/addrs`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(opts.localOnly ? 1_000 : 10_000),
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json() as unknown;
    // Expected shape: { addrs: string[] }
    if (
      data !== null &&
      typeof data === 'object' &&
      'addrs' in data &&
      Array.isArray((data as { addrs: unknown }).addrs)
    ) {
      return ((data as { addrs: unknown[] }).addrs as unknown[])
        .filter((a): a is string => isTrustedRelayMultiaddr(a, expectedPeerId));
    }
    return [];
  } catch {
    return [];
  }
}
