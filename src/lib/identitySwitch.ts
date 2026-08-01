// Shared identity-vault helpers: unlock-and-activate (with reload) and encrypted
// backup download. Extracted from SettingsScreen so the auth flow (IdentityPicker,
// KeyRevealStep, AccountSwitcher) and Settings share one implementation.
import {
  decryptIdentity,
  activateFromVault,
  loadEncryptedIdentity,
  type VaultEntry,
} from '@/native/identity/storage';
import { isEncryptedSyncBlob, type EncryptedSyncBlob } from '@/native/state/stateSync';

const NATIVE_STATE_KEY = 'harmolyn:native:state';

/**
 * Unlock a vault identity with its passphrase, make it the active identity, and
 * reload so the native engine starts with it. Throws on a wrong passphrase or a
 * corrupt blob (the caller surfaces the error and stays put — no reload).
 *
 * Switching always requires a reload: the engine resolves its identity once in
 * start(); there is no hot identity-swap. `onBeforeReload` fires AFTER decryption
 * succeeds (so it only runs on a real switch, never on a wrong password) and the
 * actual reload is deferred a tick so a "Switching account…" overlay can paint
 * before the page goes away.
 */
export async function unlockAndActivateVaultIdentity(
  entry: VaultEntry,
  passphrase: string,
  onBeforeReload?: () => void,
): Promise<void> {
  if (!passphrase.trim()) throw new Error('Enter the password for this account.');
  // Use the passphrase exactly as entered — trimming would break accounts whose
  // password legitimately contains leading/trailing whitespace.
  const identity = await decryptIdentity(entry.blob, passphrase);
  await activateFromVault(entry.peerId);
  // Seed the native state with this identity's profile so the engine restores the
  // display_name on the next load. Without this the engine's peer-id mismatch
  // detection wipes the store and the display_name is lost, making the
  // "Viewing as guest" banner reappear after a successful unlock.
  try {
    const peerId = identity.peerId ?? entry.peerId;
    localStorage.setItem(NATIVE_STATE_KEY, JSON.stringify({
      identity: { peer_id: peerId, id: peerId, profile: { display_name: entry.displayName } },
    }));
    sessionStorage.removeItem(NATIVE_STATE_KEY);
  } catch { /* best effort */ }
  onBeforeReload?.();
  // Defer the reload so React can paint the switching overlay first.
  await new Promise<void>((resolve) => { setTimeout(resolve, 60); });
  window.location.reload();
}

/**
 * Trigger a browser download of an encrypted identity backup as JSON. When a
 * `state` snapshot is provided, wraps it as a v2 backup `{ v, identity, state }`
 * so restoring brings back servers/DMs/profile too; otherwise downloads the raw
 * identity blob (back-compatible with restore, which detects both shapes).
 */
export function downloadIdentityBackup(blob: VaultEntry['blob'], peerId: string, state?: EncryptedSyncBlob | null): void {
  if (state !== undefined && state !== null && !isEncryptedSyncBlob(state)) {
    throw new Error('Identity backup account state must be encrypted.');
  }
  const payload = state ? { v: 2, identity: blob, state } : blob;
  const json = JSON.stringify(payload, null, 2);
  const file = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = `harmolyn-identity-${peerId.slice(0, 12)}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Download the encrypted backup for the currently-active registered identity
 * (used right after account creation). The blob is already encrypted under the
 * password the user just chose, so no extra passphrase prompt is needed.
 * Returns false if there is no persisted identity to back up.
 */
export async function downloadActiveIdentityBackup(peerId: string, state?: EncryptedSyncBlob | null): Promise<boolean> {
  const blob = await loadEncryptedIdentity();
  if (!blob) return false;
  downloadIdentityBackup(blob, peerId, state);
  return true;
}
