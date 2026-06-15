import { describe, it, expect } from 'vitest';
import { generateIdentity } from '../identity/identity';
import { identitySigningKey } from '../identity/identity';
import { buildBundle, verifyBundle, x3dhInitiate, x3dhRespond } from './bundle';
import { ratchetEncrypt, ratchetDecrypt, HEADER_SIZE } from './ratchet';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

describe('PrekeyBundle', () => {
  it('builds a valid bundle with all required fields', async () => {
    const id = await generateIdentity();
    const { bundle } = buildBundle(id.peerId, identitySigningKey(id));
    expect(bundle.peer_id).toBe(id.peerId);
    expect(bundle.identity_key_ed25519.length).toBe(32);
    expect(bundle.identity_key_ml_dsa_65.length).toBe(1952);
    expect(bundle.signed_prekey_x25519.length).toBe(32);
    expect(bundle.signed_prekey_signature.length).toBe(3381);
    expect(bundle.ml_kem_768_pk.length).toBe(1184);
    expect(bundle.ml_kem_768_pk_signature.length).toBe(3381);
    expect(bundle.bundle_signature.length).toBe(3381);
    expect(bundle.one_time_prekeys_x25519.length).toBe(20);
  });

  it('verifies a valid bundle', async () => {
    const id = await generateIdentity();
    const { bundle } = buildBundle(id.peerId, identitySigningKey(id));
    expect(verifyBundle(bundle)).toBe(true);
  });

  it('rejects a tampered SPK', async () => {
    const id = await generateIdentity();
    const { bundle } = buildBundle(id.peerId, identitySigningKey(id));
    bundle.signed_prekey_x25519[0] ^= 1;
    expect(verifyBundle(bundle)).toBe(false);
  });

  it('rejects a tampered bundle signature', async () => {
    const id = await generateIdentity();
    const { bundle } = buildBundle(id.peerId, identitySigningKey(id));
    bundle.bundle_signature[0] ^= 1;
    expect(verifyBundle(bundle)).toBe(false);
  });
});

describe('X3DH key agreement', () => {
  it('initiator and responder derive the same root + chain keys', async () => {
    const aliceId = await generateIdentity();
    const bobId   = await generateIdentity();

    // Bob publishes a prekey bundle.
    const { bundle, priv: bobPriv } = buildBundle(bobId.peerId, identitySigningKey(bobId));

    // Alice initiates X3DH to Bob.
    const { im, rs: aliceRs } = x3dhInitiate(aliceId.edSeed, bundle);

    // Bob responds.
    const bobRs = x3dhRespond(im, bobPriv, bundle, bobId.edSeed, aliceId.edPub);

    // Root keys must match.
    expect([...aliceRs.rootKey]).toEqual([...bobRs.rootKey]);
    // Initiator's send chain = responder's recv chain.
    expect([...aliceRs.sendChainKey]).toEqual([...bobRs.recvChainKey]);
  });
});

describe('Double Ratchet encrypt/decrypt', () => {
  it('encrypts and decrypts a message round-trip', async () => {
    const aliceId = await generateIdentity();
    const bobId   = await generateIdentity();
    const { bundle, priv: bobPriv } = buildBundle(bobId.peerId, identitySigningKey(bobId));
    const { im, rs: aliceRs } = x3dhInitiate(aliceId.edSeed, bundle);
    const bobRs = x3dhRespond(im, bobPriv, bundle, bobId.edSeed, aliceId.edPub);

    const msg = enc('Hello Bob, this is Alice!');
    const [header, ct] = ratchetEncrypt(aliceRs, msg);
    expect(header.length).toBe(HEADER_SIZE);

    const pt = ratchetDecrypt(bobRs, header, ct);
    expect(dec(pt)).toBe('Hello Bob, this is Alice!');
  });

  it('multi-message exchange with ratchet steps', async () => {
    const aliceId = await generateIdentity();
    const bobId   = await generateIdentity();
    const { bundle, priv: bobPriv } = buildBundle(bobId.peerId, identitySigningKey(bobId));
    const { im, rs: aliceRs } = x3dhInitiate(aliceId.edSeed, bundle);
    const bobRs = x3dhRespond(im, bobPriv, bundle, bobId.edSeed, aliceId.edPub);

    // Alice → Bob × 3, then Bob → Alice × 2 (triggers ratchet step).
    for (let i = 0; i < 3; i++) {
      const [h, ct] = ratchetEncrypt(aliceRs, enc(`a2b-${i}`));
      expect(dec(ratchetDecrypt(bobRs, h, ct))).toBe(`a2b-${i}`);
    }
    for (let i = 0; i < 2; i++) {
      const [h, ct] = ratchetEncrypt(bobRs, enc(`b2a-${i}`));
      expect(dec(ratchetDecrypt(aliceRs, h, ct))).toBe(`b2a-${i}`);
    }
  });
});
