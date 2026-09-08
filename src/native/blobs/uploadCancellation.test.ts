import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uploadEncryptedAttachment, downloadDecryptedAttachment } from './blobs.js';
import { createUploadLifetime, awaitUpload } from './uploadLifecycle.js';
import * as swarm from './swarm.js';
import { addServer, getState, initStore, setActiveScope, setNativeIdentity, updateState } from '../state/store.js';
import { registerPeerSync } from '../sync/registry.js';
import type { PeerSync } from '../sync/peersync.js';
import type { BlobSwarmManifest } from '../../types.js';

const SCOPE = 'files', OWNER = 'owner';
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => { resolve = yes; });
  return { promise, resolve };
}
function snapshot() { window.dispatchEvent(new Event('focus')); }
function install() {
  setNativeIdentity({ id: OWNER, peer_id: OWNER });
  setActiveScope(SCOPE);
  addServer({ id: 'space', name: 'Files', owner_peer_id: OWNER, members: [OWNER, 'p1', 'p2', 'p3'],
    channels: { [SCOPE]: { id: SCOPE, server_id: 'space', name: 'files', voice: false } } });
}
function providerGate() {
  const started = deferred<BlobSwarmManifest>();
  const gate = deferred<void>();
  const requestPeer = vi.fn(async (_peer: string, _protocol: string, operation: string, payload: { manifest: BlobSwarmManifest; chunks: { index: number }[] }) => {
    if (operation === 'sync.blob.inventory') return { ok: true, indices: [] };
    started.resolve(payload.manifest);
    await gate.promise;
    return { ok: true, stored_indices: payload.chunks.map(chunk => chunk.index) };
  });
  registerPeerSync({ requestPeer } as unknown as PeerSync);
  return { started, gate, requestPeer };
}
const plaintext = new Uint8Array(300_000).fill(42);
function upload(signal?: AbortSignal) { return uploadEncryptedAttachment(plaintext, 'private-file.txt', 'text/plain', SCOPE, signal); }

beforeEach(async () => { localStorage.clear(); initStore(); install(); await swarm.resetBlobSwarmForTests(); });
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllGlobals(); registerPeerSync(null as unknown as PeerSync); await swarm.resetBlobSwarmForTests(); });

describe('attachment upload cancellation', () => {
  it('rejects pre-cancelled work before encryption, storage or network', async () => {
    const controller = new AbortController(); controller.abort('sensitive-reason');
    const requestPeer = vi.fn(); registerPeerSync({ requestPeer } as unknown as PeerSync);
    const create = vi.spyOn(swarm, 'createLocalBlobSwarm');
    await expect(upload(controller.signal)).rejects.toMatchObject({ name: 'AbortError', message: 'Attachment upload cancelled.' });
    expect(create).not.toHaveBeenCalled(); expect(requestPeer).not.toHaveBeenCalled();
  });

  it('stages ciphertext outside the cache, then commits a decryptable successful attachment', async () => {
    const { started, gate } = providerGate(); const pending = upload();
    const manifest = await started.promise;
    expect(await swarm.readLocalBlobSwarm(manifest)).toBeNull();
    gate.resolve(); const attachment = await pending;
    expect(attachment.swarm?.provider_peer_ids).toHaveLength(3);
    expect(await swarm.readLocalBlobSwarm(manifest)).not.toBeNull();
    expect(await downloadDecryptedAttachment(attachment)).toEqual(plaintext);
    expect(localStorage.getItem('private-file.txt')).toBeNull();
  });

  it.each(['navigation', 'identity', 'pagehide', 'explicit', 'leave-and-return'] as const)(
    'stops queued distribution on %s without retaining an orphan or penalizing a provider', async reason => {
      const controller = new AbortController(); const { started, gate, requestPeer } = providerGate();
      const pending = upload(controller.signal); const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      const manifest = await started.promise;
      if (reason === 'navigation' || reason === 'leave-and-return') { setActiveScope('other'); snapshot(); }
      if (reason === 'leave-and-return') { setActiveScope(SCOPE); snapshot(); }
      if (reason === 'identity') { setNativeIdentity({ id: 'next', peer_id: 'next' }); snapshot(); }
      if (reason === 'pagehide') window.dispatchEvent(new Event('pagehide'));
      if (reason === 'explicit') controller.abort();
      await rejected;
      const dispatched = requestPeer.mock.calls.length;
      expect(dispatched).toBeLessThanOrEqual(6);
      expect(await swarm.readLocalBlobSwarm(manifest)).toBeNull();
      gate.resolve(); await new Promise(resolve => setTimeout(resolve, 0));
      expect(requestPeer).toHaveBeenCalledTimes(dispatched);
      expect(Object.values(swarm.blobProviderHealthSnapshot()).every(value => value.failures === 0)).toBe(true);
    },
  );

  it('detects headless scope changes at the next await boundary without relying on UI events', async () => {
    const { started, gate } = providerGate(); const pending = upload();
    const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    const manifest = await started.promise; setActiveScope('another'); gate.resolve();
    await rejected; expect(await swarm.readLocalBlobSwarm(manifest)).toBeNull();
  });

  it('does not cancel for unrelated state or profile updates', async () => {
    const { started, gate } = providerGate(); const pending = upload(); await started.promise;
    updateState(state => ({ unread: { ...state.unread, elsewhere: 1 },
      identity: { ...state.identity!, profile: { display_name: 'New display name' } } }));
    snapshot(); gate.resolve(); await expect(pending).resolves.toHaveProperty('key');
  });

  it('rolls back a committed unpublished blob if scope changes immediately after commit', async () => {
    const original = swarm.commitLocalBlobUpload; let committed!: BlobSwarmManifest;
    vi.spyOn(swarm, 'commitLocalBlobUpload').mockImplementation(async (manifest, bytes, guard) => {
      await original(manifest, bytes, guard); committed = manifest;
      setActiveScope('another'); snapshot();
    });
    registerPeerSync(null as unknown as PeerSync);
    await expect(upload()).rejects.toMatchObject({ name: 'AbortError' });
    expect(await swarm.readLocalBlobSwarm(committed)).toBeNull();
  });

  it('rollback is idempotent and cannot remove a newer namespace or unrelated blob', async () => {
    const bytes = new Uint8Array(100).fill(7);
    const old = await swarm.createLocalBlobSwarm(bytes, SCOPE, OWNER);
    const newer = await swarm.createLocalBlobSwarm(bytes, SCOPE, OWNER);
    const other = await swarm.createLocalBlobSwarm(new Uint8Array(100).fill(8), SCOPE, OWNER);
    expect(newer.node_namespace).not.toBe(old.node_namespace);
    await swarm.discardLocalBlobUpload(old);
    expect(await swarm.readLocalBlobSwarm(newer)).toEqual(bytes);
    await swarm.discardLocalBlobUpload(newer); await swarm.discardLocalBlobUpload(newer);
    expect(await swarm.readLocalBlobSwarm(newer)).toBeNull();
    expect(await swarm.readLocalBlobSwarm(other)).not.toBeNull();
  });

  it('refuses a scope no longer focused when upload starts', async () => {
    setActiveScope('other');
    await expect(upload()).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('disposes event listeners on success and cancellation', async () => {
    const add = vi.spyOn(window, 'addEventListener'), remove = vi.spyOn(window, 'removeEventListener');
    registerPeerSync(null as unknown as PeerSync); await upload();
    for (const [event, listener] of add.mock.calls.filter(([event]) => ['focus', 'pagehide'].includes(event))) {
      expect(remove).toHaveBeenCalledWith(event, listener);
    }
    const controller = new AbortController(); const disposeExternal = vi.spyOn(controller.signal, 'removeEventListener');
    controller.abort(); await expect(upload(controller.signal)).rejects.toThrow();
    expect(disposeExternal).toHaveBeenCalledWith('abort', expect.any(Function));
  });

  it('cancelled waits still observe a late request rejection', async () => {
    const controller = new AbortController(); const lifetime = createUploadLifetime(SCOPE, getState().identity!.peer_id, controller.signal);
    let reject!: (error: Error) => void;
    const request = new Promise<void>((_resolve, no) => { reject = no; });
    const removed = vi.spyOn(lifetime.signal, 'removeEventListener');
    const pending = awaitUpload(request, lifetime);
    controller.abort();
    expect(removed).toHaveBeenCalledWith('abort', expect.any(Function)); await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    reject(new Error('late request error')); await Promise.resolve(); lifetime.dispose();
  });
});
