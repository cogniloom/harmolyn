// Bounded, end-to-end encrypted application routing through ordinary peers.
//
// Routers see only origin/target, expiry, path, and ciphertext size. The target
// verifies the origin's hybrid signature and pairwise AEAD before dispatching
// the inner protocol operation as that origin. This is not global flooding:
// each hop has a small fan-out, a six-hop ceiling, expiry, and replay cache.
import { gcm } from '@noble/ciphers/aes.js';
import { sha256 } from '@noble/hashes/sha2.js';
import type { XoreinIdentity } from '../identity/identity.js';
import { identitySigningKey } from '../identity/identity.js';
import { hybridSign, hybridVerify, HYBRID_SIG_BYTES } from '../crypto/hybrid.js';
import { deriveKey } from '../seal/kdf.js';
import { identityKeyBlob, parseIdentityKeyBlob } from '../identity/safetyNumber.js';
import { pairwiseMailboxSecret, peerIdToEdPub } from '../delivery/offline.js';
import { canonicalJSON } from './signedHistory.js';

const DOMAIN = 'xorein/routed-request/v1\n';
const KEY_LABEL = 'xorein/routed-request/payload/v1/';
const RESPONSE_KEY_LABEL = 'xorein/routed-request/response/v1/';
const MAX_ROUTE_CIPHERTEXT_BYTES = 4 * 1024 * 1024 + 64;
const MAX_ROUTE_TEXT_BYTES = Math.ceil(MAX_ROUTE_CIPHERTEXT_BYTES * 4 / 3) + 16;
const MAX_ROUTE_HOPS = 6;
const ROUTE_TTL_MS = 30_000;
const MAX_SEEN_ROUTES = 10_000;

let activeIdentity: XoreinIdentity | null = null;
const seenRoutes = new Map<string, number>();

export interface RoutedRequest {
  version: 1;
  id: string;
  origin_peer_id: string;
  target_peer_id: string;
  created_at_ms: number;
  expires_at_ms: number;
  max_hops: number;
  ciphertext: string;
  ciphertext_hash: string;
  identity_key: string;
  signature: string;
  path: string[];
}

export interface RoutedInnerRequest {
  protocol: string;
  operation: string;
  payload: Record<string, unknown>;
}

export function registerRouteIdentity(identity: XoreinIdentity): void {
  activeIdentity = identity;
}

export function resetRouteIdentity(): void {
  activeIdentity = null;
  seenRoutes.clear();
}

function b64url(bytes: Uint8Array): string {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64url(value: unknown, maxBytes: number): Uint8Array | null {
  if (typeof value !== 'string' || !value || value.length > MAX_ROUTE_TEXT_BYTES
    || !/^[A-Za-z0-9_-]+$/.test(value) || value.length % 4 === 1) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/')
      + (value.length % 4 ? '='.repeat(4 - value.length % 4) : '');
    const raw = atob(padded);
    if (raw.length > maxBytes) return null;
    const out = Uint8Array.from(raw, c => c.charCodeAt(0));
    return b64url(out) === value ? out : null;
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

function aad(request: Pick<RoutedRequest, 'id' | 'origin_peer_id' | 'target_peer_id'>, response = false): Uint8Array {
  return new TextEncoder().encode(
    `${DOMAIN}${response ? 'response' : 'request'}\n${request.id}\n${request.origin_peer_id}\n${request.target_peer_id}`,
  );
}

function canonicalRoute(request: RoutedRequest): Uint8Array {
  return new TextEncoder().encode(DOMAIN + canonicalJSON({
    version: request.version,
    id: request.id,
    origin_peer_id: request.origin_peer_id,
    target_peer_id: request.target_peer_id,
    created_at_ms: request.created_at_ms,
    expires_at_ms: request.expires_at_ms,
    max_hops: request.max_hops,
    ciphertext_hash: request.ciphertext_hash,
    identity_key: request.identity_key,
  }));
}

function routeSecret(
  identity: XoreinIdentity,
  otherPeerId: string,
  recipientPeerId: string,
  label: string,
  requestId: string,
): Uint8Array | null {
  const otherEd = peerIdToEdPub(otherPeerId);
  if (!otherEd) return null;
  const pair = pairwiseMailboxSecret(identity.edSeed, otherEd, recipientPeerId);
  return deriveKey(pair, null, label + requestId, 32);
}

function seal(key: Uint8Array, plaintext: Uint8Array, associatedData: Uint8Array): string {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = gcm(key, nonce, associatedData).encrypt(plaintext);
  const out = new Uint8Array(nonce.length + ciphertext.length);
  out.set(nonce);
  out.set(ciphertext, nonce.length);
  return b64url(out);
}

function open(key: Uint8Array, encoded: string, associatedData: Uint8Array): Uint8Array | null {
  const value = unb64url(encoded, MAX_ROUTE_CIPHERTEXT_BYTES);
  if (!value || value.length < 12 + 16) return null;
  try {
    return gcm(key, value.subarray(0, 12), associatedData).decrypt(value.subarray(12));
  } catch {
    return null;
  }
}

export function createRoutedRequest(
  targetPeerId: string,
  inner: RoutedInnerRequest,
  identity: XoreinIdentity | null = activeIdentity,
): RoutedRequest | null {
  if (!identity || !targetPeerId || targetPeerId === identity.peerId) return null;
  const id = crypto.randomUUID();
  let plaintext: Uint8Array;
  try {
    plaintext = new TextEncoder().encode(JSON.stringify(inner));
  } catch {
    return null;
  }
  if (!plaintext.length || plaintext.length > MAX_ROUTE_CIPHERTEXT_BYTES - 64) return null;
  const key = routeSecret(identity, targetPeerId, targetPeerId, KEY_LABEL, id);
  if (!key) return null;
  const now = Date.now();
  const request: RoutedRequest = {
    version: 1,
    id,
    origin_peer_id: identity.peerId,
    target_peer_id: targetPeerId,
    created_at_ms: now,
    expires_at_ms: now + ROUTE_TTL_MS,
    max_hops: MAX_ROUTE_HOPS,
    ciphertext: '',
    ciphertext_hash: '',
    identity_key: identityKeyBlob(identity.edPub, identity.mldsaPub),
    signature: '',
    path: [identity.peerId],
  };
  request.ciphertext = seal(key, plaintext, aad(request));
  request.ciphertext_hash = b64url(sha256(new TextEncoder().encode(request.ciphertext)));
  request.signature = b64url(hybridSign(canonicalRoute(request), identitySigningKey(identity)));
  return request;
}

export function verifyRoutedRequest(request: unknown, now = Date.now()): request is RoutedRequest {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return false;
  const value = request as Partial<RoutedRequest>;
  if (value.version !== 1
    || typeof value.id !== 'string' || !value.id || value.id.length > 128
    || typeof value.origin_peer_id !== 'string' || !value.origin_peer_id || value.origin_peer_id.length > 256
    || typeof value.target_peer_id !== 'string' || !value.target_peer_id || value.target_peer_id.length > 256
    || value.origin_peer_id === value.target_peer_id
    || !Number.isSafeInteger(value.created_at_ms) || !Number.isSafeInteger(value.expires_at_ms)
    || Number(value.created_at_ms) > now + 5 * 60_000
    || Number(value.expires_at_ms) < now || Number(value.expires_at_ms) - Number(value.created_at_ms) > ROUTE_TTL_MS
    || !Number.isSafeInteger(value.max_hops) || Number(value.max_hops) < 1 || Number(value.max_hops) > MAX_ROUTE_HOPS
    || typeof value.ciphertext !== 'string' || value.ciphertext.length > MAX_ROUTE_TEXT_BYTES
    || typeof value.ciphertext_hash !== 'string'
    || typeof value.identity_key !== 'string' || value.identity_key.length > 16_384
    || typeof value.signature !== 'string'
    || !Array.isArray(value.path) || value.path.length < 1 || value.path.length > Number(value.max_hops) + 1
    || value.path[0] !== value.origin_peer_id
    || value.path.some(peer => typeof peer !== 'string' || !peer || peer.length > 256)
    || new Set(value.path).size !== value.path.length) return false;
  const ciphertext = unb64url(value.ciphertext, MAX_ROUTE_CIPHERTEXT_BYTES);
  const expectedHash = unb64url(value.ciphertext_hash, 32);
  const signature = unb64url(value.signature, HYBRID_SIG_BYTES);
  const identity = parseIdentityKeyBlob(value.identity_key);
  const originEd = peerIdToEdPub(value.origin_peer_id);
  if (!ciphertext || !expectedHash || !signature || !identity || !originEd
    || !equal(originEd, identity.ed25519)
    || !equal(sha256(new TextEncoder().encode(value.ciphertext)), expectedHash)) return false;
  return hybridVerify(canonicalRoute(value as RoutedRequest), signature, {
    edPublic: identity.ed25519,
    mldsaPublic: identity.mldsa65,
  });
}

/** Claim one routed id at this hop to stop loops and fan-out replays. */
export function claimRoutedRequest(request: RoutedRequest, now = Date.now()): boolean {
  for (const [id, expiry] of seenRoutes) {
    if (expiry < now) seenRoutes.delete(id);
  }
  if (seenRoutes.has(request.id) || seenRoutes.size >= MAX_SEEN_ROUTES) return false;
  seenRoutes.set(request.id, request.expires_at_ms);
  return true;
}

export function openRoutedRequest(
  request: RoutedRequest,
  identity: XoreinIdentity | null = activeIdentity,
): RoutedInnerRequest | null {
  if (!identity || request.target_peer_id !== identity.peerId || !verifyRoutedRequest(request)) return null;
  const key = routeSecret(
    identity,
    request.origin_peer_id,
    request.target_peer_id,
    KEY_LABEL,
    request.id,
  );
  if (!key) return null;
  const plaintext = open(key, request.ciphertext, aad(request));
  if (!plaintext) return null;
  try {
    const inner = JSON.parse(new TextDecoder().decode(plaintext)) as Partial<RoutedInnerRequest>;
    if (!inner || typeof inner !== 'object' || Array.isArray(inner)
      || typeof inner.protocol !== 'string' || !inner.protocol || inner.protocol.length > 256
      || typeof inner.operation !== 'string' || !inner.operation || inner.operation.length > 128
      || !inner.payload || typeof inner.payload !== 'object' || Array.isArray(inner.payload)) return null;
    return inner as RoutedInnerRequest;
  } catch {
    return null;
  }
}

export function sealRoutedResponse(
  request: RoutedRequest,
  response: unknown,
  identity: XoreinIdentity | null = activeIdentity,
): string | null {
  if (!identity || request.target_peer_id !== identity.peerId) return null;
  const key = routeSecret(
    identity,
    request.origin_peer_id,
    request.target_peer_id,
    RESPONSE_KEY_LABEL,
    request.id,
  );
  if (!key) return null;
  try {
    const plaintext = new TextEncoder().encode(JSON.stringify(response));
    if (plaintext.length > MAX_ROUTE_CIPHERTEXT_BYTES - 64) return null;
    return seal(key, plaintext, aad(request, true));
  } catch {
    return null;
  }
}

export function openRoutedResponse<T>(
  request: RoutedRequest,
  ciphertext: unknown,
  identity: XoreinIdentity | null = activeIdentity,
): T | null {
  if (!identity || request.origin_peer_id !== identity.peerId || typeof ciphertext !== 'string') return null;
  const key = routeSecret(
    identity,
    request.target_peer_id,
    request.target_peer_id,
    RESPONSE_KEY_LABEL,
    request.id,
  );
  if (!key) return null;
  const plaintext = open(key, ciphertext, aad(request, true));
  if (!plaintext) return null;
  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as T;
  } catch {
    return null;
  }
}
