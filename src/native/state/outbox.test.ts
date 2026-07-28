// Tier-2 T2.1: the durable outbound queue actually persists and replays messages
// composed while the transport was down — instead of discarding them behind a
// misleading "offline_queued" badge.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initStore, getState, setNativeIdentity, addServer, updateServer, getOutbox, enqueueOutbox, addMessage } from './store';
import { ChannelCrypto } from '../crowd/channel';
import { SealSessions } from '../seal/session';
import { generateSigningIdentity } from '../crypto/hybrid';
import { registerScopeCrypto, resetScopeCrypto } from '../sync/secureEnvelope';
import { registerPeerSync } from '../sync/registry';
import { nativeSendChannelMessage, nativeSendDmMessage, nativeDrainOutbox } from './mutations';
import { ensureDm } from './store';
import type { PeerSync } from '../sync/peersync';

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

const ME = 'me';
const ALICE = 'alice';
const SRV = 'srv1';
const CHAN = 'chan1';

function freshRootB64(): string {
  const r = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < r.length; i++) s += String.fromCharCode(r[i]);
  return btoa(s);
}

describe('durable outbox (T2.1)', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    registerScopeCrypto({ seal: new SealSessions(ME, generateSigningIdentity()), channels: new ChannelCrypto(), fetchBundle: async () => null });
    addServer({ id: SRV, name: 'S', owner_peer_id: ME, members: [ME, ALICE], channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } } });
    updateServer(SRV, { crowd_root: freshRootB64(), crowd_epoch: 0 });
    registerPeerSync(null as unknown as PeerSync); // relay down
  });
  afterEach(() => resetScopeCrypto());

  it('queues an encrypted envelope when the transport is down (not discarded)', () => {
    const msg = nativeSendChannelMessage(CHAN, 'hello while offline');
    expect(msg.delivery_status).toBe('pending'); // set synchronously; async path flips it
    const queued = getOutbox();
    expect(queued.length).toBe(1);
    expect(queued[0].message_id).toBe(msg.id);
    expect(queued[0].targets).toEqual([ALICE]);
    // The queued payload is the ENCRYPTED envelope, not plaintext.
    expect(JSON.stringify(queued[0].payload)).not.toContain('hello while offline');
    expect(getState().messages.find(m => m.id === msg.id)?.delivery_status).toBe('offline_queued');
  });

  it('replays the queue on reconnect and marks the message sent', async () => {
    const msg = nativeSendChannelMessage(CHAN, 'deliver me later');
    expect(getOutbox().length).toBe(1);

    // Transport comes back: a peersync that delivers to every target.
    const sendToPeer = vi.fn().mockResolvedValue(true);
    registerPeerSync({ sendToPeer } as unknown as PeerSync);

    await nativeDrainOutbox();

    expect(getOutbox().length).toBe(0);
    expect(sendToPeer).toHaveBeenCalledWith(ALICE, expect.any(String), 'chat.send', expect.any(Object));
    expect(getState().messages.find(m => m.id === msg.id)?.delivery_status).toBe('sent');
  });

  it('durably queues a channel send when direct delivery AND mailbox deposit both fail', async () => {
    // A registered (non-null) sync that reaches nobody — the real-outage shape. No
    // mailbox identity is set up, so depositOfflineChat returns false too. The envelope
    // must still end up in the durable outbox, not vanish behind an offline_queued badge.
    const broadcastToScope = vi.fn().mockResolvedValue([ALICE]); // ALICE undelivered
    registerPeerSync({ broadcastToScope } as unknown as PeerSync);

    const msg = nativeSendChannelMessage(CHAN, 'reaches nobody');
    await flush();

    const queued = getOutbox();
    expect(queued.length).toBe(1);
    expect(queued[0].targets).toEqual([ALICE]);
    expect(queued[0].message_id).toBe(msg.id);
    expect(getState().messages.find(m => m.id === msg.id)?.delivery_status).toBe('offline_queued');
  });

  it('persists a retryable pending-seal entry for a first-contact DM with no session', async () => {
    // fetchBundle returns null (recipient offline / unreachable), so encryptDmEnvelope
    // cannot build an envelope. Instead of a silent permanent "queued", a pending-seal
    // entry must be persisted so the drain can re-attempt X3DH + encrypt on reconnect.
    const dmId = 'dm-alice';
    ensureDm(dmId, [ME, ALICE]);
    registerPeerSync({ sendToPeer: vi.fn().mockResolvedValue(false) } as unknown as PeerSync);

    const msg = nativeSendDmMessage(dmId, 'first hello');
    await flush();

    const queued = getOutbox();
    expect(queued.length).toBe(1);
    expect(queued[0].pending_seal?.recipient).toBe(ALICE);
    expect(queued[0].pending_seal?.body).toBe('first hello');
    expect(queued[0].message_id).toBe(msg.id);
    // The queued payload carries NO plaintext envelope (it hasn't been encrypted yet).
    expect(Object.keys(queued[0].payload)).toHaveLength(0);
    expect(getState().messages.find(m => m.id === msg.id)?.delivery_status).toBe('offline_queued');
  });

  it('retains a still-fresh pending-seal entry across a failed drain (time-based, not attempt-based)', async () => {
    // A first-contact DM whose recipient bundle is still unreachable: encryptDmEnvelope
    // (fetchBundle → null) can't seal it. A recent entry must be KEPT (re-queued) so it
    // ships when the peer finally appears — not expired after a handful of attempts.
    registerPeerSync({ sendToPeer: vi.fn().mockResolvedValue(true) } as unknown as PeerSync);
    addMessage({ id: 'm-fresh', scope_type: 'dm', scope_id: 'dm-alice', sender_peer_id: ME, body: 'x', created_at: new Date().toISOString(), delivery_status: 'offline_queued' });
    enqueueOutbox({ id: 'ob-fresh', targets: [ALICE], protocol: 'chat', operation: 'chat.send', payload: {}, message_id: 'm-fresh', created_at: new Date().toISOString(), attempts: 49, pending_seal: { recipient: ALICE, base: {}, body: 'x' } });

    await nativeDrainOutbox();

    // Still queued (re-enqueued), NOT expired despite attempts far past the old cap of 50.
    const q = getOutbox();
    expect(q.length).toBe(1);
    expect(q[0].pending_seal?.recipient).toBe(ALICE);
    expect(getState().messages.find(m => m.id === 'm-fresh')?.delivery_status).toBe('offline_queued');
  });

  it('expires a pending-seal entry older than the retention window and marks it failed', async () => {
    registerPeerSync({ sendToPeer: vi.fn().mockResolvedValue(true) } as unknown as PeerSync);
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(); // 8 days ago (> 7d window)
    addMessage({ id: 'm-old', scope_type: 'dm', scope_id: 'dm-alice', sender_peer_id: ME, body: 'x', created_at: old, delivery_status: 'offline_queued' });
    enqueueOutbox({ id: 'ob-old', targets: [ALICE], protocol: 'chat', operation: 'chat.send', payload: {}, message_id: 'm-old', created_at: old, attempts: 3, pending_seal: { recipient: ALICE, base: {}, body: 'x' } });

    await nativeDrainOutbox();

    expect(getOutbox().length).toBe(0);
    expect(getState().messages.find(m => m.id === 'm-old')?.delivery_status).toBe('failed');
  });

  it('marks the oldest message failed when the outbox cap evicts it', () => {
    addMessage({ id: 'm-evict', scope_type: 'channel', scope_id: CHAN, server_id: SRV, sender_peer_id: ME, body: 'x', created_at: new Date().toISOString(), delivery_status: 'offline_queued' });
    // Fill the queue to the 500 cap; the first entry references the message we track.
    enqueueOutbox({ id: 'ob-0', targets: [ALICE], protocol: 'chat', operation: 'chat.send', payload: {}, message_id: 'm-evict', created_at: new Date().toISOString(), attempts: 0 });
    for (let i = 1; i < 500; i++) {
      enqueueOutbox({ id: `ob-${i}`, targets: [ALICE], protocol: 'chat', operation: 'chat.send', payload: {}, message_id: `m-${i}`, created_at: new Date().toISOString(), attempts: 0 });
    }
    expect(getOutbox().length).toBe(500);
    // One more push over the cap evicts the oldest (ob-0 → m-evict).
    enqueueOutbox({ id: 'ob-500', targets: [ALICE], protocol: 'chat', operation: 'chat.send', payload: {}, message_id: 'm-500', created_at: new Date().toISOString(), attempts: 0 });

    expect(getOutbox().length).toBe(500);
    expect(getOutbox().some(e => e.id === 'ob-0')).toBe(false); // evicted
    expect(getState().messages.find(m => m.id === 'm-evict')?.delivery_status).toBe('failed');
  });

  it('coalesces concurrent drains so a deliverable entry is sent exactly once', async () => {
    const sendToPeer = vi.fn().mockImplementation(() => new Promise(r => setTimeout(() => r(true), 10)));
    registerPeerSync({ sendToPeer } as unknown as PeerSync);
    addMessage({ id: 'm-once', scope_type: 'dm', scope_id: 'dm-alice', sender_peer_id: ME, body: 'x', created_at: new Date().toISOString(), delivery_status: 'offline_queued' });
    enqueueOutbox({ id: 'ob-once', targets: [ALICE], protocol: 'chat', operation: 'chat.send', payload: { ct: 'x' }, message_id: 'm-once', created_at: new Date().toISOString(), attempts: 0 });

    // Fire two overlapping drains; the second must coalesce into the in-flight one.
    await Promise.all([nativeDrainOutbox(), nativeDrainOutbox()]);

    expect(sendToPeer).toHaveBeenCalledTimes(1);
    expect(getOutbox().length).toBe(0);
    expect(getState().messages.find(m => m.id === 'm-once')?.delivery_status).toBe('sent');
  });
});
