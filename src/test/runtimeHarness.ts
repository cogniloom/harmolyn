import type { XoreinRuntimeSnapshot, XoreinSessionSnapshot } from "@/types";

/**
 * Injects/clears the xorein runtime + session snapshots that src/data.ts and
 * src/lib/xoreinControl.ts read from window globals and localStorage. Key lists
 * mirror those modules; keep them in sync.
 *
 * Note: src/data.ts captures module-level constants (SERVERS, MOCK_MESSAGES, …)
 * at import time, but readShellRuntimeData()/subscribeShellRuntimeData()
 * recompute whenever the injected signature changes. So tests of the dynamic
 * path can inject then call readShellRuntimeData(); tests of the import-time
 * constants must inject first, then vi.resetModules() + dynamic import.
 */
const RUNTIME_GLOBAL_KEYS = [
  "__HARMOLYN_XOREIN_RUNTIME__",
  "__HARMOLYN_RUNTIME_SNAPSHOT__",
  "__XOREIN_RUNTIME_SNAPSHOT__",
] as const;
const SESSION_GLOBAL_KEYS = [
  "__HARMOLYN_XOREIN_SESSION__",
  "__HARMOLYN_SESSION_SNAPSHOT__",
  "__XOREIN_SESSION_SNAPSHOT__",
] as const;
const RUNTIME_STORAGE_KEYS = [
  "harmolyn:xorein:runtime",
  "harmolyn:runtime-snapshot",
  "xorein:runtime-snapshot",
] as const;
const SESSION_STORAGE_KEYS = [
  "harmolyn:xorein:session",
  "harmolyn:session-snapshot",
  "xorein:session-snapshot",
] as const;
const CONTROL_TOKEN_GLOBAL_KEYS = [
  "__HARMOLYN_XOREIN_CONTROL_TOKEN__",
  "__XOREIN_CONTROL_TOKEN__",
] as const;
const CONTROL_TOKEN_STORAGE_KEY = "harmolyn:xorein:control-token";

function windowRecord(): Record<string, unknown> {
  return window as unknown as Record<string, unknown>;
}

function setGlobals(keys: readonly string[], value: unknown): void {
  const w = windowRecord();
  for (const key of keys) {
    w[key] = value;
  }
}

function setStorage(keys: readonly string[], value: unknown): void {
  const serialized = JSON.stringify(value);
  for (const key of keys) {
    window.localStorage.setItem(key, serialized);
  }
}

function clearKeys(globalKeys: readonly string[], storageKeys: readonly string[]): void {
  const w = windowRecord();
  for (const key of globalKeys) {
    delete w[key];
  }
  for (const key of storageKeys) {
    window.localStorage.removeItem(key);
  }
}

export function injectRuntimeSnapshot(snapshot: XoreinRuntimeSnapshot): void {
  setGlobals(RUNTIME_GLOBAL_KEYS, snapshot);
  setStorage(RUNTIME_STORAGE_KEYS, snapshot);
}

export function injectSessionSnapshot(session: XoreinSessionSnapshot): void {
  setGlobals(SESSION_GLOBAL_KEYS, session);
  setStorage(SESSION_STORAGE_KEYS, session);
}

export function injectControlToken(token: string): void {
  setGlobals(CONTROL_TOKEN_GLOBAL_KEYS, token);
  window.localStorage.setItem(CONTROL_TOKEN_STORAGE_KEY, token);
}

export function clearRuntime(): void {
  clearKeys(RUNTIME_GLOBAL_KEYS, RUNTIME_STORAGE_KEYS);
  clearKeys(SESSION_GLOBAL_KEYS, SESSION_STORAGE_KEYS);
  clearKeys(CONTROL_TOKEN_GLOBAL_KEYS, [CONTROL_TOKEN_STORAGE_KEY]);
}
