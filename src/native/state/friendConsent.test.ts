// A remote peer drives acceptFriendByPeer by sending a friends.accept frame. It may
// only settle a request the LOCAL user actually sent — otherwise a peer can send us
// a request and immediately "accept" it themselves, landing in our friends list with
// no consent from us.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStore, getState, setNativeIdentity, addFriendRequest, acceptFriendByPeer,
} from './store';

const ME = 'me';
const MALLORY = 'mallory';
const BOB = 'bob';

describe('acceptFriendByPeer consent gating', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
  });

  it('ignores a peer accepting the request it sent to us', () => {
    addFriendRequest({
      id: 'req-in',
      from_peer_id: MALLORY,
      to_peer_id: ME,
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    acceptFriendByPeer(MALLORY);

    const s = getState();
    expect(s.friends.map(f => f.id)).not.toContain('req-in');
    expect(s.friend_requests.map(r => r.id)).toContain('req-in');
  });

  it('settles a request the local user sent when that peer accepts', () => {
    addFriendRequest({
      id: 'req-out',
      from_peer_id: ME,
      to_peer_id: BOB,
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    acceptFriendByPeer(BOB);

    const s = getState();
    expect(s.friends.map(f => f.id)).toContain('req-out');
    expect(s.friend_requests.map(r => r.id)).not.toContain('req-out');
  });

  it('does not settle an unrelated peer request', () => {
    addFriendRequest({
      id: 'req-out',
      from_peer_id: ME,
      to_peer_id: BOB,
      status: 'pending',
      created_at: new Date().toISOString(),
    });

    acceptFriendByPeer(MALLORY);

    expect(getState().friends).toHaveLength(0);
    expect(getState().friend_requests.map(r => r.id)).toContain('req-out');
  });
});
