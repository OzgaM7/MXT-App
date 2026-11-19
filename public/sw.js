// Service worker MXT: zapamiętuje pliki aplikacji, żeby działała jak zainstalowana (PWA).
// Zapytania /api/* zawsze idą do serwera (bez cache).
const CACHE = 'mxt-v7';
const SHELL = ['/', '/app.css', '/app.js', '/modules.js', '/biznes.js', '/dzial1.js', '/dzial2.js', '/szkolenia.js', '/etap4.js', '/logo.png', '/logos/podzielniki.png', '/logos/express-parts.png', '/logos/ubezpieczenia.png', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys()
    .then(keys => Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  if (e.request.mode === 'navigate') {
    // Strony: najpierw sieć (świeża wersja), bez sieci – zapamiętana aplikacja.
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  // Pliki statyczne: z pamięci, w tle odświeżane z sieci.
  e.respondWith(caches.match(e.request).then(hit => {
    const net = fetch(e.request).then(r => {
      if (r.ok) caches.open(CACHE).then(c => c.put(e.request, r.clone()));
      return r;
    }).catch(() => hit);
    return hit || net;
  }));
});
