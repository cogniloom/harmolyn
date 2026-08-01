import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerSync } from '../sync/peersync.js';
import { generateIdentity, type XoreinIdentity } from '../identity/identity.js';
import { addServer, getState, initStore, setNativeIdentity, upsertPeer } from '../state/store.js';
import { registerPeerSync } from '../sync/registry.js';
import {
  createRecipientInboxPacket,
  depositRecipientInboxOperation,
  drainRecipientInbox,
  openRecipientInboxPacket,
  registerRecipientInboxIdentity,
  resetRecipientInboxIdentity,
} from './recipientInbox.js';
import {
  currentRecipientInboxToken,
  recipientInboxToken,
  recipientInboxTokens,
} from './inboxToken.js';
import {
  handlePeerMailboxRequest,
  resetPeerMailboxForTests,
} from './peerMailbox.js';
import { wrapRelayBody } from './mailbox.js';
import { encodeBase64Chunked } from '../security/limits.js';

function installMesh(identity: string, members: string[]): void {
  setNativeIdentity({ id: identity, peer_id: identity });
  addServer({
    id: 'server',
    name: 'Inbox mesh',
    owner_peer_id: members[0],
    members,
    channels: {
      channel: {
        id: 'channel',
        server_id: 'server',
        name: 'general',
        voice: false,
      },
    },
  });
}

describe('recipient-addressed durable inbox', () => {
  let alice: XoreinIdentity;
  let bob: XoreinIdentity;
  let mallory: XoreinIdentity;
  let dave: XoreinIdentity;

  beforeEach(async () => {
    localStorage.clear();
    initStore();
    registerPeerSync(null as unknown as PeerSync);
    resetRecipientInboxIdentity();
    await resetPeerMailboxForTests();
    alice = await generateIdentity();
    bob = await generateIdentity();
    mallory = await generateIdentity();
    dave = await generateIdentity();
  });

  afterEach(async () => {
    registerPeerSync(null as unknown as PeerSync);
    resetRecipientInboxIdentity();
    await resetPeerMailboxForTests();
    vi.restoreAllMocks();
  });

  it('derives one daily recipient token and a bounded reconnect window', () => {
    const token = currentRecipientInboxToken(bob.peerId);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(recipientInboxTokens(bob.peerId)).toHaveLength(8);
    expect(recipientInboxToken(bob.peerId, 1234))
      .toBe(recipientInboxToken(bob.peerId, 1234));
    expect(recipientInboxToken(alice.peerId, 1234))
      .not.toBe(recipientInboxToken(bob.peerId, 1234));
  });

  it('seals routing and payload metadata to the recipient and verifies the hybrid origin', () => {
    const payload = {
      kind: 'request',
      from_peer_id: alice.peerId,
      display_name: 'Alice Secret Name',
    };
    const packet = createRecipientInboxPacket(
      bob.peerId,
      '/aether/friends/0.1.0',
      'friends.request',
      payload,
      'delivery-test-0001',
      alice,
    );
    expect(packet).not.toBeNull();
    expect(JSON.stringify(packet)).not.toContain('friends.request');
    expect(JSON.stringify(packet)).not.toContain('Alice Secret Name');

    expect(openRecipientInboxPacket(packet, bob)).toMatchObject({
      id: 'delivery-test-0001',
      origin_peer_id: alice.peerId,
      target_peer_id: bob.peerId,
      operation: 'friends.request',
      payload,
    });
    expect(openRecipientInboxPacket(packet, mallory)).toBeNull();

    const tampered = {
      ...packet!,
      ciphertext: `${packet!.ciphertext.slice(0, -1)}${packet!.ciphertext.endsWith('A') ? 'B' : 'A'}`,
    };
    expect(openRecipientInboxPacket(tampered, bob)).toBeNull();
  });

  it('does not let another authenticated peer consume the recipient inbox', async () => {
    const token = currentRecipientInboxToken(bob.peerId);
    const packet = createRecipientInboxPacket(
      bob.peerId,
      '/aether/friends/0.1.0',
      'friends.request',
      { kind: 'request' },
      'delivery-test-0002',
      alice,
    )!;
    const bytes = wrapRelayBody(new TextEncoder().encode(JSON.stringify(packet)));
    const body = encodeBase64Chunked(bytes)
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');

    await expect(handlePeerMailboxRequest('peer.inbox.store', {
      recipient_peer_id: bob.peerId,
      token,
      id: packet.id,
      body,
    }, alice.peerId)).resolves.toMatchObject({ ok: true, queued: true });

    await expect(handlePeerMailboxRequest('peer.inbox.drain', {
      tokens: recipientInboxTokens(bob.peerId),
    }, mallory.peerId)).resolves.toEqual({
      ok: false,
      error: 'invalid_mailbox_tokens',
    });

    const drained = await handlePeerMailboxRequest('peer.inbox.drain', {
      tokens: recipientInboxTokens(bob.peerId),
    }, bob.peerId);
    expect(drained).toMatchObject({ ok: true });
    expect((drained.entries as unknown[])).toHaveLength(1);

    const stillPending = await handlePeerMailboxRequest('peer.inbox.drain', {
      tokens: recipientInboxTokens(bob.peerId),
    }, bob.peerId);
    expect((stillPending.entries as unknown[])).toHaveLength(1);

    const acknowledged = await handlePeerMailboxRequest('peer.inbox.drain', {
      tokens: recipientInboxTokens(bob.peerId),
      acknowledge_ids: [packet.id],
    }, bob.peerId);
    expect(acknowledged).toMatchObject({ ok: true, acknowledged: 1, entries: [] });
  });

  it('acknowledges healthy peer custody without waiting for a silent provider', async () => {
    installMesh(alice.peerId, [alice.peerId, bob.peerId, mallory.peerId, dave.peerId]);
    registerRecipientInboxIdentity(alice);
    const requestPeer = vi.fn((peerId: string) => (
      peerId === mallory.peerId
        ? new Promise<never>(() => {})
        : Promise.resolve({ ok: true, queued: true })
    ));
    registerPeerSync({
      storeInboxAtRelay: vi.fn().mockResolvedValue(false),
      activeRelayPeerId: vi.fn().mockReturnValue(null),
      requestPeer,
    } as unknown as PeerSync);

    const result = await Promise.race([
      depositRecipientInboxOperation(
        bob.peerId,
        '/aether/friends/0.1.0',
        'friends.request',
        { kind: 'request', from_peer_id: alice.peerId },
        'friend-request-fast-custody',
      ),
      new Promise<'timed-out'>(resolve => setTimeout(() => resolve('timed-out'), 100)),
    ]);

    expect(result).toBe(true);
    expect(requestPeer).toHaveBeenCalledWith(
      dave.peerId,
      expect.any(String),
      'peer.inbox.store',
      expect.objectContaining({ recipient_peer_id: bob.peerId }),
    );
  });

  it('keeps retrying when only a sender-private holder accepted custody', async () => {
    setNativeIdentity({ id: alice.peerId, peer_id: alice.peerId });
    upsertPeer({ peer_id: mallory.peerId, role: 'peer' });
    registerRecipientInboxIdentity(alice);
    registerPeerSync({
      storeInboxAtRelay: vi.fn().mockResolvedValue(false),
      activeRelayPeerId: vi.fn().mockReturnValue(null),
      requestPeer: vi.fn().mockResolvedValue({ ok: true, queued: true }),
    } as unknown as PeerSync);

    await expect(depositRecipientInboxOperation(
      bob.peerId,
      '/aether/friends/0.1.0',
      'friends.request',
      { kind: 'request', from_peer_id: alice.peerId },
      'sender-private-holder',
    )).resolves.toBe(false);
  });

  it('stores and applies a first-contact operation through ordinary peers with every node down', async () => {
    const members = [alice.peerId, bob.peerId, mallory.peerId];
    installMesh(alice.peerId, members);
    registerRecipientInboxIdentity(alice);
    const requestPeer = vi.fn((
      _peerId: string,
      _protocol: string,
      operation: string,
      payload: Record<string, unknown>,
    ) => handlePeerMailboxRequest(
      operation,
      payload,
      getStateIdentity(),
    ));
    registerPeerSync({
      storeInboxAtRelay: vi.fn().mockResolvedValue(false),
      drainInboxAtRelay: vi.fn().mockResolvedValue(null),
      activeRelayPeerId: vi.fn().mockReturnValue(null),
      requestPeer,
    } as unknown as PeerSync);

    const payload = {
      kind: 'request',
      id: 'friend-request-1',
      from_peer_id: alice.peerId,
    };
    await expect(depositRecipientInboxOperation(
      bob.peerId,
      '/aether/friends/0.1.0',
      'friends.request',
      payload,
      'friend-request-1',
    )).resolves.toBe(true);

    installMesh(bob.peerId, members);
    registerRecipientInboxIdentity(bob);
    const applied: unknown[] = [];
    await expect(drainRecipientInbox(operation => {
      applied.push(operation);
    }, true)).resolves.toBe(1);
    expect(applied).toEqual([
      expect.objectContaining({
        origin_peer_id: alice.peerId,
        target_peer_id: bob.peerId,
        operation: 'friends.request',
        payload,
      }),
    ]);
    expect(requestPeer).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'peer.inbox.store',
      expect.objectContaining({ recipient_peer_id: bob.peerId }),
    );
    expect(requestPeer).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'peer.inbox.drain',
      expect.objectContaining({ tokens: expect.any(Array) }),
    );
    await vi.waitFor(() => {
      expect(requestPeer).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'peer.inbox.drain',
        expect.objectContaining({
          tokens: expect.any(Array),
          acknowledge_ids: ['friend-request-1'],
        }),
      );
    });
  });

  it('keeps every provider copy when local apply fails, then acknowledges after retry', async () => {
    const members = [alice.peerId, bob.peerId, mallory.peerId];
    installMesh(alice.peerId, members);
    registerRecipientInboxIdentity(alice);
    const requestPeer = vi.fn((
      _peerId: string,
      _protocol: string,
      operation: string,
      payload: Record<string, unknown>,
    ) => handlePeerMailboxRequest(operation, payload, getStateIdentity()));
    registerPeerSync({
      storeInboxAtRelay: vi.fn().mockResolvedValue(false),
      drainInboxAtRelay: vi.fn().mockResolvedValue(null),
      activeRelayPeerId: vi.fn().mockReturnValue(null),
      requestPeer,
    } as unknown as PeerSync);

    await expect(depositRecipientInboxOperation(
      bob.peerId,
      '/aether/friends/0.1.0',
      'friends.request',
      { kind: 'request', id: 'retry-apply-request' },
      'retry-apply-request',
    )).resolves.toBe(true);

    installMesh(bob.peerId, members);
    registerRecipientInboxIdentity(bob);
    await expect(drainRecipientInbox(() => {
      throw new Error('transient local failure');
    }, true)).resolves.toBe(0);

    const applied: string[] = [];
    await expect(drainRecipientInbox(operation => {
      applied.push(operation.id);
    }, true)).resolves.toBe(1);
    expect(applied).toEqual(['retry-apply-request']);

    await vi.waitFor(() => {
      expect(requestPeer).toHaveBeenCalledWith(
        expect.any(String),
        expect.any(String),
        'peer.inbox.drain',
        expect.objectContaining({ acknowledge_ids: ['retry-apply-request'] }),
      );
    });
  });
});

function getStateIdentity(): string {
  // Keep the mocked authenticated caller coupled to the currently installed
  // account, exactly as a routed request is rebound to its signed origin.
  return getState().identity?.peer_id ?? '';
}
