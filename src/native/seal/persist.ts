// Encrypted at-rest persistence for Seal ratchet sessions.
//
// The serialized session state (bundle, private prekeys, per-peer ratchets) is
// key material, so it is sealed with AES-256-GCM under a key derived from the
// identity's Ed25519 seed before it touches localStorage. A reloaded client
// restores its in-flight ratchets and keeps decrypting ongoing DMs.
import { gcm } from '@noble/ciphers/aes.js';
import { deriveKey } from './kdf.js';
import { verifyBundle, type PrekeyBundle } from './bundle.js';
import type { SerializedSealState } from './session.js';
import type { XoreinIdentity } from '../identity/identity.js';
import {
  decodeBase64Strict,
  encodeBase64Chunked,
  isPlainObject,
  MAX_SEAL_STATE_BYTES,
} from '../security/limits.js';

const LABEL = 'xorein/seal-store/v1';

function storageKey(peerId: string): string {
  return `harmolyn:native:seal:${peerId}`;
}

function stateKey(identity: XoreinIdentity): Uint8Array {
  return deriveKey(identity.edSeed, null, LABEL, 32);
}

function toB64(b: Uint8Array): string {
  return encodeBase64Chunked(b);
}

function fromB64(s: string): Uint8Array {
  const out = decodeBase64Strict(s, MAX_SEAL_STATE_BYTES + 28);
  if (!out) throw new Error('seal persistence: invalid base64');
  return out;
}

function byteArray(value: unknown, length: number): value is number[] {
  return Array.isArray(value) && value.length === length
    && value.every(item => Number.isSafeInteger(item) && item >= 0 && item <= 255);
}

function b64Bytes(value: unknown, length: number): boolean {
  return typeof value === 'string' && decodeBase64Strict(value, length)?.length === length;
}

function validRatchet(value: unknown): boolean {
  if (!isPlainObject(value)
    || !b64Bytes(value.rootKey, 32)
    || !b64Bytes(value.sendChainKey, 32)
    || !b64Bytes(value.recvChainKey, 32)
    || !b64Bytes(value.sendRatchetPriv, 32)
    || !b64Bytes(value.sendRatchetPub, 32)
    || !b64Bytes(value.remoteRatchetPub, 32)
    || !Number.isSafeInteger(value.sendCounter)
    || !Number.isSafeInteger(value.recvCounter)
    || !Number.isSafeInteger(value.prevSendChainLen)
    || !Array.isArray(value.skipList)
    || value.skipList.length > 1000) return false;
  return value.skipList.every(entry => Array.isArray(entry)
    && (entry.length === 2 || entry.length === 3)
    && typeof entry[0] === 'string'
    && entry[0].length <= 100
    && b64Bytes(entry[1], 32)
    && (entry.length === 2 || (typeof entry[2] === 'number' && Number.isSafeInteger(entry[2]))));
}

function validPrekeyPrivate(value: unknown): boolean {
  if (!isPlainObject(value)
    || !b64Bytes(value.spkPriv, 32)
    || !b64Bytes(value.mlkemSk, 2400)
    || !Array.isArray(value.opkPrivs)
    || value.opkPrivs.length > 100) return false;
  return value.opkPrivs.every(item => b64Bytes(item, 32));
}

function validBundle(value: unknown): value is PrekeyBundle {
  if (!isPlainObject(value)
    || typeof value.peer_id !== 'string'
    || value.peer_id.length === 0
    || value.peer_id.length > 256
    || !byteArray(value.identity_key_ed25519, 32)
    || !byteArray(value.identity_key_ml_dsa_65, 1952)
    || !byteArray(value.signed_prekey_x25519, 32)
    || !byteArray(value.signed_prekey_signature, 3381)
    || !Array.isArray(value.one_time_prekeys_x25519)
    || value.one_time_prekeys_x25519.length > 100
    || !value.one_time_prekeys_x25519.every(item => byteArray(item, 32))
    || !byteArray(value.ml_kem_768_pk, 1184)
    || !byteArray(value.ml_kem_768_pk_signature, 3381)
    || !byteArray(value.bundle_signature, 3381)
    || !Number.isSafeInteger(value.published_at)
    || !Number.isSafeInteger(value.expires_at)) return false;
  return verifyBundle(value as unknown as PrekeyBundle);
}

function validSerializedSealState(value: unknown, peerId: string): value is SerializedSealState {
  if (!isPlainObject(value)
    || !validBundle(value.bundle)
    || value.bundle.peer_id !== peerId
    || !validPrekeyPrivate(value.priv)
    || !Array.isArray(value.sessions)
    || value.sessions.length > 1000
    || !value.sessions.every(entry => Array.isArray(entry)
      && entry.length === 2
      && typeof entry[0] === 'string'
      && entry[0].length > 0
      && entry[0].length <= 256
      && validRatchet(entry[1]))) return false;
  if (value.consumedOpks !== undefined
    && (!Array.isArray(value.consumedOpks) || value.consumedOpks.length > 100 || !value.consumedOpks.every(i => Number.isSafeInteger(i) && i >= 0 && i < 100))) return false;
  if (value.retired !== undefined
    && (!Array.isArray(value.retired) || value.retired.length > 1
      || !value.retired.every(item => isPlainObject(item) && validBundle(item.bundle) && validPrekeyPrivate(item.priv)
        && Array.isArray(item.consumedOpks) && item.consumedOpks.length <= 100))) return false;
  if (value.pendingInit !== undefined && (!Array.isArray(value.pendingInit) || value.pendingInit.length > 1000)) return false;
  return true;
}

export function saveSealState(identity: XoreinIdentity, state: SerializedSealState): void {
  if (typeof window === 'undefined') return;
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode(JSON.stringify(state));
    if (plaintext.length > MAX_SEAL_STATE_BYTES) return;
    const ct = gcm(stateKey(identity), nonce).encrypt(plaintext);
    const blob = new Uint8Array(12 + ct.length);
    blob.set(nonce, 0);
    blob.set(ct, 12);
    window.localStorage.setItem(storageKey(identity.peerId), toB64(blob));
  } catch { /* quota / private mode — best effort */ }
}

export function loadSealState(identity: XoreinIdentity): SerializedSealState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(storageKey(identity.peerId));
    if (!raw) return null;
    if (raw.length > Math.ceil((MAX_SEAL_STATE_BYTES + 28) * 4 / 3) + 1024) return null;
    const blob = fromB64(raw);
    if (blob.length < 12 + 16) return null;
    const pt = gcm(stateKey(identity), blob.subarray(0, 12)).decrypt(blob.subarray(12));
    if (pt.length > MAX_SEAL_STATE_BYTES) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(pt));
    return validSerializedSealState(parsed, identity.peerId) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearSealState(identity: XoreinIdentity): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey(identity.peerId));
  } catch { /* best effort */ }
}
