// KDF helpers matching the Go oracle (pkg/crypto/kdf.go, pkg/v0_1/crypto/kdf.go).
// DeriveKey(secret, salt, label, length) = HKDF-SHA256(IKM=secret, salt=salt, info=label, L=length).
import { sha256 } from '@noble/hashes/sha2.js';
import { hkdf } from '@noble/hashes/hkdf.js';

export function deriveKey(secret: Uint8Array, salt: Uint8Array | null, label: string, length: number): Uint8Array {
  return hkdf(sha256, secret, salt ?? new Uint8Array(0), new TextEncoder().encode(label), length);
}

export function deriveKey32(secret: Uint8Array, salt: Uint8Array | null, label: string): Uint8Array {
  return deriveKey(secret, salt, label, 32);
}
