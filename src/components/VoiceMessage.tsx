import React, { useState, useRef, useEffect, useMemo } from 'react';
import { Mic, Square, Play, Pause, Trash2, Send, Loader2 } from 'lucide-react';

interface VoiceMessageRecorderProps {
  onSend: (duration: number) => void;
  onCancel: () => void;
}

// Maximum voice-message recording length. Recording auto-stops at this cap so a
// forgotten recorder can't run unbounded (matches the behavior of Telegram/WhatsApp,
// which cap voice notes). The animated progress bar fills relative to this cap.
const MAX_RECORDING_SECONDS = 5 * 60; // 5 minutes

export const VoiceMessageRecorder: React.FC<VoiceMessageRecorderProps> = ({ onSend, onCancel }) => {
  const [recording, setRecording] = useState(true);
  const [duration, setDuration] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (recording) {
      intervalRef.current = setInterval(() => {
        setDuration(d => {
          const next = d + 1;
          // Auto-stop at the cap: clear the timer and leave the recorder in the
          // stopped state so the user can review/send (matching the manual Stop path).
          if (next >= MAX_RECORDING_SECONDS) {
            if (intervalRef.current) clearInterval(intervalRef.current);
            setRecording(false);
            return MAX_RECORDING_SECONDS;
          }
          return next;
        });
      }, 1000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [recording]);

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  const atCap = duration >= MAX_RECORDING_SECONDS;

  const handleStop = () => {
    setRecording(false);
    if (intervalRef.current) clearInterval(intervalRef.current);
  };

  return (
    <div className="flex items-center gap-3 px-4 py-2 glass-card rounded-full border border-stroke-primary animate-in slide-in-from-bottom-2 duration-200">
      {recording ? (
        <>
          <div className="w-3 h-3 rounded-full bg-accent-danger animate-pulse" />
          <span className="text-body-strong text-accent-danger font-mono">{formatTime(duration)}</span>
          <div className="flex-1 h-1 bg-white/10 rounded-full overflow-hidden">
            <div className="h-full bg-accent-danger/50 rounded-full animate-pulse" style={{ width: `${Math.min(100, (duration / MAX_RECORDING_SECONDS) * 100)}%` }} />
          </div>
          <button onClick={onCancel} className="p-1.5 text-text-tertiary hover:text-accent-danger transition-colors" aria-label="Cancel"><Trash2 size={16} /></button>
          <button onClick={handleStop} className="w-8 h-8 rounded-full bg-accent-danger flex items-center justify-center text-white hover:brightness-110 transition-all" aria-label="Stop recording"><Square size={12} /></button>
        </>
      ) : (
        <>
          <Mic size={16} className="text-primary" />
          <span className="text-body text-text-secondary font-mono">{formatTime(duration)}</span>
          {atCap && (
            <span className="micro-label text-accent-warning" role="status" aria-live="polite">Max length</span>
          )}
          <div className="flex-1 h-1 bg-white/10 rounded-full">
            <div className="h-full bg-primary/40 rounded-full" style={{ width: '100%' }} />
          </div>
          <button onClick={onCancel} className="p-1.5 text-text-tertiary hover:text-accent-danger transition-colors" aria-label="Discard"><Trash2 size={16} /></button>
          <button onClick={() => onSend(duration)} className="w-8 h-8 rounded-full bg-primary flex items-center justify-center text-bg-0 hover:shadow-glow transition-all" aria-label="Send voice message"><Send size={12} /></button>
        </>
      )}
    </div>
  );
};

interface VoiceMessagePlayerProps {
  duration: number;
  senderName: string;
}

export const VoiceMessagePlayer: React.FC<VoiceMessagePlayerProps> = ({ duration, senderName }) => {
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const formatTime = (s: number) => `${Math.floor(s / 60)}:${(s % 60).toString().padStart(2, '0')}`;

  useEffect(() => {
    if (playing) {
      intervalRef.current = setInterval(() => {
        setProgress(p => {
          if (p >= duration) {
            setPlaying(false);
            if (intervalRef.current) clearInterval(intervalRef.current);
            return 0;
          }
          return p + 1;
        });
      }, 1000);
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [playing, duration]);

  const togglePlay = () => {
    if (progress >= duration) setProgress(0);
    setPlaying(!playing);
  };

  // Placeholder waveform: a deterministic bar pattern derived from a stable hash
  // of the message (sender + duration), NOT from audio analysis. A real waveform
  // requires decoding the audio attachment; until that's wired up this is a fixed,
  // non-random visual so the same message always renders identically.
  const bars = useMemo(() => {
    const seedSource = `${senderName}|${duration}`;
    let hash = 2166136261;
    for (let i = 0; i < seedSource.length; i++) {
      hash ^= seedSource.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return Array.from({ length: 24 }, (_, i) => {
      // Pseudo-random but fully deterministic per-bar value in the 4–18px range.
      const mixed = Math.imul(hash ^ (i + 1) * 0x9e3779b1, 0x85ebca6b) >>> 0;
      return 4 + (mixed % 15);
    });
  }, [senderName, duration]);

  return (
    <div className="inline-flex items-center gap-2.5 px-4 py-2.5 glass-card rounded-r2 border border-stroke max-w-[320px]">
      <button onClick={togglePlay} className="w-8 h-8 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center text-primary hover:bg-primary/25 transition-all flex-shrink-0">
        {playing ? <Pause size={12} /> : <Play size={12} className="ml-0.5" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className="flex items-end gap-px h-5 mb-1">
          {bars.map((h, i) => (
            <div
              key={i}
              className={`w-1 rounded-full transition-colors ${i / bars.length <= progress / duration ? 'bg-primary' : 'bg-white/15'}`}
              style={{ height: `${h}px` }}
            />
          ))}
        </div>
        <div className="flex justify-between">
          <span className="text-[9px] font-mono text-text-tertiary">{formatTime(playing ? progress : duration)}</span>
          <Mic size={9} className="text-primary/40" />
        </div>
      </div>
    </div>
  );
};
