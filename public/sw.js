/*
 * Keeps a copy of the page and its scripts on the device, so a phone opening lofiwave from its home screen gets the
 * page even when the machine behind it is asleep or off, and can say so, instead of a white screen while it waits.
 * Network first: a copy is only used when the network fails or takes longer than NET_WAIT_MS. /api is never cached.
 */
const CACHE = "lofiwave-shell-v1";
const NET_WAIT_MS = 3000;
const SHELL = [
  "/", "/app.js", "/chat.js", "/style.css", "/logo.png", "/favicon.png",
  "/vendor/xterm.css", "/vendor/xterm.js", "/vendor/addon-fit.js", "/vendor/addon-webgl.js",
  "/vendor/marked.min.js", "/vendor/purify.min.js", "/vendor/highlight.min.js",
  "/vendor/fonts/instrument-sans-latin.woff2",
];

self.addEventListener("install", (e) => {
  self.skipWaiting();
  // One missing file shouldn't stop the rest from being kept.
  e.waitUntil(caches.open(CACHE).then((c) => Promise.all(SHELL.map((p) => c.add(p).catch(() => {})))));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== location.origin || url.pathname.startsWith("/api")) return;
  e.respondWith(respond(req, e));
});

async function respond(req, e) {
  const net = fetch(req).then(async (res) => {
    if (res.ok && res.type === "basic") { const copy = res.clone(); await (await caches.open(CACHE)).put(req, copy); }
    return res;
  });
  e.waitUntil(net.catch(() => {})); // keep refreshing the copy even when the copy answered first
  const cached = await caches.match(req, { ignoreSearch: true });
  if (!cached) return net;
  return Promise.race([net.catch(() => cached), new Promise((r) => setTimeout(() => r(cached), NET_WAIT_MS))]);
}
