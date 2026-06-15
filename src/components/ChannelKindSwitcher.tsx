import React, { useState } from 'react';
import { Hash, MessageSquare, Megaphone, AlertTriangle } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

export type ChannelKind = 'text' | 'forum' | 'announcement';

const KIND_META: Record<ChannelKind, { label: string; icon: React.ReactNode }> = {
  text: { label: 'Text', icon: <Hash size={11} /> },
  forum: { label: 'Forum', icon: <MessageSquare size={11} /> },
  announcement: { label: 'Announce', icon: <Megaphone size={11} /> },
};

interface ChannelKindSwitcherProps {
  value: ChannelKind;
  available: ChannelKind[];
  onChange: (kind: ChannelKind) => void;
}

/** Lets a member convert the current channel between text/forum/announcement surfaces. */
export const ChannelKindSwitcher: React.FC<ChannelKindSwitcherProps> = ({ value, available, onChange }) => {
  // Switching kind re-renders the channel surface entirely (a text feed becomes a
  // forum grid, etc.), so confirm before committing the change to avoid an
  // accidental, disorienting layout swap.
  const [pending, setPending] = useState<ChannelKind | null>(null);

  useEscapeKey(() => setPending(null), pending !== null);

  if (available.length <= 1) {
    return null;
  }

  const confirm = () => {
    if (pending) onChange(pending);
    setPending(null);
  };

  return (
    <>
      <div className="flex items-center gap-0.5 rounded-full border border-white/10 bg-white/5 p-0.5" role="group" aria-label="Channel type">
        {available.map((kind) => (
          <button
            key={kind}
            onClick={() => { if (kind !== value) setPending(kind); }}
            aria-pressed={value === kind}
            aria-label={`Set channel type to ${KIND_META[kind].label}`}
            className={`flex items-center gap-1 px-2 py-1 rounded-full text-[9px] font-bold uppercase tracking-wider transition-all focus-ring ${
              value === kind ? 'bg-primary text-bg-0' : 'text-white/40 hover:text-white/70'
            }`}
          >
            {KIND_META[kind].icon}
            <span className="hidden md:inline">{KIND_META[kind].label}</span>
          </button>
        ))}
      </div>

      {pending && (
        <div className="fixed inset-0 z-[90] flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/60" onClick={() => setPending(null)} />
          <div
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="channel-kind-switch-title"
            aria-describedby="channel-kind-switch-desc"
            className="relative z-10 w-full max-w-sm glass-card rounded-r2 border border-stroke p-5 space-y-4 animate-in fade-in zoom-in-95 duration-150"
          >
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-full bg-accent-warning/10 border border-accent-warning/20 flex items-center justify-center flex-shrink-0">
                <AlertTriangle size={16} className="text-accent-warning" aria-hidden="true" />
              </div>
              <div className="space-y-1">
                <h2 id="channel-kind-switch-title" className="text-body-strong text-text-primary">
                  Change to {KIND_META[pending].label}?
                </h2>
                <p id="channel-kind-switch-desc" className="text-caption text-text-secondary leading-relaxed">
                  This changes how the channel is displayed. Existing messages stay, but they
                  may be laid out differently.
                </p>
              </div>
            </div>
            <div className="flex items-center justify-end gap-2">
              <button
                onClick={() => setPending(null)}
                className="h-9 px-4 rounded-full text-caption font-bold text-text-secondary hover:text-text-primary hover:bg-white/5 transition-all focus-ring"
              >
                Cancel
              </button>
              <button
                onClick={confirm}
                className="h-9 px-4 rounded-full bg-primary text-bg-0 text-caption font-bold hover:shadow-glow transition-all focus-ring"
              >
                Change type
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
