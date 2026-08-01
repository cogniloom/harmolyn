// FrameDecoder + serveFamilyStream — the primitives that make PeerStream
// streams persistent: incremental frame extraction that retains partial
// trailing bytes, and the inbound loop that serves MANY requests per stream.
import { describe, it, expect, vi } from 'vitest';
import {
  FrameDecoder,
  serveFamilyStream,
  frameMessage,
  encodePeerStreamRequest,
  encodePeerStreamResponse,
  decodePeerStreamResponse,
  decodePeerStreamRequest,
  unframeMessage,
  MAX_FRAME_BYTES,
  type PeerStreamRequest,
} from './frames';

const enc = new TextEncoder();
const dec = new TextDecoder();

function reqFrame(operation: string, requestId: string, payload?: object): Uint8Array {
  return frameMessage(encodePeerStreamRequest({
    operation,
    requestId,
    payload: payload ? enc.encode(JSON.stringify(payload)) : undefined,
  }));
}

describe('FrameDecoder', () => {
  it('extracts multiple complete frames from one chunk', () => {
    const d = new FrameDecoder();
    const a = frameMessage(new Uint8Array([1, 2, 3]));
    const b = frameMessage(new Uint8Array([4, 5]));
    const glued = new Uint8Array(a.length + b.length);
    glued.set(a, 0); glued.set(b, a.length);
    const frames = d.push(glued);
    expect(frames.map(f => [...f])).toEqual([[1, 2, 3], [4, 5]]);
    expect(d.bufferedBytes).toBe(0);
  });

  it('retains a partial frame across pushes (including a split length prefix)', () => {
    const d = new FrameDecoder();
    const frame = frameMessage(new Uint8Array([9, 8, 7, 6]));
    expect(d.push(frame.subarray(0, 2))).toEqual([]); // half the length prefix
    expect(d.push(frame.subarray(2, 5))).toEqual([]); // rest of prefix + 1 body byte
    const frames = d.push(frame.subarray(5));
    expect(frames.map(f => [...f])).toEqual([[9, 8, 7, 6]]);
  });

  it('handles a chunk that ends one frame and begins the next', () => {
    const d = new FrameDecoder();
    const a = frameMessage(new Uint8Array([1]));
    const b = frameMessage(new Uint8Array([2, 2]));
    const glued = new Uint8Array(a.length + 3);
    glued.set(a, 0); glued.set(b.subarray(0, 3), a.length);
    expect(d.push(glued).map(f => [...f])).toEqual([[1]]);
    expect(d.push(b.subarray(3)).map(f => [...f])).toEqual([[2, 2]]);
  });

  it('throws on a frame length beyond the cap (poisoned stream)', () => {
    const d = new FrameDecoder();
    const bogus = new Uint8Array(8);
    new DataView(bogus.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    expect(() => d.push(bogus)).toThrow(/exceeds cap/);
  });

  it('decodes zero-length frames', () => {
    const d = new FrameDecoder();
    const frames = d.push(frameMessage(new Uint8Array(0)));
    expect(frames.length).toBe(1);
    expect(frames[0].length).toBe(0);
  });
});

describe('PeerStreamRequest capability interop', () => {
  it('round-trips repeated advertised capabilities used by Go negotiation', () => {
    const decoded = decodePeerStreamRequest(encodePeerStreamRequest({
      operation: 'sync.coverage',
      advertisedCaps: ['cap.sync', 'cap.peer.transport'],
      requestId: 'caps-1',
    }));
    expect(decoded.advertisedCaps).toEqual(['cap.sync', 'cap.peer.transport']);
  });

  it('rejects an oversized advertised capability', () => {
    expect(() => encodePeerStreamRequest({
      operation: 'peer.info',
      advertisedCaps: ['x'.repeat(129)],
    })).toThrow(/capability exceeds limit/);
  });
});

/** Controllable inbound stream fake. */
function inboundStream() {
  const sent: Uint8Array[] = [];
  const queue: Array<{ chunk?: Uint8Array; end?: boolean; err?: Error }> = [];
  let wake: (() => void) | null = null;
  const push = (item: { chunk?: Uint8Array; end?: boolean; err?: Error }) => {
    queue.push(item); wake?.(); wake = null;
  };
  return {
    sent,
    closed: false,
    aborted: null as Error | null,
    send(d: Uint8Array) { sent.push(d); return true; },
    async close() { this.closed = true; },
    abort(err: Error) { this.aborted = err; },
    pushChunk(c: Uint8Array) { push({ chunk: c }); },
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

function sentResponses(stream: ReturnType<typeof inboundStream>) {
  return stream.sent.map(f => decodePeerStreamResponse(unframeMessage(f)!));
}

describe('serveFamilyStream', () => {
  it('serves MANY requests on one stream, echoing each request_id', async () => {
    const stream = inboundStream();
    const seen: string[] = [];
    const serving = serveFamilyStream(stream, (req) => {
      seen.push(req.operation);
      return frameMessage(encodePeerStreamResponse({ payload: enc.encode('{"ok":true}'), requestId: req.requestId }));
    });

    stream.pushChunk(reqFrame('chat.send', 'r1'));
    stream.pushChunk(reqFrame('chat.edit', 'r2'));
    stream.pushChunk(reqFrame('chat.delete', 'r3'));
    stream.end();
    await serving;

    expect(seen).toEqual(['chat.send', 'chat.edit', 'chat.delete']);
    expect(sentResponses(stream).map(r => r.requestId)).toEqual(['r1', 'r2', 'r3']);
    expect(stream.closed).toBe(true);
  });

  it('handles two requests glued into one chunk', async () => {
    const stream = inboundStream();
    const serving = serveFamilyStream(stream, (req) =>
      frameMessage(encodePeerStreamResponse({ payload: enc.encode('{}'), requestId: req.requestId })));
    const a = reqFrame('op.a', 'a');
    const b = reqFrame('op.b', 'b');
    const glued = new Uint8Array(a.length + b.length);
    glued.set(a, 0); glued.set(b, a.length);
    stream.pushChunk(glued);
    stream.end();
    await serving;
    expect(sentResponses(stream).map(r => r.requestId)).toEqual(['a', 'b']);
  });

  it('legacy one-shot caller: request + half-close still receives its response before close', async () => {
    const stream = inboundStream();
    const serving = serveFamilyStream(stream, (req) =>
      frameMessage(encodePeerStreamResponse({ payload: enc.encode('{"ok":1}'), requestId: req.requestId })));
    stream.pushChunk(reqFrame('sync.join', 'j1'));
    stream.end(); // legacy caller sendCloseWrite
    await serving;
    const resps = sentResponses(stream);
    expect(resps.length).toBe(1);
    expect(resps[0].requestId).toBe('j1');
    expect(dec.decode(resps[0].payload)).toBe('{"ok":1}');
    expect(stream.closed).toBe(true);
  });

  it('drains an ASYNC in-flight handler before closing on peer EOF', async () => {
    const stream = inboundStream();
    let release!: () => void;
    const gate = new Promise<void>(res => { release = res; });
    const serving = serveFamilyStream(stream, async (req) => {
      await gate; // handler still working when EOF arrives
      return frameMessage(encodePeerStreamResponse({ payload: enc.encode('{"slow":true}'), requestId: req.requestId }));
    });
    stream.pushChunk(reqFrame('voice.offer', 'o1'));
    stream.end();
    await Promise.resolve();
    expect(stream.sent.length).toBe(0); // response not written yet
    release();
    await serving;
    expect(sentResponses(stream).map(r => r.requestId)).toEqual(['o1']); // flushed before close
    expect(stream.closed).toBe(true);
  });

  it('dispatches concurrently: a slow request does not block a later one', async () => {
    const stream = inboundStream();
    let releaseSlow!: () => void;
    const slowGate = new Promise<void>(res => { releaseSlow = res; });
    const serving = serveFamilyStream(stream, async (req: PeerStreamRequest) => {
      if (req.operation === 'slow') await slowGate;
      return frameMessage(encodePeerStreamResponse({ payload: enc.encode('{}'), requestId: req.requestId }));
    });
    stream.pushChunk(reqFrame('slow', 's1'));
    stream.pushChunk(reqFrame('fast', 'f1'));
    // Let the fast one complete while the slow one is parked.
    await new Promise(res => setTimeout(res, 0));
    expect(sentResponses(stream).map(r => r.requestId)).toEqual(['f1']);
    releaseSlow();
    stream.end();
    await serving;
    expect(sentResponses(stream).map(r => r.requestId)).toEqual(['f1', 's1']); // out-of-order is fine: correlation is by request_id
  });

  it('a throwing handler skips its response without poisoning the stream', async () => {
    const stream = inboundStream();
    const serving = serveFamilyStream(stream, (req) => {
      if (req.operation === 'bad') throw new Error('handler exploded');
      return frameMessage(encodePeerStreamResponse({ payload: enc.encode('{}'), requestId: req.requestId }));
    });
    stream.pushChunk(reqFrame('bad', 'b1'));
    stream.pushChunk(reqFrame('good', 'g1'));
    stream.end();
    await serving;
    expect(sentResponses(stream).map(r => r.requestId)).toEqual(['g1']);
    expect(stream.closed).toBe(true);
  });

  it('null response means fire-and-forget (no bytes written)', async () => {
    const stream = inboundStream();
    const handled = vi.fn(() => null);
    const serving = serveFamilyStream(stream, handled);
    stream.pushChunk(reqFrame('notify.push', 'n1'));
    stream.end();
    await serving;
    expect(handled).toHaveBeenCalledTimes(1);
    expect(stream.sent.length).toBe(0);
  });

  it('aborts the stream on a poisoned frame length instead of looping forever', async () => {
    const stream = inboundStream();
    const serving = serveFamilyStream(stream, () => null);
    const bogus = new Uint8Array(8);
    new DataView(bogus.buffer).setUint32(0, MAX_FRAME_BYTES + 1, false);
    stream.pushChunk(bogus);
    await serving;
    expect(stream.aborted).toBeTruthy();
    expect(stream.closed).toBe(false);
  });

  it('survives a stream error mid-iteration (reset) without throwing', async () => {
    const stream = inboundStream();
    const serving = serveFamilyStream(stream, (req) =>
      frameMessage(encodePeerStreamResponse({ payload: enc.encode('{}'), requestId: req.requestId })));
    stream.pushChunk(reqFrame('op', 'r1'));
    stream.fail(new Error('stream reset'));
    await expect(serving).resolves.toBeUndefined();
  });
});

// A hostile peer controls every byte of a frame's protobuf body. These cover the
// decoders' behaviour on bodies that are malformed rather than merely unknown:
// the loops must always terminate and never read outside the buffer.
describe('protobuf decoder hardening (malformed frames)', () => {
  // Field 2 (payload), wire type 2, then a 5-byte varint length whose top group
  // sets bit 31. Accumulated with the 32-bit signed `<<`, that length decodes to
  // -2147483648, so `off += len` walks the cursor billions of bytes BACKWARDS and
  // the decode loop never terminates — one frame hangs the tab.
  const negativeLengthBody = new Uint8Array([0x12, 0x80, 0x80, 0x80, 0x80, 0x08]);

  it('terminates on a length varint that decodes negative', () => {
    const start = Date.now();
    const req = decodePeerStreamRequest(negativeLengthBody);
    expect(Date.now() - start).toBeLessThan(1000);
    expect(req.payload).toBeUndefined();
  });

  it('terminates on a negative length in a response frame', () => {
    const start = Date.now();
    const resp = decodePeerStreamResponse(new Uint8Array([0x22, 0x80, 0x80, 0x80, 0x80, 0x08]));
    expect(Date.now() - start).toBeLessThan(1000);
    expect(resp.payload).toBeUndefined();
  });

  it('rejects a field whose length runs past the end of the buffer', () => {
    // Field 1 (operation), wire type 2, length 200, but only 3 bytes follow.
    const req = decodePeerStreamRequest(new Uint8Array([0x0a, 0xc8, 0x01, 1, 2, 3]));
    expect(req.operation).toBe('');
  });

  it('rejects oversized operation and request-id fields before decoding them', () => {
    // Build malformed wire bytes directly because the safe encoder rejects
    // these fields before they can leave the process.
    const oversizedOperation = new Uint8Array([0x0a, 0x81, 0x01, ...new TextEncoder().encode('x'.repeat(129))]);
    const oversizedRequestID = new Uint8Array([0x0a, 0x09, ...new TextEncoder().encode('chat.send'), 0x3a, 0x81, 0x01, ...new TextEncoder().encode('x'.repeat(129))]);
    expect(decodePeerStreamRequest(oversizedOperation).malformed).toBe(true);
    expect(decodePeerStreamRequest(oversizedRequestID).malformed).toBe(true);
  });

  it('terminates on a truncated varint with no terminating byte', () => {
    const start = Date.now();
    const req = decodePeerStreamRequest(new Uint8Array([0x0a, 0x80, 0x80, 0x80]));
    expect(Date.now() - start).toBeLessThan(1000);
    expect(req.operation).toBe('');
  });

  it('still round-trips well-formed frames unchanged', () => {
    const encoded = encodePeerStreamRequest({
      operation: 'chat.send',
      requestId: 'r-42',
      payload: enc.encode('{"a":1}'),
    });
    const req = decodePeerStreamRequest(encoded);
    expect(req.operation).toBe('chat.send');
    expect(req.requestId).toBe('r-42');
    expect(dec.decode(req.payload)).toBe('{"a":1}');
  });
});
