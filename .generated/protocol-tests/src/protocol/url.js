export function parseAbsoluteUrl(raw) {
    const trimmed = raw.trim();
    if (!trimmed) {
        return null;
    }
    try {
        return new URL(trimmed);
    }
    catch {
        return null;
    }
}
