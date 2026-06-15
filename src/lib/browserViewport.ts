export interface BrowserViewportSize {
  width: number | null;
  height: number | null;
}

export function safeViewportSize(): BrowserViewportSize {
  if (typeof window === "undefined") {
    return { width: null, height: null };
  }

  try {
    return {
      width: typeof window.innerWidth === "number" ? window.innerWidth : null,
      height: typeof window.innerHeight === "number" ? window.innerHeight : null,
    };
  } catch {
    return { width: null, height: null };
  }
}
