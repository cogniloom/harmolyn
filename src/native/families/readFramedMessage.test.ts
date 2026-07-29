// readFramedMessage returns as soon as one length-prefixed frame is complete,
// WITHOUT waiting for the stream to close. Waiting for EOF cost an extra
// relay-circuit traversal on every request/response.
import { describe, it, expect } from 'vitest';
import { frameMessage, readFramedMessage } from './peerstream.js';

/** A stream that yields the given chunks and then blocks forever (never EOFs). */
function neverEndingStream(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
      // Simulate a peer that has sent its frame but not yet closed the stream.
      await new Promise(() => { /* never resolves */ });
    },
  };
}

function endingStream(chunks: Uint8Array[]): AsyncIterable<Uint8Array> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  };
}

describe('readFramedMessage', () => {
  it('resolves from the length prefix without waiting for stream close', async () => {
    const body = new TextEncoder().encode('hello frame');
    const framed = frameMessage(body);

    const got = await Promise.race([
      readFramedMessage(neverEndingStream([framed])),
      new Promise<'timeout'>((r) => setTimeout(() => r('timeout'), 250)),
    ]);

    expect(got).not.toBe('timeout');
    expect(new TextDecoder().decode(got as Uint8Array)).toBe('hello frame');
  });

  it('reassembles a frame split across several chunks', async () => {
    const body = new TextEncoder().encode('split across chunks');
    const framed = frameMessage(body);
    const chunks = [framed.subarray(0, 2), framed.subarray(2, 7), framed.subarray(7)];

    const got = await readFramedMessage(neverEndingStream(chunks));
    expect(new TextDecoder().decode(got as Uint8Array)).toBe('split across chunks');
  });

  it('ignores trailing bytes beyond the first complete frame', async () => {
    const first = frameMessage(new TextEncoder().encode('first'));
    const second = frameMessage(new TextEncoder().encode('second'));
    const merged = new Uint8Array(first.length + second.length);
    merged.set(first, 0);
    merged.set(second, first.length);

    const got = await readFramedMessage(neverEndingStream([merged]));
    expect(new TextDecoder().decode(got as Uint8Array)).toBe('first');
  });

  it('returns null when the stream ends before any frame completes', async () => {
    const body = new TextEncoder().encode('truncated payload');
    const framed = frameMessage(body);
    // Deliver only the header plus two bytes, then EOF.
    const got = await readFramedMessage(endingStream([framed.subarray(0, 6)]));
    expect(got).toBeNull();
  });

  it('returns null for an empty stream', async () => {
    expect(await readFramedMessage(endingStream([]))).toBeNull();
  });
});
