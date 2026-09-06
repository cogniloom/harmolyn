import React, { useState } from 'react';
import { ArrowRight, Shield, UserPlus, KeyRound, X } from 'lucide-react';
import { useCreateIdentity } from '@/hooks/runtime/mutations';
import { SecurityNote } from '@/components/SecurityNote';
import { LegalDocViewer } from '@/components/legal/LegalDocViewer';
import { AGE_REQUIREMENT_TEXT } from '@/components/legal/legalDocs';

interface RegisterScreenProps {
  /** Account created — hands back the new peer_id + nickname for the key reveal. */
  onCreated: (info: { peerId: string; displayName: string }) => void;
  /** Switch to using an account that already exists. */
  onSwitchToLogin: () => void;
  /** Optional close affordance (dismiss back to guest). */
  onClose?: () => void;
}

const MIN_PASSWORD_LENGTH = 12;

export const RegisterScreen: React.FC<RegisterScreenProps> = ({ onCreated, onSwitchToLogin, onClose }) => {
  const [displayName, setDisplayName] = useState('');
  const [bio, setBio] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [feedback, setFeedback] = useState<{ tone: 'error' | 'info'; message: string } | null>(null);
  const [consented, setConsented] = useState(false);
  const [openDoc, setOpenDoc] = useState<'terms' | 'privacy' | 'guidelines' | null>(null);
  const createMutation = useCreateIdentity();
  const pending = createMutation.isPending;
  const passwordsMatch = Boolean(confirmPassword) && password === confirmPassword;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (pending) return;
    setFeedback(null);
    const name = displayName.trim();
    if (!name) {
      setFeedback({ tone: 'error', message: 'A display name is required to create your identity.' });
      return;
    }
    if (!consented) {
      setFeedback({ tone: 'error', message: 'Please confirm your age and agree to the Terms and Community Guidelines to continue.' });
      return;
    }
    if (password.length < MIN_PASSWORD_LENGTH) {
      setFeedback({ tone: 'error', message: `Choose a password of at least ${MIN_PASSWORD_LENGTH} characters — it encrypts your account on this device.` });
      return;
    }
    if (password !== confirmPassword) {
      setFeedback({ tone: 'error', message: 'The two passwords do not match.' });
      return;
    }
    try {
      const result = await createMutation.mutateAsync({ displayName: name, bio: bio.trim() || undefined, passphrase: password });
      const peerId = (result as { peer_id?: string })?.peer_id ?? '';
      // Do not retain password material in React state after the crypto operation
      // has completed. The provider owns the encrypted identity from here.
      setPassword('');
      setConfirmPassword('');
      onCreated({ peerId, displayName: name });
    } catch {
      // Creation crosses crypto/storage/native boundaries; raw errors can contain
      // implementation details and should not be rendered into the UI.
      setFeedback({ tone: 'error', message: 'Could not create your account. Nothing was published; try again.' });
    }
  };

  return (
    <div className="fixed inset-0 z-[200] bg-bg-0 flex items-center justify-center overflow-auto" aria-busy={pending}>
      <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
      <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.08) 0%, transparent 60%)' }} />
      <div className="absolute inset-0 grid-overlay opacity-30" />

      {onClose && (
        <button
          type="button"
          onClick={onClose}
          disabled={pending}
          aria-label="Close"
          className="absolute top-5 right-5 z-20 p-2 rounded-full text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-all disabled:opacity-40 disabled:cursor-wait"
        >
          <X size={20} />
        </button>
      )}

      <div className="relative z-10 w-full max-w-[440px] mx-6 my-10">
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-r2 bg-primary/10 border border-primary/20 mb-4 shadow-glow">
            <Shield size={24} className="text-primary" />
          </div>
          <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">Create your account</h1>
          <p className="text-body text-text-secondary mt-2">Pick a name and a password — that’s it.</p>
        </div>

        <form noValidate onSubmit={handleSubmit} className="glass-card rounded-r3 p-8 border border-stroke space-y-5">
          <div className="text-center mb-2">
            <p className="text-caption text-text-tertiary mt-1">
              We’ll create a secure account that lives on this device.
            </p>
          </div>

          {feedback && (
            <div
              role="alert"
              className={`rounded-r2 border px-4 py-3 text-caption ${feedback.tone === 'error' ? 'border-accent-danger/30 bg-accent-danger/10 text-accent-danger' : 'border-primary/30 bg-primary/10 text-primary'}`}
            >
              {feedback.message}
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="register-display-name" className="micro-label text-text-tertiary">NICKNAME</label>
            <input
              id="register-display-name"
              name="name"
              type="text"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="e.g. Sam"
              maxLength={64}
              autoComplete="nickname"
              disabled={pending}
              className="w-full h-14 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors disabled:opacity-60"
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="register-password" className="micro-label text-text-tertiary">PASSWORD</label>
            <input
              id="register-password"
              name="new-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={`At least ${MIN_PASSWORD_LENGTH} characters`}
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={pending}
              aria-describedby="register-password-help"
              className="w-full h-14 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors disabled:opacity-60"
            />
            <p id="register-password-help" className="px-1 text-[10px] text-text-disabled">
              Use {MIN_PASSWORD_LENGTH}+ characters. A long, unique passphrase is easier to remember and harder to guess.
            </p>
          </div>

          <div className="space-y-1.5">
            <label htmlFor="register-confirm-password" className="micro-label text-text-tertiary">CONFIRM PASSWORD</label>
            <input
              id="register-confirm-password"
              name="confirm-password"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Re-enter your password"
              autoComplete="new-password"
              minLength={MIN_PASSWORD_LENGTH}
              required
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              disabled={pending}
              aria-invalid={Boolean(confirmPassword) && !passwordsMatch}
              className={`w-full h-14 px-5 rounded-full bg-surface-dark border text-text-primary text-body placeholder:text-text-disabled focus:outline-none transition-colors disabled:opacity-60 ${
                confirmPassword && !passwordsMatch ? 'border-accent-danger/60 focus:border-accent-danger' : passwordsMatch ? 'border-accent-success/40 focus:border-accent-success' : 'border-stroke-subtle focus:border-stroke-primary'
              }`}
            />
            {confirmPassword && (
              <p className={`px-1 text-[10px] ${passwordsMatch ? 'text-accent-success' : 'text-accent-danger'}`} aria-live="polite">
                {passwordsMatch ? 'Passwords match.' : 'Passwords do not match yet.'}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label htmlFor="register-bio" className="micro-label text-text-tertiary">BIO <span className="text-text-disabled">(OPTIONAL)</span></label>
            <textarea
              id="register-bio"
              name="bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              rows={3}
              placeholder="A short description about yourself…"
              maxLength={200}
              disabled={pending}
              className="w-full px-5 py-3 rounded-r2 bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors resize-none disabled:opacity-60"
            />
          </div>

          <SecurityNote tone="caution" icon={<KeyRound size={13} />}>
            Your password encrypts this account on this device. It's needed every time you return, and it
            can't be reset or recovered — there's no server that holds it. We'll help you save a backup on
            the next step.
          </SecurityNote>

          <label className="flex items-start gap-3 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={consented}
              onChange={(e) => setConsented(e.target.checked)}
              disabled={pending}
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary disabled:opacity-60"
              aria-label="Confirm age and agree to the Terms and Community Guidelines"
            />
            <span className="text-caption text-text-secondary leading-relaxed">
              {AGE_REQUIREMENT_TEXT} I agree to the{' '}
              <button type="button" disabled={pending} onClick={() => setOpenDoc('terms')} className="text-primary hover:underline font-semibold disabled:opacity-50">Terms of Service</button>,{' '}
              <button type="button" disabled={pending} onClick={() => setOpenDoc('privacy')} className="text-primary hover:underline font-semibold disabled:opacity-50">Privacy Policy</button>, and{' '}
              <button type="button" disabled={pending} onClick={() => setOpenDoc('guidelines')} className="text-primary hover:underline font-semibold disabled:opacity-50">Community Guidelines</button>.
            </span>
          </label>

          {openDoc && <LegalDocViewer docId={openDoc} onClose={() => setOpenDoc(null)} />}

          <button
            type="submit"
            disabled={pending || !consented || password.length < MIN_PASSWORD_LENGTH || password !== confirmPassword || !displayName.trim()}
            className="w-full h-14 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all disabled:opacity-40 mt-2"
          >
            {pending ? (
              <div className="w-5 h-5 border-2 border-bg-0/30 border-t-bg-0 rounded-full animate-spin" />
            ) : (
              <>
                <UserPlus size={18} />
                Create account
                <ArrowRight size={18} />
              </>
            )}
          </button>

          <p className="text-center text-caption text-text-tertiary mt-3">
            Already have an account?{' '}
            <button type="button" disabled={pending} onClick={onSwitchToLogin} className="text-primary hover:underline font-semibold disabled:opacity-50">
              Sign in
            </button>
          </p>
        </form>
      </div>
    </div>
  );
};