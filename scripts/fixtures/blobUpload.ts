// Browser-only verification entry. Never imported by the application bundle.
import { uploadEncryptedAttachment, downloadDecryptedAttachment } from '../../src/native/blobs/blobs';
import { createLocalBlobSwarm, commitLocalBlobUpload, discardLocalBlobUpload, readLocalBlobSwarm, resetBlobSwarmForTests } from '../../src/native/blobs/swarm';
import { createUploadLifetime } from '../../src/native/blobs/uploadLifecycle';
import { addServer, initStore, setActiveScope, setNativeIdentity } from '../../src/native/state/store';
import { registerPeerSync } from '../../src/native/sync/registry';
import type { PeerSync } from '../../src/native/sync/peersync';
import type { BlobSwarmManifest } from '../../src/types';

function assert(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
}
async function cache() {
  const db = await result(indexedDB.open('harmolyn-blob-swarm-v1', 3));
  try {
    const tx = db.transaction(['chunks', 'manifests', 'usage'], 'readonly');
    const [chunks, manifests, usage] = await Promise.all([
      result(tx.objectStore('chunks').count()), result(tx.objectStore('manifests').count()), result(tx.objectStore('usage').get('cache-usage')),
    ]);
    return { chunks, manifests, bytes: usage?.total_bytes ?? 0 };
  } finally { db.close(); }
}
function install() {
  localStorage.clear(); initStore(); setNativeIdentity({ id: 'owner', peer_id: 'owner' }); setActiveScope('files');
  addServer({ id: 'space', name: 'Test', owner_peer_id: 'owner', members: ['owner', 'p1', 'p2', 'p3'],
    channels: { files: { id: 'files', server_id: 'space', name: 'Files', voice: false } } });
}
async function run() {
  const checks: string[] = [];
  const data = new Uint8Array(300_000).fill(42);
  await resetBlobSwarmForTests(); install();
  let pendingManifest: BlobSwarmManifest | undefined;
  registerPeerSync({ requestPeer: async (_peer: string, _protocol: string, operation: string, payload: { manifest: BlobSwarmManifest; chunks: { index: number }[] }) => {
    if (operation === 'sync.blob.inventory') return { ok: true, indices: [] };
    pendingManifest = payload.manifest;
    assert(await readLocalBlobSwarm(payload.manifest) === null, 'Pending upload entered IndexedDB');
    return { ok: true, stored_indices: payload.chunks.map(chunk => chunk.index) };
  } } as unknown as PeerSync);
  const attachment = await uploadEncryptedAttachment(data, 'fixture.txt', 'text/plain', 'files');
  const before = await cache();
  assert(before.chunks > 0 && before.manifests === 1 && before.bytes === data.length + 16, 'Committed upload/accounting mismatch');
  assert((await downloadDecryptedAttachment(attachment)).every(byte => byte === 42), 'Encrypted upload did not round trip');
  checks.push('Pending ciphertext stays out of IndexedDB; successful commit round-trips with exact quota accounting');
  await discardLocalBlobUpload(pendingManifest!); await discardLocalBlobUpload(pendingManifest!);
  const removed = await cache();
  assert(removed.chunks === 0 && removed.manifests === 0 && removed.bytes === 0, 'Rollback left persistent data or quota');
  checks.push('IndexedDB rollback is idempotent and restores chunk, manifest and byte accounting');

  const bytes = new Uint8Array(100).fill(7);
  const old = await createLocalBlobSwarm(bytes, 'files', 'owner');
  const newer = await createLocalBlobSwarm(bytes, 'files', 'owner');
  await discardLocalBlobUpload(old);
  assert(await readLocalBlobSwarm(newer) !== null, 'Rollback removed a newer namespace');
  await discardLocalBlobUpload(newer);
  checks.push('Rollback cannot delete a replacement namespace for the same content address');

  const controller = new AbortController();
  const lifetime = createUploadLifetime('files', 'owner', controller.signal);
  const staged = await createLocalBlobSwarm(bytes, 'files', 'owner', 0, { deferPersistence: true, guard: lifetime });
  const put = IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put = function (...args: Parameters<typeof put>) {
    const request = put.apply(this, args);
    if (this.name === 'chunks') queueMicrotask(() => controller.abort());
    return request;
  };
  let cancelled = false;
  try { await commitLocalBlobUpload(staged, bytes, lifetime); }
  catch { cancelled = true; }
  finally { IDBObjectStore.prototype.put = put; lifetime.dispose(); }
  const aborted = await cache();
  assert(cancelled && aborted.chunks === 0 && aborted.manifests === 0 && aborted.bytes === 0, 'Transaction cancellation was not atomic');
  checks.push('Cancellation during a real IndexedDB write atomically aborts chunks, manifest and accounting');

  let count = 0;
  registerPeerSync({ requestPeer: async (_peer: string, _protocol: string, operation: string, payload: { manifest: BlobSwarmManifest; chunks: { index: number }[] }) => {
    if (operation === 'sync.blob.inventory') return { ok: true, indices: [] };
    count++;
    setActiveScope('other'); window.dispatchEvent(new Event('focus'));
    setActiveScope('files'); window.dispatchEvent(new Event('focus'));
    return { ok: true, stored_indices: payload.chunks.map(chunk => chunk.index) };
  } } as unknown as PeerSync);
  cancelled = false;
  try { await uploadEncryptedAttachment(data, 'fixture.txt', 'text/plain', 'files'); } catch { cancelled = true; }
  assert(cancelled && count === 1, 'Navigation started another distribution batch');
  const navigated = await cache();
  assert(navigated.bytes === 0 && navigated.manifests === 0 && navigated.chunks === 0, 'Navigation left orphan storage');
  checks.push('Leave-and-return navigation remains cancelled, stops further batches and leaves no IndexedDB orphan');
  registerPeerSync(null as unknown as PeerSync); await resetBlobSwarmForTests();
  return checks;
}
(window as unknown as { verifyBlobUploads: typeof run }).verifyBlobUploads = run;
