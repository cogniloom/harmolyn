import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerSync } from '../sync/peersync.js';
import { addServer, initStore, setNativeIdentity } from '../state/store.js';
import { registerPeerSync } from '../sync/registry.js';
import { resetNodeHealthForTests } from '../../lib/nodeHealth.js';
import {
  currentMailboxToken,
  drainMailboxTokens,
  mailboxDrain,
  mailboxStore,
  wrapRelayBody,
} from './mailbox.js';
import {
  handlePeerMailboxRequest,
  resetPeerMailboxForTests,
} from './peerMailbox.js';
import { encodeBase64Chunked } from '../security/limits.js';

function b64url(bytes: Uint8Array): string {
  return encodeBase64Chunked(bytes)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function installPeers(identity: string): void {
  setNativeIdentity({ id: identity, peer_id: identity });
  addServer({
    id: 'server',
    name: 'Mailbox mesh',
    owner_peer_id: 'sender',
    members: ['sender', 'recipient', 'p1', 'p2', 'p3'],
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

describe('peer mailbox storage', () => {
  beforeEach(async () => {
    localStorage.clear();
    initStore();
    registerPeerSync(null as unknown as PeerSync);
    resetNodeHealthForTests();
    await resetPeerMailboxForTests();
  });

  afterEach(async () => {
    registerPeerSync(null as unknown as PeerSync);
    resetNodeHealthForTests();
    await resetPeerMailboxForTests();
    vi.restoreAllMocks();
  });

  it('stores only opaque framed bodies and lets a token holder drain once', async () => {
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const token = currentMailboxToken(secret);
    const ciphertext = crypto.getRandomValues(new Uint8Array(64));
    const body = b64url(wrapRelayBody(ciphertext));

    await expect(handlePeerMailboxRequest('peer.mailbox.store', {
      token,
      id: crypto.randomUUID(),
      body,
    }, 'sender')).resolves.toMatchObject({ ok: true, queued: true });

    const drained = await handlePeerMailboxRequest('peer.mailbox.drain', {
      tokens: drainMailboxTokens(secret),
    }, 'recipient');
    expect(drained).toMatchObject({ ok: true });
    expect((drained.entries as Array<{ body: string }>)[0].body).toBe(body);

    await expect(handlePeerMailboxRequest('peer.mailbox.drain', {
      tokens: drainMailboxTokens(secret),
    }, 'recipient')).resolves.toEqual({ ok: true, entries: [] });
  });

  it('rejects malformed tokens and bodies before consuming storage', async () => {
    await expect(handlePeerMailboxRequest('peer.mailbox.store', {
      token: 'not-a-token',
      id: crypto.randomUUID(),
      body: 'also-not-base64',
    }, 'sender')).resolves.toEqual({ ok: false, error: 'invalid_mailbox_entry' });
  });

  it('serializes parallel quota checks with their inserts', async () => {
    const token = currentMailboxToken(crypto.getRandomValues(new Uint8Array(32)));
    const body = b64url(new Uint8Array(1024 * 1024));
    const responses = await Promise.all(Array.from({ length: 25 }, () =>
      handlePeerMailboxRequest('peer.mailbox.store', {
        token,
        id: crypto.randomUUID(),
        body,
      }, 'sender')));

    expect(responses.some(response => response.error === 'mailbox_quota')).toBe(true);
    expect(responses.filter(response => response.ok === true).length).toBeLessThan(25);
  });

  it('stores and drains through ordinary peers when every node path is down', async () => {
    installPeers('sender');
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('node down')));
    const requestPeer = vi.fn((
      _peerId: string,
      _protocol: string,
      operation: string,
      payload: Record<string, unknown>,
    ) => handlePeerMailboxRequest(operation, payload, 'sender'));
    registerPeerSync({
      storeMailboxAtRelay: vi.fn().mockResolvedValue(false),
      drainMailboxAtRelay: vi.fn().mockResolvedValue(null),
      requestPeer,
    } as unknown as PeerSync);

    const secret = crypto.getRandomValues(new Uint8Array(32));
    const ciphertext = crypto.getRandomValues(new Uint8Array(96));
    const token = currentMailboxToken(secret);
    await expect(mailboxStore(token, ciphertext)).resolves.toBeUndefined();

    installPeers('recipient');
    const deliveries = await mailboxDrain(drainMailboxTokens(secret));
    expect(deliveries).toEqual([ciphertext]);
    expect(requestPeer).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'peer.mailbox.store',
      expect.objectContaining({ token }),
    );
    expect(requestPeer).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'peer.mailbox.drain',
      expect.objectContaining({ tokens: expect.any(Array) }),
    );
  });
});
