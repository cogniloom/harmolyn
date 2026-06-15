import React, { useState } from 'react';
import { Plus, Check, LogOut, ArrowRight } from 'lucide-react';
import { resolveAvatarSrc } from '@/lib/avatar';
import { shortFingerprint } from '@/lib/peerLabel';
import { unlockAndActivateVaultIdentity } from '@/lib/identitySwitch';
import { SwitchingOverlay } from '@/components/SwitchingOverlay';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import type { VaultEntry } from '@/native/identity/storage';

interface AccountSwitcherProps {
  /** Accounts saved on this device (from the identity vault). */
  entries: VaultEntry[];
  /** peer_id of the currently active identity (so it's marked, not switchable). */
  activePeerId: string;
  /** Add / sign into another account (opens the auth flow). */
  onAdd: () => void;
  /** Log out — forget the active identity and return to a fresh guest. */
  onLogout: () => void;
  onClose: () => void;
}

/**
 * Popover for the always-visible identity footer: lists the accounts saved on this
 * device and switches between them (each needs its password, since the private key
 * is encrypted). Switching reloads the app so the engine adopts the new identity.
 */
export const AccountSwitcher: React.FC<AccountSwitcherProps> = ({ entries, activePeerId, onAdd, onLogout, onClose }) => {
  const [openFor, setOpenFor] = useState<string | null>(null);
  const [passphrase, setPassphrase] = useState('');
  const [busy, setBusy] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEscapeKey(onClose);

  const handleUnlock = async (entry: VaultEntry) => {
    setError(null);
    setBusy(true);
    try {
      await unlockAndActivateVaultIdentity(entry, passphrase, () => setSwitching(true));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Wrong password for this account.');
      setBusy(false);
    }
  };

  if (switching) return <SwitchingOverlay />;

  return (
    <>
      <div className="fixed inset-0 z-[70]" onClick={onClose} />
      <div className="absolute bottom-full left-0 right-0 mb-2 z-[80] glass-card rounded-r2 border border-stroke p-2 space-y-1 animate-in slide-in-from-bottom-2 fade-in duration-200 max-h-[60vh] overflow-y-auto">
        <div className="micro-label text-text-tertiary px-3 py-1.5">Your accounts</div>

        {entries.length === 0 ? (
          <p className="text-[10px] text-text-tertiary px-3 py-1.5 leading-relaxed">No other accounts saved on this device.</p>
        ) : (
          entries.map((entry) => {
            const active = entry.peerId === activePeerId;
            return (
              <div
                key={entry.peerId}
                aria-current={active ? 'true' : undefined}
                className={`rounded-r1 ${active ? 'bg-primary/10 border border-primary/40 shadow-glow-sm' : 'border border-transparent'} ${openFor === entry.peerId ? 'p-2 space-y-2' : ''}`}
              >
                <div className="w-full flex items-center gap-2.5 px-3 py-2">
                  <img src={resolveAvatarSrc(undefined, entry.displayName || entry.peerId)} className={`w-7 h-7 rounded-full flex-shrink-0 ${active ? 'border-2 border-primary' : 'border border-stroke'}`} alt="" />
                  <div className="flex-1 min-w-0 text-left">
                    <div className="text-xs font-bold truncate text-text-primary">{entry.displayName || 'Unnamed account'}</div>
                    <div className="text-[8px] font-mono text-text-disabled truncate">{shortFingerprint(entry.peerId)}</div>
                  </div>
                  {active ? (
                    <span className="flex items-center gap-1 flex-shrink-0 text-[9px] font-bold uppercase tracking-wider text-primary">
                      <Check size={12} aria-hidden="true" />
                      Active
                    </span>
                  ) : openFor !== entry.peerId ? (
                    <button
                      onClick={() => { setOpenFor(entry.peerId); setPassphrase(''); setError(null); }}
                      className="text-[10px] font-bold text-text-tertiary hover:text-primary transition-colors flex-shrink-0"
                    >
                      Switch
                    </button>
                  ) : null}
                </div>

                {openFor === entry.peerId && !active && (
                  <div className="space-y-2 px-1">
                    <input
                      type="password"
                      value={passphrase}
                      autoFocus
                      onChange={(e) => setPassphrase(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void handleUnlock(entry);
                        if (e.key === 'Escape') { setOpenFor(null); setPassphrase(''); setError(null); }
                      }}
                      placeholder="Password"
                      autoComplete="current-password"
                      className="w-full h-9 px-3 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-[11px] placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors"
                    />
                    {error && <p role="alert" className="text-[10px] text-accent-danger px-1">{error}</p>}
                    <button
                      onClick={() => void handleUnlock(entry)}
                      disabled={busy || !passphrase}
                      className="w-full h-9 rounded-full bg-primary text-bg-0 font-bold text-[11px] flex items-center justify-center gap-1.5 hover:shadow-glow transition-all disabled:opacity-50"
                    >
                      {busy ? <div className="w-3.5 h-3.5 border-2 border-bg-0/30 border-t-bg-0 rounded-full animate-spin" /> : <>Switch &amp; reload<ArrowRight size={13} /></>}
                    </button>
                  </div>
                )}
              </div>
            );
          })
        )}

        <div className="h-px bg-stroke-subtle mx-2 my-1" />

        <button
          onClick={onAdd}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-r1 text-text-secondary hover:bg-white/5 hover:text-primary transition-all border border-transparent"
        >
          <div className="w-7 h-7 rounded-full border border-dashed border-stroke-strong flex items-center justify-center">
            <Plus size={14} />
          </div>
          <span className="text-xs font-bold">Add another account</span>
        </button>

        <button
          onClick={onLogout}
          className="w-full flex items-center gap-2.5 px-3 py-2 rounded-r1 text-accent-danger hover:bg-accent-danger/10 transition-all border border-transparent"
        >
          <LogOut size={14} />
          <span className="text-xs font-bold">Log out</span>
        </button>
      </div>
    </>
  );
};
