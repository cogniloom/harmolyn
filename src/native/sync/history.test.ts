// WS-D: member-served history + cursor pagination.
//
// handleSyncRequest is the owner/member-served history responder. These cover:
//   • a member cursor-pull (`sync.pull` + before) returns a bounded page of the
//     messages preceding the cursor, with has_more set correctly,
//   • a NON-owner member still serves a read copy (any member can serve history),
//   • a non-member cannot page history (cursor pull returns nothing for them),
//   • a brand-new joiner's initial window is clamped to join_history_messages.
import { describe, it, expect, beforeEach } from 'vitest';
import { initStore, setNativeIdentity, addServer, addMessage, updateServer, getState } from '../state/store.js';
import { handleSyncRequest } from './inbound.js';
import { computeInviteToken } from './invite.js';
import type { XoreinRuntimeMessage } from '../../types.js';

const OWNER = 'owner';
const MEMBER = 'member';
const OUTSIDER = 'outsider';
const SRV = 'srv1';
const CHAN = 'chan1';

function seed(count: number, opts: { owner?: string } = {}): void {
  addServer({
    id: SRV,
    name: 'S',
    owner_peer_id: opts.owner ?? OWNER,
    members: [OWNER, MEMBER],
    channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } },
    // Open invite so a new joiner path is exercisable; retention generous.
    invite_secret: 'sekret',
    manifest: { history_retention_messages: 100, join_history_messages: 0 } as never,
  });
  for (let i = 0; i < count; i++) {
    const n = String(i).padStart(4, '0');
    addMessage({
      id: `m-${n}`,
      scope_type: 'channel',
      scope_id: CHAN,
      server_id: SRV,
      sender_peer_id: OWNER,
      body: `msg ${n}`,
      created_at: `2026-01-01T00:00:${n.slice(-2)}.000Z`,
    } as XoreinRuntimeMessage);
  }
}

describe('handleSyncRequest — cursor pagination (WS-D)', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: OWNER, peer_id: OWNER });
  });

  it('serves a bounded page of messages before the cursor to a member', () => {
    seed(30);
    // Cursor at the 20th message; a member asks for the 5 before it.
    const res = handleSyncRequest('sync.pull', { server_id: SRV, before: '2026-01-01T00:00:20.000Z', limit: 5 }, MEMBER);
    expect(res.ok).toBe(true);
    const msgs = res.messages as XoreinRuntimeMessage[];
    expect(msgs).toHaveLength(5);
    // The page is the last 5 before the cursor: indices 15..19.
    expect(msgs.map(m => m.id)).toEqual(['m-0015', 'm-0016', 'm-0017', 'm-0018', 'm-0019']);
    // There are older messages still (0..14) → has_more true.
    expect(res.has_more).toBe(true);
  });

  it('scopes a cursor page to the requested channel (WS-D hardening)', () => {
    seed(10);
    // Add a second channel with its own messages interleaved in time.
    const CHAN2 = 'chan2';
    for (let i = 0; i < 10; i++) {
      const n = String(i).padStart(4, '0');
      addMessage({ id: `c2-${n}`, scope_type: 'channel', scope_id: CHAN2, server_id: SRV,
        sender_peer_id: OWNER, body: `c2 ${n}`, created_at: `2026-01-01T00:00:${n.slice(-2)}.500Z` } as XoreinRuntimeMessage);
    }
    const res = handleSyncRequest('sync.pull', { server_id: SRV, channel_id: CHAN, before: '2026-01-01T00:00:09.000Z', limit: 50 }, MEMBER);
    const msgs = res.messages as XoreinRuntimeMessage[];
    // Only CHAN messages come back — none from chan2.
    expect(msgs.every(m => m.scope_id === CHAN)).toBe(true);
    expect(msgs.some(m => m.id.startsWith('c2-'))).toBe(false);
  });

  it('clamps a cursor page to the retention window (WS-D hardening)', () => {
    // 30 messages but retention of only 5: paging can never reach beyond the last 5.
    addServer({ id: SRV, name: 'S', owner_peer_id: OWNER, members: [OWNER, MEMBER],
      channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } },
      invite_secret: 'sekret', manifest: { history_retention_messages: 5, join_history_messages: 0 } as never });
    for (let i = 0; i < 30; i++) {
      const n = String(i).padStart(4, '0');
      addMessage({ id: `r-${n}`, scope_type: 'channel', scope_id: CHAN, server_id: SRV,
        sender_peer_id: OWNER, body: `r ${n}`, created_at: `2026-01-01T00:00:${n.slice(-2)}.000Z` } as XoreinRuntimeMessage);
    }
    // Cursor at the very end; even with a huge limit only the retained window is served.
    const res = handleSyncRequest('sync.pull', { server_id: SRV, channel_id: CHAN, before: '2026-01-01T00:00:59.000Z', limit: 50 }, MEMBER);
    const msgs = res.messages as XoreinRuntimeMessage[];
    // Only the last 5 (retention) messages — never the older 25.
    expect(msgs.map(m => m.id)).toEqual(['r-0025', 'r-0026', 'r-0027', 'r-0028', 'r-0029']);
  });

  it('reports has_more false once the earliest messages are reached', () => {
    seed(10);
    const res = handleSyncRequest('sync.pull', { server_id: SRV, before: '2026-01-01T00:00:03.000Z', limit: 50 }, MEMBER);
    const msgs = res.messages as XoreinRuntimeMessage[];
    expect(msgs.map(m => m.id)).toEqual(['m-0000', 'm-0001', 'm-0002']);
    expect(res.has_more).toBe(false);
  });

  it('pages messages that share a created_at via the (created_at, id) cursor', () => {
    // 6 messages, ALL at the same timestamp — a created_at-only cursor would skip the
    // rest of the batch after the first page. The composite (before, before_id) cursor
    // keeps them pageable.
    const TS = '2026-01-01T00:00:05.000Z';
    addServer({ id: SRV, name: 'S', owner_peer_id: OWNER, members: [OWNER, MEMBER],
      channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } },
      invite_secret: 'sekret', manifest: { history_retention_messages: 100, join_history_messages: 0 } as never });
    for (const id of ['e', 'd', 'c', 'b', 'a']) {
      addMessage({ id, scope_type: 'channel', scope_id: CHAN, server_id: SRV, sender_peer_id: OWNER, body: id, created_at: TS } as XoreinRuntimeMessage);
    }
    // First page: cursor after everything at TS (high id sentinel), limit 2 → last two by id order (d,e).
    const p1 = handleSyncRequest('sync.pull', { server_id: SRV, channel_id: CHAN, before: TS, before_id: '￿', limit: 2 }, MEMBER);
    const ids1 = (p1.messages as XoreinRuntimeMessage[]).map(m => m.id);
    expect(ids1).toEqual(['d', 'e']);
    expect(p1.has_more).toBe(true);
    // Next page: cursor before the oldest we got ('d') → same timestamp, id < 'd' (b,c).
    const p2 = handleSyncRequest('sync.pull', { server_id: SRV, channel_id: CHAN, before: TS, before_id: 'd', limit: 2 }, MEMBER);
    expect((p2.messages as XoreinRuntimeMessage[]).map(m => m.id)).toEqual(['b', 'c']);
    // Final page reaches 'a' — nothing older remains at this timestamp.
    const p3 = handleSyncRequest('sync.pull', { server_id: SRV, channel_id: CHAN, before: TS, before_id: 'b', limit: 2 }, MEMBER);
    expect((p3.messages as XoreinRuntimeMessage[]).map(m => m.id)).toEqual(['a']);
    expect(p3.has_more).toBe(false);
  });

  it('a non-owner member serves a read copy (initial full window)', () => {
    // Local identity is the MEMBER, server owned by someone else.
    setNativeIdentity({ id: MEMBER, peer_id: MEMBER });
    seed(5, { owner: OWNER });
    // The OWNER re-pulls from us (a member) — alreadyMember true → full window.
    const res = handleSyncRequest('sync.pull', { server_id: SRV }, OWNER);
    expect(res.ok).toBe(true);
    expect((res.messages as XoreinRuntimeMessage[]).length).toBe(5);
    // We are not the owner, yet we served history.
    expect((res.server as { owner_peer_id: string }).owner_peer_id).toBe(OWNER);
  });

  it('a non-member cannot page history', () => {
    seed(20);
    const res = handleSyncRequest('sync.pull', { server_id: SRV, before: '2026-01-01T00:00:10.000Z', limit: 5 }, OUTSIDER);
    // No valid invite token and not a member → declined.
    expect(res.ok).toBe(false);
    expect(res.error).toBe('invalid_invite');
  });

  it('enforces the join boundary on later pulls, not just the initial join (P1 leak)', () => {
    // All seeded messages predate "now", so they are pre-join for any new joiner.
    seed(20);
    const token = computeInviteToken('sekret', SRV);

    // A brand-new joiner joins with a valid invite: join_history_messages=0 → no history.
    const joinRes = handleSyncRequest('sync.join', { server_id: SRV, invite_token: token }, OUTSIDER);
    expect(joinRes.ok).toBe(true);
    expect((joinRes.messages as XoreinRuntimeMessage[]).length).toBe(0);

    // The joiner is now a member. A LATER cursor pull must STILL withhold the pre-join
    // history — previously `alreadyMember` flipped true and served the full window.
    const pullRes = handleSyncRequest('sync.pull', { server_id: SRV, channel_id: CHAN, before: '2026-01-01T00:00:59.000Z', limit: 50 }, OUTSIDER);
    expect(pullRes.ok).toBe(true);
    expect((pullRes.messages as XoreinRuntimeMessage[]).length).toBe(0);

    // A message sent AFTER they joined is visible to them (boundary is a floor, not a mute).
    addMessage({ id: 'm-post', scope_type: 'channel', scope_id: CHAN, server_id: SRV, sender_peer_id: OWNER, body: 'after join', created_at: '2099-01-01T00:00:00.000Z' } as XoreinRuntimeMessage);
    const afterRes = handleSyncRequest('sync.pull', { server_id: SRV, channel_id: CHAN, before: '2099-01-02T00:00:00.000Z', limit: 50 }, OUTSIDER);
    expect((afterRes.messages as XoreinRuntimeMessage[]).map(m => m.id)).toEqual(['m-post']);
  });

  it('strips the invite_secret from the served server record', () => {
    seed(3);
    const res = handleSyncRequest('sync.pull', { server_id: SRV }, MEMBER);
    expect((res.server as Record<string, unknown>).invite_secret).toBeUndefined();
  });
});

// Finding 6 regression: the pre-join history boundary must be enforced by EVERY
// responder, not only the owner. member_since is distributed as owner-authoritative
// record metadata (sync.join/pull responses + sync.update), persisted member-side,
// and a non-owner responder with NO recorded boundary for the requester fails
// closed to the join_history_messages allowance instead of serving the full window.
describe('handleSyncRequest — pre-join boundary on non-owner responders (finding 6)', () => {
  const NEWBIE = 'newbie';

  beforeEach(() => {
    localStorage.clear();
    initStore();
  });

  it('FAILS CLOSED: a member responder with no recorded boundary serves only the join allowance', () => {
    // Responder is a plain MEMBER; requester NEWBIE is on the member list but the
    // responder's copy holds no member_since entry for them (e.g. it predates their
    // join). Without the fix, applyJoinBoundary saw memberSince=undefined and served
    // the full 20-message pre-join window.
    setNativeIdentity({ id: MEMBER, peer_id: MEMBER });
    seed(20, { owner: OWNER });
    updateServer(SRV, { members: [OWNER, MEMBER, NEWBIE] });
    const res = handleSyncRequest('sync.pull', { server_id: SRV }, NEWBIE);
    expect(res.ok).toBe(true);
    // join_history_messages = 0 → zero pre-join history from a non-owner responder.
    expect((res.messages as XoreinRuntimeMessage[]).length).toBe(0);
  });

  it('enforces the owner-distributed boundary on a member responder (pre-join withheld, post-join served)', () => {
    setNativeIdentity({ id: MEMBER, peer_id: MEMBER });
    seed(10, { owner: OWNER }); // created_at 00:00:00 .. 00:00:09
    updateServer(SRV, {
      members: [OWNER, MEMBER, NEWBIE],
      member_since: { [NEWBIE]: '2026-01-01T00:00:05.000Z' },
    });
    const res = handleSyncRequest('sync.pull', { server_id: SRV }, NEWBIE);
    expect(res.ok).toBe(true);
    expect((res.messages as XoreinRuntimeMessage[]).map(m => m.id))
      .toEqual(['m-0005', 'm-0006', 'm-0007', 'm-0008', 'm-0009']);
  });

  it('persists member_since from an owner sync.update so members can enforce it later', () => {
    setNativeIdentity({ id: MEMBER, peer_id: MEMBER });
    seed(5, { owner: OWNER });
    handleSyncRequest('sync.update', {
      server_id: SRV,
      server: {
        id: SRV, owner_peer_id: OWNER,
        members: [OWNER, MEMBER, NEWBIE],
        member_since: { [NEWBIE]: '2026-01-01T00:00:03.000Z' },
        server_rev: 1,
      },
    }, OWNER);
    expect(getState().servers[SRV].member_since).toEqual({ [NEWBIE]: '2026-01-01T00:00:03.000Z' });
    // The persisted boundary is enforced on the next member-served pull.
    const res = handleSyncRequest('sync.pull', { server_id: SRV }, NEWBIE);
    expect((res.messages as XoreinRuntimeMessage[]).map(m => m.id)).toEqual(['m-0003', 'm-0004']);
  });

  it('the served server record carries member_since but still strips invite_secret', () => {
    setNativeIdentity({ id: OWNER, peer_id: OWNER });
    seed(3);
    updateServer(SRV, { member_since: { [MEMBER]: '2026-01-01T00:00:01.000Z' } });
    const res = handleSyncRequest('sync.pull', { server_id: SRV }, MEMBER);
    const served = res.server as Record<string, unknown>;
    expect(served.member_since).toEqual({ [MEMBER]: '2026-01-01T00:00:01.000Z' });
    expect(served.invite_secret).toBeUndefined();
  });

  it('never clamps the requesting OWNER, even on a member responder with no boundary map', () => {
    setNativeIdentity({ id: MEMBER, peer_id: MEMBER });
    seed(5, { owner: OWNER });
    const res = handleSyncRequest('sync.pull', { server_id: SRV }, OWNER);
    expect((res.messages as XoreinRuntimeMessage[]).length).toBe(5);
  });
});
