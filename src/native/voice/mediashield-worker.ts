// RTCRtpScriptTransform worker for MediaShield SFrame E2EE.
//
// Bundled by Vite as a separate worker chunk:
//   new Worker(new URL('./mediashield-worker.ts', import.meta.url), { type: 'module' })
//
// The worker receives a RTCRtpScriptTransformEvent whose `transformer.options`
// carries { op: 'encrypt'|'decrypt', peerId, keyBytes } and pipes the readable
// stream through the appropriate MediaShield transform to the writable stream.
//
// Noble crypto deps (argon2, aes, sha256) are bundled into this worker chunk
// by Vite automatically because this file imports them.
import { createEncryptTransform, createDecryptTransform, newPeerKey } from './mediashield.js';

interface TransformOptions {
  op: 'encrypt' | 'decrypt';
  peerId: string;
  /** 32-byte key as a regular number array (serialisable across the Worker message boundary). */
  keyBytes: number[];
  /**
   * Disjoint frame-counter slot for THIS worker's PeerKey (see mediashield.ts
   * SLOT_BITS doc). Structured-clone gives this worker its own copy of keyBytes,
   * not a live-shared counter with any other sender using the same key, so an
   * 'encrypt' worker MUST get a slot distinct from every other concurrently
   * active encrypting sender under that key or their nonces will collide.
   * Unused ('decrypt' never allocates counters) — defaults to 0.
   */
  counterSlot?: number;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(self as any).onrtctransform = (event: { transformer: { options: TransformOptions; readable: ReadableStream; writable: WritableStream } }) => {
  const { op, peerId, keyBytes, counterSlot } = event.transformer.options;
  const key = new Uint8Array(keyBytes);
  const pk = newPeerKey(peerId, key, counterSlot ?? 0);

  const transformFn = op === 'encrypt' ? createEncryptTransform(pk) : createDecryptTransform(pk);
  const ts = new TransformStream({ transform: transformFn });
  event.transformer.readable.pipeThrough(ts).pipeTo(event.transformer.writable);
};
