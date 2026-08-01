const CACHE_NAME = 'coco-music-v2'; // v2 : force le remplacement de l'ancien SW/cache défectueux
const ASSETS = [
  './',
  './index.html' // ⚠️ REMPLACE "index.html" par le vrai nom de ton fichier s'il s'appelle autrement (ex: "Musique.html")
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS))
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    Promise.all([
      self.clients.claim(),
      // Nettoie les anciens caches (v1, etc.) pour ne pas accumuler de versions obsolètes
      caches.keys().then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
      )
    ])
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Ne JAMAIS intercepter les requêtes vers un autre domaine (API Apple
  // Music, paroles, radios, CDN...). Seules les ressources de CE site
  // (même origine) passent par le cache hors-ligne — tout le reste doit
  // se comporter exactement comme si aucun Service Worker n'existait.
  // C'est l'absence de cette vérification qui faisait planter les appels
  // vers itunes.apple.com : ce fetch handler essayait de les reproduire
  // lui-même, et le moindre souci (CORS, réseau) remontait comme une
  // erreur non gérée.
  if (url.origin !== self.location.origin) return;

  // Seules les requêtes GET se mettent en cache (POST/PUT n'ont pas de sens ici)
  if (e.request.method !== 'GET') return;

  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      // .catch() indispensable : sans lui, un échec réseau (hors-ligne,
      // etc.) remonte comme une erreur non interceptée dans respondWith()
      return fetch(e.request).catch(() => cached);
    })
  );
});
