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
  return entry ?? null;
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
  return entries;
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
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

export function setRecoveryContacts(peerIds: string[]): void {
  try {
    localStorage.setItem(CONTACTS_KEY, JSON.stringify(Array.from(new Set(peerIds))));
  } catch {
    /* storage full / unavailable — non-fatal */
  }
}
