// spawn PWA service worker
// Strategy:
//   - Static assets (/_next/static/*, /icon-*.png, /manifest.webmanifest): cache-first.
//   - API requests (/api/* and WS upgrades): never cached, network-only (the SW just falls through).
//   - Everything else (HTML pages): network-first with a cache fallback for offline shell.

const CACHE_NAME = "spawn-v1";
const PRECACHE = ["/", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      )
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icon-") ||
    url.pathname === "/manifest.webmanifest"
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // Don't touch API or websocket requests at all.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;
  if (url.origin !== self.location.origin) return;

  if (isStaticAsset(url)) {
    // Cache-first.
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            const copy = res.clone();
            caches.open(CACHE_NAME).then((c) => c.put(req, copy));
            return res;
          }),
      ),
    );
    return;
  }

  // Network-first for navigations and other GETs.
  event.respondWith(
    fetch(req)
      .then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || caches.match("/"))),
  );
});

/*
 * Notification clicks.
 *
 * Alerts are shown through this registration (`registration.showNotification`)
 * rather than the `Notification` constructor, because that is the only path
 * Android and installed PWAs honour — and the only one whose click can be
 * routed. The URL travels on the notification's own data, so the page that
 * raised it decides where it lands.
 *
 * Focus an existing tab where we can rather than opening another one: someone
 * with spawn already open wants that window brought forward, not a second copy
 * of it.
 */
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data && event.notification.data.url;
  const url = typeof target === "string" && target.startsWith("/") ? target : "/app";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if (new URL(client.url).origin !== self.location.origin) continue;
        if ("focus" in client) {
          return client.focus().then((focused) => {
            const nav = focused || client;
            return "navigate" in nav ? nav.navigate(url).catch(() => {}) : undefined;
          });
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});
