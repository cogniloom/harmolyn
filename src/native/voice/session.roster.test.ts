// Event-driven roster subscription: VoiceSession.onRosterChanged must fire when
// a remote stream is registered (onRemoteTrack) and when it is removed (peer
// drop / session stop), unsubscribing must stop callbacks, and a throwing
// listener must never break the session or starve other listeners. This is what
// lets VoiceAudioSinks/VoiceVideoSinks attach media within one render of the
// track arriving instead of waiting on the old 500ms poll.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initStore, addServer, setNativeIdentity } from '../state/store.js';
import { VoiceSession } from './session.js';

const ME = 'me-peer';
const ALICE = 'alice-peer';
const SRV = 'srv';
const CHAN = 'voice-chan';

/** Minimal RTCPeerConnection stand-in that records instances + handler
 *  assignments so the test can fire ontrack directly (jsdom has no WebRTC). */
const createdPcs: FakePC[] = [];
class FakePC {
  ontrack: ((e: RTCTrackEvent) => void) | null = null;
  localDescription: { sdp: string } | null = { sdp: 'v=0' };
  iceGatheringState = 'complete';
  signalingState = 'stable';
  connectionState = 'new';
  iceConnectionState = 'new';
  constructor() { createdPcs.push(this); }
  getTransceivers(): unknown[] { return []; }
  getSenders(): unknown[] { return []; }
  addTrack(): Record<string, never> { return {}; }
  async createOffer(): Promise<{ type: string; sdp: string }> { return { type: 'offer', sdp: 'v=0' }; }
  async createAnswer(): Promise<{ type: string; sdp: string }> { return { type: 'answer', sdp: 'v=0' }; }
  async setLocalDescription(): Promise<void> { /* noop */ }
  async setRemoteDescription(): Promise<void> { /* noop */ }
  async addIceCandidate(): Promise<void> { /* noop */ }
  close(): void { /* noop */ }
  addEventListener(): void { /* noop */ }
  removeEventListener(): void { /* noop */ }
}

class FakeTrack {
  readonly kind: string;
  constructor(kind: 'audio' | 'video') { this.kind = kind; }
  addEventListener(): void { /* noop */ }
}

class FakeStream {
  private tracks: FakeTrack[];
  constructor(...tracks: FakeTrack[]) { this.tracks = tracks; }
  getTracks(): FakeTrack[] { return [...this.tracks]; }
  getAudioTracks(): FakeTrack[] { return this.tracks.filter(t => t.kind === 'audio'); }
  getVideoTracks(): FakeTrack[] { return this.tracks.filter(t => t.kind === 'video'); }
  addTrack(t: FakeTrack): void { this.tracks.push(t); }
  addEventListener(): void { /* noop */ }
}

function trackEvent(track: FakeTrack, stream: FakeStream): RTCTrackEvent {
  return {
    track,
    streams: [stream],
    receiver: {},
    transceiver: { mid: '0' },
  } as unknown as RTCTrackEvent;
}

/** Create a session + deliver ALICE's offer so a PeerConn (with ontrack) exists. */
async function sessionWithAlicePeer(): Promise<{ session: VoiceSession; pc: FakePC }> {
  const session = new VoiceSession(CHAN, null, ME, {});
  const resp = await session.handleOffer({ session_id: CHAN, from_peer_id: ALICE, sdp: 'v=0' }, ALICE);
  expect(resp.ok).toBe(true);
  const pc = createdPcs.at(-1);
  if (!pc) throw new Error('no RTCPeerConnection was created');
  return { session, pc };
}

describe('VoiceSession.onRosterChanged', () => {
  beforeEach(() => {
    localStorage.clear();
    createdPcs.length = 0;
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    addServer({ id: SRV, name: 'S', owner_peer_id: ALICE, members: [ME, ALICE],
      channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'war-room', voice: true } } });
    vi.stubGlobal('RTCPeerConnection', FakePC);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('notifies when a remote stream is registered and when the peer is dropped', async () => {
    const { session, pc } = await sessionWithAlicePeer();
    const notified = vi.fn();
    const unsub = session.onRosterChanged(notified);
    try {
      const track = new FakeTrack('audio');
      const stream = new FakeStream(track);
      pc.ontrack?.(trackEvent(track, stream));
      expect(notified).toHaveBeenCalledTimes(1);
      expect(session.remoteStreamsMap.get(ALICE)).toBe(stream as unknown as MediaStream);

      // Peer leaves → stream removed → subscribers notified again.
      session.handlePresence({ session_id: CHAN, action: 'leave' }, ALICE);
      expect(notified).toHaveBeenCalledTimes(2);
      expect(session.remoteStreamsMap.has(ALICE)).toBe(false);
    } finally {
      unsub();
      await session.stop();
    }
  });

  it('unsubscribe stops callbacks', async () => {
    const { session, pc } = await sessionWithAlicePeer();
    const notified = vi.fn();
    const unsub = session.onRosterChanged(notified);
    const track = new FakeTrack('audio');
    const stream = new FakeStream(track);
    pc.ontrack?.(trackEvent(track, stream));
    expect(notified).toHaveBeenCalledTimes(1);

    unsub();
    session.handlePresence({ session_id: CHAN, action: 'leave' }, ALICE); // drop → notify
    await session.stop();                                                 // stop → notify
    expect(notified).toHaveBeenCalledTimes(1); // nothing after unsubscribe
  });

  it('a throwing listener does not break the session or starve other listeners', async () => {
    const { session, pc } = await sessionWithAlicePeer();
    const bad = vi.fn(() => { throw new Error('listener bug'); });
    const good = vi.fn();
    session.onRosterChanged(bad);
    session.onRosterChanged(good);
    try {
      const track = new FakeTrack('audio');
      const stream = new FakeStream(track);
      expect(() => pc.ontrack?.(trackEvent(track, stream))).not.toThrow();
      expect(bad).toHaveBeenCalledTimes(1);
      expect(good).toHaveBeenCalledTimes(1);
      // The stream still registered despite the throwing listener.
      expect(session.remoteStreamsMap.has(ALICE)).toBe(true);
    } finally {
      await session.stop();
    }
  });

  it('stop() notifies subscribers of the final roster clear', async () => {
    const { session, pc } = await sessionWithAlicePeer();
    const track = new FakeTrack('audio');
    pc.ontrack?.(trackEvent(track, new FakeStream(track)));
    const notified = vi.fn();
    session.onRosterChanged(notified);

    await session.stop();
    expect(notified).toHaveBeenCalled();
    expect(session.remoteStreamsMap.size).toBe(0);
  });
});
