import React, { useState } from 'react';
import { ArrowRight, Shield, KeyRound, Lock, Eye, EyeOff, AlertTriangle, Loader2 } from 'lucide-react';
import { useNativeEngine } from '@/native/engine/provider';
import { useEnginePassphrase, resetLocalIdentity } from '@/lib/xoreinClientProvider';
import { hasValidSession, isRememberMeEnabled, setRememberMeEnabled } from '@/native/identity/storage';
import { SecurityNote } from '@/components/SecurityNote';
import { useEscapeKey } from '@/hooks/useEscapeKey';

/**
 * Shown when a registered (password-protected) identity is persisted on this
 * device but the engine is `locked` (no passphrase supplied this session).
 *
 * Two modes:
 *  - AUTO-UNLOCK: a valid session is persisted, so on reload the engine unlocks
 *    itself with NO password. We must clearly show "signing you in…" and disable
 *    the (irrelevant) password controls so the user doesn't think they're stuck.
 *  - MANUAL: no/expired session (or the user bailed out) — show the password form.
 *    Decryption happens in the native engine; a wrong password returns to `locked`
 *    with an error so the user can retry.
 */
export const UnlockScreen: React.FC = () => {
  const { state, error, activity } = useNativeEngine();
  const { setPassphrase } = useEnginePassphrase();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);
  // Captured once: if a valid session exists at mount the engine auto-unlocks
  // without any password. `forceManual` lets the user fall back to typing it.
  const [sessionAtMount] = useState(() => { try { return hasValidSession(); } catch { return false; } });
  const [forceManual, setForceManual] = useState(false);
  // Remember-me is OPT-IN (default off): while a session is active, the keys on
  // this device are readable without the password, so the user must choose it.
  // Prefill with the previously-recorded device preference.
  const [rememberMe, setRememberMe] = useState(() => { try { return isRememberMeEnabled(); } catch { return false; } });

  const engineWorking = state === 'starting' || state === 'connecting';
  // Auto-unlock in flight: a session existed, the engine is busy starting itself,
  // the user hasn't bailed to manual entry, and nothing has errored.
  const isAutoUnlocking = sessionAtMount && engineWorking && !forceManual && !error && !submitted;

  const busy = submitted && engineWorking;
  const activityHint = (submitted || isAutoUnlocking) && activity.phase !== 'idle' && activity.phase !== 'error'
    ? activity.message
    : '';

  // Allow Escape to dismiss the inline reset confirmation (matches overlay idiom).
  useEscapeKey(() => setConfirmReset(false), confirmReset);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    // Record the remember-me choice BEFORE the engine unlocks — the engine only
    // persists an unlock session when this opt-in is set; unchecking it also
    // destroys any previously-saved session.
    try { setRememberMeEnabled(rememberMe); } catch { /* best effort */ }
    setSubmitted(true);
    setPassphrase(password);
  };

  const handleReset = () => {
    setConfirmReset(false);
    void resetLocalIdentity();
  };

  return (
    <div className="fixed inset-0 z-[210] bg-bg-0 flex items-center justify-center overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.08) 0%, transparent 60%)' }} />
      <div className="absolute inset-0 grid-overlay opacity-30" />
      <div className="relative z-10 w-full max-w-[440px] mx-6">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-r2 bg-primary/10 border border-primary/20 mb-5 shadow-glow">
            <Shield size={28} className="text-primary" />
          </div>
          <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">Harmolyn</h1>
          <p className="text-body text-text-secondary mt-2">Private messaging that's yours.</p>
        </div>

        {isAutoUnlocking ? (
          /* ── Auto-unlock: clear "signing you in" state, no password controls ── */
          <div className="glass-card rounded-r3 p-8 border border-stroke text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-full bg-primary/10 border border-primary/20 mb-5">
              <Loader2 size={26} className="text-primary animate-spin" />
            </div>
            <h2 className="text-title font-semibold text-text-primary">Signing you in…</h2>
            <p className="text-caption text-text-secondary mt-2 min-h-[1.25rem]" role="status" aria-live="polite">
              {activityHint || 'Unlocking your encrypted identity on this device.'}
            </p>

            {/* The only enabled control while unlocking. */}
            <button
              type="button"
              onClick={() => setForceManual(true)}
              className="focus-ring mt-6 text-caption text-text-tertiary hover:text-text-primary font-semibold rounded-full px-3 py-1.5 border border-stroke-subtle hover:bg-bg-2 transition-colors"
            >
              Enter password manually instead
            </button>

            <div className="mt-5">
              <SecurityNote>
                Your keys stay encrypted on this device. We're decrypting them locally — nothing is sent anywhere.
              </SecurityNote>
            </div>
          </div>
        ) : (
          /* ── Manual unlock form ── */
          <form noValidate onSubmit={handleSubmit} className="glass-card rounded-r3 p-8 border border-stroke space-y-5">
            <div className="text-center mb-2">
              <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-primary/10 border border-primary/20 mb-3">
                <Lock size={20} className="text-primary" />
              </div>
              <h2 className="text-title font-semibold text-text-primary">Welcome back</h2>
              <p className="text-caption text-text-tertiary mt-1">Enter your password to unlock your account.</p>
            </div>

            {(submitted && error) && (
              <div role="alert" className="rounded-r2 border px-4 py-3 text-caption border-accent-danger/30 bg-accent-danger/10 text-accent-danger">
                {error}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="unlock-password" className="micro-label text-text-tertiary">PASSWORD</label>
              <div className="relative">
                <input
                  id="unlock-password"
                  type={showPassword ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Your identity password"
                  autoComplete="current-password"
                  autoFocus
                  disabled={busy}
                  className="w-full h-14 pl-5 pr-14 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                />
                <button
                  type="button"
                  onClick={() => setShowPassword((v) => !v)}
                  disabled={busy}
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  aria-pressed={showPassword}
                  className="focus-ring absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 flex items-center justify-center rounded-full text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

            <label className="flex items-start gap-3 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={busy}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
                aria-label="Keep me signed in on this device"
              />
              <span className="text-caption text-text-secondary leading-relaxed">
                <span className="font-semibold text-text-primary">Keep me signed in on this device.</span>{' '}
                Skips the password for up to 30 days — but while it's active, your keys are stored on this
                device in a form that someone with access to its files could read <em>without</em> your
                password. Leave this off on shared or unencrypted devices.
              </span>
            </label>

            <button
              type="submit"
              disabled={busy || !password}
              className="w-full h-14 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {busy ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Signing in…
                </>
              ) : (
                <>
                  <KeyRound size={18} />
                  Unlock
                  <ArrowRight size={18} />
                </>
              )}
            </button>

            {activityHint && (
              <p className="text-center text-caption text-text-secondary" role="status" aria-live="polite">{activityHint}</p>
            )}

            <SecurityNote>
              Your password never leaves this device and cannot be recovered. If you have forgotten it you can
              start over as a new guest — your previous identity stays encrypted and is only recoverable from a backup.
            </SecurityNote>

            {confirmReset ? (
              <div
                role="alertdialog"
                aria-modal="true"
                aria-labelledby="reset-confirm-title"
                aria-describedby="reset-confirm-body"
                className="rounded-r2 border border-accent-danger/30 bg-accent-danger/10 p-4 animate-in fade-in zoom-in-95 duration-200"
              >
                <div className="flex items-start gap-3">
                  <div className="shrink-0 w-9 h-9 rounded-full bg-accent-danger/15 flex items-center justify-center">
                    <AlertTriangle size={18} className="text-accent-danger" />
                  </div>
                  <div className="min-w-0">
                    <h3 id="reset-confirm-title" className="text-body-strong font-semibold text-text-primary">
                      Start over as a new guest?
                    </h3>
                    <p id="reset-confirm-body" className="text-caption text-text-secondary mt-1">
                      This deletes your local keys permanently. This device will forget the saved identity and
                      cannot recover it unless you have an encrypted backup.
                    </p>
                  </div>
                </div>
                <div className="flex justify-end gap-2 mt-4">
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="focus-ring px-4 py-2 text-caption text-text-secondary hover:text-text-primary transition-colors rounded-full border border-stroke-subtle hover:bg-bg-2"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    className="focus-ring px-5 py-2 bg-accent-danger text-white rounded-full text-caption font-bold shadow-glow-sm hover:brightness-110 transition-all"
                  >
                    Delete keys and start over
                  </button>
                </div>
              </div>
            ) : (
              <p className="text-center text-caption text-text-tertiary">
                <button
                  type="button"
                  onClick={() => setConfirmReset(true)}
                  className="focus-ring rounded-full px-1 text-text-tertiary hover:text-accent-danger font-semibold"
                >
                  Forgot password? Start over
                </button>
              </p>
            )}
          </form>
        )}
      </div>
    </div>
  );
};
