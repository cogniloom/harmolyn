// Invite-token capability for server joins.
//
// Each server holds a secret `invite_secret` (random, owner-generated, never sent
// to the support node). A shareable invite embeds a token = HMAC(secret, serverId).
// The owner verifies the token before admitting a joiner or serving history, so
// knowing an (unguessable) server id + owner id is no longer sufficient to pull a
// server's messages — you must hold a real, revocable invite capability.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';
import { gcm } from '@noble/ciphers/aes.js';
import type { XoreinRuntimeServer, XoreinServerOwnerProof } from '../../types.js';
import type { XoreinIdentity } from '../identity/identity.js';
import { identitySigningKey } from '../identity/identity.js';
import { hybridSign, hybridVerify, HYBRID_SIG_BYTES } from '../crypto/hybrid.js';
import { identityKeyBlob, parseIdentityKeyBlob } from '../identity/safetyNumber.js';
import { peerIdToEdPub } from '../delivery/offline.js';
import { canonicalJSON } from './signedHistory.js';
import {
  canonicalInviteTransitionProof,
  canonicalServerRecord,
  verifyServerRecord,
} from './signedServer.js';
import {
  CHANNEL_CRYPTO_PROFILE,
  isChannelSecurityMode,
} from '../security/channelMode.js';
import { decodeBase64Strict, hasControlCharacters, isPlainObject } from '../security/limits.js';

const INVITE_LABEL = 'xorein/invite/v1/';
const SIGNED_INVITE_LABEL = 'xorein/invite-capability/v2\n';
const TRANSITION_SEAL_LABEL = 'xorein/invite-transition-seal/v3\n';
const DEFAULT_INVITE_TTL_MS = 365 * 24 * 60 * 60 * 1000;
const MAX_SIGNED_INVITE_BYTES = 12 * 1024;
const MAX_TRANSITION_CIPHERTEXT_BYTES = 2048;

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

export interface SignedInviteCapabilityV2 {
  v: 2;
  server_id: string;
  owner_peer_id: string;
  generation: number;
  issued_at: number;
  expires_at: number;
  identity_key: string;
  signature: string;
}

export interface SignedInviteCapabilityV3 {
  v: 3;
  server_id: string;
  owner_peer_id: string;
  generation: number;
  issued_at: number;
  expires_at: number;
  identity_key: string;
  transition_nonce: string;
  transition_ciphertext: string;
  content_hash: string;
  signature: string;
}

export type SignedInviteCapability = SignedInviteCapabilityV2 | SignedInviteCapabilityV3;

interface InviteTransitionStateV1 {
  v: 1;
  crowd_root: string;
  crowd_epoch: number;
  server_rev: number;
  invite_generation: number;
  updated_at: string;
  channel_security_mode: 'tree' | 'crowd';
  channel_crypto_profile: typeof CHANNEL_CRYPTO_PROFILE;
}

function inviteCanonical(capability: Omit<SignedInviteCapabilityV2, 'signature'>): Uint8Array {
  return new TextEncoder().encode(SIGNED_INVITE_LABEL + canonicalJSON(capability));
}

function transitionAAD(
  capability: Omit<SignedInviteCapabilityV3, 'signature' | 'transition_ciphertext'>,
): Uint8Array {
  return new TextEncoder().encode(TRANSITION_SEAL_LABEL + canonicalJSON(capability));
}

function transitionOwnerProof(capability: SignedInviteCapabilityV3): XoreinServerOwnerProof {
  return {
    version: 3,
    identity_key: capability.identity_key,
    signature: capability.signature,
    content_hash: capability.content_hash,
    admission_generation: capability.generation,
    issued_at: capability.issued_at,
    expires_at: capability.expires_at,
    transition_nonce: capability.transition_nonce,
    transition_ciphertext: capability.transition_ciphertext,
  };
}

function sameTransitionProof(
  proof: XoreinServerOwnerProof | undefined,
  capability: SignedInviteCapabilityV3,
): boolean {
  return proof?.version === 3
    && proof.identity_key === capability.identity_key
    && proof.signature === capability.signature
    && proof.content_hash === capability.content_hash
    && proof.admission_generation === capability.generation
    && proof.issued_at === capability.issued_at
    && proof.expires_at === capability.expires_at
    && proof.transition_nonce === capability.transition_nonce
    && proof.transition_ciphertext === capability.transition_ciphertext;
}

function boundedCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
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
  const unsigned: Omit<SignedInviteCapabilityV2, 'signature'> = {
    v: 2,
    server_id: serverId,
    owner_peer_id: identity.peerId,
    generation,
    issued_at: issuedAt,
    expires_at: issuedAt + Math.max(60_000, Math.min(ttlMs, DEFAULT_INVITE_TTL_MS)),
    identity_key: identityKeyBlob(identity.edPub, identity.mldsaPub),
  };
  const capability: SignedInviteCapabilityV2 = {
    ...unsigned,
    signature: base64url(hybridSign(inviteCanonical(unsigned), identitySigningKey(identity))),
  };
  return base64url(new TextEncoder().encode(JSON.stringify(capability)));
}

/**
 * Mint a forward-secure portable invite. The owner authorizes one exact next
 * server/key epoch, but seals its root under the CURRENT epoch root. A bearer
 * can therefore prove admission to any current member without learning the old
 * root; only an already-authorized member can open and serve the next record.
 */
export function createForwardSecureInviteCapability(
  currentServer: XoreinRuntimeServer,
  nextServer: XoreinRuntimeServer,
  ttlMs = DEFAULT_INVITE_TTL_MS,
  identity: XoreinIdentity | null = activeIdentity,
): string {
  if (!identity
    || identity.peerId !== currentServer.owner_peer_id
    || nextServer.id !== currentServer.id
    || nextServer.owner_peer_id !== currentServer.owner_peer_id
    || !verifyServerRecord(currentServer)) return '';
  const currentRoot = decodeBase64Strict(currentServer.crowd_root, 32);
  const nextRoot = decodeBase64Strict(nextServer.crowd_root, 32);
  const currentEpoch = currentServer.crowd_epoch ?? 0;
  const currentRevision = currentServer.server_rev ?? 0;
  const currentGeneration = currentServer.invite_generation ?? 0;
  if (!currentRoot || currentRoot.length !== 32 || !nextRoot || nextRoot.length !== 32
    || equal(currentRoot, nextRoot)
    || !boundedCounter(currentEpoch) || !boundedCounter(currentRevision)
    || !boundedCounter(currentGeneration)
    || currentEpoch === 0xffffffff || currentRevision === 0xffffffff
    || currentGeneration === 0xffffffff
    || !boundedCounter(nextServer.crowd_epoch)
    || !boundedCounter(nextServer.server_rev)
    || !boundedCounter(nextServer.invite_generation)
    || nextServer.crowd_epoch !== currentEpoch + 1
    || nextServer.server_rev !== currentRevision + 1
    || nextServer.invite_generation !== currentGeneration + 1
    || !isChannelSecurityMode(nextServer.channel_security_mode)
    || nextServer.channel_crypto_profile !== CHANNEL_CRYPTO_PROFILE
    || typeof nextServer.updated_at !== 'string' || !nextServer.updated_at
    || nextServer.updated_at.length > 96 || hasControlCharacters(nextServer.updated_at)) return '';

  // Reconstruct the only structural changes an invite is allowed to authorize.
  // Membership is deliberately outside the structural record so every bearer
  // admitted by this invite cohort can converge on the same future epoch.
  const expectedNext: XoreinRuntimeServer = {
    ...currentServer,
    crowd_root: nextServer.crowd_root,
    crowd_epoch: nextServer.crowd_epoch,
    server_rev: nextServer.server_rev,
    invite_generation: nextServer.invite_generation,
    updated_at: nextServer.updated_at,
    channel_security_mode: nextServer.channel_security_mode,
    channel_crypto_profile: CHANNEL_CRYPTO_PROFILE,
    ...(currentServer.manifest ? {
      manifest: {
        ...currentServer.manifest,
        security_mode: nextServer.channel_security_mode,
      },
    } : {}),
  };
  const expectedCanonical = canonicalServerRecord(expectedNext);
  const suppliedCanonical = canonicalServerRecord(nextServer);
  if (!equal(expectedCanonical, suppliedCanonical)) return '';

  const issuedAt = Date.now();
  const expiresAt = issuedAt + Math.max(60_000, Math.min(ttlMs, DEFAULT_INVITE_TTL_MS));
  const identityKey = identityKeyBlob(identity.edPub, identity.mldsaPub);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const contentHash = base64url(sha256(suppliedCanonical));
  const aadInput: Omit<SignedInviteCapabilityV3, 'signature' | 'transition_ciphertext'> = {
    v: 3,
    server_id: currentServer.id,
    owner_peer_id: currentServer.owner_peer_id,
    generation: currentGeneration,
    issued_at: issuedAt,
    expires_at: expiresAt,
    identity_key: identityKey,
    transition_nonce: base64url(nonce),
    content_hash: contentHash,
  };
  const transition: InviteTransitionStateV1 = {
    v: 1,
    crowd_root: nextServer.crowd_root,
    crowd_epoch: nextServer.crowd_epoch,
    server_rev: nextServer.server_rev,
    invite_generation: nextServer.invite_generation,
    updated_at: nextServer.updated_at,
    channel_security_mode: nextServer.channel_security_mode,
    channel_crypto_profile: CHANNEL_CRYPTO_PROFILE,
  };
  let ciphertext: Uint8Array;
  try {
    ciphertext = gcm(currentRoot, nonce, transitionAAD(aadInput))
      .encrypt(new TextEncoder().encode(JSON.stringify(transition)));
  } catch {
    return '';
  }
  if (ciphertext.length < 16 || ciphertext.length > MAX_TRANSITION_CIPHERTEXT_BYTES) return '';
  const unsigned: Omit<SignedInviteCapabilityV3, 'signature'> = {
    ...aadInput,
    transition_ciphertext: base64url(ciphertext),
  };
  const capability: SignedInviteCapabilityV3 = {
    ...unsigned,
    signature: base64url(hybridSign(
      canonicalInviteTransitionProof(unsigned),
      identitySigningKey(identity),
    )),
  };
  const encoded = new TextEncoder().encode(JSON.stringify(capability));
  return encoded.length <= MAX_SIGNED_INVITE_BYTES ? base64url(encoded) : '';
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
  const encoded = decodeBase64url(token, MAX_SIGNED_INVITE_BYTES);
  if (!encoded) return null;
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(encoded)); } catch { return null; }
  if (!isPlainObject(value)) return null;
  const capability = value as Partial<SignedInviteCapability>;
  if ((capability.v !== 2 && capability.v !== 3)
    || capability.server_id !== expectedServerId
    || capability.owner_peer_id !== expectedOwnerPeerId
    || capability.generation !== expectedGeneration
    || !boundedCounter(capability.generation)
    || !Number.isSafeInteger(capability.issued_at)
    || !Number.isSafeInteger(capability.expires_at)
    || Number(capability.issued_at) < 0
    || Number(capability.issued_at) > now + 5 * 60_000
    || Number(capability.expires_at) < now
    || Number(capability.expires_at) <= Number(capability.issued_at)
    || Number(capability.expires_at) - Number(capability.issued_at) > DEFAULT_INVITE_TTL_MS
    || typeof capability.identity_key !== 'string'
    || typeof capability.signature !== 'string') return null;
  const identity = parseIdentityKeyBlob(capability.identity_key);
  const signature = decodeBase64url(capability.signature, HYBRID_SIG_BYTES);
  if (!identity || identity.ed25519.length !== 32 || identity.mldsa65.length !== 1952
    || !signature || signature.length !== HYBRID_SIG_BYTES) return null;
  const peerEd = peerIdToEdPub(expectedOwnerPeerId);
  if (!peerEd || !equal(peerEd, identity.ed25519)) return null;
  let canonical: Uint8Array;
  if (capability.v === 2) {
    if (!exactKeys(value, [
      'v', 'server_id', 'owner_peer_id', 'generation', 'issued_at',
      'expires_at', 'identity_key', 'signature',
    ])) return null;
    const unsigned: Omit<SignedInviteCapabilityV2, 'signature'> = {
      v: 2,
      server_id: capability.server_id,
      owner_peer_id: capability.owner_peer_id,
      generation: capability.generation,
      issued_at: capability.issued_at,
      expires_at: capability.expires_at,
      identity_key: capability.identity_key,
    };
    canonical = inviteCanonical(unsigned);
  } else {
    if (!exactKeys(value, [
      'v', 'server_id', 'owner_peer_id', 'generation', 'issued_at',
      'expires_at', 'identity_key', 'transition_nonce',
      'transition_ciphertext', 'content_hash', 'signature',
    ])) return null;
    const nonce = decodeBase64url(capability.transition_nonce, 12);
    const ciphertext = decodeBase64url(
      capability.transition_ciphertext,
      MAX_TRANSITION_CIPHERTEXT_BYTES,
    );
    const contentHash = decodeBase64url(capability.content_hash, 32);
    if (!nonce || nonce.length !== 12
      || !ciphertext || ciphertext.length < 16
      || !contentHash || contentHash.length !== 32) return null;
    const unsigned: Omit<SignedInviteCapabilityV3, 'signature'> = {
      v: 3,
      server_id: capability.server_id,
      owner_peer_id: capability.owner_peer_id,
      generation: capability.generation,
      issued_at: capability.issued_at,
      expires_at: capability.expires_at,
      identity_key: capability.identity_key,
      transition_nonce: capability.transition_nonce,
      transition_ciphertext: capability.transition_ciphertext,
      content_hash: capability.content_hash,
    };
    canonical = canonicalInviteTransitionProof(unsigned);
  }
  return hybridVerify(canonical, signature, {
    edPublic: identity.ed25519,
    mldsaPublic: identity.mldsa65,
  }) ? capability as SignedInviteCapability : null;
}

/**
 * Open the owner-authorized next epoch using a verified current server record.
 * The returned record carries the same durable owner signature as the invite,
 * so the joiner and every member can independently reject a modified epoch.
 */
export function openForwardSecureInviteTransition(
  currentServer: XoreinRuntimeServer,
  capability: SignedInviteCapabilityV3,
): XoreinRuntimeServer | null {
  if (!verifyServerRecord(currentServer)
    || capability.server_id !== currentServer.id
    || capability.owner_peer_id !== currentServer.owner_peer_id
    || capability.generation !== (currentServer.invite_generation ?? 0)) return null;
  const currentRoot = decodeBase64Strict(currentServer.crowd_root, 32);
  const nonce = decodeBase64url(capability.transition_nonce, 12);
  const ciphertext = decodeBase64url(
    capability.transition_ciphertext,
    MAX_TRANSITION_CIPHERTEXT_BYTES,
  );
  if (!currentRoot || currentRoot.length !== 32 || !nonce || nonce.length !== 12
    || !ciphertext || ciphertext.length < 16) return null;
  const aadInput: Omit<SignedInviteCapabilityV3, 'signature' | 'transition_ciphertext'> = {
    v: 3,
    server_id: capability.server_id,
    owner_peer_id: capability.owner_peer_id,
    generation: capability.generation,
    issued_at: capability.issued_at,
    expires_at: capability.expires_at,
    identity_key: capability.identity_key,
    transition_nonce: capability.transition_nonce,
    content_hash: capability.content_hash,
  };
  let decoded: unknown;
  try {
    const plaintext = gcm(currentRoot, nonce, transitionAAD(aadInput)).decrypt(ciphertext);
    decoded = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    return null;
  }
  if (!isPlainObject(decoded)
    || !exactKeys(decoded, [
      'v', 'crowd_root', 'crowd_epoch', 'server_rev', 'invite_generation',
      'updated_at', 'channel_security_mode', 'channel_crypto_profile',
    ])
    || decoded.v !== 1
    || typeof decoded.crowd_root !== 'string'
    || decodeBase64Strict(decoded.crowd_root, 32)?.length !== 32
    || equal(currentRoot, decodeBase64Strict(decoded.crowd_root, 32)!)
    || !boundedCounter(decoded.crowd_epoch)
    || !boundedCounter(decoded.server_rev)
    || !boundedCounter(decoded.invite_generation)
    || decoded.crowd_epoch !== (currentServer.crowd_epoch ?? 0) + 1
    || decoded.server_rev !== (currentServer.server_rev ?? 0) + 1
    || decoded.invite_generation !== (currentServer.invite_generation ?? 0) + 1
    || !isChannelSecurityMode(decoded.channel_security_mode)
    || decoded.channel_crypto_profile !== CHANNEL_CRYPTO_PROFILE
    || typeof decoded.updated_at !== 'string' || !decoded.updated_at
    || decoded.updated_at.length > 96 || hasControlCharacters(decoded.updated_at)) return null;

  const next: XoreinRuntimeServer = {
    ...currentServer,
    crowd_root: decoded.crowd_root,
    crowd_epoch: decoded.crowd_epoch,
    server_rev: decoded.server_rev,
    invite_generation: decoded.invite_generation,
    updated_at: decoded.updated_at,
    channel_security_mode: decoded.channel_security_mode,
    channel_crypto_profile: CHANNEL_CRYPTO_PROFILE,
    ...(currentServer.manifest ? {
      manifest: {
        ...currentServer.manifest,
        security_mode: decoded.channel_security_mode,
      },
    } : {}),
    owner_proof: transitionOwnerProof(capability),
  };
  return verifyServerRecord(next) ? next : null;
}

/** True when this is the already-installed epoch authorized by `capability`. */
export function isForwardSecureInviteTransitionRecord(
  server: XoreinRuntimeServer,
  capability: SignedInviteCapabilityV3,
): boolean {
  return server.id === capability.server_id
    && server.owner_peer_id === capability.owner_peer_id
    && server.invite_generation === capability.generation + 1
    && sameTransitionProof(server.owner_proof, capability)
    && verifyServerRecord(server);
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
