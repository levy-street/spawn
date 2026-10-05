// spawn PWA service worker
// Strategy:
//   - Streamed downloads (/__spawn/stream/<token>): answered from the page's
//     own bytes, matched before anything else, never cached, never fetched.
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
      // A new version takes over at once — unless the one in control is still
      // answering a streamed download: that stream lives only in its memory,
      // and taking its clients away would leave it to be stopped mid-file. It
      // then hands over itself, the moment its last stream ends.
      .then(() => streamingElsewhere())
      .then((busy) => (busy ? undefined : self.skipWaiting())),
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

/*
 * Streamed downloads.
 *
 * A browser with no save picker can only save what it is given as a
 * response, so a large file from a host is handed over here: the page opens a
 * stream with a one-time token and a private MessagePort, points a hidden
 * frame at /__spawn/stream/<token>, and this worker answers that request with
 * the bytes the page posts, as an attachment. The response is built here and
 * goes nowhere else: no Cache API, no network, and the token is spent by the
 * first fetch. The URL holds only the token; the file's name arrives on the
 * port, and nothing about it is kept once the stream ends.
 */
const STREAM_PREFIX = "/__spawn/stream/";
const STREAM_TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STREAM_TTL_MS = 60_000;
const streams = new Map();
/** Downloads this worker is answering right now. */
let live = 0;

/** Whether the worker in control is answering a download; an older one without the question isn't. */
function streamingElsewhere() {
  const active = self.registration && self.registration.active;
  if (!active || active === self.serviceWorker) return Promise.resolve(false);
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => {
      channel.port1.close();
      resolve(false);
    }, 1_000);
    channel.port1.onmessage = (message) => {
      clearTimeout(timer);
      channel.port1.close();
      resolve(Boolean(message.data && message.data.busy));
    };
    try {
      active.postMessage({ type: "spawn.stream.busy" }, [channel.port2]);
    } catch {
      clearTimeout(timer);
      resolve(false);
    }
  });
}

/** Nothing streams through this worker any more: a version waiting on it can take over. */
function handOverIfIdle() {
  if (live > 0 || streams.size > 0) return;
  const waiting = self.registration && self.registration.waiting;
  if (waiting) waiting.postMessage({ type: "spawn.sw.take-over" });
}

function streamEnded() {
  live = Math.max(0, live - 1);
  handOverIfIdle();
}

function attachmentDisposition(name) {
  const clean = String(name || "download").replace(/[\r\n"\\/]/g, "_") || "download";
  const ascii = clean.replace(/[^\x20-\x7e]/g, "_");
  const encoded = encodeURIComponent(clean).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}

function streamResponse(token) {
  const entry = STREAM_TOKEN.test(token) ? streams.get(token) : undefined;
  if (!entry) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  streams.delete(token);
  clearTimeout(entry.expiry);
  const port = entry.port;
  let next = null;
  let ended = false;
  const end = () => {
    if (ended) return;
    ended = true;
    streamEnded();
  };
  live += 1;
  const body = new ReadableStream(
    {
      start(controller) {
        port.onmessage = (message) => {
          const data = message.data || {};
          if (data.type === "chunk" && data.bytes instanceof Uint8Array) {
            controller.enqueue(data.bytes);
            if (next) {
              const wake = next;
              next = null;
              wake();
            }
          } else if (data.type === "end") {
            controller.close();
            port.close();
            end();
          } else if (data.type === "abort") {
            controller.error(new Error("download stopped"));
            port.close();
            end();
          }
        };
      },
      pull() {
        port.postMessage({ type: "pull" });
        return new Promise((resolve) => {
          next = resolve;
        });
      },
      cancel() {
        port.postMessage({ type: "cancelled" });
        port.close();
        end();
      },
    },
    { highWaterMark: 16 },
  );
  port.postMessage({ type: "started" });
  const headers = {
    "Content-Type": "application/octet-stream",
    "Content-Disposition": attachmentDisposition(entry.name),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  if (Number.isSafeInteger(entry.size) && entry.size >= 0) headers["Content-Length"] = String(entry.size);
  return new Response(body, { status: 200, headers });
}

self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || typeof data !== "object") return;
  if (data.type === "spawn.stream.open") {
    const port = event.ports && event.ports[0];
    if (!port || typeof data.token !== "string" || !STREAM_TOKEN.test(data.token)) return;
    const size = Number.isSafeInteger(data.size) && data.size >= 0 ? data.size : null;
    const expiry = setTimeout(() => {
      if (streams.get(data.token)?.port === port) streams.delete(data.token);
      port.close();
      handOverIfIdle();
    }, STREAM_TTL_MS);
    streams.set(data.token, { port, name: String(data.name || "download"), size, expiry });
    port.postMessage({ type: "ready" });
  }
  // A new version, installed while this one is in control, asks before it
  // takes over (see "install").
  if (data.type === "spawn.stream.busy") {
    const port = event.ports && event.ports[0];
    if (port) port.postMessage({ busy: live > 0 || streams.size > 0 });
  }
  // Told by the version it replaces that its last download has ended.
  if (data.type === "spawn.sw.take-over") self.skipWaiting();
  // "spawn.stream.ping" needs no answer: receiving it keeps this worker alive
  // while a download is still streaming through it.
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);

  // First, so no other rule can cache or forward a streamed download.
  if (url.origin === self.location.origin && url.pathname.startsWith(STREAM_PREFIX)) {
    event.respondWith(streamResponse(url.pathname.slice(STREAM_PREFIX.length)));
    return;
  }

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
