import React, { useState } from 'react';
import { safeStorageSet } from '@/lib/browserStorage';
import { useEscapeKey } from '@/hooks/useEscapeKey';
import {
  Compass, Hash, MessageSquare, Mic, Server, Users,
  UserPlus, Settings, ShieldCheck, Search,
  ArrowLeft, ArrowRight, X, CheckCircle2,
} from 'lucide-react';

interface ProductTourProps {
  onClose: () => void;
}

/** localStorage key: set once the tour is completed or explicitly dismissed. */
export const TOUR_DISMISSED_KEY = 'harmolyn_tour_dismissed';

const IconArea = ({ primary: P, accent: A }: { primary: React.ElementType; accent: React.ElementType }) => (
  <div className="relative w-16 h-16 mx-auto mb-5">
    <div className="w-16 h-16 rounded-2xl glass-card flex items-center justify-center text-primary">
      <P size={28} />
    </div>
    <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-lg bg-[#111718] border border-white/10 flex items-center justify-center text-primary/70">
      <A size={14} />
    </div>
  </div>
);

const Row = ({ icon: I, title, children }: { icon: React.ElementType; title: string; children: React.ReactNode }) => (
  <div className="flex gap-3 items-start">
    <div className="w-8 h-8 rounded-lg bg-primary/10 flex items-center justify-center flex-shrink-0 text-primary">
      <I size={16} />
    </div>
    <div>
      <div className="text-sm font-semibold text-[#F6F8F8]">{title}</div>
      <div className="text-sm leading-relaxed text-[rgba(246,248,248,0.7)]">{children}</div>
    </div>
  </div>
);

// Plain-language walkthrough of the core surfaces. Deliberately non-technical:
// no crypto detail (that lives in SecurityOnboarding) — this answers "how do I
// use this app?" for a first-time, possibly non-technical, visitor.
const SCREENS = [
  {
    id: 'welcome',
    title: 'Welcome to Harmolyn',
    icon: <IconArea primary={Compass} accent={ShieldCheck} />,
    content: (
      <div className="flex flex-col gap-4">
        <p className="text-sm text-[rgba(246,248,248,0.75)] text-center">
          A private place to talk with friends and communities. Here's a quick tour of the main
          parts — it takes less than a minute, and you can skip it any time.
        </p>
        <div className="glass-card rounded-xl p-3 text-xs text-[rgba(246,248,248,0.6)] text-center">
          Everything you send is private by default. Look for the lock badge at the top of each chat.
        </div>
      </div>
    ),
  },
  {
    id: 'servers',
    title: 'Servers are communities',
    icon: <IconArea primary={Server} accent={Users} />,
    content: (
      <div className="flex flex-col gap-3">
        <Row icon={Server} title="The column on the left">
          Each round icon is a server — a community you've joined or created. Tap one to open it.
        </Row>
        <Row icon={UserPlus} title="Joining and creating">
          Use the <strong>+</strong> button to create your own server or paste an invite link a
          friend shared with you.
        </Row>
      </div>
    ),
  },
  {
    id: 'channels',
    title: 'Channels organize the talk',
    icon: <IconArea primary={Hash} accent={MessageSquare} />,
    content: (
      <div className="flex flex-col gap-3">
        <Row icon={Hash} title="Text channels">
          Inside a server, channels split conversations by topic. Tap a channel name to read and
          post in it.
        </Row>
        <Row icon={Search} title="Finding things">
          Search looks through the messages already on your device — results show how complete they
          are, so you're never misled.
        </Row>
      </div>
    ),
  },
  {
    id: 'dms',
    title: 'Direct messages',
    icon: <IconArea primary={MessageSquare} accent={ShieldCheck} />,
    content: (
      <div className="flex flex-col gap-3">
        <Row icon={MessageSquare} title="One-to-one chats">
          Direct messages are private conversations between you and one other person, end-to-end
          encrypted.
        </Row>
        <Row icon={UserPlus} title="Adding friends">
          Add someone as a friend to start a direct message. You only need their handle — no phone
          number or email.
        </Row>
      </div>
    ),
  },
  {
    id: 'voice',
    title: 'Voice and video',
    icon: <IconArea primary={Mic} accent={Users} />,
    content: (
      <div className="flex flex-col gap-3">
        <Row icon={Mic} title="Voice channels">
          Tap a voice channel to join a live call. Others in the channel can hear you, and you can
          turn your camera or screen-share on when you want.
        </Row>
        <div className="glass-card rounded-xl p-3 text-xs text-[rgba(246,248,248,0.6)]">
          If your network can't connect a call directly, Harmolyn tells you plainly instead of
          failing silently.
        </div>
      </div>
    ),
  },
  {
    id: 'settings',
    title: "You're all set",
    icon: <IconArea primary={Settings} accent={CheckCircle2} />,
    content: (
      <div className="flex flex-col gap-3">
        <Row icon={Settings} title="Make it yours">
          Open <strong>Settings</strong> to change your name, pick a language, adjust text size, or
          turn on <strong>Simple Mode</strong> for a calmer, plainer look.
        </Row>
        <Row icon={ShieldCheck} title="Keep your account safe">
          Create an encrypted backup of your identity early — it's the only way to recover your
          account if you lose your device.
        </Row>
      </div>
    ),
  },
];

export const ProductTour: React.FC<ProductTourProps> = ({ onClose }) => {
  const [step, setStep] = useState(0);

  const screen = SCREENS[step];
  const isLast = step === SCREENS.length - 1;

  const handleClose = () => {
    safeStorageSet(() => window.localStorage, TOUR_DISMISSED_KEY, 'true');
    onClose();
  };

  useEscapeKey(handleClose);

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={handleClose} />

      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="product-tour-title"
        className="relative w-full max-w-[540px] glass-card rounded-[32px] border border-white/10 shadow-[0_8px_32px_rgba(0,0,0,0.37)] overflow-hidden"
      >
        {/* Progress bar */}
        <div className="h-1.5 bg-white/5">
          <div
            className="h-full bg-primary transition-all duration-300 ease-out"
            style={{ width: `${((step + 1) / SCREENS.length) * 100}%` }}
          />
        </div>

        <button
          onClick={handleClose}
          aria-label="Close tour"
          className="focus-ring absolute top-4 right-4 w-8 h-8 rounded-full flex items-center justify-center text-[rgba(246,248,248,0.4)] hover:text-[rgba(246,248,248,0.8)] hover:bg-white/5 transition-colors z-10"
        >
          <X size={18} />
        </button>

        <div className="px-6 sm:px-8 pt-8 pb-4 max-h-[70vh] overflow-y-auto">
          <div className="micro-label text-primary/60 text-center mb-2 tracking-[0.2em]">
            {step + 1} / {SCREENS.length}
          </div>

          {screen.icon}

          <h2 id="product-tour-title" className="text-xl font-bold text-center mb-5 text-[#F6F8F8]">
            {screen.title}
          </h2>

          {screen.content}
        </div>

        <div className="px-6 sm:px-8 pb-6 pt-2">
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
                {isLast ? 'START USING HARMOLYN' : 'NEXT'}
                {!isLast && <ArrowRight size={14} />}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};
