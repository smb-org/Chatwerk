import { adminSessionForRequest, isSameOriginMutation, verifySessionCookie } from "./auth";
import {
  countActiveLooks,
  getLookByName,
  getLookBySlug,
  getOverlayAccess,
  getOverlayByToken,
  getOwnedLookById,
  listActiveLooks,
  listAccessibleOverlays,
  listOverlayEditors,
  listOwnedLooks,
  getOverlayInviteExpiry,
  rotateOwnedOverlayLink,
  type OverlayRole,
  type LookRecord,
  type OverlayRecord,
} from "./db";
import { validateShareableTheme } from "../shared/theme";

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const SOCKET_PROTOCOL = "chatwerk-live";
const MAX_JSON_BODY_BYTES = 64 * 1024;
const MAX_LOOKS = 10;
const MAX_OVERLAYS = 3;
const MAX_EDITORS = 5;
const INVITE_SECONDS = 48 * 60 * 60;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface ApiEnvironment {
  DB: D1Database;
  OVERLAY: DurableObjectNamespace;
  SESSION_KEY?: string;
  ADMIN_TWITCH_IDS?: string;
}

interface AdminOverlayStats {
  channels: string[] | null;
  connectedOutputs: number;
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
  getAdminStats(): Promise<AdminOverlayStats>;
}

export async function handleApiRequest(request: Request, env: ApiEnvironment): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname === "/api/admin" || url.pathname.startsWith("/api/admin/")) {
    return readAdminOverview(request, env, url.pathname);
  }
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

  const acceptInviteRoute = /^\/api\/invites\/([A-Za-z0-9_-]{43})\/accept$/u.exec(url.pathname);
  if (acceptInviteRoute && request.method === "POST") return acceptInvite(request, env, acceptInviteRoute[1]!);

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

  const editorRoute = /^\/api\/overlays\/([0-9a-f-]{36})\/editors\/([A-Za-z0-9_-]{1,128})$/u.exec(url.pathname);
  if (editorRoute && request.method === "DELETE") return removeEditor(request, env, editorRoute[1]!, editorRoute[2]!);

  const inviteRoute = /^\/api\/overlays\/([0-9a-f-]{36})\/invite$/u.exec(url.pathname);
  if (inviteRoute) {
    if (request.method === "POST") return createInvite(request, env, inviteRoute[1]!);
    if (request.method === "DELETE") return revokeInvite(request, env, inviteRoute[1]!);
    return Response.json({ error: "Method not allowed" }, { status: 405, headers: { Allow: "POST, DELETE" } });
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

interface AdminOverlayRow {
  id: string;
  owner_id: string;
  name: string;
  channel: string;
  created_at: string;
}

interface AdminOverviewUser {
  twitchId: string;
  login: string;
  createdAt: string;
  lastLoginAt: string | null;
  overlays: Array<{
    name: string;
    channels: string[];
    createdAt: string;
    connectedOutputs: number | null;
  }>;
  editorLogins: string[];
  pendingInvite: boolean;
  activeGalleryLooks: number;
}

async function readAdminOverview(request: Request, env: ApiEnvironment, pathname: string): Promise<Response> {
  const session = await adminSessionForRequest(request, env.DB, env.SESSION_KEY, env.ADMIN_TWITCH_IDS);
  if (!session) return adminNotFound();
  if (request.method !== "GET" || pathname !== "/api/admin/overview") return adminNotFound();
  if (request.headers.has("origin") && !isSameOriginMutation(request)) return adminNotFound();

  const now = Math.floor(Date.now() / 1000);
  const [usersResult, overlaysResult, editorsResult, inviteResult, looksResult] = await Promise.all([
    env.DB.prepare(`
      SELECT id, login, created_at, last_login_at
      FROM users
      ORDER BY last_login_at IS NULL ASC, last_login_at DESC, created_at DESC, id ASC
    `).all<{ id: string; login: string; created_at: string; last_login_at: string | null }>(),
    env.DB.prepare(`
      SELECT id, owner_id, name, channel, created_at
      FROM overlays
      ORDER BY owner_id, created_at DESC, name COLLATE NOCASE ASC, id ASC
    `).all<AdminOverlayRow>(),
    env.DB.prepare(`
      SELECT DISTINCT overlay.owner_id AS owner_id, editor.login AS login
      FROM overlay_editors AS membership
      JOIN overlays AS overlay ON overlay.id = membership.overlay_id
      JOIN users AS editor ON editor.id = membership.user_id
      ORDER BY overlay.owner_id, editor.login COLLATE NOCASE ASC
    `).all<{ owner_id: string; login: string }>(),
    env.DB.prepare(`
      SELECT DISTINCT overlay.owner_id AS owner_id
      FROM overlays AS overlay
      JOIN overlay_invites AS invite ON invite.overlay_id = overlay.id
      WHERE invite.expires_at > ?
    `).bind(now).all<{ owner_id: string }>(),
    env.DB.prepare(`
      SELECT owner_id, COUNT(*) AS count
      FROM themes
      WHERE withdrawn_at IS NULL
      GROUP BY owner_id
    `).all<{ owner_id: string; count: number }>(),
  ]);

  const users: AdminOverviewUser[] = usersResult.results.map((row) => ({
    twitchId: row.id,
    login: row.login,
    createdAt: row.created_at,
    lastLoginAt: row.last_login_at,
    overlays: [],
    editorLogins: [],
    pendingInvite: false,
    activeGalleryLooks: 0,
  }));
  const usersById = new Map(users.map((user) => [user.twitchId, user]));
  for (const row of editorsResult.results) usersById.get(row.owner_id)?.editorLogins.push(row.login);
  for (const row of inviteResult.results) {
    const user = usersById.get(row.owner_id);
    if (user) user.pendingInvite = true;
  }
  for (const row of looksResult.results) {
    const user = usersById.get(row.owner_id);
    if (user) user.activeGalleryLooks = row.count;
  }

  // ponytail: This fan-out makes one Durable Object call per overlay and is bounded by Workers subrequest limits; counts degrade to unknown when calls fail. Upgrade by paginating users and aggregating totals in SQL.
  const overlaySummaries = await mapWithConcurrency(overlaysResult.results, 8, async (row) => {
    let channels: string[] = row.channel ? [row.channel] : [];
    let connectedOutputs: number | null = null;
    try {
      const stats = await overlayStub(env, row.id).getAdminStats();
      if (!Number.isSafeInteger(stats.connectedOutputs) || stats.connectedOutputs < 0) throw new TypeError("Invalid output count");
      if (stats.channels?.length) channels = stats.channels;
      connectedOutputs = stats.connectedOutputs;
    } catch {
      // The operator overview remains available when an individual overlay is unavailable.
    }
    return {
      ownerId: row.owner_id,
      overlay: { name: row.name, channels, createdAt: row.created_at, connectedOutputs },
    };
  });
  for (const item of overlaySummaries) usersById.get(item.ownerId)?.overlays.push(item.overlay);

  const totalOutputs = overlaySummaries.reduce((total, item) => {
    if (item.overlay.connectedOutputs === null || total === null) return null;
    return total + item.overlay.connectedOutputs;
  }, 0 as number | null);
  return Response.json({
    totals: { users: users.length, overlays: overlaysResult.results.length, connectedOutputs: totalOutputs },
    users,
  }, { headers: { "Cache-Control": "no-store" } });
}

async function mapWithConcurrency<T, U>(items: T[], concurrency: number, operation: (item: T) => Promise<U>): Promise<U[]> {
  const results = new Array<U>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(items.length, concurrency);
  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index]!);
    }
  }));
  return results;
}

function adminNotFound(): Response {
  return Response.json({ error: "Not found" }, { status: 404, headers: { "Cache-Control": "no-store" } });
}

async function listOverlays(request: Request, env: ApiEnvironment): Promise<Response> {
  const session = await authenticatedSession(request, env);
  if (session instanceof Response) return session;
  const records = await listAccessibleOverlays(env.DB, session.userId);
  const overlays = await Promise.all(records.map(async (record) => {
    if (record.role === "owner") {
      record.editors = await listOverlayEditors(env.DB, record.id);
      record.invite_expires_at = await getOverlayInviteExpiry(env.DB, record.id);
    }
    return publicOverlay(record, record.role);
  }));
  return Response.json({ overlays }, { headers: { "Cache-Control": "no-store" } });
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
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  if (Object.keys(body).some((key) => key !== "overlayId" && key !== "name") ||
    typeof body.overlayId !== "string" || !UUID_PATTERN.test(body.overlayId)) {
    return Response.json({ error: "invalid-publish-request" }, { status: 400 });
  }
  const name = validName(body.name);
  if (!name) return Response.json({ error: "invalid-name" }, { status: 400 });
  const access = await requireOverlay(request, env, body.overlayId, "editor", session);
  if (access instanceof Response) return access;
  const overlay = access.overlay;
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
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  if (Object.keys(body).some((key) => key !== "overlayId") || typeof body.overlayId !== "string" || !UUID_PATTERN.test(body.overlayId)) {
    return Response.json({ error: "invalid-copy-request" }, { status: 400 });
  }
  const idempotencyKey = request.headers.get("Idempotency-Key");
  if (idempotencyKey !== null && !UUID_PATTERN.test(idempotencyKey)) {
    return Response.json({ error: "invalid-copy-request" }, { status: 400 });
  }
  const access = await requireOverlay(request, env, body.overlayId, "editor", session);
  if (access instanceof Response) return access;
  const look = await getLookBySlug(env.DB, slug);
  if (!look) return Response.json({ error: "look-not-found" }, { status: 404 });
  const target = access.overlay;
  try {
    const values = validateShareableTheme(JSON.parse(look.values_json) as unknown);
    const result = await overlayStub(env, target.id).applyLook(values, look.id, target.link_generation, idempotencyKey ?? crypto.randomUUID());
    return Response.json({ revision: result.revision, snapshotId: result.snapshotId, undoExpiresAt: result.undoExpiresAt }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return Response.json({ error: "copy-failed" }, { status: 500 });
  }
}

async function undoLook(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const access = await requireOverlay(request, env, overlayId, "editor");
  if (access instanceof Response) return access;
  const overlay = access.overlay;
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
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  if (Object.keys(body).length !== 0) return Response.json({ error: "invalid-withdraw-request" }, { status: 400 });
  const result = await env.DB.prepare(`
    UPDATE themes SET withdrawn_at = CURRENT_TIMESTAMP
    WHERE slug = ? AND owner_id = ? AND withdrawn_at IS NULL
    RETURNING id
  `).bind(slug, session.userId).first<{ id: string }>();
  return result ? new Response(null, { status: 204 }) : Response.json({ error: "look-not-found" }, { status: 404 });
}

async function createOverlay(request: Request, env: ApiEnvironment): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
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
  if (overlay) return Response.json(publicOverlay(overlay, "owner"), { status: 201, headers: { "Cache-Control": "no-store" } });
  if (await overlayNameExists(env.DB, session.userId, name)) return Response.json({ error: "overlay-name" }, { status: 409 });
  return Response.json({ error: "overlay-limit", limit: MAX_OVERLAYS }, { status: 409 });
}

async function renameOverlay(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const access = await requireOverlay(request, env, overlayId, "owner");
  if (access instanceof Response) return access;
  if (Object.keys(body).length !== 1) return Response.json({ error: "invalid-overlay-request" }, { status: 400 });
  const name = validName(body.name);
  if (!name) return Response.json({ error: "invalid-name" }, { status: 400 });
  const updated = await env.DB.prepare(`
    UPDATE overlays SET name = ? WHERE id = ? AND owner_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM overlays WHERE owner_id = ? AND id != ? AND lower(name) = lower(?)
      )
    RETURNING id, owner_id, link_token, name, channel, link_generation
  `).bind(name, overlayId, access.userId, access.userId, overlayId, name).first<OverlayRecord>();
  if (updated) return Response.json(publicOverlay(updated, "owner"), { headers: { "Cache-Control": "no-store" } });
  return await getOverlayAccess(env.DB, overlayId, access.userId)
    ? Response.json({ error: "overlay-name" }, { status: 409 })
    : Response.json({ error: "overlay-not-found" }, { status: 404 });
}

async function deleteOverlay(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const access = await requireOverlay(request, env, overlayId, "owner");
  if (access instanceof Response) return access;
  if (Object.keys(body).length !== 0) return Response.json({ error: "invalid-delete-request" }, { status: 400 });
  let deleted: { id: string } | null;
  try {
    deleted = await env.DB.prepare(`
      DELETE FROM overlays WHERE id = ? AND owner_id = ?
        AND (SELECT COUNT(*) FROM overlays WHERE owner_id = ?) > 1
      RETURNING id
    `).bind(overlayId, access.userId, access.userId).first<{ id: string }>();
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

async function createInvite(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const access = await requireOverlay(request, env, overlayId, "owner");
  if (access instanceof Response) return access;
  if (Object.keys(body).length !== 0) return Response.json({ error: "invalid-invite-request" }, { status: 400 });

  const token = randomToken(32);
  const expiresAt = Math.floor(Date.now() / 1000) + INVITE_SECONDS;
  const invite = await env.DB.prepare(`
    INSERT INTO overlay_invites (overlay_id, token, expires_at)
    SELECT id, ?, ? FROM overlays WHERE id = ? AND owner_id = ?
    ON CONFLICT(overlay_id) DO UPDATE SET token = excluded.token, expires_at = excluded.expires_at
    RETURNING expires_at
  `).bind(token, expiresAt, overlayId, access.userId).first<{ expires_at: number }>();
  if (!invite) return Response.json({ error: "overlay-not-found" }, { status: 404 });
  // authorizeWrite has checked that Origin is same-origin; using it preserves the host the browser opened.
  const inviteUrl = new URL("/studio", request.headers.get("Origin")!);
  inviteUrl.searchParams.set("invite", token);
  return Response.json({ inviteUrl: inviteUrl.toString(), expiresAt: new Date(invite.expires_at * 1000).toISOString() }, {
    headers: { "Cache-Control": "no-store" },
  });
}

async function revokeInvite(request: Request, env: ApiEnvironment, overlayId: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const access = await requireOverlay(request, env, overlayId, "owner");
  if (access instanceof Response) return access;
  if (Object.keys(body).length !== 0) return Response.json({ error: "invalid-invite-request" }, { status: 400 });
  await env.DB.prepare(`
    DELETE FROM overlay_invites WHERE overlay_id = ?
      AND EXISTS (SELECT 1 FROM overlays WHERE id = ? AND owner_id = ?)
  `).bind(overlayId, overlayId, access.userId).run();
  return new Response(null, { status: 204 });
}

async function removeEditor(request: Request, env: ApiEnvironment, overlayId: string, editorId: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const targetUserId = editorId === "me" ? session.userId : editorId;
  const role: OverlayRole = targetUserId === session.userId ? "editor" : "owner";
  const access = await requireOverlay(request, env, overlayId, role, session);
  if (access instanceof Response) return access;
  if (Object.keys(body).length !== 0) return Response.json({ error: "invalid-editor-request" }, { status: 400 });

  const deleted = await env.DB.prepare(`
    DELETE FROM overlay_editors
    WHERE overlay_id = ? AND user_id = ?
      AND (user_id = ? OR EXISTS (SELECT 1 FROM overlays WHERE id = ? AND owner_id = ?))
    RETURNING user_id
  `).bind(overlayId, targetUserId, session.userId, overlayId, session.userId).first<{ user_id: string }>();
  return deleted ? new Response(null, { status: 204 }) : Response.json({ error: "editor-not-found" }, { status: 404 });
}

async function acceptInvite(request: Request, env: ApiEnvironment, token: string): Promise<Response> {
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const session = await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  if (Object.keys(body).length !== 0) return Response.json({ error: "invalid-invite-request" }, { status: 400 });

  const now = Math.floor(Date.now() / 1000);
  const results = await env.DB.batch([
    env.DB.prepare(`
      UPDATE overlay_invites SET token = token
      WHERE token = ? AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM overlays
          WHERE overlays.id = overlay_invites.overlay_id AND overlays.owner_id != ?
        )
        AND NOT EXISTS (SELECT 1 FROM overlay_editors WHERE overlay_id = overlay_invites.overlay_id AND user_id = ?)
        AND (SELECT COUNT(*) FROM overlay_editors WHERE overlay_id = overlay_invites.overlay_id) < ?
      RETURNING overlay_id
    `).bind(token, now, session.userId, session.userId, MAX_EDITORS),
    env.DB.prepare(`
      INSERT INTO overlay_editors (overlay_id, user_id)
      SELECT invite.overlay_id, ?
      FROM overlay_invites AS invite
      JOIN overlays ON overlays.id = invite.overlay_id
      WHERE invite.token = ? AND invite.expires_at > ? AND overlays.owner_id != ?
        AND NOT EXISTS (SELECT 1 FROM overlay_editors WHERE overlay_id = invite.overlay_id AND user_id = ?)
        AND (SELECT COUNT(*) FROM overlay_editors WHERE overlay_id = invite.overlay_id) < ?
      ON CONFLICT(overlay_id, user_id) DO NOTHING
    `).bind(session.userId, token, now, session.userId, session.userId, MAX_EDITORS),
    env.DB.prepare(`
      DELETE FROM overlay_invites
      WHERE token = ? AND expires_at > ?
        AND EXISTS (
          SELECT 1 FROM overlays
          WHERE overlays.id = overlay_invites.overlay_id AND overlays.owner_id != ?
        )
        AND EXISTS (
          SELECT 1 FROM overlay_editors
          WHERE overlay_editors.overlay_id = overlay_invites.overlay_id AND overlay_editors.user_id = ?
        )
        AND changes() > 0
      RETURNING overlay_id
    `).bind(token, now, session.userId, session.userId),
  ]);
  const claimed = results[0]?.results?.[0] as { overlay_id?: string } | undefined;
  if (claimed?.overlay_id) {
    const access = await getOverlayAccess(env.DB, claimed.overlay_id, session.userId);
    if (!access) return Response.json({ error: "invite-invalid" }, { status: 410 });
    const editor = await env.DB.prepare("SELECT login FROM users WHERE id = ?").bind(access.overlay.owner_id).first<string>("login");
    access.overlay.owner_login = editor ?? "";
    return Response.json({ overlay: publicOverlay(access.overlay, "editor") }, { headers: { "Cache-Control": "no-store" } });
  }

  const state = await env.DB.prepare(`
    SELECT overlays.id AS overlay_id,
      overlays.owner_id,
      (SELECT COUNT(*) FROM overlay_editors WHERE overlay_id = overlay_invites.overlay_id) AS editor_count
    FROM overlay_invites
    JOIN overlays ON overlays.id = overlay_invites.overlay_id
    WHERE overlay_invites.token = ? AND overlay_invites.expires_at > ?
  `).bind(token, now).first<{ overlay_id: string; owner_id: string; editor_count: number }>();
  if (!state) return Response.json({ error: "invite-invalid" }, { status: 410 });
  if (state.owner_id === session.userId) return Response.json({ error: "own-overlay" }, { status: 400 });
  const alreadyEditor = await env.DB.prepare("SELECT 1 FROM overlay_editors WHERE overlay_id = (SELECT overlay_id FROM overlay_invites WHERE token = ?) AND user_id = ?")
    .bind(token, session.userId).first();
  if (alreadyEditor) {
    const access = await getOverlayAccess(env.DB, state.overlay_id, session.userId);
    if (!access) return Response.json({ error: "invite-invalid" }, { status: 410 });
    const ownerLogin = await env.DB.prepare("SELECT login FROM users WHERE id = ?").bind(access.overlay.owner_id).first<string>("login");
    access.overlay.owner_login = ownerLogin ?? "";
    return Response.json({ overlay: publicOverlay(access.overlay, "editor") }, { headers: { "Cache-Control": "no-store" } });
  }
  if (state.editor_count >= MAX_EDITORS) return Response.json({ error: "helper-limit" }, { status: 409 });
  return Response.json({ error: "invite-invalid" }, { status: 410 });
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
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const access = await requireOverlay(request, env, overlayId, "editor");
  if (access instanceof Response) return access;
  const overlay = access.overlay;
  if (!Number.isSafeInteger(body.baseRevision) || (body.baseRevision as number) < 0 || !isRecord(body.patch)) {
    return Response.json({ error: "Invalid config update" }, { status: 400 });
  }
  if (access.role === "editor" && (Object.hasOwn(body.patch, "customCss") || Object.hasOwn(body.patch, "customCssEnabled"))) {
    return Response.json({ error: "owner-only-field" }, { status: 403 });
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
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const access = await requireOverlay(request, env, overlayId, "owner");
  if (access instanceof Response) return access;
  const overlay = access.overlay;
  if (Object.keys(body).length !== 0) return Response.json({ error: "Invalid rotate request" }, { status: 400 });

  const linkToken = randomToken(32);
  const updated = await rotateOwnedOverlayLink(env.DB, overlay.id, access.userId, linkToken);
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
  const body = await readJson(request);
  if (body instanceof Response) return body;
  const access = await requireOverlay(request, env, overlayId, "editor");
  if (access instanceof Response) return access;
  const overlay = access.overlay;
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

async function requireOverlay(
  request: Request,
  env: ApiEnvironment,
  overlayId: string,
  role: OverlayRole,
  sessionOverride?: { userId: string },
): Promise<{ userId: string; overlay: OverlayRecord; role: OverlayRole } | Response> {
  const session = sessionOverride ?? await authorizeWrite(request, env);
  if (session instanceof Response) return session;
  const access = await getOverlayAccess(env.DB, overlayId, session.userId);
  // ponytail: This post-body D1 membership check is the authorization ceiling; removal can still race the later Durable Object call.
  if (!access) return Response.json({ error: "overlay-not-found" }, { status: 404 });
  if (role === "owner" && access.role !== "owner") return Response.json({ error: "owner-only" }, { status: 403 });
  return { ...session, ...access };
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

function publicOverlay(overlay: OverlayRecord, role: OverlayRole): Record<string, unknown> {
  const result: Record<string, unknown> = {
    id: overlay.id,
    name: overlay.name,
    channel: overlay.channel,
    role,
    linkToken: overlay.link_token,
    generation: overlay.link_generation,
  };
  if (role === "owner") {
    const expiresAt = overlay.invite_expires_at;
    return {
      ...result,
      editors: overlay.editors ?? [],
      invite: typeof expiresAt === "number" ? { expiresAt: new Date(expiresAt * 1000).toISOString() } : null,
    };
  }
  return { ...result, ownerLogin: overlay.owner_login ?? "" };
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

