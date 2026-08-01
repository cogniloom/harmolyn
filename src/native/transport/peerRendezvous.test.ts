import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerSync } from '../sync/peersync.js';
import { addServer, initStore, setNativeIdentity } from '../state/store.js';
import { registerPeerSync } from '../sync/registry.js';
import { resetNodeHealthForTests } from '../../lib/nodeHealth.js';
import { RELAY_MULTIADDR } from './node.js';
import {
  rendezvousDiscover,
  rendezvousRegister,
  serverRendezvousCID,
} from './rendezvous.js';
import {
  handlePeerRendezvousRequest,
  resetPeerRendezvousForTests,
} from './peerRendezvous.js';

const ALICE = '12D3KooWNNQp1tmRbcLMrqS866jRJbzoPF6sNEZRoPEVdVwLqTv6';
const BOB = '12D3KooWDsujzQH69Gq2LQb1gHMUCbDaJVACYmoVymK9dej5zh4T';
const PROVIDER = '12D3KooWGWC3A4KawRYn9Mcyt9LjDg6TS7vF5uju7v6gTFsrEBS4';
const ALICE_ADDR = `${RELAY_MULTIADDR}/p2p-circuit/p2p/${ALICE}`;

function installNetwork(identity: string): void {
  setNativeIdentity({ id: identity, peer_id: identity });
  addServer({
    id: 'server',
    name: 'Mesh',
    owner_peer_id: ALICE,
    members: [ALICE, BOB, PROVIDER],
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

describe('peer rendezvous mesh', () => {
  beforeEach(async () => {
    localStorage.clear();
    initStore();
    registerPeerSync(null as unknown as PeerSync);
    resetNodeHealthForTests();
    await resetPeerRendezvousForTests();
  });

  afterEach(async () => {
    registerPeerSync(null as unknown as PeerSync);
    resetNodeHealthForTests();
    await resetPeerRendezvousForTests();
    vi.restoreAllMocks();
  });

  it('binds registrations to the authenticated peer and hides unrelated namespaces', async () => {
    const namespace = serverRendezvousCID(new Uint8Array(32).fill(1));
    const other = serverRendezvousCID(new Uint8Array(32).fill(2));
    await expect(handlePeerRendezvousRequest(
      'peer.rendezvous.mesh.register',
      { namespace, addrs: [ALICE_ADDR], ttl_seconds: 600 },
      ALICE,
    )).resolves.toEqual({ ok: true });

    const found = await handlePeerRendezvousRequest(
      'peer.rendezvous.mesh.discover',
      { namespace, limit: 50 },
      BOB,
    );
    expect(found).toMatchObject({
      ok: true,
      peers: [expect.objectContaining({ peer_id: ALICE, addrs: [ALICE_ADDR] })],
    });
    await expect(handlePeerRendezvousRequest(
      'peer.rendezvous.mesh.discover',
      { namespace: other, limit: 50 },
      BOB,
    )).resolves.toEqual({ ok: true, peers: [] });
  });

  it('registers and discovers through peers when every node path is down', async () => {
    installNetwork(ALICE);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('node down')));
    const requestPeer = vi.fn((
      _peerId: string,
      _protocol: string,
      operation: string,
      payload: Record<string, unknown>,
    ) => handlePeerRendezvousRequest(
      operation,
      payload,
      operation.endsWith('register') ? ALICE : BOB,
    ));
    registerPeerSync({
      registerRendezvousAtRelay: vi.fn().mockResolvedValue(false),
      discoverRendezvousAtRelay: vi.fn().mockResolvedValue(null),
      requestPeer,
    } as unknown as PeerSync);

    const namespace = serverRendezvousCID(new Uint8Array(32).fill(7));
    await expect(rendezvousRegister(namespace, ALICE, [ALICE_ADDR], 600))
      .resolves.toBeUndefined();

    installNetwork(BOB);
    const peers = await rendezvousDiscover(namespace);
    expect(peers).toEqual([
      expect.objectContaining({ peer_id: ALICE, addrs: [ALICE_ADDR] }),
    ]);
    expect(requestPeer).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'peer.rendezvous.mesh.register',
      expect.objectContaining({ namespace }),
    );
    expect(requestPeer).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'peer.rendezvous.mesh.discover',
      expect.objectContaining({ namespace }),
    );
  });
});
