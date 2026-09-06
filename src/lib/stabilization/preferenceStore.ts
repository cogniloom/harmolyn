/** Shared preference channels: no writes on mount, one cross-tab listener. */
type Listener = () => void;
type Channel = {
  snapshot: unknown;
  fallback: unknown;
  raw: string | null;
  volatile: boolean;
  listeners: Set<Listener>;
  getSnapshot: () => unknown;
  subscribe: (listener: Listener) => () => void;
  set: (value: unknown | ((current: unknown) => unknown)) => void;
};
const channels = new Map<string, Channel>();
let listening = false;

function compatible(value: unknown, fallback: unknown): boolean {
  if (Array.isArray(fallback)) return Array.isArray(value);
  if (fallback === null) return value === null;
  if (typeof fallback === 'number') return typeof value === 'number' && Number.isFinite(value);
  if (typeof fallback === 'object') return !!value && typeof value === 'object' && !Array.isArray(value) && Object.getPrototypeOf(value) === Object.prototype;
  return typeof value === typeof fallback;
}
function rawValue(key: string): string | null {
  try { return typeof window === 'undefined' ? null : window.localStorage.getItem(key); } catch { return null; }
}
function decode(raw: string | null, fallback: unknown): unknown {
  if (raw === null) return fallback;
  try { const value: unknown = JSON.parse(raw); return compatible(value, fallback) ? value : fallback; } catch { return fallback; }
}
function refresh(key: string, channel: Channel, force = false): boolean {
  const raw = rawValue(key);
  if (!force && (raw === channel.raw || channel.volatile)) return false;
  channel.raw = raw;
  channel.volatile = false;
  const next = decode(raw, channel.fallback);
  if (Object.is(next, channel.snapshot)) return false;
  channel.snapshot = next;
  return true;
}
function onStorage(event: StorageEvent): void {
  try { if (event.storageArea && event.storageArea !== window.localStorage) return; } catch { return; }
  for (const [key, channel] of channels) {
    if ((event.key === null || event.key === key) && refresh(key, channel, true)) {
      for (const notify of [...channel.listeners]) notify();
    }
  }
}
function stopWhenUnused(): void {
  if (listening && ![...channels.values()].some(channel => channel.listeners.size > 0)) {
    window.removeEventListener('storage', onStorage);
    listening = false;
  }
}

export function preferenceChannel<T>(key: string, fallback: T): {
  getSnapshot: () => T;
  subscribe: (listener: Listener) => () => void;
  set: (value: T | ((current: T) => T)) => void;
} {
  let channel = channels.get(key);
  if (!channel) {
    // Bound entries created by abandoned renders; active channels are never evicted.
    if (channels.size >= 128) {
      for (const [oldKey, old] of channels) {
        if (!old.listeners.size) channels.delete(oldKey);
        if (channels.size < 128) break;
      }
    }
    const raw = rawValue(key);
    const next: Channel = {
      raw, fallback, volatile: false, snapshot: decode(raw, fallback), listeners: new Set(),
      getSnapshot: () => next.snapshot,
      subscribe: (listener) => {
        next.listeners.add(listener);
        channels.set(key, next);
        if (!listening && typeof window !== 'undefined') {
          window.addEventListener('storage', onStorage);
          listening = true;
        }
        // Covers a change between render and subscription without overwriting storage.
        if (refresh(key, next)) for (const notify of [...next.listeners]) notify();
        return () => {
          next.listeners.delete(listener);
          if (!next.listeners.size && channels.get(key) === next) channels.delete(key);
          stopWhenUnused();
        };
      },
      set: (value) => {
        refresh(key, next);
        const resolved = typeof value === 'function' ? value(next.snapshot) : value;
        if (Object.is(resolved, next.snapshot)) return;
        let raw: string | undefined;
        try { raw = JSON.stringify(resolved); } catch { return; }
        if (raw === undefined) return;
        if (raw === next.raw && !next.volatile) return;
        next.snapshot = resolved;
        next.volatile = true;
        try {
          if (typeof window !== 'undefined') {
            window.localStorage.setItem(key, raw);
            next.raw = raw;
            next.volatile = false;
          }
        } catch { /* Keep this tab's choice effective even when persistence is unavailable. */ }
        for (const notify of [...next.listeners]) notify();
      },
    };
    channel = next;
    channels.set(key, channel);
  }
  return channel as ReturnType<typeof preferenceChannel<T>>;
}
