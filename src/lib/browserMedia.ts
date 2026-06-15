type MediaMatcher = typeof window.matchMedia;

export function safeMatchMedia(query: Parameters<MediaMatcher>[0]): MediaQueryList | null {
  if (typeof window === "undefined") {
    return null;
  }

  let matchMedia: MediaMatcher | null = null;
  try {
    matchMedia = window.matchMedia;
  } catch {
    return null;
  }

  if (typeof matchMedia !== "function") {
    return null;
  }

  try {
    return matchMedia.call(window, query);
  } catch {
    return null;
  }
}
