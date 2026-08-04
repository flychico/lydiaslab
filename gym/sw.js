/* Michelangelo offline cache */
const C = "mangelo-v8";
self.addEventListener("install", e => {
  e.waitUntil(caches.open(C).then(c => c.addAll(["/gym/", "/gym/index.html", "/gym/manifest.json"])));
  self.skipWaiting();
});
self.addEventListener("activate", e => e.waitUntil(clients.claim()));
self.addEventListener("fetch", e => {
  if (e.request.method !== "GET") return;
  e.respondWith(
    fetch(e.request).then(r => {
      const cp = r.clone();
      caches.open(C).then(c => c.put(e.request, cp));
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match("/gym/index.html")))
  );
});
