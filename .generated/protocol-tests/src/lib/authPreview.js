import { safeStorageGet } from './browserStorage.js';
const CONTROL_READY_GLOBAL_KEYS = [
    '__HARMOLYN_XOREIN_CONTROL_READY__',
    '__HARMOLYN_CONTROL_READY__',
];
const RUNTIME_GLOBAL_KEYS = [
    '__HARMOLYN_XOREIN_RUNTIME__',
    '__HARMOLYN_RUNTIME_SNAPSHOT__',
    '__XOREIN_RUNTIME_SNAPSHOT__',
];
const RUNTIME_STORAGE_KEYS = [
    'harmolyn:xorein:runtime',
    'harmolyn:runtime-snapshot',
    'xorein:runtime-snapshot',
];
export function readBrowserAuthContext() {
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
function readRuntimeSnapshot() {
    if (typeof window === 'undefined') {
        return null;
    }
    const windowRecord = window;
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
function readControlBridgeReady() {
    if (typeof window === 'undefined') {
        return false;
    }
    const windowRecord = window;
    for (const key of CONTROL_READY_GLOBAL_KEYS) {
        if (windowRecord[key] === true) {
            return true;
        }
    }
    return false;
}
function parseJson(raw) {
    if (!raw) {
        return null;
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        return null;
    }
}
function isRuntimeSnapshot(value) {
    return isPlainObject(value);
}
function normalizeRuntimeSnapshot(value) {
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
export function normalizeRuntimeEndpoint(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function normalizeRuntimeSettings(value) {
    if (!isPlainObject(value)) {
        return undefined;
    }
    const entries = Object.entries(value).flatMap(([key, entry]) => {
        const normalizedKey = typeof key === 'string' ? key.trim() : '';
        const normalizedValue = typeof entry === 'string' ? entry.trim() : '';
        if (!normalizedKey || !normalizedValue) {
            return [];
        }
        return [[normalizedKey, normalizedValue]];
    });
    if (entries.length === 0) {
        return undefined;
    }
    const normalized = {};
    for (const [key, entry] of entries) {
        if (Object.prototype.hasOwnProperty.call(normalized, key)) {
            continue;
        }
        normalized[key] = entry;
    }
    return normalized;
}
export function normalizeRuntimeIdentity(value) {
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
function isPlainObject(value) {
    return Boolean(value)
        && typeof value === 'object'
        && !Array.isArray(value)
        && Object.getPrototypeOf(value) === Object.prototype;
}
