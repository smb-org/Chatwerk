import { isSameOriginMutation, verifySessionCookie } from "./auth";
import { getOverlayByToken, getOwnedOverlay, listOwnedOverlays, rotateOwnedOverlayLink, type OverlayRecord } from "./db";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SOCKET_PROTOCOL = "chatwerk-live";
const MAX_JSON_BODY_BYTES = 64 * 1024;

export interface ApiEnvironment {
  DB: D1Database;
  OVERLAY: DurableObjectNamespace;
  SESSION_KEY?: string;
}

interface OverlayConfigSnapshot {
  revision: number;
  config: unknown;
}

interface OverlayStub extends DurableObjectStub {
  get(generation: number): Promise<OverlayConfigSnapshot>;
  save(patch: Record<string, unknown>, baseRevision: number, generation: number): Promise<OverlayConfigSnapshot | { conflict: true; revision: number; config: unknown } | { invalid: true; field: string }>;
  revoke(nextGeneration?: number): Promise<void>;
  testLine(generation: number): Promise<string>;
}

export async function handleApiRequest(request: Request, env: ApiEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/overlay/config" && request.method === "OPTIONS") {
    return withBearerCors(new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Methods": "GET, OPTIONS",
        "Access-Control-Allow-Headers": "Authorization, Content-Type",
        "Access-Control-Max-Age": "600",
      },
    }));
  }
  if (url.pathname === "/api/overlay/config" && request.method === "GET") {
    return withBearerCors(await readLinkedConfig(request, env));
  }
  if (url.pathname === "/api/overlay/live" && request.method === "GET") {
    return connectLinkedSocket(request, env);
  }
  if (url.pathname === "/api/overlays" && request.method === "GET") {
    return listOverlays(request, env);
  }

  const overlayRoute = /^\/api\/overlays\/([0-9a-f-]{36})\/(config|rotate-link|test-line)$/u.exec(url.pathname);
  if (!overlayRoute) return null;
  const [, overlayId, action] = overlayRoute;
  if (action === "config" && request.method === "PUT") return writeConfig(request, env, overlayId!);
  if (action === "rotate-link" && request.method === "POST") return rotateLink(request, env, overlayId!);
  if (action === "test-line" && request.method === "POST") return sendTestLine(request, env, overlayId!);
  return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: allowedMethod(action!) } });
}

async function listOverlays(request: Request, env: ApiEnvironment): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (session instanceof Response) return session;
  const overlays = await listOwnedOverlays(env.DB, session.userId);
  return Response.json({ overlays: overlays.map(publicOverlayForOwner) }, { headers: { "Cache-Control": "no-store" } });
}

async function readLinkedConfig(request: Request, env: ApiEnvironment): Promise<Response> {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer ([^\s]+)$/iu.exec(header);
  if (!match || !TOKEN_PATTERN.test(match[1]!)) return Response.json({ error: "Invalid overlay token" }, { status: 400 });
  const overlay = await getOverlayByToken(env.DB, match[1]!);
  if (!overlay) return Response.json({ error: "Overlay link is invalid" }, { status: 404 });
  const snapshot = await overlayStub(env, overlay.id).get(overlay.link_generation);
  return Response.json({ ...snapshot, channel: overlay.channel }, { headers: { "Cache-Control": "no-store" } });
}

async function writeConfig(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const overlay = await getOwnedOverlay(env.DB, overlayId, session.userId);
  if (!overlay) return Response.json({ error: "Overlay not found" }, { status: 404 });
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (!Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 0 || !isRecord(body.patch)) {
    return Response.json({ error: "Invalid config update" }, { status: 400 });
  }

  try {
    const result = await overlayStub(env, overlay.id).save(body.patch, body.baseRevision as number, overlay.link_generation);
    if ("invalid" in result && result.invalid) {
      return Response.json({ error: "Invalid theme config", field: result.field }, { status: 400 });
    }
    if ("conflict" in result && result.conflict) {
      return Response.json({ error: "Revision conflict", revision: result.revision, config: result.config }, { status: 409 });
    }
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "Could not save overlay config" }, { status: 500 });
  }
}

async function rotateLink(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const overlay = await getOwnedOverlay(env.DB, overlayId, session.userId);
  if (!overlay) return Response.json({ error: "Overlay not found" }, { status: 404 });
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 0) return Response.json({ error: "Invalid rotate request" }, { status: 400 });

  const linkToken = randomToken(32);
  const updated = await rotateOwnedOverlayLink(env.DB, overlay.id, session.userId, linkToken);
  if (!updated) return Response.json({ error: "Overlay not found" }, { status: 404 });
  try {
    await overlayStub(env, updated.id).revoke(updated.link_generation);
  } catch {
    // The new D1 token remains valid; its first socket upgrade advances a lagging DO generation.
  }
  return Response.json({ id: updated.id, linkToken: updated.link_token, generation: updated.link_generation }, {
    headers: { "Cache-Control": "no-store" },
  });
}


async function sendTestLine(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const overlay = await getOwnedOverlay(env.DB, overlayId, session.userId);
  if (!overlay) return Response.json({ error: "Overlay not found" }, { status: 404 });
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 0) return Response.json({ error: "Invalid test request" }, { status: 400 });
  const id = await overlayStub(env, overlay.id).testLine(overlay.link_generation);
  return Response.json({ id }, { headers: { "Cache-Control": "no-store" } });
}

async function connectLinkedSocket(request: Request, env: ApiEnvironment): Promise<Response> {
  const url = new URL(request.url);
  if (url.searchParams.has("token")) return Response.json({ error: "Token must be sent as a WebSocket subprotocol" }, { status: 400 });
  if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
  const entries = (request.headers.get("sec-websocket-protocol") ?? "").split(",").map((entry) => entry.trim());
  if (entries.length !== 2 || entries[0] !== SOCKET_PROTOCOL || !TOKEN_PATTERN.test(entries[1] ?? "")) {
    return Response.json({ error: "Invalid overlay socket token" }, { status: 400 });
  }
  const overlay = await getOverlayByToken(env.DB, entries[1]!);
  if (!overlay) return Response.json({ error: "Overlay link is invalid" }, { status: 404 });
  const headers = new Headers(request.headers);
  headers.set("Sec-WebSocket-Protocol", SOCKET_PROTOCOL);
  headers.set("X-Link-Generation", String(overlay.link_generation));
  headers.set("X-Overlay-Channel", overlay.channel);
  const forwarded = new Request("https://overlay.internal/live", { headers, method: "GET" });
  return overlayStub(env, overlay.id).fetch(forwarded);
}

async function authorizeWrite(request: Request, env: ApiEnvironment): Promise<{ userId: string } | Response> {
  const session = await authenticatedSession(request, env);
  if (session instanceof Response) return session;
  if (!isSameOriginMutation(request)) return Response.json({ error: "Forbidden" }, { status: 403 });
  if (!isJsonRequest(request)) return Response.json({ error: "JSON content type required" }, { status: 415 });
  return session;
}

async function authenticatedSession(request: Request, env: ApiEnvironment): Promise<{ userId: string } | Response> {
  if (!env.SESSION_KEY) return Response.json({ error: "Authentication is not configured" }, { status: 503 });
  const session = await verifySessionCookie(readCookie(request.headers.get("cookie"), "session"), env.SESSION_KEY);
  return session ? { userId: session.userId } : Response.json({ error: "Authentication required" }, { status: 401 });
}

async function readJson(request: Request): Promise<Record<string, unknown> | Response> {
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > MAX_JSON_BODY_BYTES) return oversizedBodyResponse();
  const reader = request.body?.getReader();
  if (!reader) return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_JSON_BODY_BYTES) {
        try { await reader.cancel(); } catch { /* The request may already be complete. */ }
        return oversizedBodyResponse();
      }
      chunks.push(value);
    }
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    return isRecord(body) ? body : Response.json({ error: "JSON object required" }, { status: 400 });
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
}

function oversizedBodyResponse(): Response {
  return Response.json({ error: "Request body too large" }, { status: 413 });
}

function isJsonRequest(request: Request): boolean {
  return request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
}

function readCookie(header: string | null, name: string): string | undefined {
  return header?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function overlayStub(env: ApiEnvironment, id: string): OverlayStub {
  return env.OVERLAY.get(env.OVERLAY.idFromName(id)) as OverlayStub;
}

function publicOverlayForOwner(overlay: OverlayRecord): Record<string, unknown> {
  return {
    id: overlay.id,
    name: overlay.name,
    channel: overlay.channel,
    linkToken: overlay.link_token,
    generation: overlay.link_generation,
  };
}

function randomToken(byteLength: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(byteLength));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function withBearerCors(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("Vary", appendVary(headers.get("Vary"), "Authorization"));
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function appendVary(existing: string | null, value: string): string {
  const values = existing?.split(",").map((entry) => entry.trim()).filter(Boolean) ?? [];
  if (!values.some((entry) => entry.toLowerCase() === value.toLowerCase())) values.push(value);
  return values.join(", ");
}

function allowedMethod(action: string): string {
  return action === "config" ? "PUT" : "POST";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

