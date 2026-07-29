// xorein PeerStream framing codec — pure functions, no libp2p imports.
// Wire format: [4-byte big-endian uint32 length][proto.Marshal(PeerStreamRequest|Response)]
// Byte-compatible with Go oracle: pkg/v0_1/transport/handler.go
//
// We implement a minimal hand-rolled protobuf encoder/decoder for just the two
// envelope types — no codegen needed.
//
// This module also carries the two stream-lifecycle primitives shared by the
// one-shot and persistent-mux paths:
//   - FrameDecoder: incremental frame extraction that retains partial trailing
//     bytes, so MANY frames can be read off one long-lived stream.
//   - serveFamilyStream: the inbound loop — read framed requests until the peer
//     closes, dispatch each concurrently, write correlated framed responses.

// ── Protobuf varint + minimal encoder ─────────────────────────────────────

function varint(n: number): Uint8Array {
  const buf: number[] = [];
  while (n > 0x7f) { buf.push((n & 0x7f) | 0x80); n >>>= 7; }
  buf.push(n & 0x7f);
  return new Uint8Array(buf);
}

/** Returned as the value when a varint is truncated, overlong, or out of safe range. */
const VARINT_INVALID = -1;

/**
 * Read a protobuf varint. Returns [value, nextOffset], or [VARINT_INVALID,
 * buf.length] for any malformed encoding so the caller's `off < buf.length`
 * loop terminates immediately (fail-closed).
 *
 * Accumulation is unsigned on purpose: `<<` is a 32-bit SIGNED operation in JS,
 * so `(b & 0x7f) << 28` can go negative. A negative length flows into
 * `off += len` and moves the read offset BACKWARDS, spinning the decode loop
 * forever — a remote peer could hang the tab with one crafted frame.
 */
function readVarint(buf: Uint8Array, off: number): [number, number] {
  let result = 0, shift = 0;
  while (off < buf.length) {
    const b = buf[off++];
    result += (b & 0x7f) * 2 ** shift;
    if (!(b & 0x80)) {
      return Number.isSafeInteger(result) ? [result, off] : [VARINT_INVALID, buf.length];
    }
    shift += 7;
    if (shift > 63) return [VARINT_INVALID, buf.length]; // overlong varint
  }
  return [VARINT_INVALID, buf.length]; // truncated: no terminating byte
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
      if (len < 0 || off + len > buf.length) break; // malformed or truncated field
      const value = buf.subarray(off, off + len);
      off += len;
      if (fieldNum === 1) req.operation = dec.decode(value);
      else if (fieldNum === 2) req.payload = value;
      else if (fieldNum === 7) req.requestId = dec.decode(value);
    } else if (wireType === 0) {
      let v: number;
      [v, off] = readVarint(buf, off);
      if (v < 0) break;
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
      if (len < 0 || off + len > buf.length) break; // malformed or truncated field
      const value = buf.subarray(off, off + len);
      off += len;
      if (fieldNum === 4) resp.payload = value;
      else if (fieldNum === 5) resp.error = decodeError(value);
      else if (fieldNum === 6) resp.requestId = dec.decode(value);
    } else if (wireType === 0) {
      let v: number;
      [v, off] = readVarint(buf, off);
      if (v < 0) break;
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
      if (val < 0) break;
      if (fieldNum === 1) code = val;
    } else if (wireType === 2) {
      let len: number;
      [len, off] = readVarint(buf, off);
      if (len < 0 || off + len > buf.length) break; // malformed or truncated field
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

/** Max accepted frame body — matches the Go oracle's 8 MiB framing cap. */
export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

/** Chunk shape yielded by libp2p streams: Uint8Array or Uint8ArrayList. */
export type StreamChunk = Uint8Array | { subarray(): Uint8Array };

export function chunkBytes(chunk: StreamChunk): Uint8Array {
  return chunk instanceof Uint8Array ? chunk : chunk.subarray();
}

/**
 * Incremental frame extractor for long-lived streams. Unlike readFramedMessage
 * (which reads ONE frame and discards any trailing bytes), push() returns every
 * complete frame in the chunk and retains the partial remainder for the next
 * push — a single network chunk may end one frame and begin the next.
 */
export class FrameDecoder {
  private buf: Uint8Array = new Uint8Array(0);

  /** Feed one chunk; returns all frames completed by it (possibly none). */
  push(chunk: Uint8Array): Uint8Array[] {
    this.buf = this.buf.length === 0 ? chunk : concat(this.buf, chunk);
    const frames: Uint8Array[] = [];
    let off = 0;
    while (this.buf.length - off >= 4) {
      const len = new DataView(this.buf.buffer, this.buf.byteOffset + off).getUint32(0, false);
      if (len > MAX_FRAME_BYTES) {
        // Frame sync is unrecoverable past a bogus length — poison the stream.
        throw new Error(`peerstream: frame length ${len} exceeds cap`);
      }
      if (this.buf.length - off < 4 + len) break;
      frames.push(this.buf.subarray(off + 4, off + 4 + len));
      off += 4 + len;
    }
    if (off > 0) this.buf = this.buf.subarray(off);
    return frames;
  }

  /** Bytes held back waiting for the rest of a frame (test/diagnostic aid). */
  get bufferedBytes(): number { return this.buf.length; }
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
  stream: AsyncIterable<StreamChunk>,
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
    const bytes = chunkBytes(chunk);
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

// ── Inbound family-stream loop ─────────────────────────────────────────────

export interface InboundFamilyStream extends AsyncIterable<StreamChunk> {
  send(d: Uint8Array): boolean;
  close(): Promise<void>;
  abort?(err: Error): void;
}

/**
 * Serve framed PeerStream requests off one stream until the peer closes it.
 *
 * PROTOCOL: streams are persistent and multiplexed — a peer may send any number
 * of requests on one stream, and responses are correlated by request_id, NOT by
 * stream lifecycle. Requests are dispatched concurrently (matching the previous
 * one-stream-per-request behavior, where each request ran in its own handler
 * invocation), so responses may be written out of order; `produce` must echo
 * req.requestId into the framed response it returns. Legacy one-shot callers
 * half-close after their single request: the loop then drains in-flight
 * handlers, flushes their responses, and closes — identical observable behavior
 * to the old one-request-per-stream handlers.
 *
 * `produce` returns an already-framed response, or null for no response.
 * Handler errors are swallowed per-request (the caller's timeout/fallback
 * covers a missing response) rather than poisoning the whole stream.
 */
// Latency debug tap — see peerstream.ts debugLatency(). Read per dispatch so a
// probe can toggle it live.
function debugLatency(): boolean {
  try { return typeof localStorage !== 'undefined' && localStorage.getItem('harmolyn:debug:latency') === '1'; } catch { return false; }
}

export async function serveFamilyStream(
  stream: InboundFamilyStream,
  produce: (req: PeerStreamRequest) => Promise<Uint8Array | null> | Uint8Array | null,
): Promise<void> {
  const decoder = new FrameDecoder();
  const inflight = new Set<Promise<void>>();

  const dispatch = (frame: Uint8Array): void => {
    const req = decodePeerStreamRequest(frame);
    const t0 = debugLatency() ? performance.now() : 0;
    if (t0) console.debug(`[lat] serve ${req.operation} arrived at=${Date.now()}`);
    const p = Promise.resolve()
      .then(() => produce(req))
      .then(resp => {
        if (t0) console.debug(`[lat] serve ${req.operation} handled in=${(performance.now() - t0).toFixed(1)}ms at=${Date.now()}`);
        if (resp) stream.send(resp);
      })
      .catch(() => { /* per-request failure: no response; peer's timeout covers it */ });
    inflight.add(p);
    void p.finally(() => inflight.delete(p));
  };

  try {
    for await (const chunk of stream) {
      for (const frame of decoder.push(chunkBytes(chunk))) dispatch(frame);
    }
    // Peer closed its write side. Let in-flight handlers finish so their
    // responses reach a one-shot caller that is still reading, then close.
    await Promise.allSettled(inflight);
    await stream.close();
  } catch (err) {
    // Stream reset / poisoned framing: nothing more can be read or written.
    await Promise.allSettled(inflight);
    try { stream.abort?.(err instanceof Error ? err : new Error('peerstream: serve failed')); } catch { /* already gone */ }
  }
}
