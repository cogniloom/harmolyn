// Streamer Mode — selective blur instead of a full-screen blocker.
//
// When active: a top bar announces it, sensitive PII (account IDs, fingerprints)
// is always blurred, and inside a server the channel list / chat / member list are
// blurred behind a "reveal for this server" card. Revealing is per-server and
// resets when you switch servers. Server icons stay sharp and clickable.
//
// Back-compat: stays in sync with the existing `harmolyn:settings:streamer-mode`
// localStorage key + `harmolyn:streamer-mode` event (Settings toggle, Ctrl+Shift+S).
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { EyeOff, Eye, MonitorPlay } from 'lucide-react';

const KEY = 'harmolyn:settings:streamer-mode';
const EVENT = 'harmolyn:streamer-mode';

interface StreamerContextValue {
  active: boolean;
  setActive: (v: boolean) => void;
  toggle: () => void;
  revealedServerId: string | null;
  revealForServer: (serverId: string) => void;
  reblur: () => void;
}

const StreamerContext = createContext<StreamerContextValue>({
  active: false,
  setActive: () => undefined,
  toggle: () => undefined,
  revealedServerId: null,
  revealForServer: () => undefined,
  reblur: () => undefined,
});

export function useStreamerMode(): StreamerContextValue {
  return useContext(StreamerContext);
}

/** Class to blur always-sensitive PII (account IDs, fingerprints) while active. */
export function usePiiBlurClass(): string {
  const { active } = useStreamerMode();
  return active ? 'blur-[6px] select-none' : '';
}

function readActive(): boolean {
  try { return localStorage.getItem(KEY) === 'true'; } catch { return false; }
}

export function StreamerModeProvider({ activeServerId, children }: { activeServerId?: string | null; children: React.ReactNode }) {
  const [active, setActiveState] = useState<boolean>(readActive);
  const [revealedServerId, setRevealedServerId] = useState<string | null>(null);

  // Stay in sync with external toggles (Settings switch, Ctrl/Cmd+Shift+S).
  useEffect(() => {
    const handler = (e: Event) => {
      const enabled = Boolean((e as CustomEvent<{ enabled: boolean }>).detail?.enabled);
      setActiveState(enabled);
      if (!enabled) setRevealedServerId(null);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  // Per-server reveal resets whenever the active server changes.
  useEffect(() => { setRevealedServerId(null); }, [activeServerId]);

  const setActive = useCallback((v: boolean) => {
    setActiveState(v);
    try { localStorage.setItem(KEY, String(v)); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(EVENT, { detail: { enabled: v } }));
    if (!v) setRevealedServerId(null);
  }, []);

  const toggle = useCallback(() => setActive(!readActive()), [setActive]);
  const revealForServer = useCallback((serverId: string) => setRevealedServerId(serverId), []);
  const reblur = useCallback(() => setRevealedServerId(null), []);

  return (
    <StreamerContext.Provider value={{ active, setActive, toggle, revealedServerId, revealForServer, reblur }}>
      {children}
    </StreamerContext.Provider>
  );
}

/** Slim top bar shown while streamer mode is active (never blocks the UI). */
export function StreamerTopBar() {
  const { active, setActive, revealedServerId, reblur } = useStreamerMode();
  if (!active) return null;
  return (
    <div className="fixed top-0 inset-x-0 z-[260] flex justify-center pointer-events-none">
      <div className="mt-2 pointer-events-auto flex items-center gap-3 px-4 py-2 rounded-full bg-accent-danger/15 border border-accent-danger/30 backdrop-blur-xl shadow-2xl">
        <MonitorPlay size={15} className="text-accent-danger" />
        <span className="text-xs font-bold text-white">Streamer Mode active</span>
        <span className="text-[10px] text-white/45 hidden sm:inline">Sensitive info is hidden</span>
        {revealedServerId && (
          <button type="button" onClick={reblur} className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/10 hover:bg-white/20 text-white text-[10px] font-bold transition-all">
            <EyeOff size={11} /> Re-blur
          </button>
        )}
        <button type="button" onClick={() => setActive(false)} className="flex items-center gap-1.5 px-3 py-1 rounded-full bg-white/5 hover:bg-white/15 text-white/70 text-[10px] font-bold transition-all">
          <Eye size={11} /> Turn off
        </button>
      </div>
    </div>
  );
}

/**
 * Centered "reveal this server" card shown over the blurred channel/chat/member
 * region when streamer mode is active and the current server isn't revealed.
 */
export function StreamerServerReveal({ serverId }: { serverId?: string | null }) {
  const { active, revealedServerId, revealForServer } = useStreamerMode();
  if (!active || !serverId || revealedServerId === serverId) return null;
  return (
    <div
      className="absolute inset-0 z-[180] flex flex-col items-center justify-center gap-4 pointer-events-auto"
      style={{ backdropFilter: 'blur(16px)', WebkitBackdropFilter: 'blur(16px)', background: 'rgba(5,7,13,0.35)' }}
    >
      <div className="w-14 h-14 rounded-full bg-accent-danger/10 border border-accent-danger/25 flex items-center justify-center text-accent-danger">
        <EyeOff size={26} />
      </div>
      <div className="text-center">
        <div className="text-white font-bold text-lg font-display">Streamer Mode active</div>
        <div className="text-white/45 text-sm max-w-xs mt-1">Channels, messages and the member list are hidden so they don’t leak on your stream.</div>
      </div>
      <button
        type="button"
        onClick={() => serverId && revealForServer(serverId)}
        className="flex items-center gap-2 px-5 py-2.5 rounded-full bg-primary text-bg-0 font-bold text-sm hover:shadow-glow transition-all"
      >
        <Eye size={15} /> Show this Space
      </button>
      <div className="text-white/25 text-[11px]">Resets when you switch Spaces · re-blur from the top bar</div>
    </div>
  );
}

/** True when the current server's content should be blurred right now. */
export function useServerContentBlurred(serverId?: string | null): boolean {
  const { active, revealedServerId } = useStreamerMode();
  return Boolean(active && serverId && revealedServerId !== serverId);
}
