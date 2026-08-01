// Durable, bounded assembly storage for encrypted recovery-state fragments.
// Fragments contain only identity-key-encrypted account state. Keeping them in
// a dedicated IndexedDB prevents localStorage quota failures and survives a
// restart while an offline recipient drains replicas in arbitrary order.

const DB_NAME = 'xorein-recovery-chunks-v1';
const STORE = 'assemblies';
const META_STORE = 'assembly-meta';
const DB_VERSION = 2;
const MAX_ASSEMBLIES = 100;
const MAX_ASSEMBLIES_PER_SOURCE = 2;
const ASSEMBLY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface StoredAssembly {
  key: string;
  source: string;
  fingerprint: string;
  chunkCount: number;
  chunks: Array<string | null>;
  updatedAt: number;
}

// Keep quota data separate from the encrypted fragments.  IndexedDB clones a
// value returned by getAll(), so using the assembly records for housekeeping
// used to copy up to the entire recovery cache for every arriving fragment.
interface AssemblyMeta {
  key: string;
  source: string;
  updatedAt: number;
}

export interface RecoveryChunkInput {
  key: string;
  source: string;
  fingerprint: string;
  chunkCount: number;
  chunkIndex: number;
  data: string;
}

export interface RecoveryChunkResult {
  accepted: boolean;
  chunks?: string[];
}

let writeChain: Promise<void> = Promise.resolve();

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = event => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(META_STORE)) {
        const meta = db.createObjectStore(META_STORE, { keyPath: 'key' });
        meta.createIndex('source', 'source', { unique: false });
        // Populate the compact index once when upgrading existing installs.
        const assemblies = (event.target as IDBOpenDBRequest).transaction?.objectStore(STORE);
        if (assemblies) {
          const cursor = assemblies.openCursor();
          cursor.onsuccess = () => {
            const current = cursor.result;
            if (!current) return;
            if (validStoredAssembly(current.value)) {
              meta.put({ key: current.value.key, source: current.value.source, updatedAt: current.value.updatedAt } satisfies AssemblyMeta);
            }
            current.continue();
          };
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function validStoredAssembly(value: unknown): value is StoredAssembly {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Partial<StoredAssembly>;
  return typeof record.key === 'string'
    && typeof record.source === 'string'
    && typeof record.fingerprint === 'string'
    && Number.isSafeInteger(record.chunkCount)
    && Number(record.chunkCount) > 0
    && Array.isArray(record.chunks)
    && record.chunks.length === record.chunkCount
    && record.chunks.every(chunk => chunk === null || typeof chunk === 'string')
    && typeof record.updatedAt === 'number'
    && Number.isFinite(record.updatedAt);
}

async function pruneAssemblies(now = Date.now()): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction([STORE, META_STORE], 'readwrite');
    const store = tx.objectStore(STORE);
    const metaStore = tx.objectStore(META_STORE);
    const req = metaStore.getAll();
    req.onsuccess = () => {
      const records = (req.result as unknown[])
        .filter((value): value is AssemblyMeta => Boolean(value)
          && typeof (value as AssemblyMeta).key === 'string'
          && typeof (value as AssemblyMeta).source === 'string'
          && Number.isFinite((value as AssemblyMeta).updatedAt))
        .sort((a, b) => b.updatedAt - a.updatedAt);
      const retainedBySource = new Map<string, number>();
      let retained = 0;
      for (const record of records) {
        const sourceCount = retainedBySource.get(record.source) ?? 0;
        const expired = now - record.updatedAt > ASSEMBLY_TTL_MS;
        if (expired || retained >= MAX_ASSEMBLIES || sourceCount >= MAX_ASSEMBLIES_PER_SOURCE) {
          store.delete(record.key);
          metaStore.delete(record.key);
          continue;
        }
        retained++;
        retainedBySource.set(record.source, sourceCount + 1);
      }
    };
    req.onerror = () => reject(req.error);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

function serializeWrite<T>(operation: () => Promise<T>): Promise<T> {
  const result = writeChain.then(operation, operation);
  writeChain = result.then(() => undefined, () => undefined);
  return result;
}

export function appendRecoveryChunk(input: RecoveryChunkInput): Promise<RecoveryChunkResult> {
  return serializeWrite(async () => {
    await pruneAssemblies();
    const db = await openDB();
    const result = await new Promise<RecoveryChunkResult>((resolve, reject) => {
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      const store = tx.objectStore(STORE);
      const metaStore = tx.objectStore(META_STORE);
      const req = store.get(input.key);
      let outcome: RecoveryChunkResult = { accepted: false };
      req.onsuccess = () => {
        const existing = req.result as unknown;
        let record: StoredAssembly;
        if (existing === undefined) {
          record = {
            key: input.key,
            source: input.source,
            fingerprint: input.fingerprint,
            chunkCount: input.chunkCount,
            chunks: Array.from({ length: input.chunkCount }, () => null),
            updatedAt: Date.now(),
          };
        } else if (validStoredAssembly(existing)
          && existing.source === input.source
          && existing.fingerprint === input.fingerprint
          && existing.chunkCount === input.chunkCount) {
          record = existing;
        } else {
          return;
        }
        const previous = record.chunks[input.chunkIndex];
        if (previous !== null && previous !== input.data) return;
        record.chunks[input.chunkIndex] = input.data;
        record.updatedAt = Date.now();
        store.put(record);
        metaStore.put({ key: record.key, source: record.source, updatedAt: record.updatedAt } satisfies AssemblyMeta);
        outcome = record.chunks.every(chunk => chunk !== null)
          ? { accepted: true, chunks: record.chunks as string[] }
          : { accepted: true };
      };
      req.onerror = () => reject(req.error);
      tx.oncomplete = () => resolve(outcome);
      tx.onerror = () => reject(tx.error);
    });
    db.close();
    return result;
  });
}

export async function readRecoveryChunks(
  key: string,
  source: string,
  fingerprint: string,
): Promise<string[] | null> {
  const db = await openDB();
  const record = await new Promise<unknown>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return validStoredAssembly(record)
    && record.source === source
    && record.fingerprint === fingerprint
    && record.chunks.every(chunk => chunk !== null)
    ? record.chunks as string[]
    : null;
}

export function deleteRecoveryChunks(key: string): Promise<void> {
  return serializeWrite(async () => {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction([STORE, META_STORE], 'readwrite');
      tx.objectStore(STORE).delete(key);
      tx.objectStore(META_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
}
