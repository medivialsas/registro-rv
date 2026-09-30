/* Service worker: guarda la app en el celular para que abra sin señal.
   Al publicar cambios, subir el número de VERSION para que los celulares se actualicen. */
const VERSION = 'rv-1.0.1';
const ASSETS = [
  './', 'index.html', 'styles.css', 'app.js', 'config.js', 'manifest.webmanifest',
  'data/catalogo.json', 'data/config.json',
  'fonts/montserrat-latin-500-normal.woff2', 'fonts/montserrat-latin-600-normal.woff2',
  'fonts/montserrat-latin-700-normal.woff2', 'fonts/montserrat-latin-800-normal.woff2',
  'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-180.png',
  'img/SP-CH_CHEVRON.svg'
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(VERSION).then(c => c.addAll(ASSETS)));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(keys.filter(k => k !== VERSION).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => { if (e.data === 'skipWaiting') self.skipWaiting(); });

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // el Google Sheets siempre va por red

  // Imágenes de señales: se guardan a medida que se usan.
  if (url.pathname.includes('/img/')) {
    e.respondWith(caches.open(VERSION).then(async c => {
      const hit = await c.match(req);
      if (hit) return hit;
      try { const r = await fetch(req); if (r.ok) c.put(req, r.clone()); return r; }
      catch (err) { return new Response('', { status: 404 }); }
    }));
    return;
  }

  // Resto de la app: primero lo guardado; si hay red, se actualiza en segundo plano.
  e.respondWith(caches.open(VERSION).then(async c => {
    const hit = await c.match(req, { ignoreSearch: true });
    const net = fetch(req).then(r => { if (r.ok) c.put(req, r.clone()); return r; }).catch(() => null);
    if (hit) return hit;
    const r = await net;
    if (r) return r;
    if (req.mode === 'navigate') return c.match('index.html');
    return new Response('', { status: 504 });
  }));
});
