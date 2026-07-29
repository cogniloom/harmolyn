import { describe, it, expect } from 'vitest';
import {
  peerKID, deriveNonce, buildSFrameHeader, encryptFrame, decryptFrame,
  newPeerKey, SFRAME_HEADER_SIZE,
} from './mediashield';

const rtp = new Uint8Array([0x80, 0x00, 0x00, 0x01]); // minimal RTP header

describe('MediaShield SFrame E2EE', () => {
  it('peerKID returns first 8 bytes of SHA-256(peerID)', () => {
    const kid = peerKID('alice');
    expect(kid.length).toBe(8);
    // Deterministic
    expect([...peerKID('alice')]).toEqual([...peerKID('alice')]);
    // Different peers have different KIDs
    expect([...peerKID('alice')]).not.toEqual([...peerKID('bob')]);
  });

  it('deriveNonce returns 12 bytes', () => {
    const key = new Uint8Array(32).fill(0x42);
    const nonce = deriveNonce(key, 0n);
    expect(nonce.length).toBe(12);
    // Different counters produce different nonces
    expect([...deriveNonce(key, 0n)]).not.toEqual([...deriveNonce(key, 1n)]);
  });

  it('buildSFrameHeader is 16 bytes with KID prefix', () => {
    const hdr = buildSFrameHeader('alice', 42n);
    expect(hdr.length).toBe(SFRAME_HEADER_SIZE);
    expect([...hdr.slice(0, 8)]).toEqual([...peerKID('alice')]);
    // Counter in bytes 8-15 (big-endian)
    const view = new DataView(hdr.buffer, hdr.byteOffset);
    const hi = view.getUint32(8, false);
    const lo = view.getUint32(12, false);
    expect(BigInt(hi) * (1n << 32n) + BigInt(lo)).toBe(42n);
  });

  it('encryptFrame / decryptFrame round-trip', () => {
    const key = new Uint8Array(32).fill(0xde);
    const alice = newPeerKey('alice', key);
    const bob   = newPeerKey('alice', key); // bob uses alice's key for decryption

    const plaintext = new TextEncoder().encode('voice frame payload');
    const [sframeHeader, ct] = encryptFrame(alice, rtp, plaintext);

    expect(sframeHeader.length).toBe(SFRAME_HEADER_SIZE);
    const recovered = decryptFrame(bob, rtp, sframeHeader, ct);
    expect(new TextDecoder().decode(recovered)).toBe('voice frame payload');
  });

  it('frame counter increments after each encrypt', () => {
    const pk = newPeerKey('alice', new Uint8Array(32));
    expect(pk.frameCounter).toBe(0n);
    encryptFrame(pk, rtp, new Uint8Array(4));
    expect(pk.frameCounter).toBe(1n);
    encryptFrame(pk, rtp, new Uint8Array(4));
    expect(pk.frameCounter).toBe(2n);
  });

  it('rejects KID mismatch', () => {
    const key = new Uint8Array(32).fill(0xaa);
    const sender = newPeerKey('alice', key);
    const receiver = newPeerKey('bob', key); // different peerID → different KID
    const [hdr, ct] = encryptFrame(sender, rtp, new Uint8Array([1, 2, 3]));
    expect(() => decryptFrame(receiver, rtp, hdr, ct)).toThrow('KID mismatch');
  });

  it('rejects replay', () => {
    const key = new Uint8Array(32).fill(0xbb);
    const sender = newPeerKey('alice', key);
    const receiver = newPeerKey('alice', key);
    const [hdr, ct] = encryptFrame(sender, rtp, new Uint8Array([1]));
    // First decrypt succeeds
    decryptFrame(receiver, rtp, new Uint8Array(hdr), new Uint8Array(ct));
    // Second decrypt of same frame is replay
    expect(() => decryptFrame(receiver, rtp, hdr, ct)).toThrow('replay');
  });
});

describe('MediaShield — per-sender counter slots (nonce-reuse regression)', () => {
  // Regression for a critical bug: every scriptTransform Worker builds its OWN
  // in-worker PeerKey from cloned key bytes (structured clone, not a live
  // reference), so multiple concurrent senders under the SAME key (mic + camera
  // to one peer, or one Crowd sender key shared across a mesh) each restarted
  // their frame counter at 0 — producing colliding (key, nonce) AES-GCM inputs,
  // the "forbidden attack" that leaks the authentication key and breaks both
  // confidentiality and integrity. newPeerKey's counterSlot partitions the
  // 48-bit counter space so independently-counting instances under the same key
  // can never collide.

  it('different slots under the SAME key start at disjoint, non-colliding counters', () => {
    const key = new Uint8Array(32).fill(0x11);
    const mic = newPeerKey('me', key, 0);
    const camera = newPeerKey('me', key, 1);
    expect(mic.frameCounter).not.toBe(camera.frameCounter);
    expect(mic.frameCounter).toBeLessThan(camera.frameCounter);
  });

  it('the same nonce/frame-counter is never reused across two senders under the same key', () => {
    const key = new Uint8Array(32).fill(0x22);
    const mic = newPeerKey('me', key, 0);
    const camera = newPeerKey('me', key, 1);

    // Simulate a real session: several frames from each independently-counting
    // sender, interleaved, exactly as would happen with two live Workers.
    const seen = new Set<string>();
    for (let i = 0; i < 5; i++) {
      const [micHdr] = encryptFrame(mic, rtp, new Uint8Array([1]));
      const [camHdr] = encryptFrame(camera, rtp, new Uint8Array([2]));
      const micNonce = deriveNonce(key, readCounter(micHdr));
      const camNonce = deriveNonce(key, readCounter(camHdr));
      const micKey = `${[...micNonce]}`;
      const camKey = `${[...camNonce]}`;
      expect(seen.has(micKey)).toBe(false);
      expect(seen.has(camKey)).toBe(false);
      seen.add(micKey);
      seen.add(camKey);
    }
  });

  it('a slotted sender still round-trips normally with a receiver decrypting its stream', () => {
    const key = new Uint8Array(32).fill(0x33);
    const camera = newPeerKey('me', key, 7);
    const receiver = newPeerKey('me', key); // receiver just tracks whatever counters arrive

    const [h1, c1] = encryptFrame(camera, rtp, new TextEncoder().encode('frame one'));
    expect(new TextDecoder().decode(decryptFrame(receiver, rtp, h1, c1))).toBe('frame one');
    const [h2, c2] = encryptFrame(camera, rtp, new TextEncoder().encode('frame two'));
    expect(new TextDecoder().decode(decryptFrame(receiver, rtp, h2, c2))).toBe('frame two');
  });

  it('a slot cannot overflow into the next slot\'s counter range', () => {
    const key = new Uint8Array(32).fill(0x44);
    const pk = newPeerKey('me', key, 2);
    // Push right up to this slot's ceiling.
    pk.frameCounter = pk.maxFrameCounter;
    encryptFrame(pk, rtp, new Uint8Array([1])); // consumes the last valid counter
    expect(pk.frameCounter).toBe(pk.maxFrameCounter + 1n);
    expect(() => encryptFrame(pk, rtp, new Uint8Array([1]))).toThrow('overflow');
  });

  it('rejects an out-of-range counterSlot', () => {
    const key = new Uint8Array(32);
    expect(() => newPeerKey('me', key, -1)).toThrow();
  });
});

function readCounter(sframeHeader: Uint8Array): bigint {
  const view = new DataView(sframeHeader.buffer, sframeHeader.byteOffset + 8, 8);
  return (BigInt(view.getUint32(0, false)) << 32n) | BigInt(view.getUint32(4, false));
}
