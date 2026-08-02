// A leave can happen while TURN credentials are still in flight. Once media has
// been released, resolving that request must not revive the session's stats timer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getState, initStore, setNativeIdentity } from '../state/store.js';
import { VoiceSession } from './session.js';

const CHANNEL = 'voice-stop-race';
const ME = 'watcher-peer';

describe('VoiceSession stop during TURN credential lookup', () => {
  let resolveTurn: ((response: Response) => void) | null = null;

  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    resolveTurn = null;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((resolve) => {
      resolveTurn = resolve;
    })));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('does not recreate the stats timer after a stopped watcher credential request resolves', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const session = new VoiceSession(CHANNEL, null, ME, {});
    const starting = session.start({ receiveOnly: true });

    expect(resolveTurn).not.toBeNull();
    await session.stop();
    resolveTurn!({
      ok: true,
      json: async () => ({ urls: ['turn:node.example:3478'], username: 'u', credential: 'c' }),
    } as Response);
    await starting;

    expect(setIntervalSpy).not.toHaveBeenCalled();
    expect(getState().voice_sessions.find((entry) => entry.channel_id === CHANNEL)).toBeUndefined();
  });
});
