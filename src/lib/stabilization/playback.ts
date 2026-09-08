export type PlaybackState = 'waiting' | 'playing' | 'blocked' | 'error';

/**
 * A DOM sink owns only its derived stream, listeners and timers, never session tracks.
 * Audio/video are separated so camera tiles cannot bypass output volume or deafen.
 */
export function attachMediaPlayback(
  element: HTMLMediaElement,
  source: MediaStream,
  kind: 'audio' | 'video',
  notify: (state: PlaybackState) => void,
  stallMs = 8_000,
  autoplay = true,
): { retry: () => void; suspend: () => void; dispose: () => void } {
  const output = new MediaStream();
  const ended = new Map<MediaStreamTrack, () => void>();
  let disposed = false;
  let attempt = 0;
  let allowedToPlay = autoplay;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let last: PlaybackState | null = null;
  const clearTimer = () => { if (timer !== null) clearTimeout(timer); timer = null; };
  const report = (state: PlaybackState) => {
    if (disposed || state === last) return;
    last = state;
    notify(state);
  };
  const stalled = () => {
    if (disposed || !allowedToPlay || output.getTracks().length === 0) return;
    report('waiting');
    if (timer === null) timer = setTimeout(() => { timer = null; report('error'); }, stallMs);
  };
  const playing = () => { clearTimer(); report('playing'); };
  const failed = () => { clearTimer(); report('error'); };
  const retry = () => {
    allowedToPlay = true;
    if (disposed || output.getTracks().length === 0) return;
    const current = ++attempt;
    clearTimer();
    stalled();
    try {
      void Promise.resolve(element.play()).then(() => {
        if (!disposed && current === attempt && !element.paused && element.readyState >= 2) playing();
      }, error => {
        if (disposed || current !== attempt) return;
        clearTimer();
        // Never propagate raw media errors, SDP, device IDs or peer IDs to the UI/log.
        report(error && typeof error === 'object' && error.name === 'NotAllowedError' ? 'blocked' : 'error');
      });
    } catch { failed(); }
  };
  const sync = () => {
    if (disposed) return;
    const tracks = source.getTracks().filter(track => track.kind === kind && track.readyState !== 'ended');
    for (const track of output.getTracks()) if (!tracks.includes(track)) output.removeTrack(track);
    for (const [track, handler] of ended) {
      if (!tracks.includes(track)) { track.removeEventListener('ended', handler); ended.delete(track); }
    }
    for (const track of tracks) {
      if (!output.getTracks().includes(track)) output.addTrack(track);
      if (!ended.has(track)) {
        const handler = () => sync();
        ended.set(track, handler);
        track.addEventListener('ended', handler);
      }
    }
    if (tracks.length && allowedToPlay) retry();
    else { attempt++; clearTimer(); element.pause(); report('waiting'); }
  };
  // A video element is always silent, even before the first effect/track arrives.
  if (kind === 'video') element.muted = true;
  element.srcObject = output;
  element.addEventListener('playing', playing);
  element.addEventListener('waiting', stalled);
  element.addEventListener('stalled', stalled);
  element.addEventListener('error', failed);
  source.addEventListener('addtrack', sync);
  source.addEventListener('removetrack', sync);
  sync();
  return {
    retry,
    suspend() { allowedToPlay = false; attempt++; clearTimer(); element.pause(); report('waiting'); },
    dispose() {
      if (disposed) return;
      disposed = true;
      attempt++;
      clearTimer();
      source.removeEventListener('addtrack', sync);
      source.removeEventListener('removetrack', sync);
      for (const [track, handler] of ended) track.removeEventListener('ended', handler);
      ended.clear();
      element.removeEventListener('playing', playing);
      element.removeEventListener('waiting', stalled);
      element.removeEventListener('stalled', stalled);
      element.removeEventListener('error', failed);
      element.pause();
      if (element.srcObject === output) element.srcObject = null;
      for (const track of output.getTracks()) output.removeTrack(track);
    },
  };
}
