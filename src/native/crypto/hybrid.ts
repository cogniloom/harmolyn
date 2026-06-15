// Pure-TypeScript hybrid post-quantum crypto for the native xorein engine.
//
// xorein ciphersuite 0xFF01:
//   - signatures: Ed25519 + ML-DSA-65 (hybrid; both must verify)
//   - KEM:        X25519 + ML-KEM-768 (hybrid; shared secret derived from both)
//
// Wire format conforms byte-for-byte with the Go oracle
// (/home/hal9000/docker/xorein/pkg/v0_1/crypto/hybrid.go).
// No WASM — @noble/* is pure JS.
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ml_kem768 } from '@noble/post-quantum/ml-kem.js';
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

// ── Signature constants ────────────────────────────────────────────────────

export const ED25519_SIG_LEN = 64;
export const ML_DSA65_SIG_LEN = 3309;

// Total hybrid signature blob size: 4+64+4+3309 = 3381 (spec 01 §6).
export const HYBRID_SIG_BYTES = 3381;

// Domain-separation labels prepended before signing (spec 01 §6).
// Must match Go oracle's LabelHybridSigEd25519 / LabelHybridSigMLDSA65.
const LABEL_ED25519 = 'xorein/sig/v1/ed25519';
const LABEL_MLDSA65 = 'xorein/sig/v1/ml-dsa-65';

const enc = new TextEncoder();
const LABEL_ED25519_BYTES = enc.encode(LABEL_ED25519);
const LABEL_MLDSA65_BYTES = enc.encode(LABEL_MLDSA65);

function domainSepEd(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(LABEL_ED25519_BYTES.length + payload.length);
  out.set(LABEL_ED25519_BYTES, 0);
  out.set(payload, LABEL_ED25519_BYTES.length);
  return out;
}

function domainSepMLDSA(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(LABEL_MLDSA65_BYTES.length + payload.length);
  out.set(LABEL_MLDSA65_BYTES, 0);
  out.set(payload, LABEL_MLDSA65_BYTES.length);
  return out;
}

function uint32BE(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n, false);
  return b;
}

function readUint32BE(b: Uint8Array, offset: number): number {
  return new DataView(b.buffer, b.byteOffset + offset, 4).getUint32(0, false);
}

// ── Signing key types ──────────────────────────────────────────────────────

export interface HybridSigningKey {
  edSecret: Uint8Array;    // 32-byte Ed25519 seed
  edPublic: Uint8Array;    // 32-byte Ed25519 public key
  mldsaSecret: Uint8Array; // 4032-byte ML-DSA-65 private key
  mldsaPublic: Uint8Array; // 1952-byte ML-DSA-65 public key
}

export interface HybridSigningPublic {
  edPublic: Uint8Array;
  mldsaPublic: Uint8Array;
}

/** Generate a hybrid signing identity (Ed25519 + ML-DSA-65). */
export function generateSigningIdentity(): HybridSigningKey {
  const edSecret = ed25519.utils.randomSecretKey();
  const edPublic = ed25519.getPublicKey(edSecret);
  const { publicKey: mldsaPublic, secretKey: mldsaSecret } = ml_dsa65.keygen();
  return { edSecret, edPublic, mldsaSecret, mldsaPublic };
}

export function signingPublic(key: HybridSigningKey): HybridSigningPublic {
  return { edPublic: key.edPublic, mldsaPublic: key.mldsaPublic };
}

/**
 * Hybrid-sign a message. Wire format (spec 01 §6, byte-compatible with Go oracle):
 *   len32BE(edSig) || edSig(64) || len32BE(mldsaSig) || mldsaSig(3309) = 3381 bytes
 *
 * Each component uses per-component domain separation:
 *   Ed25519 signs:  "xorein/sig/v1/ed25519"  || message
 *   ML-DSA-65 signs: "xorein/sig/v1/ml-dsa-65" || message
 */
export function hybridSign(message: Uint8Array, key: HybridSigningKey): Uint8Array {
  const edSig = ed25519.sign(domainSepEd(message), key.edSecret);
  const mldsaSig = ml_dsa65.sign(domainSepMLDSA(message), key.mldsaSecret);

  const out = new Uint8Array(HYBRID_SIG_BYTES);
  let off = 0;
  out.set(uint32BE(ED25519_SIG_LEN), off); off += 4;
  out.set(edSig, off); off += ED25519_SIG_LEN;
  out.set(uint32BE(ML_DSA65_SIG_LEN), off); off += 4;
  out.set(mldsaSig, off);
  return out;
}

/** Verify a hybrid signature; both components must pass. */
export function hybridVerify(message: Uint8Array, sig: Uint8Array, pub: HybridSigningPublic): boolean {
  if (sig.length !== HYBRID_SIG_BYTES) return false;
  try {
    let off = 0;
    const edLen = readUint32BE(sig, off); off += 4;
    if (edLen !== ED25519_SIG_LEN) return false;
    const edSig = sig.subarray(off, off + ED25519_SIG_LEN); off += ED25519_SIG_LEN;
    const mldsaLen = readUint32BE(sig, off); off += 4;
    if (mldsaLen !== ML_DSA65_SIG_LEN) return false;
    const mldsaSig = sig.subarray(off, off + ML_DSA65_SIG_LEN);

    if (!ed25519.verify(edSig, domainSepEd(message), pub.edPublic)) return false;
    return ml_dsa65.verify(mldsaSig, domainSepMLDSA(message), pub.mldsaPublic);
  } catch {
    return false;
  }
}

// ── KEM key types ──────────────────────────────────────────────────────────

export interface HybridKemKey {
  x25519Secret: Uint8Array;
  x25519Public: Uint8Array;
  mlkemSecret: Uint8Array;
  mlkemPublic: Uint8Array;
}

export interface HybridKemPublic {
  x25519Public: Uint8Array;
  mlkemPublic: Uint8Array;
}

/** Generate a hybrid KEM keypair (X25519 + ML-KEM-768). */
export function generateKemIdentity(): HybridKemKey {
  const x25519Secret = x25519.utils.randomSecretKey();
  const x25519Public = x25519.getPublicKey(x25519Secret);
  const { publicKey: mlkemPublic, secretKey: mlkemSecret } = ml_kem768.keygen();
  return { x25519Secret, x25519Public, mlkemSecret, mlkemPublic };
}

export function kemPublic(key: HybridKemKey): HybridKemPublic {
  return { x25519Public: key.x25519Public, mlkemPublic: key.mlkemPublic };
}

const KEM_KDF_INFO = new TextEncoder().encode('xorein/0xFF01/hybrid-kem');

/**
 * Hybrid KEM encapsulation. Ciphertext: ephX25519Pub(32) || mlKemCt.
 * Shared secret: HKDF-SHA256(ecdh || mlkemSs, info="xorein/0xFF01/hybrid-kem") = 32 bytes.
 */
export function kemEncapsulate(pub: HybridKemPublic): { ciphertext: Uint8Array; sharedSecret: Uint8Array } {
  const ephSecret = x25519.utils.randomSecretKey();
  const ephPublic = x25519.getPublicKey(ephSecret);
  const ecdh = x25519.getSharedSecret(ephSecret, pub.x25519Public);
  const { cipherText: mlkemCt, sharedSecret: mlkemSs } = ml_kem768.encapsulate(pub.mlkemPublic);

  const ciphertext = new Uint8Array(ephPublic.length + mlkemCt.length);
  ciphertext.set(ephPublic, 0);
  ciphertext.set(mlkemCt, ephPublic.length);

  return { ciphertext, sharedSecret: combineKem(ecdh, mlkemSs) };
}

/** Hybrid KEM decapsulation — recomputes the 32-byte shared secret. */
export function kemDecapsulate(ciphertext: Uint8Array, key: HybridKemKey): Uint8Array {
  const ephPublic = ciphertext.subarray(0, 32);
  const mlkemCt = ciphertext.subarray(32);
  const ecdh = x25519.getSharedSecret(key.x25519Secret, ephPublic);
  const mlkemSs = ml_kem768.decapsulate(mlkemCt, key.mlkemSecret);
  return combineKem(ecdh, mlkemSs);
}

function combineKem(ecdh: Uint8Array, mlkemSs: Uint8Array): Uint8Array {
  const ikm = new Uint8Array(ecdh.length + mlkemSs.length);
  ikm.set(ecdh, 0);
  ikm.set(mlkemSs, ecdh.length);
  return hkdf(sha256, ikm, new Uint8Array(0), KEM_KDF_INFO, 32);
}
