// Publishes the native state as a XoreinRuntimeSnapshot to the global keys
// and localStorage keys that data.ts reads every 1s.
//
// Writing to these well-known locations (matching xoreinControl.ts publishSnapshot)
// means the UI's data path (data.ts → createShellRuntimeData) is unchanged.
import { toRuntimeSnapshot } from './store.js';

// Keys from src/data.ts / src/lib/xoreinControl.ts
const RUNTIME_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_RUNTIME__',
  '__HARMOLYN_RUNTIME_SNAPSHOT__',
  '__XOREIN_RUNTIME_SNAPSHOT__',
] as const;

const RUNTIME_STORAGE_KEYS = [
  'harmolyn:xorein:runtime',
  'harmolyn:runtime-snapshot',
  'xorein:runtime-snapshot',
] as const;

export function publishNativeSnapshot(): void {
  if (typeof window === 'undefined') return;

  const snapshot = toRuntimeSnapshot();

  for (const key of RUNTIME_GLOBAL_KEYS) {
    // In-memory global for the UI — full snapshot (reports drive the moderation UI).
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any)[key] = snapshot;
  }

  // localStorage is PLAINTEXT — separate from, and NOT protected by, the AES-GCM
  // native-state blob. Anyone who can read the browser profile can read these keys
  // without the account password or state key, so the persisted mirror must carry NO
  // decrypted communication content. Strip every user-content collection: message
  // bodies, DM threads, the social graph, and abuse reports. The full snapshot stays
  // in the in-memory global above (which readInjectedValue prefers whenever the engine
  // is live); the persisted mirror is only the pre-unlock bootstrap paint, which must
  // be empty of chat history until the encrypted store is decrypted on reload.
  const persisted = JSON.stringify({
    ...snapshot,
    messages: [],
    dms: [],
    friends: [],
    friend_requests: [],
    reports: [],
  });
  for (const key of RUNTIME_STORAGE_KEYS) {
    try { localStorage.setItem(key, persisted); } catch { /* best effort */ }
  }

  // Signal the React polling loop (same events as xoreinControl.ts publishSnapshot).
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
}
