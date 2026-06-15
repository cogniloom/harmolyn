type StorageInput = Storage | null | undefined | (() => Storage | null | undefined);

function resolveStorage(storage: StorageInput): Storage | null {
  try {
    const resolved = typeof storage === 'function' ? storage() : storage;
    return resolved ?? null;
  } catch {
    return null;
  }
}

export function safeStorageGet(storage: StorageInput, key: string): string | null {
  const resolved = resolveStorage(storage);
  if (!resolved) {
    return null;
  }

  try {
    return resolved.getItem(key);
  } catch {
    return null;
  }
}

export function safeStorageSet(storage: StorageInput, key: string, value: string): void {
  const resolved = resolveStorage(storage);
  if (!resolved) {
    return;
  }

  try {
    resolved.setItem(key, value);
  } catch {
    // Storage can be unavailable or quota-limited in production browsers.
  }
}

export function safeStorageRemove(storage: StorageInput, key: string): void {
  const resolved = resolveStorage(storage);
  if (!resolved) {
    return;
  }

  try {
    resolved.removeItem(key);
  } catch {
    // Storage can be unavailable or quota-limited in production browsers.
  }
}
