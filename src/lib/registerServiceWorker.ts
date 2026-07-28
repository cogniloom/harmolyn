// Register the PWA service worker in production. No-op in dev (where the SW would
// fight Vite's HMR) and in non-secure contexts. Failures are non-fatal — the app
// works fine without offline support.
export function registerServiceWorker(): void {
  if (typeof window === 'undefined' || !('serviceWorker' in navigator)) return;
  if (!import.meta.env.PROD) return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      /* offline support unavailable — non-fatal */
    });
  });
}
