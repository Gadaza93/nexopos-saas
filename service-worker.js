const CACHE = 'nexopos-v46';
const ASSETS = [
  './',
  './index.html',
  './theme.css',
  './styles.css',
  './design.css',
  './xlsx.full.min.js',
  './supabase.min.js',
  './demo-mode.js',
  './planes.js',
  './storage.js',
  './modules.js',
  './sync.js',
  './import-products.js',
  './print.js',
  './app.js',
  './manifest.webmanifest',
  './logo.png'
];
self.addEventListener('install', event => event.waitUntil(caches.open(CACHE).then(cache => cache.addAll(ASSETS)).then(() => self.skipWaiting())));
self.addEventListener('activate', event => event.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(key => key !== CACHE).map(key => caches.delete(key)))).then(() => self.clients.claim())));
self.addEventListener('fetch', event => {
  if (event.request.method !== 'GET') return;
  const url = new URL(event.request.url);
  // Don't intercept cross-origin API calls (like Supabase REST)
  if (url.origin !== self.location.origin) return;
  // Panel SuperAdmin: siempre en línea y sin caché, para que sus cambios se vean de inmediato
  if (/\/admin(\.html|\.js|\.css)?$/.test(url.pathname)) return;

  event.respondWith(
    caches.match(event.request).then(cached => {
      if (cached) return cached;
      return fetch(event.request).then(response => {
        const copy = response.clone();
        caches.open(CACHE).then(cache => cache.put(event.request, copy));
        return response;
      }).catch(() => {
        if (event.request.mode === 'navigate' || event.request.destination === 'document') {
          return caches.match('./index.html');
        }
        return caches.match(event.request);
      });
    })
  );
});
