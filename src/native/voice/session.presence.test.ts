// Voice roster symmetry: the NEWCOMER must populate its roster (participants +
// display names) from the presence handshake REPLY, exactly as the already-present
// side populates from the join REQUEST. Regression test for the measured join
// asymmetry where the newcomer showed bare peer ids until the next periodic
// presence broadcast (~15-25s) delivered profiles.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initStore, addServer, setNativeIdentity, getState } from '../state/store.js';
import { registerPeerSync } from '../sync/registry.js';
import type { PeerSync } from '../sync/peersync.js';
import { VoiceSession } from './session.js';
import type { VoicePresenceResponse } from './signaling.js';
import { VOICE_PRESENCE_HEARTBEAT_MS } from './presence.js';

const ME = 'me-peer';
const ALICE = 'alice-peer';
const BOB = 'bob-peer';
const SRV = 'srv';
const CHAN = 'voice-chan';

/** Minimal RTCPeerConnection stand-in so best-effort mesh dialing is inert in jsdom. */
class FakePC {
  localDescription: { sdp: string } | null = { sdp: 'v=0' };
  iceGatheringState = 'complete';
  signalingState = 'stable';
  connectionState = 'new';
  iceConnectionState = 'new';
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

function fakePeerSync(presenceResponse: VoicePresenceResponse): PeerSync {
  const stub = {
    requestScope: vi.fn(async () => [{ peerId: ALICE, response: presenceResponse }]),
    requestPeer: vi.fn(async () => null),
    sendToPeer: vi.fn(async () => true),
    broadcastToScope: vi.fn(async () => [] as string[]),
  };
  return stub as unknown as PeerSync;
}

function voiceParticipants(channelId: string): Record<string, { muted?: boolean }> {
  return getState().voice_sessions.find(v => v.channel_id === channelId)?.participants ?? {};
}

describe('voice presence handshake roster symmetry', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    addServer({ id: SRV, name: 'S', owner_peer_id: ALICE, members: [ME, ALICE],
      channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'war-room', voice: true } } });
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline test'); }));
  });

  afterEach(() => {
    registerPeerSync(null as unknown as PeerSync);
    vi.unstubAllGlobals();
  });

  it('newcomer populates roster AND peer profile from the handshake reply (no periodic broadcast needed)', async () => {
    registerPeerSync(fakePeerSync({
      ok: true, in_channel: true, muted: true, video: false, screen_sharing: false,
      display_name: 'Alice', avatar: 'data:image/png;base64,QQ==',
    }));

    const session = new VoiceSession(CHAN, {} as never, ME, {});
    await session.start();
    try {
      const participants = voiceParticipants(CHAN);
      // Roster: both self and the already-present member, immediately after start().
      expect(Object.keys(participants).sort()).toEqual([ALICE, ME].sort());
      // The responder's av-state from the reply is applied.
      expect(participants[ALICE]?.muted).toBe(true);
      // THE FIX: the responder's profile carried in the reply is learned, so the
      // UI can render "Alice" instead of a bare peer id right away.
      expect(getState().peers?.[ALICE]?.display_name).toBe('Alice');
      expect(getState().peers?.[ALICE]?.avatar).toBe('data:image/png;base64,QQ==');
    } finally {
      await session.stop();
    }
  });

  it('a responder who is NOT in the channel is not added to the roster', async () => {
    const peerSync = fakePeerSync({ ok: true, in_channel: false, muted: false, video: false, screen_sharing: false });
    registerPeerSync(peerSync);
    const session = new VoiceSession(CHAN, {} as never, ME, {});
    await session.start();
    try {
      expect(Object.keys(voiceParticipants(CHAN))).toEqual([ME]);
      // One initial request plus one race-closing retry; a stable non-participant
      // is not probed in every retry round.
      await vi.waitFor(() => expect(peerSync.requestScope).toHaveBeenCalledTimes(2));
    } finally {
      await session.stop();
    }
  });

  it('does not retry a member who never answers the presence request', async () => {
    getState().servers[SRV]!.members.push(BOB);
    const peerSync = fakePeerSync({
      ok: true, in_channel: true, muted: false, video: false, screen_sharing: false,
    });
    registerPeerSync(peerSync);

    const session = new VoiceSession(CHAN, {} as never, ME, {});
    await session.start();
    try {
      await vi.waitFor(() => expect(peerSync.requestScope).toHaveBeenCalledTimes(1));
      expect(peerSync.requestScope).toHaveBeenCalledWith(
        expect.arrayContaining([ALICE, BOB]),
        expect.any(String),
        expect.any(String),
        expect.any(Object),
      );
    } finally {
      await session.stop();
    }
  });

  it('re-announces join state as a bounded heartbeat for passive observers', async () => {
    vi.useFakeTimers();
    const peerSync = fakePeerSync({ ok: true, in_channel: false });
    registerPeerSync(peerSync);
    const session = new VoiceSession(CHAN, {} as never, ME, {});
    try {
      await session.start();
      await vi.advanceTimersByTimeAsync(VOICE_PRESENCE_HEARTBEAT_MS);
      expect(peerSync.broadcastToScope).toHaveBeenCalledWith(
        [ALICE],
        expect.any(String),
        'voice.presence',
        expect.objectContaining({ session_id: CHAN, action: 'join' }),
      );
    } finally {
      await session.stop();
      vi.useRealTimers();
    }
  });

  it("presence 'query' updates av-state + profile for an in-roster peer but never ADDS a participant", () => {
    const session = new VoiceSession(CHAN, null, ME, {});

    // A 'query' from a member who is NOT in the roster must not add them.
    session.handlePresence({ session_id: CHAN, action: 'query', muted: true }, ALICE);
    expect(voiceParticipants(CHAN)[ALICE]).toBeUndefined();

    // Join, then a state update ('query') flips their mute + carries a profile.
    session.handlePresence({ session_id: CHAN, action: 'join', muted: false }, ALICE);
    expect(voiceParticipants(CHAN)[ALICE]?.muted).toBe(false);
    session.handlePresence({ session_id: CHAN, action: 'query', muted: true, display_name: 'Alice' }, ALICE);
    expect(voiceParticipants(CHAN)[ALICE]?.muted).toBe(true);
    expect(getState().peers?.[ALICE]?.display_name).toBe('Alice');
  });
});
