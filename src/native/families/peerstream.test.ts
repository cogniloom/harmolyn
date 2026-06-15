import { describe, it, expect } from 'vitest';
import {
  encodePeerStreamRequest,
  decodePeerStreamResponse,
  frameMessage,
  unframeMessage,
} from './peerstream';

describe('PeerStream framing', () => {
  it('frameMessage prepends uint32BE length', () => {
    const msg = new Uint8Array([1, 2, 3]);
    const framed = frameMessage(msg);
    expect(framed.length).toBe(7);
    const view = new DataView(framed.buffer);
    expect(view.getUint32(0, false)).toBe(3);
    expect([...framed.subarray(4)]).toEqual([1, 2, 3]);
  });

  it('unframeMessage strips length prefix', () => {
    const msg = new Uint8Array([10, 20, 30]);
    const framed = frameMessage(msg);
    const out = unframeMessage(framed);
    expect([...out!]).toEqual([10, 20, 30]);
  });

  it('unframeMessage returns null for truncated input', () => {
    expect(unframeMessage(new Uint8Array([0, 0, 0, 10]))).toBeNull(); // says 10 bytes but has 0
  });
});

describe('PeerStreamRequest encoding', () => {
  it('encodes operation field (field 1)', () => {
    const buf = encodePeerStreamRequest({ operation: 'presence.query' });
    // Field tag = (1 << 3) | 2 = 0x0a; length = 14; "presence.query" = 14 chars
    expect(buf[0]).toBe(0x0a);
    const len = buf[1];
    const str = new TextDecoder().decode(buf.subarray(2, 2 + len));
    expect(str).toBe('presence.query');
  });

  it('encodes payload field (field 2)', () => {
    const payload = new TextEncoder().encode('{"test":1}');
    const buf = encodePeerStreamRequest({ operation: 'test.op', payload });
    // Should contain field tag 0x12 (field 2, wire type 2)
    expect(Array.from(buf)).toContain(0x12);
  });

  it('encodes request_id field (field 7)', () => {
    const buf = encodePeerStreamRequest({ operation: 'x', requestId: 'req-123' });
    // Field tag = (7 << 3) | 2 = 0x3a
    expect(Array.from(buf)).toContain(0x3a);
  });
});

function pbVarint(n: number): Uint8Array {
  const buf: number[] = [];
  while (n > 0x7f) { buf.push((n & 0x7f) | 0x80); n >>>= 7; }
  buf.push(n & 0x7f); return new Uint8Array(buf);
}

function buildResp(fields: Array<[number, Uint8Array | string | number]>): Uint8Array {
  const parts: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const [fn, val] of fields) {
    if (ArrayBuffer.isView(val)) {
      const bytes = new Uint8Array((val as Uint8Array).buffer, (val as Uint8Array).byteOffset, (val as Uint8Array).byteLength);
      parts.push(new Uint8Array([(fn << 3) | 2]), pbVarint(bytes.length), bytes);
    } else if (typeof val === 'string') {
      const encoded = enc.encode(val);
      parts.push(new Uint8Array([(fn << 3) | 2]), pbVarint(encoded.length), encoded);
    } else {
      parts.push(new Uint8Array([(fn << 3) | 0]), pbVarint(val));
    }
  }
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(totalLen);
  let off = 0; for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

describe('PeerStreamResponse decoding', () => {
  it('decodes payload field (field 4)', () => {
    const payload = new TextEncoder().encode('{"ok":true}');
    const buf = buildResp([[4, payload]]);
    // Verify buf has expected bytes
    expect(buf[0]).toBe(0x22); // field 4, wire type 2
    expect(buf[1]).toBe(11);   // length 11
    expect(buf.length).toBe(13);
    const resp = decodePeerStreamResponse(buf);
    // payload should be set and decode to the original string
    expect(resp.payload).toBeDefined();
    expect(resp.payload!.length).toBe(11);
    expect(new TextDecoder().decode(resp.payload)).toBe('{"ok":true}');
  });

  it('decodes request_id field (field 6)', () => {
    const buf = buildResp([[6, 'req-abc']]);
    const resp = decodePeerStreamResponse(buf);
    expect(resp.requestId).toBe('req-abc');
  });
});
