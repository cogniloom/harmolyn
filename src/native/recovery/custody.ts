// Social-recovery custody store.
//
// Two responsibilities:
//  1) As a GUARDIAN: durably hold the *password-encrypted* identity blobs that
//     friends have entrusted to me. The blob is opaque ciphertext — I cannot read
//     their identity without their password. Stored in IndexedDB `xorein-recovery`.
//  2) As an OWNER: remember which friends I picked as my recovery contacts (so the
//     UI can show status and re-sync). Stored in localStorage.
//
// See docs / memory: friend-held recovery, password is the only secret.

const DB_NAME = 'xorein-recovery';
const STORE = 'custody';
const CONTACTS_KEY = 'harmolyn:recovery:contacts';
const MAX_CUSTODY_ENTRIES = 100;
const MAX_PEER_ID_BYTES = 256;
const MAX_DISPLAY_NAME_BYTES = 256;
const MAX_CUSTODY_BLOB_BYTES = 1 * 1024 * 1024;
const MAX_CUSTODY_STATE_BYTES = 4 * 1024 * 1024;

function hasControlCharacters(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A backup a friend (owner) entrusted to us (the guardian). Ciphertext only. */
export interface CustodyEntry {
  ownerPeerId: string;
  ownerDisplayName: string;
  /** The owner's password-encrypted identity blob (opaque to us). */
  blob: unknown;
  /** The owner's identity-key-encrypted account state (servers/DMs/profile; opaque to us). */
  state?: unknown;
  receivedAt: string;
}

function validPeerId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_PEER_ID_BYTES
    && !hasControlCharacters(value);
}

function boundedJsonObject(value: unknown, maxBytes: number): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  try {
    return JSON.stringify(value).length <= maxBytes;
  } catch {
    return false;
  }
}

function validCustodyEntry(value: unknown): value is CustodyEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Partial<CustodyEntry>;
  return validPeerId(entry.ownerPeerId)
    && (typeof entry.ownerDisplayName === 'string' && entry.ownerDisplayName.length <= MAX_DISPLAY_NAME_BYTES)
    && boundedJsonObject(entry.blob, MAX_CUSTODY_BLOB_BYTES)
    && (entry.state === undefined || boundedJsonObject(entry.state, MAX_CUSTODY_STATE_BYTES))
    && typeof entry.receivedAt === 'string' && entry.receivedAt.length <= 64;
}

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'ownerPeerId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function storeCustody(entry: CustodyEntry): Promise<void> {
  if (!validCustodyEntry(entry)) throw new Error('recovery: invalid custody entry');
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function getCustody(ownerPeerId: string): Promise<CustodyEntry | null> {
  const db = await openDB();
  const entry = await new Promise<CustodyEntry | undefined>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).get(ownerPeerId);
    req.onsuccess = () => resolve(req.result as CustodyEntry | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return entry && validCustodyEntry(entry) ? entry : null;
}

export async function listCustody(): Promise<CustodyEntry[]> {
  const db = await openDB();
  const entries = await new Promise<CustodyEntry[]>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result as CustodyEntry[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return entries.filter(validCustodyEntry).slice(0, MAX_CUSTODY_ENTRIES);
}

export async function removeCustody(ownerPeerId: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(ownerPeerId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// ── My recovery contacts (owner side) ────────────────────────────────────────

export function getRecoveryContacts(): string[] {
  try {
    const raw = localStorage.getItem(CONTACTS_KEY);
    const parsed = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(parsed)
      ? Array.from(new Set(parsed.filter(validPeerId))).slice(0, MAX_CUSTODY_ENTRIES)
      : [];
  } catch {
    return [];
  }
}

export function setRecoveryContacts(peerIds: string[]): void {
  try {
    const safe = Array.from(new Set(peerIds.filter(validPeerId))).slice(0, MAX_CUSTODY_ENTRIES);
    localStorage.setItem(CONTACTS_KEY, JSON.stringify(safe));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}
