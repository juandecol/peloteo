// Service worker de Peloteo: permite instalar el sitio como app y abrirlo sin conexión.
//
// - Primero la red: si hay conexión, siempre se ve la versión publicada (un push a
//   main llega igual que antes). La copia guardada solo se usa sin conexión.
// - /api y /admin nunca pasan por aquí: los datos de partidos y el panel siempre
//   van al servidor. Sin conexión, la app muestra su aviso "Revisa tu conexión".
// - Al cambiar VERSION se descartan las copias anteriores.
//
// RETIRO: para dejar el sitio como antes de la app instalable, poner RETIRED = true
// aquí y PWA = false en app.js, y publicar. Este archivo NO se borra (al menos por
// unos meses): los navegadores que ya lo instalaron lo vuelven a pedir, y esta
// versión se borra a sí misma, elimina sus copias y deja de intervenir.
const RETIRED = false;
const VERSION = 'peloteo-v1';
const SHELL = ['/', '/styles.css', '/app.js', '/img/logo.png', '/img/inicio-tenis.webp', '/img/icon-192.png', '/favicon.ico', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  if (RETIRED) { e.waitUntil(self.skipWaiting()); return; }
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  if (RETIRED) {
    e.waitUntil(
      caches.keys()
        .then((keys) => Promise.all(keys.filter((k) => k.startsWith('peloteo-')).map((k) => caches.delete(k))))
        .then(() => self.registration.unregister()),
    );
    return;
  }
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  if (RETIRED) return; // todo va directo a la red, como sin service worker
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname === '/admin' || url.pathname.startsWith('/admin/')) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(VERSION).then((c) => c.put(req.mode === 'navigate' ? '/' : req, copy));
        }
        return res;
      })
      .catch(async () => (await caches.match(req.mode === 'navigate' ? '/' : req, { ignoreSearch: true })) || Response.error()),
  );
});
