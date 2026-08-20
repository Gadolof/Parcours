/* ==========================================================
   PARCOURS — service worker
   Met l'application entière en cache pour qu'elle s'ouvre sans
   réseau. Les tuiles de carte ne passent pas par ici : elles ont
   leur propre cache IndexedDB, géré par l'application.
   ========================================================== */

// À incrémenter à chaque déploiement : c'est ce qui déclenche la
// mise à jour du cache chez les utilisateurs déjà installés.
const VERSION = 'v0.3.3';
const SHELL = `parcours-shell-${VERSION}`;

const PRECACHE = [
  './',
  'index.html',
  'manifest.json',
  'styles.css',
  'src/app.js',
  'src/core.js',
  'vendor/leaflet.js',
  'vendor/leaflet.css',
  'vendor/drawflow.min.js',
  'vendor/drawflow.min.css',
  'vendor/jszip.min.js',
  'vendor/jsQR.js',
  'vendor/qrcode.mjs',
  'vendor/qrcode_UTF8.mjs',
  'vendor/fonts.css',
  'vendor/fonts/fraunces-latin-standard-normal.woff2',
  'vendor/fonts/fraunces-latin-standard-italic.woff2',
  'vendor/fonts/ibm-plex-sans-latin-300-normal.woff2',
  'vendor/fonts/ibm-plex-sans-latin-400-normal.woff2',
  'vendor/fonts/ibm-plex-sans-latin-500-normal.woff2',
  'vendor/fonts/ibm-plex-sans-latin-600-normal.woff2',
  'vendor/fonts/ibm-plex-mono-latin-400-normal.woff2',
  'vendor/fonts/ibm-plex-mono-latin-500-normal.woff2',
  'vendor/fonts/ibm-plex-mono-latin-600-normal.woff2',
  'vendor/images/marker-icon.png',
  'vendor/images/marker-icon-2x.png',
  'vendor/images/marker-shadow.png',
  'vendor/images/layers.png',
  'vendor/images/layers-2x.png',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png'
];

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // addAll() échoue en bloc à la moindre ressource manquante ; on
    // préfère savoir laquelle plutôt que perdre tout le précache.
    await Promise.all(PRECACHE.map(async url => {
      try {
        await cache.add(new Request(url, { cache: 'reload' }));
      } catch (e) {
        console.error('[sw] précache impossible :', url, e);
      }
    }));
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter(n => n.startsWith('parcours-shell-') && n !== SHELL)
                           .map(n => caches.delete(n)));
    await self.clients.claim();
  })());
});

// La page décide du moment de la bascule : remplacer les fichiers sous
// une session d'édition en cours serait le meilleur moyen de la casser.
self.addEventListener('message', event => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Tuiles de carte et autres origines : on laisse passer. Les mettre
  // dans ce cache-ci doublerait le cache IndexedDB, sans le remplacer.
  if (url.origin !== self.location.origin) return;

  // Navigation : hors ligne, on sert la coquille.
  if (req.mode === 'navigate') {
    event.respondWith((async () => {
      try {
        return await fetch(req);
      } catch (e) {
        const cache = await caches.open(SHELL);
        return (await cache.match('index.html')) || (await cache.match('./')) || Response.error();
      }
    })());
    return;
  }

  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const hit = await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      // On ne met en cache que ce qui appartient à l'application.
      if (res.ok && res.type === 'basic') cache.put(req, res.clone());
      return res;
    } catch (e) {
      return Response.error();
    }
  })());
});
