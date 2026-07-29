import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { XoreinRuntimeMessage, XoreinRuntimeServer } from '../../types';
import {
  initStore, getState, updateState, setNativeIdentity,
  addServer, addChannel, addMessage, editMessage, deleteMessage,
  addReaction, removeReaction, addRelay, removeRelay,
  removeServerMembership, setMessageDeliveryStatus,
  addPollVote, applyJoinedServer,
  toRuntimeSnapshot, setStateEncryptionKey,
} from './store';
import {
  nativeSendChannelMessage, nativeCreateServer, nativeCreateChannel,
  nativeAddReaction, nativeRemoveReaction, nativeEditMessage,
  nativeAddRelay, nativeRemoveRelay,
  nativeCreateRole, nativeUpdateRole, nativeDeleteRole, nativeAssignRole,
  nativeCastPollVote, nativeRemoveMember,
  nativeSearchMessages,
} from './mutations';
const TEST_STATE_KEY = new Uint8Array(32).fill(7);

// Reset store state before each test.
beforeEach(() => {
  // Wipe localStorage in jsdom environment.
  localStorage.clear();
  setStateEncryptionKey(TEST_STATE_KEY);
  initStore();
});

afterEach(() => setStateEncryptionKey(null));

describe('store', () => {
  it('initialises empty', () => {
    const s = getState();
    expect(s.servers).toEqual({});
    expect(s.messages).toEqual([]);
    expect(s.friends).toEqual([]);
    expect(s.relay_addrs).toEqual([]);
  });

  it('setNativeIdentity updates the identity field', () => {
    setNativeIdentity({ id: 'p1', peer_id: 'p1' });
    expect(getState().identity?.peer_id).toBe('p1');
  });

  it('addServer stores server keyed by id', () => {
    const srv = {
      id: 'srv1', name: 'Test', owner_peer_id: 'p1',
      members: ['p1'], channels: {},
    };
    addServer(srv);
    expect(getState().servers['srv1']?.name).toBe('Test');
  });

  it('addChannel adds channel to existing server', () => {
    addServer({ id: 's1', name: 'S', owner_peer_id: 'p', members: [], channels: {} });
    addChannel('s1', { id: 'c1', server_id: 's1', name: 'general', voice: false });
    expect(getState().servers['s1']?.channels['c1']?.name).toBe('general');
  });

  it('addMessage / editMessage / deleteMessage', () => {
    addMessage({ id: 'm1', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p', body: 'hello' });
    expect(getState().messages[0].body).toBe('hello');
    editMessage('m1', 'world');
    expect(getState().messages[0].body).toBe('world');
    deleteMessage('m1');
    expect(getState().messages[0].deleted).toBe(true);
  });

  it('addReaction / removeReaction', () => {
    addMessage({ id: 'm2', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p', body: 'hi' });
    addReaction('m2', '👍', 'local');
    const r1 = getState().messages[0].reactions!;
    expect(r1[0].emoji).toBe('👍');
    expect(r1[0].count).toBe(1);
    removeReaction('m2', '👍', 'local');
    expect(getState().messages[0].reactions).toEqual([]);
  });

  it('addRelay / removeRelay', () => {
    addRelay('/ip4/1.2.3.4/tcp/4001');
    addRelay('/ip4/1.2.3.4/tcp/4001'); // duplicate ignored
    expect(getState().relay_addrs.length).toBe(1);
    removeRelay('/ip4/1.2.3.4/tcp/4001');
    expect(getState().relay_addrs).toEqual([]);
  });

  it('persists to and restores from localStorage', () => {
    setNativeIdentity({ id: 'p99', peer_id: 'p99' });
    addServer({ id: 'srv99', name: 'Persist', owner_peer_id: 'p99', members: [], channels: {} });
    // Reinitialise from localStorage.
    initStore();
    expect(getState().identity?.peer_id).toBe('p99');
    expect(getState().servers['srv99']?.name).toBe('Persist');
  });
});

describe('toRuntimeSnapshot', () => {
  it('produces a valid XoreinRuntimeSnapshot', () => {
    setNativeIdentity({ id: 'snap-peer', peer_id: 'snap-peer' });
    addServer({ id: 's1', name: 'S1', owner_peer_id: 'snap-peer', members: ['snap-peer'], channels: {} });
    addMessage({ id: 'm1', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'snap-peer', body: 'test' });
    const snap = toRuntimeSnapshot();
    expect(snap.peer_id).toBe('snap-peer');
    expect(snap.servers!.length).toBe(1);
    expect(snap.messages!.length).toBe(1);
    expect(snap.messages![0].body).toBe('test');
    // Deleted messages are filtered out.
    deleteMessage('m1');
    const snap2 = toRuntimeSnapshot();
    expect(snap2.messages!.length).toBe(0);
  });

  it('never leaks crowd_root or invite_secret into the snapshot', () => {
    addServer({
      id: 'secret-srv',
      name: 'Secret',
      owner_peer_id: 'owner',
      members: ['owner'],
      channels: {},
      crowd_root: 'super-secret-crowd-root',
      invite_secret: 'super-secret-invite',
    });
    const snap = toRuntimeSnapshot();
    const json = JSON.stringify(snap);
    expect(json).not.toContain('super-secret-crowd-root');
    expect(json).not.toContain('super-secret-invite');
    // But the secrets remain accessible via getState() for crypto operations.
    expect(getState().servers['secret-srv']?.crowd_root).toBe('super-secret-crowd-root');
    expect(getState().servers['secret-srv']?.invite_secret).toBe('super-secret-invite');
  });

  it('snapshot servers do not have crowd_root or invite_secret fields', () => {
    addServer({
      id: 'fields-srv',
      name: 'Fields',
      owner_peer_id: 'owner',
      members: [],
      channels: {},
      crowd_root: 'root-xyz',
      invite_secret: 'secret-xyz',
    });
    const snap = toRuntimeSnapshot();
    const srv = snap.servers!.find(s => s.id === 'fields-srv')!;
    expect(srv).toBeDefined();
    expect('crowd_root' in srv).toBe(false);
    expect('invite_secret' in srv).toBe(false);
  });
});

describe('mutations', () => {
  it('nativeCreateServer creates server with a general channel', () => {
    const srv = nativeCreateServer('My Server');
    expect(srv.name).toBe('My Server');
    expect(Object.values(srv.channels).length).toBe(1);
    expect(Object.values(srv.channels)[0].name).toBe('general');
    expect(getState().servers[srv.id]).toBeTruthy();
  });

  it('nativeCreateChannel adds to existing server', () => {
    const srv = nativeCreateServer('S');
    nativeCreateChannel(srv.id, 'announcements');
    const channels = Object.values(getState().servers[srv.id]?.channels ?? {});
    expect(channels.some(c => c.name === 'announcements')).toBe(true);
  });

  it('nativeSendChannelMessage adds message to store', () => {
    const srv = nativeCreateServer('S');
    const channelId = Object.keys(srv.channels)[0];
    const msg = nativeSendChannelMessage(channelId, 'hello native');
    expect(msg.body).toBe('hello native');
    expect(msg.scope_id).toBe(channelId);
    expect(getState().messages.some(m => m.id === msg.id)).toBe(true);
  });

  it('nativeEditMessage updates the message body', () => {
    const srv = nativeCreateServer('S');
    const channelId = Object.keys(srv.channels)[0];
    const msg = nativeSendChannelMessage(channelId, 'original');
    nativeEditMessage(msg.id, 'updated');
    const stored = getState().messages.find(m => m.id === msg.id)!;
    expect(stored.body).toBe('updated');
  });

  it('nativeAddReaction / nativeRemoveReaction round-trip', () => {
    const srv = nativeCreateServer('S');
    const channelId = Object.keys(srv.channels)[0];
    setNativeIdentity({ id: 'me', peer_id: 'me' });
    const msg = nativeSendChannelMessage(channelId, 'react test');
    nativeAddReaction(msg.id, '🎉');
    const reactions = getState().messages.find(m => m.id === msg.id)!.reactions!;
    expect(reactions[0].count).toBe(1);
    nativeRemoveReaction(msg.id, '🎉');
    expect(getState().messages.find(m => m.id === msg.id)!.reactions).toEqual([]);
  });

  it('nativeAddRelay / nativeRemoveRelay', () => {
    nativeAddRelay('/ip4/9.9.9.9/tcp/9999');
    expect(getState().relay_addrs).toContain('/ip4/9.9.9.9/tcp/9999');
    nativeRemoveRelay('/ip4/9.9.9.9/tcp/9999');
    expect(getState().relay_addrs).not.toContain('/ip4/9.9.9.9/tcp/9999');
  });
});

describe('store — server leave / message purge', () => {
  it('removeServerMembership purges messages scoped to that server', () => {
    addServer({
      id: 'srv-leave',
      name: 'Leave Me',
      owner_peer_id: 'p1',
      members: ['p1'],
      channels: { 'ch-1': { id: 'ch-1', server_id: 'srv-leave', name: 'general', voice: false } },
    });
    addMessage({ id: 'm-srv', scope_type: 'channel', scope_id: 'ch-1', server_id: 'srv-leave', sender_peer_id: 'p1', body: 'server msg' });
    addMessage({ id: 'm-dm', scope_type: 'dm', scope_id: 'dm-1', sender_peer_id: 'p1', body: 'dm msg' });

    removeServerMembership('srv-leave');

    const messages = getState().messages;
    expect(messages.some(m => m.id === 'm-srv'), 'server message should be purged').toBe(false);
    expect(messages.some(m => m.id === 'm-dm'), 'DM message should be kept').toBe(true);
  });
});

describe('applyJoinedServer — responder identity binding (join/pull hijack)', () => {
  it('rejects a record whose id does not match the server we asked for', () => {
    // We asked owner/seed for "srv-real" (e.g. resolving an invite or re-pulling
    // after a missed rotation). A hostile or compromised responder answers with a
    // DIFFERENT server id instead — accepting it would silently overwrite our
    // local record for that other server (name, channels, members) with content
    // the real owner never sent for it.
    addServer({
      id: 'srv-victim', name: 'Victim Server', owner_peer_id: 'owner',
      members: ['owner', 'me'],
      channels: { 'ch-1': { id: 'ch-1', server_id: 'srv-victim', name: 'general', voice: false } },
    });

    const accepted = applyJoinedServer('srv-real', {
      id: 'srv-victim', name: 'PWNED', owner_peer_id: 'attacker',
      members: ['attacker'],
      channels: {},
    } satisfies XoreinRuntimeServer);

    expect(accepted).toBe(false);
    const victim = getState().servers['srv-victim'];
    expect(victim.name).toBe('Victim Server');
    expect(victim.owner_peer_id).toBe('owner');
  });

  it('accepts a record whose id matches the server we asked for', () => {
    const accepted = applyJoinedServer('srv-real', {
      id: 'srv-real', name: 'Real Server', owner_peer_id: 'owner',
      members: ['owner', 'me'],
      channels: {},
    } satisfies XoreinRuntimeServer);

    expect(accepted).toBe(true);
    expect(getState().servers['srv-real']?.name).toBe('Real Server');
  });

  it('drops a bundled message whose scope does not belong to the joined server (message-injection hijack)', () => {
    // A pre-existing, unrelated DM thread the victim already has with Bob.
    addMessage({ id: 'm-real', scope_type: 'dm', scope_id: 'dm-me-bob', sender_peer_id: 'bob', body: 'hi from bob, for real' });

    // The server we're joining/pulling legitimately has one real channel.
    const accepted = applyJoinedServer('srv-x', {
      id: 'srv-x', name: 'X', owner_peer_id: 'owner', members: ['owner', 'me'],
      channels: { 'ch-1': { id: 'ch-1', server_id: 'srv-x', name: 'general', voice: false } },
    } satisfies XoreinRuntimeServer, [
      // A GENUINE message for the joined server's own channel — must be kept.
      { id: 'm-legit', scope_type: 'channel', scope_id: 'ch-1', server_id: 'srv-x', sender_peer_id: 'owner', body: 'welcome' },
      // FORGED: labels itself as belonging to the victim's unrelated DM with Bob.
      { id: 'm-forged-dm', scope_type: 'dm', scope_id: 'dm-me-bob', sender_peer_id: 'bob', body: 'forged: send me your seed phrase' },
      // FORGED: claims a channel id from a DIFFERENT, unrelated server.
      { id: 'm-forged-other-server', scope_type: 'channel', scope_id: 'ch-in-another-server', server_id: 'srv-other', sender_peer_id: 'owner', body: 'forged cross-server' },
    ] satisfies XoreinRuntimeMessage[]);

    expect(accepted).toBe(true);
    const ids = getState().messages.map(m => m.id);
    expect(ids).toContain('m-real');
    expect(ids).toContain('m-legit');
    expect(ids).not.toContain('m-forged-dm');
    expect(ids).not.toContain('m-forged-other-server');
  });
});

describe('store — delivery status', () => {
  it('setMessageDeliveryStatus updates delivery_status on the message', () => {
    addMessage({ id: 'ds-1', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p', body: 'test' });
    expect(getState().messages[0].delivery_status).toBeUndefined();
    setMessageDeliveryStatus('ds-1', 'pending');
    expect(getState().messages[0].delivery_status).toBe('pending');
    setMessageDeliveryStatus('ds-1', 'sent');
    expect(getState().messages[0].delivery_status).toBe('sent');
    setMessageDeliveryStatus('ds-1', 'offline_queued');
    expect(getState().messages[0].delivery_status).toBe('offline_queued');
  });

  it('nativeSendChannelMessage creates message with delivery_status pending', () => {
    const srv = nativeCreateServer('S');
    const channelId = Object.keys(srv.channels)[0];
    const msg = nativeSendChannelMessage(channelId, 'hello');
    expect(msg.delivery_status).toBe('pending');
  });
});

describe('roles — P2P-synced server roles (Goal 7)', () => {
  it('nativeCreateRole stores a role in the server record', () => {
    setNativeIdentity({ id: 'owner', peer_id: 'owner' });
    const srv = nativeCreateServer('Role Test');
    const role = nativeCreateRole(srv.id, 'Moderator', ['kick', 'mute'], '#ff0000');
    expect(role.name).toBe('Moderator');
    expect(role.color).toBe('#ff0000');
    expect(role.permissions).toEqual(['kick', 'mute']);
    expect(role.protected).toBe(false);
    const stored = getState().servers[srv.id]?.roles ?? [];
    expect(stored.some(r => r.id === role.id)).toBe(true);
  });

  it('nativeCreateRole rejects non-owners', () => {
    setNativeIdentity({ id: 'not-owner', peer_id: 'not-owner' });
    addServer({ id: 'foreign-srv', name: 'Foreign', owner_peer_id: 'actual-owner', members: ['not-owner'], channels: {} });
    expect(() => nativeCreateRole('foreign-srv', 'Mod')).toThrow();
  });

  it('nativeDeleteRole removes the role from the server', () => {
    setNativeIdentity({ id: 'owner', peer_id: 'owner' });
    const srv = nativeCreateServer('Role Delete Test');
    const role = nativeCreateRole(srv.id, 'Temp Role');
    nativeDeleteRole(srv.id, role.id);
    const stored = getState().servers[srv.id]?.roles ?? [];
    expect(stored.some(r => r.id === role.id)).toBe(false);
  });

  it('nativeUpdateRole renames a role and propagates the change', () => {
    setNativeIdentity({ id: 'owner', peer_id: 'owner' });
    const srv = nativeCreateServer('Rename Role Test');
    const role = nativeCreateRole(srv.id, 'Junior Mod');
    nativeUpdateRole(srv.id, role.id, { name: 'Senior Mod', color: '#00ff00' });
    const stored = (getState().servers[srv.id]?.roles ?? []).find(r => r.id === role.id)!;
    expect(stored.name).toBe('Senior Mod');
    expect(stored.color).toBe('#00ff00');
  });

  it('nativeUpdateRole does not rename protected roles', () => {
    setNativeIdentity({ id: 'owner', peer_id: 'owner' });
    const srv = nativeCreateServer('Protected Rename Test');
    const protectedRole = { id: 'role-admin', name: 'Admin', color: '#red', permissions: ['*'], protected: true };
    getState().servers[srv.id]!.roles = [protectedRole];
    nativeUpdateRole(srv.id, 'role-admin', { name: 'Super Admin' });
    const stored = (getState().servers[srv.id]?.roles ?? []).find(r => r.id === 'role-admin')!;
    expect(stored.name).toBe('Admin'); // unchanged
  });

  it('nativeDeleteRole cannot delete protected roles', () => {
    setNativeIdentity({ id: 'owner', peer_id: 'owner' });
    const srv = nativeCreateServer('Protected Role Test');
    // Manually inject a protected role into the server.
    const protectedRole = { id: 'role-admin', name: 'Admin', color: '#gold', permissions: ['*'], protected: true };
    const server = getState().servers[srv.id]!;
    server.roles = [protectedRole];
    nativeDeleteRole(srv.id, 'role-admin');
    const stored = getState().servers[srv.id]?.roles ?? [];
    expect(stored.some(r => r.id === 'role-admin')).toBe(true);
  });

  it('nativeAssignRole toggles role membership on a member', () => {
    setNativeIdentity({ id: 'owner', peer_id: 'owner' });
    const srv = nativeCreateServer('Assign Role Test');
    const role = nativeCreateRole(srv.id, 'Mod');

    // Assign: member gets the role.
    nativeAssignRole(srv.id, 'member-1', role.id);
    let memberRoles = getState().servers[srv.id]?.member_roles?.['member-1'] ?? [];
    expect(memberRoles).toContain(role.id);

    // Assign again: role is removed (toggle).
    nativeAssignRole(srv.id, 'member-1', role.id);
    memberRoles = getState().servers[srv.id]?.member_roles?.['member-1'] ?? [];
    expect(memberRoles).not.toContain(role.id);
  });
});

describe('polls — P2P poll vote accumulation (Goal 9)', () => {
  it('addPollVote records a vote and returns true for first vote', () => {
    addMessage({ id: 'poll-msg', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p', body: '🗳️ POLL:{"q":"?","o":["A","B"]}' });
    const isNew = addPollVote('poll-msg', 0, 'voter-1');
    expect(isNew).toBe(true);
    const votes = getState().messages.find(m => m.id === 'poll-msg')!.poll_votes!;
    expect(votes[0]).toContain('voter-1');
  });

  it('addPollVote is idempotent — duplicate vote returns false and is not double-counted', () => {
    addMessage({ id: 'poll-dup', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p', body: '🗳️ POLL:{"q":"?","o":["A"]}' });
    addPollVote('poll-dup', 0, 'voter-x');
    const second = addPollVote('poll-dup', 0, 'voter-x');
    expect(second).toBe(false);
    const voters = getState().messages.find(m => m.id === 'poll-dup')!.poll_votes![0];
    expect(voters.filter(v => v === 'voter-x').length).toBe(1);
  });

  it('nativeCastPollVote records the local vote in native state', () => {
    setNativeIdentity({ id: 'me', peer_id: 'me' });
    addMessage({ id: 'pm-1', scope_type: 'channel', scope_id: 'c1', server_id: 'srv', sender_peer_id: 'other', body: '🗳️ POLL:{"q":"Best?","o":["X","Y"]}' });
    nativeCastPollVote('pm-1', 1);
    const votes = getState().messages.find(m => m.id === 'pm-1')!.poll_votes!;
    expect(votes[1]).toContain('me');
  });

  it('nativeCastPollVote is idempotent — second call is a no-op', () => {
    setNativeIdentity({ id: 'me', peer_id: 'me' });
    addMessage({ id: 'pm-2', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'other', body: '🗳️ POLL:{"q":"Favorite?","o":["A","B"]}' });
    nativeCastPollVote('pm-2', 0);
    nativeCastPollVote('pm-2', 0); // duplicate — should not double-count
    const voters = getState().messages.find(m => m.id === 'pm-2')!.poll_votes![0];
    expect(voters.filter(v => v === 'me').length).toBe(1);
  });
});

describe('crowd epoch rotation on member kick', () => {
  it('nativeRemoveMember rotates crowd_root AND bumps crowd_epoch when one is set', () => {
    setNativeIdentity({ id: 'owner', peer_id: 'owner' });
    const srv = nativeCreateServer('Crowd Test');
    // nativeCreateServer seeds crowd_epoch = 0.
    expect(getState().servers[srv.id]?.crowd_epoch).toBe(0);
    // Give the server a known crowd_root (simulates a live crowded channel).
    const originalRoot = 'original-crowd-root-base64value==';
    getState().servers[srv.id]!.crowd_root = originalRoot;
    // Add a member to kick (nativeCreateServer only adds the owner).
    getState().servers[srv.id]!.members = ['owner', 'victim'];

    nativeRemoveMember(srv.id, 'victim');

    const updatedRoot = getState().servers[srv.id]?.crowd_root;
    expect(updatedRoot).toBeDefined();
    expect(updatedRoot).not.toBe(originalRoot);
    // The epoch MUST advance so the kicked member's old root can't decrypt new
    // traffic — a rotated root without an epoch bump would not revoke anything.
    expect(getState().servers[srv.id]?.crowd_epoch).toBe(1);
  });

  it('nativeRemoveMember does not rotate crowd_root when none is set (no crowd encryption)', () => {
    setNativeIdentity({ id: 'owner', peer_id: 'owner' });
    // Build a server stub without a crowd_root (pre-crowd channel, no encryption).
    addServer({ id: 'no-crowd-srv', name: 'No Crowd', owner_peer_id: 'owner', members: ['owner', 'victim2'], channels: {} });
    expect(getState().servers['no-crowd-srv']?.crowd_root).toBeUndefined();

    nativeRemoveMember('no-crowd-srv', 'victim2');

    // crowd_root should remain absent — don't create one where none existed.
    expect(getState().servers['no-crowd-srv']?.crowd_root).toBeUndefined();
  });

  it('nativeRemoveMember removes the kicked member from the member list', () => {
    setNativeIdentity({ id: 'owner', peer_id: 'owner' });
    const srv = nativeCreateServer('Kick Test');
    getState().servers[srv.id]!.members = ['owner', 'to-kick'];
    nativeRemoveMember(srv.id, 'to-kick');
    const members = getState().servers[srv.id]?.members ?? [];
    expect(members).not.toContain('to-kick');
    expect(members).toContain('owner');
  });
});

describe('search — native local message search (Goal 9)', () => {
  it('finds messages by body text (case-insensitive)', () => {
    addMessage({ id: 's1', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p1', body: 'Hello World' });
    addMessage({ id: 's2', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p1', body: 'Goodbye' });
    const { results } = nativeSearchMessages({ query: 'hello' });
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('s1');
  });

  it('filters by scope_type and scope_id', () => {
    addMessage({ id: 'f1', scope_type: 'channel', scope_id: 'ch-x', sender_peer_id: 'p', body: 'channel msg' });
    addMessage({ id: 'f2', scope_type: 'dm', scope_id: 'dm-y', sender_peer_id: 'p', body: 'dm msg' });
    const { results } = nativeSearchMessages({ scope_type: 'channel', scope_id: 'ch-x' });
    expect(results.every(r => r.scope_type === 'channel' && r.scope_id === 'ch-x')).toBe(true);
    expect(results.some(r => r.id === 'f2')).toBe(false);
  });

  it('filters by sender_peer_id', () => {
    addMessage({ id: 'sp1', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'alice', body: 'hi' });
    addMessage({ id: 'sp2', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'bob', body: 'hello' });
    const { results } = nativeSearchMessages({ sender_peer_id: 'alice' });
    expect(results.length).toBe(1);
    expect(results[0].sender_peer_id).toBe('alice');
  });

  it('excludes deleted messages', () => {
    addMessage({ id: 'del1', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p', body: 'delete me' });
    deleteMessage('del1');
    const { results } = nativeSearchMessages({ query: 'delete me' });
    expect(results.some(r => r.id === 'del1')).toBe(false);
  });

  it('respects the limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      addMessage({ id: `lim-${i}`, scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p', body: 'limit test' });
    }
    const { results } = nativeSearchMessages({ query: 'limit test', limit: 3 });
    expect(results.length).toBe(3);
  });

  it('returns messages and their ids', () => {
    addMessage({ id: 'rid1', scope_type: 'channel', scope_id: 'c1', sender_peer_id: 'p', body: 'searchable' });
    const { messages, results } = nativeSearchMessages({ query: 'searchable' });
    expect(messages).toContain('rid1');
    expect(results.some(r => r.id === 'rid1')).toBe(true);
  });
});
