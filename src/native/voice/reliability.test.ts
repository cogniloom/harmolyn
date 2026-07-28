import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  IceCandidateBuffer, ReconnectScheduler,
  electVoiceCoordinator, isVoiceCoordinator, sfuConnectTargets, hasTurnServer,
} from './reliability';

const cand = (s: string): RTCIceCandidateInit => ({ candidate: s, sdpMid: '0', sdpMLineIndex: 0 });

describe('IceCandidateBuffer', () => {
  it('buffers candidates that arrive before the remote description', () => {
    const b = new IceCandidateBuffer();
    expect(b.isReady).toBe(false);
    expect(b.accept(cand('a'))).toEqual([]); // buffered, not applied
    expect(b.accept(cand('b'))).toEqual([]);
    expect(b.bufferedCount).toBe(2);
  });

  it('flushes buffered candidates in arrival order once ready', () => {
    const b = new IceCandidateBuffer();
    b.accept(cand('a'));
    b.accept(cand('b'));
    b.markRemoteReady();
    const flushed = b.flush();
    expect(flushed.map(c => c.candidate)).toEqual(['a', 'b']);
    expect(b.bufferedCount).toBe(0);
  });

  it('applies immediately (returns the candidate) once ready', () => {
    const b = new IceCandidateBuffer();
    b.markRemoteReady();
    expect(b.accept(cand('late')).map(c => c.candidate)).toEqual(['late']);
  });

  it('reset re-closes the gate and drops buffered candidates (ICE restart)', () => {
    const b = new IceCandidateBuffer();
    b.markRemoteReady();
    b.reset();
    expect(b.isReady).toBe(false);
    expect(b.accept(cand('x'))).toEqual([]); // buffered again
  });
});

describe('ReconnectScheduler', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('schedules a reconnect after a backed-off delay and fires it once', () => {
    const s = new ReconnectScheduler({ initialMs: 100, maxMs: 1000, factor: 2, jitterMs: 0 });
    const cb = vi.fn();
    const delay = s.schedule(cb);
    expect(delay).toBe(100);
    expect(s.scheduled).toBe(true);
    expect(cb).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);
    expect(cb).toHaveBeenCalledOnce();
    expect(s.scheduled).toBe(false);
  });

  it('does not double-schedule while an attempt is pending', () => {
    const s = new ReconnectScheduler({ initialMs: 100, maxMs: 1000, factor: 2, jitterMs: 0 });
    expect(s.schedule(vi.fn())).toBe(100);
    expect(s.schedule(vi.fn())).toBeNull();
  });

  it('backs off exponentially across successive attempts', () => {
    const s = new ReconnectScheduler({ initialMs: 100, maxMs: 10_000, factor: 2, jitterMs: 0 });
    expect(s.schedule(vi.fn())).toBe(100);
    vi.advanceTimersByTime(100);
    expect(s.schedule(vi.fn())).toBe(200);
    vi.advanceTimersByTime(200);
    expect(s.schedule(vi.fn())).toBe(400);
  });

  it('stops after the max attempts are exhausted', () => {
    const s = new ReconnectScheduler({ initialMs: 10, maxMs: 100, factor: 2, jitterMs: 0 }, 2);
    expect(s.schedule(vi.fn())).not.toBeNull();
    vi.advanceTimersByTime(10);
    expect(s.schedule(vi.fn())).not.toBeNull();
    vi.advanceTimersByTime(20);
    expect(s.schedule(vi.fn())).toBeNull(); // budget spent
  });

  it('cancel stops a pending fire; reset restores the attempt budget', () => {
    const s = new ReconnectScheduler({ initialMs: 100, maxMs: 1000, factor: 2, jitterMs: 0 }, 2);
    const cb = vi.fn();
    s.schedule(cb);
    s.cancel();
    vi.advanceTimersByTime(1000);
    expect(cb).not.toHaveBeenCalled();
    // Budget was consumed by the cancelled attempt; reset clears it.
    s.schedule(vi.fn());
    expect(s.schedule(vi.fn())).toBeNull();
    s.reset();
    expect(s.attemptCount).toBe(0);
    expect(s.schedule(vi.fn())).toBe(100);
  });
});

describe('coordinator election', () => {
  it('elects the lexicographically-smallest peer id, order-independent', () => {
    const roster = ['peerC', 'peerA', 'peerB'];
    expect(electVoiceCoordinator('peerC', roster)).toBe('peerA');
    expect(electVoiceCoordinator('peerA', [...roster].reverse())).toBe('peerA');
  });

  it('every participant converges on the same coordinator', () => {
    const roster = ['zeta', 'alpha', 'mid'];
    const elected = roster.map(me => electVoiceCoordinator(me, roster));
    expect(new Set(elected).size).toBe(1);
    expect(elected[0]).toBe('alpha');
  });

  it('a lone peer is its own coordinator', () => {
    expect(electVoiceCoordinator('solo', ['solo'])).toBe('solo');
    expect(isVoiceCoordinator('solo', ['solo'])).toBe(true);
  });

  it('sfuConnectTargets: coordinator connects to all others, members only to the coordinator', () => {
    const roster = ['alpha', 'mid', 'zeta'];
    expect(sfuConnectTargets('alpha', roster).sort()).toEqual(['mid', 'zeta']); // coordinator ↔ all
    expect(sfuConnectTargets('mid', roster)).toEqual(['alpha']);                // member ↔ coordinator
    expect(sfuConnectTargets('zeta', roster)).toEqual(['alpha']);
  });
});

describe('hasTurnServer', () => {
  it('detects a TURN url among the ICE servers', () => {
    expect(hasTurnServer([{ urls: 'turn:relay.example:3478' }])).toBe(true);
    expect(hasTurnServer([{ urls: ['stun:a', 'turns:b'] }])).toBe(true);
  });
  it('is false for a STUN-only configuration', () => {
    expect(hasTurnServer([{ urls: ['stun:stun.l.google.com:19302'] }])).toBe(false);
    expect(hasTurnServer([])).toBe(false);
  });
});
