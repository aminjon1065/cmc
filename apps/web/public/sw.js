/* CMC service worker (P4.4 / ADR-0075).
 * Conservative offline shell: precache the offline fallback + icon + manifest;
 * navigations are network-first and fall back to /offline when unreachable;
 * precached static assets are cache-first. API/RSC requests are left untouched
 * so Next.js navigation/data are never served stale. Registered by PwaRegister.
 */
/* eslint-disable */
const CACHE = "cmc-shell-v1";
const PRECACHE = ["/offline", "/icon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => Promise.allSettled(PRECACHE.map((u) => c.add(u))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === "navigate") {
    event.respondWith(fetch(req).catch(() => caches.match("/offline")));
    return;
  }
  if (PRECACHE.includes(url.pathname)) {
    event.respondWith(caches.match(req).then((r) => r || fetch(req)));
  }
});
