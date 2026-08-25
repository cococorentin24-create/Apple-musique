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
//   4. Journal de crash offline (CRASH_LOG_CACHE_NAME ci-dessous) — un
//      cache séparé, à part, JAMAIS supprimé par activate() (qui ne
//      supprime que les caches coco-music-vN d'une autre version), utilisé
//      UNIQUEMENT pour enregistrer les instants où le fetch handler tombe
//      sur le message d'erreur de dernier recours faute de cache
//      exploitable.
//
// COMMENT LES MISES À JOUR FONCTIONNENT ICI (CORRIGÉ) :
//   Avant : APP_VERSION était une chaîne écrite à la main ('v9-crashlog'),
//   qu'il fallait se souvenir de changer à CHAQUE déploiement d'index.html.
//   Un seul oubli = le navigateur retélécharge sw.js, le trouve identique
//   OCTET POUR OCTET à celui déjà installé (c'est le SEUL critère natif du
//   navigateur pour décider si un SW a "changé"), et n'exécute JAMAIS
//   install()/activate() — la mise à jour ne se propage tout simplement
//   jamais, sans aucune erreur visible. C'est la cause confirmée par le
//   journal de crash fourni : caches.has(CACHE_NAME) renvoie false pendant
//   24h+ d'affilée, ce qui veut dire qu'aucun install() n'a réussi à
//   repeupler le cache sur cette période, alors que le réseau était
//   disponible (crash 5/7 : online=true et pourtant cache absent).
//
//   Fix : CACHE_NAME n'est plus une constante écrite à la main. Il est
//   calculé par install() lui-même, à partir d'un hash du contenu RÉEL
//   d'index.html tel que téléchargé à cet instant. Donc :
//   - Si tu modifies index.html (même un seul caractère) → le hash change
//     automatiquement → nouveau CACHE_NAME → activate() bascule dessus.
//     Impossible d'oublier de "bumper une version" : il n'y a plus de
//     version à bumper à la main.
//   - Le seul cas où une mise à jour ne se propage PAS est si index.html
//     n'a RÉELLEMENT pas changé — ce qui est le comportement correct, pas
//     un bug.
//   - sw.js lui-même doit toujours changer d'un octet pour que le
//     navigateur le re-télécharge et exécute ce nouveau install() — c'est
//     un mécanisme du navigateur, hors de portée de ce fichier. C'est pour
//     ça que index.html force maintenant une vérification BYTE-LEVEL de
//     sw.js lui-même à chaque lancement (voir plus bas dans index.html) au
//     lieu de se reposer sur reg.update() seul.
const SW_FILE_VERSION = 'v10-auto-hash'; // change UNIQUEMENT quand ce fichier sw.js lui-même change (pas index.html)

const CACHE_PREFIX = 'coco-music-';
const TEMP_CACHE_SUFFIX = '-installing';
const CRASH_LOG_CACHE_NAME = 'coco-music-crashlog';
const CRASH_LOG_KEY = 'https://coco-music.local/__crash-log__';
const CRASH_LOG_MAX_ENTRIES = 60;
const ASSETS = [
  './',
  './index.html'
];

// ---------------------------------------------------------------------------
// Le nom du cache actif DOIT survivre à un redémarrage du Service Worker
// (iOS décharge les SW entre les événements sans prévenir). self._pending*
// en mémoire ne suffit pas — on persiste le nom résolu dans le Cache
// Storage lui-même (une petite Response texte), lisible/écrivible depuis
// install(), activate() et fetch() même après un redémarrage complet.
// ---------------------------------------------------------------------------
const ACTIVE_NAME_CACHE = 'coco-music-meta';
const ACTIVE_NAME_KEY = 'https://coco-music.local/__active-cache-name__';

async function _getActiveCacheName() {
  try {
    const metaCache = await caches.open(ACTIVE_NAME_CACHE);
    const res = await metaCache.match(ACTIVE_NAME_KEY);
    if (!res) return null;
    return (await res.text()).trim() || null;
  } catch (e) { return null; }
}
async function _setActiveCacheName(name) {
  try {
    const metaCache = await caches.open(ACTIVE_NAME_CACHE);
    await metaCache.put(ACTIVE_NAME_KEY, new Response(name));
  } catch (e) {}
}
// ---------------------------------------------------------------------------
// Hash court et stable du contenu d'index.html — sert de nom de version
// automatique. SHA-256 tronqué à 16 caractères hex : largement suffisant
// pour éviter toute collision sur le nombre de versions qu'une seule app
// connaîtra jamais, et disponible nativement via crypto.subtle (aucune
// dépendance externe, fonctionne dans un Service Worker).
// ---------------------------------------------------------------------------
async function _hashContent(text) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  const bytes = Array.from(new Uint8Array(buf));
  return bytes.map(b => b.toString(16).padStart(2, '0')).join('').slice(0, 16);
}

async function _appendCrashLog(entry) {
  try {
    const logCache = await caches.open(CRASH_LOG_CACHE_NAME);
    let existing = [];
    const prevRes = await logCache.match(CRASH_LOG_KEY);
    if (prevRes) {
      try { existing = await prevRes.json(); } catch (e) { existing = []; }
    }
    existing.push(entry);
    if (existing.length > CRASH_LOG_MAX_ENTRIES) {
      existing = existing.slice(existing.length - CRASH_LOG_MAX_ENTRIES);
    }
    await logCache.put(
      CRASH_LOG_KEY,
      new Response(JSON.stringify(existing), { headers: { 'Content-Type': 'application/json' } })
    );
  } catch (e) {
    // Best-effort
  }
}

// ---------------------------------------------------------------------------
// Téléchargement + hash + peuplement d'un cache nommé par hash. Utilisée
// par install() (cycle de vie normal du SW) ET par _selfRepairCache()
// (réparation en tâche de fond quand le cache actif a disparu du Cache
// Storage sans passer par un nouveau install()). Peuple DIRECTEMENT
// cacheName (pas de cache temporaire à part) : contrairement à install(),
// il n'y a ici ni ancien SW à laisser tourner en parallèle ni activate() à
// venir pour faire la bascule — le SW actuel EST déjà actif, on répare son
// propre cache sur place.
// ---------------------------------------------------------------------------
async function _downloadAndPopulate(cacheName) {
  const htmlReq = new Request('./index.html', { cache: 'reload' });
  const htmlRes = await fetch(htmlReq);
  if (!htmlRes.ok) throw new Error('Échec réseau pour ./index.html (' + htmlRes.status + ')');
  const targetCache = await caches.open(cacheName);
  await targetCache.put('./index.html', htmlRes.clone());
  await Promise.all(ASSETS.filter(u => u !== './index.html').map(async (url) => {
    const req = new Request(url, { cache: 'reload' });
    const res = await fetch(req);
    if (!res.ok) throw new Error('Échec réseau pour ' + url + ' (' + res.status + ')');
    await targetCache.put(url, res);
  }));
  return htmlRes;
}

// ---------------------------------------------------------------------------
// INSTALL — télécharge index.html, calcule son hash, et l'utilise comme
// nom de cache. Le cache actif (servant les onglets déjà ouverts) n'est
// jamais touché ici — voir ACTIVATE pour le vrai remplacement.
// ---------------------------------------------------------------------------
self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      try {
        // Télécharge index.html d'abord, SEUL, pour calculer son hash avant
        // de savoir quel nom de cache utiliser — cache: 'reload' pour
        // ignorer le cache HTTP du navigateur et forcer un vrai contact
        // réseau (sinon on hasherait une copie potentiellement périmée).
        const htmlReq = new Request('./index.html', { cache: 'reload' });
        const htmlRes = await fetch(htmlReq);
        if (!htmlRes.ok) throw new Error('Échec réseau pour ./index.html (' + htmlRes.status + ')');
        const htmlText = await htmlRes.clone().text();
        const contentHash = await _hashContent(htmlText);
        const cacheName = CACHE_PREFIX + contentHash;
        const tempCacheName = cacheName + TEMP_CACHE_SUFFIX;

        // Si un cache portant déjà ce hash exact existe, index.html n'a
        // RÉELLEMENT pas changé depuis la dernière install réussie — rien à
        // refaire, mais on le note pour le diagnostic (voir carte Cloud).
        const alreadyExists = await caches.has(cacheName);
        if (alreadyExists) {
          await _setActiveCacheName(cacheName);
          self.skipWaiting();
          return;
        }

        const tempCache = await caches.open(tempCacheName);
        await tempCache.put('./index.html', htmlRes.clone());
        // Le reste des ASSETS (./ notamment) suit la même logique de
        // téléchargement forcé.
        await Promise.all(ASSETS.filter(u => u !== './index.html').map(async (url) => {
          const req = new Request(url, { cache: 'reload' });
          const res = await fetch(req);
          if (!res.ok) throw new Error('Échec réseau pour ' + url + ' (' + res.status + ')');
          await tempCache.put(url, res);
        }));

        // Persisté dans le Cache Storage (pas en mémoire du SW) : survit à
        // un redémarrage du Service Worker par le navigateur entre
        // install() et activate() — iOS décharge les SW agressivement, une
        // simple propriété self.* ne suffit pas à garantir la continuité.
        await _setActiveCacheName(cacheName);
        // Nom du cache temporaire encore à copier, retrouvable par
        // activate() même après un redémarrage : dérivé directement de
        // cacheName (+ TEMP_CACHE_SUFFIX), donc pas besoin d'un stockage
        // séparé pour lui — activate() le recalcule à partir du nom actif.
        self.skipWaiting();
      } catch (err) {
        console.error('[SW] Échec du téléchargement de la mise à jour, ancienne version conservée :', err);
        await _appendCrashLog({
          t: new Date().toISOString(),
          type: 'install_failed',
          swFileVersion: SW_FILE_VERSION,
          error: String(err && err.message || err)
        });
        // Pas de skipWaiting() ici — voir raisonnement original : ce SW
        // reste en 'waiting' indéfiniment plutôt que de prendre le
        // contrôle avec un cache vide/partiel.
      }
    })()
  );
});

// ---------------------------------------------------------------------------
// SELF-REPAIR — déclenchée depuis le fetch handler quand le cache actif a
// disparu du Cache Storage (système qui l'a vidé, cause confirmée par le
// journal de crash fourni) alors qu'aucune nouvelle version de sw.js n'est
// en cours d'installation. Repeuple un cache SUR PLACE, sans dépendre du
// cycle install/activate (qui ne se déclenche que si sw.js change).
// Idempotente et sûre en cas d'appels concurrents (plusieurs requêtes
// fetch simultanées peuvent chacune détecter le cache manquant) : un verrou
// en mémoire simple évite de lancer plusieurs téléchargements en parallèle
// pour la même réparation — un doublon serait sans conséquence grave
// (caches.open avec le même nom est idempotent) mais inutile.
// ---------------------------------------------------------------------------
let _repairInFlight = null;
async function _selfRepairCache() {
  if (_repairInFlight) return _repairInFlight;
  _repairInFlight = (async () => {
    try {
      const htmlReq = new Request('./index.html', { cache: 'reload' });
      const htmlRes = await fetch(htmlReq);
      if (!htmlRes.ok) throw new Error('Échec réseau pour ./index.html (' + htmlRes.status + ')');
      const htmlText = await htmlRes.clone().text();
      const contentHash = await _hashContent(htmlText);
      const cacheName = CACHE_PREFIX + contentHash;
      await _downloadAndPopulate(cacheName);
      await _setActiveCacheName(cacheName);
      await _appendCrashLog({
        t: new Date().toISOString(), type: 'fetch_cache_self_repair_done', swFileVersion: SW_FILE_VERSION,
        newCacheName: cacheName
      });
    } catch (err) {
      await _appendCrashLog({
        t: new Date().toISOString(), type: 'fetch_cache_self_repair_failed', swFileVersion: SW_FILE_VERSION,
        error: String(err && err.message || err)
      });
    } finally {
      _repairInFlight = null;
    }
  })();
  return _repairInFlight;
}

// ---------------------------------------------------------------------------
// ACTIVATE — bascule le cache temporaire (nommé par hash) en cache actif,
// puis supprime tout le reste SAUF le cache actif et le journal de crash.
// Relit le nom actif depuis le Cache Storage (persisté par install()) au
// lieu d'une variable en mémoire, pour rester correct même si le Service
// Worker a redémarré entre install() et activate().
// ---------------------------------------------------------------------------
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const _t0 = Date.now();
      const cacheName = await _getActiveCacheName();
      const tempCacheName = cacheName ? cacheName + TEMP_CACHE_SUFFIX : null;

      await _appendCrashLog({ t: new Date().toISOString(), type: 'activate_start', swFileVersion: SW_FILE_VERSION, resolvedCacheName: cacheName || '(inconnu)' });

      if (tempCacheName && await caches.has(tempCacheName)) {
        const tempCache = await caches.open(tempCacheName);
        const keys = await tempCache.keys();
        const newCache = await caches.open(cacheName);
        await Promise.all(keys.map(async (req) => {
          const res = await tempCache.match(req);
          if (res) await newCache.put(req, res);
        }));
        await caches.delete(tempCacheName);
        await _appendCrashLog({
          t: new Date().toISOString(), type: 'activate_copy_done', swFileVersion: SW_FILE_VERSION,
          msSinceStart: Date.now() - _t0, entriesCopied: keys.length
        });
      } else if (cacheName) {
        // install() a trouvé que ce hash existait déjà (alreadyExists) —
        // rien à copier, le cache visé existe déjà tel quel.
        await _appendCrashLog({
          t: new Date().toISOString(), type: 'activate_no_temp_cache', swFileVersion: SW_FILE_VERSION,
          msSinceStart: Date.now() - _t0
        });
      }

      await self.clients.claim();
      await _appendCrashLog({
        t: new Date().toISOString(), type: 'activate_claimed', swFileVersion: SW_FILE_VERSION,
        msSinceStart: Date.now() - _t0
      });

      // Supprime tout ce qui n'est pas le cache actif résolu, le journal
      // de crash, ni le cache meta qui stocke le nom actif lui-même. Si
      // cacheName est introuvable (le Cache Storage lui-même a été vidé
      // par le système entre install() et activate() — cas extrême mais
      // c'est exactement ce que documente le journal de crash fourni), on
      // ne supprime RIEN par sécurité plutôt que de risquer d'effacer le
      // seul cache valide existant sans savoir lequel c'est.
      if (cacheName) {
        const allKeys = await caches.keys();
        const toDelete = allKeys.filter((k) => k !== cacheName && k !== CRASH_LOG_CACHE_NAME && k !== ACTIVE_NAME_CACHE);
        await Promise.all(toDelete.map((k) => caches.delete(k)));
        await _appendCrashLog({
          t: new Date().toISOString(), type: 'activate_done', swFileVersion: SW_FILE_VERSION,
          msSinceStart: Date.now() - _t0, cachesDeleted: toDelete, cachesRemaining: [cacheName, CRASH_LOG_CACHE_NAME, ACTIVE_NAME_CACHE]
        });
      } else {
        await _appendCrashLog({
          t: new Date().toISOString(), type: 'activate_skipped_cleanup_no_resolved_name', swFileVersion: SW_FILE_VERSION,
          msSinceStart: Date.now() - _t0
        });
      }
    })()
  );
});

// ---------------------------------------------------------------------------
// MESSAGE
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'RESET_APP_CACHE') {
    event.waitUntil(
      (async () => {
        const allKeys = await caches.keys();
        await Promise.all(
          allKeys.filter((k) => k !== CRASH_LOG_CACHE_NAME).map((k) => caches.delete(k))
        );
        const clients = await self.clients.matchAll();
        clients.forEach((client) => client.postMessage({ type: 'CACHE_RESET_DONE' }));
      })()
    );
  } else if (event.data && event.data.type === 'GET_CRASH_LOG') {
    event.waitUntil(
      (async () => {
        let entries = [];
        try {
          const logCache = await caches.open(CRASH_LOG_CACHE_NAME);
          const res = await logCache.match(CRASH_LOG_KEY);
          if (res) entries = await res.json();
        } catch (e) { /* renvoie [] si illisible plutôt que de bloquer */ }
        const client = event.source;
        if (client) client.postMessage({ type: 'CRASH_LOG_RESULT', entries });
      })()
    );
  } else if (event.data && event.data.type === 'CLEAR_CRASH_LOG') {
    event.waitUntil(
      (async () => {
        try { await caches.delete(CRASH_LOG_CACHE_NAME); } catch (e) {}
        const client = event.source;
        if (client) client.postMessage({ type: 'CRASH_LOG_CLEARED' });
      })()
    );
  } else if (event.data && event.data.type === 'GET_ACTIVE_CACHE_NAME') {
    // Permet à index.html d'afficher/vérifier le nom de cache RÉELLEMENT
    // actif (le hash calculé), lu depuis le stockage persistant.
    event.waitUntil(
      (async () => {
        const client = event.source;
        const cacheName = await _getActiveCacheName();
        if (client) client.postMessage({ type: 'ACTIVE_CACHE_NAME_RESULT', cacheName });
      })()
    );
  } else if (event.data && event.data.type === 'CHECK_CONTENT_UPDATE') {
    // LE VRAI MÉCANISME DE MISE À JOUR CONTINUE. Sans ce message, un SW déjà
    // actif ne recalculerait JAMAIS le hash d'index.html — install() (où
    // vit _hashContent) ne s'exécute que si sw.js change d'octet, ce qui
    // recrée exactement le piège de l'ancien APP_VERSION (un fichier à se
    // souvenir de bumper), simplement déplacé de sw.js vers... sw.js quand
    // même. Ici, le SW ACTUELLEMENT actif retélécharge index.html lui-même,
    // recalcule son hash, et si ça diffère du cache actif, bascule dessus
    // directement (réutilise _selfRepairCache, qui peuple + met à jour le
    // pointeur actif) — sans jamais installer un nouveau Service Worker ni
    // dépendre du cycle install/activate natif. index.html appelle ce
    // message à intervalle régulier (voir checkForUpdateOnLaunch) ; si un
    // changement de contenu est détecté, on répond updated:true pour que
    // la page recharge — même flux que controllerchange, déclenché
    // manuellement au lieu d'attendre un nouveau sw.js.
    event.waitUntil(
      (async () => {
        const client = event.source;
        try {
          const htmlReq = new Request('./index.html', { cache: 'reload' });
          const htmlRes = await fetch(htmlReq);
          if (!htmlRes.ok) throw new Error('Échec réseau (' + htmlRes.status + ')');
          const htmlText = await htmlRes.clone().text();
          const contentHash = await _hashContent(htmlText);
          const newCacheName = CACHE_PREFIX + contentHash;
          const currentCacheName = await _getActiveCacheName();

          if (newCacheName === currentCacheName) {
            if (client) client.postMessage({ type: 'CONTENT_UPDATE_RESULT', updated: false });
            return;
          }

          // Contenu différent confirmé : peuple le nouveau cache puis
          // bascule le pointeur actif. Nettoie l'ancien cache une fois le
          // nouveau confirmé en place (même prudence que activate() :
          // jamais de suppression avant confirmation que le remplaçant
          // existe bel et bien).
          await _downloadAndPopulate(newCacheName);
          await _setActiveCacheName(newCacheName);
          if (currentCacheName && currentCacheName !== newCacheName) {
            try { await caches.delete(currentCacheName); } catch (e) {}
          }
          await _appendCrashLog({
            t: new Date().toISOString(), type: 'content_update_applied', swFileVersion: SW_FILE_VERSION,
            previousCacheName: currentCacheName || '(aucun)', newCacheName
          });
          if (client) client.postMessage({ type: 'CONTENT_UPDATE_RESULT', updated: true });
        } catch (err) {
          await _appendCrashLog({
            t: new Date().toISOString(), type: 'content_update_check_failed', swFileVersion: SW_FILE_VERSION,
            error: String(err && err.message || err)
          });
          if (client) client.postMessage({ type: 'CONTENT_UPDATE_RESULT', updated: false, error: String(err && err.message || err) });
        }
      })()
    );
  }
});

// ---------------------------------------------------------------------------
// FETCH — stratégie "cache d'abord, réseau en secours". INCHANGÉ par
// rapport à la version précédente : le comportement hors ligne n'est pas
// touché par ce correctif, qui ne concerne que le nommage/cycle de vie du
// cache (install/activate ci-dessus).
// ---------------------------------------------------------------------------
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;
  if (event.request.method !== 'GET') return;

  event.respondWith(
    (async () => {
      const cached = await caches.match(event.request, { ignoreSearch: true });
      if (cached) return cached;

      let cacheName = await _getActiveCacheName();
      let directMatchWorks = null;
      let cacheStillIndexed = cacheName ? await caches.has(cacheName) : false;

      if (cacheName && cacheStillIndexed) {
        try {
          const directCache = await caches.open(cacheName);
          const directResult = await directCache.match(event.request, { ignoreSearch: true });
          directMatchWorks = !!directResult;
          if (directResult) return directResult;
        } catch (e) {}
      }

      // AUTO-RÉPARATION : le cache actif a disparu de l'index (confirmé
      // par le journal de crash fourni : 55 occurrences sur 60,
      // caches.has(CACHE_NAME)===false pendant 24h+ d'affilée, y compris
      // avec navigator.onLine===true côté page — donc rien ne le
      // repeuplait tout seul, puisque install()/activate() ne se
      // redéclenchent QUE quand sw.js lui-même change d'octet, jamais à
      // cause d'un cache vidé par le système). On tente toujours la
      // réparation ici, en tâche de fond, sans bloquer la requête en
      // cours (qui part sur le réseau normalement juste après) — pas de
      // vérification self.navigator.onLine au préalable : cette propriété
      // n'est pas fiable dans le scope d'un Service Worker (support
      // partiel selon navigateurs), et _selfRepairCache() échoue déjà
      // proprement tout seul si le réseau est indisponible (try/catch,
      // simple entrée de log, aucune conséquence). N'affecte JAMAIS la
      // branche hors-ligne plus bas : celle-ci n'est atteinte que si le
      // fetch réseau échoue, réparation ou pas.
      if (!cacheStillIndexed) {
        await _appendCrashLog({
          t: new Date().toISOString(), type: 'fetch_cache_missing_self_repair_triggered', swFileVersion: SW_FILE_VERSION,
          requestedUrl: url.pathname, previousCacheName: cacheName || '(aucun)'
        });
        // Ne bloque pas la requête en cours sur cette réparation — elle
        // tourne en tâche de fond et bénéficiera aux requêtes SUIVANTES.
        event.waitUntil(_selfRepairCache());
      }

      await _appendCrashLog({
        t: new Date().toISOString(), type: 'fetch_cache_miss_diagnostic', swFileVersion: SW_FILE_VERSION,
        requestedUrl: url.pathname, mode: event.request.mode,
        resolvedCacheName: cacheName || '(inconnu)', cacheStillIndexed, directMatchWorks
      });

      try {
        const fresh = await fetch(event.request);
        return fresh;
      } catch (err) {
        const acceptsHTML = (event.request.headers.get('accept') || '').includes('text/html');
        const looksLikeDocument = url.pathname === '/' || url.pathname.endsWith('/index.html') || url.pathname === '';
        const wantsHTML = event.request.mode === 'navigate' || acceptsHTML || looksLikeDocument;
        if (wantsHTML) {
          const fallbackPage = (await caches.match('./index.html', { ignoreSearch: true }))
            || (await caches.match('./', { ignoreSearch: true }));
          if (fallbackPage) return fallbackPage;
        }

        let cacheInventory = [];
        try {
          const allCacheNames = await caches.keys();
          cacheInventory = await Promise.all(allCacheNames.map(async (name) => {
            const c = await caches.open(name);
            const reqs = await c.keys();
            return { name, entries: reqs.map(r => new URL(r.url).pathname) };
          }));
        } catch (diagErr) {
          cacheInventory = [{ name: '(erreur diagnostic)', entries: [String(diagErr && diagErr.message || diagErr)] }];
        }
        await _appendCrashLog({
          t: new Date().toISOString(),
          type: 'offline_fallback_miss',
          swFileVersion: SW_FILE_VERSION,
          requestedUrl: url.pathname,
          mode: event.request.mode,
          wantsHTML,
          online: self.navigator ? self.navigator.onLine : null,
          caches: cacheInventory
        });

        const retryHtml = `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Coco Music — Reconnexion</title>
<style>
  body { font-family: -apple-system, sans-serif; background: #0a0a0a; color: #fff; display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100vh; margin: 0; padding: 24px; text-align: center; box-sizing: border-box; }
  h1 { font-size: 18px; margin-bottom: 8px; }
  p { font-size: 14px; color: #999; margin: 4px 0; }
  .spinner { width: 32px; height: 32px; border: 3px solid #333; border-top-color: #fff; border-radius: 50%; animation: spin 0.8s linear infinite; margin-bottom: 16px; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .status { margin-top: 16px; font-size: 12px; color: #666; }
</style>
</head>
<body>
<div class="spinner"></div>
<h1>Reconnexion en cours…</h1>
<p>Le cache local n'a pas répondu. Nouvelle tentative en cours.</p>
<p>Ce crash a été enregistré. Réglages &gt; Cloud &gt; "🪵 Copier le journal de crash offline".</p>
<div class="status" id="status">Vérification du Service Worker…</div>
<script>
(function() {
  var statusEl = document.getElementById('status');
  var attempt = 0;
  var maxAttempts = 8;
  var baseDelay = 2000;
  function setStatus(msg) { if (statusEl) statusEl.textContent = msg; }
  function tryServiceWorkerUpdate() {
    var handled = false;
    function callOnce() { if (handled) return; handled = true; tryDirectFetch(); }
    if (!('serviceWorker' in navigator)) { callOnce(); return; }
    navigator.serviceWorker.getRegistration().then(function(reg) {
      if (!reg) { callOnce(); return; }
      reg.addEventListener('updatefound', function() { setStatus('Mise à jour trouvée, installation…'); });
      return reg.update();
    }).then(function() { callOnce(); }).catch(function() { callOnce(); });
  }
  function tryDirectFetch() {
    attempt++;
    if (attempt > maxAttempts) {
      setStatus("Reconnexion impossible pour l'instant. Réessaie plus tard ou vérifie ta connexion.");
      return;
    }
    setStatus('Nouvelle tentative ' + attempt + '/' + maxAttempts + '…');
    fetch('./index.html', { cache: 'no-store' }).then(function(res) {
      if (res.ok) { window.location.reload(); return; }
      scheduleRetry();
    }).catch(function() { scheduleRetry(); });
  }
  function scheduleRetry() {
    var delay = Math.min(baseDelay * attempt, 20000);
    setStatus('Nouvelle tentative dans ' + Math.round(delay / 1000) + 's… (' + attempt + '/' + maxAttempts + ')');
    setTimeout(tryServiceWorkerUpdate, delay);
  }
  tryServiceWorkerUpdate();
})();
</script>
</body>
</html>`;

        return new Response(retryHtml, {
          status: 503, statusText: 'Offline',
          headers: { 'Content-Type': 'text/html; charset=utf-8' }
        });
      }
    })()
  );
});
