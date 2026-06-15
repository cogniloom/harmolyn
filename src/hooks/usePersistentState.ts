import { useEffect, useState } from 'react';
import { safeStorageGet, safeStorageSet } from '@/lib/browserStorage';

function readStoredValue<T>(storageKey: string, fallback: T): T {
  if (typeof window === 'undefined') {
    return fallback;
  }

  const raw = safeStorageGet(() => window.localStorage, storageKey);
  if (!raw) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return isCompatibleStoredValue(parsed, fallback) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function isCompatibleStoredValue<T>(value: unknown, fallback: T): value is T {
  if (Array.isArray(fallback)) {
    return Array.isArray(value);
  }
  if (fallback === null) {
    return value === null;
  }
  switch (typeof fallback) {
    case 'boolean':
      return typeof value === 'boolean';
    case 'number':
      return typeof value === 'number';
    case 'string':
      return typeof value === 'string';
    case 'object':
      return isPlainObject(value);
    default:
      return false;
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}

export function usePersistentState<T>(storageKey: string, fallback: T): [T, (value: T | ((current: T) => T)) => void] {
  const [value, setValue] = useState<T>(() => readStoredValue(storageKey, fallback));

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    safeStorageSet(() => window.localStorage, storageKey, JSON.stringify(value));
  }, [storageKey, value]);

  return [value, setValue];
}
