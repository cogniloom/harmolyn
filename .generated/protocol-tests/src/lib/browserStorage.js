function resolveStorage(storage) {
    try {
        const resolved = typeof storage === 'function' ? storage() : storage;
        return resolved ?? null;
    }
    catch {
        return null;
    }
}
export function safeStorageGet(storage, key) {
    const resolved = resolveStorage(storage);
    if (!resolved) {
        return null;
    }
    try {
        return resolved.getItem(key);
    }
    catch {
        return null;
    }
}
export function safeStorageSet(storage, key, value) {
    const resolved = resolveStorage(storage);
    if (!resolved) {
        return;
    }
    try {
        resolved.setItem(key, value);
    }
    catch {
        // Storage can be unavailable or quota-limited in production browsers.
    }
}
export function safeStorageRemove(storage, key) {
    const resolved = resolveStorage(storage);
    if (!resolved) {
        return;
    }
    try {
        resolved.removeItem(key);
    }
    catch {
        // Storage can be unavailable or quota-limited in production browsers.
    }
}
