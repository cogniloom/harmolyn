// Safety numbers for out-of-band identity verification (Tier-0 A7).
//
// A safety number lets two users confirm, over a trusted channel (in person, a
// phone call), that no relay has swapped identities between them — the same role
// the "verify safety number" screen plays in Signal. It is computed from BOTH
// peers' HYBRID public identity (Ed25519 ‖ ML-DSA-65), so it commits to the
// post-quantum half of the identity too, not just the classical key.
//
// Properties:
//   • deterministic — same inputs always yield the same number;
//   • symmetric    — A and B compute the SAME number (per-party fingerprints are
//     sorted before concatenation);
//   • collision-resistant via iterated SHA-512 (a compromised key can't be ground
//     into a matching short number).
import { sha512 } from '@noble/hashes/sha2.js';

const ITERATIONS = 5200; // matches the Signal fingerprint hardening iteration count
const VERSION = 0;

/** A peer's hybrid identity public material. */
export interface HybridIdentityKey {
  ed25519: Uint8Array;   // 32 B
  mldsa65: Uint8Array;   // 1952 B (may be empty when not yet known — Ed25519-only fp)
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

function keyBytes(k: HybridIdentityKey): Uint8Array {
  return k.mldsa65.length ? concat([k.ed25519, k.mldsa65]) : k.ed25519;
}

/** Iterated-hash fingerprint of one party's identity, bound to a stable identifier. */
function fingerprint(key: HybridIdentityKey, identifier: string): Uint8Array {
  const kb = keyBytes(key);
  const id = new TextEncoder().encode(identifier);
  let hash = sha512(concat([new Uint8Array([VERSION, VERSION]), kb, id]));
  for (let i = 0; i < ITERATIONS; i++) hash = sha512(concat([hash, kb]));
  return hash.slice(0, 30); // 30 bytes → six 5-digit groups
}

/** Encode a 30-byte fingerprint as 30 decimal digits (six 40-bit groups mod 1e5). */
function encodeDigits(fp: Uint8Array): string {
  let out = '';
  for (let i = 0; i < 30; i += 5) {
    let v = 0n;
    for (let j = 0; j < 5; j++) v = (v << 8n) | BigInt(fp[i + j]);
    out += (v % 100000n).toString().padStart(5, '0');
  }
  return out;
}

/**
 * The 60-digit safety number for a conversation between `local` and `remote`.
 * Symmetric: sorting the two per-party fingerprints means both sides derive the
 * same string regardless of who is "local".
 */
export function computeSafetyNumber(
  local: HybridIdentityKey, localId: string,
  remote: HybridIdentityKey, remoteId: string,
): string {
  const a = encodeDigits(fingerprint(local, localId));
  const b = encodeDigits(fingerprint(remote, remoteId));
  return a < b ? a + b : b + a;
}

/** Group the 60-digit safety number into 5-digit blocks for display. */
export function formatSafetyNumber(digits: string): string {
  return (digits.match(/.{1,5}/g) ?? []).join(' ');
}

/** Parse a base64 identity-key blob (b64(ed ‖ mldsa)) into its hybrid halves. */
export function parseIdentityKeyBlob(b64: string): HybridIdentityKey | null {
  try {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    if (bytes.length < 32) return null;
    return { ed25519: bytes.slice(0, 32), mldsa65: bytes.slice(32) };
  } catch {
    return null;
  }
}

/** Build the base64 identity-key blob (b64(ed ‖ mldsa)) for storage/transport. */
export function identityKeyBlob(ed25519: Uint8Array, mldsa65: Uint8Array): string {
  const bytes = concat([ed25519, mldsa65]);
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
