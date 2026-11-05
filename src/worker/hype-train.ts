import { isSameOriginMutation, sessionForRequest, verifySessionCookie } from "./auth";
import { getOverlayAccess } from "./db";
import {
  deleteHypeTrainSubscriptionsForUser,
  deriveEventSubSecret,
  type HypeTrainSubscriptionType,
  type TwitchEventSubEnvironment,
} from "./twitch-eventsub";

const encoder = new TextEncoder();
const MAX_WEBHOOK_BYTES = 64 * 1024;
const MAX_API_BODY_BYTES = 16 * 1024;
const HYPE_TRAIN_TYPES = new Set([
  "channel.hype_train.begin",
  "channel.hype_train.progress",
  "channel.hype_train.end",
]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface HypeTrainEnvironment extends TwitchEventSubEnvironment {
  DB: D1Database;
  OVERLAY: DurableObjectNamespace;
  SESSION_KEY?: string;
  PUBLIC_ORIGIN?: string;
}

export interface HypeTrainSocketMessage {
  type: "hype-train";
  id: string;
  trainId: string;
  channel: string;
  phase: "begin" | "progress" | "end";
  level: number;
  expiresAt: string | null;
}

interface WebhookSubscription {
  type: string;
  version?: unknown;
  condition?: unknown;
  status?: unknown;
}

interface InternalOverlayStub extends DurableObjectStub {
  hypeTrain(message: HypeTrainSocketMessage): Promise<void>;
}

export async function handleHypeTrainRequest(
  request: Request,
  env: HypeTrainEnvironment,
  ctx: Pick<ExecutionContext, "waitUntil">,
  fetcher: typeof fetch = fetch,
): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/webhooks/twitch") {
    if (request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "POST" } });
    return handleWebhook(request, env, ctx, fetcher);
  }
  if (url.pathname === "/api/hype-train") {
    if (request.method === "GET") return getConsentStatus(request, env);
    return new Response(null, { status: 405, headers: { Allow: "GET" } });
  }
  if (url.pathname === "/api/hype-train/disconnect") {
    if (request.method === "POST") return disconnectHypeTrain(request, env, fetcher);
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  return null;
}

async function handleWebhook(
  request: Request,
  env: HypeTrainEnvironment,
  ctx: Pick<ExecutionContext, "waitUntil">,
  fetcher: typeof fetch,
): Promise<Response> {
  if (!env.SESSION_KEY) return new Response(null, { status: 503 });
  const rawBody = await readBytes(request, MAX_WEBHOOK_BYTES);
  if (rawBody instanceof Response) return rawBody;
  const messageId = request.headers.get("twitch-eventsub-message-id");
  const timestamp = request.headers.get("twitch-eventsub-message-timestamp");
  const suppliedSignature = request.headers.get("twitch-eventsub-message-signature");
  if (!messageId || messageId.length > 256 || !timestamp || !suppliedSignature) return new Response(null, { status: 403 });

  // Rotating SESSION_KEY changes this derived secret; Twitch then revokes the existing subscriptions.
  const secret = await deriveEventSubSecret(env.SESSION_KEY);
  const signaturePrefix = encoder.encode(`${messageId}${timestamp}`);
  const signedBytes = new Uint8Array(signaturePrefix.byteLength + rawBody.byteLength);
  signedBytes.set(signaturePrefix);
  signedBytes.set(rawBody, signaturePrefix.byteLength);
  const expected = `sha256=${await hmacHex(secret, signedBytes)}`;
  if (!timingSafeEqual(expected, suppliedSignature)) return new Response(null, { status: 403 });
  const timestampMs = Date.parse(timestamp);
  const now = Date.now();
  if (!Number.isFinite(timestampMs) || now - timestampMs > 10 * 60_000 || timestampMs - now > 10 * 60_000) {
    return new Response(null, { status: 403 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(rawBody)) as unknown;
  } catch {
    return Response.json({ error: "Invalid EventSub payload" }, { status: 400 });
  }
  if (!isRecord(payload)) return Response.json({ error: "Invalid EventSub payload" }, { status: 400 });

  const messageType = request.headers.get("twitch-eventsub-message-type");
  if (messageType === "webhook_callback_verification") {
    if (typeof payload.challenge !== "string") return Response.json({ error: "Invalid challenge" }, { status: 400 });
    const challenge = encoder.encode(payload.challenge);
    return new Response(payload.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain; charset=utf-8", "Content-Length": String(challenge.byteLength) },
    });
  }

  const subscription = isRecord(payload.subscription) ? payload.subscription as unknown as WebhookSubscription : undefined;
  if (!subscription || typeof subscription.type !== "string") {
    return Response.json({ error: "Invalid EventSub subscription" }, { status: 400 });
  }
  if (!HYPE_TRAIN_TYPES.has(subscription.type)) return new Response(null, { status: 204 });

  if (messageType === "revocation") {
    if (typeof subscription.status !== "string" || subscription.status === "enabled" ||
      subscription.status === "webhook_callback_verification_pending" || Object.hasOwn(payload, "event")) {
      return Response.json({ error: "Invalid revocation" }, { status: 400 });
    }
    const condition = isRecord(subscription.condition) ? subscription.condition : undefined;
    const broadcasterId = condition?.broadcaster_user_id;
    if (typeof broadcasterId !== "string" || !validBroadcasterId(broadcasterId)) {
      return Response.json({ error: "Invalid revocation" }, { status: 400 });
    }
    await env.DB.prepare("DELETE FROM hype_train_consents WHERE user_id = ?").bind(broadcasterId).run();
    ctx.waitUntil(deleteHypeTrainSubscriptionsForUser({ env, fetcher, userId: broadcasterId }).catch(() => undefined));
    return new Response(null, { status: 204 });
  }

  if (messageType !== "notification") return new Response(null, { status: 204 });
  const parsed = validateNotification(payload, subscription, request.headers, messageId);
  if (!parsed) return Response.json({ error: "Invalid Hype Train notification" }, { status: 400 });
  const consent = await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
    .bind(parsed.broadcasterUserId).first<{ user_id: string }>();
  if (!consent) return new Response(null, { status: 204 });
  ctx.waitUntil(fanOutHypeTrain(env, parsed.broadcasterUserId, parsed.message).catch(() => undefined));
  return new Response(null, { status: 204 });
}

function validateNotification(
  payload: Record<string, unknown>,
  subscription: WebhookSubscription,
  headers: Headers,
  messageId: string,
): { broadcasterUserId: string; message: HypeTrainSocketMessage } | null {
  const event = isRecord(payload.event) ? payload.event : undefined;
  if (!event) return null;
  const condition = isRecord(subscription.condition) ? subscription.condition : undefined;
  const broadcasterUserId = event?.broadcaster_user_id;
  const channel = event?.broadcaster_user_login;
  const trainId = event?.id;
  const level = event?.level;
  const type = subscription.type as HypeTrainSubscriptionType;
  const phase = type === "channel.hype_train.begin" ? "begin"
    : type === "channel.hype_train.progress" ? "progress" : "end";
  if (subscription.version !== "2" || headers.get("twitch-eventsub-subscription-type") !== type ||
    headers.get("twitch-eventsub-subscription-version") !== "2" ||
    typeof broadcasterUserId !== "string" || !validBroadcasterId(broadcasterUserId) ||
    condition?.broadcaster_user_id !== broadcasterUserId ||
    typeof trainId !== "string" || trainId.length === 0 || trainId.length > 256 ||
    typeof channel !== "string" || !/^[a-z0-9_]{1,25}$/iu.test(channel) ||
    typeof level !== "number" || !Number.isSafeInteger(level) || level < 1) return null;

  let expiresAt: string | null = null;
  if (phase === "begin" || phase === "progress") {
    if (typeof event.expires_at !== "string" || !Number.isFinite(Date.parse(event.expires_at))) return null;
    expiresAt = event.expires_at;
  } else if (phase !== "end" || typeof event.ended_at !== "string" || !Number.isFinite(Date.parse(event.ended_at))) {
    return null;
  }
  return {
    broadcasterUserId,
    message: { type: "hype-train", id: messageId, trainId, channel: channel.toLowerCase(), phase, level, expiresAt },
  };
}

async function fanOutHypeTrain(env: HypeTrainEnvironment, broadcasterUserId: string, message: HypeTrainSocketMessage): Promise<void> {
  const rows = await env.DB.prepare("SELECT id FROM overlays WHERE owner_id = ?").bind(broadcasterUserId).all<{ id: string }>();
  // ponytail: An overlay owned by someone other than the broadcaster gets no Hype Train.
  await Promise.all(rows.results.map(async ({ id }) => {
    const stub = env.OVERLAY.get(env.OVERLAY.idFromName(id)) as InternalOverlayStub;
    await stub.hypeTrain(message);
  }));
}

async function getConsentStatus(request: Request, env: HypeTrainEnvironment): Promise<Response> {
  if (!env.SESSION_KEY) return Response.json({ error: "Authentication is not configured" }, { status: 503 });
  const session = await sessionForRequest(request, env.SESSION_KEY);
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  const overlayId = new URL(request.url).searchParams.get("overlayId");
  if (!overlayId || !UUID_PATTERN.test(overlayId)) return Response.json({ error: "Invalid overlay" }, { status: 400 });
  const access = await getOverlayAccess(env.DB, overlayId, session.userId);
  if (!access) return Response.json({ error: "overlay-not-found" }, { status: 404 });
  const consent = await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
    .bind(access.overlay.owner_id).first<{ user_id: string }>();
  return Response.json({ role: access.role, connected: Boolean(consent) }, { headers: { "Cache-Control": "no-store" } });
}

async function disconnectHypeTrain(request: Request, env: HypeTrainEnvironment, fetcher: typeof fetch): Promise<Response> {
  if (!env.SESSION_KEY) return Response.json({ error: "Authentication is not configured" }, { status: 503 });
  const session = await verifySessionCookie(readCookie(request.headers.get("cookie"), "session"), env.SESSION_KEY);
  if (!session) return Response.json({ error: "Authentication required" }, { status: 401 });
  if (!isSameOriginMutation(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!isJsonRequest(request)) return Response.json({ error: "JSON content type required" }, { status: 415 });
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 1 || typeof body.overlayId !== "string" || !UUID_PATTERN.test(body.overlayId)) {
    return Response.json({ error: "Invalid disconnect request" }, { status: 400 });
  }
  const access = await getOverlayAccess(env.DB, body.overlayId, session.userId);
  if (!access) return Response.json({ error: "overlay-not-found" }, { status: 404 });
  if (access.role !== "owner") return Response.json({ error: "owner-only" }, { status: 403 });
  try {
    await deleteHypeTrainSubscriptionsForUser({ env, fetcher, userId: session.userId });
    await env.DB.prepare("DELETE FROM hype_train_consents WHERE user_id = ?").bind(session.userId).run();
    return Response.json({ connected: false }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not disconnect Hype Train" }, { status: 502 });
  }
}

async function readBytes(request: Request, maximum: number): Promise<Uint8Array | Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > maximum) return new Response(null, { status: 413 });
  const reader = request.body?.getReader();
  if (!reader) return new Response(null, { status: 400 });
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maximum) {
        try { await reader.cancel(); } catch { /* The body may already have completed. */ }
        return new Response(null, { status: 413 });
      }
      chunks.push(value);
    }
  } catch {
    return new Response(null, { status: 400 });
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const raw = await readBytes(request, MAX_API_BODY_BYTES);
  if (raw instanceof Response) return raw;
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(raw));
    return isRecord(value) ? value : Response.json({ error: "Invalid JSON body" }, { status: 400 });
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function readCookie(header: string | null, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function timingSafeEqual(expected: string, supplied: string): boolean {
  let difference = expected.length ^ supplied.length;
  for (let index = 0; index < expected.length; index += 1) {
    difference |= expected.charCodeAt(index) ^ (supplied.charCodeAt(index) || 0);
  }
  return difference === 0;
}

async function hmacHex(secret: string, value: string | Uint8Array): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = typeof value === "string" ? encoder.encode(value) : new Uint8Array(value);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes.buffer as ArrayBuffer));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validBroadcasterId(value: string): boolean {
  return /^[A-Za-z0-9_-]{1,128}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
