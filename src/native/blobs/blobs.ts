// xorein blob storage: client-side encrypted files/avatars via relay node.
// The relay stores opaque (encrypted) blobs — zero-knowledge per node role.
// Content-addressed: blob ID derived from SHA-256 of plaintext for dedup.
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm as aesGcm } from '@noble/ciphers/aes.js';
import type { XoreinAttachment } from '../../types.js';

const CONTROL_BASE = 'https://node.xorein.com/v1';
const BLOB_KEY_INFO = 'xorein/blob/v1/encryption-key';
const BLOB_NONCE_INFO = 'xorein/blob/v1/nonce';

// ── Types ──────────────────────────────────────────────────────────────────

export interface BlobRef {
  /** Upload ID returned by the relay (opaque on the relay side). */
  id: string;
  /** SHA-256 hex digest of the original plaintext (content address). */
  contentHash: string;
  /** AES-256-GCM encryption key (32 B), never sent to the relay. */
  key: Uint8Array;
  /** Nonce used for encryption (12 B). */
  nonce: Uint8Array;
  filename: string;
  contentType: string;
  size: number;
}

// ── Binary ↔ base64 helpers (chunked to avoid call-stack overflows) ────────

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function fromBase64(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ── Encryption ─────────────────────────────────────────────────────────────

/** Encrypt plaintext bytes for opaque relay storage. Returns [ciphertext, key, nonce]. */
export function encryptBlob(plaintext: Uint8Array): { ciphertext: Uint8Array; key: Uint8Array; nonce: Uint8Array } {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aead = aesGcm(key, nonce);
  const ciphertext = aead.encrypt(plaintext);
  return { ciphertext, key, nonce };
}

/** Decrypt a blob ciphertext with the given key and nonce. */
export function decryptBlob(ciphertext: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
  const aead = aesGcm(key, nonce);
  return aead.decrypt(ciphertext);
}

/** Content address: SHA-256 hex digest of the plaintext. */
export function contentHash(plaintext: Uint8Array): string {
  return Array.from(sha256(plaintext)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// ── Upload / Download ──────────────────────────────────────────────────────

/**
 * Encrypt and upload a blob to the relay node.
 * The relay stores only ciphertext — it never sees the plaintext or key.
 * Returns a BlobRef with the upload ID + key material for sharing.
 */
export async function uploadBlob(
  data: Uint8Array,
  filename: string,
  contentType = 'application/octet-stream',
): Promise<BlobRef> {
  const hash = contentHash(data);
  const { ciphertext, key, nonce } = encryptBlob(data);

  const ctData = 'data:application/octet-stream;base64,' + toBase64(ciphertext);

  const res = await fetch(`${CONTROL_BASE}/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename, content_type: 'application/octet-stream', data: ctData }),
  });
  if (!res.ok) throw new Error(`blob upload: ${res.status}`);
  const json = await res.json() as { id: string };

  return { id: json.id, contentHash: hash, key, nonce, filename, contentType, size: data.length };
}

/**
 * Download and decrypt a blob from the relay node.
 * Requires the BlobRef (containing the key) from the original upload.
 */
export async function downloadBlob(ref: BlobRef): Promise<Uint8Array> {
  const res = await fetch(`${CONTROL_BASE}/uploads/${encodeURIComponent(ref.id)}`);
  if (!res.ok) throw new Error(`blob download: ${res.status}`);
  const json = await res.json() as { data: string };

  let b64 = json.data;
  if (b64.startsWith('data:')) b64 = b64.split(',')[1];
  const ciphertext = fromBase64(b64);
  return decryptBlob(ciphertext, ref.key, ref.nonce);
}

/**
 * Verify blob integrity: compare SHA-256 of decrypted content against stored hash.
 */
export function verifyBlobIntegrity(data: Uint8Array, ref: BlobRef): boolean {
  return contentHash(data) === ref.contentHash;
}

// ── Attachment refs (the shareable, message-embedded form of a BlobRef) ───────

function attB64url(b: Uint8Array): string {
  return toBase64(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function attUnb64url(s: string): Uint8Array {
  const b = s.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b + '='.repeat((4 - (b.length % 4)) % 4);
  return fromBase64(padded);
}

/** Convert a freshly-uploaded BlobRef into the message-embeddable attachment ref. */
export function blobRefToAttachment(ref: BlobRef): XoreinAttachment {
  return {
    id: ref.id,
    name: ref.filename,
    content_type: ref.contentType,
    size: ref.size,
    key: attB64url(ref.key),
    nonce: attB64url(ref.nonce),
    content_hash: ref.contentHash,
  };
}

function attachmentToBlobRef(att: XoreinAttachment): BlobRef {
  return {
    id: att.id,
    contentHash: att.content_hash ?? '',
    key: attUnb64url(att.key),
    nonce: attUnb64url(att.nonce),
    filename: att.name,
    contentType: att.content_type,
    size: att.size,
  };
}

/** Encrypt + upload a file, returning the message-embeddable encrypted attachment ref. */
export async function uploadEncryptedAttachment(
  data: Uint8Array,
  filename: string,
  contentType?: string,
): Promise<XoreinAttachment> {
  return blobRefToAttachment(await uploadBlob(data, filename, contentType));
}

/** Download + decrypt an attachment by its ref; verifies integrity when a hash is present. */
export async function downloadDecryptedAttachment(att: XoreinAttachment): Promise<Uint8Array> {
  const data = await downloadBlob(attachmentToBlobRef(att));
  if (att.content_hash && contentHash(data) !== att.content_hash) {
    throw new Error('attachment integrity check failed');
  }
  return data;
}
