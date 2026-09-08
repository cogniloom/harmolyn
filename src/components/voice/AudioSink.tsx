import React, { useEffect, useLayoutEffect, useRef } from 'react';
import { attachMediaPlayback, type PlaybackState } from '@/lib/stabilization/playback';

export interface SinkEntry { id: string; stream: MediaStream }

export function AudioSink({ entry, muted, deviceId, volume, onState, register }: {
  entry: SinkEntry; muted: boolean; deviceId: string; volume: number;
  onState: (id: string, state: PlaybackState | null) => void;
  register: (id: string, retry: (() => void) | null) => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const playback = useRef<ReturnType<typeof attachMediaPlayback> | null>(null);
  const routing = useRef(Promise.resolve());
  useLayoutEffect(() => { if (ref.current) { ref.current.muted = muted; ref.current.volume = volume; } }, [muted, volume]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const binding = attachMediaPlayback(element, entry.stream, 'audio', state => onState(entry.id, state), 8_000, false);
    playback.current = binding;
    return () => { binding.dispose(); playback.current = null; register(entry.id, null); onState(entry.id, null); };
  }, [entry.id, entry.stream, onState, register]);
  useEffect(() => {
    const element = ref.current as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (!element) return;
    let active = true;
    const binding = playback.current;
    let outputReady = false;
    // Serialize device changes: an older setSinkId completion cannot win a race.
    const route = () => {
      binding?.suspend();
      outputReady = false;
      routing.current = routing.current.catch(() => undefined).then(async () => {
        if (!active) return;
        if (deviceId && typeof element.setSinkId !== 'function') { onState(entry.id, 'error'); return; }
        if (typeof element.setSinkId === 'function') {
          try { await element.setSinkId(deviceId); }
          catch {
            // Fail closed for an explicitly selected output: no surprise loudspeaker playback.
            if (active) onState(entry.id, 'error');
            return;
          }
        }
        if (active && playback.current === binding) { outputReady = true; binding?.retry(); }
      });
    };
    register(entry.id, () => { if (outputReady) binding?.retry(); else route(); });
    route();
    return () => { active = false; register(entry.id, null); };
  }, [deviceId, entry.id, entry.stream, onState, register]);
  return <audio ref={ref} muted={muted} aria-hidden="true" style={{ display: 'none' }} />;
}
