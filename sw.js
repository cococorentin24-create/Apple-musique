// Coco Music Service Worker — auto-update without data loss
const CACHE_NAME = 'coco-music-v1';
const ASSETS = ['./index.html', './'];

// Install: cache the app shell
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_NAME)
      .then(c => c.addAll(ASSETS))
      .then(() => self.skipWaiting()) // activate immediately
  );
});

// Activate: clean up old caches
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    ).then(() => self.clients.claim()) // take control immediately
  );
});

// Fetch: stale-while-revalidate
// Serve cache instantly (fast), fetch update in background (fresh next time)
self.addEventListener('fetch', e => {
  // Only cache same-origin navigation/page requests — never cache API/blob/data
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;
  // Don't cache audio/blob URLs
  if (url.protocol === 'blob:') return;

  e.respondWith(
    caches.open(CACHE_NAME).then(cache =>
      cache.match(e.request).then(cached => {
        const networkFetch = fetch(e.request).then(response => {
          // Only cache valid responses
          if (response && response.status === 200) {
            cache.put(e.request, response.clone());
          }
          return response;
        }).catch(() => cached); // offline fallback to cache

        // Return cache immediately, update in background
        return cached || networkFetch;
      })
    )
  );
});
