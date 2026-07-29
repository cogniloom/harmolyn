import { describe, it, expect, vi } from 'vitest';
import type { Libp2p } from 'libp2p';
import {
  encodePeerStreamRequest,
  decodePeerStreamRequest,
  encodePeerStreamResponse,
  decodePeerStreamResponse,
  frameMessage,
  unframeMessage,
  callFamily,
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

// ── callFamily (LATENCY REGRESSION) ─────────────────────────────────────────
// Every chat/presence/sync message rides callFamily. It must (a) REUSE an open
// connection to the target peer via newStream — dialing the circuit multiaddr per
// message costs a full relayed-connection setup and trips libp2p's 'Duplicate
// multiaddr connection' abort, which pins sends onto a possibly-dead old
// connection; (b) dial with the low-latency stream options (runOnLimitedConnection
// + negotiateFully:false); (c) fall back to ONE forced fresh dial when the reused
// connection is broken; and (d) keep the one-request/one-response length-prefixed
// framing byte-exact, since the responder reads to stream end.

const PEER = '12D3KooWNNQp1tmRbcLMrqS866jRJbzoPF6sNEZRoPEVdVwLqTv6';
const OTHER_PEER = '12D3KooWDsujzQH69Gq2LQb1gHMUCbDaJVACYmoVymK9dej5zh4T';
const CIRCUIT = `/ip4/127.0.0.1/tcp/9999/ws/p2p/${OTHER_PEER}/p2p-circuit/p2p/${PEER}`;

function fakeStream(chunks: Uint8Array[]) {
  const sent: Uint8Array[] = [];
  let closedWrite = false;
  return {
    sent,
    get closedWrite() { return closedWrite; },
    send(d: Uint8Array) { sent.push(d); return true; },
    async sendCloseWrite() { closedWrite = true; },
    async *[Symbol.asyncIterator]() { for (const c of chunks) yield c; },
  };
}

function okStream(payload = '{"ok":true}', requestId = 'r1') {
  return fakeStream([frameMessage(encodePeerStreamResponse({ payload: new TextEncoder().encode(payload), requestId }))]);
}

function fakeConn(peerId: string, newStream: ReturnType<typeof vi.fn>, status = 'open') {
  return { status, remotePeer: { toString: () => peerId }, newStream, abort: vi.fn() };
}

describe('callFamily', () => {
  it('with no existing connection: dials with runOnLimitedConnection + optimistic negotiation and round-trips one framed request/response', async () => {
    const stream = okStream();
    const dialProtocol = vi.fn().mockResolvedValue(stream);
    const node = { dialProtocol, getConnections: () => [] } as unknown as Libp2p;

    const resp = await callFamily(node, CIRCUIT, '/xorein/chat/1.0.0', 'chat.send', new TextEncoder().encode('{"x":1}'), 'req-1');

    // Dial options: relay-circuit capable and 0-RTT-intent negotiation.
    expect(dialProtocol).toHaveBeenCalledTimes(1);
    const [ma, proto, opts] = dialProtocol.mock.calls[0];
    expect(String(ma)).toContain('/p2p-circuit/');
    expect(proto).toBe('/xorein/chat/1.0.0');
    expect(opts).toMatchObject({ runOnLimitedConnection: true, negotiateFully: false });

    // Exactly one length-prefixed frame went out, then close-write (responder
    // reads to stream end before replying).
    expect(stream.sent.length).toBe(1);
    expect(stream.closedWrite).toBe(true);
    const req = decodePeerStreamRequest(unframeMessage(stream.sent[0])!);
    expect(req.operation).toBe('chat.send');
    expect(req.requestId).toBe('req-1');
    expect(new TextDecoder().decode(req.payload)).toBe('{"x":1}');

    // Response decoded through the same framing.
    expect(new TextDecoder().decode(resp.payload)).toBe('{"ok":true}');
    expect(resp.requestId).toBe('r1');
  });

  it('REUSES an open connection to the target peer instead of dialing a new circuit', async () => {
    const stream = okStream('{"ok":1}', 'r-reuse');
    const newStream = vi.fn().mockResolvedValue(stream);
    const dialProtocol = vi.fn(); // must NOT be called
    const node = {
      dialProtocol,
      getConnections: () => [fakeConn(PEER, newStream)],
    } as unknown as Libp2p;

    const resp = await callFamily(node, CIRCUIT, '/xorein/chat/1.0.0', 'chat.send');

    expect(dialProtocol).not.toHaveBeenCalled();
    expect(newStream).toHaveBeenCalledTimes(1);
    const [proto, opts] = newStream.mock.calls[0];
    expect(proto).toBe('/xorein/chat/1.0.0');
    expect(opts).toMatchObject({ runOnLimitedConnection: true, negotiateFully: false });
    expect(opts.signal).toBeInstanceOf(AbortSignal); // zombie-connection cap
    expect(resp.requestId).toBe('r-reuse');
  });

  it('ignores connections to OTHER peers and closed connections when picking one to reuse', async () => {
    const stream = okStream();
    const dialProtocol = vi.fn().mockResolvedValue(stream);
    const otherConn = fakeConn(OTHER_PEER, vi.fn());
    const closedConn = fakeConn(PEER, vi.fn(), 'closed');
    const node = { dialProtocol, getConnections: () => [otherConn, closedConn] } as unknown as Libp2p;

    await callFamily(node, CIRCUIT, '/xorein/chat/1.0.0', 'chat.send');

    expect(dialProtocol).toHaveBeenCalledTimes(1);
    expect(otherConn.newStream).not.toHaveBeenCalled();
    expect(closedConn.newStream).not.toHaveBeenCalled();
  });

  it('falls back to ONE forced fresh dial (and evicts the stale connection) when the reused connection is broken', async () => {
    const newStream = vi.fn().mockRejectedValue(new Error('muxer closed'));
    const stale = fakeConn(PEER, newStream);
    const stream = okStream('{"ok":true}', 'r-fresh');
    const dialProtocol = vi.fn().mockResolvedValue(stream);
    const node = { dialProtocol, getConnections: () => [stale] } as unknown as Libp2p;

    const resp = await callFamily(node, CIRCUIT, '/xorein/chat/1.0.0', 'chat.send');

    // The zombie was aborted so future sends cannot be pinned back onto it...
    expect(stale.abort).toHaveBeenCalled();
    // ...and the fresh dial bypassed the reuse shortcut AND the duplicate-multiaddr abort.
    expect(dialProtocol).toHaveBeenCalledTimes(1);
    expect(dialProtocol.mock.calls[0][2]).toMatchObject({ force: true, runOnLimitedConnection: true, negotiateFully: false });
    expect(resp.requestId).toBe('r-fresh');
  });

  it('reassembles a response split across chunks', async () => {
    const framed = frameMessage(encodePeerStreamResponse({ payload: new TextEncoder().encode('{"ok":1}'), requestId: 'r2' }));
    const stream = fakeStream([framed.subarray(0, 3), framed.subarray(3)]);
    const node = { dialProtocol: vi.fn().mockResolvedValue(stream), getConnections: () => [] } as unknown as Libp2p;
    const resp = await callFamily(node, CIRCUIT, '/xorein/chat/1.0.0', 'chat.send');
    expect(resp.requestId).toBe('r2');
  });

  it('throws on an empty response stream so callers fall back to mailbox/outbox', async () => {
    const stream = fakeStream([]);
    const node = { dialProtocol: vi.fn().mockResolvedValue(stream), getConnections: () => [] } as unknown as Libp2p;
    await expect(callFamily(node, CIRCUIT, '/xorein/chat/1.0.0', 'chat.send')).rejects.toThrow(/empty or malformed/);
  });

  it('propagates a dial failure (peer unreachable) as a rejection', async () => {
    const node = { dialProtocol: vi.fn().mockRejectedValue(new Error('dial failed')), getConnections: () => [] } as unknown as Libp2p;
    await expect(callFamily(node, CIRCUIT, '/xorein/chat/1.0.0', 'chat.send')).rejects.toThrow('dial failed');
  });
});
