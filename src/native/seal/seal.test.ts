import { describe, it, expect } from 'vitest';
import { generateIdentity } from '../identity/identity';
import { identitySigningKey } from '../identity/identity';
import { buildBundle, verifyBundle, x3dhInitiate, x3dhRespond } from './bundle';
import { ratchetEncrypt, ratchetDecrypt, pruneSkipList, HEADER_SIZE, SKIPPED_KEY_TTL_MS, type RatchetState } from './ratchet';
import { generateX25519Keypair } from './curve';
import { deriveKey } from './kdf';
import { x25519 } from '@noble/curves/ed25519.js';
import { chacha20poly1305 } from '@noble/ciphers/chacha.js';

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

/** X3DH-establish a live initiator/responder ratchet pair. */
async function establishedPair() {
  const aliceId = await generateIdentity();
  const bobId   = await generateIdentity();
  const { bundle, priv: bobPriv } = buildBundle(bobId.peerId, identitySigningKey(bobId));
  const { im, rs: aliceRs } = x3dhInitiate(aliceId.edSeed, bundle);
  const bobRs = x3dhRespond(im, bobPriv, bundle, bobId.edSeed, aliceId.edPub);
  return { aliceRs, bobRs };
}

/**
 * Emulate the SENDER side of a DH ratchet step (a new ratchet keypair + re-keyed
 * root/send chain). The JS implementation only performs DH steps on receive, so
 * tests use this to act as a stepping remote implementation and drive the
 * receive-side dhRatchetStep branch.
 *
 * Both `baseRootKey` and `remotePub` must be the RECEIVER's (the other party's)
 * CURRENT values, not `s`'s own — `s.rootKey`/`s.remoteRatchetPub` are this party's
 * possibly-stale record of them. In particular, since the responder's send-chain
 * bootstrap fix, a fresh responder's root and pub move past the shared X3DH root
 * and its SPK from the moment its session is constructed, before it has sent
 * anything the other side could have learned those from.
 */
function forceSenderDhStep(s: RatchetState, baseRootKey: Uint8Array, remotePub: Uint8Array): void {
  const { priv, pub } = generateX25519Keypair();
  const dhOut = x25519.getSharedSecret(priv, remotePub);
  const okm = deriveKey(baseRootKey, dhOut, 'xorein/seal/v1/ratchet-step', 64);
  s.prevSendChainLen = s.sendCounter;
  s.sendCounter = 0;
  s.rootKey = okm.slice(0, 32);
  s.sendChainKey = okm.slice(32);
  s.sendRatchetPriv = priv;
  s.sendRatchetPub = pub;
}

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
  it('initiator send chain = responder recv chain', async () => {
    const aliceId = await generateIdentity();
    const bobId   = await generateIdentity();

    // Bob publishes a prekey bundle.
    const { bundle, priv: bobPriv } = buildBundle(bobId.peerId, identitySigningKey(bobId));

    // Alice initiates X3DH to Bob.
    const { im, rs: aliceRs } = x3dhInitiate(aliceId.edSeed, bundle);

    // Bob responds.
    const bobRs = x3dhRespond(im, bobPriv, bundle, bobId.edSeed, aliceId.edPub);

    // Initiator's send chain = responder's recv chain (the "for free" chain X3DH's
    // root-key HKDF splits out — shared verbatim since both sides derive it from the
    // same hybrid_master).
    expect([...aliceRs.sendChainKey]).toEqual([...bobRs.recvChainKey]);
    // The responder's root has ALREADY moved past the initiator's: it bootstraps its
    // own send chain immediately (see the zero-chain-key regression tests below), a
    // ratchet step the initiator has not yet performed on her side.
    expect([...aliceRs.rootKey]).not.toEqual([...bobRs.rootKey]);
  });
});

describe('Double Ratchet — responder send-chain bootstrap (zero-chain-key fix)', () => {
  it('the responder never has an all-zero send chain, even before it decrypts anything', async () => {
    const aliceId = await generateIdentity();
    const bobId   = await generateIdentity();
    const { bundle, priv: bobPriv } = buildBundle(bobId.peerId, identitySigningKey(bobId));
    const { im } = x3dhInitiate(aliceId.edSeed, bundle);
    const bobRs = x3dhRespond(im, bobPriv, bundle, bobId.edSeed, aliceId.edPub);

    expect(bobRs.sendChainKey.every(b => b === 0)).toBe(false);
  });

  it('a passive observer holding only the public all-zero key cannot read the responder first reply', async () => {
    const aliceId = await generateIdentity();
    const bobId   = await generateIdentity();
    const { bundle, priv: bobPriv } = buildBundle(bobId.peerId, identitySigningKey(bobId));
    const { im, rs: aliceRs } = x3dhInitiate(aliceId.edSeed, bundle);
    const bobRs = x3dhRespond(im, bobPriv, bundle, bobId.edSeed, aliceId.edPub);

    // Bob replies FIRST, before ever decrypting anything from Alice.
    const [header, ct] = ratchetEncrypt(bobRs, enc('top secret reply'));

    // Attacker tries the well-known all-zero chain key — the entire pre-fix exploit.
    const okm = deriveKey(new Uint8Array(32), new Uint8Array([0x01]), 'xorein/seal/v1/message-key', 64);
    const mk = okm.slice(0, 32);
    const nonce = header.slice(41, 53);
    expect(() => chacha20poly1305(mk, nonce, header).decrypt(ct)).toThrow();

    // The legitimate initiator can still read it once she processes the rotation.
    expect(dec(ratchetDecrypt(aliceRs, header, ct))).toBe('top secret reply');
  });

  it('responder can reply before ever receiving anything, and the initiator can still decrypt', async () => {
    const aliceId = await generateIdentity();
    const bobId   = await generateIdentity();
    const { bundle, priv: bobPriv } = buildBundle(bobId.peerId, identitySigningKey(bobId));
    const { im, rs: aliceRs } = x3dhInitiate(aliceId.edSeed, bundle);
    const bobRs = x3dhRespond(im, bobPriv, bundle, bobId.edSeed, aliceId.edPub);

    const [h, ct] = ratchetEncrypt(bobRs, enc('hi alice, bob here'));
    expect(dec(ratchetDecrypt(aliceRs, h, ct))).toBe('hi alice, bob here');

    // The session still works normally in both directions afterwards.
    const [h2, ct2] = ratchetEncrypt(aliceRs, enc('hi bob'));
    expect(dec(ratchetDecrypt(bobRs, h2, ct2))).toBe('hi bob');
  });

  it('survives two independent DH ratchet steps on each side (root-chaining regression)', async () => {
    // Every reply here rotates the sender's ratchet keypair — the responder via
    // this fix's bootstrap, the initiator via her first receive-triggered step —
    // so by the 4th message BOTH sides have independently run dhRatchetStep. A
    // root update that only carries the first (recv) KDF_RK call forward and
    // drops the second (send) call's output desyncs the two sides exactly here:
    // this reproduces the "invalid tag" regression the fix above resolved.
    const aliceId = await generateIdentity();
    const bobId   = await generateIdentity();
    const { bundle, priv: bobPriv } = buildBundle(bobId.peerId, identitySigningKey(bobId));
    const { im, rs: aliceRs } = x3dhInitiate(aliceId.edSeed, bundle);
    const bobRs = x3dhRespond(im, bobPriv, bundle, bobId.edSeed, aliceId.edPub);

    const [h1, c1] = ratchetEncrypt(aliceRs, enc('w1'));            // alice's original chain
    expect(dec(ratchetDecrypt(bobRs, h1, c1))).toBe('w1');
    const [h2, c2] = ratchetEncrypt(bobRs, enc('w2'));               // bob's bootstrap chain
    expect(dec(ratchetDecrypt(aliceRs, h2, c2))).toBe('w2');         // alice's 1st DH step
    const [h3, c3] = ratchetEncrypt(aliceRs, enc('w3'));             // alice's rotated chain
    expect(dec(ratchetDecrypt(bobRs, h3, c3))).toBe('w3');           // bob's 1st DH step
    const [h4, c4] = ratchetEncrypt(bobRs, enc('w4'));               // bob's rotated chain
    expect(dec(ratchetDecrypt(aliceRs, h4, c4))).toBe('w4');         // alice's 2nd DH step — the regression
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

describe('Double Ratchet — transactional decrypt (replay hardening)', () => {
  it('a replayed ciphertext throws and the session still decrypts the next genuine message', async () => {
    const { aliceRs, bobRs } = await establishedPair();

    const [h1, c1] = ratchetEncrypt(aliceRs, enc('m1'));
    expect(dec(ratchetDecrypt(bobRs, h1, c1))).toBe('m1');

    // Replay (mailbox blob re-served by the node / outbox retry): must throw…
    expect(() => ratchetDecrypt(bobRs, h1, c1)).toThrow();

    // …WITHOUT advancing the receive chain. Before the transactional fix the
    // failed replay committed recvChainKey/recvCounter first, so this next
    // genuine message failed forever and the DM direction was destroyed.
    const [h2, c2] = ratchetEncrypt(aliceRs, enc('m2'));
    expect(dec(ratchetDecrypt(bobRs, h2, c2))).toBe('m2');
  });

  it('an old-epoch/foreign ratchet-pub header neither re-keys the root nor replaces the local ratchet keypair', async () => {
    const { aliceRs, bobRs } = await establishedPair();

    const [h1, c1] = ratchetEncrypt(aliceRs, enc('a1'));
    expect(dec(ratchetDecrypt(bobRs, h1, c1))).toBe('a1');

    // A ciphertext whose header carries a ratchet pub that is NOT the current
    // remote pub — e.g. a recorded message from an older, since-replaced session
    // re-served by the support node, or a forged header. This used to trigger an
    // UNAUTHENTICATED DH step that re-keyed the root and replaced the local
    // ratchet keypair BEFORE the tag check, permanently destroying the session.
    const foreign = new Uint8Array(h1);
    crypto.getRandomValues(foreign.subarray(9, 41)); // swap in a foreign ratchet pub

    const rootBefore = [...bobRs.rootKey];
    const sendPrivBefore = [...bobRs.sendRatchetPriv];
    const remoteBefore = [...bobRs.remoteRatchetPub];

    expect(() => ratchetDecrypt(bobRs, foreign, c1)).toThrow();
    expect([...bobRs.rootKey]).toEqual(rootBefore);
    expect([...bobRs.sendRatchetPriv]).toEqual(sendPrivBefore);
    expect([...bobRs.remoteRatchetPub]).toEqual(remoteBefore);

    // The session keeps working in both directions.
    const [h2, c2] = ratchetEncrypt(aliceRs, enc('a2'));
    expect(dec(ratchetDecrypt(bobRs, h2, c2))).toBe('a2');
    const [hr, cr] = ratchetEncrypt(bobRs, enc('r1'));
    expect(dec(ratchetDecrypt(aliceRs, hr, cr))).toBe('r1');
  });

  it('a failed decrypt does not consume a stored skipped-message key', async () => {
    const { aliceRs, bobRs } = await establishedPair();

    const [h1, c1] = ratchetEncrypt(aliceRs, enc('m1'));
    const [h2, c2] = ratchetEncrypt(aliceRs, enc('m2'));
    expect(dec(ratchetDecrypt(bobRs, h2, c2))).toBe('m2'); // m1's key is skipped/stored

    // A forged ciphertext under m1's header must not burn m1's stored key.
    expect(() => ratchetDecrypt(bobRs, h1, new Uint8Array(c1.length))).toThrow();
    expect(dec(ratchetDecrypt(bobRs, h1, c1))).toBe('m1'); // late genuine arrival still decrypts
  });
});

describe('Double Ratchet — skipped-key retention bounds', () => {
  it('expires skipped keys past the TTL and reclaims the budget on the decrypt path', async () => {
    const { aliceRs, bobRs } = await establishedPair();

    ratchetEncrypt(aliceRs, enc('m1')); // never delivered
    ratchetEncrypt(aliceRs, enc('m2')); // never delivered
    const [h3, c3] = ratchetEncrypt(aliceRs, enc('m3'));
    expect(dec(ratchetDecrypt(bobRs, h3, c3))).toBe('m3');
    expect(bobRs.skipList.size).toBe(2);

    // Age the retained keys past the TTL; the next decrypt prunes them.
    for (const e of bobRs.skipList.values()) e.addedAt -= SKIPPED_KEY_TTL_MS + 60_000;
    const [h4, c4] = ratchetEncrypt(aliceRs, enc('m4'));
    expect(dec(ratchetDecrypt(bobRs, h4, c4))).toBe('m4');
    expect(bobRs.skipList.size).toBe(0);
  });

  it('pruneSkipList drops only expired entries', async () => {
    const { aliceRs, bobRs } = await establishedPair();

    ratchetEncrypt(aliceRs, enc('m1')); // never delivered
    const [h2, c2] = ratchetEncrypt(aliceRs, enc('m2'));
    expect(dec(ratchetDecrypt(bobRs, h2, c2))).toBe('m2');
    expect(bobRs.skipList.size).toBe(1);

    pruneSkipList(bobRs); // fresh — kept
    expect(bobRs.skipList.size).toBe(1);
    pruneSkipList(bobRs, Date.now() + SKIPPED_KEY_TTL_MS + 1); // aged out — dropped
    expect(bobRs.skipList.size).toBe(0);
  });

  it('a DH ratchet step purges skipped keys from chains older than the immediately-previous one', async () => {
    const { aliceRs, bobRs } = await establishedPair();

    // Chain 1: m1 skipped, m2 delivered → one retained key under alice's chain-1 pub.
    const [h1, c1] = ratchetEncrypt(aliceRs, enc('m1'));
    const [h2, c2] = ratchetEncrypt(aliceRs, enc('m2'));
    expect(dec(ratchetDecrypt(bobRs, h2, c2))).toBe('m2');
    expect(bobRs.skipList.size).toBe(1);

    // Residue from an ancient, long-abandoned chain (e.g. restored from old
    // persisted state): its ratchet pub is neither current nor previous.
    bobRs.skipList.set(`${'ab'.repeat(32)}:0`, { mk: new Uint8Array(32), addedAt: Date.now() });
    expect(bobRs.skipList.size).toBe(2);

    // Alice DH-steps (the JS impl only steps on receive, so emulate a stepping
    // remote sender); bob's receive-side step keeps ONLY the immediately-previous
    // chain's skipped keys.
    forceSenderDhStep(aliceRs, bobRs.rootKey, bobRs.sendRatchetPub);
    const [h3, c3] = ratchetEncrypt(aliceRs, enc('m3'));
    expect(dec(ratchetDecrypt(bobRs, h3, c3))).toBe('m3');
    expect(bobRs.skipList.size).toBe(1); // ancient-chain residue purged…
    expect(dec(ratchetDecrypt(bobRs, h1, c1))).toBe('m1'); // …chain-1 key still usable
  });
});
