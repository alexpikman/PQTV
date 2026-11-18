// PQTV PWA Service Worker
const CACHE = 'pqtv-v2-2026';
const PRECACHE = [
  '/assets/css/style.css',
  '/assets/css/watch.css',
  '/assets/js/watch.js',
  '/assets/js/firebase-users.js',
  '/manifest.webmanifest',
  '/assets/icons/icon-192.png',
  '/assets/icons/icon-512.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(PRECACHE).catch(() => {}))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // Never cache API, APK downloads, stream proxies, or auth routes
  if (
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/watch/api/') ||
    url.pathname.startsWith('/apk/') ||
    url.pathname.startsWith('/login') ||
    url.pathname.startsWith('/logout') ||
    url.pathname.startsWith('/editor')
  ) {
    return;
  }

  // Network-first for HTML page navigations so auth/session state is always fresh
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).catch(() => caches.match('/watch'))
    );
    return;
  }

  const isOurHost = url.hostname === location.hostname;
  const isCDN = url.hostname.includes('jsdelivr.net');
  if (!isOurHost && !isCDN) return;

  e.respondWith(
    caches.match(req).then(cached => {
      const fetchPromise = fetch(req).then(res => {
        if (res && res.status === 200 && res.type !== 'opaque') {
          const copy = res.clone();
          caches.open(CACHE).then(c => c.put(req, copy)).catch(() => {});
        }
        return res;
      }).catch(() => cached);

      return cached || fetchPromise;
    })
  );
});
