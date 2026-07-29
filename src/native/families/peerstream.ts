// xorein PeerStream framing protocol.
// Wire format: [4-byte big-endian uint32 length][proto.Marshal(PeerStreamRequest|Response)]
// Byte-compatible with Go oracle: pkg/v0_1/transport/handler.go
//
// We implement a minimal hand-rolled protobuf encoder/decoder for just the two
// envelope types — no codegen needed.

// ── Protobuf varint + minimal encoder ─────────────────────────────────────

function varint(n: number): Uint8Array {
  const buf: number[] = [];
  while (n > 0x7f) { buf.push((n & 0x7f) | 0x80); n >>>= 7; }
  buf.push(n & 0x7f);
  return new Uint8Array(buf);
}

function readVarint(buf: Uint8Array, off: number): [number, number] {
  let result = 0, shift = 0;
  while (off < buf.length) {
    const b = buf[off++];
    result |= (b & 0x7f) << shift;
    if (!(b & 0x80)) break;
    shift += 7;
  }
  return [result, off];
}

const enc = new TextEncoder();
const dec = new TextDecoder();

function pbField(fieldNum: number, wireType: number): Uint8Array {
  return varint((fieldNum << 3) | wireType);
}

function pbString(fieldNum: number, s: string): Uint8Array {
  const encoded = enc.encode(s);
  return concat(pbField(fieldNum, 2), varint(encoded.length), encoded);
}

function pbBytes(fieldNum: number, b: Uint8Array): Uint8Array {
  return concat(pbField(fieldNum, 2), varint(b.length), b);
}

function pbVarint32(fieldNum: number, n: number): Uint8Array {
  return concat(pbField(fieldNum, 0), varint(n));
}

function concat(...arrays: Uint8Array[]): Uint8Array {
  const len = arrays.reduce((s, a) => s + a.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const a of arrays) { out.set(a, off); off += a.length; }
  return out;
}

// ── PeerStreamRequest encoder / decoder ───────────────────────────────────
// field 1: operation (string)
// field 2: payload (bytes)
// field 7: request_id (string)

export function encodePeerStreamRequest(req: {
  operation: string;
  payload?: Uint8Array;
  requestId?: string;
}): Uint8Array {
  const parts: Uint8Array[] = [pbString(1, req.operation)];
  if (req.payload?.length) parts.push(pbBytes(2, req.payload));
  if (req.requestId) parts.push(pbString(7, req.requestId));
  return concat(...parts);
}

export interface PeerStreamRequest {
  operation: string;
  payload?: Uint8Array;
  requestId?: string;
}

export function decodePeerStreamRequest(buf: Uint8Array): PeerStreamRequest {
  const req: PeerStreamRequest = { operation: '' };
  let off = 0;
  while (off < buf.length) {
    let tag: number;
    [tag, off] = readVarint(buf, off);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType === 2) {
      let len: number;
      [len, off] = readVarint(buf, off);
      const value = buf.subarray(off, off + len);
      off += len;
      if (fieldNum === 1) req.operation = dec.decode(value);
      else if (fieldNum === 2) req.payload = value;
      else if (fieldNum === 7) req.requestId = dec.decode(value);
    } else if (wireType === 0) {
      let _v: number;
      [_v, off] = readVarint(buf, off);
    } else {
      break;
    }
  }
  return req;
}

// ── PeerStreamResponse encoder / decoder ──────────────────────────────────
// field 4: payload (bytes)
// field 5: error (embedded message: field 1=code int32, field 2=message string)
// field 6: request_id (string)

export function encodePeerStreamResponse(resp: {
  payload?: Uint8Array;
  requestId?: string;
}): Uint8Array {
  const parts: Uint8Array[] = [];
  if (resp.payload?.length) parts.push(pbBytes(4, resp.payload));
  if (resp.requestId) parts.push(pbString(6, resp.requestId));
  return parts.length ? concat(...parts) : new Uint8Array(0);
}

export interface PeerStreamError {
  code: number;
  message: string;
}

export interface PeerStreamResponse {
  payload?: Uint8Array;
  error?: PeerStreamError;
  requestId?: string;
}

export function decodePeerStreamResponse(buf: Uint8Array): PeerStreamResponse {
  const resp: PeerStreamResponse = {};
  let off = 0;
  while (off < buf.length) {
    let tag: number;
    [tag, off] = readVarint(buf, off);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType === 2) {
      let len: number;
      [len, off] = readVarint(buf, off);
      const value = buf.subarray(off, off + len);
      off += len;
      if (fieldNum === 4) resp.payload = value;
      else if (fieldNum === 5) resp.error = decodeError(value);
      else if (fieldNum === 6) resp.requestId = dec.decode(value);
    } else if (wireType === 0) {
      let _: number;
      [_, off] = readVarint(buf, off);
    } else {
      break; // unsupported wire type, stop
    }
  }
  return resp;
}

function decodeError(buf: Uint8Array): PeerStreamError {
  let off = 0, code = 0, message = '';
  while (off < buf.length) {
    let tag: number;
    [tag, off] = readVarint(buf, off);
    const fieldNum = tag >>> 3;
    const wireType = tag & 0x7;
    if (wireType === 0) {
      let val: number;
      [val, off] = readVarint(buf, off);
      if (fieldNum === 1) code = val;
    } else if (wireType === 2) {
      let len: number;
      [len, off] = readVarint(buf, off);
      const value = buf.subarray(off, off + len);
      off += len;
      if (fieldNum === 2) message = dec.decode(value);
    } else break;
  }
  return { code, message };
}

// ── 4-byte length framing ──────────────────────────────────────────────────

export function frameMessage(msg: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + msg.length);
  new DataView(out.buffer).setUint32(0, msg.length, false);
  out.set(msg, 4);
  return out;
}

export function unframeMessage(buf: Uint8Array): Uint8Array | null {
  if (buf.length < 4) return null;
  const len = new DataView(buf.buffer, buf.byteOffset).getUint32(0, false);
  if (buf.length < 4 + len) return null;
  return buf.subarray(4, 4 + len);
}

/**
 * Read exactly ONE length-prefixed message from a stream and return as soon as
 * that message is complete.
 *
 * LATENCY: the obvious `for await (const chunk of stream)` alternative only ends
 * when the peer's FIN arrives, so every request paid an extra relay-circuit
 * traversal purely to learn that a message we had already fully received was in
 * fact finished. The 4-byte length prefix tells us that directly.
 *
 * Returns null if the stream ends before a complete frame arrives.
 */
export async function readFramedMessage(
  stream: AsyncIterable<Uint8Array | { subarray(): Uint8Array }>,
): Promise<Uint8Array | null> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  let joined: Uint8Array | null = null;

  const assemble = (): Uint8Array => {
    if (chunks.length === 1) return chunks[0];
    const total = new Uint8Array(size);
    let off = 0;
    for (const c of chunks) { total.set(c, off); off += c.length; }
    return total;
  };

  for await (const chunk of stream) {
    const bytes = chunk instanceof Uint8Array ? chunk : chunk.subarray();
    chunks.push(bytes);
    size += bytes.length;
    if (size < 4) continue;
    joined = assemble();
    const len = new DataView(joined.buffer, joined.byteOffset).getUint32(0, false);
    if (size >= 4 + len) return joined.subarray(4, 4 + len);
  }
  // Stream ended: fall back to whatever arrived (handles a peer that closed
  // without ever completing a frame).
  if (!chunks.length) return null;
  return unframeMessage(joined ?? assemble());
}

// ── Family stream call ─────────────────────────────────────────────────────

import type { Libp2p } from 'libp2p';
// LATENCY: static import — the previous per-call `await import('@multiformats/multiaddr')`
// added a module-resolution microtask hop to EVERY outbound message. The transport layer
// already imports this module statically, so hoisting costs nothing in bundle terms.
import { multiaddr, type Multiaddr } from '@multiformats/multiaddr';

// Stream-open options shared by the reuse and fresh-dial paths.
// - runOnLimitedConnection: relay circuits are 'limited' connections.
// - negotiateFully:false — LATENCY: with a single protocol, multistream-select may
//   write the protocol name together with the first data chunk instead of waiting a
//   full relay-circuit RTT for the ack. Harmless no-op on libp2p versions that do
//   not implement optimistic select. A protocol mismatch then surfaces on the
//   response read, which callers already treat as "peer unreachable".
const STREAM_OPTS = { runOnLimitedConnection: true, negotiateFully: false } as const;

// Cap protocol negotiation on a REUSED connection. A relay-killed circuit can stay
// 'open' in the local pool (zombie); without this cap a send to it burns the full
// default 10s negotiation timeout before the fresh-dial fallback runs.
const REUSE_NEGOTIATION_TIMEOUT_MS = 5_000;

/**
 * Open an outbound stream to the peer behind `ma`.
 *
 * LATENCY + CORRECTNESS: prefer `newStream` on an EXISTING open connection to the
 * peer instead of `dialProtocol(multiaddr)`. Dialing by circuit multiaddr makes
 * libp2p 3.x establish a whole new relayed connection (reservation + Noise +
 * muxer) per message and then abort it as a 'Duplicate multiaddr connection'
 * (connection-manager guard) whenever any connection to that peer+relay addr
 * already exists — returning the OLD connection, which may be a zombie whose
 * circuit the relay already reset. That both wasted a full circuit setup per
 * message and, once the first circuit died, made every send time out into the
 * mailbox fallback. Reusing the open connection directly skips the per-message
 * circuit dial entirely; if the reused connection turns out broken, every stale
 * connection to the peer is aborted and ONE genuinely fresh dial (`force:true`,
 * which bypasses both the reuse shortcut and the duplicate-multiaddr abort) is
 * attempted before giving up to the caller's mailbox/outbox fallback.
 */
/** The target peer of a (possibly circuit) multiaddr: its LAST /p2p/ component. */
function circuitTargetPeer(ma: Multiaddr): string | undefined {
  const comps = ma.getComponents();
  for (let i = comps.length - 1; i >= 0; i--) {
    if (comps[i].name === 'p2p') return comps[i].value;
  }
  return undefined;
}

async function openFamilyStream(node: Libp2p, ma: Multiaddr, protocol: string) {
  const targetPeer = circuitTargetPeer(ma);
  const existing = targetPeer == null ? undefined : node
    .getConnections()
    .find(c => c.status === 'open' && c.remotePeer.toString() === targetPeer);

  if (existing != null) {
    try {
      return await existing.newStream(protocol, {
        ...STREAM_OPTS,
        signal: AbortSignal.timeout(REUSE_NEGOTIATION_TIMEOUT_MS),
      });
    } catch (err) {
      // Broken/zombie connection: evict every connection to this peer so the
      // fresh dial below (and future sends) cannot be pinned back onto it.
      for (const c of node.getConnections()) {
        if (c.remotePeer.toString() === targetPeer) {
          try { c.abort(err instanceof Error ? err : new Error('peerstream: stale connection')); } catch { /* already closed */ }
        }
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return await (node as any).dialProtocol(ma, protocol, { ...STREAM_OPTS, force: true });
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return await (node as any).dialProtocol(ma, protocol, STREAM_OPTS);
}

/** Open a stream to a peer on a given protocol, send one request, read one response. */
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

  // LATENCY NOTE: opening this stream is the single dominant cost of a message
  // (~50ms median through a relay circuit, measured; the local store write and
  // the wire-send initiation together are ~1ms). The remaining win is a
  // persistent multiplexed stream per (peer, protocol) — the wire format already
  // carries a requestId, so responses can be correlated — rather than a fresh
  // stream per request. That is a protocol-level change and is not attempted here.
  const stream = await openFamilyStream(node, ma, protocol);
  stream.send(framed);
  await stream.sendCloseWrite();

  const msg = await readFramedMessage(stream);
  if (!msg) throw new Error('peerstream: empty or malformed response');
  return decodePeerStreamResponse(msg);
}
