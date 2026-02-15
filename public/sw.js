/**
 * Ride Service Worker — Build-aware caching with seamless updates
 *
 * Strategy:
 *   App shell (HTML/CSS/JS/icons) → Network-first, cache fallback
 *   API requests                  → Network-only (never cached)
 *   Map tiles                     → Stale-while-revalidate (separate cache)
 *   Routing                       → Network-only
 *
 * On activate and every 2 minutes, polls /api/_build.
 * If the server build ID differs → purge app-shell cache, re-fetch assets,
 * and post a 'ride:update' message to all clients so they can reload.
 */

const CACHE_NAME = 'ride-v5';
const TILES_CACHE = 'ride-tiles';

const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/css/global.css',
  '/js/api.js',
  '/js/app.js',
  '/js/app-core.js',
  '/js/auth-controller.js',
  '/js/trip-controller.js',
  '/js/waypoint-controller.js',
  '/js/journal-controller.js',
  '/js/ride-controller.js',
  '/js/utils.js',
  '/js/storage.js',
  '/js/trip.js',
  '/js/map.js',
  '/js/ui.js',
  '/js/share.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const EXTERNAL_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css',
  'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.min.js'
];

/* ── Build version tracking ──────────────────────────────────────────── */
let knownBuildId = null;

async function fetchBuildId() {
  try {
    const res = await fetch('/api/_build', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data.build || null;
  } catch (_) {
    return null;
  }
}

async function checkForUpdate() {
  const remoteBuild = await fetchBuildId();
  if (!remoteBuild) return;

  if (knownBuildId && remoteBuild !== knownBuildId) {
    console.log(`[SW] Build changed: ${knownBuildId} → ${remoteBuild}`);
    knownBuildId = remoteBuild;

    // Purge app-shell cache (keep tiles — they're content-addressed)
    const keys = await caches.keys();
    await Promise.all(keys.filter(k => k !== TILES_CACHE).map(k => caches.delete(k)));

    // Re-populate with fresh assets
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(STATIC_ASSETS.map(u => new Request(u, { cache: 'reload' })));

    // Tell every open tab to reload
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(c => c.postMessage({ type: 'ride:update', build: remoteBuild }));
  } else if (!knownBuildId) {
    knownBuildId = remoteBuild;
  }
}

/* ── Install ─────────────────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      console.log('[SW] Caching app shell');
      await cache.addAll(STATIC_ASSETS.map(u => new Request(u, { cache: 'reload' })));
      await cache.addAll(EXTERNAL_ASSETS);
    })
  );
  self.skipWaiting();
});

/* ── Activate ────────────────────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      // Clean legacy caches
      const keys = await caches.keys();
      await Promise.all(
        keys
          .filter(n => n !== CACHE_NAME && n !== TILES_CACHE)
          .map(n => caches.delete(n))
      );
      await self.clients.claim();
      await checkForUpdate();
    })()
  );
});

/* ── Periodic build polling (every 2 min while SW is alive) ──────── */
setInterval(() => checkForUpdate(), 2 * 60 * 1000);

/* ── Fetch ───────────────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Non-GET → pass through
  if (request.method !== 'GET') return;

  // ── API: network only ──
  if (url.pathname.startsWith('/api/')) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Share target redirect ──
  if (url.pathname === '/share') {
    event.respondWith(Response.redirect('/?shared=true'));
    return;
  }

  // ── App shell: network first, cache fallback ──
  const isAppShell = url.origin === self.location.origin && (
    url.pathname === '/' ||
    url.pathname === '/index.html' ||
    url.pathname === '/manifest.json' ||
    url.pathname.startsWith('/css/') ||
    url.pathname.startsWith('/js/') ||
    url.pathname.startsWith('/icons/')
  );

  if (isAppShell) {
    event.respondWith(
      fetch(request).then((response) => {
        if (response && response.status === 200) {
          const copy = response.clone();
          caches.open(CACHE_NAME).then(c => c.put(request, copy));
        }
        return response;
      }).catch(() => caches.match(request))
    );
    return;
  }

  // ── Map tiles: stale-while-revalidate ──
  if (url.hostname.includes('tile.openstreetmap.org') ||
      url.hostname.includes('basemaps.cartocdn.com') ||
      url.hostname.includes('arcgisonline.com')) {
    event.respondWith(
      caches.open(TILES_CACHE).then((cache) =>
        cache.match(request).then((cached) => {
          const network = fetch(request).then((res) => {
            if (res && res.status === 200) cache.put(request, res.clone());
            return res;
          }).catch(() => cached);
          return cached || network;
        })
      )
    );
    return;
  }

  // ── OSRM routing: network only ──
  if (url.hostname.includes('router.project-osrm.org') ||
      url.hostname.includes('maps.incitat.io')) {
    event.respondWith(fetch(request));
    return;
  }

  // ── Everything else: cache first ──
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }
        const copy = response.clone();
        caches.open(CACHE_NAME).then(c => c.put(request, copy));
        return response;
      });
    }).catch(() => {
      if (request.mode === 'navigate') return caches.match('/index.html');
    })
  );
});
