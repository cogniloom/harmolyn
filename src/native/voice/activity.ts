// Voice activity (speaking) detection.
//
// Taps each participant's MediaStream with a Web Audio AnalyserNode, samples the
// RMS level on a rAF loop, and reports speaking-state TRANSITIONS (with hysteresis
// + a short hangover) so the UI can draw a Discord-style speaking ring without
// flicker. Transitions are debounced to booleans — callers should only re-publish
// the snapshot when the boolean actually flips, never every frame.

export type SpeakingListener = (peerId: string, speaking: boolean) => void;

interface Tap {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  analyser: AnalyserNode;
  data: Uint8Array<ArrayBuffer>;
  speaking: boolean;
  /** Timestamp (ms) until which we keep treating the peer as speaking (hangover). */
  hangoverUntil: number;
}

// RMS thresholds on a 0..1 scale. Start speaking above ON, keep speaking until we
// drop below OFF for the hangover window — hysteresis avoids rapid on/off flicker.
const THRESHOLD_ON = 0.045;
const THRESHOLD_OFF = 0.030;
const HANGOVER_MS = 250;

export class VoiceActivityMonitor {
  private taps = new Map<string, Tap>();
  private raf: number | null = null;
  private readonly listener: SpeakingListener;
  private now: () => number;

  constructor(listener: SpeakingListener) {
    this.listener = listener;
    // Date.now is unavailable in some sandboxes; performance.now is monotonic.
    this.now = typeof performance !== 'undefined' && performance.now
      ? () => performance.now()
      : () => 0;
  }

  /** Begin (or replace) monitoring of a peer's stream. No-op without audio tracks. */
  addStream(peerId: string, stream: MediaStream): void {
    if (typeof window === 'undefined') return;
    const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return;
    if (!stream.getAudioTracks().length) return;
    this.removeStream(peerId);
    try {
      const ctx = new AudioCtx();
      // Resume in case the context starts suspended (autoplay policy).
      void ctx.resume?.().catch(() => undefined);
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.4;
      source.connect(analyser);
      const tap: Tap = {
        ctx,
        source,
        analyser,
        data: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
        speaking: false,
        hangoverUntil: 0,
      };
      this.taps.set(peerId, tap);
      this.ensureLoop();
    } catch {
      /* analyser unavailable for this stream — speaking ring simply won't show */
    }
  }

  removeStream(peerId: string): void {
    const tap = this.taps.get(peerId);
    if (!tap) return;
    try { tap.source.disconnect(); } catch { /* already gone */ }
    try { void tap.ctx.close?.(); } catch { /* already closed */ }
    this.taps.delete(peerId);
    if (tap.speaking) this.listener(peerId, false);
    if (this.taps.size === 0) this.stopLoop();
  }

  stop(): void {
    for (const peerId of Array.from(this.taps.keys())) this.removeStream(peerId);
    this.stopLoop();
  }

  private ensureLoop(): void {
    if (this.raf != null || typeof requestAnimationFrame === 'undefined') return;
    const tick = () => {
      const t = this.now();
      for (const [peerId, tap] of this.taps) {
        tap.analyser.getByteTimeDomainData(tap.data);
        // RMS of the centered waveform (128 == silence midpoint).
        let sum = 0;
        for (let i = 0; i < tap.data.length; i++) {
          const v = (tap.data[i] - 128) / 128;
          sum += v * v;
        }
        const rms = Math.sqrt(sum / tap.data.length);
        if (rms >= THRESHOLD_ON) {
          tap.hangoverUntil = t + HANGOVER_MS;
          if (!tap.speaking) { tap.speaking = true; this.listener(peerId, true); }
        } else if (tap.speaking && rms < THRESHOLD_OFF && t >= tap.hangoverUntil) {
          tap.speaking = false;
          this.listener(peerId, false);
        }
      }
      this.raf = requestAnimationFrame(tick);
    };
    this.raf = requestAnimationFrame(tick);
  }

  private stopLoop(): void {
    if (this.raf != null && typeof cancelAnimationFrame !== 'undefined') {
      cancelAnimationFrame(this.raf);
    }
    this.raf = null;
  }
}
