import { describe, it, expect } from 'vitest';
import {
  generateIdentity, createIdentityCert, verifyIdentityCert, identitySigningKey,
  buildBundle, verifyBundle, x3dhInitiate, x3dhRespond, ratchetEncrypt, ratchetDecrypt,
  newCrowdGroup, crowdEncrypt, crowdDecrypt,
  newPeerKey, encryptFrame, decryptFrame,
  uploadBlob, downloadBlob, encryptIdentity, decryptIdentity,
  XoreinNativeEngine,
} from './engine';
import { ARGON2_TEST_PARAMS } from '../identity/storage';

// Smoke test: verify all exported primitives are accessible and correct types.
describe('NativeEngine exports smoke test', () => {
  it('identity exports work', async () => {
    const id = await generateIdentity();
    expect(id.peerId).toMatch(/^12D3KooW/);
    const cert = createIdentityCert(id);
    expect(verifyIdentityCert(cert)).toBe(true);
  });

  it('Seal DM exports work (X3DH + ratchet)', async () => {
    const alice = await generateIdentity();
    const bob = await generateIdentity();
    const { bundle, priv } = buildBundle(bob.peerId, identitySigningKey(bob));
    expect(verifyBundle(bundle)).toBe(true);
    const { im, rs: aliceRs } = x3dhInitiate(alice.edSeed, bundle);
    const bobRs = x3dhRespond(im, priv, bundle, bob.edSeed, alice.edPub);
    const [h, ct] = ratchetEncrypt(aliceRs, new TextEncoder().encode('P10 works'));
    expect(new TextDecoder().decode(ratchetDecrypt(bobRs, h, ct))).toBe('P10 works');
  });

  it('Crowd mode exports work', () => {
    const g = newCrowdGroup('test-scope');
    const ct = crowdEncrypt(g, 'alice', new TextEncoder().encode('broadcast'));
    expect(new TextDecoder().decode(crowdDecrypt(g, ct))).toBe('broadcast');
  });

  it('MediaShield exports work', () => {
    const key = new Uint8Array(32).fill(0x99);
    const sender = newPeerKey('alice', key);
    const recv = newPeerKey('alice', key);
    const rtp = new Uint8Array(4);
    const [hdr, ct] = encryptFrame(sender, rtp, new TextEncoder().encode('voice'));
    expect(new TextDecoder().decode(decryptFrame(recv, rtp, hdr, ct))).toBe('voice');
  });

  it('blob encryption exports work', async () => {
    const { encryptBlob, decryptBlob } = await import('../blobs/blobs.js');
    const data = new TextEncoder().encode('file content');
    const { ciphertext, key, nonce } = encryptBlob(data);
    expect(new TextDecoder().decode(decryptBlob(ciphertext, key, nonce))).toBe('file content');
  });

  it('identity encryption/decryption round-trip with test params', async () => {
    const id = await generateIdentity();
    const blob = encryptIdentity(id, 'test-pass', ARGON2_TEST_PARAMS);
    const restored = await decryptIdentity(blob, 'test-pass');
    expect(restored.peerId).toBe(id.peerId);
  });
});

// Regression test: XoreinNativeEngine.sign()/verify() must not use require().
// Before this fix, those methods called require('../crypto/hybrid.js') at call-time,
// which throws in an ESM/browser bundle. This test catches that regression by:
// 1. Importing XoreinNativeEngine (ESM imports resolve at module load — would fail if engine.ts
//    had a top-level require() of a missing module, or if hybridSign/hybridVerify are absent).
// 2. Exercising sign()/verify() with a real identity injected, confirming the ESM-imported
//    hybridSign/hybridVerify functions are reachable without going through engine.start()
//    (which would require an actual libp2p relay connection).
describe('XoreinNativeEngine.sign/verify (ESM import regression)', () => {
  it('constructs without error (module loads cleanly)', () => {
    expect(() => new XoreinNativeEngine({ passphrase: 'test' })).not.toThrow();
  });

  it('sign() and verify() round-trip via hybrid crypto', async () => {
    const id = await generateIdentity();
    const engine = new XoreinNativeEngine({ passphrase: 'test' });
    // Bypass engine.start() (needs a live relay) by injecting the identity directly.
    (engine as unknown as Record<string, unknown>)._identity = id;
    (engine as unknown as Record<string, unknown>)._started = true;

    const msg = new TextEncoder().encode('stage-0 regression test');
    const sig = engine.sign(msg);
    expect(sig).toBeInstanceOf(Uint8Array);
    expect(sig.length).toBeGreaterThan(64);

    const ok = engine.verify(msg, sig, id.edPub, id.mldsaPub);
    expect(ok).toBe(true);

    // Wrong message must not verify.
    const tampered = new TextEncoder().encode('tampered');
    expect(engine.verify(tampered, sig, id.edPub, id.mldsaPub)).toBe(false);
  });
});
