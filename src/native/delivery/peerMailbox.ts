// Browser peers can act as zero-knowledge store-and-forward routers. They see
// only a random epoch token and an already double-encrypted relay frame.

import {
  decodeBase64Strict,
  hasControlCharacters,
  MAX_MAILBOX_BODY_BYTES,
  MAX_MAILBOX_DELIVERIES,
} from '../security/limits.js';
import {
  areRecipientInboxDrainTokens,
  isCurrentRecipientInboxToken,
} from './inboxToken.js';

const DB_NAME = 'harmolyn-peer-mailbox-v1';
const DB_VERSION = 2;
const STORE = 'entries';
const USAGE_STORE = 'usage';
const TOTAL_USAGE_KEY = 'total';
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_TOKEN_ENTRIES = MAX_MAILBOX_DELIVERIES;
const RETENTION_MS = 8 * 24 * 60 * 60 * 1000;

interface PeerMailboxEntry {
  key: string;
  token: string;
  id: string;
  body: string;
  source_peer_id: string;
  size: number;
  stored_at: number;
  expires_at: number;
}

interface MailboxUsage {
  key: typeof TOTAL_USAGE_KEY;
  bytes: number;
}

const memory = new Map<string, PeerMailboxEntry>();
let memoryBytes = 0;
let dbPromise: Promise<IDBDatabase> | null = null;

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('peer mailbox request failed'));
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error ?? new Error('peer mailbox transaction aborted'));
    transaction.onerror = () => reject(transaction.error ?? new Error('peer mailbox transaction failed'));
  });
}

function openDatabase(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === 'undefined') return null;
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: 'key' });
        store.createIndex('token', 'token', { unique: false });
        store.createIndex('source_peer_id', 'source_peer_id', { unique: false });
        store.createIndex('expires_at', 'expires_at', { unique: false });
      }
      if (!db.objectStoreNames.contains(USAGE_STORE)) {
        const usage = db.createObjectStore(USAGE_STORE, { keyPath: 'key' });
        let bytes = 0;
        const entries = request.transaction?.objectStore(STORE).openCursor();
        if (entries) {
          entries.onsuccess = () => {
            const cursor = entries.result;
            if (!cursor) {
              usage.put({ key: TOTAL_USAGE_KEY, bytes } satisfies MailboxUsage);
              return;
            }
            const entry = cursor.value as Partial<PeerMailboxEntry>;
            if (typeof entry.size === 'number' && Number.isFinite(entry.size) && entry.size >= 0) bytes += entry.size;
            cursor.continue();
          };
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error ?? new Error('peer mailbox unavailable'));
    };
  });
  return dbPromise;
}

function validToken(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function validId(value: unknown): value is string {
  return typeof value === 'string'
    && value.length >= 8
    && value.length <= 128
    && !hasControlCharacters(value);
}

function validBody(value: unknown): value is string {
  return typeof value === 'string'
    && decodeBase64Strict(value, MAX_MAILBOX_BODY_BYTES + 5, true) !== null;
}

function pruneMemory(now: number): void {
  for (const [key, entry] of memory) {
    if (entry.expires_at > now) continue;
    memory.delete(key);
    memoryBytes -= entry.size;
  }
}

async function pruneDatabase(db: IDBDatabase, now: number): Promise<void> {
  const tx = db.transaction([STORE, USAGE_STORE], 'readwrite');
  const usageStore = tx.objectStore(USAGE_STORE);
  const usageRequest = usageStore.get(TOTAL_USAGE_KEY);
  const request = tx.objectStore(STORE).index('expires_at').openCursor(IDBKeyRange.upperBound(now));
  let bytes = 0;
  usageRequest.onsuccess = () => { bytes = (usageRequest.result as MailboxUsage | undefined)?.bytes ?? 0; };
  await new Promise<void>((resolve, reject) => {
    request.onerror = () => reject(request.error ?? new Error('peer mailbox pruning failed'));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        usageStore.put({ key: TOTAL_USAGE_KEY, bytes: Math.max(0, bytes) } satisfies MailboxUsage);
        resolve();
        return;
      }
      const entry = cursor.value as PeerMailboxEntry;
      bytes -= entry.size;
      cursor.delete();
      cursor.continue();
    };
  });
  await transactionDone(tx);
}

export async function handlePeerMailboxRequest(
  operation: string,
  payload: Record<string, unknown>,
  remotePeerId: string,
): Promise<Record<string, unknown>> {
  if (!remotePeerId) return { ok: false, error: 'authenticated_peer_required' };
  const db = await openDatabase()?.catch(() => null);
  const now = Date.now();

  if (operation === 'peer.mailbox.store' || operation === 'peer.inbox.store') {
    const recipientPeerId = operation === 'peer.inbox.store'
      ? payload.recipient_peer_id
      : undefined;
    if (!validToken(payload.token) || !validId(payload.id) || !validBody(payload.body)) {
      return { ok: false, error: 'invalid_mailbox_entry' };
    }
    if (operation === 'peer.inbox.store'
      && (typeof recipientPeerId !== 'string'
        || !isCurrentRecipientInboxToken(recipientPeerId, payload.token))) {
      return { ok: false, error: 'invalid_inbox_placement' };
    }
    const token = payload.token;
    const id = payload.id;
    const body = payload.body;
    const key = `${token}:${id}`;
    const size = body.length;
    const entry: PeerMailboxEntry = {
      key,
      token,
      id,
      body,
      source_peer_id: remotePeerId,
      size,
      stored_at: now,
      expires_at: now + RETENTION_MS,
    };

    if (!db) {
      pruneMemory(now);
      if (memory.has(key)) return { ok: true, queued: true, duplicate: true };
      const values = [...memory.values()];
      const sourceBytes = values
        .filter(candidate => candidate.source_peer_id === remotePeerId)
        .reduce((sum, candidate) => sum + candidate.size, 0);
      const tokenCount = values.filter(candidate => candidate.token === token).length;
      if (memoryBytes + size > MAX_TOTAL_BYTES
        || sourceBytes + size > MAX_SOURCE_BYTES
        || tokenCount >= MAX_TOKEN_ENTRIES) {
        return { ok: false, error: 'mailbox_quota' };
      }
      memory.set(key, entry);
      memoryBytes += size;
      return { ok: true, queued: true };
    }

    try {
      await pruneDatabase(db, now);
      const readTx = db.transaction([STORE, USAGE_STORE], 'readonly');
      const store = readTx.objectStore(STORE);
      const [existing, usage, source, tokenEntries] = await Promise.all([
        requestResult(store.get(key)) as Promise<PeerMailboxEntry | undefined>,
        requestResult(readTx.objectStore(USAGE_STORE).get(TOTAL_USAGE_KEY)) as Promise<MailboxUsage | undefined>,
        requestResult(store.index('source_peer_id').getAll(remotePeerId)) as Promise<PeerMailboxEntry[]>,
        requestResult(store.index('token').getAll(token)) as Promise<PeerMailboxEntry[]>,
      ]);
      await transactionDone(readTx);
      if (existing) return { ok: true, queued: true, duplicate: true };
      const totalBytes = usage?.bytes ?? 0;
      const sourceBytes = source.reduce((sum, candidate) => sum + candidate.size, 0);
      if (totalBytes + size > MAX_TOTAL_BYTES
        || sourceBytes + size > MAX_SOURCE_BYTES
        || tokenEntries.length >= MAX_TOKEN_ENTRIES) {
        return { ok: false, error: 'mailbox_quota' };
      }
      const writeTx = db.transaction([STORE, USAGE_STORE], 'readwrite');
      writeTx.objectStore(STORE).put(entry);
      writeTx.objectStore(USAGE_STORE).put({ key: TOTAL_USAGE_KEY, bytes: totalBytes + size } satisfies MailboxUsage);
      await transactionDone(writeTx);
      return { ok: true, queued: true };
    } catch {
      return { ok: false, error: 'mailbox_unavailable' };
    }
  }

  if (operation === 'peer.mailbox.drain' || operation === 'peer.inbox.drain') {
    const recipientInbox = operation === 'peer.inbox.drain';
    const validTokens = recipientInbox
      ? areRecipientInboxDrainTokens(remotePeerId, payload.tokens)
      : Array.isArray(payload.tokens)
        && payload.tokens.length >= 1
        && payload.tokens.length <= 2
        && payload.tokens.every(token => validToken(token));
    const acknowledgeIds = recipientInbox && payload.acknowledge_ids !== undefined
      ? payload.acknowledge_ids
      : [];
    if (!validTokens) {
      return { ok: false, error: 'invalid_mailbox_tokens' };
    }
    if (!Array.isArray(acknowledgeIds)
      || acknowledgeIds.length > MAX_MAILBOX_DELIVERIES
      || acknowledgeIds.some(id => !validId(id))) {
      return { ok: false, error: 'invalid_mailbox_acknowledgement' };
    }
    const tokens = [...new Set(payload.tokens as string[])];
    const acknowledgedIds = new Set(acknowledgeIds as string[]);
    if (!db) {
      pruneMemory(now);
      let acknowledged = 0;
      if (recipientInbox && acknowledgedIds.size > 0) {
        for (const [key, entry] of memory) {
          if (!tokens.includes(entry.token) || !acknowledgedIds.has(entry.id)) continue;
          memory.delete(key);
          memoryBytes -= entry.size;
          acknowledged++;
        }
      }
      const entries = [...memory.values()]
        .filter(entry => tokens.includes(entry.token))
        .sort((a, b) => a.stored_at - b.stored_at)
        .slice(0, MAX_MAILBOX_DELIVERIES);
      if (!recipientInbox) {
        for (const entry of entries) {
          memory.delete(entry.key);
          memoryBytes -= entry.size;
        }
      }
      return {
        ok: true,
        ...(recipientInbox && acknowledged > 0 ? { acknowledged } : {}),
        entries: entries.map(entry => ({ id: entry.id, body: entry.body })),
      };
    }
    try {
      await pruneDatabase(db, now);
      const readTx = db.transaction(STORE, 'readonly');
      const groups = await Promise.all(tokens.map(token =>
        requestResult(readTx.objectStore(STORE).index('token').getAll(token)) as Promise<PeerMailboxEntry[]>));
      await transactionDone(readTx);
      const candidates = groups.flat();
      const acknowledgedEntries = recipientInbox && acknowledgedIds.size > 0
        ? candidates.filter(entry => acknowledgedIds.has(entry.id))
        : [];
      const entries = candidates
        .filter(entry => !acknowledgedIds.has(entry.id))
        .sort((a, b) => a.stored_at - b.stored_at)
        .slice(0, MAX_MAILBOX_DELIVERIES);
      const entriesToDelete = recipientInbox ? acknowledgedEntries : entries;
      if (entriesToDelete.length > 0) {
        const writeTx = db.transaction([STORE, USAGE_STORE], 'readwrite');
        for (const entry of entriesToDelete) writeTx.objectStore(STORE).delete(entry.key);
        const usage = await requestResult(writeTx.objectStore(USAGE_STORE).get(TOTAL_USAGE_KEY)) as MailboxUsage | undefined;
        writeTx.objectStore(USAGE_STORE).put({
          key: TOTAL_USAGE_KEY,
          bytes: Math.max(0, (usage?.bytes ?? 0) - entriesToDelete.reduce((sum, entry) => sum + entry.size, 0)),
        } satisfies MailboxUsage);
        await transactionDone(writeTx);
      }
      return {
        ok: true,
        ...(recipientInbox && acknowledgedEntries.length > 0
          ? { acknowledged: acknowledgedEntries.length }
          : {}),
        entries: entries.map(entry => ({ id: entry.id, body: entry.body })),
      };
    } catch {
      return { ok: false, error: 'mailbox_unavailable' };
    }
  }

  return { ok: false, error: 'unsupported_mailbox_operation' };
}

export async function resetPeerMailboxForTests(): Promise<void> {
  memory.clear();
  memoryBytes = 0;
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
