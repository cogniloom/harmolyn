import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  identityFromStored,
  createIdentityCert,
  verifyIdentityCert,
  identitySigningKey,
} from './identity';
import { hybridSign, hybridVerify, signingPublic } from '../crypto/hybrid';
import { encryptIdentity, decryptIdentity, ARGON2_TEST_PARAMS } from './storage';

describe('identity generation', () => {
  it('generates a complete identity with all key material', async () => {
    const id = await generateIdentity();
    expect(id.edSeed.length).toBe(32);
    expect(id.edPub.length).toBe(32);
    expect(id.edPriv.length).toBe(64);
    expect(id.mldsaPriv.length).toBe(4032);
    expect(id.mldsaPub.length).toBe(1952);
    expect(id.peerId).toMatch(/^12D3KooW/);
  });

  it('edPriv = edSeed || edPub (Go oracle format)', async () => {
    const id = await generateIdentity();
    expect([...id.edPriv.subarray(0, 32)]).toEqual([...id.edSeed]);
    expect([...id.edPriv.subarray(32, 64)]).toEqual([...id.edPub]);
  });

  it('identityFromStored round-trips through the Go stored format', async () => {
    const id = await generateIdentity();
    const restored = await identityFromStored(id.edPriv, id.mldsaPriv);
    expect([...restored.edPub]).toEqual([...id.edPub]);
    expect([...restored.mldsaPub]).toEqual([...id.mldsaPub]);
    expect(restored.peerId).toBe(id.peerId);
  });

  it('signing key derived from identity works with hybridSign/hybridVerify', async () => {
    const id = await generateIdentity();
    const key = identitySigningKey(id);
    const msg = new TextEncoder().encode('test message');
    const sig = hybridSign(msg, key);
    expect(hybridVerify(msg, sig, signingPublic(key))).toBe(true);
  });
});

describe('IdentityCert', () => {
  it('creates a cert with all required fields', async () => {
    const id = await generateIdentity();
    const cert = createIdentityCert(id);
    expect(cert.peer_id).toBe(id.peerId);
    expect(cert.ed_public_key.length).toBe(32);
    expect(cert.mldsa_public_key.length).toBe(1952);
    expect(cert.issued_at).toBeGreaterThan(0);
    expect(cert.ed_over_mldsa_sig.length).toBe(64);
    expect(cert.mldsa_over_ed_sig.length).toBe(3309);
  });

  it('verifies a valid cert', async () => {
    const id = await generateIdentity();
    const cert = createIdentityCert(id);
    expect(verifyIdentityCert(cert)).toBe(true);
  });

  it('rejects a cert with tampered peer_id', async () => {
    const id = await generateIdentity();
    const cert = createIdentityCert(id);
    cert.peer_id = cert.peer_id.slice(0, -1) + 'X';
    expect(verifyIdentityCert(cert)).toBe(false);
  });

  it('rejects a cert with tampered ed_public_key', async () => {
    const id = await generateIdentity();
    const cert = createIdentityCert(id);
    cert.ed_public_key[0] ^= 1;
    expect(verifyIdentityCert(cert)).toBe(false);
  });

  it('rejects a cert with tampered ed_over_mldsa_sig', async () => {
    const id = await generateIdentity();
    const cert = createIdentityCert(id);
    cert.ed_over_mldsa_sig[0] ^= 1;
    expect(verifyIdentityCert(cert)).toBe(false);
  });
});

describe('encrypted identity storage', () => {
  it('encrypt/decrypt round-trip preserves all key material', async () => {
    const id = await generateIdentity();
    const passphrase = 'correct-horse-battery-staple';
    const blob = encryptIdentity(id, passphrase, ARGON2_TEST_PARAMS);
    expect(blob.v).toBe(1);
    expect(blob.kdf).toBe('argon2id');
    expect(blob.salt.length).toBe(32); // 16 bytes hex = 32 chars
    expect(blob.nonce.length).toBe(24); // 12 bytes hex = 24 chars

    const restored = await decryptIdentity(blob, passphrase);
    expect(restored.peerId).toBe(id.peerId);
    expect([...restored.edPriv]).toEqual([...id.edPriv]);
    expect([...restored.mldsaPriv]).toEqual([...id.mldsaPriv]);
  });

  it('rejects wrong passphrase', async () => {
    const id = await generateIdentity();
    const blob = encryptIdentity(id, 'right-password', ARGON2_TEST_PARAMS);
    await expect(decryptIdentity(blob, 'wrong-password')).rejects.toThrow('decryption failed');
  });
});
