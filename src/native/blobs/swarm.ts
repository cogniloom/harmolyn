// Peer-owned encrypted blob fragments.
//
// Attachments are encrypted before entering this module. We split only opaque
// ciphertext into content-addressed fragments, retain a complete local source,
// prefer support nodes as remote holders, and fill missing replicas with
// authenticated scope members. Every fragment is verified against the
// author-signed manifest before it is accepted or served.

import { sha256 } from '@noble/hashes/sha2.js';
import { PROTOCOLS } from '../families/families.js';
import {
  BLOB_SWARM_MAX_CHUNKS,
  BLOB_SWARM_MAX_PROVIDERS,
  BLOB_SWARM_MAX_CHUNK_BYTES,
  BLOB_SWARM_MIN_CHUNK_BYTES,
  decodeBase64Strict,
  encodeBase64Chunked,
  hasControlCharacters,
  isPlainObject,
  isSafeBlobSwarmManifest,
  MAX_ATTACHMENT_BYTES,
} from '../security/limits.js';
import { getState } from '../state/store.js';
import { getPeerSync } from '../sync/registry.js';
import { createReplicaUploaderProof } from '../sync/replica.js';
import type { BlobSwarmManifest } from '../../types.js';

const DB_NAME = 'harmolyn-blob-swarm-v1';
const DB_VERSION = 3;
const CHUNKS_STORE = 'chunks';
const MANIFESTS_STORE = 'manifests';
const USAGE_STORE = 'usage';
const USAGE_KEY = 'cache-usage';
const MAX_LOCAL_CACHE_BYTES = 512 * 1024 * 1024;
const MAX_REMOTE_SPONSOR_BYTES = 128 * 1024 * 1024;
const MAX_STORE_BATCH_CHUNKS = 2;
const MAX_FETCH_BATCH_CHUNKS = 2;
const TARGET_REMOTE_COPIES = 3;
const MAX_PARALLEL_REQUESTS = 6;
const MAX_PROVIDER_FAILURES = 3;
const MAX_SPONSOR_ACCOUNTS = 8192;

interface StoredChunk {
  key: string;
  blob_id: string;
  index: number;
  hash: string;
  data: ArrayBuffer;
  stored_at: number;
  sponsor_peer_id?: string;
}

interface CacheUsage {
  key: typeof USAGE_KEY;
  total_bytes: number;
  sponsor_bytes: Array<[string, number]>;
}

interface WireChunk {
  index: number;
  hash: string;
  data: string;
  created_at?: string;
  uploader_peer_id?: string;
  uploader_ed_pub?: string;
  uploader_mldsa_pub?: string;
  uploader_signature?: string;
}

interface ProviderHealth {
  failures: number;
  invalid: number;
  quarantined: boolean;
}

export interface BlobSwarmSeedReport {
  attemptedProviders: number;
  successfulProviders: string[];
  fullyReplicatedChunks: number;
  totalChunks: number;
}

const memoryChunks = new Map<string, StoredChunk>();
const memoryManifests = new Map<string, BlobSwarmManifest>();
const providerHealth = new Map<string, ProviderHealth>();
const learnedNodeProviders = new Map<string, Set<string>>();
const memorySponsorBytes = new Map<string, number>();
let memoryBytes = 0;
let dbPromise: Promise<IDBDatabase> | null = null;
let persistentWriteQueue: Promise<void> = Promise.resolve();
let auditRemaining = randomAuditInterval();

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

function digest(bytes: Uint8Array): string {
  return hex(sha256(bytes));
}

function randomNamespace(): string {
  return encodeBase64Chunked(crypto.getRandomValues(new Uint8Array(32)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function chunkKey(blobId: string, index: number): string {
  return `${blobId}:${index}`;
}

function cloneManifest(manifest: BlobSwarmManifest): BlobSwarmManifest {
  return {
    ...manifest,
    chunk_hashes: [...manifest.chunk_hashes],
    ...(manifest.provider_peer_ids
      ? { provider_peer_ids: [...manifest.provider_peer_ids] }
      : {}),
  };
}

function cloneChunk(chunk: StoredChunk): StoredChunk {
  return {
    ...chunk,
    data: chunk.data.slice(0),
  };
}

function randomAuditInterval(): number {
  const random = new Uint32Array(1);
  crypto.getRandomValues(random);
  return 20 + (random[0] % 31);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('blob swarm database request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('blob swarm database transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('blob swarm database transaction failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      let chunks: IDBObjectStore;
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        chunks = db.createObjectStore(CHUNKS_STORE, { keyPath: 'key' });
        chunks.createIndex('blob_id', 'blob_id', { unique: false });
        chunks.createIndex('stored_at', 'stored_at', { unique: false });
        chunks.createIndex('sponsor_peer_id', 'sponsor_peer_id', { unique: false });
      } else {
        chunks = request.transaction!.objectStore(CHUNKS_STORE);
        if (!chunks.indexNames.contains('sponsor_peer_id')) {
          chunks.createIndex('sponsor_peer_id', 'sponsor_peer_id', { unique: false });
        }
      }
      if (!db.objectStoreNames.contains(MANIFESTS_STORE)) {
        db.createObjectStore(MANIFESTS_STORE, { keyPath: 'blob_id' });
      }
      if (!db.objectStoreNames.contains(USAGE_STORE)) {
        const usage = db.createObjectStore(USAGE_STORE, { keyPath: 'key' });
        // One-time migration reads one chunk at a time while the old database is
        // upgraded. Normal quota checks thereafter read only this small record.
        const totals = new Map<string, number>();
        let totalBytes = 0;
        const cursor = chunks.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) {
            const record = item.value as StoredChunk;
            const bytes = record.data instanceof ArrayBuffer ? record.data.byteLength : 0;
            totalBytes += bytes;
            if (record.sponsor_peer_id) {
              totals.set(
                record.sponsor_peer_id,
                (totals.get(record.sponsor_peer_id) ?? 0) + bytes,
              );
            }
            item.continue();
            return;
          }
          usage.put({
            key: USAGE_KEY,
            total_bytes: totalBytes,
            sponsor_bytes: [...totals],
          } satisfies CacheUsage);
        };
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('blob swarm database unavailable'));
    };
  });
  return dbPromise;
}

function normalizeUsage(value: unknown): CacheUsage | null {
  if (!isPlainObject(value)
    || value.key !== USAGE_KEY
    || !Number.isSafeInteger(value.total_bytes)
    || Number(value.total_bytes) < 0
    || !Array.isArray(value.sponsor_bytes)
    || value.sponsor_bytes.length > 8192) return null;
  const sponsors: Array<[string, number]> = [];
  const seen = new Set<string>();
  for (const entry of value.sponsor_bytes) {
    if (!Array.isArray(entry) || entry.length !== 2
      || typeof entry[0] !== 'string' || !entry[0] || entry[0].length > 256
      || hasControlCharacters(entry[0]) || seen.has(entry[0])
      || !Number.isSafeInteger(entry[1]) || Number(entry[1]) < 0) return null;
    seen.add(entry[0]);
    sponsors.push([entry[0], Number(entry[1])]);
  }
  return { key: USAGE_KEY, total_bytes: Number(value.total_bytes), sponsor_bytes: sponsors };
}

async function persistentUsage(db: IDBDatabase): Promise<CacheUsage> {
  const tx = db.transaction(USAGE_STORE, 'readonly');
  const value = await requestResult(tx.objectStore(USAGE_STORE).get(USAGE_KEY));
  await transactionDone(tx);
  const usage = normalizeUsage(value);
  if (!usage) throw new Error('blob swarm: cache accounting unavailable');
  return usage;
}

async function evictPersistentBytes(
  db: IDBDatabase,
  bytesNeeded: number,
  protectedKeys: ReadonlySet<string>,
): Promise<void> {
  const usage = await persistentUsage(db);
  if (usage.total_bytes + bytesNeeded <= MAX_LOCAL_CACHE_BYTES) return;
  const sponsorBytes = new Map(usage.sponsor_bytes);
  const tx = db.transaction([CHUNKS_STORE, USAGE_STORE], 'readwrite');
  const store = tx.objectStore(CHUNKS_STORE);
  const cursorRequest = store.index('stored_at').openCursor();
  await new Promise<void>((resolve, reject) => {
    cursorRequest.onerror = () => reject(cursorRequest.error ?? new Error('blob swarm eviction failed'));
    cursorRequest.onsuccess = () => {
      const cursor = cursorRequest.result;
      if (!cursor || usage.total_bytes + bytesNeeded <= MAX_LOCAL_CACHE_BYTES) {
        resolve();
        return;
      }
      const record = cursor.value as StoredChunk;
      if (protectedKeys.has(record.key)) {
        cursor.continue();
        return;
      }
      const bytes = record.data.byteLength;
      usage.total_bytes -= bytes;
      if (record.sponsor_peer_id) {
        const remaining = Math.max(0, (sponsorBytes.get(record.sponsor_peer_id) ?? 0) - bytes);
        if (remaining) sponsorBytes.set(record.sponsor_peer_id, remaining);
        else sponsorBytes.delete(record.sponsor_peer_id);
      }
      cursor.delete();
      cursor.continue();
    };
  });
  usage.sponsor_bytes = [...sponsorBytes];
  tx.objectStore(USAGE_STORE).put(usage);
  await transactionDone(tx);
  if (usage.total_bytes + bytesNeeded > MAX_LOCAL_CACHE_BYTES) {
    throw new Error('blob swarm: local cache quota reached');
  }
}

function evictMemoryBytes(bytesNeeded: number): void {
  if (memoryBytes + bytesNeeded <= MAX_LOCAL_CACHE_BYTES) return;
  const oldest = [...memoryChunks.values()].sort((a, b) => a.stored_at - b.stored_at);
  for (const record of oldest) {
    memoryChunks.delete(record.key);
    memoryBytes -= record.data.byteLength;
    if (record.sponsor_peer_id) {
      const remaining = Math.max(
        0,
        (memorySponsorBytes.get(record.sponsor_peer_id) ?? 0) - record.data.byteLength,
      );
      if (remaining) memorySponsorBytes.set(record.sponsor_peer_id, remaining);
      else memorySponsorBytes.delete(record.sponsor_peer_id);
    }
    if (memoryBytes + bytesNeeded <= MAX_LOCAL_CACHE_BYTES) return;
  }
  if (memoryBytes + bytesNeeded > MAX_LOCAL_CACHE_BYTES) {
    throw new Error('blob swarm: local cache quota reached');
  }
}

async function putLocalChunksUnlocked(
  manifest: BlobSwarmManifest,
  chunks: Array<{ index: number; data: Uint8Array }>,
  options: { sponsorPeerId?: string; allowEviction?: boolean } = {},
): Promise<number[]> {
  if (!isSafeBlobSwarmManifest(manifest)) throw new Error('blob swarm: invalid manifest');
  const unique = new Map<number, Uint8Array>();
  for (const chunk of chunks) {
    if (!Number.isSafeInteger(chunk.index)
      || chunk.index < 0
      || chunk.index >= manifest.chunk_hashes.length
      || chunk.data.length < 1
      || chunk.data.length > manifest.chunk_size
      || (chunk.index < manifest.chunk_hashes.length - 1 && chunk.data.length !== manifest.chunk_size)
      || digest(chunk.data) !== manifest.chunk_hashes[chunk.index]) {
      throw new Error('blob swarm: invalid fragment');
    }
    unique.set(chunk.index, chunk.data.slice());
  }
  const accepted = [...unique.keys()];
  const now = Date.now();
  const sponsorPeerId = options.sponsorPeerId;
  const allowEviction = options.allowEviction !== false;
  const db = await openDatabase()?.catch(() => null);
  if (!db) {
    const addedBytes = [...unique].reduce((sum, [index, data]) =>
      sum + (memoryChunks.has(chunkKey(manifest.blob_id, index)) ? 0 : data.length), 0);
    if (sponsorPeerId) {
      const sponsoredBytes = memorySponsorBytes.get(sponsorPeerId) ?? 0;
      if (addedBytes > 0 && sponsoredBytes === 0
        && memorySponsorBytes.size >= MAX_SPONSOR_ACCOUNTS) {
        throw new Error('blob swarm: remote sponsor capacity reached');
      }
      if (sponsoredBytes + addedBytes > MAX_REMOTE_SPONSOR_BYTES) {
        throw new Error('blob swarm: remote peer storage quota reached');
      }
    }
    if (allowEviction) evictMemoryBytes(addedBytes);
    else if (memoryBytes + addedBytes > MAX_LOCAL_CACHE_BYTES) {
      throw new Error('blob swarm: local cache quota reached');
    }
    for (const [index, data] of unique) {
      const key = chunkKey(manifest.blob_id, index);
      const prior = memoryChunks.get(key);
      if (prior) continue;
      const record: StoredChunk = {
        key,
        blob_id: manifest.blob_id,
        index,
        hash: manifest.chunk_hashes[index],
        data: toArrayBuffer(data),
        stored_at: now,
        ...(sponsorPeerId ? { sponsor_peer_id: sponsorPeerId } : {}),
      };
      memoryChunks.set(key, record);
      memoryBytes += data.byteLength;
      if (sponsorPeerId) {
        memorySponsorBytes.set(
          sponsorPeerId,
          (memorySponsorBytes.get(sponsorPeerId) ?? 0) + data.byteLength,
        );
      }
    }
    memoryManifests.set(manifest.blob_id, cloneManifest(manifest));
    return accepted;
  }

  const readTx = db.transaction(CHUNKS_STORE, 'readonly');
  const readStore = readTx.objectStore(CHUNKS_STORE);
  const uniqueIndices = [...unique.keys()];
  const prior = await Promise.all(uniqueIndices.map(index =>
    requestResult(readStore.get(chunkKey(manifest.blob_id, index))) as Promise<StoredChunk | undefined>));
  await transactionDone(readTx);
  const existingIndices = new Set(uniqueIndices.filter((_index, position) => Boolean(prior[position])));
  const addedBytes = [...unique.values()].reduce((sum, data, position) =>
    sum + (prior[position] ? 0 : data.length), 0);
  let usage = await persistentUsage(db);
  if (sponsorPeerId) {
    const sponsorBytes = new Map(usage.sponsor_bytes);
    const sponsoredBytes = sponsorBytes.get(sponsorPeerId) ?? 0;
    if (addedBytes > 0 && sponsoredBytes === 0 && sponsorBytes.size >= MAX_SPONSOR_ACCOUNTS) {
      throw new Error('blob swarm: remote sponsor capacity reached');
    }
    if (sponsoredBytes + addedBytes > MAX_REMOTE_SPONSOR_BYTES) {
      throw new Error('blob swarm: remote peer storage quota reached');
    }
  }
  if (allowEviction) {
    await evictPersistentBytes(
      db,
      addedBytes,
      new Set(uniqueIndices.map(index => chunkKey(manifest.blob_id, index))),
    );
    usage = await persistentUsage(db);
  } else if (usage.total_bytes + addedBytes > MAX_LOCAL_CACHE_BYTES) {
    throw new Error('blob swarm: local cache quota reached');
  }

  const tx = db.transaction([CHUNKS_STORE, MANIFESTS_STORE, USAGE_STORE], 'readwrite');
  const store = tx.objectStore(CHUNKS_STORE);
  for (const [index, data] of unique) {
    if (existingIndices.has(index)) continue;
    const record: StoredChunk = {
      key: chunkKey(manifest.blob_id, index),
      blob_id: manifest.blob_id,
      index,
      hash: manifest.chunk_hashes[index],
      data: toArrayBuffer(data),
      stored_at: now,
      ...(sponsorPeerId ? { sponsor_peer_id: sponsorPeerId } : {}),
    };
    store.put(record);
  }
  tx.objectStore(MANIFESTS_STORE).put(cloneManifest(manifest));
  if (addedBytes) {
    usage.total_bytes += addedBytes;
    if (sponsorPeerId) {
      const sponsorBytes = new Map(usage.sponsor_bytes);
      sponsorBytes.set(sponsorPeerId, (sponsorBytes.get(sponsorPeerId) ?? 0) + addedBytes);
      usage.sponsor_bytes = [...sponsorBytes];
    }
    tx.objectStore(USAGE_STORE).put(usage);
  }
  await transactionDone(tx);
  return accepted;
}

function putLocalChunks(
  manifest: BlobSwarmManifest,
  chunks: Array<{ index: number; data: Uint8Array }>,
  options: { sponsorPeerId?: string; allowEviction?: boolean } = {},
): Promise<number[]> {
  const run = persistentWriteQueue.then(() => putLocalChunksUnlocked(manifest, chunks, options));
  persistentWriteQueue = run.then(() => undefined, () => undefined);
  return run;
}

async function getLocalChunks(
  manifest: BlobSwarmManifest,
  indices: number[],
): Promise<Map<number, Uint8Array>> {
  const wanted = [...new Set(indices)]
    .filter(index => Number.isSafeInteger(index) && index >= 0 && index < manifest.chunk_hashes.length);
  const out = new Map<number, Uint8Array>();
  const db = await openDatabase()?.catch(() => null);
  if (!db) {
    for (const index of wanted) {
      const record = memoryChunks.get(chunkKey(manifest.blob_id, index));
      if (!record) continue;
      const data = new Uint8Array(record.data.slice(0));
      if (record.hash === manifest.chunk_hashes[index] && digest(data) === record.hash) out.set(index, data);
    }
    return out;
  }
  const tx = db.transaction(CHUNKS_STORE, 'readonly');
  const store = tx.objectStore(CHUNKS_STORE);
  const records = await Promise.all(wanted.map(index =>
    requestResult(store.get(chunkKey(manifest.blob_id, index))) as Promise<StoredChunk | undefined>));
  await transactionDone(tx);
  records.forEach((record, position) => {
    if (!record) return;
    const index = wanted[position];
    const data = new Uint8Array(record.data);
    if (record.hash === manifest.chunk_hashes[index] && digest(data) === record.hash) out.set(index, data);
  });
  return out;
}

async function localInventory(manifest: BlobSwarmManifest): Promise<number[]> {
  return [...(await getLocalChunks(
    manifest,
    Array.from({ length: manifest.chunk_hashes.length }, (_, index) => index),
  )).keys()];
}

function chooseChunkSize(ciphertextBytes: number, providerCount: number): number {
  const targetChunks = Math.min(
    BLOB_SWARM_MAX_CHUNKS,
    Math.max(16, Math.min(BLOB_SWARM_MAX_PROVIDERS, Math.max(1, providerCount))),
  );
  const desired = Math.ceil(ciphertextBytes / targetChunks);
  return Math.min(
    BLOB_SWARM_MAX_CHUNK_BYTES,
    Math.max(BLOB_SWARM_MIN_CHUNK_BYTES, Math.ceil(desired / 1024) * 1024),
  );
}

export async function createLocalBlobSwarm(
  ciphertext: Uint8Array,
  scopeId: string,
  ownerPeerId: string,
  providerCount = 0,
): Promise<BlobSwarmManifest> {
  if (ciphertext.length < 16 || ciphertext.length > MAX_ATTACHMENT_BYTES + 16) {
    throw new Error('blob swarm: invalid ciphertext size');
  }
  const chunkSize = chooseChunkSize(ciphertext.length, providerCount);
  const chunks: Array<{ index: number; data: Uint8Array }> = [];
  const hashes: string[] = [];
  for (let offset = 0, index = 0; offset < ciphertext.length; offset += chunkSize, index++) {
    const data = ciphertext.slice(offset, Math.min(ciphertext.length, offset + chunkSize));
    chunks.push({ index, data });
    hashes.push(digest(data));
  }
  const manifest: BlobSwarmManifest = {
    version: 1,
    blob_id: digest(ciphertext),
    node_namespace: randomNamespace(),
    scope_id: scopeId,
    owner_peer_id: ownerPeerId,
    ciphertext_size: ciphertext.length,
    chunk_size: chunkSize,
    chunk_hashes: hashes,
  };
  if (!isSafeBlobSwarmManifest(manifest)) throw new Error('blob swarm: generated invalid manifest');
  await putLocalChunks(manifest, chunks);
  return manifest;
}

export async function readLocalBlobSwarm(manifest: BlobSwarmManifest): Promise<Uint8Array | null> {
  if (!isSafeBlobSwarmManifest(manifest)) return null;
  const chunks = await getLocalChunks(
    manifest,
    Array.from({ length: manifest.chunk_hashes.length }, (_, index) => index),
  );
  if (chunks.size !== manifest.chunk_hashes.length) return null;
  const ciphertext = new Uint8Array(manifest.ciphertext_size);
  let offset = 0;
  for (let index = 0; index < manifest.chunk_hashes.length; index++) {
    const chunk = chunks.get(index);
    if (!chunk) return null;
    ciphertext.set(chunk, offset);
    offset += chunk.length;
  }
  return offset === manifest.ciphertext_size && digest(ciphertext) === manifest.blob_id
    ? ciphertext
    : null;
}

function scopeMemberPeerIds(scopeId: string): string[] {
  const state = getState();
  const server = Object.values(state.servers).find(candidate =>
    Object.prototype.hasOwnProperty.call(candidate.channels, scopeId));
  if (server) return [...server.members];
  const dm = state.dms[scopeId];
  return dm ? [...dm.participants] : [];
}

function isAuthorizedScopePeer(scopeId: string, peerId: string): boolean {
  return scopeMemberPeerIds(scopeId).includes(peerId);
}

function providerCandidates(manifest: BlobSwarmManifest): { support: string[]; members: string[] } {
  const state = getState();
  const self = state.identity?.peer_id ?? '';
  const support = [
    ...Object.values(state.peers)
    .filter(peer => peer.peer_id !== self && (peer.role === 'relay' || peer.role === 'archivist'))
      .map(peer => peer.peer_id),
    ...[...(learnedNodeProviders.get(manifest.blob_id) ?? [])]
      .filter(peerId => {
        const role = state.peers[peerId]?.role;
        return role === 'relay' || role === 'archivist';
      }),
  ];
  const members = [
    ...(manifest.provider_peer_ids ?? []),
    manifest.owner_peer_id,
    ...scopeMemberPeerIds(manifest.scope_id),
  ].filter(peer => peer && peer !== self && !support.includes(peer));
  return {
    support: [...new Set(support)].slice(0, BLOB_SWARM_MAX_PROVIDERS),
    members: [...new Set(members)].slice(0, BLOB_SWARM_MAX_PROVIDERS),
  };
}

function isSupportProvider(peerId: string): boolean {
  const role = getState().peers[peerId]?.role;
  return role === 'relay' || role === 'archivist';
}

function manifestForProvider(
  peerId: string,
  manifest: BlobSwarmManifest,
): BlobSwarmManifest | Record<string, unknown> | null {
  if (!isSupportProvider(peerId)) return manifest;
  if (!manifest.node_namespace) return null;
  // Never reveal the real channel/DM scope to infrastructure. Nodes need only
  // an opaque namespace plus content-addressed shard metadata.
  return {
    version: 1,
    node_namespace: manifest.node_namespace,
    blob_id: manifest.blob_id,
    ciphertext_size: manifest.ciphertext_size,
    chunk_size: manifest.chunk_size,
    chunk_hashes: manifest.chunk_hashes,
  };
}

function rememberProviderHints(blobId: string, value: unknown): void {
  if (!Array.isArray(value)) return;
  const state = getState();
  const hints = learnedNodeProviders.get(blobId) ?? new Set<string>();
  for (const peerId of value.slice(0, 32)) {
    if (typeof peerId !== 'string' || peerId.length < 1 || peerId.length > 256) continue;
    const role = state.peers[peerId]?.role;
    // Bare IDs from an untrusted node never create dial targets. Accept only
    // support peers already authenticated through signed PEX.
    if (role === 'relay' || role === 'archivist') hints.add(peerId);
  }
  learnedNodeProviders.set(blobId, hints);
}

function rotated<T>(values: T[], offset: number): T[] {
  if (values.length < 2) return [...values];
  const start = offset % values.length;
  return [...values.slice(start), ...values.slice(0, start)];
}

function chunksOf<T>(values: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

async function parallelMap<T, R>(
  values: T[],
  limit: number,
  fn: (value: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor++;
      out[index] = await fn(values[index]);
    }
  }));
  return out;
}

function healthFor(peerId: string): ProviderHealth {
  const current = providerHealth.get(peerId) ?? { failures: 0, invalid: 0, quarantined: false };
  providerHealth.set(peerId, current);
  return current;
}

function recordProviderSuccess(peerId: string): void {
  const health = healthFor(peerId);
  health.failures = Math.max(0, health.failures - 1);
}

function recordProviderFailure(peerId: string): void {
  const health = healthFor(peerId);
  health.failures++;
  if (health.failures >= MAX_PROVIDER_FAILURES) health.quarantined = true;
}

function recordProviderInvalid(peerId: string): void {
  const health = healthFor(peerId);
  health.invalid++;
  health.quarantined = true;
}

function usableProvider(peerId: string): boolean {
  return !healthFor(peerId).quarantined;
}

async function sendChunkBatch(
  peerId: string,
  manifest: BlobSwarmManifest,
  chunks: Array<{ index: number; data: Uint8Array }>,
): Promise<number[]> {
  const peerSync = getPeerSync();
  if (!peerSync || !usableProvider(peerId)) return [];
  const wireManifest = manifestForProvider(peerId, manifest);
  if (!wireManifest) return [];
	const supportProvider = isSupportProvider(peerId);
	const uploaderPeerId = getState().identity?.peer_id ?? '';
	const wireChunks: WireChunk[] = [];
	for (const chunk of chunks) {
		const data = encodeBase64Chunked(chunk.data);
		const base: WireChunk = {
			index: chunk.index,
			hash: manifest.chunk_hashes[chunk.index],
			data,
		};
		if (!supportProvider) {
			wireChunks.push(base);
			continue;
		}
		const createdAt = new Date().toISOString();
		const envelope = {
			version: 1,
			blob_id: manifest.blob_id,
			index: chunk.index,
			hash: base.hash,
			data,
			ciphertext_size: manifest.ciphertext_size,
			chunk_size: manifest.chunk_size,
			chunk_count: manifest.chunk_hashes.length,
		};
		const proof = createReplicaUploaderProof({
			version: 1,
			namespace: manifest.node_namespace ?? '',
			id: `blob:${manifest.blob_id}:${chunk.index}`,
			revision: 0,
			created_at: createdAt,
			content_hash: base.hash,
			key_epoch: 0,
			uploader_peer_id: uploaderPeerId,
			envelope,
		});
		if (!proof) return [];
		wireChunks.push({
			...base,
			created_at: createdAt,
			uploader_peer_id: uploaderPeerId,
			...proof,
		});
	}
  const response = await peerSync.requestPeer<{
    ok?: boolean;
    stored_indices?: number[];
    provider_peer_ids?: string[];
  }>(
    peerId,
    PROTOCOLS.sync,
    'sync.blob.store',
    {
      manifest: wireManifest,
		chunks: wireChunks,
    },
  );
  if (!response?.ok || !Array.isArray(response.stored_indices)) {
    recordProviderFailure(peerId);
    return [];
  }
  rememberProviderHints(manifest.blob_id, response.provider_peer_ids);
  const accepted = response.stored_indices.filter(index =>
    chunks.some(chunk => chunk.index === index));
  if (accepted.length) recordProviderSuccess(peerId);
  return accepted;
}

export async function seedBlobSwarm(manifest: BlobSwarmManifest): Promise<BlobSwarmSeedReport> {
  if (!isSafeBlobSwarmManifest(manifest)) throw new Error('blob swarm: invalid manifest');
  const local = await getLocalChunks(
    manifest,
    Array.from({ length: manifest.chunk_hashes.length }, (_, index) => index),
  );
  if (local.size !== manifest.chunk_hashes.length) throw new Error('blob swarm: local source incomplete');
  const { support, members } = providerCandidates(manifest);
  const allCandidates = [...support, ...members];
  if (!allCandidates.length) {
    return {
      attemptedProviders: 0,
      successfulProviders: [],
      fullyReplicatedChunks: 0,
      totalChunks: manifest.chunk_hashes.length,
    };
  }

  const acknowledgements = new Map<number, Set<string>>();
  const attempted = new Map<number, Set<string>>();
  const successfulProviders = new Set<string>();
  // On repair passes, verify previously advertised holders (and preferred
  // support nodes) before retransmitting bytes. This turns the same bounded
  // seeding routine into anti-entropy: healthy copies are counted, missing
  // copies are filled elsewhere, and dead providers do not pin the manifest.
  const knownProviders = [...new Set([
    ...support,
    ...(manifest.provider_peer_ids ?? []),
  ])].filter(peer => allCandidates.includes(peer)).slice(0, 16);
  const inventories = await parallelMap(
    knownProviders,
    MAX_PARALLEL_REQUESTS,
    async peerId => ({ peerId, indices: await providerInventory(peerId, manifest) }),
  );
  for (const inventory of inventories) {
    if (inventory.indices.length) successfulProviders.add(inventory.peerId);
    for (const index of inventory.indices) {
      const peers = acknowledgements.get(index) ?? new Set<string>();
      peers.add(inventory.peerId);
      acknowledgements.set(index, peers);
    }
  }
  let remaining = true;
  while (remaining) {
    remaining = false;
    const assignments = new Map<string, Array<{ index: number; data: Uint8Array }>>();
    for (let index = 0; index < manifest.chunk_hashes.length; index++) {
      const ack = acknowledgements.get(index) ?? new Set<string>();
      acknowledgements.set(index, ack);
      if (ack.size >= TARGET_REMOTE_COPIES) continue;
      const tried = attempted.get(index) ?? new Set<string>();
      attempted.set(index, tried);
      const ordered = [
        ...rotated(support, index),
        ...rotated(members, index),
      ].filter(peer => usableProvider(peer));
      const next = ordered.find(peer => !tried.has(peer));
      if (!next) continue;
      remaining = true;
      tried.add(next);
      assignments.set(next, [
        ...(assignments.get(next) ?? []),
        { index, data: local.get(index)! },
      ]);
    }
    const jobs = [...assignments].flatMap(([peerId, assigned]) =>
      chunksOf(assigned, MAX_STORE_BATCH_CHUNKS).map(batch => ({ peerId, batch })));
    if (!jobs.length) break;
    const outcomes = await parallelMap(jobs, MAX_PARALLEL_REQUESTS, async job => ({
      peerId: job.peerId,
      indices: await sendChunkBatch(job.peerId, manifest, job.batch),
    }));
    for (const outcome of outcomes) {
      if (outcome.indices.length) successfulProviders.add(outcome.peerId);
      for (const index of outcome.indices) acknowledgements.get(index)?.add(outcome.peerId);
    }
  }

  const providerList = [...successfulProviders].slice(0, BLOB_SWARM_MAX_PROVIDERS);
  const fullyReplicatedChunks = [...acknowledgements.values()]
    .filter(peers => peers.size >= Math.min(TARGET_REMOTE_COPIES, allCandidates.length)).length;
  return {
    attemptedProviders: allCandidates.length,
    successfulProviders: providerList,
    fullyReplicatedChunks,
    totalChunks: manifest.chunk_hashes.length,
  };
}

export async function handleBlobSyncRequest(
  operation: string,
  payload: Record<string, unknown>,
  remotePeerId: string,
): Promise<Record<string, unknown>> {
  const manifest = isSafeBlobSwarmManifest(payload.manifest) ? payload.manifest : null;
  if (!manifest) return { ok: false, error: 'invalid_blob_manifest' };
  if (!isAuthorizedScopePeer(manifest.scope_id, remotePeerId)) {
    return { ok: false, error: 'member_required' };
  }

  if (operation === 'sync.blob.store') {
    if (!Array.isArray(payload.chunks)
      || payload.chunks.length < 1
      || payload.chunks.length > MAX_STORE_BATCH_CHUNKS) {
      return { ok: false, error: 'invalid_blob_chunks' };
    }
    const decoded: Array<{ index: number; data: Uint8Array }> = [];
    for (const candidate of payload.chunks) {
      if (!isPlainObject(candidate)
        || !Number.isSafeInteger(candidate.index)
        || typeof candidate.hash !== 'string'
        || typeof candidate.data !== 'string') {
        return { ok: false, error: 'invalid_blob_chunk' };
      }
      const index = Number(candidate.index);
      if (index < 0
        || index >= manifest.chunk_hashes.length
        || candidate.hash !== manifest.chunk_hashes[index]) {
        return { ok: false, error: 'invalid_blob_chunk' };
      }
      const data = decodeBase64Strict(candidate.data, manifest.chunk_size);
      if (!data || digest(data) !== candidate.hash) {
        recordProviderInvalid(remotePeerId);
        return { ok: false, error: 'invalid_blob_chunk' };
      }
      decoded.push({ index, data });
    }
    try {
      return {
        ok: true,
        stored_indices: await putLocalChunks(manifest, decoded, {
          sponsorPeerId: remotePeerId,
          allowEviction: false,
        }),
      };
    } catch {
      return { ok: false, error: 'blob_store_unavailable' };
    }
  }

  if (operation === 'sync.blob.inventory') {
    return { ok: true, indices: await localInventory(manifest) };
  }

  if (operation === 'sync.blob.fetch') {
    const indices = Array.isArray(payload.indices)
      ? payload.indices.filter((index): index is number =>
        Number.isSafeInteger(index) && Number(index) >= 0 && Number(index) < manifest.chunk_hashes.length)
      : [];
    if (!indices.length
      || indices.length > MAX_FETCH_BATCH_CHUNKS
      || indices.length !== (payload.indices as unknown[] | undefined)?.length) {
      return { ok: false, error: 'invalid_blob_indices' };
    }
    const chunks = await getLocalChunks(manifest, indices);
    return {
      ok: true,
      chunks: [...chunks].map(([index, data]) => ({
        index,
        hash: manifest.chunk_hashes[index],
        data: encodeBase64Chunked(data),
      })),
    };
  }

  return { ok: false, error: 'unsupported_blob_operation' };
}

async function providerInventory(peerId: string, manifest: BlobSwarmManifest): Promise<number[]> {
  const peerSync = getPeerSync();
  if (!peerSync || !usableProvider(peerId)) return [];
  const wireManifest = manifestForProvider(peerId, manifest);
  if (!wireManifest) return [];
  const response = await peerSync.requestPeer<{
    ok?: boolean;
    indices?: number[];
    provider_peer_ids?: string[];
  }>(
    peerId,
    PROTOCOLS.sync,
    'sync.blob.inventory',
    { manifest: wireManifest },
  );
  if (!response?.ok || !Array.isArray(response.indices)) {
    recordProviderFailure(peerId);
    return [];
  }
  rememberProviderHints(manifest.blob_id, response.provider_peer_ids);
  const indices = [...new Set(response.indices.filter(index =>
    Number.isSafeInteger(index) && index >= 0 && index < manifest.chunk_hashes.length))];
  recordProviderSuccess(peerId);
  return indices;
}

async function fetchChunkBatch(
  peerId: string,
  manifest: BlobSwarmManifest,
  indices: number[],
): Promise<Map<number, Uint8Array>> {
  const peerSync = getPeerSync();
  const out = new Map<number, Uint8Array>();
  if (!peerSync || !usableProvider(peerId)) return out;
  const wireManifest = manifestForProvider(peerId, manifest);
  if (!wireManifest) return out;
  const response = await peerSync.requestPeer<{
    ok?: boolean;
    chunks?: WireChunk[];
    provider_peer_ids?: string[];
  }>(
    peerId,
    PROTOCOLS.sync,
    'sync.blob.fetch',
    { manifest: wireManifest, indices },
  );
  if (!response?.ok || !Array.isArray(response.chunks)) {
    recordProviderFailure(peerId);
    return out;
  }
  rememberProviderHints(manifest.blob_id, response.provider_peer_ids);
  for (const chunk of response.chunks) {
    if (!isPlainObject(chunk)
      || !Number.isSafeInteger(chunk.index)
      || !indices.includes(chunk.index)
      || chunk.hash !== manifest.chunk_hashes[chunk.index]
      || typeof chunk.data !== 'string') {
      recordProviderInvalid(peerId);
      continue;
    }
    const data = decodeBase64Strict(chunk.data, manifest.chunk_size);
    if (!data || digest(data) !== chunk.hash) {
      recordProviderInvalid(peerId);
      continue;
    }
    out.set(chunk.index, data);
  }
  if (out.size) recordProviderSuccess(peerId);
  else recordProviderFailure(peerId);
  return out;
}

async function auditChunk(
  manifest: BlobSwarmManifest,
  index: number,
  accepted: Uint8Array,
  acceptedProvider: string,
  holders: Map<number, string[]>,
): Promise<void> {
  auditRemaining--;
  if (auditRemaining > 0) return;
  auditRemaining = randomAuditInterval();
  const alternates = (holders.get(index) ?? [])
    .filter(peer => peer !== acceptedProvider && usableProvider(peer))
    .slice(0, 2);
  await Promise.all(alternates.map(async peer => {
    const copy = (await fetchChunkBatch(peer, manifest, [index])).get(index);
    // Unavailability is a reachability failure, not proof of corruption.
    // Quarantine only a contradictory byte-for-byte copy; fetchChunkBatch
    // already quarantines malformed/hash-invalid responses itself.
    if (copy && digest(copy) !== digest(accepted)) recordProviderInvalid(peer);
  }));
}

export async function fetchBlobFromSwarm(manifest: BlobSwarmManifest): Promise<Uint8Array> {
  if (!isSafeBlobSwarmManifest(manifest)) throw new Error('blob swarm: invalid manifest');
  const local = await readLocalBlobSwarm(manifest);
  if (local) return local;

  const { support, members } = providerCandidates(manifest);
  const providers = [...support, ...members].filter(usableProvider);
  if (!providers.length) throw new Error('blob swarm: no providers are currently reachable');
  const inventories = await parallelMap(providers, MAX_PARALLEL_REQUESTS, async peerId => ({
    peerId,
    indices: await providerInventory(peerId, manifest),
  }));
  const holders = new Map<number, string[]>();
  for (const inventory of inventories) {
    for (const index of inventory.indices) {
      holders.set(index, [...(holders.get(index) ?? []), inventory.peerId]);
    }
  }

  const accepted = await getLocalChunks(
    manifest,
    Array.from({ length: manifest.chunk_hashes.length }, (_, index) => index),
  );
  const attempted = new Map<number, Set<string>>();
  while (accepted.size < manifest.chunk_hashes.length) {
    const assignments = new Map<string, number[]>();
    for (let index = 0; index < manifest.chunk_hashes.length; index++) {
      if (accepted.has(index)) continue;
      const tried = attempted.get(index) ?? new Set<string>();
      attempted.set(index, tried);
      const next = (holders.get(index) ?? []).find(peer => !tried.has(peer) && usableProvider(peer));
      if (!next) continue;
      tried.add(next);
      assignments.set(next, [...(assignments.get(next) ?? []), index]);
    }
    const jobs = [...assignments].flatMap(([peerId, indices]) =>
      chunksOf(indices, MAX_FETCH_BATCH_CHUNKS).map(batch => ({ peerId, indices: batch })));
    if (!jobs.length) break;
    const outcomes = await parallelMap(jobs, MAX_PARALLEL_REQUESTS, async job => ({
      peerId: job.peerId,
      chunks: await fetchChunkBatch(job.peerId, manifest, job.indices),
    }));
    for (const outcome of outcomes) {
      for (const [index, data] of outcome.chunks) {
        if (!accepted.has(index)) {
          accepted.set(index, data);
          await auditChunk(manifest, index, data, outcome.peerId, holders);
        }
      }
    }
  }
  if (accepted.size !== manifest.chunk_hashes.length) {
    throw new Error(`blob swarm: ${manifest.chunk_hashes.length - accepted.size} fragments unavailable`);
  }
  await putLocalChunks(manifest, [...accepted].map(([index, data]) => ({ index, data })));
  const ciphertext = await readLocalBlobSwarm(manifest);
  if (!ciphertext) throw new Error('blob swarm: reconstructed ciphertext failed integrity verification');
  return ciphertext;
}

export function blobProviderHealthSnapshot(): Record<string, ProviderHealth> {
  return Object.fromEntries([...providerHealth].map(([peer, health]) => [peer, { ...health }]));
}

export async function resetBlobSwarmForTests(): Promise<void> {
  memoryChunks.clear();
  memoryManifests.clear();
  providerHealth.clear();
  learnedNodeProviders.clear();
  memorySponsorBytes.clear();
  memoryBytes = 0;
  persistentWriteQueue = Promise.resolve();
  auditRemaining = randomAuditInterval();
  const db = await openDatabase()?.catch(() => null);
  db?.close();
  dbPromise = null;
  if (typeof indexedDB !== 'undefined') {
    await new Promise<void>((resolve) => {
      const request = indexedDB.deleteDatabase(DB_NAME);
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
    });
  }
}
