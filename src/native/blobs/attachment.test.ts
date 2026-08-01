// Verifies the encrypted-attachment round-trip (priv-4): a file is uploaded to
// the node as OPAQUE ciphertext and recovered only by a holder of the key, which
// travels inside the E2EE message — the node never sees plaintext.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { uploadEncryptedAttachment, downloadDecryptedAttachment } from './blobs.js';
import { addServer, initStore, setNativeIdentity } from '../state/store.js';
import { registerPeerSync } from '../sync/registry.js';
import type { PeerSync } from '../sync/peersync.js';
import { resetBlobSwarmForTests } from './swarm.js';
import { resetNodeHealthForTests } from '../../lib/nodeHealth.js';

function mockNodeUploads() {
  const store = new Map<string, string>();
  const urls: string[] = [];
  let n = 0;
  const fetchMock = vi.fn(async (url: string | URL, init?: { method?: string; body?: string }) => {
    const u = String(url);
    urls.push(u);
    if (u.endsWith('/uploads') && init?.method === 'POST') {
      const body = JSON.parse(init?.body ?? '{}');
      const id = `u${++n}`;
      store.set(id, body.data);
      // The node stores opaque ciphertext + a forced opaque content_type, and
      // must never learn the real filename (metadata zero-trust).
      expect(body.content_type).toBe('application/octet-stream');
      expect(body.filename).toBe('blob');
      return { ok: true, status: 200, json: async () => ({ id }) };
    }
    const m = u.match(/\/uploads\/([^/]+)$/);
    if (m) {
      const data = store.get(decodeURIComponent(m[1]));
      return { ok: !!data, status: data ? 200 : 404, json: async () => ({ data }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).fetch = fetchMock;
  return { store, urls };
}

describe('encrypted attachments (priv-4)', () => {
  afterEach(async () => {
    registerPeerSync(null as unknown as PeerSync);
    resetNodeHealthForTests();
    await resetBlobSwarmForTests();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('uploads opaque ciphertext and round-trips the file via the key in the message', async () => {
    const { store } = mockNodeUploads();
    const plaintext = new TextEncoder().encode('secret file contents 🔐 attack at dawn');

    const att = await uploadEncryptedAttachment(plaintext, 'plans.txt', 'text/plain');
    expect(att.id).toBeTruthy();
    expect(att.key.length).toBeGreaterThan(0);
    expect(att.nonce.length).toBeGreaterThan(0);
    expect(att.content_type).toBe('text/plain'); // preserved in the ref (E2EE), not at the node

    // What the node holds must be ciphertext — the plaintext must not be recoverable
    // from the stored blob without the key.
    const stored = [...store.values()][0];
    const storedBytes = atob(stored.startsWith('data:') ? stored.split(',')[1] : stored);
    expect(storedBytes).not.toContain('attack at dawn');

    // A holder of the attachment ref (key in the E2EE message) recovers the file.
    const got = await downloadDecryptedAttachment(att);
    expect(new TextDecoder().decode(got)).toBe('secret file contents 🔐 attack at dawn');
  });

  it('targets the configured node and records its origin so recipients fetch from the right node', async () => {
    // Pin the "no override" premise: the ambient .env may set a local endpoint.
    vi.stubEnv('VITE_XOREIN_CONTROL_ENDPOINT', '');
    const { urls } = mockNodeUploads();
    const att = await uploadEncryptedAttachment(new TextEncoder().encode('hi'), 'f', 'text/plain');
    // With no VITE_XOREIN_CONTROL_ENDPOINT override, uploads target the default node's /v1.
    expect(urls[0]).toBe('https://node.xorein.com/v1/uploads');
    // The ref carries the node origin so a recipient on a different configured node still
    // fetches the ciphertext from where it actually lives.
    expect(att.origin).toBe('https://node.xorein.com');
  });

  it('rejects a peer-chosen attachment origin instead of leaking to an arbitrary host', async () => {
    const { store, urls } = mockNodeUploads();
    const att = await uploadEncryptedAttachment(new TextEncoder().encode('data'), 'f', 'text/plain');
    // Simulate the ref having been minted on a different node.
    const uploadedId = [...store.keys()][0];
    const remote = { ...att, id: uploadedId, origin: 'https://relay.example.org' };
    urls.length = 0;
    await expect(downloadDecryptedAttachment(remote)).rejects.toThrow(/selected support node/i);
    expect(urls).toEqual([]);
  });

  it('fails the integrity check if the ciphertext is tampered', async () => {
    const { store } = mockNodeUploads();
    const att = await uploadEncryptedAttachment(new TextEncoder().encode('hello'), 'f', 'text/plain');
    // Corrupt the stored blob.
    const id = [...store.keys()][0];
    store.set(id, 'data:application/octet-stream;base64,' + btoa('totally different bytes here!!'));
    await expect(downloadDecryptedAttachment(att)).rejects.toThrow();
  });

  it('retains the legacy HTTP recovery path for pre-hash attachments', async () => {
    mockNodeUploads();
    const plaintext = new TextEncoder().encode('legacy attachment');
    const current = await uploadEncryptedAttachment(plaintext, 'legacy.txt', 'text/plain');
    const legacy = { ...current, content_hash: undefined, swarm: undefined };

    const recovered = await downloadDecryptedAttachment(legacy);
    expect(new TextDecoder().decode(recovered)).toBe('legacy attachment');
  });

  it('uses the replica protocol directly for scoped attachments without probing legacy HTTP', async () => {
    localStorage.clear();
    initStore();
    setNativeIdentity({ id: 'me', peer_id: 'me' });
    addServer({
      id: 'server',
      name: 'Files',
      owner_peer_id: 'me',
      members: ['me', 'p1', 'p2', 'p3'],
      channels: {
        channel: {
          id: 'channel',
          server_id: 'server',
          name: 'general',
          voice: false,
        },
      },
    });
    const fetchMock = vi.fn().mockRejectedValue(new TypeError('legacy HTTP route is unavailable'));
    vi.stubGlobal('fetch', fetchMock);
    const requestPeer = vi.fn(async (
      _peerId: string,
      _protocol: string,
      operation: string,
      payload: Record<string, unknown>,
    ) => {
      if (operation === 'sync.blob.inventory') return { ok: true, indices: [] };
      if (operation === 'sync.blob.store') {
        return {
          ok: true,
          stored_indices: (payload.chunks as Array<{ index: number }>).map(chunk => chunk.index),
        };
      }
      return { ok: false };
    });
    registerPeerSync({ requestPeer } as unknown as PeerSync);

    const plaintext = new TextEncoder().encode('zero-node attachment');
    const att = await uploadEncryptedAttachment(
      plaintext,
      'offline.txt',
      'text/plain',
      'channel',
    );

    expect(att.origin).toBeUndefined();
    expect(att.swarm?.provider_peer_ids).toHaveLength(3);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(requestPeer).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      'sync.blob.store',
      expect.objectContaining({ manifest: expect.any(Object) }),
    );
    const recovered = await downloadDecryptedAttachment(att);
    expect([...recovered]).toEqual([...plaintext]);
  });
});
