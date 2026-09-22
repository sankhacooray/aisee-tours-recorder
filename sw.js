/* Service worker — versioned cache.
 * Bump CACHE on each deploy (deploy.py substitutes 20260922-134157).
 * Navigation: network-first (fresh HTML). Static assets: cache-first (offline shell).
 * Never caches the Google Maps script or the backend API (always network). */

var CACHE = 'recorder-20260922-134157';
var ASSETS = ['./', './index.html', './styles.css', './app.js', './manifest.webmanifest', './icon.svg'];

self.addEventListener('install', function (e) {
  e.waitUntil(caches.open(CACHE).then(function (c) { return c.addAll(ASSETS); }).then(function () { return self.skipWaiting(); }));
});

self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (keys) {
    return Promise.all(keys.filter(function (k) { return k !== CACHE; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});

self.addEventListener('fetch', function (e) {
  var url = new URL(e.request.url);
  // Only handle our own origin; let Maps + backend API go straight to network.
  if (url.origin !== self.location.origin) return;

  if (e.request.mode === 'navigate') {
    // Always revalidate HTML against the network (bypass the browser's 10-min
    // HTTP cache from GitHub Pages) so a new deploy shows up on the next load.
    e.respondWith(fetch(e.request, { cache: 'no-store' }).catch(function () { return caches.match('./index.html'); }));
    return;
  }
  e.respondWith(caches.match(e.request).then(function (hit) { return hit || fetch(e.request); }));
});
