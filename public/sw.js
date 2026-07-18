// sidedoor service worker.
//
// Network-first, and it never caches the HTML document. That makes the app
// installable (a registered service worker is required) without the classic
// PWA footgun of serving a stale shell after you redeploy: pages always come
// from the network, and only hashed/immutable static assets are cached.
//
// Copy this file to your public root so it is served at /sw.js, then call
// registerServiceWorker() from sidedoor/pwa (or register('/sw.js') yourself).

const CACHE = 'sidedoor-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))),
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.pathname.startsWith('/api/')) return; // never cache API calls

  event.respondWith(
    fetch(request)
      .then((response) => {
        // Cache only fingerprinted static assets, never the HTML shell.
        const cacheable =
          response.ok &&
          (url.pathname.startsWith('/_next/static/') ||
            url.pathname.startsWith('/assets/') ||
            url.pathname.startsWith('/static/'));
        if (cacheable) {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(() => caches.match(request)),
  );
});
