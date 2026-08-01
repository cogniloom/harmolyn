import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PeerSync } from '../sync/peersync.js';
import {
  addServer,
  initStore,
  setNativeIdentity,
  upsertPeer,
} from '../state/store.js';
import { registerPeerSync } from '../sync/registry.js';
import { encodeBase64Chunked } from '../security/limits.js';
import {
  blobProviderHealthSnapshot,
  createLocalBlobSwarm,
  fetchBlobFromSwarm,
  handleBlobSyncRequest,
  readLocalBlobSwarm,
  resetBlobSwarmForTests,
  seedBlobSwarm,
} from './swarm.js';

const OWNER = 'owner';
const MEMBER = 'member';
const OUTSIDER = 'outsider';
const CHANNEL = 'channel';
const SERVER = 'server';

function randomBytes(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let offset = 0; offset < bytes.length; offset += 65_536) {
    crypto.getRandomValues(bytes.subarray(offset, Math.min(bytes.length, offset + 65_536)));
  }
  return bytes;
}

function installScope(members = [OWNER, MEMBER]): void {
  setNativeIdentity({ id: OWNER, peer_id: OWNER });
  addServer({
    id: SERVER,
    name: 'Blob swarm',
    owner_peer_id: OWNER,
    members,
    channels: {
      [CHANNEL]: {
        id: CHANNEL,
        server_id: SERVER,
        name: 'files',
        voice: false,
      },
    },
  });
}

describe('peer-owned encrypted blob swarm', () => {
  beforeEach(async () => {
    localStorage.clear();
    initStore();
    registerPeerSync(null as unknown as PeerSync);
    await resetBlobSwarmForTests();
  });

  afterEach(async () => {
    registerPeerSync(null as unknown as PeerSync);
    await resetBlobSwarmForTests();
    vi.restoreAllMocks();
  });

  it('content-addresses fragments and reconstructs a complete local source', async () => {
    installScope();
    const ciphertext = randomBytes(190_000);
    const manifest = await createLocalBlobSwarm(ciphertext, CHANNEL, OWNER, 20);

    expect(manifest.chunk_hashes.length).toBeGreaterThan(1);
    expect(await readLocalBlobSwarm(manifest)).toEqual(ciphertext);
  });

  it('authorizes storage by current scope membership and rejects tampered fragments', async () => {
    installScope();
    const ciphertext = crypto.getRandomValues(new Uint8Array(128));
    const manifest = await createLocalBlobSwarm(ciphertext, CHANNEL, OWNER);
    const wireChunk = {
      index: 0,
      hash: manifest.chunk_hashes[0],
      data: encodeBase64Chunked(ciphertext),
    };
    await resetBlobSwarmForTests();

    await expect(handleBlobSyncRequest(
      'sync.blob.store',
      { manifest, chunks: [wireChunk] },
      OUTSIDER,
    )).resolves.toEqual({ ok: false, error: 'member_required' });

    const tampered = {
      ...wireChunk,
      data: encodeBase64Chunked(new Uint8Array(ciphertext).fill(7)),
    };
    await expect(handleBlobSyncRequest(
      'sync.blob.store',
      { manifest, chunks: [tampered] },
      MEMBER,
    )).resolves.toEqual({ ok: false, error: 'invalid_blob_chunk' });

    await expect(handleBlobSyncRequest(
      'sync.blob.store',
      { manifest, chunks: [wireChunk] },
      MEMBER,
    )).resolves.toEqual({ ok: true, stored_indices: [0] });
    await expect(readLocalBlobSwarm(manifest)).resolves.toEqual(ciphertext);
  });

  it('prefers support providers, then fills three remote copies through members', async () => {
    installScope([OWNER, 'node', 'p1', 'p2', 'p3']);
    upsertPeer({ peer_id: 'node', role: 'archivist' });
    const requestOrder: string[] = [];
    const requestPeer = vi.fn(async (
      peerId: string,
      _protocol: string,
      operation: string,
      payload: Record<string, unknown>,
    ) => {
      if (operation !== 'sync.blob.store') return { ok: false };
      requestOrder.push(peerId);
      const chunks = payload.chunks as Array<{ index: number }>;
      // Simulate the preferred node being unavailable; member copies must still
      // reach the replication target.
      if (peerId === 'node') return { ok: false };
      return { ok: true, stored_indices: chunks.map(chunk => chunk.index) };
    });
    registerPeerSync({ requestPeer } as unknown as PeerSync);

    const manifest = await createLocalBlobSwarm(
      crypto.getRandomValues(new Uint8Array(96)),
      CHANNEL,
      OWNER,
      5,
    );
    const report = await seedBlobSwarm(manifest);

    expect(requestOrder[0]).toBe('node');
    expect(report.successfulProviders).toEqual(expect.arrayContaining(['p1', 'p2', 'p3']));
    expect(report.fullyReplicatedChunks).toBe(report.totalChunks);
    expect(manifest.provider_peer_ids).toHaveLength(3);
  });

  it('round-robins missing fragments across partial providers and reconstructs them', async () => {
    installScope([OWNER, 'recipient', 'p1', 'p2', 'p3']);
    const ciphertext = randomBytes(260_000);
    const manifest = await createLocalBlobSwarm(ciphertext, CHANNEL, OWNER, 20);
    manifest.provider_peer_ids = ['p1', 'p2', 'p3'];
    await resetBlobSwarmForTests();
    setNativeIdentity({ id: 'recipient', peer_id: 'recipient' });

    const providerIndices = new Map<string, number[]>([
      ['p1', []],
      ['p2', []],
      ['p3', []],
    ]);
    manifest.chunk_hashes.forEach((_hash, index) => {
      providerIndices.get(`p${(index % 3) + 1}`)!.push(index);
    });
    const fetchProviders = new Set<string>();
    const requestPeer = vi.fn(async (
      peerId: string,
      _protocol: string,
      operation: string,
      payload: Record<string, unknown>,
    ) => {
      if (operation === 'sync.blob.inventory') {
        return { ok: true, indices: providerIndices.get(peerId) ?? [] };
      }
      if (operation === 'sync.blob.fetch') {
        fetchProviders.add(peerId);
        const indices = payload.indices as number[];
        return {
          ok: true,
          chunks: indices
            .filter(index => providerIndices.get(peerId)?.includes(index))
            .map(index => {
              const start = index * manifest.chunk_size;
              const data = ciphertext.slice(start, Math.min(ciphertext.length, start + manifest.chunk_size));
              return {
                index,
                hash: manifest.chunk_hashes[index],
                data: encodeBase64Chunked(data),
              };
            }),
        };
      }
      return { ok: false };
    });
    registerPeerSync({ requestPeer } as unknown as PeerSync);

    await expect(fetchBlobFromSwarm(manifest)).resolves.toEqual(ciphertext);
    expect(fetchProviders).toEqual(new Set(['p1', 'p2', 'p3']));
  });

  it('quarantines a corrupt provider and retries a verified alternate', async () => {
    installScope([OWNER, 'recipient', 'bad', 'good']);
    const ciphertext = crypto.getRandomValues(new Uint8Array(200));
    const manifest = await createLocalBlobSwarm(ciphertext, CHANNEL, OWNER);
    manifest.provider_peer_ids = ['bad', 'good'];
    await resetBlobSwarmForTests();
    setNativeIdentity({ id: 'recipient', peer_id: 'recipient' });

    const requestPeer = vi.fn(async (
      peerId: string,
      _protocol: string,
      operation: string,
    ) => {
      if (operation === 'sync.blob.inventory') return { ok: true, indices: [0] };
      if (operation === 'sync.blob.fetch') {
        const data = peerId === 'bad'
          ? new Uint8Array(ciphertext).fill(9)
          : ciphertext;
        return {
          ok: true,
          chunks: [{
            index: 0,
            hash: manifest.chunk_hashes[0],
            data: encodeBase64Chunked(data),
          }],
        };
      }
      return { ok: false };
    });
    registerPeerSync({ requestPeer } as unknown as PeerSync);

    await expect(fetchBlobFromSwarm(manifest)).resolves.toEqual(ciphertext);
    expect(blobProviderHealthSnapshot().bad).toMatchObject({
      invalid: 1,
      quarantined: true,
    });
  });
});
