import React from 'react';
import { Loader2, AlertTriangle, Wifi } from 'lucide-react';
import { useNativeEngine } from '@/native/engine/provider';
import type { EngineActivityPhase } from '@/native/engine/engine';

const TRANSIENT: EngineActivityPhase[] = ['starting', 'decrypting', 'connecting-relay', 'discovering-peers', 'syncing'];

/**
 * Compact, always-visible indicator of what the engine is doing right now
 * (connecting, syncing, connected, or trouble). Reuses the engine's activity
 * phase so the user is never left wondering "is it still working?".
 */
export const ConnectionActivityPill: React.FC = () => {
  const { activity } = useNativeEngine();
  const { phase, message, detail } = activity;

  // Nothing meaningful to show before the engine reports a phase, or during
  // background relay reconnects (handled silently by the engine).
  if (phase === 'idle' || phase === 'reconnecting-relay') return null;

  // Native hover tooltip. The engine only surfaces phase/message/detail — there
  // is no latency or peer-count telemetry to expose, so we explain the current
  // network state with the data we actually have.
  const tooltip = [message, detail].filter(Boolean).join(' — ') || 'Network status';

  if (phase === 'error') {
    return (
      <div
        role="status"
        title={tooltip}
        aria-label={`Network status: ${tooltip}`}
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-danger/10 border border-accent-danger/20 text-accent-danger text-[10px] font-medium cursor-help"
      >
        <AlertTriangle size={11} className="flex-shrink-0" />
        <span className="truncate">{message || 'Connection problem'}</span>
      </div>
    );
  }

  if (phase === 'connected') {
    return (
      <div
        role="status"
        title="Connected to the xorein network"
        aria-label="Network status: connected to the xorein network"
        className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-accent-success/10 border border-accent-success/20 text-accent-success text-[10px] font-medium cursor-help"
      >
        <Wifi size={11} className="flex-shrink-0" />
        <span className="truncate">Connected</span>
      </div>
    );
  }

  const animate = TRANSIENT.includes(phase);
  return (
    <div
      role="status"
      title={tooltip}
      aria-label={`Network status: ${tooltip}`}
      className="flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-primary/10 border border-primary/20 text-primary text-[10px] font-medium cursor-help"
    >
      <Loader2 size={11} className={`flex-shrink-0 ${animate ? 'animate-spin' : ''}`} />
      <span className="truncate">{message || 'Working…'}</span>
    </div>
  );
};
