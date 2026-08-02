import { afterEach, describe, expect, it, vi } from 'vitest';
import type { XoreinIdentity } from '../identity/identity.js';
import { clearVoiceSession, registerVoiceSession } from '../voice/registry.js';
import type { VoiceSession } from '../voice/session.js';
import { XoreinNativeEngine } from './engine.js';

type EngineInternals = {
  _identity: XoreinIdentity | null;
  _transport: {
    currentNode: object | null;
    hasLivePeerPath(): boolean;
  } | null;
  _wiredNode: object | null;
};

describe('XoreinNativeEngine receive-only voice guard', () => {
  afterEach(() => {
    clearVoiceSession('watch-channel');
    vi.unstubAllGlobals();
  });

  it('does not relabel an active outbound call as receive-only', async () => {
    registerVoiceSession({
      channelId: 'watch-channel',
      isReceiveOnly: false,
    } as VoiceSession);

    await expect(new XoreinNativeEngine({}).joinVoice('watch-channel', { receiveOnly: true }))
      .rejects.toThrow(/leave the current voice session/i);
  });

  it('fails closed when the live transport node is not the node PeerSync is wired to', async () => {
    const engine = new XoreinNativeEngine({});
    const currentNode = {};
    const staleWiredNode = {};
    const internals = engine as unknown as EngineInternals;
    internals._identity = { peerId: 'watcher' } as XoreinIdentity;
    internals._transport = {
      currentNode,
      hasLivePeerPath: () => true,
    };
    internals._wiredNode = staleWiredNode;
    vi.stubGlobal('RTCPeerConnection', class {});

    await expect(engine.joinVoice('watch-channel', { receiveOnly: true }))
      .rejects.toThrow(/active native peer connection/i);
  });

  it('fails closed when the wired node no longer has a live peer path', async () => {
    const engine = new XoreinNativeEngine({});
    const node = {};
    const internals = engine as unknown as EngineInternals;
    internals._identity = { peerId: 'watcher' } as XoreinIdentity;
    internals._transport = {
      currentNode: node,
      hasLivePeerPath: () => false,
    };
    internals._wiredNode = node;
    vi.stubGlobal('RTCPeerConnection', class {});

    await expect(engine.joinVoice('watch-channel', { receiveOnly: true }))
      .rejects.toThrow(/active native peer connection/i);
  });
});
