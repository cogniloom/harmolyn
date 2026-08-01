// Persistent multiplexed PeerStream channels (streammux.ts) — the protocol
// change from one-stream-per-request to one long-lived stream per (peer,
// protocol) with request_id-correlated responses.
//
// The contract under test:
//  (a) concurrent requests to one (peer, protocol) share ONE stream (opened once);
//  (b) responses settle by request_id, in ANY order;
//  (c) a one-shot (legacy) responder that closes after its first response is a
//      graceful drop — the next request re-opens, i.e. exactly the old behavior;
//  (d) post-open stream death rejects all pending AND callFamily retries once on
//      a fresh single-shot stream before giving up;
//  (e) a dial failure propagates without a wasteful second dial;
//  (f) an unresponsive channel times out, killing the channel (zombie circuit);
//  (g) a response with an EMPTY request_id (Go frame-parse error path) settles
//      an unambiguous single pending request.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Libp2p } from 'libp2p';
import {
  encodePeerStreamResponse,
  decodePeerStreamRequest,
  frameMessage,
  unframeMessage,
  callFamily,
  muxPoolSize,
  isDirectAddr,
  SINGLE_SHOT_RESPONSE_TIMEOUT_MS,
} from './peerstream';
import { MuxChannel, MuxStreamError, REQUEST_TIMEOUT_MS } from './streammux';
import { FEATURE_OVERRIDES_STORAGE_KEY } from '../../config/featureFlags';

const PEER = '12D3KooWNNQp1tmRbcLMrqS866jRJbzoPF6sNEZRoPEVdVwLqTv6';
const CIRCUIT = `/ip4/127.0.0.1/tcp/9999/ws/p2p/12D3KooWDsujzQH69Gq2LQb1gHMUCbDaJVACYmoVymK9dej5zh4T/p2p-circuit/p2p/${PEER}`;
const PROTO = '/aether/chat/0.2.0';

function respFrame(payload: string, requestId?: string): Uint8Array {
  return frameMessage(encodePeerStreamResponse({ payload: new TextEncoder().encode(payload), requestId }));
}

/** A controllable duplex fake: tests push inbound chunks / EOF / errors. */
function muxStream() {
  const sent: Uint8Array[] = [];
  const queue: Array<{ chunk?: Uint8Array; end?: boolean; err?: Error }> = [];
  let wake: (() => void) | null = null;
  const push = (item: { chunk?: Uint8Array; end?: boolean; err?: Error }) => {
    queue.push(item);
    wake?.();
    wake = null;
  };
  return {
    sent,
    aborted: null as Error | null,
    inactivityTimeout: 0,
    send(d: Uint8Array) { sent.push(d); return true; },
    async sendCloseWrite() { /* legacy single-shot half-close */ },
    abort(err: Error) { this.aborted = err; push({ end: true }); },
    respond(payload: string, requestId?: string) { push({ chunk: respFrame(payload, requestId) }); },
    pushChunk(chunk: Uint8Array) { push({ chunk }); },
    end() { push({ end: true }); },
    fail(err: Error) { push({ err }); },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        while (queue.length === 0) await new Promise<void>(res => { wake = res; });
        const item = queue.shift()!;
        if (item.err) throw item.err;
        if (item.end) return;
        yield item.chunk!;
      }
    },
  };
}

/** Node whose first dial yields `stream`; later dials yield extra streams in order. */
function fakeNode(...streams: Array<ReturnType<typeof muxStream>>) {
  let i = 0;
  const dialProtocol = vi.fn(async () => {
    if (i >= streams.length) throw new Error('no more fake streams');
    return streams[i++];
  });
  return { node: { dialProtocol, getConnections: () => [] } as unknown as Libp2p, dialProtocol };
}

function sentRequestIds(stream: ReturnType<typeof muxStream>): string[] {
  return stream.sent.map(f => decodePeerStreamRequest(unframeMessage(f)!).requestId ?? '');
}

async function tick(times = 3) {
  for (let i = 0; i < times; i++) await Promise.resolve();
}

describe('persistent mux callFamily', () => {
  beforeEach(() => {
    localStorage.setItem(FEATURE_OVERRIDES_STORAGE_KEY, JSON.stringify({ persistentPeerStreams: true }));
  });
  afterEach(() => localStorage.clear());

  it('pipelines concurrent requests on ONE stream and settles out-of-order responses by request_id', async () => {
    const stream = muxStream();
    const { node, dialProtocol } = fakeNode(stream);

    const p1 = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'req-A');
    const p2 = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'req-B');
    await tick();

    // One stream opened, both requests written to it, no half-close.
    expect(dialProtocol).toHaveBeenCalledTimes(1);
    expect(sentRequestIds(stream)).toEqual(['req-A', 'req-B']);

    // Answer B first, then A — both settle correctly.
    stream.respond('{"n":2}', 'req-B');
    stream.respond('{"n":1}', 'req-A');
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(new TextDecoder().decode(r1.payload)).toBe('{"n":1}');
    expect(new TextDecoder().decode(r2.payload)).toBe('{"n":2}');
    expect(muxPoolSize(node)).toBe(1); // channel stays pooled for the next request
  });

  it('reuses the pooled stream for sequential requests (no second dial)', async () => {
    const stream = muxStream();
    const { node, dialProtocol } = fakeNode(stream);

    const p1 = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'r1');
    await tick();
    stream.respond('{"ok":1}', 'r1');
    await p1;

    const p2 = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'r2');
    await tick();
    stream.respond('{"ok":2}', 'r2');
    await p2;

    expect(dialProtocol).toHaveBeenCalledTimes(1);
    expect(stream.sent.length).toBe(2);
  });

  it('opens SEPARATE channels per protocol to the same peer', async () => {
    const s1 = muxStream(); const s2 = muxStream();
    const { node, dialProtocol } = fakeNode(s1, s2);

    const p1 = callFamily(node, CIRCUIT, '/aether/chat/0.2.0', 'chat.send', undefined, 'c1');
    const p2 = callFamily(node, CIRCUIT, '/aether/presence/0.2.0', 'presence.update', undefined, 'p1');
    await tick();
    expect(dialProtocol).toHaveBeenCalledTimes(2);
    s1.respond('{"ok":true}', 'c1');
    s2.respond('{"ok":true}', 'p1');
    await Promise.all([p1, p2]);
    expect(muxPoolSize(node)).toBe(2);
  });

  it('treats a one-shot legacy responder (respond then close) as a graceful drop: next request re-opens', async () => {
    const oneShot = muxStream();
    const second = muxStream();
    const { node, dialProtocol } = fakeNode(oneShot, second);

    const p1 = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'r1');
    await tick();
    oneShot.respond('{"ok":1}', 'r1');
    oneShot.end(); // legacy peer closes after one response
    expect((await p1).requestId).toBe('r1');
    await tick();
    expect(muxPoolSize(node)).toBe(0); // pool entry dropped on EOF

    const p2 = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'r2');
    await tick();
    second.respond('{"ok":2}', 'r2');
    expect((await p2).requestId).toBe('r2');
    expect(dialProtocol).toHaveBeenCalledTimes(2); // exactly one re-open — the old per-request cost
  });

  it('on pooled-stream death mid-request: rejects pending, then callFamily retries ONCE on a fresh single-shot stream', async () => {
    const dying = muxStream();
    // The retry stream is a legacy single-shot fake: answer arrives immediately.
    const retry = muxStream();
    const { node, dialProtocol } = fakeNode(dying, retry);

    const p = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'r1');
    await tick();
    dying.fail(new Error('stream reset'));
    // Preload the retry response so the single-shot read finds it.
    retry.respond('{"ok":"retried"}', 'r1');
    retry.end();

    const resp = await p;
    expect(new TextDecoder().decode(resp.payload)).toBe('{"ok":"retried"}');
    expect(dialProtocol).toHaveBeenCalledTimes(2);
    // The retry reused the SAME request bytes (same request_id → receiver-side de-dup).
    expect(sentRequestIds(retry)).toEqual(['r1']);
    expect(muxPoolSize(node)).toBe(0);
  });

  it('propagates a dial failure without a second dial (peer unreachable → outbox fallback)', async () => {
    const dialProtocol = vi.fn().mockRejectedValue(new Error('dial failed'));
    const node = { dialProtocol, getConnections: () => [] } as unknown as Libp2p;
    await expect(callFamily(node, CIRCUIT, PROTO, 'chat.send')).rejects.toThrow('dial failed');
    expect(dialProtocol).toHaveBeenCalledTimes(1);
    expect(muxPoolSize(node)).toBe(0); // failed open does not leak a pool entry
  });

  it('times out an unresponsive channel, killing it so the next attempt re-dials (zombie circuit)', async () => {
    vi.useFakeTimers();
    try {
      const zombie = muxStream();
      const retry = muxStream();
      const { node, dialProtocol } = fakeNode(zombie, retry);

      const p = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'r1');
      // Give the open + send a chance to run, then fire the request timeout.
      await vi.advanceTimersByTimeAsync(0);
      retry.respond('{"ok":"after-timeout"}', 'r1');
      retry.end();
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);

      const resp = await p; // settled via the single-shot retry
      expect(new TextDecoder().decode(resp.payload)).toBe('{"ok":"after-timeout"}');
      expect(zombie.aborted).toBeTruthy(); // zombie stream was torn down
      expect(dialProtocol).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('bounds an unresponsive single-shot retry so peer routing and inbox fallback can run', async () => {
    vi.useFakeTimers();
    try {
      const zombie = muxStream();
      const silentRetry = muxStream();
      const { node, dialProtocol } = fakeNode(zombie, silentRetry);

      const request = callFamily(node, CIRCUIT, PROTO, 'friends.request', undefined, 'silent-1');
      const rejected = expect(request).rejects.toThrow('no single-shot response');
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(REQUEST_TIMEOUT_MS);
      await vi.advanceTimersByTimeAsync(SINGLE_SHOT_RESPONSE_TIMEOUT_MS);
      await rejected;

      expect(zombie.aborted).toBeTruthy();
      expect(silentRetry.aborted?.message).toContain('no single-shot response');
      expect(dialProtocol).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('settles a single pending request from a response with an EMPTY request_id (Go error-path compat)', async () => {
    const stream = muxStream();
    const { node } = fakeNode(stream);
    const p = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'r1');
    await tick();
    stream.respond('{"ok":false,"error":"parse"}'); // no request_id echoed
    const resp = await p;
    expect(new TextDecoder().decode(resp.payload)).toBe('{"ok":false,"error":"parse"}');
  });

  it('DEADLOCK GUARD: a caller parked on the drain gate is released when the channel dies', async () => {
    // send() returns false → the gate arms; the stream then dies WITHOUT ever
    // emitting 'drain' (the write-buffer-overflow reset path). Before the fix,
    // the parked second request hung forever — wedging the outbox drain chain.
    const stream = muxStream();
    const drainListeners: Array<() => void> = [];
    (stream as unknown as { addEventListener(type: string, cb: () => void): void }).addEventListener =
      (type: string, cb: () => void) => { if (type === 'drain') drainListeners.push(cb); };
    stream.send = (d: Uint8Array) => { stream.sent.push(d); return false; }; // permanent backpressure

    const ch = new MuxChannel(stream as never, () => {});
    const p1 = ch.request(respFrame('{"x":1}', 'r1'), 'r1');
    const p2 = ch.request(respFrame('{"x":2}', 'r2'), 'r2'); // parks on the gate
    await tick();
    expect(stream.sent.length).toBe(1); // r2 never sent — parked

    ch.destroy(new MuxStreamError('write buffer overflow reset'));
    await expect(p1).rejects.toThrow(MuxStreamError);
    await expect(p2).rejects.toThrow(MuxStreamError); // released, not hung
    expect(drainListeners.length).toBe(1); // gate was armed via the real path
  });

  it('isDirectAddr: dialer-side WebRTC addrs (circuit-prefixed) count as DIRECT', () => {
    // The DIALER of a browser↔browser WebRTC link keeps the full dialed form as
    // remoteAddr; only the listener sees the clean /webrtc form. Both are direct.
    expect(isDirectAddr(`/ip4/1.2.3.4/tcp/9999/ws/p2p/12D3KooWRelay/p2p-circuit/webrtc/p2p/${PEER}`)).toBe(true);
    expect(isDirectAddr(`/webrtc/p2p/${PEER}`)).toBe(true);
    expect(isDirectAddr(`/ip4/1.2.3.4/tcp/9999/ws/p2p/12D3KooWRelay/p2p-circuit/p2p/${PEER}`)).toBe(false);
    expect(isDirectAddr('/ip4/1.2.3.4/tcp/9999/ws/p2p/12D3KooWRelay')).toBe(true); // plain WS to the relay itself
    expect(isDirectAddr(undefined)).toBe(false);
  });

  it('reassembles responses split across chunks and multiple responses within one chunk', async () => {
    const stream = muxStream();
    const { node } = fakeNode(stream);

    const p1 = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'r1');
    const p2 = callFamily(node, CIRCUIT, PROTO, 'chat.send', undefined, 'r2');
    await tick();

    const f1 = respFrame('{"n":1}', 'r1');
    const f2 = respFrame('{"n":2}', 'r2');
    // First frame split mid-way; its tail glued to the whole second frame.
    const glued = new Uint8Array(f1.length - 3 + f2.length);
    glued.set(f1.subarray(3), 0);
    glued.set(f2, f1.length - 3);
    stream.pushChunk(f1.subarray(0, 3));
    stream.pushChunk(glued);

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(new TextDecoder().decode(r1.payload)).toBe('{"n":1}');
    expect(new TextDecoder().decode(r2.payload)).toBe('{"n":2}');
  });
});
