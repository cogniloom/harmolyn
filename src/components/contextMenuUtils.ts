import { safeParseUrl } from '@/lib/browserLocation';

const ALLOWED_EXTERNAL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel']);
const ALLOWED_IMAGE_SCHEMES = new Set(['http', 'https', 'data']);

export function canCopyTextToClipboardSafely(): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.clipboard?.writeText;
  } catch {
    return false;
  }
}

export async function copyTextToClipboardSafely(text: string): Promise<boolean> {
  try {
    const clipboard = typeof navigator === 'undefined' ? null : navigator.clipboard;
    if (!clipboard?.writeText) {
      return false;
    }
    await clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function safeConfirm(message: string): boolean {
  try {
    return typeof window !== 'undefined' && typeof window.confirm === 'function' ? window.confirm(message) : false;
  } catch {
    return false;
  }
}

export function safeGetSelectedText(): string {
  try {
    return window.getSelection()?.toString()?.trim() || '';
  } catch {
    return '';
  }
}

export function safeReloadPage(): boolean {
  try {
    if (typeof window === 'undefined' || typeof window.location?.reload !== 'function') {
      return false;
    }

    window.location.reload();
    return true;
  } catch {
    return false;
  }
}

export function openUrlSafely(rawUrl: string, allowedSchemes: ReadonlySet<string>): boolean {
  const trimmed = rawUrl.trim();
  if (!trimmed) return false;
  if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
    return false;
  }

  try {
    const parsed = safeParseUrl(trimmed);
    const scheme = parsed.protocol.replace(/:$/, '').toLowerCase();
    if (!allowedSchemes.has(scheme)) {
      return false;
    }

    if (scheme === 'data') {
      const imageDataUrl = /^data:image\/(?!svg\+xml)([a-z0-9.+-]+)(?:;[^,]*)?,/i;
      if (!imageDataUrl.test(trimmed)) {
        return false;
      }
    }

    if ((scheme === 'http' || scheme === 'https') && /\.svgz?([?#].*)?$/i.test(parsed.pathname)) {
      return false;
    }

    const opened = window.open(parsed.toString(), '_blank', 'noopener,noreferrer');
    if (opened) {
      opened.opener = null;
    }
    return true;
  } catch {
    return false;
  }
}

export { ALLOWED_EXTERNAL_SCHEMES, ALLOWED_IMAGE_SCHEMES };
