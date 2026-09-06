import React, { useState, useEffect } from 'react';
import { Shield, Upload, KeyRound, ArrowRight, ArrowLeft, X, Users, Loader2, Check } from 'lucide-react';
import { importToVault, activateFromVault, MAX_IDENTITY_BACKUP_BYTES } from '@/native/identity/storage';
import { useEnginePassphrase } from '@/lib/xoreinClientProvider';
import { useNativeEngine } from '@/native/engine/provider';
import { RECOVERY_DELIVERED_EVENT, type RecoveryDelivery } from '@/native/recovery/recovery';
import { isEncryptedSyncBlob, PENDING_STATE_KEY, type EncryptedSyncBlob } from '@/native/state/stateSync';
import { SecurityNote } from '@/components/SecurityNote';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface RestoreStepProps {
  /** The engine is starting with the restored identity — close the auth flow. */
  onRestored: () => void;
  /** Go back to the device account picker. */
  onBack: () => void;
  /** Switch to creating a brand-new account. */
  onCreate: () => void;
  /** Dismiss the auth flow entirely. */
  onClose: () => void;
}

const NATIVE_STATE_KEY = 'harmolyn:native:state';

/**
 * Restore an account from an encrypted backup file on a device that doesn't have
 * it yet. The backup holds only the keypair, so we also ask for a nickname to
 * display locally (the public key — your real identity — is unchanged). The engine
 * is then started with the restored identity in place, no reload required.
 */
export const RestoreStep: React.FC<RestoreStepProps> = ({ onRestored, onBack, onCreate, onClose }) => {
  const { setPassphrase } = useEnginePassphrase();
  const { engine } = useNativeEngine();
  const [backupText, setBackupText] = useState('');
  const [passphrase, setPassphraseInput] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Friend recovery: ask a guardian to release the backup they hold for you.
  const [guardianId, setGuardianId] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [friendStatus, setFriendStatus] = useState<'idle' | 'waiting' | 'received' | 'error'>('idle');
  const [friendError, setFriendError] = useState<string | null>(null);
  // Keep delivered encrypted account state in memory until restore succeeds. An
  // abandoned recovery attempt must not leave stale material in localStorage.
  const [deliveredState, setDeliveredState] = useState<EncryptedSyncBlob | undefined>(undefined);

  useEscapeKey(onClose, !busy);

  // When a guardian approves, the backup arrives here — drop it into the backup
  // field and let the user finish with their password (the normal restore path).
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<RecoveryDelivery>).detail;
      if (!d) return;
      if (d.state !== undefined && !isEncryptedSyncBlob(d.state)) {
        setFriendStatus('error');
        setFriendError('Your friend sent an invalid account-state backup; nothing was imported.');
        return;
      }
      if (isEncryptedSyncBlob(d.state)) setDeliveredState(d.state);
      // A chunk set can complete before or after the smaller identity packet.
      // State-only completion must not erase an identity that already arrived.
      if (d.blob === undefined) return;
      setBackupText(JSON.stringify(d.blob));
      setFriendStatus('received');
      setFriendError(null);
    };
    window.addEventListener(RECOVERY_DELIVERED_EVENT, handler);
    return () => window.removeEventListener(RECOVERY_DELIVERED_EVENT, handler);
  }, []);

  const handleFriendRequest = async () => {
    if (busy || friendStatus === 'waiting') return;
    setFriendError(null);
    const guardian = guardianId.trim();
    const owner = ownerId.trim();
    if (!guardian || !owner) { setFriendError('Enter both your friend’s account ID and your own account ID.'); return; }
    if (!engine) { setFriendError('Still connecting — try again in a moment.'); return; }
    setFriendStatus('waiting');
    try {
      const res = await engine.requestRecovery(guardian, owner);
      if (res.pending || res.queued) {
        setFriendStatus('waiting');
      } else {
        setFriendStatus('error');
        setFriendError(res.error === 'no_custody' ? 'That friend doesn’t hold a backup for this account.' : 'Your friend couldn’t be reached. Check the ID and that they’re online.');
      }
    } catch {
      setFriendStatus('error');
      setFriendError('Could not reach your friend. Check the ID and that they’re online.');
    }
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.currentTarget.value = '';
    if (!file || busy) return;
    setError(null);
    if (file.size > MAX_IDENTITY_BACKUP_BYTES) {
      setError('That identity backup is too large.');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      const value = String(event.target?.result ?? '');
      if (!value.trim()) {
        setError('That backup file is empty.');
        return;
      }
      setBackupText(value);
    };
    reader.onerror = () => setError('Could not read that backup file. Try selecting it again.');
    reader.readAsText(file);
  };

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setError(null);
    const backup = backupText.trim();
    const name = displayName.trim();
    if (!backup) { setError('Paste your backup or upload the backup file.'); return; }
    if (new TextEncoder().encode(backup).length > MAX_IDENTITY_BACKUP_BYTES) {
      setError('That identity backup is too large.');
      return;
    }
    if (!passphrase.trim()) { setError('Enter the password for this backup.'); return; }
    if (!name) { setError('Choose a nickname to show for this account.'); return; }
    setBusy(true);
    try {
      // A v2 backup wraps the identity with an encrypted account-state snapshot:
      // { v:2, identity, state }. Unwrap it (importToVault wants the raw identity
      // blob) and keep the state in memory until identity validation succeeds.
      let identityJson = backup;
      let pendingState: EncryptedSyncBlob | undefined = deliveredState;
      let parsed: unknown;
      try {
        parsed = JSON.parse(backup) as unknown;
      } catch {
        parsed = undefined;
      }
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        && (parsed as { v?: unknown }).v === 2) {
        const wrapped = parsed as { identity?: unknown; state?: unknown };
        if (!wrapped.identity) {
          setError('That backup file is incomplete.');
          setBusy(false);
          return;
        }
        identityJson = JSON.stringify(wrapped.identity);
        if (wrapped.state !== undefined) {
          if (!isEncryptedSyncBlob(wrapped.state)) {
            setError('That backup contains invalid account-state data.');
            setBusy(false);
            return;
          }
          pendingState = wrapped.state;
        }
      }

      // Decrypts the blob (validates the password) and saves it to the vault, then
      // promotes it to the active identity. Use the passphrase exactly as entered.
      const entry = await importToVault(identityJson, passphrase);
      await activateFromVault(entry.peerId);

      // Persistence starts only after the encrypted identity has authenticated.
      if (pendingState) {
        try { localStorage.setItem(PENDING_STATE_KEY, JSON.stringify(pendingState)); } catch { /* best effort */ }
      }
      try {
        localStorage.setItem(NATIVE_STATE_KEY, JSON.stringify({
          identity: { peer_id: entry.peerId, id: entry.peerId, profile: { display_name: name } },
        }));
        sessionStorage.removeItem(NATIVE_STATE_KEY);
      } catch { /* best effort */ }

      // The engine provider needs this passphrase only to unlock the newly-active
      // encrypted vault entry. Do not expose it anywhere else.
      setPassphrase(passphrase);
      setBackupText('');
      setDeliveredState(undefined);
      onRestored();
    } catch {
      // Do not render raw crypto/storage diagnostics into the auth UI.
      setPassphraseInput('');
      setError('Could not restore this account. Check the backup and password, then try again.');
      setBusy(false);
    }
  };

  const formReady = Boolean(backupText.trim() && passphrase && displayName.trim());

  return (
    <div
      className="fixed inset-0 z-[200] bg-bg-0 flex items-center justify-center overflow-auto"
      role="dialog"
      aria-modal="true"
      aria-labelledby="restore-account-title"
      aria-busy={busy}
    >
      <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.08) 0%, transparent 60%)' }} />
      <div className="absolute inset-0 grid-overlay opacity-30" />

      <button
        type="button"
        onClick={onClose}
        disabled={busy}
        aria-label="Close"
        className="absolute top-5 right-5 z-20 p-2 rounded-full text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-all disabled:opacity-40 disabled:cursor-wait"
      >
        <X size={20} />
      </button>

      <div className="relative z-10 w-full max-w-[440px] mx-6 my-10">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-r2 bg-primary/10 border border-primary/20 mb-5 shadow-glow">
            <Shield size={28} className="text-primary" />
          </div>
          <h1 id="restore-account-title" className="text-display-l font-bold text-text-primary font-display tracking-tight">Restore from backup</h1>
          <p className="text-body text-text-secondary mt-2">Bring an account onto this device from its backup file.</p>
        </div>

        <form noValidate onSubmit={handleRestore} className="glass-card rounded-r3 p-8 border border-stroke space-y-5">
          {error && (
            <div role="alert" className="rounded-r2 border px-4 py-3 text-caption border-accent-danger/30 bg-accent-danger/10 text-accent-danger">
              {error}
            </div>
          )}

          <div className="space-y-2 rounded-r2 border border-primary/15 bg-primary/[0.04] p-4">
            <div className="flex items-center gap-2">
              <Users size={15} className="text-primary" />
              <span className="text-body-strong text-text-primary text-sm font-bold">Recover with a trusted friend</span>
            </div>
            <p className="text-[11px] text-text-tertiary leading-relaxed">
              If you set up recovery contacts, ask one of them to release your backup. They’ll get a prompt to approve — then it arrives here automatically.
            </p>
            {friendStatus === 'received' ? (
              <div className="flex items-center gap-2 text-caption text-accent-success" role="status"><Check size={14} /> Backup received — enter your password below to finish.</div>
            ) : (
              <>
                <input
                  type="text"
                  name="recovery-owner-id"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                  disabled={busy || friendStatus === 'waiting'}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Your account ID (the one you’re recovering)"
                  className="w-full h-11 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption font-mono placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors disabled:opacity-60"
                />
                <input
                  type="text"
                  name="recovery-guardian-id"
                  value={guardianId}
                  onChange={(e) => setGuardianId(e.target.value)}
                  disabled={busy || friendStatus === 'waiting'}
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="Your friend’s account ID (the guardian)"
                  className="w-full h-11 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption font-mono placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors disabled:opacity-60"
                />
                {friendError && <div role="alert" className="text-[11px] text-accent-danger">{friendError}</div>}
                <button
                  type="button"
                  onClick={() => void handleFriendRequest()}
                  disabled={busy || friendStatus === 'waiting' || !ownerId.trim() || !guardianId.trim()}
                  className="w-full h-11 rounded-full border border-primary/30 text-primary font-bold text-xs hover:bg-primary/10 transition-all disabled:opacity-60 flex items-center justify-center gap-2"
                >
                  {friendStatus === 'waiting'
                    ? <><Loader2 size={14} className="animate-spin" /> Waiting for your friend to approve…</>
                    : <>Send recovery request</>}
                </button>
              </>
            )}
          </div>

          <div className="flex items-center gap-3">
            <div className="flex-1 h-px bg-white/10" />
            <span className="micro-label text-text-tertiary">or use a backup file</span>
            <div className="flex-1 h-px bg-white/10" />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="restore-backup" className="micro-label text-text-tertiary">Encrypted backup</label>
            <textarea
              id="restore-backup"
              name="encrypted-backup"
              value={backupText}
              onChange={(e) => setBackupText(e.target.value)}
              rows={4}
              disabled={busy}
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="none"
              placeholder="Paste your backup here…"
              className="w-full px-5 py-4 rounded-r2 bg-surface-dark border border-stroke-subtle text-text-primary text-caption font-mono placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors resize-none disabled:opacity-60"
            />
            <label className={`flex items-center gap-3 px-1 py-2 rounded-r2 border border-dashed border-stroke transition-colors ${busy ? 'cursor-not-allowed opacity-50' : 'cursor-pointer hover:border-primary/40'}`}>
              <Upload size={16} className="text-primary flex-shrink-0" />
              <span className="text-caption text-text-secondary">Upload backup file</span>
              <input type="file" accept=".json,.txt,.bak,application/json,text/plain" disabled={busy} className="sr-only" onChange={handleFileUpload} />
            </label>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="restore-password" className="micro-label text-text-tertiary">Password</label>
            <input
              id="restore-password"
              name="current-password"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphraseInput(e.target.value)}
              disabled={busy}
              placeholder="The password used to create this backup"
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="w-full h-12 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors disabled:opacity-60"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="restore-nickname" className="micro-label text-text-tertiary">Nickname on this device</label>
            <input
              id="restore-nickname"
              name="nickname"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              disabled={busy}
              placeholder="e.g. Sam"
              maxLength={64}
              autoComplete="nickname"
              className="w-full h-12 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors disabled:opacity-60"
            />
          </div>

          <SecurityNote>
            Your backup and password together grant full access to this account. Anyone with both can sign in
            as you — keep them private.
          </SecurityNote>

          <button
            type="submit"
            disabled={busy || !formReady}
            className="w-full h-14 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all disabled:opacity-50"
          >
            {busy ? (
              <div className="w-5 h-5 border-2 border-bg-0/30 border-t-bg-0 rounded-full animate-spin" />
            ) : (
              <>
                <KeyRound size={18} />
                Restore account
                <ArrowRight size={18} />
              </>
            )}
          </button>

          <div className="flex items-center justify-between gap-3 text-caption text-text-tertiary">
            <button type="button" disabled={busy} onClick={onBack} className="inline-flex items-center gap-1 hover:text-text-secondary transition-colors disabled:opacity-40">
              <ArrowLeft size={13} /> Device accounts
            </button>
            <button type="button" disabled={busy} onClick={onCreate} className="text-primary hover:underline font-semibold disabled:opacity-40">
              Create a new account
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};