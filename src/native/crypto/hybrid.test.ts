import { describe, it, expect } from 'vitest';
import {
  generateSigningIdentity,
  signingPublic,
  hybridSign,
  hybridVerify,
  generateKemIdentity,
  kemPublic,
  kemEncapsulate,
  kemDecapsulate,
  ED25519_SIG_LEN,
  ML_DSA65_SIG_LEN,
  HYBRID_SIG_BYTES,
} from './hybrid';

const enc = (s: string) => new TextEncoder().encode(s);

describe('hybrid signing (Ed25519 + ML-DSA-65)', () => {
  it('signs and verifies — total blob is HYBRID_SIG_BYTES (3381)', () => {
    const id = generateSigningIdentity();
    const msg = enc('xorein native engine — P0');
    const sig = hybridSign(msg, id);
    expect(sig.length).toBe(HYBRID_SIG_BYTES);
    expect(HYBRID_SIG_BYTES).toBe(4 + ED25519_SIG_LEN + 4 + ML_DSA65_SIG_LEN);
    expect(hybridVerify(msg, sig, signingPublic(id))).toBe(true);
  });

  it('wire format: len32(edSig) || edSig || len32(mldsaSig) || mldsaSig', () => {
    const id = generateSigningIdentity();
    const sig = hybridSign(enc('m'), id);
    const view = new DataView(sig.buffer, sig.byteOffset);
    // First 4 bytes = uint32BE(64)
    expect(view.getUint32(0, false)).toBe(ED25519_SIG_LEN);
    // Bytes 68–72 = uint32BE(3309)
    expect(view.getUint32(4 + ED25519_SIG_LEN, false)).toBe(ML_DSA65_SIG_LEN);
  });

  it('rejects a tampered message', () => {
    const id = generateSigningIdentity();
    const sig = hybridSign(enc('hello'), id);
    expect(hybridVerify(enc('hell0'), sig, signingPublic(id))).toBe(false);
  });

  it('rejects a wrong signer', () => {
    const a = generateSigningIdentity();
    const b = generateSigningIdentity();
    const msg = enc('m');
    expect(hybridVerify(msg, hybridSign(msg, a), signingPublic(b))).toBe(false);
  });

  it('rejects blobs of wrong length', () => {
    const id = generateSigningIdentity();
    const sig = hybridSign(enc('m'), id);
    expect(hybridVerify(enc('m'), sig.subarray(0, 64), signingPublic(id))).toBe(false);
    expect(hybridVerify(enc('m'), sig.subarray(0, 68), signingPublic(id))).toBe(false);
  });
});

describe('hybrid KEM (X25519 + ML-KEM-768)', () => {
  it('encapsulate/decapsulate agree on a 32-byte secret', () => {
    const id = generateKemIdentity();
    const { ciphertext, sharedSecret } = kemEncapsulate(kemPublic(id));
    const recovered = kemDecapsulate(ciphertext, id);
    expect(sharedSecret.length).toBe(32);
    expect([...recovered]).toEqual([...sharedSecret]);
  });

  it('a different recipient cannot recover the secret', () => {
    const a = generateKemIdentity();
    const b = generateKemIdentity();
    const { ciphertext, sharedSecret } = kemEncapsulate(kemPublic(a));
    const wrong = kemDecapsulate(ciphertext, b);
    expect([...wrong]).not.toEqual([...sharedSecret]);
  });
});
