/* Кэшируем ТОЛЬКО оболочку приложения. Никаких потоков, ключей или ответов API. */
const CACHE = 'ytlocal-shell-v1.1.0';
const ASSETS = [
  './', 'index.html', 'styles.css', 'media.js', 'db.js', 'native.js', 'youtube.js', 'app.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png',
  'icons/icon-maskable-512.png', 'icons/apple-touch-icon.png',
  ...['latin', 'cyrillic'].flatMap((subset) => [400, 500, 700].map((weight) => `fonts/roboto-${subset}-${weight}-normal.woff2`))
];
const STATIC = new Set(ASSETS.map((path) => new URL(path, self.location).pathname));
const offlineClients = new Map();
self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(ASSETS)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE && key.startsWith('ytlocal-')).map((key) => caches.delete(key)))).then(() => self.clients.claim()));
});
self.addEventListener('message', (event) => {
  if (event.data?.type === 'SET_OFFLINE' && event.source?.id) offlineClients.set(event.source.id, !!event.data.enabled);
});
self.addEventListener('fetch', (event) => {
  const request = event.request, url = new URL(request.url);
  if (request.method !== 'GET') return;
  if (url.origin !== self.location.origin) {
    if (offlineClients.get(event.clientId)) event.respondWith(Promise.resolve(new Response('Offline mode', { status: 503 })));
    return;
  }
  if (!STATIC.has(url.pathname) && request.mode !== 'navigate') return;
  event.respondWith(caches.open(CACHE).then(async (cache) => {
    const hit = await cache.match(request, { ignoreSearch: true });
    if (hit) return hit;
    try { return await fetch(request); }
    catch (error) {
      if (request.mode === 'navigate') return (await cache.match('index.html')) || Response.error();
      return Response.error();
    }
  }));
});
