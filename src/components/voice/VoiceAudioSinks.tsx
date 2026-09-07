import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getVoiceSession, subscribeVoiceSession } from '@/native/voice/registry';
import { usePersistentState } from '@/hooks/usePersistentState';
import type { PlaybackState } from '@/lib/stabilization/playback';

import { AudioSink, type SinkEntry } from './AudioSink';

const EMPTY_PREFS: Record<string, unknown> = {};
interface Props { channelId: string | null; deafened?: boolean }

export function VoiceAudioSinks({ channelId, deafened = false }: Props) {
  const [snapshot, setSnapshot] = useState<{ channelId: string | null; sinks: SinkEntry[] }>({ channelId: null, sinks: [] });
  const [problems, setProblems] = useState<Record<string, PlaybackState>>({});
  const retries = useRef(new Map<string, () => void>());
  const [prefs] = usePersistentState('harmolyn:settings:audio-video', EMPTY_PREFS);
  const deviceId = typeof prefs.speakerDevice === 'string' && prefs.speakerDevice !== 'default' ? prefs.speakerDevice : '';
  const volume = typeof prefs.speakerVolume === 'number' && Number.isFinite(prefs.speakerVolume) ? Math.max(0, Math.min(1, prefs.speakerVolume / 100)) : 1;
  // Old-session audio disappears on the render that changes scope, not a later effect.
  const sinks = snapshot.channelId === channelId ? snapshot.sinks : [];

  useEffect(() => {
    if (!channelId) return;
    let subscribed: ReturnType<typeof getVoiceSession> = null;
    let unsubscribe: (() => void) | undefined;
    const collect = () => {
      const session = getVoiceSession(channelId);
      const next: SinkEntry[] = [];
      const seen = new Set<MediaStream>();
      if (session) for (const [kind, map] of [['voice', session.remoteStreamsMap], ['screen', session.remoteScreensMap]] as const) {
        for (const [peerId, stream] of map) {
          if (seen.has(stream)) continue;
          seen.add(stream);
          next.push({ id: `${channelId}:${peerId}:${kind}`, stream });
        }
      }
      setSnapshot(previous => previous.channelId === channelId && previous.sinks.length === next.length && previous.sinks.every((sink, index) => sink.id === next[index].id && sink.stream === next[index].stream) ? previous : { channelId, sinks: next });
    };
    const bind = () => {
      const session = getVoiceSession(channelId);
      if (session !== subscribed) {
        unsubscribe?.();
        subscribed = session;
        unsubscribe = session?.onRosterChanged(collect);
      }
      collect();
    };
    const releaseRegistry = subscribeVoiceSession(channelId, bind);
    bind();
    return () => { releaseRegistry(); unsubscribe?.(); };
  }, [channelId]);

  const onState = useCallback((id: string, state: PlaybackState | null) => {
    setProblems(previous => {
      if (state === 'blocked' || state === 'error') return previous[id] === state ? previous : { ...previous, [id]: state };
      if (!(id in previous)) return previous;
      const next = { ...previous }; delete next[id]; return next;
    });
  }, []);
  const register = useCallback((id: string, retry: (() => void) | null) => {
    if (retry) retries.current.set(id, retry); else retries.current.delete(id);
  }, []);
  const affected = sinks.filter(sink => problems[sink.id]);
  return <>
    {sinks.map(sink => <AudioSink key={sink.id} entry={sink} muted={deafened} deviceId={deviceId} volume={volume} onState={onState} register={register} />)}
    {!deafened && affected.length > 0 && <div className="voice-playback-notice" role="status">
      <span className="min-w-0 flex-1 text-sm">{deviceId ? 'Sound needs attention. Check the selected output in Settings → Audio & Video, then retry.' : 'Sound needs attention. Your browser may have paused playback.'}</span>
      <button type="button" onClick={() => { for (const sink of affected) retries.current.get(sink.id)?.(); }}>Retry sound</button>
    </div>}
  </>;
}

