/* Service worker: cachea solo assets públicos.
   Las navegaciones y /api/ siempre van a la red; si no hay internet,
   se usa el shell de la app cacheado (nunca la pantalla de login). */
const CACHE = 'byd-colombia-v15';
const ASSETS = [
  '/styles.css',
  '/app.js',
  '/manifest.webmanifest',
  '/vendor/leaflet/leaflet.js',
  '/vendor/leaflet/leaflet.css',
  '/icons/icon.svg',
  '/assets/byd-suv.svg',
  '/assets/byd-top.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => Promise.all(ASSETS.map((asset) => cache.add(asset).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const type = response.headers.get('content-type') || '';
          if (response.ok && !response.redirected && type.includes('text/html')) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put('/', copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const cached = await caches.match('/');
          if (cached) return cached;
          return new Response('Sin conexión. Conecta el carro a internet y vuelve a intentar.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        })
    );
    return;
  }

  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((response) => {
          if (response.ok && !response.redirected) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
          }
          return response;
        })
        .catch(async () => {
          const fallback = await caches.match(request);
          return fallback || new Response('', { status: 504 });
        });
    })
  );
});
