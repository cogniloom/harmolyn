
import React, { useState } from 'react';
import { X, MonitorUp, Columns, Square, Maximize } from 'lucide-react';
import { useEscapeKey } from '@/hooks/useEscapeKey';

interface ScreenSharePanelProps {
  onClose: () => void;
  onStartShare?: (type: 'screen' | 'window' | 'tab', quality: string) => Promise<void> | void;
  disabledReason?: string;
  isSharing?: boolean;
}

const SHARE_OPTIONS = [
  { id: 'screen', label: 'Entire Screen', description: 'Share your full screen', icon: <Maximize size={24} /> },
  { id: 'window', label: 'Application Window', description: 'Share a specific app window', icon: <Square size={24} /> },
  { id: 'tab', label: 'Browser Tab', description: 'Share a single browser tab', icon: <Columns size={24} /> },
];

const QUALITY_OPTIONS = [
  { id: '720', label: '720p', desc: '30 fps' },
  { id: '1080', label: '1080p', desc: '60 fps' },
  { id: '1440', label: '1440p', desc: '60 fps' },
];

export const ScreenSharePanel: React.FC<ScreenSharePanelProps> = ({ onClose, onStartShare, disabledReason, isSharing }) => {
  const [selectedType, setSelectedType] = useState<string>('screen');
  const [quality, setQuality] = useState('720');
  const [sharing, setSharing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Don't allow dismissing the overlay mid-handshake.
  useEscapeKey(onClose, !sharing && !isSharing);

  const handleStart = async () => {
    if (disabledReason) {
      setError(disabledReason);
      return;
    }
    setSharing(true);
    setError(null);
    try {
      await onStartShare?.(selectedType as Parameters<NonNullable<typeof onStartShare>>[0], quality);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : 'Unable to start screen share.');
      setSharing(false);
    }
  };

  return (
    <div className="absolute inset-0 z-[110] bg-bg-0/95 backdrop-blur-xl flex items-center justify-center p-4 animate-in fade-in duration-200">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="screen-share-title"
        className="glass-card rounded-r3 border border-white/10 w-full max-w-[480px] shadow-2xl"
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-white/5 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <MonitorUp size={20} className="text-primary" />
            <div>
              <h2 id="screen-share-title" className="text-lg font-bold text-white font-display tracking-tight">SCREEN SHARE</h2>
              <p className="micro-label text-white/30 mt-0.5">GO LIVE // BROADCAST</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={sharing || Boolean(isSharing)}
            aria-label="Close screen share"
            className="w-10 h-10 rounded-full border border-white/10 glass-panel flex items-center justify-center hover:border-primary transition-all focus-ring disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <X size={18} className="text-white/60" />
          </button>
        </div>

        {disabledReason && (
          <div className="mx-6 mt-4 rounded-r2 border border-accent-warning/20 bg-accent-warning/10 px-4 py-3 text-[10px] font-mono text-accent-warning">
            {disabledReason}
          </div>
        )}

        {error && (
          <div role="alert" className="mx-6 mt-4 rounded-r2 border border-accent-danger/20 bg-accent-danger/10 px-4 py-3 text-[10px] font-mono text-accent-danger">
            {error}
          </div>
        )}

        {/* Share Type */}
        <div className="px-6 py-5">
          <div className="micro-label text-white/30 mb-3">SHARE TYPE</div>
          <div className="space-y-2">
            {SHARE_OPTIONS.map(opt => (
              <button
                key={opt.id}
                onClick={() => setSelectedType(opt.id)}
                disabled={Boolean(disabledReason)}
                aria-pressed={selectedType === opt.id}
                className={`w-full flex items-center gap-3 p-4 rounded-r2 border transition-all text-left focus-ring ${
                  selectedType === opt.id
                    ? 'bg-primary/10 border-primary/20'
                    : 'border-white/5 hover:bg-white/5'
                } ${disabledReason ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className={`w-12 h-12 rounded-r2 flex items-center justify-center ${
                  selectedType === opt.id ? 'bg-primary/15 text-primary' : 'bg-white/5 text-white/30'
                }`}>
                  {opt.icon}
                </div>
                <div>
                  <div className="text-sm font-bold text-white">{opt.label}</div>
                  <div className="text-[10px] text-white/35">{opt.description}</div>
                </div>
              </button>
            ))}
          </div>
        </div>

        {/* Quality */}
        <div className="px-6 pb-5">
          <div className="micro-label text-white/30 mb-3">STREAM QUALITY</div>
          <div className="flex gap-2">
            {QUALITY_OPTIONS.map(q => (
              <button
                key={q.id}
                onClick={() => setQuality(q.id)}
                disabled={Boolean(disabledReason)}
                aria-pressed={quality === q.id}
                className={`flex-1 py-3 rounded-r2 text-center border transition-all relative focus-ring ${
                  quality === q.id
                    ? 'bg-primary/10 border-primary/20 text-primary'
                    : 'border-white/5 text-white/40 hover:bg-white/5'
                } ${disabledReason ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <div className="text-sm font-bold">{q.label}</div>
                <div className="text-[9px] text-white/30">{q.desc}</div>
              </button>
            ))}
          </div>
        </div>

        {/* Start */}
        <div className="px-6 pb-6">
          <button
            onClick={handleStart}
            disabled={sharing || Boolean(disabledReason) || Boolean(isSharing)}
            className={`w-full py-4 rounded-full font-bold text-sm transition-all flex items-center justify-center gap-2 focus-ring disabled:opacity-60 disabled:cursor-not-allowed ${
              sharing || isSharing
                ? 'bg-accent-danger/20 text-accent-danger border border-accent-danger/30'
                : 'bg-primary text-bg-0 hover:shadow-glow'
            }`}
          >
            <MonitorUp size={16} />
            {sharing || isSharing ? 'SHARING...' : 'GO LIVE'}
          </button>
        </div>
      </div>
    </div>
  );
};
