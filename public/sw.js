// Harmolyn service worker: makes the app installable and usable offline after the
// first visit. Deliberately conservative — it caches only the app shell and static
// assets. It NEVER caches API/relay/blob traffic: message delivery, presence, and
// E2EE material must always go to the live network, and caching ciphertext or
// control responses could surface stale or sensitive data.
const CACHE = 'harmolyn-shell-v1';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/favicon.ico'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

// Only same-origin GETs are eligible. Cross-origin (node.xorein.com API, relay,
// fonts, blobs) always goes straight to the network — never cached here.
function isCacheable(request, url) {
  return request.method === 'GET' && url.origin === self.location.origin;
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (!isCacheable(event.request, url)) return;

  // Navigations: network-first so a fresh build is picked up, falling back to the
  // cached shell (then '/') when offline — this is what makes the app open offline.
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(event.request).then((r) => r || caches.match('/index.html')).then((r) => r || caches.match('/'))),
    );
    return;
  }

  // Hashed build assets (immutable): cache-first, then populate on first fetch.
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((res) => {
        if (res.ok && (url.pathname.startsWith('/assets/') || /\.(js|css|svg|png|woff2?)$/.test(url.pathname))) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(event.request, copy)).catch(() => {});
        }
        return res;
      });
    }),
  );
});
