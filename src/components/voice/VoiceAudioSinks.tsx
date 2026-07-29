// VoiceAudioSinks — renders one hidden <audio autoPlay> per remote participant
// in the active voice session. Attaching srcObject on the join gesture (which is
// a user-initiated action) satisfies the browser autoplay policy.
//
// EVENT-DRIVEN: subscribes to VoiceSession.onRosterChanged so a newly attached
// remote stream reaches its DOM sink within one render of the track arriving
// (the old 500ms poll added up to half a second of dead air on join/renegotiate).
//
// Mount once in Layout.tsx near the existing `connectedVoiceSession` computation.
import React, { useEffect, useRef, useState } from 'react';
import { getVoiceSession } from '@/native/voice/registry';

/** Speaker device + output volume from the Audio & Video settings (best-effort). */
function readSpeakerPrefs(): { deviceId: string; volume: number } {
  try {
    const raw = localStorage.getItem('harmolyn:settings:audio-video');
    const p = raw ? JSON.parse(raw) : {};
    return {
      deviceId: typeof p.speakerDevice === 'string' ? p.speakerDevice : 'default',
      volume: typeof p.speakerVolume === 'number' ? p.speakerVolume : 100,
    };
  } catch {
    return { deviceId: 'default', volume: 100 };
  }
}

interface SinkEntry {
  peerId: string;
  stream: MediaStream;
}

interface Props {
  channelId: string | null;
  /** When deafened, all incoming audio is silenced (in addition to mic mute). */
  deafened?: boolean;
}

export function VoiceAudioSinks({ channelId, deafened = false }: Props) {
  const [sinks, setSinks] = useState<SinkEntry[]>([]);

  useEffect(() => {
    if (!channelId) {
      setSinks([]);
      return;
    }

    // Snapshot the live session's remoteStreamsMap into React state.
    // VoiceSession is mutable; re-read the map on every notify. Skips the state
    // update when nothing changed so fallback ticks don't cause re-renders.
    const sync = () => {
      const s = getVoiceSession(channelId);
      const next: SinkEntry[] = s
        ? Array.from(s.remoteStreamsMap.entries()).map(([pid, stream]) => ({ peerId: pid, stream }))
        : [];
      setSinks(prev =>
        prev.length === next.length && prev.every((p, i) => p.peerId === next[i].peerId && p.stream === next[i].stream)
          ? prev
          : next);
    };

    // Event-driven attach: the session notifies on every remote-stream change.
    // subscribe() also handles the session being created/replaced after mount.
    let unsubscribe: (() => void) | null = null;
    let subscribed: ReturnType<typeof getVoiceSession> = null;
    const subscribe = () => {
      const s = getVoiceSession(channelId);
      if (s === subscribed) return;
      unsubscribe?.();
      subscribed = s;
      unsubscribe = s ? s.onRosterChanged(sync) : null;
    };

    subscribe();
    sync();

    // FALLBACK ONLY: a low-frequency re-sync as a safety net against a missed
    // event (or a session that appeared after mount). The onRosterChanged
    // subscription above is the primary update path.
    const fallback = setInterval(() => { subscribe(); sync(); }, 2000);

    return () => {
      clearInterval(fallback);
      unsubscribe?.();
    };
  }, [channelId]);

  return (
    <>
      {sinks.map(({ peerId, stream }) => (
        <React.Fragment key={peerId}>
          <AudioSink peerId={peerId} stream={stream} muted={deafened} />
        </React.Fragment>
      ))}
    </>
  );
}

function AudioSink({ peerId, stream, muted }: { peerId: string; stream: MediaStream; muted: boolean }) {
  const ref = useRef<HTMLAudioElement>(null);

  // Deafen state lives in its own effect (covering mount + toggles) so a mute
  // flip never re-runs the attach effect below and restarts playback.
  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    // Route to the chosen output device + apply the output volume (both were
    // previously stored but never honoured).
    const { deviceId, volume } = readSpeakerPrefs();
    el.volume = Math.min(1, Math.max(0, volume / 100));
    const sinkable = el as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (deviceId && deviceId !== 'default' && typeof sinkable.setSinkId === 'function') {
      void sinkable.setSinkId(deviceId).catch(() => { /* permission/unsupported — system default */ });
    }
    el.play().catch(() => {
      // Autoplay may be blocked on some browsers without a recent user gesture.
      // The join click is a gesture, so this should succeed; log and continue.
      console.warn('[VoiceAudioSink] autoplay blocked for peer', peerId);
    });
    return () => {
      el.srcObject = null;
    };
  }, [stream, peerId]);

  // Hidden — audio only, no visual element needed.
  return <audio ref={ref} autoPlay style={{ display: 'none' }} aria-hidden="true" />;
}
