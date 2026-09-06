import { describe, it } from 'vitest';
import assert from 'node:assert/strict';
import { attachMediaPlayback } from '../playback';
import { Track, Stream, MediaElement, withGlobals } from './support';

describe('call media lifecycle', () => {
  it('keeps video silent and excludes audio tracks from its stream', async () => withGlobals({ MediaStream: Stream }, () => {
    const audio = new Track('audio'); const video = new Track('video'); const source = new Stream([audio, video]); const element = new MediaElement();
    const binding = attachMediaPlayback(element as unknown as HTMLMediaElement, source as unknown as MediaStream, 'video', () => {});
    assert.equal(element.muted, true); assert.deepEqual(element.srcObject?.getTracks(), [video]); binding.dispose();
    assert.equal(element.srcObject, null); assert.equal(element.paused, true); assert.equal(audio.stops + video.stops, 0);
  }));
  it('tracks later audio additions and removes all listeners on dispose', async () => withGlobals({ MediaStream: Stream }, () => {
    const audio = new Track('audio'); const source = new Stream(); const element = new MediaElement(); const states: string[] = [];
    const binding = attachMediaPlayback(element as unknown as HTMLMediaElement, source as unknown as MediaStream, 'audio', state => states.push(state));
    source.addTrack(audio); assert.deepEqual(element.srcObject?.getTracks(), [audio]); binding.dispose(); const count = states.length;
    source.removeTrack(audio); source.addTrack(new Track('audio')); assert.equal(states.length, count); assert.equal(element.srcObject, null);
  }));
  it('makes blocked playback recoverable and ignores stale play failures', async () => withGlobals({ MediaStream: Stream }, async () => {
    const source = new Stream([new Track('audio')]); const element = new MediaElement(); const states: string[] = [];
    let reject: (error: Error) => void = () => {};
    element.result = () => new Promise<void>((_, no) => { reject = no; });
    const binding = attachMediaPlayback(element as unknown as HTMLMediaElement, source as unknown as MediaStream, 'audio', state => states.push(state));
    element.result = null; binding.retry(); reject(Object.assign(new Error('private reason'), { name: 'NotAllowedError' })); await Promise.resolve();
    assert.equal(states[states.length - 1], 'playing'); binding.dispose();
  }));
  it('does not start audio before explicit output routing and supports suspension', async () => withGlobals({ MediaStream: Stream }, () => {
    const source = new Stream([new Track('audio')]); const element = new MediaElement();
    const binding = attachMediaPlayback(element as unknown as HTMLMediaElement, source as unknown as MediaStream, 'audio', () => {}, 8_000, false);
    assert.equal(element.attempts, 0); binding.retry(); assert.equal(element.attempts, 1); binding.suspend(); source.addTrack(new Track('audio')); assert.equal(element.attempts, 1); binding.dispose();
  }));
  it('turns a persistent stall into an actionable error and cancels the timer on disposal', async () => withGlobals({ MediaStream: Stream }, async () => {
    const element = new MediaElement(); const source = new Stream([new Track('audio')]); const states: string[] = [];
    const binding = attachMediaPlayback(element as unknown as HTMLMediaElement, source as unknown as MediaStream, 'audio', state => states.push(state), 10);
    await Promise.resolve(); element.dispatchEvent(new Event('stalled')); await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(states[states.length - 1], 'error');
    binding.retry(); element.dispatchEvent(new Event('stalled')); binding.dispose(); const count = states.length; await new Promise(resolve => setTimeout(resolve, 25)); assert.equal(states.length, count);
  }));
});

