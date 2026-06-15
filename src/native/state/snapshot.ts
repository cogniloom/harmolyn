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
  const serialized = JSON.stringify(snapshot);

  for (const key of RUNTIME_GLOBAL_KEYS) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (window as any)[key] = snapshot;
  }
  for (const key of RUNTIME_STORAGE_KEYS) {
    try { localStorage.setItem(key, serialized); } catch { /* best effort */ }
  }

  // Signal the React polling loop (same events as xoreinControl.ts publishSnapshot).
  window.dispatchEvent(new Event('focus'));
  document.dispatchEvent(new Event('visibilitychange'));
}
