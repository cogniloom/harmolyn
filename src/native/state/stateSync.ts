// Cross-device account-state sync.
//
// The support node is relay/blob-only (no per-identity state store), and servers
// are created locally. So "use my ID on another device and see the same servers"
// is achieved by carrying an ENCRYPTED snapshot of the recoverable account state
// (servers, joined ids, DMs, profile) inside the social-recovery payload — and
// applying it on the new device once the identity is recovered.
//
// The snapshot is encrypted with a key derived from the identity's Ed25519 seed,
// so guardians who hold it (and the relay) only ever see ciphertext. Only the
// identity holder can decrypt it.
import { gcm } from '@noble/ciphers/aes.js';
import { deriveKey } from '../seal/kdf.js';
import type { XoreinIdentity } from '../identity/identity.js';
import type { XoreinRuntimeServer, XoreinRuntimeDM, XoreinRuntimeProfile } from '../../types.js';
import { getState, addServer, recordServerMembership, ensureDm, mergeNativeIdentityProfile } from './store.js';
import { publishNativeSnapshot } from './snapshot.js';

const LABEL = 'xorein/state-sync/v1';
/** localStorage slot holding an encrypted state blob delivered during recovery. */
export const PENDING_STATE_KEY = 'harmolyn:recovery:pending-state';

// The engine registers a (debounced) handler that re-distributes the account-state
// snapshot to recovery contacts. Mutations that change the recoverable state
// (creating/joining a server) call markStateDirty() so guardians stay fresh.
let _dirtyHandler: (() => void) | null = null;
export function registerStateSyncHandler(fn: (() => void) | null): void { _dirtyHandler = fn; }
export function markStateDirty(): void { try { _dirtyHandler?.(); } catch { /* non-fatal */ } }

export interface SyncState {
  servers: Record<string, XoreinRuntimeServer>;
  joined_server_ids: string[];
  dms: Record<string, XoreinRuntimeDM>;
  profile?: XoreinRuntimeProfile;
}

export interface EncryptedSyncBlob {
  v: 1;
  nonce: string;       // hex
  ciphertext: string;  // base64
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s: string): Uint8Array {
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64(bytes: Uint8Array): string {
  let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s);
}
function unb64(s: string): Uint8Array {
  const bin = atob(s); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function stateKey(id: XoreinIdentity): Uint8Array {
  return deriveKey(id.edSeed, null, LABEL, 32);
}

/** Snapshot the recoverable subset of local state. */
export function captureSyncState(): SyncState {
  const s = getState();
  return {
    servers: s.servers,
    joined_server_ids: s.joined_server_ids,
    dms: s.dms,
    ...(s.identity?.profile ? { profile: s.identity.profile } : {}),
  };
}

export function encryptSyncState(id: XoreinIdentity, state: SyncState): EncryptedSyncBlob {
  const key = stateKey(id);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(state));
  const ct = gcm(key, nonce).encrypt(pt);
  return { v: 1, nonce: hex(nonce), ciphertext: b64(ct) };
}

export function decryptSyncState(id: XoreinIdentity, blob: EncryptedSyncBlob): SyncState | null {
  try {
    const key = stateKey(id);
    const pt = gcm(key, unhex(blob.nonce)).decrypt(unb64(blob.ciphertext));
    return JSON.parse(new TextDecoder().decode(pt)) as SyncState;
  } catch {
    return null;
  }
}

/** Merge a recovered snapshot into local state (additive — never destructive). */
export function applySyncState(state: SyncState): void {
  for (const server of Object.values(state.servers ?? {})) {
    if (server && server.id) addServer(server);
  }
  for (const id of state.joined_server_ids ?? []) recordServerMembership(id);
  for (const [id, dm] of Object.entries(state.dms ?? {})) {
    if (dm?.participants) ensureDm(id, dm.participants);
  }
  if (state.profile?.display_name) {
    mergeNativeIdentityProfile(state.profile.display_name, state.profile.bio, state.profile.avatar);
  }
  publishNativeSnapshot();
}

/**
 * On a freshly-recovered device, decrypt and apply any state blob the recovery
 * flow stashed (see RestoreStep). Idempotent; clears the slot when done.
 */
export function restorePendingSyncState(id: XoreinIdentity): boolean {
  try {
    const raw = localStorage.getItem(PENDING_STATE_KEY);
    if (!raw) return false;
    const blob = JSON.parse(raw) as EncryptedSyncBlob;
    const state = decryptSyncState(id, blob);
    localStorage.removeItem(PENDING_STATE_KEY);
    if (state) { applySyncState(state); return true; }
    return false;
  } catch {
    try { localStorage.removeItem(PENDING_STATE_KEY); } catch { /* ignore */ }
    return false;
  }
}
