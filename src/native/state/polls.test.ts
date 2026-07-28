// Round-9: poll integrity. A peer holds at most one vote across ALL options (single
// choice), and inbound poll_vote notify.push events are only honored from a current
// participant of the poll's scope — a kicked member (or any peer that learned the
// message id) must not be able to change results.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStore, getState, setNativeIdentity, addServer, addMessage, ensureDm,
  addPollVote, isScopeMember, removeServerMember,
} from './store';

const ME = 'me';
const ALICE = 'alice';
const BOB = 'bob';
const SRV = 'srv1';

function seedPoll(): void {
  addServer({
    id: SRV, name: 'S', owner_peer_id: ME, members: [ME, ALICE, BOB],
    channels: { c1: { id: 'c1', server_id: SRV, name: 'general', voice: false } },
  });
  addMessage({ id: 'poll1', scope_type: 'channel', scope_id: 'c1', server_id: SRV, sender_peer_id: ME, body: 'pick one', created_at: '2026-01-01T00:00:00.000Z' });
}

describe('addPollVote — single vote per peer (Round-9)', () => {
  beforeEach(() => { localStorage.clear(); initStore(); setNativeIdentity({ id: ME, peer_id: ME }); seedPoll(); });

  it('records a first vote', () => {
    expect(addPollVote('poll1', 0, ALICE)).toBe(true);
    expect(getState().messages.find(m => m.id === 'poll1')?.poll_votes?.[0]).toEqual([ALICE]);
  });

  it('rejects the same peer voting a SECOND, different option (no vote stacking)', () => {
    expect(addPollVote('poll1', 0, ALICE)).toBe(true);
    // Even though option 1 has no ALICE entry yet, ALICE already voted in option 0.
    expect(addPollVote('poll1', 1, ALICE)).toBe(false);
    const votes = getState().messages.find(m => m.id === 'poll1')?.poll_votes ?? {};
    expect(votes[1] ?? []).not.toContain(ALICE);
    // Other peers still vote independently.
    expect(addPollVote('poll1', 1, BOB)).toBe(true);
  });
});

describe('isScopeMember — poll-vote authorization gate (Round-9)', () => {
  beforeEach(() => { localStorage.clear(); initStore(); setNativeIdentity({ id: ME, peer_id: ME }); seedPoll(); ensureDm('dm1', [ME, ALICE]); });

  it('recognizes a current channel member and rejects a kicked one', () => {
    expect(isScopeMember('c1', 'channel', SRV, ALICE)).toBe(true);
    removeServerMember(SRV, ALICE);
    expect(isScopeMember('c1', 'channel', SRV, ALICE)).toBe(false);
  });

  it('recognizes a DM participant and rejects a non-participant', () => {
    expect(isScopeMember('dm1', 'dm', undefined, ALICE)).toBe(true);
    expect(isScopeMember('dm1', 'dm', undefined, BOB)).toBe(false);
  });
});
