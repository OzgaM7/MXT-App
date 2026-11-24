// Service worker MXT: zapamiętuje pliki aplikacji, żeby działała jak zainstalowana (PWA), i pokazuje powiadomienia push.
// Zapytania /api/* zawsze idą do serwera (bez cache).
const CACHE = 'mxt-v23';
const SHELL = ['/', '/app.css', '/app.js', '/modules.js', '/biznes.js', '/dzial1.js', '/dzial2.js', '/szkolenia.js', '/etap4.js', '/konta.js', '/teren.js', '/serwisy.js', '/odczyty.js', '/montaze-import.js', '/asystent.js', '/ghost.js', '/erp-operacje.js', '/erp-magazyn.js', '/erp-pracownicy.js', '/erp-ubezpieczenia.js', '/erp-czesci.js', '/erp-finanse.js',
  '/logo.png', '/logos/podzielniki.png', '/logos/express-parts.png', '/logos/ubezpieczenia.png', '/logos/asystent-telefoniczny.png', '/logos/ghost.webp', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/icon-512.png'];

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

// ---------- powiadomienia push (lib/notify.js) ----------
// Treść: { title, body, url, tag }. Adres zawsze wewnątrz aplikacji (ścieżka zaczynająca się od „/”).
self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { title: 'MXT', body: e.data ? e.data.text() : '' }; }
  const url = typeof d.url === 'string' && d.url.startsWith('/') && !d.url.startsWith('//') ? d.url : '/powiadomienia';
  e.waitUntil(Promise.all([
    self.registration.showNotification(d.title || 'MXT', { body: d.body || '', tag: d.tag || undefined, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url } }),
    // Otwarta aplikacja odświeża licznik na dzwonku.
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => cs.forEach(c => c.postMessage({ type: 'mxt-push' })))
  ]));
});
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = (e.notification.data && e.notification.data.url) || '/powiadomienia';
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(cs => {
    const c = cs.find(x => new URL(x.url).origin === location.origin);
    if (c) return c.focus().then(w => (w || c).navigate ? (w || c).navigate(url) : null).catch(() => self.clients.openWindow(url));
    return self.clients.openWindow(url);
  }));
});
