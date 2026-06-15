import React from 'react';
import { Sparkles, Plus, Link2, UserPlus, Network, Lock, KeyRound, ArrowRight } from 'lucide-react';

interface WelcomeEmptyStateProps {
  hasIdentity: boolean;
  /** Whether connectivity actions (create/join server) are currently available. */
  canUseConnectivity: boolean;
  onCreateServer: () => void;
  onJoinServer: () => void;
  onAddFriend: () => void;
  /** Open the auth flow (shown when the user is still a guest). */
  onOpenAuth: () => void;
}

const FACTS: { icon: React.ReactNode; text: string }[] = [
  { icon: <Network size={14} className="text-primary" />, text: 'Peer-to-peer — messages travel directly between people, not through a central server.' },
  { icon: <Lock size={14} className="text-primary" />, text: 'End-to-end encrypted — every space shows exactly which protection is in use.' },
  { icon: <KeyRound size={14} className="text-primary" />, text: 'You own your identity — it’s a key on your device, and you can back it up any time.' },
];

/**
 * Friendly first-screen for a connected user who has no servers yet. Replaces the
 * cryptic "Initiate Hub: #empty-shell" placeholder with a plain-language intro to
 * Harmolyn + xorein and three clear next steps.
 */
export const WelcomeEmptyState: React.FC<WelcomeEmptyStateProps> = ({
  hasIdentity,
  canUseConnectivity,
  onCreateServer,
  onJoinServer,
  onAddFriend,
  onOpenAuth,
}) => {
  const actionsEnabled = hasIdentity && canUseConnectivity;

  const actions: { icon: React.ReactNode; title: string; body: string; onClick: () => void }[] = [
    { icon: <Plus size={18} className="text-primary" />, title: 'Create a server', body: 'Start a space for your community or friends.', onClick: onCreateServer },
    { icon: <Link2 size={18} className="text-primary" />, title: 'Join with an invite', body: 'Paste an invite link to join an existing server.', onClick: onJoinServer },
    { icon: <UserPlus size={18} className="text-primary" />, title: 'Add a friend', body: 'Connect one-to-one with someone’s public key.', onClick: onAddFriend },
  ];

  return (
    <div className="flex-1 min-h-0 overflow-auto relative">
      <div className="absolute inset-0 grid-overlay opacity-20 pointer-events-none" />
      <div className="relative z-10 max-w-[640px] mx-auto px-6 py-12 md:py-16">
        <div className="text-center mb-10">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-r2 bg-primary/10 border border-primary/20 mb-4 shadow-glow">
            <Sparkles size={26} className="text-primary" />
          </div>
          <h1 className="text-2xl md:text-3xl font-bold text-white font-display tracking-tight">Welcome to Harmolyn</h1>
          <p className="text-body text-white/60 mt-2 max-w-[440px] mx-auto">
            A private, peer-to-peer chat network. You don’t have any servers yet — here’s how to get started.
          </p>
        </div>

        <div className="glass-card rounded-r3 border border-stroke p-5 mb-8 space-y-3">
          {FACTS.map((f, i) => (
            <div key={i} className="flex items-start gap-3">
              <div className="w-8 h-8 rounded-r2 bg-primary/10 border border-primary/15 flex items-center justify-center flex-shrink-0">{f.icon}</div>
              <p className="text-caption text-white/70 leading-relaxed pt-1.5">{f.text}</p>
            </div>
          ))}
        </div>

        {!hasIdentity ? (
          <div className="glass-card rounded-r3 border border-primary/20 p-6 text-center space-y-4">
            <p className="text-body text-white/70">Create a free account to start a server, join one, or add a friend.</p>
            <button
              onClick={onOpenAuth}
              className="inline-flex items-center justify-center gap-2 h-12 px-6 rounded-full bg-primary text-bg-0 font-bold text-body-strong hover:shadow-glow transition-all"
            >
              Create your account
              <ArrowRight size={18} />
            </button>
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-3">
            {actions.map((a) => (
              <button
                key={a.title}
                onClick={a.onClick}
                disabled={!actionsEnabled}
                className="glass-card rounded-r3 border border-stroke p-5 text-left hover:border-primary/40 transition-all disabled:opacity-40 disabled:cursor-not-allowed group"
              >
                <div className="w-10 h-10 rounded-r2 bg-primary/10 border border-primary/15 flex items-center justify-center mb-3 group-hover:scale-105 transition-transform">{a.icon}</div>
                <div className="text-body-strong text-white">{a.title}</div>
                <p className="text-caption text-white/50 leading-relaxed mt-1">{a.body}</p>
              </button>
            ))}
          </div>
        )}

        {hasIdentity && !canUseConnectivity && (
          <p className="text-center text-caption text-white/40 mt-5">
            Connecting to the network… these actions become available once you’re online.
          </p>
        )}
      </div>
    </div>
  );
};
