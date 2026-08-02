import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addServer, getState, initStore, setNativeIdentity } from '../state/store.js';
import { registerPeerSync } from '../sync/registry.js';
import type { PeerSync } from '../sync/peersync.js';
import { VoiceSession } from './session.js';

const ME = 'me-peer';
const ALICE = 'alice-peer';
const SERVER = 'server';
const CHANNEL = 'voice-channel';

class FakePC {
  static recvonlyKinds: string[] = [];
  localDescription: { sdp: string } | null = { sdp: 'v=0' };
  iceGatheringState = 'complete';
  signalingState = 'stable';
  connectionState = 'new';
  iceConnectionState = 'new';
  getTransceivers(): unknown[] { return []; }
  getSenders(): unknown[] { return []; }
  addTrack(): Record<string, never> { return {}; }
  addTransceiver(kind: string, init: { direction?: string }): Record<string, never> {
    if (init.direction === 'recvonly') FakePC.recvonlyKinds.push(kind);
    return {};
  }
  async createOffer(): Promise<{ type: string; sdp: string }> { return { type: 'offer', sdp: 'v=0' }; }
  async createAnswer(): Promise<{ type: string; sdp: string }> { return { type: 'answer', sdp: 'v=0' }; }
  async setLocalDescription(): Promise<void> { /* noop */ }
  async setRemoteDescription(): Promise<void> { /* noop */ }
  async addIceCandidate(): Promise<void> { /* noop */ }
  close(): void { /* noop */ }
  addEventListener(): void { /* noop */ }
  removeEventListener(): void { /* noop */ }
}

function fakePeerSync(): PeerSync {
  return {
    requestScope: vi.fn(async () => [{
      peerId: ALICE,
      response: { ok: true, in_channel: true, muted: false, video: true, screen_sharing: true },
    }]),
    requestPeer: vi.fn(async () => null),
    sendToPeer: vi.fn(async () => true),
    broadcastToScope: vi.fn(async () => [] as string[]),
  } as unknown as PeerSync;
}

describe('receive-only voice session', () => {
  let mediaDevicesDescriptor: PropertyDescriptor | undefined;

  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    addServer({
      id: SERVER,
      name: 'Space',
      owner_peer_id: ME,
      members: [ME, ALICE],
      channels: { [CHANNEL]: { id: CHANNEL, server_id: SERVER, name: 'Voice', voice: true } },
    });
    FakePC.recvonlyKinds = [];
    vi.stubGlobal('RTCPeerConnection', FakePC);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline test'); }));
    mediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
  });

  afterEach(() => {
    registerPeerSync(null as unknown as PeerSync);
    if (mediaDevicesDescriptor) Object.defineProperty(navigator, 'mediaDevices', mediaDevicesDescriptor);
    else Reflect.deleteProperty(navigator, 'mediaDevices');
    vi.unstubAllGlobals();
  });

  it('does not prompt for capture and offers receive-only media slots', async () => {
    const getUserMedia = vi.fn(async () => new MediaStream());
    Object.defineProperty(navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia },
    });
    const peerSync = fakePeerSync();
    registerPeerSync(peerSync);

    const session = new VoiceSession(CHANNEL, null, ME, {});
    await session.start({ receiveOnly: true });
    try {
      await vi.waitFor(() => expect(peerSync.requestPeer).toHaveBeenCalled());
      expect(getUserMedia).not.toHaveBeenCalled();
      expect(session.isReceiveOnly).toBe(true);
      expect(getState().voice_sessions.find(v => v.channel_id === CHANNEL)?.participants[ME]?.muted).toBe(true);
      expect(FakePC.recvonlyKinds).toEqual(['audio', 'audio', 'video', 'video']);
      expect(() => session.setMuted(false)).toThrow(/receive-only/i);
      await expect(session.setCameraEnabled(true)).rejects.toThrow(/receive-only/i);
      await expect(session.startScreenShare()).rejects.toThrow(/receive-only/i);
    } finally {
      await session.stop();
    }
  });
});
