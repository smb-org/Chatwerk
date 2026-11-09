import {
  createHypeTrainSubscriptions,
  deleteHypeTrainSubscriptionsForUser,
  deriveEventSubSecret,
  getAppAccessToken,
  type TwitchEventSubEnvironment,
} from "./twitch-eventsub";
import { featureEnabled } from "../shared/features";

const encoder = new TextEncoder();
const SESSION_COOKIE = "session";
const NONCE_COOKIE = "oauth_nonce";
const NEXT_COOKIE = "oauth_next";
const PURPOSE_COOKIE = "oauth_purpose";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const STATE_SECONDS = 10 * 60;
const AUTHORIZE_URL = "https://id.twitch.tv/oauth2/authorize";
const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const USERS_URL = "https://api.twitch.tv/helix/users";

export interface AuthEnvironment extends TwitchEventSubEnvironment {
  DB: D1Database;
  SESSION_KEY?: string;
  PUBLIC_ORIGIN?: string;
}

export interface VerifiedSession {
  userId: string;
  expiresAt: number;
}

export async function handleAuthRequest(
  request: Request,
  env: AuthEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  const isAuthPath = url.pathname === "/auth" || url.pathname.startsWith("/auth/");
  if (!isAuthPath) return null;

  if (request.method === "GET" && url.pathname === "/auth/login") {
    if (!hasSecrets(env)) return unavailable();
    return beginLogin(request, env);
  }
  if (request.method === "GET" && url.pathname === "/auth/hype-train") {
    if (!featureEnabled("hypeTrain")) return Response.redirect(new URL("/studio", url.origin), 302);
    if (!hasSecrets(env)) return unavailable();
    return beginHypeTrainConsent(request, env);
  }
  if (request.method === "GET" && url.pathname === "/auth/callback") {
    if (!hasSecrets(env)) return unavailable();
    if (readCookie(request.headers.get("cookie"), PURPOSE_COOKIE) === "hype-train") {
      return completeHypeTrainConsent(request, env, fetcher);
    }
    return completeOAuth(request, env, fetcher);
  }
  if (request.method === "POST" && url.pathname === "/auth/logout") {
    if (!env.SESSION_KEY) return unavailable();
    if (!isSameOriginMutation(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
    return new Response(null, {
      status: 204,
      headers: { "Set-Cookie": sessionCookie("", request.url, 0), "Cache-Control": "no-store" },
    });
  }

  return Response.json({ error: "Not found" }, { status: 404 });
}

export async function verifySessionCookie(
  value: string | undefined,
  sessionKey: string | undefined,
  now = Math.floor(Date.now() / 1000),
): Promise<VerifiedSession | null> {
  if (!value || !sessionKey) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;
  const [userId, rawExpiresAt, signature] = parts;
  const expiresAt = Number(rawExpiresAt);
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(userId!) || !Number.isSafeInteger(expiresAt) || expiresAt <= now) return null;
  if (!/^[A-Za-z0-9_-]{43}$/u.test(signature!)) return null;
  const valid = await verifyHmac(`${userId}.${rawExpiresAt}`, signature!, sessionKey);
  return valid ? { userId: userId!, expiresAt } : null;
}

export async function sessionForRequest(request: Request, sessionKey: string | undefined): Promise<VerifiedSession | null> {
  return verifySessionCookie(readCookie(request.headers.get("cookie"), SESSION_COOKIE), sessionKey);
}

export async function adminSessionForRequest(
  request: Request,
  db: D1Database,
  sessionKey: string | undefined,
  adminTwitchIds: string | undefined,
): Promise<VerifiedSession | null> {
  const allowedIds = new Set((adminTwitchIds ?? "").split(",").map((id) => id.trim()).filter((id) => /^\d+$/u.test(id)));
  if (allowedIds.size === 0) return null;
  const session = await sessionForRequest(request, sessionKey);
  if (!session || !/^\d+$/u.test(session.userId) || !allowedIds.has(session.userId)) return null;
  const user = await db.prepare("SELECT id FROM users WHERE id = ?").bind(session.userId).first<{ id: string }>();
  return user ? session : null;
}

export function isSameOriginMutation(request: Request): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(request.url).origin;
  } catch {
    return false;
  }
}

function hasSecrets(env: AuthEnvironment): boolean {
  return Boolean(env.TWITCH_CLIENT_ID && env.TWITCH_CLIENT_SECRET && env.SESSION_KEY);
}

function unavailable(): Response {
  return Response.json({ error: "Authentication is not configured" }, { status: 503 });
}

async function beginLogin(request: Request, env: AuthEnvironment): Promise<Response> {
  const url = new URL(request.url);
  const nonce = randomToken(32);
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_SECONDS;
  const next = url.searchParams.get("next") ?? "/studio";
  const state = `${nonce}.${await signHmac(nonce, env.SESSION_KEY!)}`;
  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set("client_id", env.TWITCH_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", new URL("/auth/callback", url.origin).toString());
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "");
  authorize.searchParams.set("state", state);
  const headers = new Headers({
    Location: authorize.toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append("Set-Cookie", nonceCookie(`${nonce}.${expiresAt}.${await signHmac(`${nonce}.${expiresAt}`, env.SESSION_KEY!)}`, request.url));
  headers.append("Set-Cookie", nextCookie(base64Url(encoder.encode(next)), request.url));
  headers.append("Set-Cookie", purposeCookie("", request.url, 0));
  return new Response(null, {
    status: 302,
    headers,
  });
}

async function beginHypeTrainConsent(request: Request, env: AuthEnvironment): Promise<Response> {
  const url = new URL(request.url);
  const session = await sessionForRequest(request, env.SESSION_KEY);
  const overlayId = url.searchParams.get("overlayId");
  if (!session) {
    const next = overlayId ? `/studio?overlay=${encodeURIComponent(overlayId)}` : "/studio";
    return new Response(null, {
      status: 302,
      headers: { Location: new URL(`/login?next=${encodeURIComponent(next)}`, url.origin).toString(), "Cache-Control": "no-store" },
    });
  }

  const ownedOverlay = overlayId
    ? await env.DB.prepare("SELECT id FROM overlays WHERE id = ? AND owner_id = ?").bind(overlayId, session.userId).first<{ id: string }>()
    : await env.DB.prepare("SELECT id FROM overlays WHERE owner_id = ? ORDER BY created_at, id LIMIT 1").bind(session.userId).first<{ id: string }>();
  if (!ownedOverlay) return Response.json({ error: "owner-only" }, { status: 403 });

  const next = `/studio?overlay=${encodeURIComponent(ownedOverlay.id)}`;
  const nonce = randomToken(32);
  const expiresAt = Math.floor(Date.now() / 1000) + STATE_SECONDS;
  const state = `${nonce}.${await signHmac(nonce, env.SESSION_KEY!)}`;
  const authorize = new URL(AUTHORIZE_URL);
  authorize.searchParams.set("client_id", env.TWITCH_CLIENT_ID!);
  authorize.searchParams.set("redirect_uri", callbackUrl(request.url, env.PUBLIC_ORIGIN));
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "channel:read:hype_train");
  authorize.searchParams.set("state", state);
  const headers = new Headers({
    Location: authorize.toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append("Set-Cookie", nonceCookie(`${nonce}.${expiresAt}.${await signHmac(`${nonce}.${expiresAt}`, env.SESSION_KEY!)}`, request.url));
  headers.append("Set-Cookie", nextCookie(base64Url(encoder.encode(next)), request.url));
  headers.append("Set-Cookie", purposeCookie("hype-train", request.url));
  return new Response(null, { status: 302, headers });
}

async function completeOAuth(request: Request, env: AuthEnvironment, fetcher: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const cookie = request.headers.get("cookie");
  const nonce = readCookie(cookie, NONCE_COOKIE);
  const verifiedState = state ? await verifyOAuthState(state, nonce, env.SESSION_KEY!) : false;
  if (!code || !verifiedState) return loginErrorRedirect(url.origin, request.url);
  const next = safeNext(decodeNextCookie(readCookie(cookie, NEXT_COOKIE)), url.origin);

  let identity: { id: string; login: string };
  try {
    const tokenResponse = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID!,
        client_secret: env.TWITCH_CLIENT_SECRET!,
        code,
        grant_type: "authorization_code",
        redirect_uri: new URL("/auth/callback", url.origin).toString(),
      }),
    });
    if (!tokenResponse.ok) return loginErrorRedirect(url.origin, request.url);
    const token = await tokenResponse.json() as { access_token?: unknown };
    if (typeof token.access_token !== "string" || !token.access_token) {
      return loginErrorRedirect(url.origin, request.url);
    }
    const userResponse = await fetcher(USERS_URL, {
      headers: { Authorization: `Bearer ${token.access_token}`, "Client-Id": env.TWITCH_CLIENT_ID! },
    });
    if (!userResponse.ok) return loginErrorRedirect(url.origin, request.url);
    const userPayload = await userResponse.json() as { data?: unknown };
    const user = Array.isArray(userPayload.data) ? userPayload.data[0] as Record<string, unknown> | undefined : undefined;
    if (!user || typeof user.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(user.id) ||
      typeof user.login !== "string" || !/^[A-Za-z0-9_]{1,25}$/u.test(user.login)) {
      return loginErrorRedirect(url.origin, request.url);
    }
    identity = { id: user.id, login: user.login.toLowerCase() };
  } catch {
    return loginErrorRedirect(url.origin, request.url);
  }

  try {
    await ensureDefaultOverlay(env.DB, identity.id, identity.login);
  } catch {
    return loginErrorRedirect(url.origin, request.url);
  }

  const expiresAt = Math.floor(Date.now() / 1000) + SESSION_SECONDS;
  const sessionValue = `${identity.id}.${expiresAt}.${await signHmac(`${identity.id}.${expiresAt}`, env.SESSION_KEY!)}`;
  const headers = new Headers({
    Location: new URL(next, url.origin).toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append("Set-Cookie", sessionCookie(sessionValue, request.url, SESSION_SECONDS));
  headers.append("Set-Cookie", nonceCookie("", request.url, 0));
  headers.append("Set-Cookie", nextCookie("", request.url, 0));
  return new Response(null, { status: 302, headers });
}

async function completeHypeTrainConsent(request: Request, env: AuthEnvironment, fetcher: typeof fetch): Promise<Response> {
  const url = new URL(request.url);
  const cookie = request.headers.get("cookie");
  const nonce = readCookie(cookie, NONCE_COOKIE);
  const state = url.searchParams.get("state");
  const returnTo = safeNext(decodeNextCookie(readCookie(cookie, NEXT_COOKIE)), url.origin);
  const finish = (status: string): Response => hypeTrainStatusRedirect(url.origin, request.url, returnTo, status);
  if (!state || !await verifyOAuthState(state, nonce, env.SESSION_KEY!)) return finish("error");
  if (url.searchParams.has("error")) return finish("denied");

  const session = await sessionForRequest(request, env.SESSION_KEY);
  if (!session) return finish("session-expired");
  const code = url.searchParams.get("code");
  if (!code) return finish("error");

  try {
    const tokenResponse = await fetcher(TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.TWITCH_CLIENT_ID!,
        client_secret: env.TWITCH_CLIENT_SECRET!,
        code,
        grant_type: "authorization_code",
        redirect_uri: callbackUrl(request.url, env.PUBLIC_ORIGIN),
      }),
    });
    if (!tokenResponse.ok) return finish("error");
    const tokenPayload = await tokenResponse.json() as { access_token?: unknown; scope?: unknown };
    if (typeof tokenPayload.access_token !== "string" || !tokenPayload.access_token) return finish("error");
    if (!Array.isArray(tokenPayload.scope) || !tokenPayload.scope.includes("channel:read:hype_train")) {
      return finish("scope-missing");
    }
    const userResponse = await fetcher(USERS_URL, {
      headers: { Authorization: `Bearer ${tokenPayload.access_token}`, "Client-Id": env.TWITCH_CLIENT_ID! },
    });
    if (!userResponse.ok) return finish("error");
    const userPayload = await userResponse.json() as { data?: unknown };
    const user = Array.isArray(userPayload.data) ? userPayload.data[0] as Record<string, unknown> | undefined : undefined;
    if (!user || typeof user.id !== "string" || !/^[A-Za-z0-9_-]{1,128}$/u.test(user.id) ||
      typeof user.login !== "string" || !/^[A-Za-z0-9_]{1,25}$/u.test(user.login)) return finish("error");
    if (user.id !== session.userId) return finish("user-mismatch");

    const sessionKey = env.SESSION_KEY!;
    const appToken = await getAppAccessToken(env, fetcher);
    await deleteHypeTrainSubscriptionsForUser({ env, fetcher, appToken, userId: session.userId }).catch(() => undefined);
    await env.DB.prepare(`
      INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET login = excluded.login
    `).bind(session.userId, user.login.toLowerCase()).run();
    try {
      await createHypeTrainSubscriptions({
        env,
        fetcher,
        appToken,
        broadcasterUserId: session.userId,
        callback: `${(env.PUBLIC_ORIGIN ? new URL(env.PUBLIC_ORIGIN).origin : url.origin)}/webhooks/twitch`,
        secret: await deriveEventSubSecret(sessionKey),
      });
    } catch {
      await env.DB.prepare("DELETE FROM hype_train_consents WHERE user_id = ?").bind(session.userId).run();
      return finish("failed");
    }
    return finish("connected");
  } catch {
    return finish("failed");
  }
}

function loginErrorRedirect(origin: string, requestUrl: string): Response {
  const headers = new Headers({
    Location: new URL("/login?error=1", origin).toString(),
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
  });
  headers.append("Set-Cookie", nonceCookie("", requestUrl, 0));
  headers.append("Set-Cookie", nextCookie("", requestUrl, 0));
  headers.append("Set-Cookie", purposeCookie("", requestUrl, 0));
  return new Response(null, {
    status: 302,
    headers,
  });
}

async function ensureDefaultOverlay(db: D1Database, userId: string, login: string): Promise<void> {
  const overlayId = crypto.randomUUID();
  const token = randomToken(32);
  await db.batch([
    db.prepare("INSERT INTO users (id, login, last_login_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(id) DO UPDATE SET login = excluded.login, last_login_at = CURRENT_TIMESTAMP")
      .bind(userId, login),
    db.prepare(`
      INSERT INTO overlays (id, owner_id, link_token, name, channel)
      SELECT ?, ?, ?, 'Main', ?
      WHERE NOT EXISTS (SELECT 1 FROM overlays WHERE owner_id = ?)
    `).bind(overlayId, userId, token, login, userId),
    db.prepare("UPDATE overlays SET channel = ? WHERE owner_id = ? AND channel = ''")
      .bind(login, userId),
  ]);
}

async function verifyOAuthState(state: string, cookieNonce: string | undefined, sessionKey: string): Promise<boolean> {
  const [nonce, signature, extra] = state.split(".");
  const [cookieValue, rawExpiresAt, expiresSignature, cookieExtra] = cookieNonce?.split(".") ?? [];
  const expiresAt = Number(rawExpiresAt);
  if (!nonce || !signature || extra !== undefined || cookieExtra !== undefined || !expiresSignature || nonce !== cookieValue ||
    !Number.isSafeInteger(expiresAt) || expiresAt <= Math.floor(Date.now() / 1000)) return false;
  return await verifyHmac(nonce, signature, sessionKey) &&
    await verifyHmac(`${cookieValue}.${rawExpiresAt}`, expiresSignature, sessionKey);
}

function safeNext(value: string | null, origin: string): string {
  const hasControlCharacter = [...(value ?? "")].some((character) => {
    const code = character.codePointAt(0)!;
    return code < 0x20 || code === 0x7f;
  });
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\") || hasControlCharacter) {
    return "/studio";
  }
  try {
    const resolved = new URL(value, origin);
    return resolved.origin === origin ? `${resolved.pathname}${resolved.search}${resolved.hash}` : "/studio";
  } catch {
    return "/studio";
  }
}

function sessionCookie(value: string, requestUrl: string, maxAge: number): string {
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly${secureAttribute(requestUrl)}; SameSite=Lax; Max-Age=${maxAge}`;
}

function nonceCookie(value: string, requestUrl: string, maxAge = STATE_SECONDS): string {
  return `${NONCE_COOKIE}=${value}; Path=/auth/callback; HttpOnly${secureAttribute(requestUrl)}; SameSite=Lax; Max-Age=${maxAge}`;
}

function purposeCookie(value: string, requestUrl: string, maxAge = STATE_SECONDS): string {
  return `${PURPOSE_COOKIE}=${value}; Path=/auth/callback; HttpOnly${secureAttribute(requestUrl)}; SameSite=Lax; Max-Age=${maxAge}`;
}

function nextCookie(value: string, requestUrl: string, maxAge = STATE_SECONDS): string {
  return `${NEXT_COOKIE}=${value}; Path=/auth/callback; HttpOnly${secureAttribute(requestUrl)}; SameSite=Lax; Max-Age=${maxAge}`;
}

function callbackUrl(requestUrl: string, publicOrigin?: string): string {
  const origin = publicOrigin ? new URL(publicOrigin).origin : new URL(requestUrl).origin;
  return new URL("/auth/callback", origin).toString();
}

function hypeTrainStatusRedirect(origin: string, requestUrl: string, returnTo: string, status: string): Response {
  const target = new URL(returnTo, origin);
  target.searchParams.set("hypeTrain", status);
  const headers = new Headers({ Location: target.toString(), "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  headers.append("Set-Cookie", nonceCookie("", requestUrl, 0));
  headers.append("Set-Cookie", nextCookie("", requestUrl, 0));
  headers.append("Set-Cookie", purposeCookie("", requestUrl, 0));
  return new Response(null, { status: 302, headers });
}

function decodeNextCookie(value: string | undefined): string | null {
  if (!value) return null;
  try { return new TextDecoder().decode(fromBase64Url(value)); }
  catch { return null; }
}

function secureAttribute(requestUrl: string): string {
  const url = new URL(requestUrl);
  const localHttp = url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return localHttp ? "" : "; Secure";
}

function readCookie(header: string | null, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function randomToken(byteLength: number): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

async function signHmac(value: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return base64Url(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}

async function verifyHmac(value: string, signature: string, secret: string): Promise<boolean> {
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
    const signatureBytes = fromBase64Url(signature);
    return await crypto.subtle.verify("HMAC", key, signatureBytes.buffer as ArrayBuffer, encoder.encode(value));
  } catch {
    return false;
  }
}

function base64Url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64Url(value: string): Uint8Array {
  const normalized = value.replace(/-/gu, "+").replace(/_/gu, "/");
  const padded = normalized + "=".repeat((4 - normalized.length % 4) % 4);
  return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
