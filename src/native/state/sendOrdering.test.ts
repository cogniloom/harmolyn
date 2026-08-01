// LATENCY REGRESSION (send-path ordering): the encrypted envelope must be handed
// to the network layer BEFORE the heavy snapshot publish. publishNativeSnapshot
// does a full-snapshot JSON.stringify, three localStorage writes, and dispatches
// 'focus'/'visibilitychange' (driving React refetches) — running it inline ahead
// of the broadcast serialized all of that in front of the wire send. These tests
// fail against the old ordering (publish first, broadcast second) and also pin
// the durability behavior so the reorder can never silently weaken it.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import type { Mock } from 'vitest';

vi.mock('./snapshot', () => {
  // Faithful mock of the coalescing scheduler: schedule defers one macrotask and
  // collapses same-tick requests into one call of the mocked publish, exactly
  // like the real snapshot.ts pair — the ordering assertions below depend on it.
  const publishNativeSnapshot = vi.fn();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedulePublishNativeSnapshot = vi.fn(() => {
    if (timer !== null) return;
    timer = setTimeout(() => { timer = null; publishNativeSnapshot(); }, 0);
  });
  return { publishNativeSnapshot, schedulePublishNativeSnapshot };
});

import { publishNativeSnapshot } from './snapshot';
import {
  initStore, getState, setNativeIdentity, addServer, updateServer, ensureDm, getOutbox,
} from './store';
import { ChannelCrypto } from '../crowd/channel';
import { SealSessions } from '../seal/session';
import { generateIdentity, identitySigningKey, type XoreinIdentity } from '../identity/identity';
import { registerScopeCrypto, resetScopeCrypto } from '../sync/secureEnvelope';
import { registerHistoryIdentity, resetHistoryIdentity } from '../sync/signedHistory';
import { registerPeerSync } from '../sync/registry';
import { nativeSendChannelMessage, nativeSendDmMessage } from './mutations';
import type { PeerSync } from '../sync/peersync';

const flush = () => new Promise((resolve) => setTimeout(resolve, 20));

let identity: XoreinIdentity;
let ME = '';
const ALICE = 'alice';
const SRV = 'srv1';
const CHAN = 'chan1';

function freshRootB64(): string {
  const r = crypto.getRandomValues(new Uint8Array(32));
  let s = '';
  for (let i = 0; i < r.length; i++) s += String.fromCharCode(r[i]);
  return btoa(s);
}

const publishMock = publishNativeSnapshot as unknown as Mock;

describe('send-path ordering: wire before snapshot publish', () => {
  beforeAll(async () => {
    identity = await generateIdentity();
    ME = identity.peerId;
  });

  beforeEach(() => {
    localStorage.clear();
    publishMock.mockClear();
    initStore();
    setNativeIdentity({ id: ME, peer_id: ME });
    registerHistoryIdentity(identity);
    registerScopeCrypto({ seal: new SealSessions(ME, identitySigningKey(identity)), channels: new ChannelCrypto(), fetchBundle: async () => null });
    addServer({ id: SRV, name: 'S', owner_peer_id: ME, members: [ME, ALICE], channel_security_mode: 'crowd', channel_crypto_profile: 'scope-aad-v2', channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } } });
    updateServer(SRV, { crowd_root: freshRootB64(), crowd_epoch: 0 });
  });
  afterEach(() => {
    resetScopeCrypto();
    resetHistoryIdentity();
    registerPeerSync(null as unknown as PeerSync);
  });

  it('channel send: broadcast is initiated synchronously, snapshot publish is deferred behind it', async () => {
    const broadcastToScope = vi.fn().mockResolvedValue([]); // every target reached
    registerPeerSync({ broadcastToScope } as unknown as PeerSync);

    const msg = nativeSendChannelMessage(CHAN, 'wire first');

    // The wire broadcast was initiated within the synchronous call...
    expect(broadcastToScope).toHaveBeenCalledTimes(1);
    // ...and the heavy snapshot publish has NOT run yet — it is deferred so the
    // dial/negotiate/write microtasks of the broadcast drain ahead of it.
    expect(publishMock).not.toHaveBeenCalled();

    await flush();

    // The publish still happens (local echo is not lost)...
    expect(publishMock).toHaveBeenCalled();
    // ...and strictly AFTER the broadcast was initiated.
    expect(broadcastToScope.mock.invocationCallOrder[0])
      .toBeLessThan(publishMock.mock.invocationCallOrder[0]);
    // Delivery-status transition still lands exactly as before.
    expect(getState().messages.find(m => m.id === msg.id)?.delivery_status).toBe('sent');
  });

  it('channel send: transport down still durably queues and publishes (reorder does not weaken durability)', async () => {
    registerPeerSync(null as unknown as PeerSync); // relay/transport down

    const msg = nativeSendChannelMessage(CHAN, 'queued while offline');

    const queued = getOutbox();
    expect(queued.length).toBe(1);
    expect(queued[0].message_id).toBe(msg.id);
    expect(queued[0].targets).toEqual([ALICE]);
    expect(JSON.stringify(queued[0].payload)).not.toContain('queued while offline'); // encrypted
    expect(getState().messages.find(m => m.id === msg.id)?.delivery_status).toBe('offline_queued');

    await flush();
    expect(publishMock).toHaveBeenCalled(); // echo still published
  });

  it('channel send: mailbox/outbox fallback still runs when a peer is unreachable', async () => {
    const broadcastToScope = vi.fn().mockResolvedValue([ALICE]); // ALICE undelivered
    registerPeerSync({ broadcastToScope } as unknown as PeerSync);

    const msg = nativeSendChannelMessage(CHAN, 'reaches nobody');
    await flush();

    const queued = getOutbox();
    expect(queued.length).toBe(1); // deposit fails (no mailbox identity) → durable outbox
    expect(queued[0].message_id).toBe(msg.id);
    expect(getState().messages.find(m => m.id === msg.id)?.delivery_status).toBe('offline_queued');
  });

  it('dm send: snapshot publish is deferred until after the seal/deliver chain starts', async () => {
    const dmId = 'dm-alice';
    ensureDm(dmId, [ME, ALICE]);
    publishMock.mockClear(); // ensureDm may publish via other paths; isolate the send
    registerPeerSync({ sendToPeer: vi.fn().mockResolvedValue(true) } as unknown as PeerSync);

    const msg = nativeSendDmMessage(dmId, 'dm wire first');

    // Message stored synchronously (durability), but the publish is deferred.
    expect(getState().messages.some(m => m.id === msg.id)).toBe(true);
    expect(publishMock).not.toHaveBeenCalled();

    await flush();
    expect(publishMock).toHaveBeenCalled();
    // First-contact with no reachable bundle → retryable pending-seal entry, as before.
    expect(getOutbox().some(e => e.pending_seal?.recipient === ALICE)).toBe(true);
  });
});
