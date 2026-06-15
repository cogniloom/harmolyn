import type { XoreinRuntimeSnapshot } from '../types.js';
import { safeStorageGet } from './browserStorage.js';

const CONTROL_READY_GLOBAL_KEYS = [
  '__HARMOLYN_XOREIN_CONTROL_READY__',
  '__HARMOLYN_CONTROL_READY__',
] as const;

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

export interface AuthPreviewContext {
  runtimeSnapshot: XoreinRuntimeSnapshot | null;
  hasRuntimeIdentity: boolean;
  hasControlEndpoint: boolean;
  hasControlBridge: boolean;
  identityLabel: string;
}

export function readBrowserAuthContext(): AuthPreviewContext {
  const runtimeSnapshot = readRuntimeSnapshot();
  const identity = normalizeRuntimeIdentity(runtimeSnapshot?.identity);
  const identityPeerId = identity?.peer_id ?? '';
  const displayName = identity?.profile?.display_name ?? '';
  const controlEndpoint = normalizeRuntimeEndpoint(runtimeSnapshot?.control_endpoint) || normalizeRuntimeSettings(runtimeSnapshot?.settings)?.control_endpoint || '';
  const controlBridge = readControlBridgeReady();

  return {
    runtimeSnapshot,
    hasRuntimeIdentity: Boolean(identityPeerId),
    hasControlEndpoint: Boolean(controlEndpoint),
    hasControlBridge: controlBridge,
    identityLabel: displayName || identityPeerId || 'local runtime',
  };
}

function readRuntimeSnapshot(): XoreinRuntimeSnapshot | null {
  if (typeof window === 'undefined') {
    return null;
  }

  const windowRecord = window as unknown as Record<string, unknown>;
  for (const key of RUNTIME_GLOBAL_KEYS) {
    const value = normalizeRuntimeSnapshot(windowRecord[key]);
    if (value) {
      return value;
    }
  }

  for (const key of RUNTIME_STORAGE_KEYS) {
    const value = normalizeRuntimeSnapshot(parseJson(safeStorageGet(() => window.localStorage, key)));
    if (value) {
      return value;
    }
  }

  return null;
}

function readControlBridgeReady(): boolean {
  if (typeof window === 'undefined') {
    return false;
  }

  const windowRecord = window as unknown as Record<string, unknown>;
  for (const key of CONTROL_READY_GLOBAL_KEYS) {
    if (windowRecord[key] === true) {
      return true;
    }
  }

  return false;
}

function parseJson(raw: string | null): unknown {
  if (!raw) {
    return null;
  }

  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function isRuntimeSnapshot(value: unknown): value is XoreinRuntimeSnapshot {
  return isPlainObject(value);
}

function normalizeRuntimeSnapshot(value: unknown): XoreinRuntimeSnapshot | null {
  if (!isRuntimeSnapshot(value)) {
    return null;
  }

  const identity = normalizeRuntimeIdentity(value.identity);
  const controlEndpoint = normalizeRuntimeEndpoint(value.control_endpoint);
  const settings = normalizeRuntimeSettings(value.settings);
  if (!identity && !controlEndpoint && !settings) {
    return null;
  }

  return {
    ...(identity ? { identity } : {}),
    ...(controlEndpoint ? { control_endpoint: controlEndpoint } : {}),
    ...(settings ? { settings } : {}),
  };
}

export function normalizeRuntimeEndpoint(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

export function normalizeRuntimeSettings(value: unknown): Record<string, string> | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const entries = Object.entries(value).flatMap(([key, entry]) => {
    const normalizedKey = typeof key === 'string' ? key.trim() : '';
    const normalizedValue = typeof entry === 'string' ? entry.trim() : '';
    if (!normalizedKey || !normalizedValue) {
      return [];
    }
    return [[normalizedKey, normalizedValue] as const];
  });

  if (entries.length === 0) {
    return undefined;
  }
  const normalized: Record<string, string> = {};
  for (const [key, entry] of entries) {
    if (Object.prototype.hasOwnProperty.call(normalized, key)) {
      continue;
    }
    normalized[key] = entry;
  }
  return normalized;
}

export function normalizeRuntimeIdentity(value: unknown): XoreinRuntimeSnapshot['identity'] | undefined {
  if (!isPlainObject(value)) {
    return undefined;
  }

  const profile = isPlainObject(value.profile) ? value.profile : null;
  const peerId = typeof value.peer_id === 'string' && value.peer_id.trim() ? value.peer_id.trim() : '';
  const displayName = profile && typeof profile.display_name === 'string' && profile.display_name.trim()
    ? profile.display_name.trim()
    : '';
  const bio = profile && typeof profile.bio === 'string' && profile.bio.trim()
    ? profile.bio.trim()
    : '';

  if (!peerId) {
    return undefined;
  }

  return {
    ...(typeof value.id === 'string' && value.id.trim() ? { id: value.id.trim() } : {}),
    peer_id: peerId,
    ...(typeof value.public_key === 'string' && value.public_key.trim() ? { public_key: value.public_key.trim() } : {}),
    ...(typeof value.created_at === 'string' && value.created_at.trim() ? { created_at: value.created_at.trim() } : {}),
    ...(displayName || bio ? {
      profile: {
        ...(displayName ? { display_name: displayName } : {}),
        ...(bio ? { bio } : {}),
      },
    } : {}),
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype;
}
