function safeLocation(): Location | null {
  try {
    return (globalThis as typeof globalThis & { location?: Location }).location ?? null;
  } catch {
    return null;
  }
}

export function safeLocationHref(): string | null {
  const location = safeLocation();
  if (!location) {
    return null;
  }

  try {
    return location.href;
  } catch {
    return null;
  }
}

export function safeParseUrl(rawValue: string, baseHref?: string | null): URL | null {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return null;
  }

  if (!baseHref && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }

  try {
    return new URL(trimmed, baseHref ?? safeLocationHref() ?? undefined);
  } catch {
    return null;
  }
}

export function safeLocationSearch(): string | null {
  const location = safeLocation();
  if (!location) {
    return null;
  }

  try {
    return location.search;
  } catch {
    return null;
  }
}
