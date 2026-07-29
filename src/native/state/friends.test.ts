// P0 friends.accept durability: accepting a friend request must RELIABLY reach the
// original requester. A one-shot fire-and-forget send loses the accept forever when
// the first dial fails (cold circuit / requester briefly offline), leaving the
// requester's outgoing request stuck on PENDING while presence (heartbeat-retried)
// happily arrives. The accept now falls back to the durable outbox and is replayed
// by the drain until acknowledged.
//
// Also covers the typing producer (nativeNotifyTyping / nativeStopTyping): debounced
// presence broadcasts carrying typing_in_scope, with an automatic stop after idle.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initStore, getState, setNativeIdentity, addFriendRequest, getOutbox,
} from './store';
import { registerPeerSync } from '../sync/registry';
import { PROTOCOLS } from '../families/families';
import {
  nativeAcceptFriend, nativeDrainOutbox, nativeUpdatePresence,
  nativeNotifyTyping, nativeStopTyping,
} from './mutations';
import type { PeerSync } from '../sync/peersync';

const ME = 'me';
const ALICE = 'alice';

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

function mockSync(overrides: { sendToPeer?: ReturnType<typeof vi.fn>; broadcastTyping?: ReturnType<typeof vi.fn> } = {}) {
  return {
    sendToPeer: overrides.sendToPeer ?? vi.fn().mockResolvedValue(true),
    broadcastTyping: overrides.broadcastTyping ?? vi.fn().mockResolvedValue(undefined),
  };
}

function seedIncomingRequest(id = 'req-1'): void {
  addFriendRequest({
    id,
    from_peer_id: ALICE,
    to_peer_id: ME,
    status: 'pending',
    created_at: new Date().toISOString(),
  });
}

describe('nativeAcceptFriend durability (P0)', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
  });
  afterEach(() => {
    registerPeerSync(null as unknown as PeerSync);
  });

  it('delivers friends.accept to the requester and queues nothing when reachable', async () => {
    seedIncomingRequest();
    const sync = mockSync();
    registerPeerSync(sync as unknown as PeerSync);

    nativeAcceptFriend('req-1');
    await flush();

    expect(sync.sendToPeer).toHaveBeenCalledWith(
      ALICE,
      PROTOCOLS.friends,
      'friends.accept',
      expect.objectContaining({ kind: 'accept', from_peer_id: ME }),
    );
    expect(getOutbox().length).toBe(0);
    expect(getState().friends.some(f => f.from_peer_id === ALICE && f.status === 'accepted')).toBe(true);
    expect(getState().friend_requests.length).toBe(0);
  });

  it('durably queues the accept when the requester is unreachable, and the drain replays it', async () => {
    seedIncomingRequest();
    const sync = mockSync({ sendToPeer: vi.fn().mockResolvedValue(false) });
    registerPeerSync(sync as unknown as PeerSync);

    nativeAcceptFriend('req-1');
    await flush();

    // The lost one-shot is now a durable outbox entry targeting the requester.
    const queued = getOutbox();
    expect(queued.length).toBe(1);
    expect(queued[0].targets).toEqual([ALICE]);
    expect(queued[0].protocol).toBe(PROTOCOLS.friends);
    expect(queued[0].operation).toBe('friends.accept');
    expect((queued[0].payload as { kind?: string }).kind).toBe('accept');

    // Requester comes back: the drain delivers the accept and clears the queue.
    const backOnline = mockSync();
    registerPeerSync(backOnline as unknown as PeerSync);
    await nativeDrainOutbox();

    expect(backOnline.sendToPeer).toHaveBeenCalledWith(
      ALICE, PROTOCOLS.friends, 'friends.accept', expect.objectContaining({ kind: 'accept' }),
    );
    expect(getOutbox().length).toBe(0);
  });

  it('queues the accept when no transport is registered at all', async () => {
    seedIncomingRequest();
    registerPeerSync(null as unknown as PeerSync);

    nativeAcceptFriend('req-1');
    await flush();

    const queued = getOutbox();
    expect(queued.length).toBe(1);
    expect(queued[0].operation).toBe('friends.accept');
    expect(queued[0].targets).toEqual([ALICE]);
    // The local flip still happened — only delivery is deferred.
    expect(getState().friends.some(f => f.status === 'accepted')).toBe(true);
  });
});

describe('typing producer (nativeNotifyTyping / nativeStopTyping)', () => {
  let sync: ReturnType<typeof mockSync>;

  beforeEach(async () => {
    vi.useFakeTimers();
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    // An accepted friend so presenceTargets is non-empty and broadcasts happen.
    seedIncomingRequest('req-t');
    sync = mockSync();
    registerPeerSync(sync as unknown as PeerSync);
    nativeAcceptFriend('req-t');
    sync.broadcastTyping.mockClear();
    sync.sendToPeer.mockClear();
  });
  afterEach(() => {
    nativeStopTyping();
    vi.useRealTimers();
    registerPeerSync(null as unknown as PeerSync);
  });

  it('broadcasts typing presence for the scope and records it locally', () => {
    nativeNotifyTyping('dm-1');

    expect(sync.broadcastTyping).toHaveBeenCalledTimes(1);
    expect(sync.broadcastTyping).toHaveBeenCalledWith(expect.objectContaining({
      peerId: ME,
      scopeId: 'dm-1',
      isTyping: true,
    }));
    expect(getState().presence[ME]?.typing_in_scope).toBe('dm-1');
  });

  it('debounces repeated keystrokes into a single broadcast per window', () => {
    nativeNotifyTyping('dm-1');
    nativeNotifyTyping('dm-1');
    vi.advanceTimersByTime(1000);
    nativeNotifyTyping('dm-1');

    expect(sync.broadcastTyping).toHaveBeenCalledTimes(1);

    // After the rebroadcast window elapses, continued typing re-asserts.
    vi.advanceTimersByTime(2600);
    nativeNotifyTyping('dm-1');
    expect(sync.broadcastTyping).toHaveBeenCalledTimes(2);
  });

  it('re-broadcasts immediately when the scope changes', () => {
    nativeNotifyTyping('dm-1');
    nativeNotifyTyping('chan-2');

    expect(sync.broadcastTyping).toHaveBeenCalledTimes(2);
    expect(sync.broadcastTyping).toHaveBeenLastCalledWith(expect.objectContaining({
      scopeId: 'chan-2',
      isTyping: true,
    }));
  });

  it('auto-broadcasts stop-typing after the idle timeout', () => {
    nativeNotifyTyping('dm-1');
    expect(getState().presence[ME]?.typing_in_scope).toBe('dm-1');

    vi.advanceTimersByTime(4100);

    expect(sync.broadcastTyping).toHaveBeenCalledTimes(2);
    expect(sync.broadcastTyping).toHaveBeenLastCalledWith(expect.objectContaining({
      isTyping: false,
    }));
    expect(getState().presence[ME]?.typing_in_scope).toBeUndefined();
  });

  it('explicit stop (message sent) broadcasts cleared typing once and is idempotent', async () => {
    nativeNotifyTyping('dm-1');
    nativeStopTyping();

    // Local state clears immediately, but the stop BROADCAST is deferred one
    // macrotask so a same-tick message send reaches the wire ahead of it.
    expect(getState().presence[ME]?.typing_in_scope).toBeUndefined();
    expect(sync.broadcastTyping).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.broadcastTyping).toHaveBeenCalledTimes(2);

    // No pending typing → stop is a no-op (no spurious presence broadcast).
    nativeStopTyping();
    await vi.advanceTimersByTimeAsync(1);
    expect(sync.broadcastTyping).toHaveBeenCalledTimes(2);
  });

  it('preserves the user status and custom status text on typing broadcasts', () => {
    nativeUpdatePresence('dnd', { status_text: 'in a meeting' });
    sync.broadcastTyping.mockClear();

    nativeNotifyTyping('dm-1');

    expect(sync.broadcastTyping).toHaveBeenCalledWith(expect.objectContaining({
      scopeId: 'dm-1',
      isTyping: true,
      status: 'dnd',
      status_text: 'in a meeting',
    }));
  });
});
