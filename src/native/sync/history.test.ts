// WS-D: member-served history + cursor pagination.
//
// handleSyncRequest is the owner/member-served history responder. These cover:
//   • a member cursor-pull (`sync.pull` + before) returns a bounded page of the
//     messages preceding the cursor, with has_more set correctly,
//   • a NON-owner member still serves a read copy (any member can serve history),
//   • a non-member cannot page history (cursor pull returns nothing for them),
//   • a brand-new joiner's initial window is clamped to join_history_messages.
import { describe, it, expect, beforeEach } from 'vitest';
import { initStore, setNativeIdentity, addServer, addMessage } from '../state/store.js';
import { handleSyncRequest } from './inbound.js';
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

  it('strips the invite_secret from the served server record', () => {
    seed(3);
    const res = handleSyncRequest('sync.pull', { server_id: SRV }, MEMBER);
    expect((res.server as Record<string, unknown>).invite_secret).toBeUndefined();
  });
});
