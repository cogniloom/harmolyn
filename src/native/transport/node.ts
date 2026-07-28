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
import { AETHER_NOISE_PROLOGUE } from './prologue.js';
import type { Libp2p } from 'libp2p';
import type { PeerId } from '@libp2p/interface';
import type { XoreinIdentity } from '../identity/identity.js';

// Minimal slice of @libp2p/circuit-relay-v2 ReservationStore needed to call addRelay().
// Using a local interface avoids the deep dist/ import (not in the package exports map)
// while still providing type safety over the `as any` approach.
interface CircuitRelayReservationStore {
  addRelay(peerId: PeerId, type: 'discovered' | 'configured'): Promise<unknown>;
}
interface CircuitRelayTransport {
  readonly [Symbol.toStringTag]: string;
  reservationStore: CircuitRelayReservationStore;
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
  /** Use an existing identity so the libp2p PeerID is stable across sessions. */
  identity?: XoreinIdentity;
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
      denyDialMultiaddr: () => false,
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
  const relayMa = multiaddr(relayMultiaddr ?? RELAY_MULTIADDR);

  try {
    // Dial the relay with a generous timeout.
    const dialSignal = AbortSignal.timeout(RELAY_DIAL_TIMEOUT_MS);
    const conn = await node.dial(relayMa, { signal: dialSignal });
    console.debug('[xorein/relay] dialed relay', conn.remotePeer.toString().substring(0, 20));

    // Access the circuit relay transport's reservation store to trigger a
    // proper HOP reservation now that we have a live connection.
    // `node.components` is not on the Libp2p interface type (it's internal to the
    // concrete libp2p class), so we access it via a typed narrowing helper that
    // confines the `unknown` cast to this one spot. CircuitRelayTransport is a
    // local interface that types only the properties we actually use.
    const nodeComponents = (node as unknown as { components?: { transportManager?: { getTransports(): unknown[] } } }).components;
    if (nodeComponents?.transportManager) {
      const transports = nodeComponents.transportManager.getTransports();
      const circuitTransport = transports.find(
        (t): t is CircuitRelayTransport =>
          typeof t === 'object' && t !== null &&
          (t as CircuitRelayTransport)[Symbol.toStringTag] === '@libp2p/circuit-relay-v2-transport',
      );

      if (circuitTransport?.reservationStore) {
        console.debug('[xorein/relay] calling addRelay');
        // Use 'discovered' type so the reservation ID matches what the CircuitSearch
        // listener registered via reserveRelay() during node.start(). With 'configured'
        // type, the reservation has no id, and _onAddRelayPeer skips addedRelay(),
        // leaving node.getMultiaddrs() empty.
        const result = await circuitTransport.reservationStore.addRelay(conn.remotePeer, 'discovered') as { details?: { reservation?: { addrs?: unknown[] } } } | undefined;
        console.debug('[xorein/relay] addRelay result', JSON.stringify(result?.details?.reservation?.addrs?.length ?? 'no addrs'));
      } else {
        console.warn('[xorein/relay] circuit relay transport not found, transports:', transports.length);
      }
    }

    // Wait up to 10s for the circuit address to actually appear in getMultiaddrs().
    for (let i = 0; i < 20; i++) {
      const addrs = circuitAddrs(node);
      if (addrs.length > 0) {
        console.debug('[xorein/relay] circuit addrs acquired:', addrs);
        return true;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    const finalAddrs = circuitAddrs(node);
    console.warn('[xorein/relay] no circuit addrs after 10s, getMultiaddrs:', node.getMultiaddrs().map(m => m.toString()));
    const ok = finalAddrs.length > 0;

    // Best-effort: also dial the WebTransport (QUIC) addr so future protocol
    // streams can use the QUIC path when available.
    dialWebTransport(node).catch(() => undefined);

    return ok;
  } catch (err) {
    console.error('[xorein/relay] reserveCircuitRelay error:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * Dial the relay's WebTransport (QUIC) multiaddr in the background.
 * On success, libp2p will prefer the QUIC connection for future streams.
 * Failure is silent — WSS remains the fallback.
 */
async function dialWebTransport(node: Libp2p): Promise<void> {
  const addrs = await fetchRelayAddrs();
  const wtAddr = addrs.find(a => a.includes('/quic-v1/webtransport/'));
  if (!wtAddr) return;
  try {
    const signal = AbortSignal.timeout(15_000);
    await node.dial(multiaddr(wtAddr), { signal });
    console.debug('[xorein/wt] WebTransport QUIC connection established');
  } catch (err) {
    console.debug('[xorein/wt] WebTransport dial failed (WSS remains active):', err instanceof Error ? err.message : String(err));
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

/**
 * Fetch the relay node's advertised multiaddrs from the control endpoint,
 * including any WebTransport multiaddrs. The browser should try dialing
 * the WebTransport addr in addition to the WSS relay addr, since WebTransport
 * uses QUIC and has lower latency than WSS.
 *
 * Returns an empty array if the endpoint is unavailable or returns unexpected data.
 */
export async function fetchRelayAddrs(): Promise<string[]> {
  try {
    const supportBase = import.meta.env.VITE_XOREIN_CONTROL_ENDPOINT?.trim() || 'https://node.xorein.com';
    const resp = await fetch(`${supportBase}/v1/relay/addrs`, { method: 'GET' });
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
        .filter((a): a is string => typeof a === 'string');
    }
    return [];
  } catch {
    return [];
  }
}
