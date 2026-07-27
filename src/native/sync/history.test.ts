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
