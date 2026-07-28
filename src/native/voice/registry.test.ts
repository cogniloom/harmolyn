// rekeyVoiceForServer fans a Crowd-root rotation out to the active voice call(s) on that
// server, passing the current membership so removed peers can be dropped. (The media-level
// rekey itself is exercised by the live voice smoketest; here we verify the wiring.)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initStore, addServer, updateServer } from '../state/store.js';
import { registerVoiceSession, clearVoiceSession, rekeyVoiceForServer } from './registry.js';
import type { VoiceSession } from './session.js';

function stubSession(channelId: string) {
  return { channelId, rekey: vi.fn() } as unknown as VoiceSession & { rekey: ReturnType<typeof vi.fn> };
}

describe('rekeyVoiceForServer', () => {
  beforeEach(() => { localStorage.clear(); initStore(); });

  it('rekeys the active voice session for a server channel with the current members', () => {
    addServer({ id: 'srv', name: 'S', owner_peer_id: 'owner', members: ['owner', 'alice'],
      channels: { voiceChan: { id: 'voiceChan', server_id: 'srv', name: 'voice', voice: true } } });
    updateServer('srv', { crowd_root: 'root', crowd_epoch: 1 });

    const session = stubSession('voiceChan');
    registerVoiceSession(session);
    try {
      rekeyVoiceForServer('srv');
      expect(session.rekey).toHaveBeenCalledTimes(1);
      expect(session.rekey).toHaveBeenCalledWith(['owner', 'alice']);
    } finally {
      clearVoiceSession('voiceChan');
    }
  });

  it('is a no-op for a server with no active voice session', () => {
    addServer({ id: 'srv2', name: 'S2', owner_peer_id: 'owner', members: ['owner'],
      channels: { c: { id: 'c', server_id: 'srv2', name: 'text', voice: false } } });
    expect(() => rekeyVoiceForServer('srv2')).not.toThrow();
  });

  it('ignores an unknown server', () => {
    expect(() => rekeyVoiceForServer('nope')).not.toThrow();
  });
});
