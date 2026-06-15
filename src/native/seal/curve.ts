// Curve utility functions for X3DH: Ed25519↔X25519 key conversions.
// Matches Go oracle: pkg/v0_1/crypto/ed25519.go and pkg/v0_1/crypto/x25519.go.
import { ed25519, x25519 } from '@noble/curves/ed25519.js';
import { sha512 } from '@noble/hashes/sha2.js';

export { x25519, ed25519 };

/** Convert an Ed25519 seed (32 bytes) to an X25519 private scalar via
 *  clamp(SHA-512(seed)[0:32]). Matches Go Ed25519PrivateToX25519. */
export function ed25519SeedToX25519Scalar(seed: Uint8Array): Uint8Array {
  const h = sha512(seed);
  const out = h.slice(0, 32);
  out[0] &= 248;
  out[31] &= 127;
  out[31] |= 64;
  return out;
}

/** Convert an Ed25519 public key (compressed, 32 bytes) to an X25519 public key
 *  via the Bernstein-Hamburg birational map: u = (1+y)/(1-y) mod p.
 *  Matches Go Ed25519PublicToX25519. */
export function ed25519PubToX25519Pub(edPub: Uint8Array): Uint8Array {
  const P = (1n << 255n) - 19n;
  const bytes = new Uint8Array(edPub);
  bytes[31] &= 0x7f; // clear sign bit
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(bytes[i]);

  // modular inverse via Fermat: x^(p-2) mod p
  const n = y === 0n ? 0n : ((b: bigint, e: bigint, m: bigint) => {
    let r = 1n;
    b = ((b % m) + m) % m;
    while (e > 0n) { if (e & 1n) r = r * b % m; b = b * b % m; e >>= 1n; }
    return r;
  })(1n - y, P - 2n, P);

  const oneMinusY_inv = n;
  const u = ((1n + y) % P * oneMinusY_inv) % P;

  const out = new Uint8Array(32);
  let tmp = (u + P) % P;
  for (let i = 0; i < 32; i++) { out[i] = Number(tmp & 0xffn); tmp >>= 8n; }
  return out;
}

/** Generate a fresh X25519 keypair. Returns { priv, pub } each 32 bytes. */
export function generateX25519Keypair(): { priv: Uint8Array; pub: Uint8Array } {
  const priv = x25519.utils.randomSecretKey();
  const pub = x25519.getPublicKey(priv);
  return { priv, pub };
}
