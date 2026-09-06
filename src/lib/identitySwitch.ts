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
const BACKUP_URL_REVOKE_DELAY_MS = 30_000;

/**
 * Unlock failures cross a crypto/storage trust boundary. Callers must not surface
 * raw exception text because browser/native errors can contain implementation
 * details, paths, serialized values, or provider-specific diagnostics.
 */
export class IdentityUnlockError extends Error {
  constructor(message = 'Could not unlock this account. Check the password and try again.') {
    super(message);
    this.name = 'IdentityUnlockError';
  }
}

/**
 * Unlock a vault identity with its passphrase, make it the active identity, and
 * reload so the native engine starts with it. Throws a stable, user-safe error on
 * decryption/activation failure; internal crypto/storage diagnostics never cross
 * into UI strings.
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
  if (!passphrase.trim()) throw new IdentityUnlockError('Enter the password for this account.');

  let identity: Awaited<ReturnType<typeof decryptIdentity>>;
  try {
    // Use the passphrase exactly as entered — trimming would break accounts whose
    // password legitimately contains leading/trailing whitespace.
    identity = await decryptIdentity(entry.blob, passphrase);
    await activateFromVault(entry.peerId);
  } catch {
    // Deliberately collapse wrong-password, corrupt-vault, and platform crypto
    // errors into one stable message. The UI does not need internal diagnostics.
    throw new IdentityUnlockError();
  }

  // Seed the native state with this identity's public profile so the engine restores
  // the display_name on the next load. Never place private key material here.
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
  a.rel = 'noopener';
  a.style.display = 'none';
  document.body.appendChild(a);
  try {
    a.click();
  } finally {
    a.remove();
    // Safari/WebKit can consume the blob URL after the synthetic click returns.
    // Revoking immediately can produce a zero-byte/missing backup. Keep the
    // encrypted URL briefly, then release it deterministically.
    window.setTimeout(() => URL.revokeObjectURL(url), BACKUP_URL_REVOKE_DELAY_MS);
  }
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
