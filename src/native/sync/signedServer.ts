// Owner-authenticated portable server snapshots.
//
// Members may serve these snapshots while the owner is offline. The proof
// authenticates server structure and key epochs, while membership availability
// can grow through separately owner-signed invite capabilities.
import { sha256 } from '@noble/hashes/sha2.js';
import type {
  XoreinRuntimeServer,
  XoreinServerOwnerProof,
} from '../../types.js';
import type { XoreinIdentity } from '../identity/identity.js';
import { identitySigningKey } from '../identity/identity.js';
import { hybridSign, hybridVerify, HYBRID_SIG_BYTES } from '../crypto/hybrid.js';
import { identityKeyBlob, parseIdentityKeyBlob } from '../identity/safetyNumber.js';
import { peerIdToEdPub } from '../delivery/offline.js';
import { canonicalJSON } from './signedHistory.js';

const DOMAIN_V1 = 'xorein/server-record/v1\n';
const DOMAIN_V2 = 'xorein/server-record/v2\n';
const DOMAIN_INVITE_TRANSITION_V3 = 'xorein/invite-transition/v3\n';
let activeIdentity: XoreinIdentity | null = null;

export function registerServerSigningIdentity(identity: XoreinIdentity): void {
  activeIdentity = identity;
}

export function resetServerSigningIdentity(): void {
  activeIdentity = null;
}

function b64url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value: unknown, expected: number): Uint8Array | null {
  if (typeof value !== 'string' || !value || value.length > 24 * 1024
    || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + (value.length % 4 ? '='.repeat(4 - value.length % 4) : '');
    const raw = atob(padded);
    const out = Uint8Array.from(raw, c => c.charCodeAt(0));
    return out.length === expected && b64url(out) === value ? out : null;
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

/**
 * Membership is intentionally not covered by this structural proof. A member
 * list can gain portable, owner-authorized admissions while the owner is
 * offline; those admissions are validated from the signed invite capability.
 * Everything that could redefine/decrypt the server remains owner-signed here.
 */
function serverRecordV1(server: XoreinRuntimeServer): Record<string, unknown> {
  return {
    version: 1,
    id: server.id,
    name: server.name,
    description: server.description ?? '',
    owner_peer_id: server.owner_peer_id,
    created_at: server.created_at ?? '',
    updated_at: server.updated_at ?? '',
    channels: server.channels,
    manifest: server.manifest ?? {},
    roles: server.roles ?? [],
    member_roles: server.member_roles ?? {},
    channel_security_mode: server.channel_security_mode ?? 'crowd',
    crowd_root: server.crowd_root ?? '',
    crowd_epoch: server.crowd_epoch ?? 0,
    replica_secret: server.replica_secret ?? '',
    server_rev: server.server_rev ?? 0,
    invite_generation: server.invite_generation ?? 0,
  };
}

function canonicalServerRecordV1(server: XoreinRuntimeServer): Uint8Array {
  return new TextEncoder().encode(DOMAIN_V1 + canonicalJSON(serverRecordV1(server)));
}

export function canonicalServerRecord(server: XoreinRuntimeServer): Uint8Array {
  const record = {
    ...serverRecordV1(server),
    version: 2,
    channel_crypto_profile: server.channel_crypto_profile ?? 'scope-aad-v2',
  };
  return new TextEncoder().encode(DOMAIN_V2 + canonicalJSON(record));
}

export interface InviteTransitionProofPayload {
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
}

/** Canonical owner authorization shared by the invite token and resulting
 * server-record proof. One hybrid signature therefore authenticates both the
 * bearer capability and the exact pre-authorized post-join epoch. */
export function canonicalInviteTransitionProof(
  payload: InviteTransitionProofPayload,
): Uint8Array {
  return new TextEncoder().encode(
    DOMAIN_INVITE_TRANSITION_V3 + canonicalJSON(payload),
  );
}

export function signServerRecord(
  server: XoreinRuntimeServer,
  identity: XoreinIdentity | null = activeIdentity,
): XoreinServerOwnerProof | undefined {
  if (!identity || server.owner_peer_id !== identity.peerId) return undefined;
  const canonical = canonicalServerRecord(server);
  return {
    version: 2,
    identity_key: identityKeyBlob(identity.edPub, identity.mldsaPub),
    signature: b64url(hybridSign(canonical, identitySigningKey(identity))),
    content_hash: b64url(sha256(canonical)),
  };
}

export function verifyServerRecord(server: XoreinRuntimeServer): boolean {
  const proof = server.owner_proof;
  if (!proof || (proof.version !== 1 && proof.version !== 2 && proof.version !== 3)) return false;
  // A v1 proof predates crypto-profile authentication. Never let one authorize
  // an explicitly supplied profile field.
  if (proof.version === 1 && server.channel_crypto_profile !== undefined) return false;
  const identity = parseIdentityKeyBlob(proof.identity_key);
  const signature = unb64url(proof.signature, HYBRID_SIG_BYTES);
  const expectedHash = unb64url(proof.content_hash, 32);
  if (!identity || identity.ed25519.length !== 32 || identity.mldsa65.length !== 1952
    || !signature || !expectedHash) return false;
  const peerEd = peerIdToEdPub(server.owner_peer_id);
  if (!peerEd || !equal(peerEd, identity.ed25519)) return false;
  let canonical: Uint8Array;
  try {
    canonical = proof.version === 1 ? canonicalServerRecordV1(server) : canonicalServerRecord(server);
  } catch { return false; }
  if (!equal(sha256(canonical), expectedHash)) return false;
  let signedPayload = canonical;
  if (proof.version === 3) {
    if (!Number.isSafeInteger(proof.admission_generation)
      || Number(proof.admission_generation) < 0
      || !Number.isSafeInteger(proof.issued_at)
      || !Number.isSafeInteger(proof.expires_at)
      || Number(proof.expires_at) <= Number(proof.issued_at)
      || typeof proof.transition_nonce !== 'string'
      || typeof proof.transition_ciphertext !== 'string'
      || proof.transition_nonce.length > 64
      || proof.transition_ciphertext.length > 4096) return false;
    signedPayload = canonicalInviteTransitionProof({
      v: 3,
      server_id: server.id,
      owner_peer_id: server.owner_peer_id,
      generation: Number(proof.admission_generation),
      issued_at: Number(proof.issued_at),
      expires_at: Number(proof.expires_at),
      identity_key: proof.identity_key,
      transition_nonce: proof.transition_nonce,
      transition_ciphertext: proof.transition_ciphertext,
      content_hash: proof.content_hash,
    });
  }
  return hybridVerify(signedPayload, signature, {
    edPublic: identity.ed25519,
    mldsaPublic: identity.mldsa65,
  });
}
