// xorein identity: Ed25519 + ML-DSA-65 hybrid keypair with cross-certification.
// Wire formats are byte-compatible with the Go oracle:
//   pkg/v0_1/crypto/identity_cert.go
//   pkg/v0_1/nodeid/nodeid.go
import { ml_dsa65 } from '@noble/post-quantum/ml-dsa.js';
import { ed25519 } from '@noble/curves/ed25519.js';
import { peerIdFromPrivateKey } from '@libp2p/peer-id';
import { generateKeyPairFromSeed } from '@libp2p/crypto/keys';
import { hybridSign, hybridVerify, signingPublic } from '../crypto/hybrid.js';
import type { HybridSigningKey } from '../crypto/hybrid.js';

// ── Types ──────────────────────────────────────────────────────────────────

/** Full hybrid identity with all key material. Keep private; never serialize raw. */
export interface XoreinIdentity {
  /** 32-byte Ed25519 seed (private). */
  edSeed: Uint8Array;
  /** 32-byte Ed25519 public key. */
  edPub: Uint8Array;
  /** 64-byte Ed25519 private key = seed || pub (Go oracle format). */
  edPriv: Uint8Array;
  /** 4032-byte ML-DSA-65 private key. */
  mldsaPriv: Uint8Array;
  /** 1952-byte ML-DSA-65 public key. */
  mldsaPub: Uint8Array;
  /** libp2p PeerID string ("12D3KooW..."), derived from Ed25519 public key. */
  peerId: string;
}

/**
 * Cross-certification cert binding Ed25519 (libp2p PeerID) to ML-DSA-65.
 * JSON structure byte-compatible with Go IdentityCert.
 * Payload: "xorein/identity/v1/cross-cert\n" + canonical JSON of {peer_id, ed_public_key,
 * mldsa_public_key, issued_at}
 */
export interface IdentityCert {
  peer_id: string;
  ed_public_key: number[];    // 32-byte Ed25519 pub, as number[] for JSON compat
  mldsa_public_key: number[]; // 1952-byte ML-DSA-65 pub, as number[] for JSON compat
  issued_at: number;          // unix seconds
  ed_over_mldsa_sig: number[];  // hybrid sig signed by Ed25519 component over payload
  mldsa_over_ed_sig: number[];  // hybrid sig signed by ML-DSA-65 component over payload
}

// ── Constants ──────────────────────────────────────────────────────────────

const LABEL_IDENTITY_CERT = 'xorein/identity/v1/cross-cert';

// ── Identity generation ────────────────────────────────────────────────────

/** Generate a fresh xorein hybrid identity. */
export async function generateIdentity(): Promise<XoreinIdentity> {
  const edSeed = ed25519.utils.randomSecretKey();
  const edPub = ed25519.getPublicKey(edSeed);
  const edPriv = new Uint8Array(64);
  edPriv.set(edSeed, 0);
  edPriv.set(edPub, 32);

  const { secretKey: mldsaPriv, publicKey: mldsaPub } = ml_dsa65.keygen();

  // Derive libp2p PeerID from Ed25519 seed (compatible with Go node's PeerID).
  const libp2pKey = await generateKeyPairFromSeed('Ed25519', edSeed);
  const peerId = peerIdFromPrivateKey(libp2pKey).toString();

  return { edSeed, edPub, edPriv, mldsaPriv, mldsaPub, peerId };
}

/** Restore an XoreinIdentity from stored raw bytes (Go oracle's `stored` JSON format). */
export async function identityFromStored(edPriv64: Uint8Array, mldsaPriv: Uint8Array): Promise<XoreinIdentity> {
  if (edPriv64.length !== 64) throw new Error(`identity: ed25519 priv must be 64 bytes, got ${edPriv64.length}`);
  const edSeed = edPriv64.subarray(0, 32);
  const edPub = edPriv64.subarray(32, 64);
  const edPriv = new Uint8Array(edPriv64);

  const mldsaPub = ml_dsa65.getPublicKey(mldsaPriv);

  const libp2pKey = await generateKeyPairFromSeed('Ed25519', edSeed);
  const peerId = peerIdFromPrivateKey(libp2pKey).toString();

  return { edSeed, edPub, edPriv, mldsaPriv, mldsaPub, peerId };
}

/** The signing key pair for use with hybridSign / hybridVerify. */
export function identitySigningKey(id: XoreinIdentity): HybridSigningKey {
  return {
    edSecret: id.edSeed,
    edPublic: id.edPub,
    mldsaSecret: id.mldsaPriv,
    mldsaPublic: id.mldsaPub,
  };
}

// ── IdentityCert ───────────────────────────────────────────────────────────

function certPayload(peerId: string, edPub: Uint8Array, mldsaPub: Uint8Array, issuedAt: number): Uint8Array {
  const canonical = JSON.stringify({
    peer_id: peerId,
    ed_public_key: Array.from(edPub),
    mldsa_public_key: Array.from(mldsaPub),
    issued_at: issuedAt,
  });
  const prefix = LABEL_IDENTITY_CERT + '\n';
  const enc = new TextEncoder();
  const prefixBytes = enc.encode(prefix);
  const canonicalBytes = enc.encode(canonical);
  const out = new Uint8Array(prefixBytes.length + canonicalBytes.length);
  out.set(prefixBytes, 0);
  out.set(canonicalBytes, prefixBytes.length);
  return out;
}

/** Issue a cross-certification cert for the given identity (both keys sign the same payload). */
export function createIdentityCert(id: XoreinIdentity): IdentityCert {
  const issuedAt = Math.floor(Date.now() / 1000);
  const payload = certPayload(id.peerId, id.edPub, id.mldsaPub, issuedAt);
  const signingKey = identitySigningKey(id);

  // edOverMLDSASig: Ed25519 signature over the payload (via hybridSign's Ed25519 component)
  const hybridSig = hybridSign(payload, signingKey);
  // Extract the Ed25519 component from the hybrid sig blob: bytes [4..68)
  const edOverMLDSASig = Array.from(hybridSig.subarray(4, 4 + 64));
  // Extract the ML-DSA-65 component: bytes [72..3381)
  const mldsaOverEdSig = Array.from(hybridSig.subarray(72));

  return {
    peer_id: id.peerId,
    ed_public_key: Array.from(id.edPub),
    mldsa_public_key: Array.from(id.mldsaPub),
    issued_at: issuedAt,
    ed_over_mldsa_sig: edOverMLDSASig,
    mldsa_over_ed_sig: mldsaOverEdSig,
  };
}

/** Verify a cross-certification cert. Both component signatures must pass. */
export function verifyIdentityCert(cert: IdentityCert): boolean {
  try {
    if (!cert.peer_id || !cert.ed_public_key?.length || !cert.mldsa_public_key?.length) return false;
    if (!cert.ed_over_mldsa_sig?.length || !cert.mldsa_over_ed_sig?.length) return false;

    const edPub = new Uint8Array(cert.ed_public_key);
    const mldsaPub = new Uint8Array(cert.mldsa_public_key);
    const payload = certPayload(cert.peer_id, edPub, mldsaPub, cert.issued_at);

    // Reconstruct the full hybrid sig blob from the two components, then verify.
    const HYBRID_SIG_BYTES = 3381;
    const sigBlob = new Uint8Array(HYBRID_SIG_BYTES);
    const view = new DataView(sigBlob.buffer);
    view.setUint32(0, 64, false);
    sigBlob.set(cert.ed_over_mldsa_sig, 4);
    view.setUint32(68, 3309, false);
    sigBlob.set(cert.mldsa_over_ed_sig, 72);

    return hybridVerify(payload, sigBlob, signingPublic({
      edSecret: new Uint8Array(32),
      edPublic: edPub,
      mldsaSecret: new Uint8Array(4032),
      mldsaPublic: mldsaPub,
    }));
  } catch {
    return false;
  }
}
