/* global self, caches */
const META_CACHE = "chatwerk-overlay-meta-v2";
const PAIR_PREFIX = "chatwerk-overlay-pair-";
const ACTIVE_KEY = new URL("/__chatwerk_overlay_pair__", self.location.origin).href;
let overlayUpdate = Promise.resolve();

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("message", (event) => {
  if (event.data?.type !== "populate-overlay") return;
  const request = new Request(new URL("/overlay", self.location.origin), { credentials: "same-origin" });
  event.waitUntil(queueOverlayUpdate(request).catch(() => undefined));
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || !isOverlayDocumentOrAsset(url.pathname)) return;

  if (url.pathname === "/overlay") {
    event.respondWith(queueOverlayUpdate(request));
    return;
  }
  event.respondWith(fetchAssetOrCached(request));
});

function queueOverlayUpdate(request) {
  const work = overlayUpdate.then(() => updateOverlayPair(request));
  overlayUpdate = work.catch(() => undefined);
  return work;
}

async function updateOverlayPair(request) {
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await cachedResponse(request);
    if (cached) return cached;
    throw error;
  }
  if (!response.ok) return (await cachedResponse(request)) || response;

  const html = await response.clone().text();
  const assets = referencedAssets(html);
  const assetResponses = [];
  for (const asset of assets) {
    let assetResponse;
    try {
      assetResponse = await fetch(asset);
    } catch {
      return (await cachedResponse(request)) || response;
    }
    if (!assetResponse.ok) return (await cachedResponse(request)) || response;
    assetResponses.push([asset, assetResponse]);
  }

  const pairName = `${PAIR_PREFIX}${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  try {
    const pair = await caches.open(pairName);
    for (const [asset, assetResponse] of assetResponses) {
      await pair.put(asset, assetResponse.clone());
    }
    await pair.put(request, response.clone());
    await commitPair(pairName);
    try {
      await pruneAfterCommit();
    } catch {
      // Keep the newly committed pair even if cleanup has to wait for another commit.
    }
    return response;
  } catch {
    try { await caches.delete(pairName); } catch { /* The old active pointer remains authoritative. */ }
    // Asset fetches succeeded, so a cache write failure must not replace fresh HTML with an old pair.
  }
  return response;
}

async function fetchAssetOrCached(request) {
  try {
    const response = await fetch(request);
    if (response.ok) return response;
    if (response.status === 404 || response.status >= 500) {
      return (await cachedResponse(request)) || response;
    }
    return response;
  } catch (error) {
    const cached = await cachedResponse(request);
    if (cached) return cached;
    throw error;
  }
}

function isOverlayDocumentOrAsset(pathname) {
  return pathname === "/overlay" || pathname.startsWith("/assets/");
}

function referencedAssets(html) {
  const assets = new Map();
  for (const match of html.matchAll(/(?:src|href)\s*=\s*["']([^"']+)["']/giu)) {
    try {
      const url = new URL(match[1], self.location.origin);
      if (url.origin === self.location.origin && url.pathname.startsWith("/assets/")) {
        assets.set(url.href, new Request(url.href, { credentials: "same-origin" }));
      }
    } catch {
      // Ignore malformed or cross-origin asset references.
    }
  }
  return [...assets.values()];
}

async function pairNames() {
  const metadata = await caches.open(META_CACHE);
  const active = await metadata.match(ACTIVE_KEY);
  if (!active) return [];
  try {
    const value = await active.json();
    return Array.isArray(value) ? value.filter((name) => typeof name === "string" && name.startsWith(PAIR_PREFIX)) : [];
  } catch {
    return [];
  }
}

async function commitPair(name) {
  const previous = await pairNames();
  const metadata = await caches.open(META_CACHE);
  await metadata.put(ACTIVE_KEY, Response.json([name, ...previous.slice(0, 1)]));
}

async function cachedResponse(request) {
  for (const name of await pairNames()) {
    const response = await (await caches.open(name)).match(request);
    if (response) return response;
  }
  return undefined;
}

async function pruneAfterCommit() {
  const keep = new Set(await pairNames());
  for (const name of await caches.keys()) {
    if (name.startsWith(PAIR_PREFIX) && !keep.has(name)) await caches.delete(name);
  }
}
