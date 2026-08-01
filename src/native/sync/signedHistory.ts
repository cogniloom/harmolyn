// Self-authenticating channel-history records.
//
// A relay, archivist, server owner, or ordinary member may serve a copy, but the
// copy is accepted only when the original author's hybrid signature verifies and
// its Ed25519 key derives the claimed libp2p PeerID. Provider agreement is useful
// for availability/equivocation detection; it is never the source of truth.
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  XoreinAttachment,
  XoreinMessageAuthorProof,
  XoreinRuntimeMessage,
} from '../../types.js';
import type { XoreinIdentity } from '../identity/identity.js';
import { identitySigningKey } from '../identity/identity.js';
import { hybridSign, hybridVerify, HYBRID_SIG_BYTES } from '../crypto/hybrid.js';
import { identityKeyBlob, parseIdentityKeyBlob } from '../identity/safetyNumber.js';
import { peerIdToEdPub } from '../delivery/offline.js';

const DOMAIN = 'xorein/channel-message/v1\n';
const MAX_IDENTITY_KEY_BYTES = 32 + 1952;
const MAX_PROOF_TEXT_BYTES = 24 * 1024;

let activeIdentity: XoreinIdentity | null = null;

export function registerHistoryIdentity(identity: XoreinIdentity): void {
  activeIdentity = identity;
}

export function resetHistoryIdentity(): void {
  activeIdentity = null;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function b64url(bytes: Uint8Array): string {
  let raw = '';
  for (let i = 0; i < bytes.length; i++) raw += String.fromCharCode(bytes[i]);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value: unknown, expectedLength?: number): Uint8Array | null {
  if (typeof value !== 'string' || !value || value.length > MAX_PROOF_TEXT_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + (value.length % 4 ? '='.repeat(4 - value.length % 4) : '');
    const raw = atob(padded);
    const out = Uint8Array.from(raw, c => c.charCodeAt(0));
    if (expectedLength !== undefined && out.length !== expectedLength) return null;
    return b64url(out) === value ? out : null;
  } catch {
    return null;
  }
}

function normalizedMedia(media: XoreinAttachment[] | undefined): XoreinAttachment[] | undefined {
  if (!media?.length) return undefined;
  return media.map(item => ({
    id: item.id,
    name: item.name,
    content_type: item.content_type,
    size: item.size,
    key: item.key,
    nonce: item.nonce,
    ...(item.content_hash ? { content_hash: item.content_hash } : {}),
    ...(item.origin ? { origin: item.origin } : {}),
  }));
}

/**
 * RFC-8785-style deterministic JSON for the JSON value subset used here:
 * sorted object keys, stable array order, no whitespace.
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('signed history: non-finite number');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key =>
      `${JSON.stringify(key)}:${canonicalJSON(record[key])}`,
    ).join(',')}}`;
  }
  throw new Error('signed history: unsupported canonical value');
}

export function canonicalMessageVersion(message: XoreinRuntimeMessage): Uint8Array {
  if (message.scope_type !== 'channel' || !message.server_id) {
    throw new Error('signed history: only server channel messages are supported');
  }
  const record = {
    version: 1,
    id: message.id,
    server_id: message.server_id,
    scope_type: 'channel',
    scope_id: message.scope_id,
    sender_peer_id: message.sender_peer_id,
    body: message.body,
    ...(normalizedMedia(message.media) ? { media: normalizedMedia(message.media) } : {}),
    ...(message.reply_to ? { reply_to: message.reply_to } : {}),
    ...(message.forwarded_from ? { forwarded_from: message.forwarded_from } : {}),
    created_at: message.created_at ?? '',
    updated_at: message.updated_at ?? '',
    deleted: message.deleted === true,
    security_mode: message.security_mode ?? 'clear',
    encrypted: message.encrypted === true,
    revision: message.author_revision ?? 0,
  };
  return new TextEncoder().encode(DOMAIN + canonicalJSON(record));
}

/** Sign the current immutable version, or return undefined outside an active engine. */
export function signChannelMessageVersion(
  message: XoreinRuntimeMessage,
  identity: XoreinIdentity | null = activeIdentity,
): XoreinMessageAuthorProof | undefined {
  if (!identity || message.scope_type !== 'channel' || !message.server_id
    || message.sender_peer_id !== identity.peerId) return undefined;
  const canonical = canonicalMessageVersion(message);
  return {
    version: 1,
    identity_key: identityKeyBlob(identity.edPub, identity.mldsaPub),
    signature: b64url(hybridSign(canonical, identitySigningKey(identity))),
    content_hash: b64url(sha256(canonical)),
  };
}

export type HistoryVerification =
  | { ok: true; contentHash: string }
  | { ok: false; reason: 'missing_proof' | 'malformed_proof' | 'peer_id_mismatch' | 'hash_mismatch' | 'bad_signature' };

/** Verify one provider-independent message copy against the original author. */
export function verifySignedHistoryMessage(message: XoreinRuntimeMessage): HistoryVerification {
  const proof = message.author_proof;
  if (!proof) return { ok: false, reason: 'missing_proof' };
  if (proof.version !== 1
    || typeof proof.identity_key !== 'string'
    || typeof proof.signature !== 'string'
    || typeof proof.content_hash !== 'string'
    || proof.identity_key.length > MAX_PROOF_TEXT_BYTES) {
    return { ok: false, reason: 'malformed_proof' };
  }

  const identity = parseIdentityKeyBlob(proof.identity_key);
  const signature = unb64url(proof.signature, HYBRID_SIG_BYTES);
  const expectedHash = unb64url(proof.content_hash, 32);
  if (!identity || identity.ed25519.length !== 32
    || identity.mldsa65.length !== MAX_IDENTITY_KEY_BYTES - 32
    || !signature || !expectedHash) {
    return { ok: false, reason: 'malformed_proof' };
  }
  const peerEd = peerIdToEdPub(message.sender_peer_id);
  if (!peerEd || !bytesEqual(peerEd, identity.ed25519)) {
    return { ok: false, reason: 'peer_id_mismatch' };
  }

  let canonical: Uint8Array;
  try {
    canonical = canonicalMessageVersion(message);
  } catch {
    return { ok: false, reason: 'malformed_proof' };
  }
  const actualHash = sha256(canonical);
  if (!bytesEqual(actualHash, expectedHash)) return { ok: false, reason: 'hash_mismatch' };
  if (!hybridVerify(canonical, signature, {
    edPublic: identity.ed25519,
    mldsaPublic: identity.mldsa65,
  })) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true, contentHash: proof.content_hash };
}

/** Keep the highest valid author revision for each message id. */
export function selectNewestVerifiedVersions(messages: XoreinRuntimeMessage[]): XoreinRuntimeMessage[] {
  const byID = new Map<string, XoreinRuntimeMessage>();
  for (const message of messages) {
    if (!verifySignedHistoryMessage(message).ok) continue;
    const current = byID.get(message.id);
    const revision = message.author_revision ?? 0;
    const currentRevision = current?.author_revision ?? -1;
    if (!current || revision > currentRevision) byID.set(message.id, message);
  }
  return [...byID.values()];
}
