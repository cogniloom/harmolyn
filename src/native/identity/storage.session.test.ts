// The remember-me capability is intentionally disabled. Browser IndexedDB can
// persist CryptoKey bytes, so a copied profile must never be enough to recover
// an identity without its password.
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
} from './storage';

installFakeIndexedDB();

const SESSION_LS_KEY = 'harmolyn:session-unlock';
const REMEMBER_ME_LS_KEY = 'harmolyn:remember-me';

beforeEach(() => {
  resetFakeIndexedDB();
  localStorage.clear();
  sessionStorage.clear();
});

describe('remember-me disabled', () => {
  it('always reports disabled and removes stale preference state', () => {
    localStorage.setItem(REMEMBER_ME_LS_KEY, '1');

    expect(isRememberMeEnabled()).toBe(false);
    expect(localStorage.getItem(REMEMBER_ME_LS_KEY)).toBeNull();
  });

  it('cannot be enabled through the compatibility setter', () => {
    setRememberMeEnabled(true);

    expect(isRememberMeEnabled()).toBe(false);
    expect(hasValidSession()).toBe(false);
    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
  });

  it('activates in-memory chat encryption but never persists an unlock session', async () => {
    const id = await generateIdentity();

    await saveSessionIdentity(id);

    expect(hasValidSession()).toBe(false);
    expect(await loadSessionIdentity()).toBeNull();
    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
  });

  it('clears legacy localStorage and IndexedDB session artifacts', async () => {
    localStorage.setItem(SESSION_LS_KEY, JSON.stringify({ expiresAt: Date.now() + 60_000 }));
    setRememberMeEnabled(false);

    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
    expect(hasValidSession()).toBe(false);
    await loadSessionIdentity();
    clearSessionIdentity();
    expect(localStorage.getItem(SESSION_LS_KEY)).toBeNull();
  });
});
