// VoiceVideoSinks — the in-call video stage.
//
// Renders remote SCREEN shares as large tiles (click to fullscreen), remote
// CAMERA feeds as smaller thumbnails, and a self-preview of your own screen share.
// EVENT-DRIVEN: subscribes to the live VoiceSession (which is mutable and outside
// the React snapshot) via onRosterChanged, so a new share/camera tile mounts
// within one render of the track arriving; a low-frequency fallback re-sync
// guards against a missed event.
import React, { useEffect, useRef, useState } from 'react';
import { Maximize2, MonitorUp, Video as VideoIcon } from 'lucide-react';
import { getVoiceSession } from '@/native/voice/registry';
import { resolveFeatureFlag } from '@/config/featureFlags';
import { shortFingerprint } from '@/lib/peerLabel';

interface Tile {
  key: string;
  peerId: string;
  stream: MediaStream;
  kind: 'screen' | 'camera';
  self?: boolean;
}

function VideoTile({ tile }: { tile: Tile }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (ref.current && ref.current.srcObject !== tile.stream) ref.current.srcObject = tile.stream;
  }, [tile.stream]);

  const goFullscreen = () => { void ref.current?.requestFullscreen?.().catch(() => undefined); };
  const isScreen = tile.kind === 'screen';
  const label = tile.self ? 'Your screen' : `${shortFingerprint(tile.peerId, 6, 4)}${isScreen ? ' · screen' : ''}`;

  return (
    <div
      className={`group/tile relative max-w-full shrink-0 overflow-hidden rounded-xl border border-white/10 bg-black shadow-2xl ${isScreen ? 'aspect-video w-[min(340px,100%)]' : 'aspect-[4/3] w-[140px]'}`}
    >
      <video ref={ref} autoPlay playsInline muted={tile.self} className="w-full h-full object-contain bg-black" />
      <div className="absolute bottom-0 inset-x-0 px-2 py-1 bg-gradient-to-t from-black/80 to-transparent flex items-center gap-1.5">
        {isScreen ? <MonitorUp size={11} className="text-accent-success shrink-0" /> : <VideoIcon size={11} className="text-white/70 shrink-0" />}
        <span className="text-[10px] text-white/90 font-medium truncate">{label}</span>
      </div>
      {isScreen && (
        <button
          type="button"
          onClick={goFullscreen}
          aria-label="Fullscreen"
          className="compact-touch-target absolute right-1.5 top-1.5 flex items-center justify-center rounded-lg bg-black/60 p-1.5 text-white/90 opacity-80 transition-all hover:bg-black/80 hover:opacity-100 focus-visible:opacity-100"
        >
          <Maximize2 size={13} />
        </button>
      )}
    </div>
  );
}

export function VoiceVideoSinks({ channelId }: { channelId?: string | null }) {
  const [tiles, setTiles] = useState<Tile[]>([]);

  useEffect(() => {
    if (!channelId || !resolveFeatureFlag('voiceVideo')) { setTiles([]); return; }

    // Snapshot the live session's stream maps into React state. Skips the state
    // update when nothing changed so fallback ticks don't cause re-renders.
    const collect = () => {
      const session = getVoiceSession(channelId);
      const next: Tile[] = [];
      if (session) {
        // Local screen-share self-preview.
        const localScreen = session.localScreenStream;
        if (localScreen && localScreen.getVideoTracks().length) {
          next.push({ key: 'self:screen', peerId: 'self', stream: localScreen, kind: 'screen', self: true });
        }
        // Remote screen shares (large).
        for (const [peerId, stream] of session.remoteScreensMap) {
          if (stream.getVideoTracks().length) next.push({ key: `${peerId}:screen`, peerId, stream, kind: 'screen' });
        }
        // Remote cameras (thumbnails) — primary streams that carry a video track.
        for (const [peerId, stream] of session.remoteStreamsMap) {
          if (stream.getVideoTracks().length) next.push({ key: `${peerId}:cam`, peerId, stream, kind: 'camera' });
        }
      }
      setTiles(prev =>
        prev.length === next.length && prev.every((t, i) => t.key === next[i].key && t.stream === next[i].stream)
          ? prev
          : next);
    };

    // Event-driven attach: the session notifies on every stream/roster change.
    // subscribe() also handles the session being created/replaced after mount.
    let unsubscribe: (() => void) | null = null;
    let subscribed: ReturnType<typeof getVoiceSession> = null;
    const subscribe = () => {
      const session = getVoiceSession(channelId);
      if (session === subscribed) return;
      unsubscribe?.();
      subscribed = session;
      unsubscribe = session ? session.onRosterChanged(collect) : null;
    };

    subscribe();
    collect();

    // FALLBACK ONLY: a low-frequency re-sync as a safety net against a missed
    // event (or a session that appeared after mount). The onRosterChanged
    // subscription above is the primary update path.
    const fallback = setInterval(() => { subscribe(); collect(); }, 2000);

    return () => {
      clearInterval(fallback);
      unsubscribe?.();
    };
  }, [channelId]);

  if (tiles.length === 0) return null;

  return (
    <div className="no-scrollbar pointer-events-auto fixed bottom-[calc(6rem+env(safe-area-inset-bottom))] left-[max(0.75rem,env(safe-area-inset-left))] right-[max(0.75rem,env(safe-area-inset-right))] z-[120] flex max-h-[calc(100dvh-7rem-env(safe-area-inset-top)-env(safe-area-inset-bottom))] min-h-0 flex-col items-end gap-2 overflow-y-auto overscroll-contain">
      {tiles.map((tile) => (
        <React.Fragment key={tile.key}><VideoTile tile={tile} /></React.Fragment>
      ))}
    </div>
  );
}
