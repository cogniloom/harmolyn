// xorein blob storage: client-side encrypted files/avatars via relay node.
// The relay stores opaque (encrypted) blobs — zero-knowledge per node role.
// Content-addressed: blob ID derived from SHA-256 of plaintext for dedup.
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm as aesGcm } from '@noble/ciphers/aes.js';
import { supportNodeOrigin } from '../nodeOrigin.js';
import { reportNodeRequestFailure, reportNodeRequestSuccess } from '../../lib/nodeHealth.js';
import type { XoreinAttachment } from '../../types.js';
import {
  decodeBase64Strict,
  encodeBase64Chunked,
  hasControlCharacters,
  isPlainObject,
  isSafeAttachment,
  MAX_ATTACHMENT_BYTES,
} from '../security/limits.js';

const BLOB_KEY_INFO = 'xorein/blob/v1/encryption-key';
const BLOB_NONCE_INFO = 'xorein/blob/v1/nonce';

/**
 * The blob support node ORIGIN (scheme+host, no /v1) the local deployment is configured to
 * use. Resolves the runtime-selected endpoint first, then VITE_XOREIN_CONTROL_ENDPOINT, so a
 * user's ciphertext never silently goes to the default Harmolyn node. Matches how the
 * rest of the control API resolves its endpoint (xoreinControl.ts, store.ts toRuntimeSnapshot).
 */
function configuredNodeOrigin(): string {
  return supportNodeOrigin();
}

/** The /v1 API base for a node origin. */
function apiBase(origin: string): string {
  return `${origin.replace(/\/+$/, '')}/v1`;
}

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
  /** Node origin (scheme+host) the ciphertext was uploaded to, so a recipient on a different
   *  configured node still fetches it from where it actually lives. */
  origin?: string;
}

// ── Binary ↔ base64 helpers (chunked to avoid call-stack overflows) ────────

function toBase64(bytes: Uint8Array): string {
  return encodeBase64Chunked(bytes);
}

function fromBase64(b64: string): Uint8Array {
  const bytes = decodeBase64Strict(b64, MAX_ATTACHMENT_BYTES + 16);
  if (!bytes) throw new Error('blob: invalid base64');
  return bytes;
}

function validOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === 'https:' || parsed.protocol === 'http:')
      && !parsed.username && !parsed.password
      && (parsed.pathname === '' || parsed.pathname === '/')
      && !parsed.search && !parsed.hash;
  } catch {
    return false;
  }
}

function validBlobRef(ref: BlobRef): boolean {
  return typeof ref.id === 'string' && ref.id.length > 0 && ref.id.length <= 256
    && !hasControlCharacters(ref.id)
    && typeof ref.filename === 'string' && ref.filename.length <= 512
    && typeof ref.contentType === 'string' && ref.contentType.length > 0 && ref.contentType.length <= 256
    && Number.isSafeInteger(ref.size) && ref.size >= 0 && ref.size <= MAX_ATTACHMENT_BYTES
    && ref.key instanceof Uint8Array && ref.key.length === 32
    && ref.nonce instanceof Uint8Array && ref.nonce.length === 12
    && /^[0-9a-f]{64}$/.test(ref.contentHash)
    && validOrigin(ref.origin);
}

// ── Encryption ─────────────────────────────────────────────────────────────

/** Encrypt plaintext bytes for opaque relay storage. Returns [ciphertext, key, nonce]. */
export function encryptBlob(plaintext: Uint8Array): { ciphertext: Uint8Array; key: Uint8Array; nonce: Uint8Array } {
  if (plaintext.length > MAX_ATTACHMENT_BYTES) throw new RangeError('blob: plaintext exceeds limit');
  const key = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const aead = aesGcm(key, nonce);
  const ciphertext = aead.encrypt(plaintext);
  return { ciphertext, key, nonce };
}

/** Decrypt a blob ciphertext with the given key and nonce. */
export function decryptBlob(ciphertext: Uint8Array, key: Uint8Array, nonce: Uint8Array): Uint8Array {
  if (ciphertext.length < 16 || ciphertext.length > MAX_ATTACHMENT_BYTES + 16 || key.length !== 32 || nonce.length !== 12) {
    throw new Error('blob: invalid ciphertext or key material');
  }
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
  if (data.length > MAX_ATTACHMENT_BYTES) throw new RangeError('blob upload: file exceeds limit');
  if (typeof filename !== 'string' || filename.length > 512 || typeof contentType !== 'string' || contentType.length > 256) {
    throw new Error('blob upload: invalid metadata');
  }
  const hash = contentHash(data);
  const { ciphertext, key, nonce } = encryptBlob(data);

  const ctData = 'data:application/octet-stream;base64,' + toBase64(ciphertext);

  const origin = configuredNodeOrigin();
  // ZERO-TRUST: the node stores an opaque blob — it must not learn the real
  // filename (metadata). Recipients get the true name inside the E2EE message
  // (XoreinAttachment.name); the node only ever sees "blob".
  let res: Response;
  try {
    res = await fetch(`${apiBase(origin)}/uploads`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename: 'blob', content_type: 'application/octet-stream', data: ctData }),
    });
  } catch (error) {
    reportNodeRequestFailure(error);
    throw error;
  }
  reportNodeRequestSuccess();
  if (!res.ok) throw new Error(`blob upload: ${res.status}`);
  const json = await res.json() as unknown;
  if (!isPlainObject(json) || typeof json.id !== 'string' || json.id.length === 0 || json.id.length > 256) {
    throw new Error('blob upload: invalid response');
  }

  const ref: BlobRef = { id: json.id, contentHash: hash, key, nonce, filename, contentType, size: data.length, origin };
  if (!validBlobRef(ref)) throw new Error('blob upload: invalid reference');
  return ref;
}

/**
 * Download and decrypt a blob from the relay node.
 * Requires the BlobRef (containing the key) from the original upload.
 */
export async function downloadBlob(ref: BlobRef): Promise<Uint8Array> {
  if (!validBlobRef(ref)) throw new Error('blob download: invalid reference');
  // Fetch from the node the blob was uploaded to (carried on the ref), falling back to the
  // locally-configured node for older refs without an origin.
  const base = apiBase(ref.origin || configuredNodeOrigin());
  const isConfiguredNode = !ref.origin || ref.origin === configuredNodeOrigin();
  let res: Response;
  try {
    res = await fetch(`${base}/uploads/${encodeURIComponent(ref.id)}`);
  } catch (error) {
    // Only downloads from OUR configured node say anything about its health;
    // a ref pinned to some other peer's node must not flip our state.
    if (isConfiguredNode) reportNodeRequestFailure(error);
    throw error;
  }
  if (isConfiguredNode) reportNodeRequestSuccess();
  if (!res.ok) throw new Error(`blob download: ${res.status}`);
  const json = await res.json() as unknown;
  if (!isPlainObject(json) || typeof json.data !== 'string') throw new Error('blob download: invalid response');

  let b64 = json.data;
  if (b64.startsWith('data:')) {
    const comma = b64.indexOf(',');
    if (comma < 0) throw new Error('blob download: invalid data URI');
    b64 = b64.slice(comma + 1);
  }
  const ciphertext = fromBase64(b64);
  const data = decryptBlob(ciphertext, ref.key, ref.nonce);
  if (data.length !== ref.size || contentHash(data) !== ref.contentHash) throw new Error('blob download: integrity check failed');
  return data;
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
  const bytes = decodeBase64Strict(s, 32, true);
  if (!bytes) throw new Error('attachment: invalid key material');
  return bytes;
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
    origin: ref.origin,
  };
}

function attachmentToBlobRef(att: XoreinAttachment): BlobRef {
  if (!isSafeAttachment(att)) throw new Error('attachment: invalid reference');
  return {
    id: att.id,
    contentHash: att.content_hash ?? '',
    key: attUnb64url(att.key),
    nonce: (() => {
      const bytes = decodeBase64Strict(att.nonce, 12, true);
      if (!bytes) throw new Error('attachment: invalid nonce');
      return bytes;
    })(),
    filename: att.name,
    contentType: att.content_type,
    size: att.size,
    origin: att.origin,
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
