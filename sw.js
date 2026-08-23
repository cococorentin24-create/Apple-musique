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
//      exploitable. Sert de "boîte noire" : contrairement à un log dans
//      IndexedDB (géré par index.html, donc inatteignable si l'app ne
//      charge jamais à cause du crash lui-même), ce cache est écrit
//      directement par ce fichier, à l'instant T du crash, sans dépendre
//      d'index.html qui n'est peut-être pas encore chargé.
//
// COMMENT LES MISES À JOUR FONCTIONNENT ICI :
//   Le navigateur ne réexamine ce fichier que si son CONTENU change, octet
//   pour octet (mécanisme natif du navigateur, pas quelque chose que ce
//   fichier contrôle). C'est pourquoi APP_VERSION ci-dessous DOIT être
//   changée à chaque nouvelle version d'index.html livrée — sans ce
//   changement, le navigateur ne peut objectivement pas savoir qu'une
//   nouvelle version existe, quel que soit le code exécuté à l'intérieur.
//   Un simple compteur qui s'incrémente de 1 à chaque livraison suffit.
const APP_VERSION = 'v9-crashlog'; // ← CHANGE CE NUMÉRO À CHAQUE NOUVELLE VERSION D'INDEX.HTML

const CACHE_NAME = 'coco-music-' + APP_VERSION;
const TEMP_CACHE_NAME = 'coco-music-' + APP_VERSION + '-installing';
// Nom FIXE, sans APP_VERSION dedans exprès : ce cache doit survivre à
// travers les mises à jour de version (sinon activate() l'effacerait à
// chaque nouvelle version puisqu'il ne correspond plus à CACHE_NAME) et
// rester lisible par une future version d'index.html qui voudrait
// afficher l'historique de crashs même après une mise à jour de l'app.
const CRASH_LOG_CACHE_NAME = 'coco-music-crashlog';
const CRASH_LOG_KEY = 'https://coco-music.local/__crash-log__'; // clé interne, jamais une vraie requête réseau
const CRASH_LOG_MAX_ENTRIES = 60; // boîte noire élargie : avec le log détaillé par étape (activate_start/copy_done/claimed/done + fetch_first_attempt_miss/retry_hit/retry_miss), un seul cycle activate()+fetch concurrent peut produire 5-7 entrées — 20 ne gardait qu'1-2 cycles complets, 60 en garde ~8-10.
const ASSETS = [
  './',
  './index.html'
];

// ---------------------------------------------------------------------------
// Écrit une entrée dans la boîte noire de crash (Cache API, PAS IndexedDB —
// voir architecture ci-dessus). Best-effort : si cette écriture échoue elle
// aussi (cas extrême), on l'avale silencieusement pour ne jamais empêcher le
// vrai fallback (la Response 503) d'être renvoyé au navigateur.
// ---------------------------------------------------------------------------
async function _appendCrashLog(entry) {
  try {
    const logCache = await caches.open(CRASH_LOG_CACHE_NAME);
    let existing = [];
    const prevRes = await logCache.match(CRASH_LOG_KEY);
    if (prevRes) {
      try { existing = await prevRes.json(); } catch (e) { existing = []; }
    }
    existing.push(entry);
    // Ne garde que les N dernières entrées — boîte noire courte, pas un
    // fichier qui grossit indéfiniment sur un appareil qui reste des mois.
    if (existing.length > CRASH_LOG_MAX_ENTRIES) {
      existing = existing.slice(existing.length - CRASH_LOG_MAX_ENTRIES);
    }
    await logCache.put(
      CRASH_LOG_KEY,
      new Response(JSON.stringify(existing), { headers: { 'Content-Type': 'application/json' } })
    );
  } catch (e) {
    // Best-effort — voir commentaire ci-dessus.
  }
}

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
        // Boîte noire : ce cas précis (install() qui échoue) est justement
        // le suspect n°1 pour expliquer un caches.keys() vide plus tard —
        // si install() n'a JAMAIS réussi une seule fois sur cet appareil
        // (première visite avec coupure réseau en plein téléchargement,
        // par exemple), CACHE_NAME lui-même n'existe pas encore et le
        // fetch handler n'aura rien à servir hors ligne.
        await _appendCrashLog({
          t: new Date().toISOString(),
          type: 'install_failed',
          appVersion: APP_VERSION,
          error: String(err && err.message || err)
        });
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
      const _t0 = Date.now();
      await _appendCrashLog({ t: new Date().toISOString(), type: 'activate_start', appVersion: APP_VERSION });

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
        await _appendCrashLog({
          t: new Date().toISOString(), type: 'activate_copy_done', appVersion: APP_VERSION,
          msSinceStart: Date.now() - _t0, entriesCopied: keys.length
        });
      } else {
        await _appendCrashLog({
          t: new Date().toISOString(), type: 'activate_no_temp_cache', appVersion: APP_VERSION,
          msSinceStart: Date.now() - _t0
        });
      }

      // Prend le contrôle des clients AVANT de supprimer l'ancien cache
      // (inversion volontaire par rapport à l'ordre précédent — voir
      // pourquoi ci-dessous), et surtout : laisse un court délai après pour
      // qu'une navigation déjà en vol au moment de ce basculement ait le
      // temps de retomber sur le nouveau CACHE_NAME (déjà pleinement
      // peuplé, voir ci-dessus) plutôt que sur une fenêtre où l'ancien
      // cache est supprimé mais aucune requête n'a encore pu retenter.
      // CONFIRMÉ par 2 logs de crash réels (offline_fallback_miss avec
      // caches.keys() ne renvoyant que CRASH_LOG_CACHE_NAME) : sans ce
      // délai, une requête concurrente arrivant pile entre l'ancien
      // addEventListener('activate') et self.clients.claim() pouvait
      // tomber dans cette fenêtre. event.waitUntil() protège le cycle de
      // vie de CE handler mais pas les fetch d'onglets déjà ouverts, donc
      // ce délai est bien nécessaire même si tout ici est déjà await.
      await self.clients.claim();
      await _appendCrashLog({
        t: new Date().toISOString(), type: 'activate_claimed', appVersion: APP_VERSION,
        msSinceStart: Date.now() - _t0
      });
      await new Promise((res) => setTimeout(res, 300));

      // Supprime maintenant TOUS les caches d'une version différente de
      // celle-ci (l'ancien CACHE_NAME d'une précédente APP_VERSION, tout
      // résidu -installing orphelin d'un échec précédent...) — SAUF le
      // journal de crash (CRASH_LOG_CACHE_NAME), qui doit survivre à
      // travers les mises à jour pour rester consultable ensuite. C'est
      // sécuritaire ici uniquement parce qu'on vient de confirmer que
      // CACHE_NAME (la nouvelle version) est déjà pleinement peuplé.
      const allKeys = await caches.keys();
      const toDelete = allKeys.filter((k) => k !== CACHE_NAME && k !== CRASH_LOG_CACHE_NAME);
      await Promise.all(toDelete.map((k) => caches.delete(k)));

      await _appendCrashLog({
        t: new Date().toISOString(), type: 'activate_done', appVersion: APP_VERSION,
        msSinceStart: Date.now() - _t0, cachesDeleted: toDelete, cachesRemaining: [CACHE_NAME, CRASH_LOG_CACHE_NAME].filter((k) => allKeys.includes(k))
      });
    })()
  );
});

// ---------------------------------------------------------------------------
// MESSAGE — permet à index.html de forcer une réinitialisation complète du
// code de l'app (pas des données) à la demande explicite de l'utilisateur,
// et de lire le journal de crash offline pour l'afficher/copier dans
// Réglages.
// ---------------------------------------------------------------------------
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'RESET_APP_CACHE') {
    event.waitUntil(
      (async () => {
        // Supprime uniquement les caches gérés par CE fichier (le code) —
        // n'a physiquement aucun moyen de toucher IndexedDB, qui vit dans
        // un espace de stockage complètement différent et n'est jamais
        // référencé nulle part dans ce fichier. Le journal de crash N'EST
        // PAS effacé par un reset app : c'est un historique de diagnostic,
        // pas du "code d'app" — un reset ne doit pas effacer la preuve du
        // problème qu'il vient justement corriger. Effacement séparé via
        // CLEAR_CRASH_LOG ci-dessous si l'utilisateur le veut explicitement.
        const allKeys = await caches.keys();
        await Promise.all(
          allKeys.filter((k) => k !== CRASH_LOG_CACHE_NAME).map((k) => caches.delete(k))
        );
        // Redémarre proprement : la prochaine visite déclenchera un nouvel
        // install() qui re-téléchargera tout depuis zéro.
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
// jamais undefined/null. Ci-dessous, chaque chemin (cache trouvé / réseau
// OK / réseau KO sans cache) se termine toujours par une vraie Response.
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
      // différent...).
      //
      // RETRY (confirmé par 2 logs de crash réels, l'un online:false l'autre
      // online:true — donc pas un problème réseau) : ce match peut tomber
      // pile pendant l'exécution d'activate(), qui supprime l'ancien cache
      // AVANT que clients.claim() ne termine. event.waitUntil() protège le
      // cycle de vie du SW mais pas les fetch des clients déjà ouverts — une
      // navigation concurrente peut donc arriver dans cette fenêtre étroite
      // où l'ancien cache vient d'être supprimé. Un seul retry après un
      // court délai laisse le temps à activate() de finir sans changer le
      // comportement dans le cas normal (qui retourne toujours dès le 1er
      // essai, ce await supplémentaire n'existe que si le premier échoue).
      let cached = await caches.match(event.request, { ignoreSearch: true });
      if (!cached) {
        // Log du 1er échec AVANT le retry — si le retry réussit quand même
        // juste après, on veut savoir que ça a foiré une fois, sinon cette
        // quasi-collision resterait invisible (seul le résultat final était
        // loggé avant). appVersion ici, pas juste dans le crash final : sert
        // à recouper avec activate_start/activate_done de la MÊME version
        // pour confirmer si le retry est bien tombé pendant un activate().
        await _appendCrashLog({
          t: new Date().toISOString(), type: 'fetch_first_attempt_miss', appVersion: APP_VERSION,
          requestedUrl: url.pathname, mode: event.request.mode
        });
        await new Promise((res) => setTimeout(res, 300));
        cached = await caches.match(event.request, { ignoreSearch: true });
        await _appendCrashLog({
          t: new Date().toISOString(), type: cached ? 'fetch_retry_hit' : 'fetch_retry_miss', appVersion: APP_VERSION,
          requestedUrl: url.pathname, mode: event.request.mode
        });
      }
      if (cached) return cached;

      // 2. Sinon, réseau.
      try {
        const fresh = await fetch(event.request);
        return fresh;
      } catch (err) {
        // 3. Réseau KO ET rien en cache : on ne renvoie JAMAIS undefined.
        const acceptsHTML = (event.request.headers.get('accept') || '').includes('text/html');
        const looksLikeDocument = url.pathname === '/' || url.pathname.endsWith('/index.html') || url.pathname === '';
        const wantsHTML = event.request.mode === 'navigate' || acceptsHTML || looksLikeDocument;
        if (wantsHTML) {
          let fallbackPage = (await caches.match('./index.html', { ignoreSearch: true }))
            || (await caches.match('./', { ignoreSearch: true }));
          // Même retry que ci-dessus, même raison : ce fallback est
          // exactement celui qui échouait dans les 2 logs de crash réels
          // (étape 2 du diagnostic dans le doc de passation). Un seul essai
          // supplémentaire après le même court délai.
          if (!fallbackPage) {
            await _appendCrashLog({
              t: new Date().toISOString(), type: 'fetch_fallback_first_attempt_miss', appVersion: APP_VERSION,
              requestedUrl: url.pathname, mode: event.request.mode
            });
            await new Promise((res) => setTimeout(res, 300));
            fallbackPage = (await caches.match('./index.html', { ignoreSearch: true }))
              || (await caches.match('./', { ignoreSearch: true }));
            await _appendCrashLog({
              t: new Date().toISOString(), type: fallbackPage ? 'fetch_fallback_retry_hit' : 'fetch_fallback_retry_miss', appVersion: APP_VERSION,
              requestedUrl: url.pathname, mode: event.request.mode
            });
          }
          if (fallbackPage) return fallbackPage;
        }

        // On atteint cette ligne uniquement dans le cas déjà cassé : ni le
        // cache exact, ni le fallback index.html n'ont rien donné. C'est
        // exactement l'instant à enregistrer dans la boîte noire — AVANT de
        // renvoyer la Response 503, pour capturer l'état précis qui a mené
        // à ce crash, avant que l'utilisateur ne puisse rien cliquer.
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
          appVersion: APP_VERSION,
          requestedUrl: url.pathname,
          mode: event.request.mode,
          wantsHTML,
          online: self.navigator ? self.navigator.onLine : null,
          caches: cacheInventory
        });

        // Dernier recours absolu : une vraie Response d'erreur, jamais
        // null/undefined, pour que Safari affiche un échec propre plutôt
        // que de crasher sur "Returned response is null".
        return new Response(
          'Hors ligne : ressource indisponible.\n\n' +
          'Ce crash a été enregistré automatiquement. Rouvre l\'app quand tu as du réseau, ' +
          'puis va dans Réglages > Cloud > "🪵 Copier le journal de crash offline" pour le récupérer.',
          { status: 503, statusText: 'Offline', headers: { 'Content-Type': 'text/plain; charset=utf-8' } }
        );
      }
    })()
  );
});
