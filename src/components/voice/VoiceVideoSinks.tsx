// VoiceVideoSinks — the in-call video stage.
//
// Renders remote SCREEN shares as large tiles (click to fullscreen), remote
// CAMERA feeds as smaller thumbnails, and a self-preview of your own screen share.
// Polls the live VoiceSession (which is mutable and outside the React snapshot)
// for its remote camera/screen stream maps.
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
      className={`relative group/tile rounded-xl overflow-hidden border border-white/10 bg-black shadow-2xl ${isScreen ? 'w-[340px] h-[191px]' : 'w-[140px] h-[105px]'}`}
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
          className="absolute top-1.5 right-1.5 p-1.5 rounded-lg bg-black/50 text-white/80 opacity-0 group-hover/tile:opacity-100 hover:bg-black/70 transition-all"
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
    const collect = () => {
      const session = getVoiceSession(channelId);
      if (!session) { setTiles([]); return; }
      const next: Tile[] = [];
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
      setTiles(next);
    };
    collect();
    const id = setInterval(collect, 600);
    return () => clearInterval(id);
  }, [channelId]);

  if (tiles.length === 0) return null;

  return (
    <div className="fixed bottom-24 right-4 z-[120] flex flex-col items-end gap-2 max-h-[70vh] overflow-y-auto pointer-events-auto">
      {tiles.map((tile) => (
        <React.Fragment key={tile.key}><VideoTile tile={tile} /></React.Fragment>
      ))}
    </div>
  );
}
