// Invite-token capability for server joins.
//
// Each server holds a secret `invite_secret` (random, owner-generated, never sent
// to the support node). A shareable invite embeds a token = HMAC(secret, serverId).
// The owner verifies the token before admitting a joiner or serving history, so
// knowing an (unguessable) server id + owner id is no longer sufficient to pull a
// server's messages — you must hold a real, revocable invite capability.
import { hmac } from '@noble/hashes/hmac.js';
import { sha256 } from '@noble/hashes/sha2.js';

const INVITE_LABEL = 'xorein/invite/v1/';

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
