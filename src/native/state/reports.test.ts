// Tier-1: abuse reporting stores a local copy and targets the right server owner.
import { describe, it, expect, beforeEach } from 'vitest';
import { initStore, getState, setNativeIdentity, addServer } from './store';
import { nativeSubmitReport } from './mutations';

const ME = 'reporter';
const OWNER = 'server-owner';

describe('nativeSubmitReport', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
  });

  it('records a local copy of a server report attributed to the local peer', () => {
    addServer({ id: 's1', name: 'S', owner_peer_id: OWNER, members: [OWNER, ME], channels: { c1: { id: 'c1', server_id: 's1', name: 'general', voice: false } } });
    const report = nativeSubmitReport({
      targetKind: 'message', targetId: 'm1', reportedPeerId: 'baddie',
      serverId: 's1', channelId: 'c1', contentExcerpt: 'something bad', reason: 'harassment',
    });
    const stored = getState().reports.find(r => r.id === report.id);
    expect(stored).toBeTruthy();
    expect(stored!.reporter_peer_id).toBe(ME);
    expect(stored!.reason).toBe('harassment');
    expect(stored!.server_id).toBe('s1');
    expect(stored!.inbound).toBeFalsy();
  });

  it('records a DM report locally with no server scope', () => {
    const report = nativeSubmitReport({ targetKind: 'user', targetId: 'baddie', reportedPeerId: 'baddie', reason: 'spam' });
    const stored = getState().reports.find(r => r.id === report.id);
    expect(stored).toBeTruthy();
    expect(stored!.server_id).toBeUndefined();
    expect(stored!.target_kind).toBe('user');
  });

  it('truncates an over-long content excerpt', () => {
    const report = nativeSubmitReport({ targetKind: 'message', targetId: 'm', reason: 'other', contentExcerpt: 'x'.repeat(500) });
    expect(getState().reports.find(r => r.id === report.id)!.content_excerpt!.length).toBe(280);
  });
});
