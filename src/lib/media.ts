import { safeParseUrl } from './browserLocation';

const SAFE_PREVIEW_SCHEMES = ['http:', 'https:'];
const SAFE_PREVIEW_DATA_URL = /^data:image\/(?:png|jpeg|jpg|gif|webp|avif|bmp);/i;
const SAFE_PREVIEW_PATH = /\.(?:png|jpeg|jpg|gif|webp|avif|bmp)$/i;
const EXPLICIT_SCHEME_REGEX = /^[a-zA-Z][a-zA-Z0-9+.-]*:/;

export function isSafePreviewImageSource(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) {
    return false;
  }

  if (trimmed.toLowerCase().startsWith('data:')) {
    return SAFE_PREVIEW_DATA_URL.test(trimmed);
  }

  if (!EXPLICIT_SCHEME_REGEX.test(trimmed)) {
    return false;
  }

  try {
    const parsed = safeParseUrl(trimmed);
    if (!SAFE_PREVIEW_SCHEMES.includes(parsed.protocol)) {
      return false;
    }

    return SAFE_PREVIEW_PATH.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function resolvePreviewImageSrc(source: string | null | undefined): string | null {
  const trimmed = source?.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.toLowerCase().startsWith('data:')) {
    return isSafePreviewImageSource(trimmed) ? trimmed : null;
  }

  if (!EXPLICIT_SCHEME_REGEX.test(trimmed)) {
    return null;
  }

  try {
    const parsed = safeParseUrl(trimmed);
    if (!parsed || (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')) {
      return null;
    }

    const canonical = parsed.toString();
    return isSafePreviewImageSource(canonical) ? canonical : null;
  } catch {
    return null;
  }
}
