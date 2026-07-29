
import React, { useEffect, useState } from 'react';
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Settings, Video, MonitorUp, Signal, Activity, ShieldCheck, ShieldAlert } from 'lucide-react';
import { Spinner } from '@/components/ui/Spinner';
import { getVoiceSession } from '@/native/voice/registry';
import { getState } from '@/native/state/store';

/**
 * Honest per-call media security badge. The voice layer records the LIVE mode in
 * voice_sessions[].security_mode ('crowd' only while SFrame genuinely attached;
 * downgraded to 'clear' on any transform failure or missing Insertable Streams) —
 * this surfaces it, so the call never silently rides under the channel header's
 * CROWD text badge while the media is actually DTLS-only. DTLS-only is still
 * peer-to-peer encrypted (TURN sees only SRTP ciphertext), but it is not the
 * channel-key E2EE the text badge claims — the distinction must be visible.
 */
const VoiceModeBadge: React.FC<{ channelId: string | null }> = ({ channelId }) => {
  const [mode, setMode] = useState<string | null>(null);

  useEffect(() => {
    if (!channelId) { setMode(null); return; }
    const tick = () => {
      const session = getState().voice_sessions.find(v => v.channel_id === channelId);
      setMode(session?.security_mode ?? null);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [channelId]);

  if (!mode) return null;
  const e2ee = mode === 'crowd' || mode === 'seal' || mode === 'tree';
  return (
    <span
      data-testid="voice-security-mode"
      className={`text-[9px] font-mono shrink-0 flex items-center gap-1 ${e2ee ? 'text-accent-success' : 'text-accent-warning'}`}
      title={e2ee
        ? 'Call media is end-to-end encrypted with SFrame (channel key) on top of DTLS.'
        : "SFrame is not active for this call — media is protected by peer-to-peer DTLS only. No relay can read it, but it is not encrypted under the channel's Crowd key."}
    >
      {e2ee ? <ShieldCheck size={9} /> : <ShieldAlert size={9} />}
      {e2ee ? 'SFRAME E2EE' : 'DTLS ONLY'}
    </span>
  );
};

/** Live round-trip latency to mesh peers, sampled from RTCPeerConnection stats. */
const LatencyReadout: React.FC<{ channelId: string | null }> = ({ channelId }) => {
  const [agg, setAgg] = useState<{ avg: number; worst: number; lines: string[] } | null>(null);

  useEffect(() => {
    if (!channelId) { setAgg(null); return; }
    const tick = () => {
      const session = getVoiceSession(channelId);
      if (!session) { setAgg(null); return; }
      const stats = session.peerStatsSnapshot();
      const rtts = stats.map(s => s.rttMs).filter((n): n is number => typeof n === 'number');
      if (rtts.length === 0) { setAgg(null); return; }
      setAgg({
        avg: Math.round(rtts.reduce((a, b) => a + b, 0) / rtts.length),
        worst: Math.max(...rtts),
        lines: stats.map(s => `${s.peerId.slice(0, 8)}…  ${s.rttMs == null ? '—' : `${s.rttMs} ms`}${s.jitterMs != null ? ` · ${s.jitterMs} ms jitter` : ''}`),
      });
    };
    tick();
    const id = setInterval(tick, 1500);
    return () => clearInterval(id);
  }, [channelId]);

  if (!agg) return null;
  const color = agg.avg < 80 ? 'text-accent-success' : agg.avg < 200 ? 'text-accent-warning' : 'text-accent-danger';
  return (
    <span
      className={`text-[9px] font-mono shrink-0 flex items-center gap-1 ${color}`}
      title={`Round-trip latency per peer (covers voice + video):\n${agg.lines.join('\n')}`}
    >
      <Activity size={9} /> {agg.avg} ms{agg.lines.length > 1 ? ` · ${agg.worst} max` : ''}
    </span>
  );
};

export interface VoiceControlState {
  statusLabel: string;
  statusDetail: string;
  participantCount: number;
  muted: boolean;
  deafened: boolean;
  videoOn: boolean;
  screenSharing: boolean;
  canInteract: boolean;
  pendingAction: string | null;
  error: string | null;
  sessionAvailable: boolean;
  channelId: string | null;
}

interface VoiceControlBarProps {
  channelName: string;
  state: VoiceControlState;
  onDisconnect: () => void;
  onToggleMute?: () => void;
  onToggleDeafen?: () => void;
  onToggleVideo?: () => void;
  onToggleScreenShare?: () => void;
  onOpenVoiceSettings?: () => void;
}

export const VoiceControlBar: React.FC<VoiceControlBarProps> = ({
  channelName,
  state,
  onDisconnect,
  onToggleMute,
  onToggleDeafen,
  onToggleVideo,
  onToggleScreenShare,
  onOpenVoiceSettings,
}) => {
  const controlsUnavailable = !onToggleMute || !onToggleDeafen || !onToggleVideo;
  const effectiveState = controlsUnavailable && state.canInteract
    ? {
        ...state,
        canInteract: false,
        error: state.error ?? 'Voice controls are unavailable in this shell.',
        statusDetail: 'Voice controls are unavailable in this shell.',
        statusLabel: 'VOICE UNAVAILABLE',
      }
    : state;
  const actionsLocked = !effectiveState.canInteract || Boolean(effectiveState.pendingAction);

  // Global Ctrl+M (mute) / Ctrl+D (deafen) shortcuts. Wired only to the
  // locally-supplied toggle handlers; ignored while controls are locked or
  // while the user is typing into a field so we don't hijack text entry.
  useEffect(() => {
    if (actionsLocked) return;
    if (!onToggleMute && !onToggleDeafen) return;
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      const key = event.key.toLowerCase();
      if (key === 'm' && onToggleMute) {
        event.preventDefault();
        onToggleMute();
      } else if (key === 'd' && onToggleDeafen) {
        event.preventDefault();
        onToggleDeafen();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [actionsLocked, onToggleMute, onToggleDeafen]);

  return (
    <div className="p-3 border-t border-white/5 bg-bg-0/80 backdrop-blur-sm">
      {/* Connection Info */}
      <div className="flex items-center justify-between mb-1.5 gap-3">
        <div className="flex items-center gap-1.5 min-w-0">
          {effectiveState.pendingAction ? (
            <Spinner size={10} className="text-primary" />
          ) : (
            <Signal size={10} className={effectiveState.canInteract ? 'text-accent-success animate-pulse' : 'text-accent-warning'} />
          )}
          <span className={`text-[10px] font-bold tracking-wide truncate ${effectiveState.pendingAction ? 'text-primary' : effectiveState.canInteract ? 'text-accent-success' : 'text-accent-warning'}`}>
            {effectiveState.pendingAction ? 'Connecting…' : effectiveState.statusLabel}
          </span>
        </div>
        <span className="text-[9px] font-mono text-white/30 truncate max-w-[120px]">{channelName}</span>
      </div>

      <div className="flex items-center justify-between gap-3 mb-2.5">
        <span className="text-[9px] font-mono text-white/35 truncate max-w-[120px]">{effectiveState.statusDetail}</span>
        <div className="flex items-center gap-2 shrink-0">
          <VoiceModeBadge channelId={effectiveState.channelId} />
          <LatencyReadout channelId={effectiveState.channelId} />
          <span className="text-[9px] font-mono text-white/20">{effectiveState.participantCount} member{effectiveState.participantCount === 1 ? '' : 's'}</span>
        </div>
      </div>

      {effectiveState.error && (
        <div className="mb-2 text-[9px] font-mono text-accent-danger truncate">{effectiveState.error}</div>
      )}

      {/* Controls */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-1">
          <ControlButton
            active={!effectiveState.muted && !effectiveState.deafened}
            danger={effectiveState.muted || effectiveState.deafened}
            icon={effectiveState.muted || effectiveState.deafened ? <MicOff size={16} /> : <Mic size={16} />}
            label={effectiveState.muted || effectiveState.deafened ? 'Unmute' : 'Mute'}
            title={`${effectiveState.muted || effectiveState.deafened ? 'Unmute' : 'Mute'} (Ctrl+M)`}
            onClick={onToggleMute}
            disabled={actionsLocked || !onToggleMute}
          />
          <ControlButton
            active={!effectiveState.deafened}
            danger={effectiveState.deafened}
            icon={effectiveState.deafened ? <HeadphoneOff size={16} /> : <Headphones size={16} />}
            label={effectiveState.deafened ? 'Undeafen' : 'Deafen'}
            title={`${effectiveState.deafened ? 'Undeafen' : 'Deafen'} (Ctrl+D)`}
            onClick={onToggleDeafen}
            disabled={actionsLocked || !onToggleDeafen}
          />
          <ControlButton
            active={effectiveState.videoOn}
            icon={<Video size={16} />}
            label="Video"
            onClick={onToggleVideo}
            disabled={actionsLocked || !onToggleVideo}
          />
          {onToggleScreenShare && (
            <ControlButton
              active={effectiveState.screenSharing}
              icon={<MonitorUp size={16} />}
              label={effectiveState.screenSharing ? 'Stop Screen Share' : 'Screen Share'}
              onClick={onToggleScreenShare}
              disabled={actionsLocked}
            />
          )}
        </div>

        <div className="flex items-center gap-1">
          {onOpenVoiceSettings && (
            <ControlButton
              active={false}
              icon={<Settings size={14} />}
              label="Voice Settings"
              onClick={onOpenVoiceSettings}
              small
              disabled={Boolean(effectiveState.pendingAction)}
            />
          )}
          <button
            onClick={onDisconnect}
            disabled={Boolean(effectiveState.pendingAction)}
            className="p-2 rounded-full bg-accent-danger/20 text-accent-danger hover:bg-accent-danger/30 transition-all hover:shadow-[0_0_10px_rgba(255,42,109,0.3)] disabled:opacity-40 disabled:cursor-not-allowed focus-ring"
            aria-label="Disconnect"
            title="Leave voice"
          >
            <PhoneOff size={16} />
          </button>
        </div>
      </div>
    </div>
  );
};

const ControlButton = ({ active, danger, icon, label, title, onClick, small, disabled = false }: {
  active: boolean;
  danger?: boolean;
  icon: React.ReactNode;
  label: string;
  title?: string;
  onClick?: () => void;
  small?: boolean;
  disabled?: boolean;
}) => (
  <button
    onClick={onClick}
    disabled={disabled || !onClick}
    className={`
      ${small ? 'p-1.5' : 'p-2'} rounded-full transition-all border focus-ring
      ${disabled || !onClick ? 'opacity-40 cursor-not-allowed' : ''}
      ${danger
        ? 'bg-accent-danger/15 border-accent-danger/20 text-accent-danger hover:bg-accent-danger/25'
        : active
          ? 'bg-white/8 border-white/10 text-white/80 hover:bg-white/12'
          : 'bg-white/5 border-white/5 text-white/40 hover:bg-white/8 hover:text-white/60'
      }
    `}
    aria-label={label}
    title={title ?? label}
  >
    {icon}
  </button>
);
