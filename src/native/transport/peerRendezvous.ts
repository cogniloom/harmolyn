import { isTrustedPeerCircuitMultiaddr } from './node.js';
import { hasControlCharacters, isPlainObject } from '../security/limits.js';

const DB_NAME = 'harmolyn-peer-rendezvous-v1';
const DB_VERSION = 1;
const STORE = 'registrations';
const MAX_TOTAL_RECORDS = 20_000;
const MAX_NAMESPACE_RECORDS = 2_000;
const MAX_ADDRS = 8;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 7_200;

interface Registration {
  key: string;
  namespace: string;
  peer_id: string;
  addrs: string[];
  expires_at: number;
  registered_at: number;
}

const memory = new Map<string, Registration>();
let dbPromise: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('peer rendezvous request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('peer rendezvous transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('peer rendezvous transaction failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (db.objectStoreNames.contains(STORE)) return;
      const store = db.createObjectStore(STORE, { keyPath: 'key' });
      store.createIndex('namespace', 'namespace', { unique: false });
      store.createIndex('expires_at', 'expires_at', { unique: false });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('peer rendezvous unavailable'));
    };
  });
  return dbPromise;
}

function validNamespace(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

function validPeerId(value: string): boolean {
  return value.length > 0 && value.length <= 256 && !hasControlCharacters(value);
}

function validAddrs(value: unknown, peerId: string): value is string[] {
  return Array.isArray(value)
    && value.length > 0
    && value.length <= MAX_ADDRS
    && value.every(address => isTrustedPeerCircuitMultiaddr(address, peerId));
}

function pruneMemory(now: number): void {
  for (const [key, record] of memory) {
    if (record.expires_at <= now) memory.delete(key);
  }
}

async function pruneDatabase(db: IDBDatabase, now: number): Promise<void> {
  const tx = db.transaction(STORE, 'readwrite');
  const request = tx.objectStore(STORE).index('expires_at').openCursor(IDBKeyRange.upperBound(now));
  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('peer rendezvous pruning failed'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve();
        return;
      }
      cursor.delete();
      cursor.continue();
    };
  });
  await transactionDone(tx);
}

export async function handlePeerRendezvousRequest(
  operation: string,
  payload: Record<string, unknown>,
  remotePeerId: string,
): Promise<Record<string, unknown>> {
  if (!validPeerId(remotePeerId)) return { ok: false, error: 'authenticated_peer_required' };
  const namespace = payload.namespace;
  if (!validNamespace(namespace)) return { ok: false, error: 'invalid_namespace' };
  const now = Date.now();
  const db = await openDatabase()?.catch(() => null);

  if (operation === 'peer.rendezvous.mesh.register') {
    const ttl = Number(payload.ttl_seconds ?? MAX_TTL_SECONDS);
    if (!Number.isSafeInteger(ttl)
      || ttl < MIN_TTL_SECONDS
      || ttl > MAX_TTL_SECONDS
      || !validAddrs(payload.addrs, remotePeerId)) {
      return { ok: false, error: 'invalid_registration' };
    }
    const record: Registration = {
      key: `${namespace}:${remotePeerId}`,
      namespace,
      peer_id: remotePeerId,
      addrs: [...new Set(payload.addrs)],
      expires_at: now + ttl * 1000,
      registered_at: now,
    };
    if (!db) {
      pruneMemory(now);
      const existing = memory.has(record.key);
      const namespaceCount = [...memory.values()].filter(item => item.namespace === namespace).length;
      if (!existing && (memory.size >= MAX_TOTAL_RECORDS || namespaceCount >= MAX_NAMESPACE_RECORDS)) {
        return { ok: false, error: 'rendezvous_quota' };
      }
      memory.set(record.key, record);
      return { ok: true };
    }
    try {
      await pruneDatabase(db, now);
      const readTx = db.transaction(STORE, 'readonly');
      const store = readTx.objectStore(STORE);
      const [existing, total, namespaceRecords] = await Promise.all([
        requestResult(store.get(record.key)) as Promise<Registration | undefined>,
        requestResult(store.count()) as Promise<number>,
        requestResult(store.index('namespace').count(namespace)) as Promise<number>,
      ]);
      await transactionDone(readTx);
      if (!existing && (total >= MAX_TOTAL_RECORDS || namespaceRecords >= MAX_NAMESPACE_RECORDS)) {
        return { ok: false, error: 'rendezvous_quota' };
      }
      const writeTx = db.transaction(STORE, 'readwrite');
      writeTx.objectStore(STORE).put(record);
      await transactionDone(writeTx);
      return { ok: true };
    } catch {
      return { ok: false, error: 'rendezvous_unavailable' };
    }
  }

  if (operation === 'peer.rendezvous.mesh.discover') {
    const requestedLimit = Number(payload.limit ?? 50);
    if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 200) {
      return { ok: false, error: 'invalid_limit' };
    }
    let records: Registration[];
    if (!db) {
      pruneMemory(now);
      records = [...memory.values()].filter(record => record.namespace === namespace);
    } else {
      try {
        await pruneDatabase(db, now);
        const tx = db.transaction(STORE, 'readonly');
        records = await requestResult(
          tx.objectStore(STORE).index('namespace').getAll(namespace),
        ) as Registration[];
        await transactionDone(tx);
      } catch {
        return { ok: false, error: 'rendezvous_unavailable' };
      }
    }
    return {
      ok: true,
      peers: records
        .filter(record => isPlainObject(record) && record.expires_at > now)
        .sort((a, b) => b.registered_at - a.registered_at)
        .slice(0, requestedLimit)
        .map(record => ({
          peer_id: record.peer_id,
          addrs: [...record.addrs],
          ttl_remaining_seconds: Math.max(0, Math.floor((record.expires_at - now) / 1000)),
        })),
    };
  }

  return { ok: false, error: 'unsupported_rendezvous_operation' };
}

export async function resetPeerRendezvousForTests(): Promise<void> {
  memory.clear();
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
