// Seal mode prekey bundle: generation, signing, verification, and X3DH key agreement.
// Byte-compatible with Go oracle: pkg/v0_1/mode/seal/x3dh.go.
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { x25519 } from '@noble/curves/ed25519.js';
import { hybridSign, hybridVerify, signingPublic } from '../crypto/hybrid.js';
import type { HybridSigningKey } from '../crypto/hybrid.js';
import { ed25519SeedToX25519Scalar, ed25519PubToX25519Pub, generateX25519Keypair } from './curve.js';
import { deriveKey } from './kdf.js';
import type { RatchetState } from './ratchet.js';
import { initRatchetFromMaster } from './ratchet.js';

// Label constants matching Go oracle (pkg/v0_1/crypto/labels.go).
const LABEL_SEAL_HYBRID_MASTER = 'xorein/seal/v1/hybrid-master';
const LABEL_SEAL_SPK_SIGN      = 'xorein/seal/v1/spk-sign';
const LABEL_SEAL_MLKEM_PK_SIGN = 'xorein/seal/v1/mlkem-pk-sign';
const LABEL_BUNDLE_SIGN_PREFIX = 'xorein/seal/v1/bundle-sign\x00';

// ── Types ──────────────────────────────────────────────────────────────────

/** Prekey bundle published per spec 11 §1.1. JSON fields match Go oracle wire format. */
export interface PrekeyBundle {
  peer_id: string;
  identity_key_ed25519: number[];      // 32 B Ed25519 pub
  identity_key_ml_dsa_65: number[];    // 1952 B ML-DSA-65 pub
  signed_prekey_x25519: number[];      // 32 B X25519 SPK pub
  signed_prekey_signature: number[];   // 3381 B hybrid sig
  one_time_prekeys_x25519: number[][]; // each 32 B
  ml_kem_768_pk: number[];             // 1184 B ML-KEM-768 pub
  ml_kem_768_pk_signature: number[];   // 3381 B hybrid sig
  published_at: number;
  expires_at: number;
  bundle_signature: number[];          // 3381 B hybrid sig
}

/** Private key material corresponding to a PrekeyBundle. */
export interface PrekeyPrivate {
  spkPriv: Uint8Array;      // 32 B X25519 SPK private key
  opkPrivs: Uint8Array[];   // each 32 B X25519 OPK private keys
  mlkemSk: Uint8Array;      // ML-KEM-768 decapsulation key
}

/** Data the initiator sends with the first X3DH message. */
export interface InitialMessage {
  ekPub: Uint8Array;   // 32 B ephemeral X25519 pub
  ctMlkem: Uint8Array; // ML-KEM-768 ciphertext (1088 B)
  opkIndex: number;    // -1 if no OPK
  opkPub?: Uint8Array; // 32 B pub of the OPK used — lets the responder bind/validate it
}

// ── Bundle generation ──────────────────────────────────────────────────────

function numArray(b: Uint8Array): number[] { return Array.from(b); }

/** Generate a fresh prekey bundle + private key material. */
export function buildBundle(
  peerId: string,
  signingKey: HybridSigningKey,
  opkCount = 20,
): { bundle: PrekeyBundle; priv: PrekeyPrivate } {
  opkCount = Math.max(1, Math.min(100, opkCount));
  const now = Math.floor(Date.now() / 1000);

  // SPK (signed prekey X25519).
  const { priv: spkPriv, pub: spkPub } = generateX25519Keypair();
  const spkCanonical = new Uint8Array(LABEL_SEAL_SPK_SIGN.length + 32);
  spkCanonical.set(new TextEncoder().encode(LABEL_SEAL_SPK_SIGN), 0);
  spkCanonical.set(spkPub, LABEL_SEAL_SPK_SIGN.length);
  const spkSig = hybridSign(spkCanonical, signingKey);

  // OPKs.
  const opkPubs: Uint8Array[] = [];
  const opkPrivs: Uint8Array[] = [];
  for (let i = 0; i < opkCount; i++) {
    const { priv, pub } = generateX25519Keypair();
    opkPrivs.push(priv);
    opkPubs.push(pub);
  }

  // ML-KEM-768 keypair.
  const { publicKey: mlkemPk, secretKey: mlkemSk } = ml_kem768.keygen();
  const mlkemCanonical = new Uint8Array(LABEL_SEAL_MLKEM_PK_SIGN.length + mlkemPk.length);
  mlkemCanonical.set(new TextEncoder().encode(LABEL_SEAL_MLKEM_PK_SIGN), 0);
  mlkemCanonical.set(mlkemPk, LABEL_SEAL_MLKEM_PK_SIGN.length);
  const mlkemSig = hybridSign(mlkemCanonical, signingKey);

  // Build partial bundle (without bundle_signature).
  const partial: Omit<PrekeyBundle, 'bundle_signature'> = {
    peer_id: peerId,
    identity_key_ed25519: numArray(signingKey.edPublic),
    identity_key_ml_dsa_65: numArray(signingKey.mldsaPublic),
    signed_prekey_x25519: numArray(spkPub),
    signed_prekey_signature: numArray(spkSig),
    one_time_prekeys_x25519: opkPubs.map(numArray),
    ml_kem_768_pk: numArray(mlkemPk),
    ml_kem_768_pk_signature: numArray(mlkemSig),
    published_at: now,
    expires_at: now + 7 * 24 * 3600, // 7 days
  };

  // Bundle signature over canonical bytes (matches Go canonicalBundleBytes).
  const canonPayload = new TextEncoder().encode(LABEL_BUNDLE_SIGN_PREFIX + JSON.stringify(partial));
  const bundleSig = hybridSign(canonPayload, signingKey);

  const bundle: PrekeyBundle = { ...partial, bundle_signature: numArray(bundleSig) };
  return { bundle, priv: { spkPriv, opkPrivs, mlkemSk } };
}

/**
 * Recompute a bundle's `bundle_signature` in place after its OPK set changes (e.g.
 * a consumed one-time prekey is zeroed). Keeps the bundle self-verifiable so peers
 * that fetch it after a consumption still pass verifyBundle.
 */
export function resignBundle(bundle: PrekeyBundle, signingKey: HybridSigningKey): void {
  const { bundle_signature: _omit, ...partial } = bundle;
  const canonPayload = new TextEncoder().encode(LABEL_BUNDLE_SIGN_PREFIX + JSON.stringify(partial));
  bundle.bundle_signature = numArray(hybridSign(canonPayload, signingKey));
}

// ── Bundle verification ────────────────────────────────────────────────────

/** Verify all signatures in a prekey bundle. Returns true if valid. */
export function verifyBundle(bundle: PrekeyBundle): boolean {
  try {
    const pub = signingPublic({
      edSecret: new Uint8Array(32),
      edPublic: new Uint8Array(bundle.identity_key_ed25519),
      mldsaSecret: new Uint8Array(4032),
      mldsaPublic: new Uint8Array(bundle.identity_key_ml_dsa_65),
    });

    // Verify SPK signature.
    const spkPub = new Uint8Array(bundle.signed_prekey_x25519);
    const spkCanonical = new Uint8Array(LABEL_SEAL_SPK_SIGN.length + 32);
    spkCanonical.set(new TextEncoder().encode(LABEL_SEAL_SPK_SIGN), 0);
    spkCanonical.set(spkPub, LABEL_SEAL_SPK_SIGN.length);
    if (!hybridVerify(spkCanonical, new Uint8Array(bundle.signed_prekey_signature), pub)) return false;

    // Verify ML-KEM PK signature.
    const mlkemPk = new Uint8Array(bundle.ml_kem_768_pk);
    const mlkemCanonical = new Uint8Array(LABEL_SEAL_MLKEM_PK_SIGN.length + mlkemPk.length);
    mlkemCanonical.set(new TextEncoder().encode(LABEL_SEAL_MLKEM_PK_SIGN), 0);
    mlkemCanonical.set(mlkemPk, LABEL_SEAL_MLKEM_PK_SIGN.length);
    if (!hybridVerify(mlkemCanonical, new Uint8Array(bundle.ml_kem_768_pk_signature), pub)) return false;

    // Verify bundle signature.
    const { bundle_signature: _, ...partial } = bundle;
    const canonPayload = new TextEncoder().encode(LABEL_BUNDLE_SIGN_PREFIX + JSON.stringify(partial));
    return hybridVerify(canonPayload, new Uint8Array(bundle.bundle_signature), pub);
  } catch {
    return false;
  }
}

// ── X3DH key agreement ─────────────────────────────────────────────────────

/** X3DH initiator side. Returns InitialMessage + initial RatchetState. */
export function x3dhInitiate(
  myEdSeed: Uint8Array,
  bundle: PrekeyBundle,
): { im: InitialMessage; rs: RatchetState } {
  // Our identity key as X25519.
  const ikPriv = ed25519SeedToX25519Scalar(myEdSeed);

  // Responder's identity as X25519.
  const theirIKPub = ed25519PubToX25519Pub(new Uint8Array(bundle.identity_key_ed25519));

  // Responder's signed prekey.
  const spkPub = new Uint8Array(32); spkPub.set(bundle.signed_prekey_x25519);

  // Ephemeral keypair.
  const { priv: ekPriv, pub: ekPub } = generateX25519Keypair();

  // DH1: ik × spk | DH2: ek × ik_r | DH3: ek × spk
  const dh1 = x25519.getSharedSecret(ikPriv, spkPub);
  const dh2 = x25519.getSharedSecret(ekPriv, theirIKPub);
  const dh3 = x25519.getSharedSecret(ekPriv, spkPub);

  let x3dhSecret = new Uint8Array([...dh1, ...dh2, ...dh3]);
  let opkIndex = -1;
  let opkPubUsed: Uint8Array | undefined;

  // DH4 (OPK) if available. Pick a RANDOM unconsumed one-time prekey (a consumed
  // slot is published as 32 zero bytes) rather than always index 0 — this spreads
  // usage across the pool so no single OPK backs many sessions, and reduces the
  // chance two concurrent initiators pick the same slot.
  const available: number[] = [];
  for (let i = 0; i < bundle.one_time_prekeys_x25519.length; i++) {
    if (bundle.one_time_prekeys_x25519[i].some(b => b !== 0)) available.push(i);
  }
  if (available.length > 0) {
    const pick = available[Math.floor(Math.random() * available.length)];
    const opkPub = new Uint8Array(bundle.one_time_prekeys_x25519[pick]);
    const dh4 = x25519.getSharedSecret(ekPriv, opkPub);
    x3dhSecret = new Uint8Array([...x3dhSecret, ...dh4]);
    opkIndex = pick;
    opkPubUsed = opkPub;
  }

  // ML-KEM encapsulation.
  const { cipherText: ctMlkem, sharedSecret: ssMlkem } = ml_kem768.encapsulate(
    new Uint8Array(bundle.ml_kem_768_pk),
  );

  // Hybrid combine: HKDF(x3dhSecret || ssMlkem, label).
  const hybridMaster = combineKem(x3dhSecret, ssMlkem);

  const rs = initRatchetFromMaster(hybridMaster, ekPriv, ekPub, spkPub, true);
  return { im: { ekPub, ctMlkem, opkIndex, ...(opkPubUsed ? { opkPub: opkPubUsed } : {}) }, rs };
}

/** X3DH responder side. Returns the initial RatchetState. */
export function x3dhRespond(
  im: InitialMessage,
  priv: PrekeyPrivate,
  bundle: PrekeyBundle,
  ourEdSeed: Uint8Array,
  theirEdPub: Uint8Array,
): RatchetState {
  const ourIKPriv = ed25519SeedToX25519Scalar(ourEdSeed);
  const theirIKPub = ed25519PubToX25519Pub(theirEdPub);
  const spkPub = new Uint8Array(32); spkPub.set(bundle.signed_prekey_x25519);

  // DH1: spk × their_ik | DH2: our_ik × their_ek | DH3: spk × their_ek
  const dh1 = x25519.getSharedSecret(priv.spkPriv, theirIKPub);
  const dh2 = x25519.getSharedSecret(ourIKPriv, im.ekPub);
  const dh3 = x25519.getSharedSecret(priv.spkPriv, im.ekPub);

  let x3dhSecret = new Uint8Array([...dh1, ...dh2, ...dh3]);

  if (im.opkIndex >= 0 && im.opkIndex < priv.opkPrivs.length) {
    const dh4 = x25519.getSharedSecret(priv.opkPrivs[im.opkIndex], im.ekPub);
    x3dhSecret = new Uint8Array([...x3dhSecret, ...dh4]);
  }

  const ssMlkem = ml_kem768.decapsulate(im.ctMlkem, priv.mlkemSk);
  const hybridMaster = combineKem(x3dhSecret, ssMlkem);

  return initRatchetFromMaster(hybridMaster, priv.spkPriv, spkPub, im.ekPub, false);
}

function combineKem(x3dhSecret: Uint8Array, ssMlkem: Uint8Array): Uint8Array {
  const ikm = new Uint8Array([...x3dhSecret, ...ssMlkem]);
  return deriveKey(ikm, null, LABEL_SEAL_HYBRID_MASTER, 32);
}
