// Invite-token capability for server joins.
//
// Each server holds a secret `invite_secret` (random, owner-generated, never sent
// to the support node). A shareable invite embeds a token = HMAC(secret, serverId).
// The owner verifies the token before admitting a joiner or serving history, so
// knowing an (unguessable) server id + owner id is no longer sufficient to pull a
// server's messages — you must hold a real, revocable invite capability.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { XoreinIdentity } from '../identity/identity.js';
import { identitySigningKey } from '../identity/identity.js';
import { hybridSign, hybridVerify, HYBRID_SIG_BYTES } from '../crypto/hybrid.js';
import { identityKeyBlob, parseIdentityKeyBlob } from '../identity/safetyNumber.js';
import { peerIdToEdPub } from '../delivery/offline.js';
import { canonicalJSON } from './signedHistory.js';

const INVITE_LABEL = 'xorein/invite/v1/';
const SIGNED_INVITE_LABEL = 'xorein/invite-capability/v2\n';
const DEFAULT_INVITE_TTL_MS = 365 * 24 * 60 * 60 * 1000;

let activeIdentity: XoreinIdentity | null = null;

export function registerInviteIdentity(identity: XoreinIdentity): void {
  activeIdentity = identity;
}

export function resetInviteIdentity(): void {
  activeIdentity = null;
}

function secretBytes(secretB64: string): Uint8Array {
  const bin = atob(secretB64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function base64url(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeBase64url(value: unknown, maxBytes: number): Uint8Array | null {
  if (typeof value !== 'string' || !value || value.length > Math.ceil(maxBytes * 4 / 3) + 4
    || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + (value.length % 4 ? '='.repeat(4 - value.length % 4) : '');
    const raw = atob(padded);
    if (raw.length > maxBytes) return null;
    const out = Uint8Array.from(raw, c => c.charCodeAt(0));
    return base64url(out) === value ? out : null;
  } catch {
    return null;
  }
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export interface SignedInviteCapability {
  v: 2;
  server_id: string;
  owner_peer_id: string;
  generation: number;
  issued_at: number;
  expires_at: number;
  identity_key: string;
  signature: string;
}

function inviteCanonical(capability: Omit<SignedInviteCapability, 'signature'>): Uint8Array {
  return new TextEncoder().encode(SIGNED_INVITE_LABEL + canonicalJSON(capability));
}

/**
 * Mint a portable owner-signed admission capability. Any current member can
 * verify it while the owner is offline; rotating invite_generation revokes it.
 */
export function createSignedInviteCapability(
  serverId: string,
  generation: number,
  ttlMs = DEFAULT_INVITE_TTL_MS,
  identity: XoreinIdentity | null = activeIdentity,
): string {
  if (!identity || !serverId || !Number.isSafeInteger(generation) || generation < 0) return '';
  const issuedAt = Date.now();
  const unsigned: Omit<SignedInviteCapability, 'signature'> = {
    v: 2,
    server_id: serverId,
    owner_peer_id: identity.peerId,
    generation,
    issued_at: issuedAt,
    expires_at: issuedAt + Math.max(60_000, Math.min(ttlMs, DEFAULT_INVITE_TTL_MS)),
    identity_key: identityKeyBlob(identity.edPub, identity.mldsaPub),
  };
  const capability: SignedInviteCapability = {
    ...unsigned,
    signature: base64url(hybridSign(inviteCanonical(unsigned), identitySigningKey(identity))),
  };
  return base64url(new TextEncoder().encode(JSON.stringify(capability)));
}

/**
 * Verify a portable admission capability without contacting the owner.
 * Returns the decoded capability on success so callers can retain evidence.
 */
export function verifySignedInviteCapability(
  token: string,
  expectedServerId: string,
  expectedOwnerPeerId: string,
  expectedGeneration: number,
  now = Date.now(),
): SignedInviteCapability | null {
  const encoded = decodeBase64url(token, 12 * 1024);
  if (!encoded) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(encoded)); } catch { return null; }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const capability = value as Partial<SignedInviteCapability>;
  if (capability.v !== 2
    || capability.server_id !== expectedServerId
    || capability.owner_peer_id !== expectedOwnerPeerId
    || capability.generation !== expectedGeneration
    || !Number.isSafeInteger(capability.issued_at)
    || !Number.isSafeInteger(capability.expires_at)
    || Number(capability.issued_at) > now + 5 * 60_000
    || Number(capability.expires_at) < now
    || Number(capability.expires_at) <= Number(capability.issued_at)
    || typeof capability.identity_key !== 'string'
    || typeof capability.signature !== 'string') return null;
  const identity = parseIdentityKeyBlob(capability.identity_key);
  const signature = decodeBase64url(capability.signature, HYBRID_SIG_BYTES);
  if (!identity || identity.ed25519.length !== 32 || identity.mldsa65.length !== 1952
    || !signature || signature.length !== HYBRID_SIG_BYTES) return null;
  const peerEd = peerIdToEdPub(expectedOwnerPeerId);
  if (!peerEd || !equal(peerEd, identity.ed25519)) return null;
  const unsigned: Omit<SignedInviteCapability, 'signature'> = {
    v: 2,
    server_id: capability.server_id,
    owner_peer_id: capability.owner_peer_id,
    generation: capability.generation,
    issued_at: capability.issued_at,
    expires_at: capability.expires_at,
    identity_key: capability.identity_key,
  };
  return hybridVerify(inviteCanonical(unsigned), signature, {
    edPublic: identity.ed25519,
    mldsaPublic: identity.mldsa65,
  }) ? capability as SignedInviteCapability : null;
}

/** token = base64url(HMAC-SHA256(invite_secret, "xorein/invite/v1/" + serverId)). */
export function computeInviteToken(secretB64: string, serverId: string): string {
  if (!secretB64) return '';
  const mac = hmac(sha256, secretBytes(secretB64), new TextEncoder().encode(INVITE_LABEL + serverId));
  return base64url(mac);
}

/**
 * Verify a presented invite token. Servers without an invite_secret (created
 * before the invite-capability feature) are treated as closed — unknown peers
 * cannot join; returning true for missing secrets would allow any peer who
 * learned the serverId to pull history without authentication.
 */
export function verifyInviteToken(secretB64: string | undefined, serverId: string, token: string): boolean {
  if (!secretB64) return false; // no secret → closed; use nativeCreateServer to get a fresh invite_secret
  if (!token) return false;
  const expected = computeInviteToken(secretB64, serverId);
  if (expected.length !== token.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ token.charCodeAt(i);
  return diff === 0;
}
