import { isSameOriginMutation, verifySessionCookie } from "./auth";
import {
  countActiveLooks,
  getLookByName,
  getLookBySlug,
  getOverlayById,
  getOverlayByToken,
  getOwnedLookById,
  getOwnedOverlay,
  listActiveLooks,
  listOwnedLooks,
  listOwnedOverlays,
  rotateOwnedOverlayLink,
  type LookRecord,
  type OverlayRecord,
} from "./db";
import { validateShareableTheme } from "../shared/theme";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SOCKET_PROTOCOL = "chatwerk-live";
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_LOOKS = 10;
const MAX_OVERLAYS = 3;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ApiEnvironment {
  DB: D1Database;
  OVERLAY: DurableObjectNamespace;
  SESSION_KEY?: string;
}

interface OverlayConfigSnapshot {
  revision: number;
  config: unknown;
  themeFrom?: string | null;
}

interface OverlayStub extends DurableObjectStub {
  get(generation: number): Promise<OverlayConfigSnapshot>;
  save(patch: Record<string, unknown>, baseRevision: number, generation: number): Promise<OverlayConfigSnapshot | { conflict: true; revision: number; config: unknown; themeFrom: string | null } | { invalid: true; field: string }>;
  applyLook(values: unknown, themeId: string, generation: number, idempotencyKey: string): Promise<OverlayConfigSnapshot & { snapshotId: string; undoExpiresAt: number }>;
  undoLook(snapshotId: string, expectedRevision: number, generation: number): Promise<OverlayConfigSnapshot | { conflict: true; revision: number; config: unknown; themeFrom: string | null } | { expired: true }>;
  resetForDelete(): Promise<void>;
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
  if (url.pathname === "/api/overlays" && request.method === "POST") return createOverlay(request, env);

  if (url.pathname === "/api/looks" && request.method === "GET") return listLooks(request, env);
  if (url.pathname === "/api/looks/mine" && request.method === "GET") return listMyLooks(request, env);
  if (url.pathname === "/api/looks" && request.method === "POST") return publishLook(request, env);

  const lookRoute = /^\/api\/looks\/([a-z0-9-]{1,100})(?:\/(copy|withdraw))?$/u.exec(url.pathname);
  if (lookRoute) {
    const [, slug, action] = lookRoute;
    if (!action && request.method === "GET") return readLook(env, slug!);
    if (action === "copy" && request.method === "POST") return copyLook(request, env, slug!);
    if (action === "withdraw" && request.method === "POST") return withdrawLook(request, env, slug!);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
  }

  const overlayManagementRoute = /^\/api\/overlays\/([0-9a-f-]{36})(?:\/(undo))?$/u.exec(url.pathname);
  if (overlayManagementRoute) {
    const [, overlayId, action] = overlayManagementRoute;
    if (action === "undo" && request.method === "POST") return undoLook(request, env, overlayId!);
    if (!action && request.method === "PATCH") return renameOverlay(request, env, overlayId!);
    if (!action && request.method === "DELETE") return deleteOverlay(request, env, overlayId!);
    return Response.json({ error: "Method not allowed" }, { status: 405 });
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

async function listLooks(request: Request, env: ApiEnvironment): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (session instanceof Response) return session;
  const looks = await listActiveLooks(env.DB);
  return Response.json({ looks: publicLooks(looks) }, { headers: { "Cache-Control": "no-store" } });
}

async function listMyLooks(request: Request, env: ApiEnvironment): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (session instanceof Response) return session;
  const looks = await listOwnedLooks(env.DB, session.userId);
  return Response.json({ looks: publicLooks(looks) }, { headers: { "Cache-Control": "no-store" } });
}

async function readLook(env: ApiEnvironment, slug: string): Promise<Response> {
  const look = await getLookBySlug(env.DB, slug);
  if (!look) return Response.json({ error: "look-not-found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  try {
    return Response.json(publicLook(look), { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "look-not-found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
  }
}

async function publishLook(request: Request, env: ApiEnvironment): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== "overlayId" && key !== "name") ||
    typeof body.overlayId !== "string" || !UUID_PATTERN.test(body.overlayId)) {
    return Response.json({ error: "invalid-publish-request" }, { status: 400 });
  }
  const name = validName(body.name);
  if (!name) return Response.json({ error: "invalid-name" }, { status: 400 });
  const overlay = await getOwnedOverlay(env.DB, body.overlayId, session.userId);
  if (!overlay) return Response.json({ error: "overlay-not-found" }, { status: 404 });
  const nameKey = name.toLowerCase();
  if (await getLookByName(env.DB, session.userId, nameKey)) {
    return Response.json({ error: "duplicate-name" }, { status: 409 });
  }
  if (await countActiveLooks(env.DB, session.userId) >= MAX_LOOKS) {
    return Response.json({ error: "look-limit", limit: MAX_LOOKS }, { status: 409 });
  }

  let snapshot: OverlayConfigSnapshot;
  try {
    snapshot = await overlayStub(env, overlay.id).get(overlay.link_generation);
  } catch {
    return Response.json({ error: "config-unavailable" }, { status: 503 });
  }
  let parentId: string | null = null;
  if (typeof snapshot.themeFrom === "string") {
    const parent = await env.DB.prepare("SELECT id FROM themes WHERE id = ?").bind(snapshot.themeFrom).first<{ id: string }>();
    if (parent) parentId = parent.id;
  }
  const values = validateShareableTheme(snapshot.config);
  const id = crypto.randomUUID();
  const baseSlug = slugBase(name);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const slug = `${baseSlug}-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const inserted = await env.DB.prepare(`
        INSERT INTO themes (id, owner_id, slug, name, values_json, parent_theme_id, name_key)
        SELECT ?, ?, ?, ?, ?, ?, ?
        WHERE (SELECT COUNT(*) FROM themes WHERE owner_id = ? AND withdrawn_at IS NULL) < ?
          AND NOT EXISTS (SELECT 1 FROM themes WHERE owner_id = ? AND name_key = ? AND withdrawn_at IS NULL)
        RETURNING id
      `).bind(id, session.userId, slug, name, JSON.stringify(values), parentId, nameKey,
        session.userId, MAX_LOOKS, session.userId, nameKey).first<{ id: string }>();
      if (inserted) {
        const look = await getOwnedLookById(env.DB, inserted.id, session.userId);
        if (!look) return Response.json({ error: "publish-failed" }, { status: 500 });
        return Response.json(publicLook(look), { status: 201, headers: { "Cache-Control": "no-store" } });
      }
      if (await getLookByName(env.DB, session.userId, nameKey)) {
        return Response.json({ error: "duplicate-name" }, { status: 409 });
      }
      return Response.json({ error: "look-limit", limit: MAX_LOOKS }, { status: 409 });
    } catch (error) {
      if (attempt === 4 || !isUniqueConstraintError(error)) {
        return Response.json({ error: "publish-failed" }, { status: 500 });
      }
    }
  }
  return Response.json({ error: "publish-failed" }, { status: 500 });
}

async function copyLook(request: Request, env: ApiEnvironment, slug: string): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => key !== "overlayId") || typeof body.overlayId !== "string" || !UUID_PATTERN.test(body.overlayId)) {
    return Response.json({ error: "invalid-copy-request" }, { status: 400 });
  }
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey !== null && !UUID_PATTERN.test(idempotencyKey)) {
    return Response.json({ error: "invalid-copy-request" }, { status: 400 });
  }
  const look = await getLookBySlug(env.DB, slug);
  if (!look) return Response.json({ error: "look-not-found" }, { status: 404 });
  const target = await getOverlayById(env.DB, body.overlayId);
  if (!target) return Response.json({ error: "overlay-not-found" }, { status: 404 });
  if (target.owner_id !== session.userId) return Response.json({ error: "forbidden" }, { status: 403 });
  try {
    const values = validateShareableTheme(JSON.parse(look.values_json) as unknown);
    const result = await overlayStub(env, target.id).applyLook(values, look.id, target.link_generation, idempotencyKey ?? crypto.randomUUID());
    return Response.json({ revision: result.revision, snapshotId: result.snapshotId, undoExpiresAt: result.undoExpiresAt }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "copy-failed" }, { status: 500 });
  }
}

async function undoLook(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const overlay = await getOwnedOverlay(env.DB, overlayId, session.userId);
  if (!overlay) return Response.json({ error: "overlay-not-found" }, { status: 404 });
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).some((key) => !["snapshotId", "expectedRevision"].includes(key)) ||
    typeof body.snapshotId !== "string" || !UUID_PATTERN.test(body.snapshotId) ||
    !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) {
    return Response.json({ error: "invalid-undo-request" }, { status: 400 });
  }
  try {
    const result = await overlayStub(env, overlay.id).undoLook(body.snapshotId, body.expectedRevision as number, overlay.link_generation);
    if ("expired" in result) return Response.json({ error: "undo-expired" }, { status: 409 });
    if ("conflict" in result && result.conflict) return Response.json({ error: "revision-conflict", revision: result.revision }, { status: 409 });
    return Response.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "undo-failed" }, { status: 500 });
  }
}

async function withdrawLook(request: Request, env: ApiEnvironment, slug: string): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 0) return Response.json({ error: "invalid-withdraw-request" }, { status: 400 });
  const result = await env.DB.prepare(`
    UPDATE themes SET withdrawn_at = CURRENT_TIMESTAMP
    WHERE slug = ? AND owner_id = ? AND withdrawn_at IS NULL
    RETURNING id
  `).bind(slug, session.userId).first<{ id: string }>();
  return result ? new Response(null, { status: 204 }) : Response.json({ error: "look-not-found" }, { status: 404 });
}

async function createOverlay(request: Request, env: ApiEnvironment): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 1) return Response.json({ error: "invalid-overlay-request" }, { status: 400 });
  const name = validName(body.name);
  if (!name) return Response.json({ error: "invalid-name" }, { status: 400 });
  if (await overlayNameExists(env.DB, session.userId, name)) return Response.json({ error: "overlay-name" }, { status: 409 });
  const id = crypto.randomUUID();
  const token = randomToken(32);
  const overlay = await env.DB.prepare(`
    INSERT INTO overlays (id, owner_id, link_token, name, channel)
    SELECT ?, ?, ?, ?, users.login
    FROM users
    WHERE users.id = ?
      AND (SELECT COUNT(*) FROM overlays WHERE owner_id = ?) < ?
      AND NOT EXISTS (SELECT 1 FROM overlays WHERE owner_id = ? AND lower(name) = lower(?))
    RETURNING id, owner_id, link_token, name, channel, link_generation
  `).bind(id, session.userId, token, name, session.userId, session.userId, MAX_OVERLAYS, session.userId, name).first<OverlayRecord>();
  if (overlay) return Response.json(publicOverlayForOwner(overlay), { status: 201, headers: { "Cache-Control": "no-store" } });
  if (await overlayNameExists(env.DB, session.userId, name)) return Response.json({ error: "overlay-name" }, { status: 409 });
  return Response.json({ error: "overlay-limit", limit: MAX_OVERLAYS }, { status: 409 });
}

async function renameOverlay(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 1) return Response.json({ error: "invalid-overlay-request" }, { status: 400 });
  const name = validName(body.name);
  if (!name) return Response.json({ error: "invalid-name" }, { status: 400 });
  const updated = await env.DB.prepare(`
    UPDATE overlays SET name = ? WHERE id = ? AND owner_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM overlays WHERE owner_id = ? AND id != ? AND lower(name) = lower(?)
      )
    RETURNING id, owner_id, link_token, name, channel, link_generation
  `).bind(name, overlayId, session.userId, session.userId, overlayId, name).first<OverlayRecord>();
  if (updated) return Response.json(publicOverlayForOwner(updated), { headers: { "Cache-Control": "no-store" } });
  return await getOwnedOverlay(env.DB, overlayId, session.userId)
    ? Response.json({ error: "overlay-name" }, { status: 409 })
    : Response.json({ error: "overlay-not-found" }, { status: 404 });
}

async function deleteOverlay(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const body = await readJson(request);
  if (body instanceof Response) return body;
  if (Object.keys(body).length !== 0) return Response.json({ error: "invalid-delete-request" }, { status: 400 });
  let deleted: { id: string } | null;
  try {
    deleted = await env.DB.prepare(`
      DELETE FROM overlays WHERE id = ? AND owner_id = ?
        AND (SELECT COUNT(*) FROM overlays WHERE owner_id = ?) > 1
      RETURNING id
    `).bind(overlayId, session.userId, session.userId).first<{ id: string }>();
  } catch {
    return Response.json({ error: "delete-failed" }, { status: 500 });
  }
  if (!deleted) return Response.json({ error: "last-overlay" }, { status: 409 });
  try {
    await overlayStub(env, deleted.id).resetForDelete();
  } catch (error) {
    // ponytail: Failed cleanup leaves orphan state, and sockets stay open until they reconnect.
    console.error("Overlay cleanup failed after deletion", { overlayId: deleted.id, error });
  }
  return new Response(null, { status: 204 });
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

function publicLook(look: LookRecord): Record<string, unknown> {
  let parent: Record<string, unknown> | null = null;
  if (look.parent_theme_id !== null) {
    parent = look.parent_withdrawn_at !== null || look.parent_name === null
      ? { removed: true }
      : { removed: false, name: look.parent_name, author: look.parent_author, slug: look.parent_slug };
  }
  return {
    id: look.id,
    slug: look.slug,
    name: look.name,
    author: look.author_login,
    values: validateShareableTheme(JSON.parse(look.values_json) as unknown),
    parent,
    withdrawn: look.withdrawn_at !== null,
    createdAt: look.created_at,
  };
}

function publicLooks(looks: LookRecord[]): Record<string, unknown>[] {
  return looks.flatMap((look) => {
    try { return [publicLook(look)]; } catch { return []; }
  });
}

function validName(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const name = input.trim();
  if (name.length < 1 || name.length > 40 || [...name].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 32 || codePoint === 127;
  })) return null;
  return name;
}

async function overlayNameExists(db: D1Database, ownerId: string, name: string): Promise<boolean> {
  const row = await db.prepare("SELECT id FROM overlays WHERE owner_id = ? AND lower(name) = lower(?)")
    .bind(ownerId, name).first<{ id: string }>();
  return row !== null;
}

function slugBase(name: string): string {
  const base = name.normalize("NFKD").replace(/[\u0300-\u036f]/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 48).replace(/-+$/u, "");
  return base || "look";
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Error && /unique constraint|themes\.slug/iu.test(error.message);
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

