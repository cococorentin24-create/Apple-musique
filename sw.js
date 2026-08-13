// ============================================================================
// Coco Music — Service Worker
// ============================================================================
// ARCHITECTURE (3 couches strictement séparées) :
//   1. Cache du code de l'app (CACHE_NAME ci-dessous) — index.html, sw.js.
//      C'est la SEULE chose que ce fichier gère.
//   2. Données utilisateur (bibliothèque, playlists, favoris) — IndexedDB,
//      gérée entièrement par index.html, JAMAIS touchée ici. Aucune ligne de
//      ce fichier n'ouvre ni ne lit IndexedDB.
//   3. Ressources réseau externes (Apple Music, paroles, radios, CDN) —
//      JAMAIS interceptées, JAMAIS mises en cache (voir le tout début du
//      handler 'fetch' plus bas). Se comportent exactement comme si ce
//      Service Worker n'existait pas.
//
// COMMENT LES MISES À JOUR FONCTIONNENT ICI :
//   Le navigateur ne réexamine ce fichier que si son CONTENU change, octet
//   pour octet (mécanisme natif du navigateur, pas quelque chose que ce
//   fichier contrôle). C'est pourquoi APP_VERSION ci-dessous DOIT être
//   changée à chaque nouvelle version d'index.html livrée — sans ce
//   changement, le navigateur ne peut objectivement pas savoir qu'une
//   nouvelle version existe, quel que soit le code exécuté à l'intérieur.
//   Un simple compteur qui s'incrémente de 1 à chaque livraison suffit.
const APP_VERSION = 'v6'; // ← CHANGE CE NUMÉRO À CHAQUE NOUVELLE VERSION D'INDEX.HTML

const CACHE_NAME = 'coco-music-' + APP_VERSION;
const TEMP_CACHE_NAME = 'coco-music-' + APP_VERSION + '-installing';
const ASSETS = [
  './',
  './index.html'
];

// ---------------------------------------------------------------------------
// INSTALL — télécharge la nouvelle version dans un cache TEMPORAIRE d'abord.
// Le cache actif (CACHE_NAME, servant les onglets déjà ouverts) n'est jamais
// touché ici — voir ACTIVATE pour le vrai remplacement, seulement une fois
// le téléchargement confirmé intégralement réussi.
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        const tempCache = await caches.open(TEMP_CACHE_NAME);
        // IMPORTANT : { cache: 'reload' } sur chaque requête force le
        // navigateur à recontacter le réseau et à ignorer son cache HTTP
        // habituel (celui contrôlé par les en-têtes Cache-Control du
        // serveur, ex. GitHub Pages) pour CES fichiers précis. Sans ça,
        // cache.addAll() peut recevoir depuis le cache HTTP du navigateur
        // une copie d'index.html vieille de plusieurs minutes/heures même
        // si le fichier a bel et bien changé sur le serveur — c'est la
        // cause la plus fréquente d'une "mise à jour qui ne se fait
        // jamais vraiment" : le Service Worker croit avoir téléchargé le
        // nouveau fichier alors qu'il a en fait re-caché l'ancien.
        await Promise.all(ASSETS.map(async (url) => {
          const req = new Request(url, { cache: 'reload' });
          const res = await fetch(req);
          if (!res.ok) throw new Error('Échec réseau pour ' + url + ' (' + res.status + ')');
          await tempCache.put(url, res);
        }));
        // Le téléchargement a réussi intégralement : on peut maintenant
        // prendre le contrôle dès que possible (voir activate).
        self.skipWaiting();
      } catch (err) {
        // Échec du téléchargement (réseau coupé en cours de route, fichier
        // manquant, etc.) : on nettoie le cache temporaire partiel et on
        // NE FAIT RIEN d'autre. L'ancien Service Worker (et son cache
        // CACHE_NAME existant) reste actif et continue de servir l'app
        // normalement — c'est exactement l'exigence "en cas d'échec,
        // conserve intégralement l'ancien cache".
        try { await caches.delete(TEMP_CACHE_NAME); } catch (e) {}
        console.error('[SW] Échec du téléchargement de la mise à jour, ancienne version conservée :', err);
        // On NE rappelle PAS self.skipWaiting() ici — si on l'appelait
        // quand même, ce SW passerait actif avec un cache vide/partiel.
        // En ne l'appelant pas, ce SW installé-mais-en-échec reste en
        // 'waiting' indéfiniment et ne prendra jamais le contrôle tant
        // qu'aucune version saine n'aura été installée par-dessus.
      }
    })()
  );
});

// ---------------------------------------------------------------------------
// ACTIVATE — ne s'exécute QUE si install() a réussi jusqu'au bout (sinon ce
// Service Worker ne serait jamais passé en 'waiting' puis 'activating').
// C'est le SEUL endroit où l'ancien cache est supprimé, et seulement après
// avoir confirmé que le nouveau cache temporaire existe bel et bien.
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const tempExists = await caches.has(TEMP_CACHE_NAME);
      if (tempExists) {
        // Bascule le cache temporaire (entièrement téléchargé, confirmé) en
        // cache actif définitif pour cette version.
        const tempCache = await caches.open(TEMP_CACHE_NAME);
        const keys = await tempCache.keys();
        const newCache = await caches.open(CACHE_NAME);
        await Promise.all(keys.map(async (req) => {
          const res = await tempCache.match(req);
          if (res) await newCache.put(req, res);
        }));
        await caches.delete(TEMP_CACHE_NAME);
      }
      // Supprime maintenant TOUS les caches d'une version différente de
      // celle-ci (l'ancien CACHE_NAME d'une précédente APP_VERSION, tout
      // résidu -installing orphelin d'un échec précédent...). C'est
      // sécuritaire ici uniquement parce qu'on vient de confirmer que
      // CACHE_NAME (la nouvelle version) est déjà pleinement peuplé.
      const allKeys = await caches.keys();
      await Promise.all(
        allKeys
          .filter((k) => k !== CACHE_NAME)
          .map((k) => caches.delete(k))
      );
      await self.clients.claim();
    })()
  );
});

// ---------------------------------------------------------------------------
// MESSAGE — permet à index.html de forcer une réinitialisation complète du
// code de l'app (pas des données) à la demande explicite de l'utilisateur,
// par exemple depuis un bouton "réparer/réinitialiser l'app" dans les
// paramètres. Supprime uniquement les caches gérés par CE fichier
// (le code) — n'a physiquement aucun moyen de toucher IndexedDB, qui vit
// dans un espace de stockage complètement différent et n'est jamais
// référencé nulle part dans ce fichier.
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'RESET_APP_CACHE') {
    event.waitUntil(
      (async () => {
        const allKeys = await caches.keys();
        await Promise.all(allKeys.map((k) => caches.delete(k)));
        // Redémarre proprement : la prochaine visite déclenchera un nouvel
        // install() qui re-téléchargera tout depuis zéro.
        const clients = await self.clients.matchAll();
        clients.forEach((client) => client.postMessage({ type: 'CACHE_RESET_DONE' }));
      })()
    );
  }
});

// ---------------------------------------------------------------------------
// FETCH — stratégie "cache d'abord, réseau en secours" UNIQUEMENT pour les
// ressources de ce site. Tout le reste (Apple Music, paroles, radios, CDN,
// n'importe quel autre domaine) n'est JAMAIS intercepté : le navigateur
// gère ces requêtes exactement comme si ce Service Worker n'existait pas.
//
// RÈGLE D'OR (c'est le bug qui causait le crash Safari "Returned response
// is null") : respondWith() DOIT toujours recevoir une vraie Response,
// jamais undefined/null. Avant, le fallback réseau faisait
// `.catch(() => cached)` — si `cached` valait undefined (ressource jamais
// mise en cache, ou cache vidé) ET que le réseau échouait (mode avion,
// hors ligne...), la Promise se résolvait quand même avec `undefined`,
// et Safari plantait au lieu d'afficher une page hors-ligne propre.
// Ci-dessous, chaque chemin (cache trouvé / réseau OK / réseau KO sans
// cache) se termine toujours par une vraie Response.
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Ne JAMAIS intercepter les requêtes vers un autre domaine (API Apple
  // Music, paroles, radios, CDN...). C'est la ligne la plus importante de
  // tout ce fichier : sans elle, une requête vers itunes.apple.com (ou
  // n'importe quelle autre API) passerait par ce handler, et le moindre
  // souci (CORS, réseau, timeout) remonterait comme une erreur gérée par CE
  // fichier au lieu du comportement natif du navigateur.
  if (url.origin !== self.location.origin) return;

  // Seules les requêtes GET se mettent en cache (POST/PUT n'ont pas de sens ici).
  if (event.request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      // 1. Cache d'abord — ignoreSearch:true : un match strict sur l'URL
      // complète (query string incluse) peut échouer alors que le fichier
      // EST bel et bien en cache, si la requête réelle diffère légèrement
      // de celle mise en cache au départ (paramètre ajouté, encodage
      // différent...). C'était la première cause suspectée du bug "au
      // bout de 30min" : le fichier était en cache mais ne matchait plus.
      const cached = await caches.match(event.request, { ignoreSearch: true });
      if (cached) return cached;

      // 2. Sinon, réseau.
      try {
        const fresh = await fetch(event.request);
        return fresh;
      } catch (err) {
        // 3. Réseau KO ET rien en cache : on ne renvoie JAMAIS undefined.
        //
        // Le fallback ne dépend plus uniquement de mode==='navigate'.
        // Quand iOS ranime une PWA après une longue mise en veille
        // (~30min et plus), la requête de retour peut être reconstruite
        // par le système sans porter mode:'navigate' — parfois
        // 'same-origin', parfois sans le header Accept habituel. Se fier
        // uniquement à 'navigate' faisait sauter ce filet de sécurité
        // exactement dans ce cas de figure, et laissait passer directement
        // le message d'erreur brut — ce qui correspond au bug observé.
        // On élargit donc la condition à toute requête qui ressemble à
        // une demande de document HTML (Accept contient text/html, ou le
        // chemin vise la racine / index.html), en plus de mode==='navigate'.
        const acceptsHTML = (event.request.headers.get('accept') || '').includes('text/html');
        const looksLikeDocument = url.pathname === '/' || url.pathname.endsWith('/index.html') || url.pathname === '';
        const wantsHTML = event.request.mode === 'navigate' || acceptsHTML || looksLikeDocument;
        if (wantsHTML) {
          const fallbackPage = (await caches.match('./index.html', { ignoreSearch: true }))
            || (await caches.match('./', { ignoreSearch: true }));
          if (fallbackPage) return fallbackPage;
        }
        // Dernier recours absolu : une vraie Response d'erreur, jamais
        // null/undefined, pour que Safari affiche un échec propre plutôt
        // que de crasher sur "Returned response is null".
        return new Response(
          'Hors ligne : ressource indisponible.',
          { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
        );
      }
    })()
  );
});
