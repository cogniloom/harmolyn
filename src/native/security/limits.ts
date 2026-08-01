import type { XoreinAttachment } from '../../types.js';
import { isTrustedHttpOrigin } from '../../lib/trustedOrigin.js';

// These limits are deliberately conservative. They bound work and storage at
// every trust boundary while leaving enough room for normal text, attachment
// references, and encrypted account metadata.
export const MAX_CHAT_BODY_BYTES = 64 * 1024;
export const MAX_ENCRYPTED_MESSAGE_BYTES = 256 * 1024;
export const MAX_ATTACHMENTS = 16;
export const MAX_ATTACHMENT_BYTES = 64 * 1024 * 1024;
export const MAX_ATTACHMENT_ID_BYTES = 256;
export const MAX_ATTACHMENT_NAME_BYTES = 512;
export const MAX_ATTACHMENT_TYPE_BYTES = 256;
export const MAX_ATTACHMENT_KEY_BYTES = 128;
export const MAX_ATTACHMENT_ORIGIN_BYTES = 512;
export const BLOB_SWARM_MIN_CHUNK_BYTES = 64 * 1024;
export const BLOB_SWARM_MAX_CHUNK_BYTES = 256 * 1024;
export const BLOB_SWARM_MAX_CHUNKS = 1025;
export const BLOB_SWARM_MAX_PROVIDERS = 2048;
export const MAX_SYNC_STATE_BYTES = 4 * 1024 * 1024;
export const MAX_MAILBOX_BODY_BYTES = 1 * 1024 * 1024;
export const MAX_MAILBOX_DELIVERIES = 100;
export const MAX_RECOVERY_BLOB_BYTES = 1 * 1024 * 1024;
export const MAX_RECOVERY_STATE_BYTES = 4 * 1024 * 1024;
export const MAX_SEAL_STATE_BYTES = 8 * 1024 * 1024;

export function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

export function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

/** Strict base64 decoder with an allocation cap. Accepts padded standard or raw URL-safe input. */
export function decodeBase64Strict(
  value: unknown,
  maxBytes: number,
  urlSafe = false,
): Uint8Array | null {
  if (typeof value !== 'string' || maxBytes < 0) return null;
  // A base64 string can be at most 4/3 the decoded size, plus padding.
  if (value.length > Math.ceil(maxBytes / 3) * 4 + 4) return null;
  const pattern = urlSafe
    ? /^[A-Za-z0-9_-]+$/
    : /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
  if (!value || value.length % 4 === 1 || !pattern.test(value)) return null;
  const standard = urlSafe
    ? value.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (value.length % 4)) % 4)
    : value;
  try {
    const binary = atob(standard);
    if (binary.length > maxBytes) return null;
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

export function encodeBase64Chunked(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  }
  return btoa(binary);
}

function boundedText(value: unknown, maxBytes: number): value is string {
  return typeof value === 'string'
    && value.length > 0
    && !hasControlCharacters(value)
    && utf8ByteLength(value) <= maxBytes;
}

function safeOrigin(value: unknown): value is string | undefined {
  if (value === undefined) return true;
  if (!boundedText(value, MAX_ATTACHMENT_ORIGIN_BYTES)) return false;
  try {
    const parsed = new URL(value);
    return isTrustedHttpOrigin(parsed)
      && (parsed.pathname === '' || parsed.pathname === '/')
      && !parsed.search
      && !parsed.hash;
  } catch {
    return false;
  }
}

/** Validate the exact shape that is safe to carry inside an E2EE message. */
export function isSafeAttachment(value: unknown): value is XoreinAttachment {
  if (!isPlainObject(value)) return false;
  const id = value.id;
  const name = value.name;
  const contentType = value.content_type;
  const size = value.size;
  const key = value.key;
  const nonce = value.nonce;
  if (!boundedText(id, MAX_ATTACHMENT_ID_BYTES)
    || !boundedText(name, MAX_ATTACHMENT_NAME_BYTES)
    || !boundedText(contentType, MAX_ATTACHMENT_TYPE_BYTES)
    || typeof size !== 'number'
    || !Number.isSafeInteger(size)
    || size < 0
    || size > MAX_ATTACHMENT_BYTES
    || typeof key !== 'string'
    || utf8ByteLength(key) > MAX_ATTACHMENT_KEY_BYTES
    || typeof nonce !== 'string'
    || utf8ByteLength(nonce) > MAX_ATTACHMENT_KEY_BYTES
    || !safeOrigin(value.origin)) {
    return false;
  }
  const keyBytes = decodeBase64Strict(key, 32, true);
  const nonceBytes = decodeBase64Strict(nonce, 12, true);
  if (!keyBytes || keyBytes.length !== 32 || !nonceBytes || nonceBytes.length !== 12) return false;
  if (value.content_hash !== undefined
    && (typeof value.content_hash !== 'string' || !/^[0-9a-f]{64}$/.test(value.content_hash))) {
    return false;
  }
  if (value.swarm !== undefined
    && (value.content_hash === undefined || !isSafeBlobSwarmManifest(value.swarm))) return false;
  return true;
}

export function isSafeBlobSwarmManifest(value: unknown): value is import('../../types.js').BlobSwarmManifest {
  if (!isPlainObject(value)
    || value.version !== 1
    || typeof value.blob_id !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.blob_id)
    || (value.node_namespace !== undefined
      && (typeof value.node_namespace !== 'string'
        || !/^[A-Za-z0-9_-]{43}$/.test(value.node_namespace)))
    || !boundedText(value.scope_id, 256)
    || !boundedText(value.owner_peer_id, 256)
    || !Number.isSafeInteger(value.ciphertext_size)
    || Number(value.ciphertext_size) < 16
    || Number(value.ciphertext_size) > MAX_ATTACHMENT_BYTES + 16
    || !Number.isSafeInteger(value.chunk_size)
    || Number(value.chunk_size) < BLOB_SWARM_MIN_CHUNK_BYTES
    || Number(value.chunk_size) > BLOB_SWARM_MAX_CHUNK_BYTES
    || !Array.isArray(value.chunk_hashes)
    || value.chunk_hashes.length < 1
    || value.chunk_hashes.length > BLOB_SWARM_MAX_CHUNKS
    || value.chunk_hashes.some(hash => typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) {
    return false;
  }
  const expectedChunks = Math.ceil(Number(value.ciphertext_size) / Number(value.chunk_size));
  if (expectedChunks !== value.chunk_hashes.length) return false;
  if (value.provider_peer_ids !== undefined) {
    if (!Array.isArray(value.provider_peer_ids)
      || value.provider_peer_ids.length > BLOB_SWARM_MAX_PROVIDERS
      || value.provider_peer_ids.some(peer => !boundedText(peer, 256))) {
      return false;
    }
    if (new Set(value.provider_peer_ids).size !== value.provider_peer_ids.length) return false;
  }
  return true;
}

/** Returns null for an explicitly malformed attachment list, undefined when absent. */
export function normalizeSafeAttachments(value: unknown): XoreinAttachment[] | undefined | null {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > MAX_ATTACHMENTS) return null;
  const seen = new Set<string>();
  const out: XoreinAttachment[] = [];
  for (const item of value) {
    if (!isSafeAttachment(item)) return null;
    if (seen.has(item.id)) return null;
    seen.add(item.id);
    out.push(item);
  }
  return out;
}
