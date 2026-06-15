import React, { useEffect, useState } from 'react';
import { Shield, UserCheck, ArrowRight, Upload, UserPlus, X, RefreshCw } from 'lucide-react';
import { listVaultIdentities, type VaultEntry } from '@/native/identity/storage';
import { unlockAndActivateVaultIdentity } from '@/lib/identitySwitch';
import { resolveAvatarSrc } from '@/lib/avatar';
import { shortFingerprint } from '@/lib/peerLabel';
import { SwitchingOverlay } from '@/components/SwitchingOverlay';

interface IdentityPickerProps {
  /** Switch to the "restore from backup file" step. */
  onRestore: () => void;
  /** Switch to the create-account step. */
  onCreate: () => void;
  /** Dismiss the auth flow. */
  onClose: () => void;
}

/**
 * Returning-user surface: lists the accounts saved on this device (the vault) and
 * unlocks the chosen one with its password. Switching reloads the app so the
 * native engine starts with the selected identity. Restoring from a backup file
 * lives one tap away for accounts not yet on this device.
 */
function formatVaultDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  } catch {
    return '';
  }
}

export const IdentityPicker: React.FC<IdentityPickerProps> = ({ onRestore, onCreate, onClose }) => {
  const [entries, setEntries] = useState<VaultEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let mounted = true;
    listVaultIdentities()
      .then((list) => { if (mounted) setEntries(list); })
      .catch(() => { if (mounted) setEntries([]); })
      .finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, []);

  const handleUnlock = async (entry: VaultEntry) => {
    setError(null);
    setBusy(true);
    try {
      // Validates the passphrase, activates the entry, then reloads on success.
      // The overlay is shown only after a successful unlock, right before reload.
      await unlockAndActivateVaultIdentity(entry, passphrase, () => setSwitching(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wrong password or corrupt account.');
      setBusy(false);
    }
  };

  const hasEntries = entries.length > 0;

  if (switching) return <SwitchingOverlay />;

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
          <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">Choose an account</h1>
          <p className="text-body text-text-secondary mt-2">Sign in with an account saved on this device.</p>
        </div>

        <div className="glass-card rounded-r3 p-8 border border-stroke space-y-4">
          {loading ? (
            <div className="flex items-center justify-center gap-2 text-text-tertiary text-caption py-6">
              <RefreshCw size={14} className="animate-spin" />
              Loading your accounts…
            </div>
          ) : hasEntries ? (
            <div className="space-y-3">
              {entries.map((entry) => (
                <div key={entry.peerId} className="rounded-r2 border border-stroke bg-surface-dark/60 p-3 space-y-3">
                  <div className="flex items-center gap-3 min-w-0">
                    <img
                      src={resolveAvatarSrc(undefined, entry.displayName || entry.peerId)}
                      alt=""
                      className="w-9 h-9 rounded-full border border-stroke flex-shrink-0"
                    />
                    <div className="min-w-0 flex-1">
                      <div className="text-body-strong text-text-primary truncate">{entry.displayName || 'Unnamed account'}</div>
                      <div className="text-[10px] text-text-tertiary font-mono truncate">{shortFingerprint(entry.peerId)}</div>
                      {entry.createdAt && (
                        <div className="text-[9px] text-text-disabled mt-0.5">{formatVaultDate(entry.createdAt)}</div>
                      )}
                    </div>
                    {openFor !== entry.peerId && (
                      <UserCheck size={16} className="text-text-tertiary flex-shrink-0" />
                    )}
                  </div>

                  {openFor === entry.peerId ? (
                    <div className="space-y-2">
                      <input
                        type="password"
                        value={passphrase}
                        autoFocus
                        onChange={(e) => setPassphrase(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void handleUnlock(entry);
                          if (e.key === 'Escape') { setOpenFor(null); setPassphrase(''); setError(null); }
                        }}
                        placeholder="Password for this account"
                        autoComplete="current-password"
                        className="w-full h-11 px-4 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-caption placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
                      />
                      {error && <p role="alert" className="text-caption text-accent-danger px-1">{error}</p>}
                      <div className="flex gap-2">
                        <button
                          type="button"
                          onClick={() => void handleUnlock(entry)}
                          disabled={busy || !passphrase}
                          className="flex-1 h-11 rounded-full bg-primary text-bg-0 font-bold text-caption flex items-center justify-center gap-1.5 hover:shadow-glow transition-all disabled:opacity-50"
                        >
                          {busy ? <div className="w-4 h-4 border-2 border-bg-0/30 border-t-bg-0 rounded-full animate-spin" /> : <>Sign in<ArrowRight size={15} /></>}
                        </button>
                        <button
                          type="button"
                          onClick={() => { setOpenFor(null); setPassphrase(''); setError(null); }}
                          className="px-4 h-11 rounded-full bg-white/5 text-text-tertiary text-caption hover:bg-white/10 transition-all"
                        >
                          Cancel
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => { setOpenFor(entry.peerId); setPassphrase(''); setError(null); }}
                      className="w-full h-10 rounded-full bg-white/5 border border-stroke text-text-secondary font-semibold text-caption hover:border-stroke-primary hover:text-primary transition-all"
                    >
                      Sign in
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <p className="text-caption text-text-tertiary text-center py-4">
              No accounts are saved on this device yet. Restore one from a backup, or create a new account.
            </p>
          )}

          <div className="space-y-2 pt-2 border-t border-stroke">
            <button
              type="button"
              onClick={onRestore}
              className="w-full h-12 rounded-full bg-surface-dark border border-stroke text-text-primary font-semibold text-caption flex items-center justify-center gap-2 hover:border-stroke-primary transition-all"
            >
              <Upload size={15} />
              Restore from a backup file
            </button>
            <button
              type="button"
              onClick={onCreate}
              className="w-full text-center text-caption text-text-tertiary hover:text-primary transition-colors py-1 flex items-center justify-center gap-1.5"
            >
              <UserPlus size={14} />
              Create a new account
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
