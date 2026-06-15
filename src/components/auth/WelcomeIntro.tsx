import React from 'react';
import { Shield, Network, Lock, KeyRound, UserPlus, ArrowRight, X } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface WelcomeIntroProps {
  /** Start creating a new account. */
  onCreate: () => void;
  /** Use an account that already exists (device picker / restore from backup). */
  onRestore: () => void;
  /** Dismiss and keep looking around as a read-only guest. */
  onGuest: () => void;
  /** Open the deeper "how security works" primer. */
  onLearnMore: () => void;
}

const POINTS: { icon: React.ReactNode; title: string; body: string }[] = [
  {
    icon: <Network size={16} className="text-primary" />,
    title: 'Peer-to-peer',
    body: 'Messages flow directly between people over the xorein network — not through a company’s servers.',
  },
  {
    icon: <Lock size={16} className="text-primary" />,
    title: 'End-to-end encrypted',
    body: 'Only the people in a conversation can read it. Every surface shows exactly which protection is in use.',
  },
  {
    icon: <KeyRound size={16} className="text-primary" />,
    title: 'You own your identity',
    body: 'Your account is a key kept on this device — not an email and password held on someone else’s server.',
  },
];

/**
 * Friendly first-contact screen. Replaces the heavy security primer as the very
 * first thing a new visitor sees: a plain-language intro to Harmolyn + xorein and
 * three clear choices — create an account, use an existing one, or just look around.
 */
export const WelcomeIntro: React.FC<WelcomeIntroProps> = ({ onCreate, onRestore, onGuest, onLearnMore }) => {
  // Escape dismisses the welcome screen the same way the close button does:
  // keyboard users get the same "browse as a guest" escape hatch as mouse users.
  useEscapeKey(onGuest);

  return (
  <div className="fixed inset-0 z-[200] bg-bg-0 flex items-center justify-center overflow-auto">
    <div className="absolute inset-0 bg-gradient-to-b from-bg-0 via-bg-2 to-bg-0" />
    <div className="absolute inset-0" style={{ background: 'radial-gradient(circle at 50% 0%, rgba(19,221,236,0.08) 0%, transparent 60%)' }} />
    <div className="absolute inset-0 grid-overlay opacity-30" />

    <button
      type="button"
      onClick={onGuest}
      aria-label="Close and browse as a guest"
      className="absolute top-3 right-3 z-20 w-11 h-11 flex items-center justify-center rounded-full text-text-tertiary hover:text-text-primary hover:bg-white/5 transition-all focus-ring"
    >
      <X size={20} />
    </button>

    <div className="relative z-10 w-full max-w-[460px] mx-6 my-10">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-r2 bg-primary/10 border border-primary/20 mb-5 shadow-glow">
          <Shield size={28} className="text-primary" />
        </div>
        <h1 className="text-display-l font-bold text-text-primary font-display tracking-tight">Welcome to Harmolyn</h1>
        <p className="text-body text-text-secondary mt-2">Private, peer-to-peer chat that you actually own.</p>
      </div>

      <div className="glass-card rounded-r3 p-8 border border-stroke space-y-6">
        <div className="space-y-4">
          {POINTS.map((p) => (
            <div key={p.title} className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-r2 bg-primary/10 border border-primary/15 flex items-center justify-center flex-shrink-0">
                {p.icon}
              </div>
              <div>
                <div className="text-body-strong text-text-primary">{p.title}</div>
                <p className="text-caption text-text-tertiary leading-relaxed mt-0.5">{p.body}</p>
              </div>
            </div>
          ))}
        </div>

        <div className="space-y-3 pt-1">
          <button
            type="button"
            onClick={onCreate}
            autoFocus
            className="w-full h-14 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center justify-center gap-2 hover:shadow-glow transition-all btn-press focus-ring"
          >
            <UserPlus size={18} />
            Create an account
            <ArrowRight size={18} />
          </button>
          <button
            type="button"
            onClick={onRestore}
            className="w-full h-12 rounded-full bg-transparent border border-stroke-primary text-primary font-semibold text-body hover:bg-primary/5 hover:border-primary transition-all btn-press focus-ring"
          >
            I already have an account
          </button>
          <button
            type="button"
            onClick={onGuest}
            className="w-full text-center text-caption text-text-tertiary hover:text-text-secondary hover:underline transition-colors py-1.5 rounded-r1 focus-ring"
          >
            Just looking? Browse as a guest
          </button>
        </div>
      </div>

      <p className="text-center text-caption text-text-tertiary mt-5">
        <button type="button" onClick={onLearnMore} className="text-primary/80 hover:text-primary hover:underline font-semibold rounded-r1 focus-ring">
          How does Harmolyn keep you safe?
        </button>
      </p>
    </div>
  </div>
  );
};
