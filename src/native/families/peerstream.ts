// xorein PeerStream framing protocol — public façade.
// Wire format: [4-byte big-endian uint32 length][proto.Marshal(PeerStreamRequest|Response)]
// Byte-compatible with Go oracle: pkg/v0_1/transport/handler.go
//
// The codec + stream-loop primitives live in frames.ts; the persistent
// multiplexed channel pool lives in streammux.ts. This module re-exports both
// (existing import sites are unchanged) and provides callFamily, the single
// outbound request entrypoint.

export {
  encodePeerStreamRequest,
  decodePeerStreamRequest,
  encodePeerStreamResponse,
  decodePeerStreamResponse,
  frameMessage,
  unframeMessage,
  readFramedMessage,
  serveFamilyStream,
  FrameDecoder,
  MAX_FRAME_BYTES,
} from './frames.js';
export type {
  PeerStreamRequest,
  PeerStreamResponse,
  PeerStreamError,
  StreamChunk,
  InboundFamilyStream,
} from './frames.js';
export { MuxStreamError, muxPoolSize, isDirectAddr } from './streammux.js';

import type { Libp2p } from 'libp2p';
// LATENCY: static import — the previous per-call `await import('@multiformats/multiaddr')`
// added a module-resolution microtask hop to EVERY outbound message. The transport layer
// already imports this module statically, so hoisting costs nothing in bundle terms.
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';
import {
  encodePeerStreamRequest,
  decodePeerStreamResponse,
  frameMessage,
  readFramedMessage,
  type PeerStreamResponse,
} from './frames.js';
import { muxRequest, openFamilyStream, MuxStreamError } from './streammux.js';
import { resolveFeatureFlag } from '../../config/featureFlags.js';

/**
 * Send one request to a peer on a given protocol and read its response.
 *
 * Default path (persistentPeerStreams flag): the request rides the long-lived
 * multiplexed stream for (peer, protocol) — no per-message stream setup, which
 * was the dominant cost of a message (~50ms median through a relay circuit).
 * Responses are correlated by requestId, so requests pipeline freely.
 *
 * If the pooled stream fails mid-request (relay reset the circuit, idle abort,
 * zombie), ONE legacy single-shot attempt is made on a fresh stream — same
 * request bytes, same requestId (receivers de-dup by message/request id) —
 * before the error propagates to the caller's outbox/mailbox fallback. With
 * the flag off, only the legacy single-shot path runs.
 */
// Latency debug tap: set localStorage 'harmolyn:debug:latency' = '1' to
// console.debug per-request wire timings. Used by the E2E latency probe to
// attribute cost between app, wire, and render. Read per call so a probe can
// toggle it live; a localStorage hit is sub-microsecond on Chromium.
const DEBUG_LATENCY_KEY = 'harmolyn:debug:latency';
function debugLatency(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem(DEBUG_LATENCY_KEY) === '1'; } catch { return false; }
}

export async function callFamily(
  node: Libp2p,
  peer: Multiaddr | string,
  protocol: string,
  operation: string,
  payload?: Uint8Array,
  requestId?: string,
): Promise<PeerStreamResponse> {
  const ma = typeof peer === 'string' ? multiaddr(peer) : peer;
  const reqId = requestId ?? crypto.randomUUID();
  const reqBytes = encodePeerStreamRequest({ operation, payload, requestId: reqId });
  const framed = frameMessage(reqBytes);
  const t0 = debugLatency() ? performance.now() : 0;

  if (resolveFeatureFlag('persistentPeerStreams')) {
    try {
      const resp = await muxRequest(node, ma, protocol, framed, reqId);
      if (t0) console.debug(`[lat] call ${operation} mux rtt=${(performance.now() - t0).toFixed(1)}ms at=${Date.now()}`);
      return resp;
    } catch (err) {
      // Dial failures propagate: the peer is unreachable and a second dial
      // would fail identically — callers fall back to the mailbox/outbox.
      if (!(err instanceof MuxStreamError)) throw err;
      // Pooled-stream death is retryable: fall through to one single-shot
      // attempt on a genuinely fresh stream.
    }
  }

  // Legacy single-shot: open, send, half-close, read one framed response.
  const stream = await openFamilyStream(node, ma, protocol);
  stream.send(framed);
  await stream.sendCloseWrite();

  const msg = await readFramedMessage(stream);
  if (!msg) throw new Error('peerstream: empty or malformed response');
  if (t0) console.debug(`[lat] call ${operation} oneshot rtt=${(performance.now() - t0).toFixed(1)}ms at=${Date.now()}`);
  return decodePeerStreamResponse(msg);
}
