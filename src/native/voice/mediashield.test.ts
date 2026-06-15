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
