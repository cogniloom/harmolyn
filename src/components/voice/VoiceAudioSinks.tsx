// VoiceAudioSinks — renders one hidden <audio autoPlay> per remote participant
// in the active voice session. Attaching srcObject on the join gesture (which is
// a user-initiated action) satisfies the browser autoplay policy.
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
  // Track the last channelId to reset when leaving.
  const prevChannelIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!channelId) {
      setSinks([]);
      prevChannelIdRef.current = null;
      return;
    }

    if (channelId !== prevChannelIdRef.current) {
      setSinks([]);
      prevChannelIdRef.current = channelId;
    }

    const session = getVoiceSession(channelId);
    if (!session) return;

    // Register callbacks so we update when remote streams arrive or leave.
    // VoiceSession is mutable; re-read remoteStreamsMap on callback.
    const sync = () => {
      const s = getVoiceSession(channelId);
      if (!s) { setSinks([]); return; }
      setSinks(Array.from(s.remoteStreamsMap.entries()).map(([pid, stream]) => ({ peerId: pid, stream })));
    };

    // Poll at 500ms until the session stabilises (streams may arrive after mount).
    const interval = setInterval(sync, 500);
    sync();
    return () => clearInterval(interval);
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

  useEffect(() => { if (ref.current) ref.current.muted = muted; }, [muted]);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.srcObject = stream;
    el.muted = muted;
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
