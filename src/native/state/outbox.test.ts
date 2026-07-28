// Tier-2 T2.1: the durable outbound queue actually persists and replays messages
// composed while the transport was down — instead of discarding them behind a
// misleading "offline_queued" badge.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { initStore, getState, setNativeIdentity, addServer, updateServer, getOutbox } from './store';
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
});
