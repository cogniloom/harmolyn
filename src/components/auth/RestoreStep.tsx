import React, { useState, useEffect } from 'react';
import { Shield, Upload, KeyRound, ArrowRight, ArrowLeft, X, Users, Loader2, Check } from 'lucide-react';
import { importToVault, activateFromVault } from '@/native/identity/storage';
import { useEnginePassphrase } from '@/lib/xoreinClientProvider';
import { useNativeEngine } from '@/native/engine/provider';
import { RECOVERY_DELIVERED_EVENT, type RecoveryDelivery } from '@/native/recovery/recovery';
import { PENDING_STATE_KEY } from '@/native/state/stateSync';
import { SecurityNote } from '@/components/SecurityNote';

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

  // When a guardian approves, the backup arrives here — drop it into the backup
  // field and let the user finish with their password (the normal restore path).
  useEffect(() => {
    const handler = (e: Event) => {
      const d = (e as CustomEvent<RecoveryDelivery>).detail;
      if (!d?.blob) return;
      setBackupText(JSON.stringify(d.blob));
      // Stash the encrypted account-state snapshot (servers/DMs/profile). The
      // engine decrypts + applies it on start once the identity is recovered.
      try {
        if (d.state) localStorage.setItem(PENDING_STATE_KEY, JSON.stringify(d.state));
      } catch { /* non-fatal */ }
      setFriendStatus('received');
    };
    window.addEventListener(RECOVERY_DELIVERED_EVENT, handler);
    return () => window.removeEventListener(RECOVERY_DELIVERED_EVENT, handler);
  }, []);

  const handleFriendRequest = async () => {
    setFriendError(null);
    const guardian = guardianId.trim();
    const owner = ownerId.trim();
    if (!guardian || !owner) { setFriendError('Enter both your friend’s account ID and your own account ID.'); return; }
    if (!engine) { setFriendError('Still connecting — try again in a moment.'); return; }
    setFriendStatus('waiting');
    try {
      const res = await engine.requestRecovery(guardian, owner);
      if (res.pending) {
        setFriendStatus('waiting'); // waiting for the friend's manual approval
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
    if (!file) return;
    const reader = new FileReader();
    reader.onload = (event) => setBackupText(String(event.target?.result ?? ''));
    reader.readAsText(file);
  };

  const handleRestore = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const backup = backupText.trim();
    const name = displayName.trim();
    if (!backup) { setError('Paste your backup or upload the backup file.'); return; }
    if (!passphrase.trim()) { setError('Enter the password for this backup.'); return; }
    if (!name) { setError('Choose a nickname to show for this account.'); return; }
    setBusy(true);
    try {
      // A v2 backup wraps the identity with an encrypted account-state snapshot:
      // { v:2, identity, state }. Unwrap it (importToVault wants the raw identity
      // blob) and stash the state so the engine restores servers/DMs/profile on
      // start. A raw identity blob (older backups / friend delivery) is used as-is.
      let identityJson = backup;
      try {
        const parsed = JSON.parse(backup) as { v?: number; identity?: unknown; state?: unknown };
        if (parsed && parsed.v === 2 && parsed.identity) {
          identityJson = JSON.stringify(parsed.identity);
          if (parsed.state) localStorage.setItem(PENDING_STATE_KEY, JSON.stringify(parsed.state));
        }
      } catch { /* not JSON-wrapped — treat as a raw identity blob */ }
      // Decrypts the blob (validates the password) and saves it to the vault, then
      // promotes it to the active 'local' identity. Throws on a wrong password.
      // Use passphrase exactly as entered — trimming would break accounts whose
      // password legitimately contains leading/trailing whitespace.
      const entry = await importToVault(identityJson, passphrase);
      await activateFromVault(entry.peerId);
      // The backup carries no nickname — seed the chosen one so the engine restores
      // it and the "guest" banner stays gone after the engine picks the identity up.
      try {
        localStorage.setItem(NATIVE_STATE_KEY, JSON.stringify({
          identity: { peer_id: entry.peerId, id: entry.peerId, profile: { display_name: name } },
        }));
        sessionStorage.removeItem(NATIVE_STATE_KEY);
      } catch { /* best effort */ }
      // Restart the engine with this identity (the provider re-runs on a new
      // passphrase and decrypts the now-active blob) — no page reload needed.
      setPassphrase(passphrase);
      onRestored();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not restore — check the file and password.');
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-bg-0 flex items-center justify-center overflow-auto">
      <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.08) 0%, transparent 60%)' }} />
      <div className="absolute inset-0 grid-overlay opacity-30" />

      <button
        type="button"
        onClick={onClose}
        aria-label="Close"
        className="absolute top-5 right-5 z-20 p-2 rounded-full text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-all"
      >
        <X size={20} />
      </button>

      <div className="relative z-10 w-full max-w-[440px] mx-6 my-10">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-r2 bg-primary/10 border border-primary/20 mb-5 shadow-glow">
            <Shield size={28} className="text-primary" />
          </div>
          <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">Restore from backup</h1>
          <p className="text-body text-text-secondary mt-2">Bring an account onto this device from its backup file.</p>
        </div>

        <form noValidate onSubmit={handleRestore} className="glass-card rounded-r3 p-8 border border-stroke space-y-5">
          {error && (
            <div role="alert" className="rounded-r2 border px-4 py-3 text-caption border-accent-danger/30 bg-accent-danger/10 text-accent-danger">
              {error}
            </div>
          )}

          {/* Recover with a trusted friend (no file needed) */}
          <div className="space-y-2 rounded-r2 border border-primary/15 bg-primary/[0.04] p-4">
            <div className="flex items-center gap-2">
              <Users size={15} className="text-primary" />
              <span className="text-body-strong text-text-primary text-sm font-bold">Recover with a trusted friend</span>
            </div>
            <p className="text-[11px] text-text-tertiary leading-relaxed">
              If you set up recovery contacts, ask one of them to release your backup. They’ll get a prompt to approve — then it arrives here automatically.
            </p>
            {friendStatus === 'received' ? (
              <div className="flex items-center gap-2 text-caption text-accent-success"><Check size={14} /> Backup received — enter your password below to finish.</div>
            ) : (
              <>
                <input
                  type="text"
                  value={ownerId}
                  onChange={(e) => setOwnerId(e.target.value)}
                  placeholder="Your account ID (the one you’re recovering)"
                  className="w-full h-11 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption font-mono placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
                />
                <input
                  type="text"
                  value={guardianId}
                  onChange={(e) => setGuardianId(e.target.value)}
                  placeholder="Your friend’s account ID (the guardian)"
                  className="w-full h-11 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption font-mono placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
                />
                {friendError && <div className="text-[11px] text-accent-danger">{friendError}</div>}
                <button
                  type="button"
                  onClick={() => void handleFriendRequest()}
                  disabled={friendStatus === 'waiting'}
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
            <label className="micro-label text-text-tertiary">Encrypted backup</label>
            <textarea
              value={backupText}
              onChange={(e) => setBackupText(e.target.value)}
              rows={4}
              placeholder="Paste your backup here…"
              className="w-full px-5 py-4 rounded-r2 bg-surface-dark border border-stroke-subtle text-text-primary text-caption font-mono placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors resize-none"
            />
            <label className="flex items-center gap-3 cursor-pointer px-1 py-2 rounded-r2 border border-dashed border-stroke hover:border-primary/40 transition-colors">
              <Upload size={16} className="text-primary flex-shrink-0" />
              <span className="text-caption text-text-secondary">Upload backup file</span>
              <input type="file" accept=".json,.txt,.bak" className="sr-only" onChange={handleFileUpload} />
            </label>
          </div>

          <div className="space-y-1.5">
            <label className="micro-label text-text-tertiary">Password</label>
            <input
              type="password"
              value={passphrase}
              onChange={(e) => setPassphraseInput(e.target.value)}
              placeholder="The password used to create this backup"
              autoComplete="current-password"
              className="w-full h-12 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label className="micro-label text-text-tertiary">Nickname on this device</label>
            <input
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Sam"
              maxLength={64}
              className="w-full h-12 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
            />
          </div>

          <SecurityNote>
            Your backup and password together grant full access to this account. Anyone with both can sign in
            as you — keep them private.
          </SecurityNote>

          <button
            type="submit"
            disabled={busy}
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

          <div className="flex items-center justify-between text-caption text-text-tertiary">
            <button type="button" onClick={onBack} className="inline-flex items-center gap-1 hover:text-text-secondary transition-colors">
              <ArrowLeft size={13} /> Device accounts
            </button>
            <button type="button" onClick={onCreate} className="text-primary hover:underline font-semibold">
              Create a new account
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
