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
import {
  decodeBase64Strict,
  encodeBase64Chunked,
  hasControlCharacters,
  isPlainObject,
  MAX_SYNC_STATE_BYTES,
} from '../security/limits.js';

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

/** Validate the transport/storage envelope without attempting decryption. */
export function isEncryptedSyncBlob(value: unknown): value is EncryptedSyncBlob {
  if (!isPlainObject(value) || value.v !== 1) return false;
  const nonce = unhex(value.nonce, 12);
  const ciphertext = decodeBase64Strict(value.ciphertext, MAX_SYNC_STATE_BYTES + 16);
  return nonce !== null && ciphertext !== null && ciphertext.length >= 16;
}

function hex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}
function unhex(s: unknown, exactBytes: number): Uint8Array | null {
  if (typeof s !== 'string' || s.length !== exactBytes * 2 || !/^[0-9a-f]+$/i.test(s)) return null;
  const out = new Uint8Array(exactBytes);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}
function b64(bytes: Uint8Array): string {
  return encodeBase64Chunked(bytes);
}

function boundedId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 256
    && !hasControlCharacters(value);
}

function validSyncState(value: unknown): value is SyncState {
  if (!isPlainObject(value) || !isPlainObject(value.servers) || Object.keys(value.servers).length > 200
    || !Array.isArray(value.joined_server_ids) || value.joined_server_ids.length > 2000
    || !value.joined_server_ids.every(boundedId)
    || !isPlainObject(value.dms) || Object.keys(value.dms).length > 2000) return false;
  for (const [serverId, serverValue] of Object.entries(value.servers)) {
    if (!isPlainObject(serverValue)
      || serverValue.id !== serverId
      || !boundedId(serverValue.id)
      || typeof serverValue.name !== 'string'
      || serverValue.name.length > 512
      || !boundedId(serverValue.owner_peer_id)
      || !Array.isArray(serverValue.members)
      || serverValue.members.length > 1000
      || !serverValue.members.every(boundedId)
      || !isPlainObject(serverValue.channels)
      || Object.keys(serverValue.channels).length > 500) return false;
    if (serverValue.crowd_root !== undefined
      && (typeof serverValue.crowd_root !== 'string' || decodeBase64Strict(serverValue.crowd_root, 32)?.length !== 32)) return false;
    if (serverValue.channel_security_mode !== undefined
      && serverValue.channel_security_mode !== 'tree'
      && serverValue.channel_security_mode !== 'crowd') return false;
    if (serverValue.channel_crypto_profile !== undefined
      && serverValue.channel_crypto_profile !== 'scope-aad-v2') return false;
    for (const [channelId, channel] of Object.entries(serverValue.channels)) {
      if (!isPlainObject(channel) || channel.id !== channelId || channel.server_id !== serverId || !boundedId(channel.id)) return false;
    }
  }
  for (const [dmId, dm] of Object.entries(value.dms)) {
    if (!isPlainObject(dm) || dm.id !== dmId || !boundedId(dm.id)
      || !Array.isArray(dm.participants) || dm.participants.length > 4 || !dm.participants.every(boundedId)) return false;
  }
  if (value.profile !== undefined) {
    const profile = value.profile;
    if (!isPlainObject(profile)
      || (profile.display_name !== undefined && typeof profile.display_name !== 'string')
      || (profile.bio !== undefined && typeof profile.bio !== 'string')
      || (profile.avatar !== undefined && typeof profile.avatar !== 'string')) return false;
    if (typeof profile.display_name === 'string' && profile.display_name.length > 256) return false;
    if (typeof profile.bio === 'string' && profile.bio.length > 4096) return false;
    if (typeof profile.avatar === 'string' && profile.avatar.length > 512 * 1024) return false;
  }
  return true;
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
  if (!validSyncState(state)) throw new Error('state sync: invalid state');
  const key = stateKey(id);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const pt = new TextEncoder().encode(JSON.stringify(state));
  if (pt.length > MAX_SYNC_STATE_BYTES) throw new Error('state sync: state exceeds limit');
  const ct = gcm(key, nonce).encrypt(pt);
  return { v: 1, nonce: hex(nonce), ciphertext: b64(ct) };
}

export function decryptSyncState(id: XoreinIdentity, blob: EncryptedSyncBlob): SyncState | null {
  try {
    if (!isEncryptedSyncBlob(blob)) return null;
    const nonce = unhex(blob.nonce, 12);
    const ciphertext = decodeBase64Strict(blob.ciphertext, MAX_SYNC_STATE_BYTES + 16);
    if (!nonce || !ciphertext) return null;
    const key = stateKey(id);
    const pt = gcm(key, nonce).decrypt(ciphertext);
    if (pt.length > MAX_SYNC_STATE_BYTES) return null;
    const parsed: unknown = JSON.parse(new TextDecoder().decode(pt));
    return validSyncState(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

/** Merge a recovered snapshot into local state (additive — never destructive). */
export function applySyncState(state: SyncState): void {
  if (!validSyncState(state)) return;
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
    if (raw.length > Math.ceil((MAX_SYNC_STATE_BYTES + 16) * 4 / 3) + 4096) {
      localStorage.removeItem(PENDING_STATE_KEY);
      return false;
    }
    const blob = JSON.parse(raw) as unknown;
    if (!isEncryptedSyncBlob(blob)) {
      localStorage.removeItem(PENDING_STATE_KEY);
      return false;
    }
    const state = decryptSyncState(id, blob);
    localStorage.removeItem(PENDING_STATE_KEY);
    if (state) { applySyncState(state); return true; }
    return false;
  } catch {
    try { localStorage.removeItem(PENDING_STATE_KEY); } catch { /* ignore */ }
    return false;
  }
}
