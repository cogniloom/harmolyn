import React, { useState } from 'react';
import { safeStorageSet } from '@/lib/browserStorage';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import {
  Monitor, Cpu, KeyRound, Fingerprint, ShieldCheck, Lock, Unlock,
  Search, HardDrive, Network, Activity, RefreshCw, Shield,
  CheckCircle2, AlertTriangle, Info, TreePine, Users,
  ArrowLeft, ArrowRight, X, Wifi, Radio
} from 'lucide-react';

interface SecurityOnboardingProps {
  onClose: () => void;
}

const IconArea = ({ primary: P, accent: A, color = 'text-primary' }: { primary: React.ElementType; accent: React.ElementType; color?: string }) => (
  <div className="relative w-16 h-16 mx-auto mb-5">
    <div className={`w-16 h-16 rounded-2xl glass-card flex items-center justify-center ${color}`}>
      <P size={28} />
    </div>
    <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-lg bg-[#111718] border border-white/10 flex items-center justify-center text-primary/70">
      <A size={14} />
    </div>
  </div>
);

const Bullet = ({ icon: I, color, children }: { icon: React.ElementType; color: string; children: React.ReactNode }) => (
  <div className="flex gap-3 items-start">
    <I size={16} className={`mt-0.5 flex-shrink-0 ${color}`} />
    <span className="text-sm leading-relaxed text-[rgba(246,248,248,0.85)]">{children}</span>
  </div>
);

const Badge = ({ icon: I, label, color, bg }: { icon: React.ElementType; label: string; color: string; bg: string }) => (
  <div className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-semibold ${color} ${bg}`}>
    <I size={14} />
    {label}
  </div>
);

const SCREENS = [
  {
    id: 'what-you-run',
    title: "What you're running",
    icon: <IconArea primary={Monitor} accent={Cpu} />,
    content: (
      <div className="flex flex-col gap-3">
        <Bullet icon={Info} color="text-primary">
          <strong>Harmolyn</strong> is the UI. <strong>xorein</strong> is the local network engine it talks to.
        </Bullet>
        <Bullet icon={CheckCircle2} color="text-[#05FFA1]">
          There is no "central server" that needs your plaintext to work.
        </Bullet>
        <Bullet icon={CheckCircle2} color="text-[#05FFA1]">
          Your messages are processed and encrypted <strong>on your device</strong>.
        </Bullet>
      </div>
    ),
  },
  {
    id: 'identity-key',
    title: 'Your identity is a key',
    icon: <IconArea primary={KeyRound} accent={Fingerprint} />,
    content: (
      <div className="flex flex-col gap-3">
        <Bullet icon={Info} color="text-primary">
          Your account is a <strong>cryptographic identity</strong> — not an email/password.
        </Bullet>
        <Bullet icon={AlertTriangle} color="text-[#FFB020]">
          Losing your device without a backup can mean <strong>losing access</strong>.
        </Bullet>
        <Bullet icon={CheckCircle2} color="text-[#05FFA1]">
          Create an encrypted backup early: <strong>Settings → Identity Backup</strong>.
        </Bullet>
      </div>
    ),
  },
  {
    id: 'security-modes',
    title: 'Security is explicit, per surface',
    icon: <IconArea primary={ShieldCheck} accent={Lock} />,
    content: (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[rgba(246,248,248,0.7)]">
          Every conversation header shows a badge indicating its security mode:
        </p>
        <div className="grid grid-cols-3 gap-2">
          <Badge icon={Lock} label="Seal" color="text-[#05FFA1]" bg="bg-[rgba(5,255,161,0.12)]" />
          <Badge icon={TreePine} label="Tree" color="text-primary" bg="bg-[rgba(19,221,236,0.12)]" />
          <Badge icon={Users} label="Crowd" color="text-[#FFB020]" bg="bg-[rgba(255,176,32,0.12)]" />
        </div>
        <div className="glass-card rounded-xl p-3 text-xs text-[#FF2A6D]/90">
          <AlertTriangle size={12} className="inline mr-1" />
          <span className="font-semibold">Clear means not encrypted.</span> Harmolyn never puts you in a Clear
          conversation — there is no option to choose it. If you ever see an unencrypted badge, treat the chat as
          readable by infrastructure and don't share anything sensitive.
        </div>
        <div className="glass-card rounded-xl p-3 text-xs text-[rgba(246,248,248,0.6)] italic">
          "This chat is: <span className="text-[#05FFA1] font-semibold not-italic">Seal (E2EE)</span>. Tap for details: algorithms, key status, and what's visible as metadata."
        </div>
      </div>
    ),
  },
  {
    id: 'e2ee-limits',
    title: 'What E2EE does and does not protect',
    icon: (
      <div className="relative w-16 h-16 mx-auto mb-5">
        <div className="w-16 h-16 rounded-2xl glass-card flex items-center justify-center">
          <Lock size={20} className="text-[#05FFA1] -mr-0.5" />
          <Unlock size={20} className="text-[#FFB020] -ml-0.5" />
        </div>
      </div>
    ),
    content: (
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <div className="flex flex-col gap-2.5">
          <span className="micro-label text-[#05FFA1] tracking-widest">PROTECTED</span>
          <Bullet icon={CheckCircle2} color="text-[#05FFA1]">Message text is encrypted end-to-end</Bullet>
          <Bullet icon={CheckCircle2} color="text-[#05FFA1]">Attachments are encrypted</Bullet>
          <Bullet icon={CheckCircle2} color="text-[#05FFA1]">Media frames (when enabled)</Bullet>
        </div>
        <div className="flex flex-col gap-2.5">
          <span className="micro-label text-[#FFB020] tracking-widest">NOT HIDDEN</span>
          <Bullet icon={AlertTriangle} color="text-[#FFB020]">Who you talk to &amp; when</Bullet>
          <Bullet icon={AlertTriangle} color="text-[#FFB020]">Channel membership &amp; routing</Bullet>
          <Bullet icon={AlertTriangle} color="text-[#FFB020]">Traffic patterns &amp; sizes</Bullet>
        </div>
        <div className="sm:col-span-2 text-xs text-[rgba(246,248,248,0.5)] mt-1">
          <AlertTriangle size={12} className="inline mr-1 text-[#FF2A6D]" />
          A compromised device can read your decrypted content — crypto can't solve that.
        </div>
      </div>
    ),
  },
  {
    id: 'search-limits',
    title: 'Search and history have real limits',
    icon: <IconArea primary={Search} accent={HardDrive} />,
    content: (
      <div className="flex flex-col gap-3">
        <Bullet icon={Info} color="text-primary">
          In E2EE chats, servers <strong>cannot</strong> do plaintext full-text search.
        </Bullet>
        <Bullet icon={Info} color="text-primary">
          Search runs <strong>on your device</strong> over locally available messages.
        </Bullet>
        <div className="flex gap-2 flex-wrap mt-1">
          <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-[rgba(5,255,161,0.15)] text-[#05FFA1]">Full</span>
          <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-[rgba(255,176,32,0.15)] text-[#FFB020]">Partial</span>
          <span className="px-2.5 py-1 rounded-full text-[10px] font-semibold uppercase tracking-wider bg-[rgba(255,42,109,0.15)] text-[#FF2A6D]">Empty</span>
        </div>
        <p className="text-xs text-[rgba(246,248,248,0.5)] mt-1">Coverage labels tell you how complete your results are — so you're never tricked by "missing" results.</p>
        <Bullet icon={AlertTriangle} color="text-[#FFB020]">
          History is retention-bounded and may be locked across security-mode changes.
        </Bullet>
      </div>
    ),
  },
  {
    id: 'network',
    title: 'Network behavior you can see',
    icon: <IconArea primary={Network} accent={Activity} />,
    content: (
      <div className="flex flex-col gap-3">
        <p className="text-sm text-[rgba(246,248,248,0.7)]">Honest indicators you can always check:</p>
        <div className="grid grid-cols-2 gap-2">
          {[
            { icon: Wifi, label: 'Connected via', value: 'Direct / Relay' },
            { icon: Users, label: 'Peers in scope', value: 'N' },
            { icon: Radio, label: 'Store-and-forward', value: 'On / Off' },
            { icon: AlertTriangle, label: 'Downgrade', value: 'Warned' },
          ].map(({ icon: I, label, value }) => (
            <div key={label} className="glass-card rounded-xl p-2.5 flex items-center gap-2">
              <I size={14} className="text-primary flex-shrink-0" />
              <div className="min-w-0">
                <div className="text-[10px] font-semibold uppercase tracking-wider text-[rgba(246,248,248,0.45)]">{label}</div>
                <div className="text-xs font-medium text-[rgba(246,248,248,0.85)]">{value}</div>
              </div>
            </div>
          ))}
        </div>
        <p className="text-xs text-[rgba(246,248,248,0.5)] mt-1">
          If anything downgrades (e.g., media E2EE unavailable), the UI tells you explicitly.
        </p>
      </div>
    ),
  },
  {
    id: 'updates',
    title: 'Updates are part of security',
    icon: <IconArea primary={RefreshCw} accent={Shield} />,
    content: (
      <div className="flex flex-col gap-3">
        <Bullet icon={Info} color="text-primary">
          Protocol + crypto is <strong>versioned and negotiated</strong> between peers.
        </Bullet>
        <Bullet icon={CheckCircle2} color="text-[#05FFA1]">
          Old clients may keep working, but security fixes may require upgrading.
        </Bullet>
        <div className="glass-card rounded-xl p-3 flex items-center gap-3 mt-1">
          <div className="w-8 h-8 rounded-lg bg-[rgba(255,176,32,0.15)] flex items-center justify-center flex-shrink-0">
            <AlertTriangle size={16} className="text-[#FFB020]" />
          </div>
          <div>
            <div className="text-xs font-semibold text-[#FFB020]">Update recommended</div>
            <div className="text-[11px] text-[rgba(246,248,248,0.5)]">The network prefers a newer secure profile.</div>
          </div>
        </div>
      </div>
    ),
  },
];

export const SecurityOnboarding: React.FC<SecurityOnboardingProps> = ({ onClose }) => {
  const [step, setStep] = useState(0);
  const [dontShow, setDontShow] = useState(false);

  const screen = SCREENS[step];
  const isLast = step === SCREENS.length - 1;

  const handleClose = () => {
    if (dontShow) safeStorageSet(() => window.localStorage, 'harmolyn_onboarding_dismissed', 'true');
    onClose();
  };

  useEscapeKey(handleClose);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={handleClose} />

      {/* Modal */}
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="security-onboarding-title"
        className="relative w-full max-w-[580px] glass-card rounded-[32px] border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.37)] overflow-hidden"
      >
        {/* Progress bar */}
        <div className="h-1.5 bg-white/5">
          <div
            className="h-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${((step + 1) / SCREENS.length) * 100}%` }}
          />
        </div>

        {/* Close */}
        <button
          onClick={handleClose}
          aria-label="Close security overview"
          className="focus-ring absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center text-[rgba(246,248,248,0.4)] hover:text-[rgba(246,248,248,0.8)] hover:bg-white/5 transition-colors z-10"
        >
          <X size={18} />
        </button>

        {/* Content */}
        <div className="px-6 sm:px-8 pt-8 pb-4 max-h-[70vh] overflow-y-auto">
          <div className="micro-label text-primary/60 text-center mb-2 tracking-[0.2em]">
            {step + 1} / {SCREENS.length}
          </div>

          {screen.icon}

          <h2 id="security-onboarding-title" className="text-xl font-bold text-center mb-5 text-[#F6F8F8]">
            {screen.title}
          </h2>

          {screen.content}
        </div>

        {/* Footer */}
        <div className="px-6 sm:px-8 pb-6 pt-2">
          {/* Progress dots */}
          <div className="flex justify-center gap-1.5 mb-4">
            {SCREENS.map((_, i) => (
              <div
                key={i}
                className={`h-1.5 rounded-full transition-all duration-300 ${
                  i === step ? 'w-6 bg-primary' : i < step ? 'w-1.5 bg-primary/40' : 'w-1.5 bg-white/10'
                }`}
              />
            ))}
          </div>

          {/* Checkbox — whole row is clickable (Fitts's Law) */}
          <label
            htmlFor="onboarding-dont-show"
            className="flex items-center gap-2.5 cursor-pointer mb-4 justify-center group rounded-full px-3 py-1 -mx-3"
          >
            <input
              id="onboarding-dont-show"
              type="checkbox"
              checked={dontShow}
              onChange={(e) => setDontShow(e.target.checked)}
              className="sr-only peer"
            />
            <span
              aria-hidden="true"
              className={`w-4 h-4 rounded border transition-colors flex items-center justify-center peer-focus-visible:ring-2 peer-focus-visible:ring-[rgba(19,221,236,0.5)] ${
                dontShow ? 'bg-primary border-primary' : 'border-white/20 group-hover:border-white/40'
              }`}
            >
              {dontShow && <CheckCircle2 size={12} className="text-[#050A0B]" />}
            </span>
            <span className="text-xs text-[rgba(246,248,248,0.5)]">
              Do not show again
            </span>
          </label>

          {/* Buttons */}
          <div className="flex items-center justify-between">
            <button
              onClick={handleClose}
              className="text-xs font-semibold text-[rgba(246,248,248,0.4)] hover:text-[rgba(246,248,248,0.7)] transition-colors px-4 py-2"
            >
              SKIP
            </button>

            <div className="flex gap-2">
              {step > 0 && (
                <button
                  onClick={() => setStep(s => s - 1)}
                  className="h-10 px-4 rounded-full border border-white/10 text-sm font-semibold text-[rgba(246,248,248,0.7)] hover:border-[rgba(19,221,236,0.3)] hover:text-primary transition-colors flex items-center gap-1.5"
                >
                  <ArrowLeft size={14} />
                  BACK
                </button>
              )}
              <button
                onClick={isLast ? handleClose : () => setStep(s => s + 1)}
                className="h-10 px-5 rounded-full bg-primary text-[#050A0B] text-sm font-bold hover:brightness-110 transition-all flex items-center gap-1.5 shadow-[0_0_5px_rgba(19,221,236,0.4)]"
              >
                {isLast ? 'GOT IT' : 'NEXT'}
                {!isLast && <ArrowRight size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
