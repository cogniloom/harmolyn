// Session-unlock ("remember me") persistence: the OPT-IN mechanism that keeps a
// registered user signed in across reloads without re-entering the password.
//
// SECURITY CONTRACT under test (finding: remember-me defeats at-rest password
// protection — identity keys recoverable from disk without the password):
//   1. Remember-me is opt-in and DEFAULT OFF: without setRememberMeEnabled(true),
//      saveSessionIdentity persists nothing and the password is always required.
//   2. The session lifetime is HARD-CAPPED from the initial password unlock:
//      the sliding TTL refresh can never extend a session past
//      createdAt + SESSION_MAX_LIFETIME_MS (no indefinitely-refreshed session).
//   3. Disabling remember-me destroys any previously-persisted session.
//   4. Legacy session entries (no createdAt hard-cap clock, incl. the pre-A5
//      raw-key format) are cleared, never migrated.
import { describe, it, expect, beforeEach } from 'vitest';
import { installFakeIndexedDB, resetFakeIndexedDB } from './fakeIndexedDB.testutil';
import { generateIdentity } from './identity';
import {
  saveSessionIdentity,
  loadSessionIdentity,
  hasValidSession,
  clearSessionIdentity,
  isRememberMeEnabled,
  setRememberMeEnabled,
  SESSION_TTL_MS,
  SESSION_MAX_LIFETIME_MS,
} from './storage';

installFakeIndexedDB();

const SESSION_LS_KEY = 'harmolyn:session-unlock';

interface StoredEntry { expiresAt: number; createdAt: number }

function readEntry(): StoredEntry {
  return JSON.parse(localStorage.getItem(SESSION_LS_KEY) ?? '{}') as StoredEntry;
}

function writeEntry(entry: Partial<StoredEntry> | Record<string, unknown>): void {
  localStorage.setItem(SESSION_LS_KEY, JSON.stringify(entry));
}

beforeEach(() => {
  resetFakeIndexedDB();
  localStorage.clear();
  sessionStorage.clear();
});

describe('remember-me opt-in (default OFF)', () => {
  it('is disabled by default', () => {
    expect(isRememberMeEnabled()).toBe(false);
  });

  it('saveSessionIdentity persists NOTHING without the opt-in — password stays required', async () => {
    const id = await generateIdentity();

    await saveSessionIdentity(id);

    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
    expect(hasValidSession()).toBe(false);
    expect(await loadSessionIdentity()).toBeNull();
  });

  it('disabling remember-me destroys an existing persisted session', async () => {
    const id = await generateIdentity();
    setRememberMeEnabled(true);
    await saveSessionIdentity(id);
    expect(hasValidSession()).toBe(true);

    setRememberMeEnabled(false);

    expect(isRememberMeEnabled()).toBe(false);
    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
    expect(hasValidSession()).toBe(false);
    expect(await loadSessionIdentity()).toBeNull();
  });

  it('a session left behind while the preference is off is cleared on load, not used', async () => {
    const id = await generateIdentity();
    setRememberMeEnabled(true);
    await saveSessionIdentity(id);
    // Simulate the preference being dropped without the session cleanup.
    localStorage.removeItem('harmolyn:remember-me');

    expect(hasValidSession()).toBe(false);
    expect(await loadSessionIdentity()).toBeNull();
    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
  });
});

describe('session unlock persistence (opted in)', () => {
  beforeEach(() => {
    setRememberMeEnabled(true);
  });

  it('round-trips: a saved session restores the identity without a passphrase', async () => {
    const id = await generateIdentity();
    expect(hasValidSession()).toBe(false);

    await saveSessionIdentity(id);

    expect(hasValidSession()).toBe(true);
    const restored = await loadSessionIdentity();
    expect(restored).not.toBeNull();
    expect(restored?.peerId).toBe(id.peerId);
    expect(Array.from(restored?.edSeed ?? [])).toEqual(Array.from(id.edSeed));
  });

  it('stores only expiry + hard-cap timestamps in localStorage — never key material', async () => {
    const id = await generateIdentity();
    await saveSessionIdentity(id);
    const entry = JSON.parse(localStorage.getItem(SESSION_LS_KEY) ?? '{}') as Record<string, unknown>;
    expect(Object.keys(entry).sort()).toEqual(['createdAt', 'expiresAt']);
    expect(typeof entry.expiresAt).toBe('number');
    expect(typeof entry.createdAt).toBe('number');
    expect(entry.expiresAt as number).toBeGreaterThan(Date.now());
  });

  it('rejects and clears an expired session', async () => {
    const id = await generateIdentity();
    await saveSessionIdentity(id);
    const entry = readEntry();
    entry.expiresAt = Date.now() - 1_000;
    writeEntry(entry);

    expect(hasValidSession()).toBe(false);
    expect(await loadSessionIdentity()).toBeNull();
    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
  });

  it('clearSessionIdentity invalidates the session', async () => {
    const id = await generateIdentity();
    await saveSessionIdentity(id);
    expect(hasValidSession()).toBe(true);

    clearSessionIdentity();

    expect(hasValidSession()).toBe(false);
    expect(await loadSessionIdentity()).toBeNull();
  });

  it('refreshes the TTL on load while inside the hard cap (active users stay signed in)', async () => {
    const id = await generateIdentity();
    await saveSessionIdentity(id);
    // Age the entry to nearly-expired, then load: the TTL must be pushed out.
    const aged = readEntry();
    aged.expiresAt = Date.now() + 60_000;
    writeEntry(aged);

    expect((await loadSessionIdentity())?.peerId).toBe(id.peerId);

    const refreshed = readEntry();
    expect(refreshed.expiresAt).toBeGreaterThan(Date.now() + 60_000);
  });
});

describe('hard lifetime cap from the initial password unlock', () => {
  beforeEach(() => {
    setRememberMeEnabled(true);
  });

  it('the TTL refresh never extends a session past createdAt + SESSION_MAX_LIFETIME_MS', async () => {
    const id = await generateIdentity();
    await saveSessionIdentity(id);
    // Initial unlock was almost a full lifetime ago; only one hour of cap remains.
    const now = Date.now();
    const createdAt = now - (SESSION_MAX_LIFETIME_MS - 60 * 60 * 1000);
    writeEntry({ createdAt, expiresAt: now + 60_000 });

    expect((await loadSessionIdentity())?.peerId).toBe(id.peerId);

    const refreshed = readEntry();
    // Without the cap, a naive refresh would set expiresAt ≈ now + SESSION_TTL_MS
    // (5 days) — far beyond the one hour of remaining lifetime.
    expect(refreshed.expiresAt).toBeLessThanOrEqual(createdAt + SESSION_MAX_LIFETIME_MS);
    expect(refreshed.expiresAt).toBeLessThan(now + SESSION_TTL_MS);
    expect(refreshed.createdAt).toBe(createdAt);
  });

  it('rejects and clears a session whose hard cap has passed, even with a future expiresAt', async () => {
    const id = await generateIdentity();
    await saveSessionIdentity(id);
    const now = Date.now();
    // A (tampered or refresh-artifact) entry: expiry in the future but the
    // initial unlock is older than the maximum lifetime.
    writeEntry({ createdAt: now - SESSION_MAX_LIFETIME_MS - 1_000, expiresAt: now + 60_000 });

    expect(hasValidSession()).toBe(false);
    expect(await loadSessionIdentity()).toBeNull();
    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
  });

  it('clears legacy entries without the createdAt hard-cap clock (incl. pre-A5 raw-key sessions)', async () => {
    const id = await generateIdentity();
    await saveSessionIdentity(id);
    // Legacy formats: no createdAt; the oldest also carried a raw AES key.
    writeEntry({ expiresAt: Date.now() + 60_000, key: 'deadbeef'.repeat(8) });

    expect(hasValidSession()).toBe(false);
    expect(await loadSessionIdentity()).toBeNull();
    // The raw key material must be gone from localStorage.
    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
  });
});
