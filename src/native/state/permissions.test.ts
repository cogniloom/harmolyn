// Tier-0 A8: privileged metadata ops (pin) require real authorization, not just an
// authenticated connection. memberHasPermission is the gate; the pin mutation and
// the inbound pin handler both consult it.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  initStore, getState, setNativeIdentity, addServer, addMessage, memberHasPermission, removeServerMember,
} from './store';
import { nativePinMessage } from './mutations';

const OWNER = 'owner';
const MOD = 'mod';
const PLAIN = 'plain';
const SRV = 'srv1';

function seedServer(): void {
  addServer({
    id: SRV, name: 'S', owner_peer_id: OWNER,
    members: [OWNER, MOD, PLAIN],
    channels: { c1: { id: 'c1', server_id: SRV, name: 'general', voice: false } },
    roles: [{ id: 'r-mod', name: 'Moderator', permissions: ['MANAGE_MESSAGES'] }],
    member_roles: { [MOD]: ['r-mod'] },
  });
  addMessage({ id: 'm1', scope_type: 'channel', scope_id: 'c1', server_id: SRV, sender_peer_id: OWNER, body: 'hi', created_at: '2026-01-01T00:00:00.000Z' });
}

describe('memberHasPermission (A8)', () => {
  beforeEach(() => { localStorage.clear(); initStore(); seedServer(); });

  it('owner implicitly has every permission', () => {
    expect(memberHasPermission(SRV, OWNER, 'MANAGE_MESSAGES')).toBe(true);
  });
  it('a member with a granting role has the permission', () => {
    expect(memberHasPermission(SRV, MOD, 'MANAGE_MESSAGES')).toBe(true);
  });
  it('a plain member without a granting role does not', () => {
    expect(memberHasPermission(SRV, PLAIN, 'MANAGE_MESSAGES')).toBe(false);
  });
  it('a KICKED moderator whose member_roles linger loses the permission (requires current membership)', () => {
    expect(memberHasPermission(SRV, MOD, 'MANAGE_MESSAGES')).toBe(true); // still a member
    removeServerMember(SRV, MOD); // drops from members; member_roles assignment may remain
    expect(getState().servers[SRV].members).not.toContain(MOD);
    expect(memberHasPermission(SRV, MOD, 'MANAGE_MESSAGES')).toBe(false);
  });
});

describe('nativePinMessage authorization (A8)', () => {
  beforeEach(() => { localStorage.clear(); initStore(); seedServer(); });

  it('a plain member cannot pin — the mutation THROWS so the optimistic UI rolls back', () => {
    setNativeIdentity({ id: PLAIN, peer_id: PLAIN });
    // Must reject (not silently return) so React Query runs its rollback handler and the
    // unauthorized optimistic pin doesn't stick in the archive.
    expect(() => nativePinMessage('c1', 'm1')).toThrow(/not authorized/i);
    expect(getState().messages.find(m => m.id === 'm1')?.pinned).toBeFalsy();
  });

  it('the owner can pin', () => {
    setNativeIdentity({ id: OWNER, peer_id: OWNER });
    nativePinMessage('c1', 'm1');
    expect(getState().messages.find(m => m.id === 'm1')?.pinned).toBe(true);
  });
});
