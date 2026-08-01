import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerSync } from '../sync/peersync';
import { generateIdentity, type XoreinIdentity } from '../identity/identity';
import {
  registerRecipientInboxIdentity,
  resetRecipientInboxIdentity,
} from '../delivery/recipientInbox';
import { registerPeerSync } from '../sync/registry';
import {
  addServer,
  getOutbox,
  getState,
  initStore,
  setNativeIdentity,
} from './store';
import { nativeAddFriendRequest } from './mutations';

describe('friend-request network placement', () => {
  let alice: XoreinIdentity;
  let bob: XoreinIdentity;
  let holder: XoreinIdentity;

  beforeEach(async () => {
    localStorage.clear();
    initStore();
    alice = await generateIdentity();
    bob = await generateIdentity();
    holder = await generateIdentity();
    setNativeIdentity({
      id: alice.peerId,
      peer_id: alice.peerId,
      profile: { display_name: 'Alice' },
    });
    registerRecipientInboxIdentity(alice);
  });

  afterEach(() => {
    registerPeerSync(null as unknown as PeerSync);
    resetRecipientInboxIdentity();
    vi.restoreAllMocks();
  });

  it('reports sent when an ordinary peer accepts durable custody', async () => {
    addServer({
      id: 'shared-space',
      name: 'Shared space',
      owner_peer_id: alice.peerId,
      members: [alice.peerId, bob.peerId, holder.peerId],
      channels: {},
    });
    const requestPeer = vi.fn().mockResolvedValue({ ok: true, queued: true });
    registerPeerSync({
      sendToPeer: vi.fn().mockResolvedValue(false),
      storeInboxAtRelay: vi.fn().mockResolvedValue(false),
      activeRelayPeerId: vi.fn().mockReturnValue(null),
      requestPeer,
    } as unknown as PeerSync);

    const result = await nativeAddFriendRequest(bob.peerId);

    expect(result.delivery_status).toBe('sent');
    expect(getState().friend_requests.find(request => request.id === result.id)?.delivery_status)
      .toBe('sent');
    expect(getOutbox()).toHaveLength(0);
    expect(requestPeer).toHaveBeenCalledWith(
      holder.peerId,
      expect.any(String),
      'peer.inbox.store',
      expect.objectContaining({ recipient_peer_id: bob.peerId }),
    );
  });

  it('uses queued only when no remote peer accepted custody', async () => {
    registerPeerSync({
      sendToPeer: vi.fn().mockResolvedValue(false),
      storeInboxAtRelay: vi.fn().mockResolvedValue(false),
      activeRelayPeerId: vi.fn().mockReturnValue(null),
      requestPeer: vi.fn().mockResolvedValue(null),
    } as unknown as PeerSync);

    const result = await nativeAddFriendRequest(bob.peerId);

    expect(result.delivery_status).toBe('queued');
    expect(getOutbox()).toHaveLength(1);
  });
});
