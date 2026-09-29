/** A build-specific worker without filesystem reads or manually maintained version numbers.
 * Keep its cache policy deliberately small: public shell and immutable Next assets only.
 * The returned classic JavaScript is also executed by the VM behavior tests. */
export function serviceWorkerSource(buildId: string): string {
  return `const BUILD_ID = ${JSON.stringify(buildId)};\n` + String.raw`
const STATIC_CACHE = "chronicle-static-v1";
const SHELL_PREFIX = "chronicle-offline-";
const SHELL_CACHE = SHELL_PREFIX + BUILD_ID;
const OFFLINE_URL = "/offline.html";
const PRECACHE = [OFFLINE_URL, "/icon.svg", "/icons/icon-192.png", "/icons/icon-512.png"];
const MAX_ENTRIES = 160;

self.addEventListener("install", (event) => {
  // Failed precaching rejects installation; the previous worker stays active.
  event.waitUntil(caches.open(SHELL_CACHE)
    .then((cache) => cache.addAll(PRECACHE.map((path) => new Request(new URL(path, self.location.origin), { cache: "reload", credentials: "omit" }))))
    .then(() => self.skipWaiting()));
});

function publicResponse(response) {
  return response.ok && response.type === "basic" && !response.redirected &&
    !/text\/(?:html|x-component)/i.test(response.headers.get("content-type") || "") &&
    !/private|no-store/i.test(response.headers.get("cache-control") || "");
}

async function trim(cache) {
  const keys = await cache.keys();
  for (const key of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) await cache.delete(key);
}

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
    try {
      const keys = await caches.keys();
      const shared = await caches.open(STATIC_CACHE);
      // One-time migration from the previous manually versioned policy. Public
      // icons are excluded because their unversioned URLs must use this build's shell.
      for (const name of keys.filter((key) => /^chronicle-shell-v[12]-static$/.test(key))) {
        const legacy = await caches.open(name);
        for (const request of (await legacy.keys()).slice(-MAX_ENTRIES)) {
          const url = new URL(request.url);
          const response = await legacy.match(request);
          if (url.origin === self.location.origin && url.pathname.startsWith("/_next/static/") && !url.search && response && publicResponse(response)) {
            await shared.put(request, response);
          }
        }
        await trim(shared);
        await caches.delete(name);
      }
      await trim(shared);
      // Retain one previous offline shell for in-flight events in a replaced worker.
      const oldShells = keys.filter((key) => (key.startsWith(SHELL_PREFIX) || /^chronicle-shell-v[12]-offline$/.test(key)) && key !== SHELL_CACHE);
      for (const key of oldShells.slice(0, -1)) await caches.delete(key);
    } catch { /* Storage maintenance must not prevent activation or network delivery. */ }
  })());
});

async function reportUnavailable(event) {
  if (!event.clientId) return;
  try {
    const client = await self.clients.get(event.clientId);
    if (client) client.postMessage({ type: "chronicle:asset-unavailable" });
  } catch { /* The tab may have closed. */ }
}

async function staticFirst(event, isShell) {
  const request = event.request;
  let cache;
  try {
    cache = await caches.open(isShell ? SHELL_CACHE : STATIC_CACHE);
    const hit = await cache.match(request);
    if (hit) return hit;
  } catch { /* CacheStorage can be unavailable or evicted. */ }
  let response;
  try { response = await fetch(request); }
  catch (error) { if (!isShell) await reportUnavailable(event); throw error; }
  if (publicResponse(response)) {
    if (cache) {
      try { await cache.put(request, response.clone()); await trim(cache); }
      catch { /* Quota errors cannot turn a successful fetch into a failed asset. */ }
    }
  } else if (!isShell) await reportUnavailable(event);
  return response;
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET" || request.headers.get("RSC") === "1" || request.headers.has("Next-Router-State-Tree")) return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;
  if (request.mode === "navigate") {
    event.respondWith(fetch(request).catch(async () => {
      try { return (await (await caches.open(SHELL_CACHE)).match(OFFLINE_URL)) || Response.error(); }
      catch { return Response.error(); }
    }));
    return;
  }
  const isShell = PRECACHE.includes(url.pathname) && url.pathname !== OFFLINE_URL;
  if (!url.search && (isShell || url.pathname.startsWith("/_next/static/"))) event.respondWith(staticFirst(event, isShell));
});

self.addEventListener("message", (event) => {
  if (event.data === "chronicle:clear-shell") {
    event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key.startsWith("chronicle-")).map((key) => caches.delete(key)))));
  }
});
`;
}
