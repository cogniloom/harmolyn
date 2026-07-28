// Harmolyn service worker: makes the app installable and usable offline after the
// first visit. Deliberately conservative — it caches only the app shell and static
// assets. It NEVER caches API/relay/blob traffic: message delivery, presence, and
// E2EE material must always go to the live network, and caching ciphertext or
// control responses could surface stale or sensitive data.
const CACHE = 'harmolyn-shell-v2';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/favicon.ico'];

// On a first visit the service worker activates AFTER the page's hashed JS/CSS have
// already loaded, so those requests never pass through the fetch handler and never land
// in the cache. If the user then goes offline before a second controlled visit, the
// cached document opens but its bundle is missing and the launch fails. To make the
// promised first-visit offline launch real, fetch index.html at install time, parse the
// hashed assets it references, and precache them alongside the shell.
async function precacheShellAndBundle(cache) {
  await cache.addAll(APP_SHELL);
  try {
    const res = await fetch('/index.html', { cache: 'reload' });
    if (!res.ok) return;
    await cache.put('/index.html', res.clone());
    const html = await res.text();
    const urls = new Set();
    const re = /(?:src|href)\s*=\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(html)) !== null) {
      const u = m[1];
      // Same-origin hashed build assets only (the /assets/ chunks + module preloads).
      if (u.startsWith('/assets/') || /\.(js|css|woff2?)$/.test(u)) urls.add(u);
    }
    // Add individually so one 404 can't fail the whole precache (addAll is atomic).
    await Promise.allSettled([...urls].map((u) => cache.add(u)));
  } catch { /* offline/parse failure — runtime cache-first still fills in later */ }
}

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => precacheShellAndBundle(c)).then(() => self.skipWaiting()));
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
          // Only replace the cached offline shell with a genuinely good HTML response.
          // A same-origin navigation that gets a 5xx/maintenance page still resolves
          // fetch(); caching that would poison the shell so later offline launches show
          // the error page instead of the app.
          const ct = res.headers.get('content-type') || '';
          if (res.ok && res.type === 'basic' && ct.includes('text/html')) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          }
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
