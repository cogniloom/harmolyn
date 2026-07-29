// Pin/unpin P2P propagation: a pin must actually REACH other server members
// (broadcast as a notify.push, durably queued for unreachable peers and replayed
// by the outbox drain) and must only be APPLIED on the receiving side when the
// authenticated sender genuinely holds MANAGE_MESSAGES — connection auth proves
// who sent it, not that they were allowed to pin.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  initStore, getState, setNativeIdentity, addServer, addMessage, getOutbox,
} from './store';
import { registerPeerSync } from '../sync/registry';
import { PROTOCOLS } from '../families/families';
import { nativePinMessage, nativeUnpinMessage, nativeDrainOutbox } from './mutations';
import { ingestNotifyPush } from '../sync/inbound';
import type { PeerSync } from '../sync/peersync';

const OWNER = 'owner';
const MOD = 'mod';
const PLAIN = 'plain';
const SRV = 'srv1';
const CHAN = 'c1';
const MSG = 'm1';

const flush = () => new Promise((resolve) => setTimeout(resolve, 15));

function seedServer(): void {
  addServer({
    id: SRV, name: 'S', owner_peer_id: OWNER,
    members: [OWNER, MOD, PLAIN],
    channels: { [CHAN]: { id: CHAN, server_id: SRV, name: 'general', voice: false } },
    roles: [{ id: 'r-mod', name: 'Moderator', permissions: ['MANAGE_MESSAGES'] }],
    member_roles: { [MOD]: ['r-mod'] },
  });
  addMessage({ id: MSG, scope_type: 'channel', scope_id: CHAN, server_id: SRV, sender_peer_id: OWNER, body: 'hi', created_at: '2026-01-01T00:00:00.000Z' });
}

function mockSync(overrides: Partial<{ broadcastToScope: ReturnType<typeof vi.fn>; sendToPeer: ReturnType<typeof vi.fn> }> = {}) {
  return {
    // Returns the UNDELIVERED peer ids (empty = everyone reached).
    broadcastToScope: overrides.broadcastToScope ?? vi.fn().mockResolvedValue([]),
    sendToPeer: overrides.sendToPeer ?? vi.fn().mockResolvedValue(true),
  };
}

afterEach(() => {
  registerPeerSync(null as unknown as PeerSync);
});

describe('nativePinMessage / nativeUnpinMessage — P2P propagation', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: OWNER, peer_id: OWNER });
    seedServer();
  });

  it('broadcasts a pin notify.push to the other server members (never to self)', async () => {
    const sync = mockSync();
    registerPeerSync(sync as unknown as PeerSync);

    nativePinMessage(CHAN, MSG);
    await flush();

    expect(getState().messages.find(m => m.id === MSG)?.pinned).toBe(true);
    expect(sync.broadcastToScope).toHaveBeenCalledTimes(1);
    const [targets, protocol, op, payload] = sync.broadcastToScope.mock.calls[0];
    expect(targets).toEqual([MOD, PLAIN]); // self excluded
    expect(protocol).toBe(PROTOCOLS.notify);
    expect(op).toBe('notify.push');
    expect(payload).toMatchObject({ kind: 'pin', channel_id: CHAN, message_id: MSG, pinned: true, from_peer_id: OWNER });
    // Everyone reached — nothing durably queued.
    expect(getOutbox().length).toBe(0);
  });

  it('broadcasts an unpin (pinned:false) to the other members', async () => {
    const sync = mockSync();
    registerPeerSync(sync as unknown as PeerSync);

    nativePinMessage(CHAN, MSG);
    await flush();
    nativeUnpinMessage(CHAN, MSG);
    await flush();

    expect(getState().messages.find(m => m.id === MSG)?.pinned).toBe(false);
    const last = sync.broadcastToScope.mock.calls.at(-1)!;
    expect(last[3]).toMatchObject({ kind: 'pin', message_id: MSG, pinned: false });
  });

  it('durably queues the pin for unreachable members and the drain replays it', async () => {
    // MOD reached, PLAIN unreachable → PLAIN must land in the durable outbox.
    const sync = mockSync({ broadcastToScope: vi.fn().mockResolvedValue([PLAIN]) });
    registerPeerSync(sync as unknown as PeerSync);

    nativePinMessage(CHAN, MSG);
    await flush();

    const queued = getOutbox();
    expect(queued.length).toBe(1);
    expect(queued[0].targets).toEqual([PLAIN]);
    expect(queued[0].protocol).toBe(PROTOCOLS.notify);
    expect(queued[0].operation).toBe('notify.push');
    expect((queued[0].payload as { kind?: string; pinned?: boolean })).toMatchObject({ kind: 'pin', pinned: true });

    // Peer comes back: the drain delivers the pin and clears the queue.
    const backOnline = mockSync();
    registerPeerSync(backOnline as unknown as PeerSync);
    await nativeDrainOutbox();

    expect(backOnline.sendToPeer).toHaveBeenCalledWith(
      PLAIN, PROTOCOLS.notify, 'notify.push', expect.objectContaining({ kind: 'pin', message_id: MSG, pinned: true }),
    );
    expect(getOutbox().length).toBe(0);
  });

  it('queues for ALL members when no transport is registered at all', async () => {
    registerPeerSync(null as unknown as PeerSync);

    nativePinMessage(CHAN, MSG);
    await flush();

    const queued = getOutbox();
    expect(queued.length).toBe(1);
    expect(queued[0].targets).toEqual([MOD, PLAIN]);
    // The local pin still applied — only delivery is deferred.
    expect(getState().messages.find(m => m.id === MSG)?.pinned).toBe(true);
  });
});

describe('inbound notify.push pin — receiver-side apply + authorization', () => {
  beforeEach(() => {
    localStorage.clear();
    initStore();
    // We are a PLAIN member receiving someone else's pin.
    setNativeIdentity({ id: PLAIN, peer_id: PLAIN });
    seedServer();
  });

  it('applies a pin from the owner (implicit MANAGE_MESSAGES)', () => {
    ingestNotifyPush({ kind: 'pin', channel_id: CHAN, message_id: MSG, pinned: true }, OWNER);
    expect(getState().messages.find(m => m.id === MSG)?.pinned).toBe(true);
  });

  it('applies a pin from a member holding a MANAGE_MESSAGES role, and an unpin', () => {
    ingestNotifyPush({ kind: 'pin', channel_id: CHAN, message_id: MSG, pinned: true }, MOD);
    expect(getState().messages.find(m => m.id === MSG)?.pinned).toBe(true);

    ingestNotifyPush({ kind: 'pin', channel_id: CHAN, message_id: MSG, pinned: false }, MOD);
    expect(getState().messages.find(m => m.id === MSG)?.pinned).toBe(false);
  });

  it('REJECTS a pin from an authenticated member without MANAGE_MESSAGES', () => {
    ingestNotifyPush({ kind: 'pin', channel_id: CHAN, message_id: MSG, pinned: true }, PLAIN);
    expect(getState().messages.find(m => m.id === MSG)?.pinned).toBeFalsy();
  });

  it('REJECTS an unpin forged by an unprivileged member (cannot undo a moderator pin)', () => {
    ingestNotifyPush({ kind: 'pin', channel_id: CHAN, message_id: MSG, pinned: true }, OWNER);
    expect(getState().messages.find(m => m.id === MSG)?.pinned).toBe(true);

    ingestNotifyPush({ kind: 'pin', channel_id: CHAN, message_id: MSG, pinned: false }, PLAIN);
    expect(getState().messages.find(m => m.id === MSG)?.pinned).toBe(true);
  });

  it('ignores a pin for a message we do not hold', () => {
    ingestNotifyPush({ kind: 'pin', channel_id: CHAN, message_id: 'nope', pinned: true }, OWNER);
    expect(getState().messages.find(m => m.id === 'nope')).toBeUndefined();
  });
});
