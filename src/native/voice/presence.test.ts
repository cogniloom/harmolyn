import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addServer, getState, initStore, setNativeIdentity } from '../state/store.js';
import {
  clearAllObservedVoicePresence,
  observeVoicePresence,
  VOICE_OBSERVED_PRESENCE_TTL_MS,
} from './presence.js';

const ME = 'me-peer';
const ALICE = 'alice-peer';
const KICKED = 'kicked-peer';
const SERVER = 'server';
const CHANNEL = 'voice-channel';

function participants(): Record<string, { muted?: boolean; video?: boolean; screen_sharing?: boolean }> {
  return getState().voice_sessions.find(session => session.channel_id === CHANNEL)?.participants ?? {};
}

describe('passive voice occupancy', () => {
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
  });

  afterEach(() => {
    clearAllObservedVoicePresence();
    vi.useRealTimers();
  });

  it('publishes authenticated member occupancy with the advertised media state', () => {
    expect(observeVoicePresence(CHANNEL, ALICE, {
      session_id: CHANNEL,
      action: 'join',
      muted: true,
      video: true,
      screen_sharing: true,
      display_name: 'Alice',
    })).toBe(true);

    expect(participants()[ALICE]).toMatchObject({
      muted: true,
      video: true,
      screen_sharing: true,
    });
    expect(getState().peers[ALICE]?.display_name).toBe('Alice');
  });

  it('does not create an observer roster entry from a query or a non-member', () => {
    expect(observeVoicePresence(CHANNEL, ALICE, {
      session_id: CHANNEL,
      action: 'query',
      muted: true,
    })).toBe(true);
    expect(participants()[ALICE]).toBeUndefined();

    expect(observeVoicePresence(CHANNEL, KICKED, {
      session_id: CHANNEL,
      action: 'join',
      muted: false,
    })).toBe(false);
    expect(participants()[KICKED]).toBeUndefined();
  });

  it('does not disclose occupancy after this observer is no longer a member', () => {
    getState().servers[SERVER]!.members = [ALICE];
    expect(observeVoicePresence(CHANNEL, ALICE, {
      session_id: CHANNEL,
      action: 'join',
      muted: false,
    })).toBe(false);
    expect(participants()[ALICE]).toBeUndefined();
  });

  it('removes passive occupancy immediately on an authenticated leave', () => {
    expect(observeVoicePresence(CHANNEL, ALICE, {
      session_id: CHANNEL,
      action: 'join',
      muted: false,
    })).toBe(true);
    expect(participants()[ALICE]).toBeDefined();

    expect(observeVoicePresence(CHANNEL, ALICE, {
      session_id: CHANNEL,
      action: 'leave',
    })).toBe(true);
    expect(participants()[ALICE]).toBeUndefined();
  });

  it('expires an uncleaned beacon instead of retaining stale occupancy', () => {
    vi.useFakeTimers();
    expect(observeVoicePresence(CHANNEL, ALICE, {
      session_id: CHANNEL,
      action: 'join',
      muted: false,
    })).toBe(true);
    expect(participants()[ALICE]).toBeDefined();

    vi.advanceTimersByTime(VOICE_OBSERVED_PRESENCE_TTL_MS + 1);
    expect(participants()[ALICE]).toBeUndefined();
  });
});
