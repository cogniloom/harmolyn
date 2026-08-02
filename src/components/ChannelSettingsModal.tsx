import React, { useEffect, useState } from 'react';
import { X, Hash, Volume2, Trash2, Save, Gauge, Users } from 'lucide-react';
import { Channel } from '@/types';

export interface ChannelEditValues {
  name: string;
  topic?: string;
  bitrate?: number;
  user_limit?: number;
}

interface ChannelSettingsModalProps {
  channel: Channel;
  busy?: boolean;
  onClose: () => void;
  onSave: (patch: ChannelEditValues) => void;
  onDelete: () => void;
}

const BITRATE_OPTIONS = [8, 32, 64, 96, 128, 256, 384];

export const ChannelSettingsModal: React.FC<ChannelSettingsModalProps> = ({ channel, busy, onClose, onSave, onDelete }) => {
  const isVoice = channel.type === 'voice';
  const [name, setName] = useState(channel.name);
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [bitrate, setBitrate] = useState<number>(channel.bitrate ?? 64);
  const [userLimit, setUserLimit] = useState<number>(channel.userLimit ?? 0);

  // Close on Escape (matches the rest of the app's modal affordances).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Channel names are normalized on save (lowercased, spaces → hyphens). Computed
  // here too so the form can TELL the user what will actually be saved instead of
  // silently rewriting their input.
  const normalizedName = name.trim().toLowerCase().replace(/\s+/g, '-');
  const nameWillChange = Boolean(name.trim()) && normalizedName !== name.trim();

  const handleSave = () => {
    if (!normalizedName) return;
    onSave({
      name: normalizedName,
      topic: topic.trim(),
      ...(isVoice ? { bitrate, user_limit: userLimit } : {}),
    });
  };

  return (
    <div className="responsive-overlay-scroll fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="channel-settings-title"
        className="flex max-h-full w-full max-w-[520px] flex-col overflow-hidden rounded-r3 border border-stroke glass-card"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex flex-shrink-0 items-center justify-between gap-3 border-b border-white/5 p-4 sm:p-6">
          <div className="flex min-w-0 items-center gap-3">
            <div className="flex h-10 w-10 flex-shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
              {isVoice ? <Volume2 size={18} /> : <Hash size={18} />}
            </div>
            <div className="min-w-0">
              <h2 id="channel-settings-title" className="truncate text-title font-semibold text-text-primary">Edit {isVoice ? 'Voice' : 'Text'} Channel</h2>
              <p className="truncate text-caption text-text-tertiary">{isVoice ? '' : '#'}{channel.name}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="touch-target flex flex-shrink-0 items-center justify-center rounded-full border border-stroke-subtle text-text-secondary glass-panel transition-all hover:border-primary hover:text-primary focus-ring">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto overscroll-contain p-4 sm:p-6">
          <div className="space-y-1.5">
            <label htmlFor="channel-name-input" className="micro-label text-text-tertiary">CHANNEL NAME</label>
            <input
              id="channel-name-input"
              type="text"
              value={name}
              autoFocus
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
              aria-describedby={nameWillChange ? 'channel-name-normalized-note' : undefined}
              className="w-full h-12 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body focus:border-stroke-primary focus:outline-none transition-colors"
            />
            {nameWillChange && (
              <p id="channel-name-normalized-note" role="note" className="text-[10px] text-text-tertiary px-1">
                Channel names are lowercase and use hyphens instead of spaces — this will be saved as{' '}
                <span className="text-text-secondary font-mono">{isVoice ? '' : '#'}{normalizedName}</span>.
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <label className="micro-label text-text-tertiary">{isVoice ? 'CHANNEL DESCRIPTION' : 'CHANNEL TOPIC'}</label>
            <textarea
              value={topic}
              onChange={e => setTopic(e.target.value)}
              placeholder={isVoice ? 'What is this voice channel for?' : 'Describe the purpose of this channel…'}
              rows={3}
              className="w-full px-5 py-3 rounded-r2 bg-surface-dark border border-stroke-subtle text-text-primary text-body placeholder:text-text-disabled focus:border-stroke-primary focus:outline-none transition-colors resize-none"
            />
          </div>

          {isVoice && (
            <>
              {/* Bitrate */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Gauge size={14} className="text-text-tertiary" />
                  <label className="micro-label text-text-tertiary">BITRATE — {bitrate} kbps</label>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {BITRATE_OPTIONS.map(opt => (
                    <button
                      key={opt}
                      onClick={() => setBitrate(opt)}
                      className={`compact-touch-target rounded-full border px-3 py-1.5 text-xs font-bold transition-all ${
                        bitrate === opt
                          ? 'bg-primary/15 text-primary border-primary/30'
                          : 'text-text-secondary border-stroke-subtle hover:bg-white/5'
                      }`}
                    >
                      {opt}
                    </button>
                  ))}
                </div>
              </div>

              {/* User limit */}
              <div className="space-y-2">
                <div className="flex items-center gap-2">
                  <Users size={14} className="text-text-tertiary" />
                  <label className="micro-label text-text-tertiary">USER LIMIT {userLimit === 0 ? '— Unlimited' : `— ${userLimit}`}</label>
                </div>
                <input
                  type="range"
                  min={0}
                  max={99}
                  value={userLimit}
                  onChange={e => setUserLimit(Number(e.target.value))}
                  className="compact-touch-target w-full cursor-pointer accent-primary"
                />
                <div className="text-[10px] text-text-tertiary">0 = no limit. Drag to cap how many people can join.</div>
              </div>
            </>
          )}

          {/* Danger Zone */}
          <div className="border-t border-white/5 pt-5">
            <div className="micro-label text-accent-danger mb-3">DANGER ZONE</div>
            <button
              onClick={onDelete}
              disabled={busy}
              className="compact-touch-target flex h-10 items-center gap-2 rounded-full border border-accent-danger/20 bg-accent-danger/10 px-5 text-xs font-bold text-accent-danger transition-all hover:bg-accent-danger/20 disabled:opacity-40"
            >
              <Trash2 size={14} />
              Delete Channel
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="flex flex-shrink-0 flex-wrap justify-end gap-2 border-t border-white/5 p-4 sm:gap-3">
          <button onClick={onClose} className="compact-touch-target h-10 rounded-full border border-stroke-subtle px-5 text-text-secondary text-body-strong transition-all hover:bg-white/5">
            Cancel
          </button>
          <button onClick={handleSave} disabled={busy || !name.trim()} className="compact-touch-target flex h-10 items-center gap-2 rounded-full bg-primary px-5 font-bold text-bg-0 text-body-strong transition-all hover:shadow-glow disabled:opacity-40">
            <Save size={14} />
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};
