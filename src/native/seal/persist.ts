// Encrypted at-rest persistence for Seal ratchet sessions.
//
// The serialized session state (bundle, private prekeys, per-peer ratchets) is
// key material, so it is sealed with AES-256-GCM under a key derived from the
// identity's Ed25519 seed before it touches localStorage. A reloaded client
// restores its in-flight ratchets and keeps decrypting ongoing DMs.
import { gcm } from '@noble/ciphers/aes.js';
import { deriveKey } from './kdf.js';
import type { SerializedSealState } from './session.js';
import type { XoreinIdentity } from '../identity/identity.js';

const LABEL = 'xorein/seal-store/v1';

function storageKey(peerId: string): string {
  return `harmolyn:native:seal:${peerId}`;
}

function stateKey(identity: XoreinIdentity): Uint8Array {
  return deriveKey(identity.edSeed, null, LABEL, 32);
}

function toB64(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
}

function fromB64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function saveSealState(identity: XoreinIdentity, state: SerializedSealState): void {
  if (typeof window === 'undefined') return;
  try {
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ct = gcm(stateKey(identity), nonce).encrypt(new TextEncoder().encode(JSON.stringify(state)));
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
    const blob = fromB64(raw);
    if (blob.length < 12 + 16) return null;
    const pt = gcm(stateKey(identity), blob.subarray(0, 12)).decrypt(blob.subarray(12));
    return JSON.parse(new TextDecoder().decode(pt)) as SerializedSealState;
  } catch {
    return null;
  }
}

export function clearSealState(identity: XoreinIdentity): void {
  try {
    if (typeof window !== 'undefined') window.localStorage.removeItem(storageKey(identity.peerId));
  } catch { /* best effort */ }
}
