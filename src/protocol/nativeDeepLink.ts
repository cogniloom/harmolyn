import { parseJoinDeepLink } from './deeplink.js';

export function handleNativeDeepLink(rawUrl: unknown, onOpenJoin: (initialValue?: string) => void): boolean {
  if (typeof rawUrl !== 'string') {
    return false;
  }
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return false;
  }

  try {
    const parsed = parseJoinDeepLink(trimmed);
    if (!parsed.invite) {
      return false;
    }

    onOpenJoin(trimmed);
    return true;
  } catch {
    return false;
  }
}
