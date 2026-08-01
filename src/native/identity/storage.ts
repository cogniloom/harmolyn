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
import { deriveKey as hkdfDeriveKey } from '../seal/kdf.js';
import { configureChatScopePersistence } from '../../protocol/client.js';

// ── Constants ──────────────────────────────────────────────────────────────

const IDB_DB_NAME = 'xorein-native';
const IDB_STORE_NAME = 'identity';
const IDB_KEY = 'local';
const STORAGE_VERSION = 1;

// Argon2id parameters: strong enough for a passphrase-derived key.
const ARGON2_M = 65536; // 64 MiB
const ARGON2_T = 3;
const ARGON2_P = 1;
const ARGON2_MIN_M = 256; // Keep the explicit reduced test profile valid.
const ARGON2_MAX_M = 128 * 1024; // Never let imported data request unbounded RAM.
const ARGON2_MAX_T = 10;
const ARGON2_MAX_P = 4;
const MAX_IDENTITY_CIPHERTEXT_BYTES = 512 * 1024;
export const MAX_IDENTITY_BACKUP_BYTES = 8 * 1024 * 1024;
const AES_GCM_TAG_BYTES = 16;

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
	if (typeof s !== 'string' || s.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(s)) {
		throw new Error('identity storage: invalid hexadecimal value');
	}
	const b = new Uint8Array(s.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return b;
}

function toBase64(b: Uint8Array): string {
	let binary = '';
	for (let offset = 0; offset < b.length; offset += 0x8000) {
		binary += String.fromCharCode(...b.subarray(offset, offset + 0x8000));
	}
	return btoa(binary);
}

function fromBase64(s: string): Uint8Array {
	if (typeof s !== 'string' || s.length > 4 * Math.ceil(MAX_IDENTITY_CIPHERTEXT_BYTES / 3) + 4
		|| s.length % 4 === 1 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(s)) {
		throw new Error('identity storage: invalid base64 value');
	}
	const decoded = atob(s);
	return Uint8Array.from(decoded, c => c.charCodeAt(0));
}

function validateArgon2Params(params: Argon2Params): void {
	if (!Number.isSafeInteger(params.m) || params.m < ARGON2_MIN_M || params.m > ARGON2_MAX_M
		|| !Number.isSafeInteger(params.t) || params.t < 1 || params.t > ARGON2_MAX_T
		|| !Number.isSafeInteger(params.p) || params.p < 1 || params.p > ARGON2_MAX_P
		|| params.m < 8 * params.p) {
		throw new Error('identity storage: invalid KDF parameters');
	}
}

function isByteArray(value: unknown, length: number): value is number[] {
	return Array.isArray(value) && value.length === length
		&& value.every(byte => Number.isSafeInteger(byte) && byte >= 0 && byte <= 255);
}

function parseStoredIdentity(plaintext: Uint8Array): { ed25519_priv: number[]; mldsa65_priv: number[] } {
	if (plaintext.length > MAX_IDENTITY_CIPHERTEXT_BYTES) {
		throw new Error('identity storage: identity payload is too large');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(plaintext));
	} catch {
		throw new Error('identity storage: invalid identity payload');
	}
	if (typeof parsed !== 'object' || parsed === null) {
		throw new Error('identity storage: invalid identity payload');
	}
	const stored = parsed as Record<string, unknown>;
	if (!isByteArray(stored.ed25519_priv, 64) || !isByteArray(stored.mldsa65_priv, 4032)) {
		throw new Error('identity storage: invalid identity key material');
	}
	return {
		ed25519_priv: stored.ed25519_priv,
		mldsa65_priv: stored.mldsa65_priv,
	};
}

function validateEncryptedIdentityBlob(blob: unknown): asserts blob is EncryptedIdentityBlob {
	if (typeof blob !== 'object' || blob === null) {
		throw new Error('identity storage: invalid format');
	}
	const candidate = blob as Record<string, unknown>;
	if (candidate.v !== STORAGE_VERSION || candidate.kdf !== 'argon2id'
		|| typeof candidate.salt !== 'string' || candidate.salt.length !== 32
		|| typeof candidate.nonce !== 'string' || candidate.nonce.length !== 24
		|| typeof candidate.ciphertext !== 'string') {
		throw new Error('identity storage: unsupported format');
	}
	const salt = fromHex(candidate.salt);
	const nonce = fromHex(candidate.nonce);
	if (salt.length !== 16 || nonce.length !== 12) {
		throw new Error('identity storage: invalid nonce or salt');
	}
	if (typeof candidate.m !== 'number' || typeof candidate.t !== 'number' || typeof candidate.p !== 'number') {
		throw new Error('identity storage: invalid KDF parameters');
	}
	validateArgon2Params({ m: candidate.m, t: candidate.t, p: candidate.p });
	const ciphertext = fromBase64(candidate.ciphertext);
	if (ciphertext.length < AES_GCM_TAG_BYTES || ciphertext.length > MAX_IDENTITY_CIPHERTEXT_BYTES) {
		throw new Error('identity storage: ciphertext size is invalid');
	}
}

/** Serialize an identity to the Go-oracle-compatible stored format. */
function serializeIdentity(id: XoreinIdentity): Uint8Array {
  const payload = JSON.stringify({
    ed25519_priv: Array.from(id.edPriv),   // 64 bytes, matches Go stored.Ed25519Priv
    mldsa65_priv: Array.from(id.mldsaPriv), // 4032 bytes, matches Go stored.MLDSA65Priv
  });
  return new TextEncoder().encode(payload);
}

// ── Chat-scope persistence activation ──────────────────────────────────────
// Chat-scope state (ChatArea's persisted copy of decrypted messages, thread
// replies, nicknames) is persisted by src/protocol/client.ts. It must never be
// stored in plaintext, so whenever an identity becomes the ACTIVE identity we
// hand the protocol layer an at-rest cipher config derived from that identity:
//   • registered → AES-256-GCM key from the identity seed, namespaced by peer id;
//   • guest      → ephemeral (memory-only; guests leave no chat data behind).
// Every path that resolves the active identity funnels through this module, so
// hooking here covers all engine bootstrap modes.

const CHAT_SCOPE_KEY_LABEL = 'xorein/chat-scope/v1/at-rest';

function activateChatScopePersistence(id: XoreinIdentity, opts: { ephemeral: boolean }): void {
  try {
    if (opts.ephemeral) {
      configureChatScopePersistence({ ephemeral: true });
    } else {
      configureChatScopePersistence({
        key: hkdfDeriveKey(id.edSeed, null, CHAT_SCOPE_KEY_LABEL, 32),
        namespace: id.peerId,
      });
    }
  } catch {
    // Persistence is best-effort and fails closed (memory-only) — never block
    // identity resolution on it.
  }
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
	validateArgon2Params(argon2Params);
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
	validateEncryptedIdentityBlob(blob);
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

	const stored = parseStoredIdentity(plaintext);
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
	validateEncryptedIdentityBlob(blob);
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
	try {
		const parsed: unknown = JSON.parse(raw);
		validateEncryptedIdentityBlob(parsed);
		return parsed;
	} catch {
		return null;
	}
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
  // Guests get memory-only chat-scope persistence: no plaintext (or even
  // ciphertext) chat state may outlive the throwaway session.
  activateChatScopePersistence(id, { ephemeral: true });
}

/** Clear the in-memory guest identity (e.g. after promotion to registered). */
export function clearGuestIdentity(): void {
  _guestIdentityCache = null;
}

/**
 * Whether the ACTIVE identity in this JS context is a throwaway guest. Used by
 * persistence layers (e.g. the runtime-snapshot mirror) to keep guest data out
 * of durable localStorage.
 */
export function isGuestIdentityActive(): boolean {
  return _guestIdentityCache !== null;
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
	validateEncryptedIdentityBlob(entry.blob);
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
	if (typeof blobJson !== 'string' || new TextEncoder().encode(blobJson).length > MAX_IDENTITY_BACKUP_BYTES) {
		throw new Error('identity storage: backup is too large');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(blobJson);
	} catch {
		throw new Error('identity storage: invalid backup JSON');
	}
	validateEncryptedIdentityBlob(parsed);
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

// ── Session unlock (disabled) ─────────────────────────────────────────────
// A previous implementation stored an AES wrapping key handle and ciphertext
// in IndexedDB. Browser profiles can serialize the raw CryptoKey bytes, so a
// disk reader could recover the identity seed without the password. That
// violates the local at-rest boundary: this module now deliberately refuses
// all remember-me sessions and deletes artifacts created by older builds.

const SESSION_KEY_LS_KEY = 'harmolyn:session-unlock';
const SESSION_BLOB_IDB_KEY = 'session';
const SESSION_WRAPKEY_IDB_KEY = 'session-wrapkey';
const REMEMBER_ME_LS_KEY = 'harmolyn:remember-me';
/**
 * Remember-me is permanently disabled. Kept as a compatibility export so old
 * callers cannot accidentally re-enable an unsafe storage path.
 */
export function isRememberMeEnabled(): boolean {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(REMEMBER_ME_LS_KEY);
  } catch {
    // Storage may be unavailable in private/SSR contexts.
  }
  return false;
}

/**
 * Compatibility no-op: all choices are treated as disabled and any legacy
 * persisted session is destroyed immediately.
 */
export function setRememberMeEnabled(_enabled: boolean): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(REMEMBER_ME_LS_KEY);
  } catch { /* best effort */ }
  clearSessionIdentity();
}

/** Always false: identity keys must not be recoverable from disk without a password. */
export function hasValidSession(): boolean {
  clearSessionIdentity();
  return false;
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

/** Activate encrypted chat-scope persistence for the current in-memory identity. */
export function configureIdentityChatScopePersistence(id: XoreinIdentity): void {
  activateChatScopePersistence(id, { ephemeral: false });
}

/**
 * Compatibility shim for older callers. It never stores an unlock session;
 * it only activates encrypted chat-scope persistence for the live identity.
 */
export async function saveSessionIdentity(id: XoreinIdentity): Promise<void> {
  configureIdentityChatScopePersistence(id);
  clearSessionIdentity();
}

/**
 * Session restore is permanently disabled. Remove any legacy artifacts and
 * require the caller to provide the password to recover the identity.
 */
export async function loadSessionIdentity(): Promise<XoreinIdentity | null> {
  clearSessionIdentity();
  return null;
}

/** Remove the session expiry, encrypted blob, and non-extractable wrapping key. */
export function clearSessionIdentity(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.removeItem(SESSION_KEY_LS_KEY);
  } catch { /* best effort */ }
  void idbDelete(SESSION_BLOB_IDB_KEY).catch(() => {});
  void idbDelete(SESSION_WRAPKEY_IDB_KEY).catch(() => {});
}

// Upgrade hygiene: remove session artifacts left by versions that offered the
// unsafe remember-me feature, even before the engine reaches its first boot.
void clearSessionIdentity();

// ── High-level API ─────────────────────────────────────────────────────────

export { STORAGE_VERSION };
