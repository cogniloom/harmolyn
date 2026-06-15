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

// ── Family stream call ─────────────────────────────────────────────────────

import type { Libp2p } from 'libp2p';
import type { Multiaddr } from '@multiformats/multiaddr';

/** Open a stream to a peer on a given protocol, send one request, read one response. */
export async function callFamily(
  node: Libp2p,
  peer: Multiaddr | string,
  protocol: string,
  operation: string,
  payload?: Uint8Array,
  requestId?: string,
): Promise<PeerStreamResponse> {
  const { multiaddr } = await import('@multiformats/multiaddr');
  const ma = typeof peer === 'string' ? multiaddr(peer) : peer;
  const reqId = requestId ?? crypto.randomUUID();
  const reqBytes = encodePeerStreamRequest({ operation, payload, requestId: reqId });
  const framed = frameMessage(reqBytes);

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stream = await (node as any).dialProtocol(ma, protocol, { runOnLimitedConnection: true });
  stream.send(framed);
  await stream.sendCloseWrite();

  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk?.subarray ? chunk.subarray() : new Uint8Array(chunk));
  }
  const raw = chunks.length === 1 ? chunks[0] : concat(...chunks);
  const msg = unframeMessage(raw);
  if (!msg) throw new Error('peerstream: empty or malformed response');
  return decodePeerStreamResponse(msg);
}
