import React, { useState } from 'react';
import { ArrowRight, Shield, KeyRound, Lock, Eye, EyeOff, AlertTriangle, Loader2 } from 'lucide-react';
import { useNativeEngine } from '@/native/engine/provider';
import { useEnginePassphrase, resetLocalIdentity } from '@/lib/xoreinClientProvider';
import { SecurityNote } from '@/components/SecurityNote';
import { useEscapeKey } from '@/hooks/useEscapeKey';

/**
 * Shown when a registered (password-protected) identity is persisted on this
 * device but the engine is `locked` (no passphrase supplied this session).
 *
 * The password is always required after reload. Identity keys are never restored
 * from browser storage without a password.
 */
export const UnlockScreen: React.FC = () => {
  const { state, error, activity } = useNativeEngine();
  const { setPassphrase } = useEnginePassphrase();
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [confirmReset, setConfirmReset] = useState(false);

  const engineWorking = state === 'starting' || state === 'connecting';
  const busy = submitted && engineWorking;
  const activityHint = submitted && activity.phase !== 'idle' && activity.phase !== 'error'
    ? activity.message
    : '';

  // Allow Escape to dismiss the inline reset confirmation (matches overlay idiom).
  useEscapeKey(() => setConfirmReset(false), confirmReset);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!password) return;
    setSubmitted(true);
    setPassphrase(password);
  };

  const handleReset = () => {
    setConfirmReset(false);
    void resetLocalIdentity();
  };

  return (
    <div className="responsive-overlay-scroll fixed inset-0 z-[210] bg-bg-0">
      <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.08) 0%, transparent 60%)' }} />
      <div className="absolute inset-0 grid-overlay opacity-30" />
      <div className="relative z-10 flex min-h-full w-full">
       <div className="m-auto w-full max-w-[440px]">
        <div className="text-center mb-6 sm:mb-10">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-r2 bg-primary/10 border border-primary/20 mb-5 shadow-glow">
            <Shield size={28} className="text-primary" />
          </div>
          <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">Harmolyn</h1>
          <p className="text-body text-text-secondary mt-2">Private messaging that's yours.</p>
        </div>

        <form noValidate onSubmit={handleSubmit} className="glass-card rounded-r3 border border-stroke p-5 space-y-5 sm:p-8">
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
                  className="touch-target focus-ring absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center rounded-full text-text-tertiary hover:text-text-primary transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {showPassword ? <EyeOff size={18} /> : <Eye size={18} />}
                </button>
              </div>
            </div>

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
                <div className="mt-4 flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
                  <button
                    type="button"
                    onClick={() => setConfirmReset(false)}
                    className="touch-target focus-ring w-full px-4 py-2 text-caption text-text-secondary hover:text-text-primary transition-colors rounded-full border border-stroke-subtle hover:bg-bg-2 sm:w-auto"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={handleReset}
                    className="touch-target focus-ring w-full px-5 py-2 bg-accent-danger text-white rounded-full text-caption font-bold shadow-glow-sm hover:brightness-110 transition-all sm:w-auto"
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
                  className="touch-target focus-ring inline-flex items-center justify-center rounded-full px-2 text-text-tertiary hover:text-accent-danger font-semibold"
                >
                  Forgot password? Start over
                </button>
              </p>
            )}
        </form>
       </div>
      </div>
    </div>
  );
};
