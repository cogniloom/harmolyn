import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerSync } from '../sync/peersync';
import { registerPeerSync } from '../sync/registry';
import { PROTOCOLS } from '../families/families';
import {
  addFriendRequest,
  enqueueOutbox,
  getOutbox,
  getState,
  initStore,
  isFriendRequestTombstoned,
  pruneExpiredFriendRequests,
  acceptFriend,
  setNativeIdentity,
} from './store';
import {
  nativeActOnFriendRequest,
  nativeAddFriendRequest,
  nativeDrainOutbox,
  nativeRetryFriendRequest,
} from './mutations';

const ME = 'me';
const ALICE = 'alice';

function seedOutgoing(id: string, createdAt = new Date().toISOString()): void {
  addFriendRequest({
    id,
    from_peer_id: ME,
    to_peer_id: ALICE,
    status: 'pending',
    delivery_status: 'queued',
    created_at: createdAt,
  });
}

describe('native friend-request lifecycle', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
  });

  afterEach(() => {
    registerPeerSync(null as unknown as PeerSync);
    vi.restoreAllMocks();
  });

  it('cancels an outgoing request atomically while retaining the cancellation action for delivery', async () => {
    seedOutgoing('request-1');
    enqueueOutbox({
      id: 'queued-request-1',
      targets: [ALICE],
      protocol: PROTOCOLS.friends,
      operation: 'friends.request',
      payload: { kind: 'request', id: 'request-1', request_id: 'request-1', from_peer_id: ME },
      friend_request_id: 'request-1',
      created_at: new Date().toISOString(),
      attempts: 0,
    });
    registerPeerSync({ sendToPeer: vi.fn().mockResolvedValue(false) } as unknown as PeerSync);

    await nativeActOnFriendRequest('request-1', 'cancel');

    expect(getState().friend_requests).toHaveLength(0);
    expect(isFriendRequestTombstoned(ALICE, 'request-1')).toBe(true);
    expect(getOutbox().some(entry => entry.friend_request_id === 'request-1')).toBe(false);
    expect(getOutbox()).toEqual([
      expect.objectContaining({
        protocol: PROTOCOLS.friends,
        operation: 'friends.accept',
        payload: expect.objectContaining({ action: 'cancel', request_id: 'request-1' }),
      }),
    ]);
  });

  it('does not resurrect or queue the original request when cancellation races first delivery', async () => {
    let releaseOriginal: ((value: boolean) => void) | undefined;
    const sendToPeer = vi.fn()
      .mockImplementationOnce(() => new Promise<boolean>(resolve => { releaseOriginal = resolve; }))
      .mockResolvedValue(false);
    registerPeerSync({ sendToPeer } as unknown as PeerSync);

    const sending = nativeAddFriendRequest(ALICE);
    const requestId = getState().friend_requests[0]?.id;
    expect(requestId).toBeTruthy();
    const cancelling = nativeActOnFriendRequest(requestId!, 'cancel');
    releaseOriginal?.(false);
    await Promise.all([sending, cancelling]);

    expect(getState().friend_requests).toHaveLength(0);
    expect(getOutbox().some(entry => entry.friend_request_id === requestId)).toBe(false);
    expect(getOutbox().some(entry =>
      (entry.payload as { action?: string; request_id?: string }).action === 'cancel'
      && (entry.payload as { request_id?: string }).request_id === requestId,
    )).toBe(true);
  });

  it('retries a failed request using its existing id rather than creating a second pending request', async () => {
    seedOutgoing('stable-request');
    const sendToPeer = vi.fn().mockResolvedValue(true);
    registerPeerSync({ sendToPeer } as unknown as PeerSync);

    const retried = await nativeRetryFriendRequest('stable-request');

    expect(retried.id).toBe('stable-request');
    expect(getState().friend_requests).toHaveLength(1);
    expect(getState().friend_requests[0]?.id).toBe('stable-request');
    expect(getState().friend_requests[0]?.delivery_status).toBe('sent');
    expect(sendToPeer).toHaveBeenCalledWith(
      ALICE,
      PROTOCOLS.friends,
      'friends.request',
      expect.objectContaining({ id: 'stable-request', request_id: 'stable-request' }),
    );
  });

  it('retries a legacy multiaddr-only request against its canonical peer id', async () => {
    addFriendRequest({
      id: 'legacy-address',
      from_peer_id: ME,
      to_peer_addr: '/dns4/node.xorein.com/tcp/443/wss/p2p/alice',
      status: 'pending',
      delivery_status: 'failed',
      created_at: new Date().toISOString(),
    });
    const sendToPeer = vi.fn().mockResolvedValue(true);
    registerPeerSync({ sendToPeer } as unknown as PeerSync);

    await nativeRetryFriendRequest('legacy-address');

    expect(sendToPeer).toHaveBeenCalledWith(
      ALICE,
      PROTOCOLS.friends,
      'friends.request',
      expect.objectContaining({ id: 'legacy-address', request_id: 'legacy-address' }),
    );
  });

  it('refuses a new outgoing request to an already accepted friend', async () => {
    seedOutgoing('already-friends');
    acceptFriend('already-friends');

    await expect(nativeAddFriendRequest(ALICE)).rejects.toThrow('already your friend');
    expect(getState().friends).toEqual([
      expect.objectContaining({ id: 'already-friends', status: 'accepted' }),
    ]);
    expect(getState().friend_requests).toHaveLength(0);
  });

  it('expires pending requests after seven days, clears their original outbox item, and tombstones the id', () => {
    const old = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString();
    seedOutgoing('expired-request', old);
    enqueueOutbox({
      id: 'queued-expired-request',
      targets: [ALICE],
      protocol: PROTOCOLS.friends,
      operation: 'friends.request',
      payload: { kind: 'request' },
      friend_request_id: 'expired-request',
      created_at: old,
      attempts: 0,
    });

    expect(pruneExpiredFriendRequests()).toEqual(['expired-request']);
    expect(getState().friend_requests).toHaveLength(0);
    expect(getOutbox()).toHaveLength(0);
    expect(isFriendRequestTombstoned(ALICE, 'expired-request')).toBe(true);
  });

  it('treats a terminal click on a just-expired request as successful local cleanup', async () => {
    const old = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString();
    seedOutgoing('expired-on-click', old);

    await expect(nativeActOnFriendRequest('expired-on-click', 'cancel')).resolves.toBeUndefined();

    expect(getState().friend_requests).toHaveLength(0);
    expect(isFriendRequestTombstoned(ALICE, 'expired-on-click')).toBe(true);
  });

  it('drops an orphaned queued original request rather than replaying it after terminalization', async () => {
    const sendToPeer = vi.fn().mockResolvedValue(true);
    registerPeerSync({ sendToPeer } as unknown as PeerSync);
    enqueueOutbox({
      id: 'orphaned-request',
      targets: [ALICE],
      protocol: PROTOCOLS.friends,
      operation: 'friends.request',
      payload: { kind: 'request', id: 'orphaned', request_id: 'orphaned', from_peer_id: ME },
      friend_request_id: 'orphaned',
      created_at: new Date().toISOString(),
      attempts: 0,
    });

    await nativeDrainOutbox();

    expect(getOutbox()).toHaveLength(0);
    expect(sendToPeer).not.toHaveBeenCalled();
  });

  it('retains lifecycle actions beyond the generic retry cap but expires them after the request TTL', async () => {
    const sendToPeer = vi.fn().mockResolvedValue(false);
    registerPeerSync({ sendToPeer } as unknown as PeerSync);
    const now = new Date().toISOString();
    const old = new Date(Date.now() - (8 * 24 * 60 * 60 * 1000)).toISOString();
    const actionPayload = { kind: 'cancel', action: 'cancel', id: 'request-1', request_id: 'request-1', from_peer_id: ME };
    enqueueOutbox({
      id: 'fresh-lifecycle-action',
      targets: [ALICE],
      protocol: PROTOCOLS.friends,
      operation: 'friends.accept',
      payload: actionPayload,
      created_at: now,
      attempts: 49,
    });
    enqueueOutbox({
      id: 'expired-lifecycle-action',
      targets: [ALICE],
      protocol: PROTOCOLS.friends,
      operation: 'friends.accept',
      payload: actionPayload,
      created_at: old,
      attempts: 0,
    });

    await nativeDrainOutbox();

    expect(getOutbox()).toEqual([
      expect.objectContaining({ id: 'fresh-lifecycle-action', attempts: 50 }),
    ]);
  });

  it('preserves terminal friend actions when an ordinary offline queue overflows', () => {
    enqueueOutbox({
      id: 'lifecycle-first',
      targets: [ALICE],
      protocol: PROTOCOLS.friends,
      operation: 'friends.accept',
      payload: { kind: 'cancel', action: 'cancel', request_id: 'request-1' },
      created_at: new Date().toISOString(),
      attempts: 0,
    });
    for (let index = 0; index < 499; index += 1) {
      enqueueOutbox({
        id: `ordinary-${index}`,
        targets: [ALICE],
        protocol: PROTOCOLS.chat,
        operation: 'chat.send',
        payload: { index },
        created_at: new Date().toISOString(),
        attempts: 0,
      });
    }

    enqueueOutbox({
      id: 'ordinary-overflow',
      targets: [ALICE],
      protocol: PROTOCOLS.chat,
      operation: 'chat.send',
      payload: {},
      created_at: new Date().toISOString(),
      attempts: 0,
    });

    expect(getOutbox()).toHaveLength(500);
    expect(getOutbox().some(entry => entry.id === 'lifecycle-first')).toBe(true);
    expect(getOutbox().some(entry => entry.id === 'ordinary-0')).toBe(false);
    expect(getOutbox().some(entry => entry.id === 'ordinary-overflow')).toBe(true);
  });
});
