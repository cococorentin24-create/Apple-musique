const CACHE_NAME = 'coco-music-v1';
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
  e.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (e) => {
  e.respondWith(
    caches.match(e.request).then((response) => response || fetch(e.request))
  );
});
