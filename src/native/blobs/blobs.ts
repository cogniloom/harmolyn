// xorein blob storage: client-side encrypted files/avatars via relay node.
// The relay stores opaque (encrypted) blobs — zero-knowledge per node role.
// Content-addressed: blob ID derived from SHA-256 of plaintext for dedup.
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm as aesGcm } from '@noble/ciphers/aes.js';
import { supportNodeOrigin } from '../nodeOrigin.js';
import { reportNodeRequestFailure, reportNodeRequestSuccess } from '../../lib/nodeHealth.js';
import { isTrustedHttpOrigin } from '../../lib/trustedOrigin.js';
import type { BlobSwarmManifest, XoreinAttachment } from '../../types.js';
import {
  decodeBase64Strict,
  encodeBase64Chunked,
  hasControlCharacters,
  isPlainObject,
  isSafeAttachment,
  isSafeBlobSwarmManifest,
  MAX_ATTACHMENT_BYTES,
} from '../security/limits.js';
import { getState } from '../state/store.js';
import {
  createLocalBlobSwarm,
  fetchBlobFromSwarm,
  seedBlobSwarm,
} from './swarm.js';

const BLOB_KEY_INFO = 'xorein/blob/v1/encryption-key';
const BLOB_NONCE_INFO = 'xorein/blob/v1/nonce';

/**
 * The legacy HTTP blob-store origin (scheme+host, no /v1). Current scoped
 * attachments use the authenticated blob-swarm protocol; this remains only so
 * pre-v1 attachment references can still be recovered from their original node.
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
  /** Content address, or a legacy opaque HTTP upload ID. */
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
  /** Legacy HTTP node origin. New scoped attachments do not publish an origin. */
  origin?: string;
  /** Node-preferred, peer-owned content-addressed replica manifest. */
  swarm?: BlobSwarmManifest;
}

export interface BlobUploadOptions {
  /** Channel or DM whose authenticated members may store and serve fragments. */
  scopeId?: string;
  /** Defaults to the active local identity. */
  ownerPeerId?: string;
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
    return isTrustedHttpOrigin(parsed)
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
    && validOrigin(ref.origin)
    && (ref.swarm === undefined || isSafeBlobSwarmManifest(ref.swarm));
}

function availableScopeProviderCount(scopeId: string): number {
  if (!scopeId) return 0;
  const state = getState();
  const ids = new Set<string>();
  const server = Object.values(state.servers).find(candidate =>
    Object.prototype.hasOwnProperty.call(candidate.channels, scopeId));
  for (const peerId of server?.members ?? state.dms[scopeId]?.participants ?? []) ids.add(peerId);
  for (const peer of Object.values(state.peers)) {
    if (peer.role === 'relay' || peer.role === 'archivist') ids.add(peer.peer_id);
  }
  ids.delete(state.identity?.peer_id ?? '');
  return ids.size;
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
 * Encrypt and distribute a blob through the authenticated replica swarm.
 * Xorein nodes are attempted first, then scope members fill missing copies. All
 * providers receive only ciphertext and the key stays in the E2EE message.
 * Unscoped callers retain the legacy HTTP store solely for compatibility.
 */
export async function uploadBlob(
  data: Uint8Array,
  filename: string,
  contentType = 'application/octet-stream',
  options: BlobUploadOptions = {},
): Promise<BlobRef> {
  if (data.length > MAX_ATTACHMENT_BYTES) throw new RangeError('blob upload: file exceeds limit');
  if (typeof filename !== 'string' || filename.length > 512 || typeof contentType !== 'string' || contentType.length > 256) {
    throw new Error('blob upload: invalid metadata');
  }
  const hash = contentHash(data);
  const { ciphertext, key, nonce } = encryptBlob(data);
  const scopeId = options.scopeId?.trim() ?? '';
  const ownerPeerId = options.ownerPeerId?.trim()
    || getState().identity?.peer_id
    || '';
  if (scopeId && !ownerPeerId) {
    throw new Error('blob upload: a local peer identity is required for peer storage');
  }
  const swarm = scopeId
    ? await createLocalBlobSwarm(
      ciphertext,
      scopeId,
      ownerPeerId,
      availableScopeProviderCount(scopeId),
    )
    : undefined;

  const origin = configuredNodeOrigin();
  // Legacy unscoped uploads use the retired HTTP blob route. Current scoped
  // attachments must not probe it: doing so against a current Xorein node would
  // manufacture a 404 health failure before the P2P replica succeeds.
  let nodeId = '';
  let uploadedOrigin: string | undefined;
  let nodeError: unknown;
  if (origin && !swarm) {
    try {
      const ctData = 'data:application/octet-stream;base64,' + toBase64(ciphertext);
      const res = await fetch(`${apiBase(origin)}/uploads`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: 'blob', content_type: 'application/octet-stream', data: ctData }),
      });
      reportNodeRequestSuccess();
      if (!res.ok) throw new Error(`blob upload: ${res.status}`);
      const json = await res.json() as unknown;
      if (!isPlainObject(json)
        || typeof json.id !== 'string'
        || json.id.length === 0
        || json.id.length > 256
        || hasControlCharacters(json.id)) {
        throw new Error('blob upload: invalid response');
      }
      nodeId = json.id;
      uploadedOrigin = origin;
    } catch (error) {
      nodeError = error;
      reportNodeRequestFailure(error);
    }
  }

  if (swarm) {
    // Await bounded distribution so the attachment is not published before any
    // currently reachable member has had a chance to retain encrypted fragments.
    // A lone peer may still publish: it remains the complete source and future
    // members can fetch from it once a route exists.
    await seedBlobSwarm(swarm);
  } else if (!nodeId) {
    if (nodeError instanceof Error) throw nodeError;
    throw new Error('blob upload: no support node or peer storage scope is available');
  }

  const ref: BlobRef = {
    id: nodeId || swarm!.blob_id,
    contentHash: hash,
    key,
    nonce,
    filename,
    contentType,
    size: data.length,
    ...(uploadedOrigin ? { origin: uploadedOrigin } : {}),
    ...(swarm ? { swarm } : {}),
  };
  if (!validBlobRef(ref)) throw new Error('blob upload: invalid reference');
  return ref;
}

/**
 * Download and decrypt a blob. Current references use node-preferred swarm
 * retrieval; legacy references may still use their explicitly selected node.
 */
export async function downloadBlob(ref: BlobRef): Promise<Uint8Array> {
  if (!validBlobRef(ref)) throw new Error('blob download: invalid reference');
  // Legacy refs carry the node they were uploaded to; current swarm refs do not.
  const localOrigin = configuredNodeOrigin();
  const targetOrigin = ref.origin || localOrigin;
  // The origin is carried inside an E2EE message and is therefore controlled
  // by the sender. HTTPS alone is not an allowlist: fetching an attachment
  // from an arbitrary origin would disclose the recipient's IP, timing, and
  // referrer to a malicious peer. Cross-node attachments require the user to
  // explicitly select that support node first; never auto-dial a peer-chosen
  // host.
  if (ref.origin && ref.origin !== localOrigin && !ref.swarm) {
    throw new Error('blob download: attachment origin is not this device\'s selected support node');
  }
  const mayUseSelectedNode = !!targetOrigin && (!ref.origin || ref.origin === localOrigin);
  let ciphertext: Uint8Array | null = null;
  let swarmError: unknown;
  if (ref.swarm) {
    try {
      ciphertext = await fetchBlobFromSwarm(ref.swarm);
    } catch (error) {
      swarmError = error;
    }
  }

  let nodeError: unknown;
  // Only legacy refs (or transitional refs that explicitly carry an origin)
  // use the HTTP blob store. A new swarm ref must never turn a removed HTTP
  // route into a false "node offline" signal.
  if (!ciphertext && mayUseSelectedNode && (!ref.swarm || Boolean(ref.origin))) {
    const base = apiBase(targetOrigin);
    try {
      const res = await fetch(`${base}/uploads/${encodeURIComponent(ref.id)}`);
      reportNodeRequestSuccess();
      if (!res.ok) throw new Error(`blob download: ${res.status}`);
      const json = await res.json() as unknown;
      if (!isPlainObject(json) || typeof json.data !== 'string') {
        throw new Error('blob download: invalid response');
      }
      let b64 = json.data;
      if (b64.startsWith('data:')) {
        const comma = b64.indexOf(',');
        if (comma < 0) throw new Error('blob download: invalid data URI');
        b64 = b64.slice(comma + 1);
      }
      const candidate = fromBase64(b64);
      // A malicious or stale node cannot force a bad copy to win over the
      // content-addressed peer swarm.
      if (ref.swarm && contentHash(candidate) !== ref.swarm.blob_id) {
        throw new Error('blob download: node returned a fragment-manifest mismatch');
      }
      ciphertext = candidate;
    } catch (error) {
      nodeError = error;
      reportNodeRequestFailure(error);
    }
  }

  if (!ciphertext) {
    if (nodeError instanceof Error) throw nodeError;
    if (swarmError instanceof Error) throw swarmError;
    throw new Error('blob download: no support node or peer provider is reachable');
  }
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
    swarm: ref.swarm ? {
      ...ref.swarm,
      chunk_hashes: [...ref.swarm.chunk_hashes],
      ...(ref.swarm.provider_peer_ids
        ? { provider_peer_ids: [...ref.swarm.provider_peer_ids] }
        : {}),
    } : undefined,
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
    swarm: att.swarm,
  };
}

/** Encrypt + upload a file, returning the message-embeddable encrypted attachment ref. */
export async function uploadEncryptedAttachment(
  data: Uint8Array,
  filename: string,
  contentType?: string,
  scopeId?: string,
): Promise<XoreinAttachment> {
  return blobRefToAttachment(await uploadBlob(data, filename, contentType, { scopeId }));
}

/** Download + decrypt an attachment by its ref; verifies integrity when a hash is present. */
export async function downloadDecryptedAttachment(att: XoreinAttachment): Promise<Uint8Array> {
  const data = await downloadBlob(attachmentToBlobRef(att));
  if (att.content_hash && contentHash(data) !== att.content_hash) {
    throw new Error('attachment integrity check failed');
  }
  return data;
}
