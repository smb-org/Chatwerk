const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const HELIX_URL = "https://api.twitch.tv/helix/chat/badges";
const CACHE_CONTROL = "public, max-age=3600, stale-while-revalidate=86400";
const INTERNAL_CACHED_AT = "X-Chatwerk-Cached-At";
const FRESH_MS = 60 * 60 * 1000;
const STALE_WHILE_REVALIDATE_MS = 24 * 60 * 60 * 1000;
const UPSTREAM_MISS_LIMIT = 30;
const UPSTREAM_MISS_WINDOW_MS = 60_000;
const EMPTY_BADGE_PAYLOAD = { data: [] as unknown[], pagination: {} };

export interface BadgeEnvironment {
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
}

interface AppToken {
  accessToken: string;
  expiresAt: number;
}

type TokenEntry = AppToken | Promise<AppToken>;
const appTokens = new Map<string, TokenEntry>();
let upstreamMissWindowStartedAt = Date.now();
let upstreamMisses = 0;

export async function handleBadgeRequest(
  request: Request,
  env: BadgeEnvironment,
  fetcher: typeof fetch = fetch,
  waitUntil: (promise: Promise<unknown>) => void = (promise) => { void promise.catch(() => undefined); },
): Promise<Response | null> {
  const url = new URL(request.url);
  const route = badgeRoute(url.pathname);
  if (!route) return null;

  if (request.method === "OPTIONS") return cors(new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "600",
    },
  }));
  if (request.method !== "GET") return cors(Response.json({ error: "Method not allowed" }, {
    status: 405,
    headers: { Allow: "GET, OPTIONS" },
  }));
  if (route.kind === "channel" && !/^\d{1,20}$/u.test(route.broadcasterId)) {
    return cors(Response.json({ error: "Broadcaster id must be numeric" }, { status: 400 }));
  }
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) {
    return cors(Response.json({ error: "Badge proxy is not configured" }, { status: 503 }));
  }

  const cacheKey = new Request(`${url.origin}${url.pathname}`, { method: "GET" });
  const cache = (globalThis.caches as CacheStorage & { default?: Cache }).default;
  let stale: Response | undefined;
  try {
    stale = await cache?.match(cacheKey);
  } catch {
    stale = undefined;
  }

  const cachedAt = stale ? readCachedAt(stale) : undefined;
  const age = cachedAt === undefined ? Number.POSITIVE_INFINITY : Date.now() - cachedAt;
  if (stale && age >= 0 && age < FRESH_MS) return publicResponse(stale);
  if (stale && age >= FRESH_MS && age < FRESH_MS + STALE_WHILE_REVALIDATE_MS) {
    if (reserveUpstreamMiss()) {
      waitUntil(refreshCache(cacheKey, route, env, fetcher, cache).catch(() => undefined));
    }
    return publicResponse(stale);
  }

  if (!reserveUpstreamMiss()) {
    return stale ? publicResponse(stale) : cors(Response.json(EMPTY_BADGE_PAYLOAD, {
      headers: { "Cache-Control": "no-store" },
    }));
  }

  try {
    return publicResponse(await refreshCache(cacheKey, route, env, fetcher, cache));
  } catch {
    if (stale) return publicResponse(stale);
    return cors(Response.json({ error: "Badge service is unavailable" }, { status: 502 }));
  }
}

async function refreshCache(
  cacheKey: Request,
  route: BadgeRoute,
  env: BadgeEnvironment,
  fetcher: typeof fetch,
  cache: Cache | undefined,
): Promise<Response> {
  const payload = await fetchBadges(route, env, fetcher);
  const headers = new Headers({
    "Cache-Control": CACHE_CONTROL,
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    [INTERNAL_CACHED_AT]: String(Date.now()),
  });
  const response = new Response(JSON.stringify(payload), { status: 200, headers });
  try {
    await cache?.put(cacheKey, response.clone());
  } catch {
    // Cache failures must not take down the public read-through proxy.
  }
  return response;
}

async function fetchBadges(route: BadgeRoute, env: BadgeEnvironment, fetcher: typeof fetch): Promise<unknown> {
  const token = await getAppToken(env, fetcher);
  const url = new URL(route.kind === "global" ? `${HELIX_URL}/global` : HELIX_URL);
  if (route.kind === "channel") url.searchParams.set("broadcaster_id", route.broadcasterId);

  let response = await fetcher(url, { headers: helixHeaders(env.TWITCH_CLIENT_ID!, token.accessToken) });
  if (response.status === 401) {
    invalidateToken(env, token.accessToken);
    const refreshedToken = await getAppToken(env, fetcher, true);
    response = await fetcher(url, { headers: helixHeaders(env.TWITCH_CLIENT_ID!, refreshedToken.accessToken) });
  }
  if (response.status === 400 || response.status === 404) return EMPTY_BADGE_PAYLOAD;
  if (!response.ok) throw new Error("Twitch badge request failed");
  return response.json();
}

async function getAppToken(env: BadgeEnvironment, fetcher: typeof fetch, forceRefresh = false): Promise<AppToken> {
  const clientId = env.TWITCH_CLIENT_ID!;
  const clientSecret = env.TWITCH_CLIENT_SECRET!;
  const key = `${clientId}\u0000${clientSecret}`;
  const existing = appTokens.get(key);
  if (!forceRefresh && existing) {
    const token = await existing;
    if (token.expiresAt > Date.now() + 5_000) return token;
    if (appTokens.get(key) === existing) appTokens.delete(key);
  }

  const minting = mintAppToken(clientId, clientSecret, fetcher);
  appTokens.set(key, minting);
  try {
    const token = await minting;
    if (appTokens.get(key) === minting) appTokens.set(key, token);
    return token;
  } catch (error) {
    if (appTokens.get(key) === minting) appTokens.delete(key);
    throw error;
  }
}

async function mintAppToken(clientId: string, clientSecret: string, fetcher: typeof fetch): Promise<AppToken> {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    grant_type: "client_credentials",
  });
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!response.ok) throw new Error("Twitch app token request failed");
  const payload: unknown = await response.json();
  if (!isRecord(payload) || typeof payload.access_token !== "string" || !payload.access_token ||
      typeof payload.expires_in !== "number" || !Number.isFinite(payload.expires_in) || payload.expires_in <= 0) {
    throw new Error("Twitch app token response was invalid");
  }
  return { accessToken: payload.access_token, expiresAt: Date.now() + payload.expires_in * 1000 };
}

function invalidateToken(env: BadgeEnvironment, accessToken: string): void {
  const key = `${env.TWITCH_CLIENT_ID!}\u0000${env.TWITCH_CLIENT_SECRET!}`;
  const cached = appTokens.get(key);
  if (cached && !(cached instanceof Promise) && cached.accessToken === accessToken) appTokens.delete(key);
}

function helixHeaders(clientId: string, accessToken: string): HeadersInit {
  return { "Client-Id": clientId, Authorization: `Bearer ${accessToken}` };
}

function reserveUpstreamMiss(): boolean {
  const now = Date.now();
  // Upgrade path: move this isolate-local ceiling to a shared rate limiter if abuse crosses isolates.
  if (now < upstreamMissWindowStartedAt || now - upstreamMissWindowStartedAt >= UPSTREAM_MISS_WINDOW_MS) {
    upstreamMissWindowStartedAt = now;
    upstreamMisses = 0;
  }
  if (upstreamMisses >= UPSTREAM_MISS_LIMIT) return false;
  upstreamMisses += 1;
  return true;
}

type BadgeRoute = { kind: "global" } | { kind: "channel"; broadcasterId: string };

function badgeRoute(pathname: string): BadgeRoute | null {
  if (pathname === "/api/twitch/badges/global") return { kind: "global" };
  const channel = /^\/api\/twitch\/badges\/([^/]+)$/u.exec(pathname);
  return channel ? { kind: "channel", broadcasterId: channel[1]! } : null;
}

function readCachedAt(response: Response): number | undefined {
  const header = response.headers.get(INTERNAL_CACHED_AT);
  const parsed = header ? Number(header) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function publicResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete(INTERNAL_CACHED_AT);
  headers.set("Cache-Control", CACHE_CONTROL);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function cors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
