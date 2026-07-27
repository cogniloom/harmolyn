// Encrypted identity persistence for browser clients.
// Key derivation: Argon2id(passphrase, salt) → 32-byte AES-256-GCM key.
// Stored JSON:
//   { v:1, kdf:"argon2id", salt:<hex16>, m:<num>, t:<num>, p:<num>,
//     nonce:<hex12>, ciphertext:<base64 of AES-256-GCM(identity JSON)> }
// Identity payload: {"ed25519_priv":[...64 bytes...], "mldsa65_priv":[...4032 bytes...]}
// (JSON field names match Go oracle's `stored` struct in pkg/v0_1/nodeid/nodeid.go.)
import { argon2id } from '@noble/hashes/argon2.js';
import { gcm } from '@noble/ciphers/aes.js';
import type { XoreinIdentity } from './identity.js';
import { identityFromStored, generateIdentity } from './identity.js';

// ── Constants ──────────────────────────────────────────────────────────────

const IDB_DB_NAME = 'xorein-native';
const IDB_STORE_NAME = 'identity';
const IDB_KEY = 'local';
const STORAGE_VERSION = 1;

// Argon2id parameters: strong enough for a passphrase-derived key.
const ARGON2_M = 65536; // 64 MiB
const ARGON2_T = 3;
const ARGON2_P = 1;

// ── Encryption types ───────────────────────────────────────────────────────

interface EncryptedIdentityBlob {
  v: 1;
  kdf: 'argon2id';
  salt: string;   // hex-encoded 16-byte salt
  m: number;      // Argon2id memory (KiB)
  t: number;      // Argon2id iterations
  p: number;      // Argon2id parallelism
  nonce: string;  // hex-encoded 12-byte AES-GCM nonce
  ciphertext: string; // base64-encoded AES-256-GCM(identity JSON)
}

// ── KDF ────────────────────────────────────────────────────────────────────

function deriveKey(passphrase: string, salt: Uint8Array, m: number, t: number, p: number): Uint8Array {
  const pass = new TextEncoder().encode(passphrase);
  return argon2id(pass, salt, { m, t, p, dkLen: 32 });
}

// ── Encryption / decryption ────────────────────────────────────────────────

function toHex(b: Uint8Array): string {
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

function fromHex(s: string): Uint8Array {
  const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return b;
}

function toBase64(b: Uint8Array): string {
  return btoa(String.fromCharCode(...b));
}

function fromBase64(s: string): Uint8Array {
  return new Uint8Array([...atob(s)].map(c => c.charCodeAt(0)));
}

/** Serialize an identity to the Go-oracle-compatible stored format. */
function serializeIdentity(id: XoreinIdentity): Uint8Array {
  const payload = JSON.stringify({
    ed25519_priv: Array.from(id.edPriv),   // 64 bytes, matches Go stored.Ed25519Priv
    mldsa65_priv: Array.from(id.mldsaPriv), // 4032 bytes, matches Go stored.MLDSA65Priv
  });
  return new TextEncoder().encode(payload);
}

export interface Argon2Params { m: number; t: number; p: number }

// Reduced params for testing — never use in production.
export const ARGON2_TEST_PARAMS: Argon2Params = { m: 256, t: 1, p: 1 };

/** Encrypt an identity with Argon2id + AES-256-GCM. Returns a portable blob. */
export function encryptIdentity(
  id: XoreinIdentity,
  passphrase: string,
  argon2Params: Argon2Params = { m: ARGON2_M, t: ARGON2_T, p: ARGON2_P },
): EncryptedIdentityBlob {
  const { m, t, p } = argon2Params;
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const key = deriveKey(passphrase, salt, m, t, p);
  const plaintext = serializeIdentity(id);

  const aead = gcm(key, nonce);
  const ciphertext = aead.encrypt(plaintext);

  return { v: 1, kdf: 'argon2id', salt: toHex(salt), m, t, p, nonce: toHex(nonce), ciphertext: toBase64(ciphertext) };
}

/** Decrypt an encrypted identity blob with the given passphrase. */
export async function decryptIdentity(blob: EncryptedIdentityBlob, passphrase: string): Promise<XoreinIdentity> {
  if (blob.v !== 1 || blob.kdf !== 'argon2id') throw new Error('identity storage: unsupported format');
  const salt = fromHex(blob.salt);
  const nonce = fromHex(blob.nonce);
  const key = deriveKey(passphrase, salt, blob.m, blob.t, blob.p);
  const ciphertext = fromBase64(blob.ciphertext);

  const aead = gcm(key, nonce);
  let plaintext: Uint8Array;
  try {
    plaintext = aead.decrypt(ciphertext);
  } catch {
    throw new Error('identity storage: decryption failed (wrong passphrase?)');
  }

  const stored = JSON.parse(new TextDecoder().decode(plaintext)) as {
    ed25519_priv: number[];
    mldsa65_priv: number[];
  };
  const edPriv64 = new Uint8Array(stored.ed25519_priv);
  const mldsaPriv = new Uint8Array(stored.mldsa65_priv);
  return identityFromStored(edPriv64, mldsaPriv);
}

// ── IndexedDB persistence ──────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(IDB_STORE_NAME)) {
        db.createObjectStore(IDB_STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/** Save an encrypted identity blob to IndexedDB. */
export async function saveEncryptedIdentity(blob: EncryptedIdentityBlob): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    tx.objectStore(IDB_STORE_NAME).put(JSON.stringify(blob), IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Load an encrypted identity blob from IndexedDB, or null if not found. */
export async function loadEncryptedIdentity(): Promise<EncryptedIdentityBlob | null> {
  const db = await openDB();
  const raw = await new Promise<string | undefined>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly');
    const req = tx.objectStore(IDB_STORE_NAME).get(IDB_KEY);
    req.onsuccess = () => resolve(req.result as string | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (!raw) return null;
  return JSON.parse(raw) as EncryptedIdentityBlob;
}

/** Check if an identity is persisted in IndexedDB (no decryption needed). */
export async function hasPersistedIdentity(): Promise<boolean> {
  return (await loadEncryptedIdentity()) !== null;
}

/** Delete the persisted (registered) identity blob from IndexedDB. */
export async function clearPersistedIdentity(): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    tx.objectStore(IDB_STORE_NAME).delete(IDB_KEY);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

// ── Guest (ephemeral) identity ───────────────────────────────────────────────
// A guest has no password. Their throwaway identity is kept in module-level
// memory only — private key material is never written to any browser storage.
// The identity is regenerated on every page load, which is correct for an
// anonymous throwaway peer; callers must not assume guest peer_ids are stable
// across reloads. On promotion to a registered account, the caller invokes
// clearGuestIdentity() then saves the password-encrypted blob to IndexedDB.

// Module-level in-memory cache — never touches sessionStorage or IndexedDB.
let _guestIdentityCache: XoreinIdentity | null = null;

/** Store the guest identity in memory for the lifetime of this JS context. */
export function saveGuestIdentity(id: XoreinIdentity): void {
  _guestIdentityCache = id;
}

/** Clear the in-memory guest identity (e.g. after promotion to registered). */
export function clearGuestIdentity(): void {
  _guestIdentityCache = null;
}

/**
 * Return the current guest identity from memory, or generate and cache a fresh
 * one — yielding a new throwaway peer_id each page load.
 */
export async function loadOrCreateGuestIdentity(): Promise<XoreinIdentity> {
  if (_guestIdentityCache) return _guestIdentityCache;
  const fresh = await generateIdentity();
  saveGuestIdentity(fresh);
  return fresh;
}

// ── Identity Vault (multi-identity storage) ────────────────────────────────
// A separate IndexedDB ('xorein-vault') stores multiple named identities so
// the user can switch between them without losing any. The currently active
// identity is always in the main 'xorein-native' DB under key 'local'.

const VAULT_DB_NAME = 'xorein-vault';
const VAULT_STORE_NAME = 'vault';

export interface VaultEntry {
  peerId: string;
  displayName: string;
  createdAt: string;
  blob: EncryptedIdentityBlob;
}

function openVaultDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(VAULT_DB_NAME, 1);
    req.onupgradeneeded = (e) => {
      const db = (e.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(VAULT_STORE_NAME)) {
        db.createObjectStore(VAULT_STORE_NAME, { keyPath: 'peerId' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function listVaultIdentities(): Promise<VaultEntry[]> {
  const db = await openVaultDB();
  const entries = await new Promise<VaultEntry[]>((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readonly');
    const req = tx.objectStore(VAULT_STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as VaultEntry[]);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return entries;
}

export async function saveToVault(entry: VaultEntry): Promise<void> {
  const db = await openVaultDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readwrite');
    tx.objectStore(VAULT_STORE_NAME).put(entry);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

export async function removeFromVault(peerId: string): Promise<void> {
  const db = await openVaultDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readwrite');
    tx.objectStore(VAULT_STORE_NAME).delete(peerId);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

/** Copy a vault entry to the active identity slot ('local'). Caller must reload after. */
export async function activateFromVault(peerId: string): Promise<void> {
  const db = await openVaultDB();
  const entry = await new Promise<VaultEntry | undefined>((resolve, reject) => {
    const tx = db.transaction(VAULT_STORE_NAME, 'readonly');
    const req = tx.objectStore(VAULT_STORE_NAME).get(peerId);
    req.onsuccess = () => resolve(req.result as VaultEntry | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  if (!entry) throw new Error(`identity vault: no entry for ${peerId}`);
  await saveEncryptedIdentity(entry.blob);
}

/** Save the currently active registered identity to the vault. */
export async function saveCurrentToVault(peerId: string, displayName: string): Promise<void> {
  const blob = await loadEncryptedIdentity();
  if (!blob) throw new Error('No active registered identity to save to vault.');
  await saveToVault({ peerId, displayName, createdAt: new Date().toISOString(), blob });
}

/** Import an external encrypted backup blob into the vault after verifying the passphrase. */
export async function importToVault(blobJson: string, passphrase: string): Promise<VaultEntry> {
  const parsed = JSON.parse(blobJson) as EncryptedIdentityBlob;
  const identity = await decryptIdentity(parsed, passphrase);
  const entry: VaultEntry = {
    peerId: identity.peerId,
    displayName: '',
    createdAt: new Date().toISOString(),
    blob: parsed,
  };
  await saveToVault(entry);
  return entry;
}

// ── Session unlock (remember-me) ──────────────────────────────────────────
// After a successful passphrase unlock we re-encrypt the decrypted identity under
// a NON-EXTRACTABLE WebCrypto AES-GCM key and store both the ciphertext and the
// CryptoKey handle in IndexedDB. localStorage holds only an expiry timestamp — no
// key material. The wrapping key's raw bytes are never exposed to JS (the browser
// keeps them opaque), so an attacker with disk/localStorage/IDB-dump access cannot
// recover the identity without executing in the page's origin. On subsequent loads
// we skip the expensive Argon2 KDF.

const SESSION_KEY_LS_KEY = 'harmolyn:session-unlock';
const SESSION_BLOB_IDB_KEY = 'session';
const SESSION_WRAPKEY_IDB_KEY = 'session-wrapkey';
export const SESSION_TTL_MS = 5 * 24 * 60 * 60 * 1000;

interface SessionEntry {
  expiresAt: number; // ms timestamp — the ONLY thing in localStorage (no key bytes)
}

interface SessionBlob {
  nonce: string;      // hex 12 bytes
  ciphertext: string; // base64 AES-256-GCM(identity JSON) under the non-extractable key
}

/** Returns true if a non-expired session entry exists in localStorage. Synchronous. */
export function hasValidSession(): boolean {
  try {
    if (typeof localStorage === 'undefined') return false;
    const raw = localStorage.getItem(SESSION_KEY_LS_KEY);
    if (!raw) return false;
    const entry = JSON.parse(raw) as SessionEntry;
    return typeof entry.expiresAt === 'number' && entry.expiresAt > Date.now();
  } catch {
    return false;
  }
}

async function idbPut(key: string, value: unknown): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    tx.objectStore(IDB_STORE_NAME).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function idbGet<T>(key: string): Promise<T | undefined> {
  const db = await openDB();
  const result = await new Promise<T | undefined>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readonly');
    const req = tx.objectStore(IDB_STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
  db.close();
  return result;
}

async function idbDelete(key: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(IDB_STORE_NAME, 'readwrite');
    tx.objectStore(IDB_STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}

async function saveSessionBlob(blob: SessionBlob): Promise<void> {
  await idbPut(SESSION_BLOB_IDB_KEY, JSON.stringify(blob));
}

async function loadSessionBlob(): Promise<SessionBlob | null> {
  const raw = await idbGet<string>(SESSION_BLOB_IDB_KEY);
  return raw ? (JSON.parse(raw) as SessionBlob) : null;
}

/**
 * Get (or lazily create) the non-extractable AES-GCM wrapping key, persisted as a
 * CryptoKey handle in IndexedDB. `extractable: false` means its raw bytes can never
 * be read back out — this is the whole point: the remember-me secret is not a value
 * an attacker can copy off disk.
 */
async function getOrCreateSessionWrapKey(): Promise<CryptoKey> {
  const existing = await idbGet<CryptoKey>(SESSION_WRAPKEY_IDB_KEY);
  if (existing) return existing;
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await idbPut(SESSION_WRAPKEY_IDB_KEY, key);
  return key;
}

/**
 * Re-encrypt the identity under the non-extractable wrapping key and persist for
 * SESSION_TTL_MS. localStorage stores only the expiry — never key material.
 */
export async function saveSessionIdentity(id: XoreinIdentity): Promise<void> {
  const wrapKey = await getOrCreateSessionWrapKey();
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = serializeIdentity(id);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, wrapKey, plaintext as BufferSource),
  );
  await saveSessionBlob({ nonce: toHex(nonce), ciphertext: toBase64(ciphertext) });
  const entry: SessionEntry = { expiresAt: Date.now() + SESSION_TTL_MS };
  localStorage.setItem(SESSION_KEY_LS_KEY, JSON.stringify(entry));
}

/**
 * Attempt to load the session identity. Refreshes the TTL on success.
 * Returns null and clears the session on expiry or any error.
 */
export async function loadSessionIdentity(): Promise<XoreinIdentity | null> {
  try {
    if (typeof localStorage === 'undefined') return null;
    const raw = localStorage.getItem(SESSION_KEY_LS_KEY);
    if (!raw) return null;
    const entry = JSON.parse(raw) as SessionEntry;
    if (entry.expiresAt <= Date.now()) { clearSessionIdentity(); return null; }
    const [blob, wrapKey] = await Promise.all([loadSessionBlob(), idbGet<CryptoKey>(SESSION_WRAPKEY_IDB_KEY)]);
    if (!blob || !wrapKey) { clearSessionIdentity(); return null; }
    const plaintext = new Uint8Array(
      await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromHex(blob.nonce) as BufferSource }, wrapKey, fromBase64(blob.ciphertext) as BufferSource),
    );
    const stored = JSON.parse(new TextDecoder().decode(plaintext)) as {
      ed25519_priv: number[];
      mldsa65_priv: number[];
    };
    // Refresh TTL on each successful load so active users stay logged in.
    entry.expiresAt = Date.now() + SESSION_TTL_MS;
    localStorage.setItem(SESSION_KEY_LS_KEY, JSON.stringify(entry));
    return identityFromStored(new Uint8Array(stored.ed25519_priv), new Uint8Array(stored.mldsa65_priv));
  } catch {
    clearSessionIdentity();
    return null;
  }
}

/** Remove the session expiry, encrypted blob, and non-extractable wrapping key. */
export function clearSessionIdentity(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(SESSION_KEY_LS_KEY);
  } catch { /* best effort */ }
  void idbDelete(SESSION_BLOB_IDB_KEY).catch(() => {});
  void idbDelete(SESSION_WRAPKEY_IDB_KEY).catch(() => {});
}

// ── High-level API ─────────────────────────────────────────────────────────

export { STORAGE_VERSION };
