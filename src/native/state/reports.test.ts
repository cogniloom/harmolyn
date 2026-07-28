// Tier-1: abuse reporting stores a local copy and targets the right server owner.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { initStore, getState, setNativeIdentity, addServer, getOutbox } from './store';
import { publishNativeSnapshot } from './snapshot';
import { nativeSubmitReport } from './mutations';
import { registerPeerSync } from '../sync/registry';
import type { PeerSync } from '../sync/peersync';

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

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

  it('keeps report content OUT of the plaintext localStorage snapshot', () => {
    addServer({ id: 's1', name: 'S', owner_peer_id: OWNER, members: [OWNER, ME], channels: { c1: { id: 'c1', server_id: 's1', name: 'general', voice: false } } });
    nativeSubmitReport({
      targetKind: 'message', targetId: 'm1', reportedPeerId: 'baddie',
      serverId: 's1', channelId: 'c1', contentExcerpt: 'SENSITIVE-EXCERPT-XYZ', reason: 'harassment',
      details: 'SENSITIVE-DETAILS-XYZ',
    });
    publishNativeSnapshot();
    // The in-memory global keeps reports (moderation UI needs them)...
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(((window as any).__HARMOLYN_XOREIN_RUNTIME__?.reports ?? []).length).toBeGreaterThan(0);
    // ...but the PLAINTEXT localStorage copies must not carry the report content.
    for (const key of ['harmolyn:xorein:runtime', 'harmolyn:runtime-snapshot', 'xorein:runtime-snapshot']) {
      const raw = localStorage.getItem(key) ?? '';
      expect(raw).not.toContain('SENSITIVE-EXCERPT-XYZ');
      expect(raw).not.toContain('SENSITIVE-DETAILS-XYZ');
    }
  });

  it('durably queues a server report when the owner is offline (not silently lost)', async () => {
    addServer({ id: 's1', name: 'S', owner_peer_id: OWNER, members: [OWNER, ME], channels: { c1: { id: 'c1', server_id: 's1', name: 'general', voice: false } } });
    // Owner unreachable: sendToPeer resolves false.
    const sendToPeer = vi.fn().mockResolvedValue(false);
    registerPeerSync({ sendToPeer } as unknown as PeerSync);

    const report = nativeSubmitReport({ targetKind: 'message', targetId: 'm1', reportedPeerId: 'baddie', serverId: 's1', channelId: 'c1', reason: 'harassment' });
    await flush();

    expect(sendToPeer).toHaveBeenCalledWith(OWNER, expect.any(String), 'notify.push', expect.objectContaining({ report_id: report.id }));
    const queued = getOutbox().filter(e => e.operation === 'notify.push');
    expect(queued.length).toBe(1);
    expect(queued[0].targets).toEqual([OWNER]);
    // The queued payload carries the report so the moderator gets it on reconnect.
    expect((queued[0].payload as { report_id?: string }).report_id).toBe(report.id);
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
