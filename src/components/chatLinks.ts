import { safeLocationHref, safeParseUrl } from '@/lib/browserLocation';

const ALLOWED_MESSAGE_ORIGINS = new Set(['http:', 'https:', 'tauri:']);

export function safeLocationOrigin(): string | null {
  try {
    const href = safeLocationHref();
    if (!href) {
      return null;
    }
    const parsed = safeParseUrl(href);
    if (!parsed?.host || !ALLOWED_MESSAGE_ORIGINS.has(parsed.protocol)) {
      return null;
    }
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function normalizeMessageLinkOrigin(origin: string): string | null {
  const trimmed = origin.trim();
  if (!trimmed || !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return null;
  }

  const parsed = safeParseUrl(trimmed);
  if (!parsed?.host || !ALLOWED_MESSAGE_ORIGINS.has(parsed.protocol)) {
    return null;
  }

  return `${parsed.protocol}//${parsed.host}`;
}

export function buildMessageLink(origin: string, channelId: string | undefined, msgId: string): string | null {
  const normalizedOrigin = normalizeMessageLinkOrigin(origin);
  if (!normalizedOrigin) {
    return null;
  }

  const scope = encodeURIComponent(channelId || 'scope');
  const message = encodeURIComponent(msgId);
  return `${normalizedOrigin}/#/messages/${scope}/${message}`;
}
