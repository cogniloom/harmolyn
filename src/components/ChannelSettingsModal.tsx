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

  const handleSave = () => {
    const trimmed = name.trim().toLowerCase().replace(/\s+/g, '-');
    if (!trimmed) return;
    onSave({
      name: trimmed,
      topic: topic.trim(),
      ...(isVoice ? { bitrate, user_limit: userLimit } : {}),
    });
  };

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center bg-black/60 backdrop-blur-sm animate-in fade-in duration-200" onClick={onClose}>
      <div className="w-full max-w-[520px] mx-6 glass-card rounded-r3 border border-stroke overflow-hidden max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        {/* Header */}
        <div className="p-6 border-b border-white/5 flex items-center justify-between flex-shrink-0">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-primary/10 flex items-center justify-center text-primary">
              {isVoice ? <Volume2 size={18} /> : <Hash size={18} />}
            </div>
            <div>
              <h2 className="text-title font-semibold text-text-primary">Edit {isVoice ? 'Voice' : 'Text'} Channel</h2>
              <p className="text-caption text-text-tertiary">{isVoice ? '' : '#'}{channel.name}</p>
            </div>
          </div>
          <button onClick={onClose} aria-label="Close" className="w-8 h-8 rounded-full glass-panel border border-stroke-subtle flex items-center justify-center text-text-secondary hover:text-primary hover:border-primary transition-all">
            <X size={16} />
          </button>
        </div>

        {/* Content */}
        <div className="p-6 space-y-5 overflow-y-auto flex-1">
          <div className="space-y-1.5">
            <label className="micro-label text-text-tertiary">CHANNEL NAME</label>
            <input
              type="text"
              value={name}
              autoFocus
              onChange={e => setName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
              className="w-full h-12 px-5 rounded-full bg-surface-dark border border-stroke-subtle text-text-primary text-body focus:border-stroke-primary focus:outline-none transition-colors"
            />
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
                      className={`px-3 py-1.5 rounded-full text-xs font-bold transition-all border ${
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
                  className="w-full accent-primary"
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
              className="h-10 px-5 rounded-full bg-accent-danger/10 border border-accent-danger/20 text-accent-danger font-bold text-xs flex items-center gap-2 hover:bg-accent-danger/20 transition-all disabled:opacity-40"
            >
              <Trash2 size={14} />
              Delete Channel
            </button>
          </div>
        </div>

        {/* Footer */}
        <div className="p-4 border-t border-white/5 flex justify-end gap-3 flex-shrink-0">
          <button onClick={onClose} className="h-10 px-5 rounded-full border border-stroke-subtle text-text-secondary text-body-strong hover:bg-white/5 transition-all">
            Cancel
          </button>
          <button onClick={handleSave} disabled={busy || !name.trim()} className="h-10 px-5 rounded-full bg-primary text-bg-0 font-bold text-body-strong flex items-center gap-2 hover:shadow-glow transition-all disabled:opacity-40">
            <Save size={14} />
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
};
