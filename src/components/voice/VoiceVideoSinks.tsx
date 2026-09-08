import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, MonitorUp, Video as VideoIcon, ChevronDown, ChevronUp, Play } from 'lucide-react';
import { getVoiceSession, subscribeVoiceSession } from '@/native/voice/registry';
import { resolveFeatureFlag } from '@/config/featureFlags';
import { shortFingerprint } from '@/lib/peerLabel';
import { attachMediaPlayback, type PlaybackState } from '@/lib/stabilization/playback';

interface Tile { key: string; peerId: string; stream: MediaStream; kind: 'screen' | 'camera'; self?: boolean }

function VideoTile({ tile }: { tile: Tile }) {
  const ref = useRef<HTMLVideoElement>(null);
  const retry = useRef<(() => void) | null>(null);
  const [status, setStatus] = useState<PlaybackState>('waiting');
  useEffect(() => {
    if (!ref.current) return;
    const binding = attachMediaPlayback(ref.current, tile.stream, 'video', setStatus);
    retry.current = binding.retry;
    return () => { retry.current = null; binding.dispose(); };
  }, [tile.stream]);
  const isScreen = tile.kind === 'screen';
  const label = tile.self ? 'Your screen' : `${shortFingerprint(tile.peerId, 6, 4)} · ${isScreen ? 'screen' : 'camera'}`;
  return <div className="relative min-w-0 overflow-hidden rounded-lg border border-white/10 bg-black">
    <video ref={ref} playsInline muted aria-label={label} className="aspect-video w-full object-contain" />
    {(status === 'blocked' || status === 'error') && <div className="absolute inset-0 flex items-center justify-center bg-black/80"><button type="button" onClick={() => retry.current?.()} className="flex items-center gap-2 rounded-lg bg-white/10 px-3 text-sm text-white"><Play size={16} />Retry video</button></div>}
    <div className="flex min-w-0 items-center gap-2 px-2 text-xs text-white/80">
      {isScreen ? <MonitorUp size={14} /> : <VideoIcon size={14} />}
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <button type="button" aria-label={`Fullscreen ${label}`} onClick={() => { void ref.current?.requestFullscreen?.().catch(() => undefined); }}><Maximize2 size={18} /></button>
    </div>
  </div>;
}

export function VoiceVideoSinks({ channelId }: { channelId?: string | null }) {
  const [snapshot, setSnapshot] = useState<{ channelId?: string | null; tiles: Tile[] }>({ tiles: [] });
  const [minimized, setMinimized] = useState(false);
  const enabled = resolveFeatureFlag('voiceVideo');
  const tiles = enabled && snapshot.channelId === channelId ? snapshot.tiles : [];
  useEffect(() => {
    if (!channelId || !enabled) return;
    let subscribed: ReturnType<typeof getVoiceSession> = null;
    let unsubscribe: (() => void) | undefined;
    const collect = () => {
      const session = getVoiceSession(channelId);
      const next: Tile[] = [];
      if (session) {
        if (session.localScreenStream?.getVideoTracks().some(track => track.readyState !== 'ended')) next.push({ key: `${channelId}:self:screen`, peerId: 'self', stream: session.localScreenStream, kind: 'screen', self: true });
        for (const [peerId, stream] of session.remoteScreensMap) if (stream.getVideoTracks().some(track => track.readyState !== 'ended')) next.push({ key: `${channelId}:${peerId}:screen`, peerId, stream, kind: 'screen' });
        for (const [peerId, stream] of session.remoteStreamsMap) if (stream.getVideoTracks().some(track => track.readyState !== 'ended')) next.push({ key: `${channelId}:${peerId}:camera`, peerId, stream, kind: 'camera' });
      }
      setSnapshot(previous => previous.channelId === channelId && previous.tiles.length === next.length && previous.tiles.every((tile, index) => tile.key === next[index].key && tile.stream === next[index].stream) ? previous : { channelId, tiles: next });
    };
    const bind = () => {
      const session = getVoiceSession(channelId);
      if (session !== subscribed) { unsubscribe?.(); subscribed = session; unsubscribe = session?.onRosterChanged(collect); }
      collect();
    };
    const releaseRegistry = subscribeVoiceSession(channelId, bind);
    bind();
    return () => { releaseRegistry(); unsubscribe?.(); };
  }, [channelId, enabled]);
  if (!tiles.length) return null;
  return <section className="voice-stage appearance-media-island" aria-label="Call video">
    <button type="button" className="flex w-full shrink-0 items-center gap-2 px-3 text-sm text-white/90" aria-expanded={!minimized} onClick={() => setMinimized(value => !value)}>
      <VideoIcon size={18} /><span className="flex-1 text-left">Video · {tiles.length}</span><span className="text-xs">{minimized ? 'Show' : 'Minimize'}</span>{minimized ? <ChevronUp size={18} /> : <ChevronDown size={18} />}
    </button>
    {!minimized && <div className="voice-stage-body">{tiles.map(tile => <VideoTile key={tile.key} tile={tile} />)}</div>}
  </section>;
}
