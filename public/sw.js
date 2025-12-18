const CACHE_NAME = 'ride-v2-2025-12-19';
const STATIC_ASSETS = [
  '/',
  '/index.html',
  '/manifest.json',
  '/css/app.css',
  '/js/storage.js',
  '/js/trip.js',
  '/js/map.js',
  '/js/ui.js',
  '/js/share.js',
  '/js/app.js',
  '/icons/icon-192.png',
  '/icons/icon-512.png'
];

const EXTERNAL_ASSETS = [
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.css',
  'https://unpkg.com/leaflet-routing-machine@3.2.12/dist/leaflet-routing-machine.min.js'
];

// Install event - cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('Caching static assets');
      // Cache static assets
      cache.addAll(STATIC_ASSETS.map(url => new Request(url, { cache: 'reload' })));
      // Cache external assets
      return cache.addAll(EXTERNAL_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate event - clean up old caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((cacheNames) => {
      return Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
    })
  );
  self.clients.claim();
});

// Fetch event - serve from cache, fallback to network
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip tile requests (let them go to network)
  if (url.hostname.includes('tile.openstreetmap.org')) {
    event.respondWith(
      caches.open('tiles-cache').then((cache) => {
        return cache.match(request).then((cached) => {
          const fetched = fetch(request).then((response) => {
            cache.put(request, response.clone());
            return response;
          }).catch(() => cached);
          
          return cached || fetched;
        });
      })
    );
    return;
  }

  // Skip routing API requests
  if (url.hostname.includes('router.project-osrm.org')) {
    event.respondWith(fetch(request));
    return;
  }

  // For other requests, try cache first, then network
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) {
        return cached;
      }

      return fetch(request).then((response) => {
        // Don't cache non-successful responses
        if (!response || response.status !== 200 || response.type !== 'basic') {
          return response;
        }

        // Clone and cache the response
        const responseToCache = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(request, responseToCache);
        });

        return response;
      });
    }).catch(() => {
      // Return offline page for navigation requests
      if (request.mode === 'navigate') {
        return caches.match('/index.html');
      }
    })
  );
});

// Handle share target
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  
  if (url.pathname === '/share' && event.request.method === 'GET') {
    event.respondWith(Response.redirect('/?shared=true'));
  }
});
