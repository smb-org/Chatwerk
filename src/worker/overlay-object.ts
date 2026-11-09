import { DurableObject } from "cloudflare:workers";
import { DEFAULTS, SCHEMA_VERSION, ThemeValidationError, validateShareableTheme, validateTheme, type ThemeConfig } from "../shared/theme";
import type { HypeTrainSocketMessage } from "./hype-train";

const SOCKET_TAG = "overlay";
const MAX_SOCKETS = 16;
const MAX_FRAME_BYTES = 4 * 1024;
const MAX_ATTACHMENT_BYTES = 2 * 1024;
const NO_REVISION_FRAME_LIMIT = 60;
const MESSAGE_BYTE_LIMIT = 1024 * 1024;
const MESSAGE_WINDOW_MS = 60_000;
const UNDO_WINDOW_MS = 10_000;
const BUILD_ID_PATTERN = /^[a-f0-9]{16}$/u;
const frameEncoder = new TextEncoder();
type ClientType = "browser" | "obs" | "widget" | "studio";
type ChatStatus = "connected" | "reconnecting" | "idle";

interface SocketAttachment {
  socketId: string;
  channel: string | null;
  client: ClientType | null;
  acknowledgedRevision: number | null;
  chatStatus: ChatStatus;
  buildId: string | null;
  windowStartedAt: number;
  noRevisionFrameCount: number;
  messageByteCount: number;
}

interface Snapshot {
  revision: number;
  config: OverlayConfig;
  themeFrom: string | null;
}

interface OverlayConfig extends ThemeConfig {
  customCss?: string;
  customCssEnabled?: boolean;
}

interface UndoSnapshotRow {
  [key: string]: string | number | null;
  config_json: string;
  theme_from: string | null;
  applied_revision: number | null;
}

type CopyResult = Snapshot & { snapshotId: string; undoExpiresAt: number };

export function closeDeadSockets(sockets: Iterable<WebSocket>): void {
  for (const socket of sockets) {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) continue;
    try {
      socket.close(4004, "stale_socket");
    } catch {
      // A stale hibernating socket may already have completed its close handshake.
    }
  }
}

export class OverlayObject extends DurableObject<Env> {
  private storageReady = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async get(generation: number): Promise<Snapshot> {
    this.prepareGeneration(generation);
    return this.readSnapshot();
  }

  async getAdminStats(): Promise<{ channels: string[] | null; connectedOutputs: number }> {
    let channels: string[] | null = null;
    try {
      const row = this.ctx.storage.sql.exec<{ config_json: string }>(
        "SELECT config_json FROM overlay_config WHERE singleton = 1",
      ).toArray()[0];
      if (row) {
        const stored = JSON.parse(row.config_json) as unknown;
        if (isRecord(stored) && Array.isArray(stored.channels) && stored.channels.every((channel) => typeof channel === "string")) {
          channels = stored.channels;
        }
      }
    } catch {
      // New overlays may not have initialized config storage yet.
    }
    const counts = { browser: 0, obs: 0, widget: 0 };
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = socket.deserializeAttachment() as Partial<SocketAttachment> | null;
      if (!attachment || !isClientType(attachment.client) || attachment.client === "studio" ||
        !Number.isSafeInteger(attachment.acknowledgedRevision) || (attachment.acknowledgedRevision as number) < 0) continue;
      counts[attachment.client] += 1;
    }
    return { channels, connectedOutputs: counts.browser + counts.obs + counts.widget };
  }

  async save(
    patch: Record<string, unknown>,
    baseRevision: number,
    generation: number,
  ): Promise<Snapshot | { conflict: true; revision: number; config: OverlayConfig; themeFrom: string | null } | { invalid: true; field: string }> {
    this.prepareGeneration(generation);
    const current = this.readSnapshot();
    if (baseRevision !== current.revision) {
      return { conflict: true, revision: current.revision, config: current.config, themeFrom: current.themeFrom };
    }
    if (!isRecord(patch)) return { invalid: true, field: "theme" };
    let config: OverlayConfig;
    try {
      config = validateOverlayConfig({ ...current.config, ...patch, schemaVersion: SCHEMA_VERSION });
    } catch (error) {
      if (error instanceof ThemeValidationError) return { invalid: true, field: error.fieldName };
      throw error;
    }
    const revision = current.revision + 1;
    this.writeSnapshot(revision, config, current.themeFrom);
    this.broadcast({ type: "config", schemaVersion: SCHEMA_VERSION, revision, config, themeFrom: current.themeFrom });
    return { revision, config, themeFrom: current.themeFrom };
  }

  async applyLook(values: unknown, themeId: string, generation: number, idempotencyKey = crypto.randomUUID()): Promise<CopyResult> {
    this.prepareGeneration(generation);
    const now = Date.now();
    this.ctx.storage.sql.exec("DELETE FROM overlay_undo_snapshots WHERE created_at < ?", now - UNDO_WINDOW_MS);
    const replay = this.ctx.storage.sql.exec<{ result_json: string }>(
      "SELECT result_json FROM overlay_undo_snapshots WHERE idempotency_key = ?", idempotencyKey,
    ).toArray()[0];
    if (replay) {
      const result = JSON.parse(replay.result_json) as CopyResult;
      if (result.themeFrom !== themeId) throw new TypeError("Copy key was already used for another look");
      return result;
    }
    const current = this.readSnapshot();
    const theme = validateShareableTheme(values);
    const snapshotId = crypto.randomUUID();
    const config: OverlayConfig = {
      ...current.config,
      ...theme,
      ...(current.config.customCss === undefined ? {} : { customCss: current.config.customCss }),
      ...(current.config.customCss === undefined ? {} : { customCssEnabled: false }),
    };
    const revision = current.revision + 1;
    const result = { revision, config, themeFrom: themeId, snapshotId, undoExpiresAt: now + UNDO_WINDOW_MS };
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec(`
        INSERT INTO overlay_undo_snapshots
          (snapshot_id, config_json, theme_from, created_at, applied_revision, idempotency_key, result_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `, snapshotId, JSON.stringify(current.config), current.themeFrom, now, revision, idempotencyKey, JSON.stringify(result));
      this.writeSnapshot(revision, config, themeId);
    });
    this.broadcast({ type: "config", schemaVersion: SCHEMA_VERSION, revision, config, themeFrom: themeId });
    return result;
  }

  async undoLook(
    snapshotId: string,
    expectedRevision: number,
    generation: number,
  ): Promise<Snapshot | { conflict: true; revision: number; config: OverlayConfig; themeFrom: string | null } | { expired: true }> {
    this.prepareGeneration(generation);
    const current = this.readSnapshot();
    if (expectedRevision !== current.revision) {
      return { conflict: true, revision: current.revision, config: current.config, themeFrom: current.themeFrom };
    }
    const row = this.ctx.storage.sql.exec<UndoSnapshotRow>(
      "SELECT config_json, theme_from, applied_revision FROM overlay_undo_snapshots WHERE snapshot_id = ? AND created_at >= ?",
      snapshotId, Date.now() - UNDO_WINDOW_MS,
    ).toArray()[0];
    if (!row) return { expired: true };
    if (row.applied_revision !== expectedRevision) {
      return { conflict: true, revision: current.revision, config: current.config, themeFrom: current.themeFrom };
    }
    const before = JSON.parse(row.config_json) as unknown;
    const config = validateOverlayConfig(before);
    const themeFrom = row.theme_from;
    const revision = current.revision + 1;
    this.writeSnapshot(revision, config, themeFrom);
    this.broadcast({ type: "config", schemaVersion: SCHEMA_VERSION, revision, config, themeFrom });
    return { revision, config, themeFrom };
  }

  async resetForDelete(): Promise<void> {
    this.ensureStorage();
    this.assertActive();
    this.ctx.storage.transactionSync(() => {
      this.ctx.storage.sql.exec("DELETE FROM overlay_config");
      this.ctx.storage.sql.exec("DELETE FROM overlay_link_state");
      this.ctx.storage.sql.exec("DELETE FROM overlay_test_line_targets");
      this.ctx.storage.sql.exec("DELETE FROM overlay_test_lines");
      this.ctx.storage.sql.exec("DELETE FROM overlay_undo_snapshots");
      this.ctx.storage.sql.exec("INSERT INTO overlay_tombstone(singleton) VALUES (1)");
    });
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      try { socket.close(4001, "overlay_deleted"); } catch { /* Socket is already closed. */ }
    }
  }

  async testLine(generation: number): Promise<string> {
    this.prepareGeneration(generation);
    const id = crypto.randomUUID();
    const now = Date.now();
    this.ctx.storage.sql.exec(
      "DELETE FROM overlay_test_line_targets WHERE test_id IN (SELECT id FROM overlay_test_lines WHERE created_at < ?)",
      now - 60_000,
    );
    this.ctx.storage.sql.exec("DELETE FROM overlay_test_lines WHERE created_at < ?", now - 60_000);
    const outputs = this.ctx.getWebSockets(SOCKET_TAG).filter((socket) => {
      const attachment = readAttachment(socket);
      return socket.readyState === WebSocket.OPEN && attachment.client !== null && attachment.client !== "studio" &&
        attachment.acknowledgedRevision !== null;
    });
    this.ctx.storage.sql.exec(
      "INSERT INTO overlay_test_lines(id, total, created_at) VALUES (?, ?, ?)", id, outputs.length, now,
    );
    for (const socket of outputs) {
      const attachment = readAttachment(socket);
      this.ctx.storage.sql.exec(
        "INSERT INTO overlay_test_line_targets(test_id, socket_id, acknowledged) VALUES (?, ?, 0)",
        id, attachment.socketId,
      );
      send(socket, { type: "test-line", id });
    }
    this.sendTestProgress(id, 0, outputs.length);
    return id;
  }

  async hypeTrain(message: HypeTrainSocketMessage): Promise<void> {
    this.ensureStorage();
    if (this.isDeleted()) return;
    const generation = this.readGeneration() ?? 1;
    this.prepareGeneration(generation);
    const config = this.readSnapshot().config;
    const configuredChannels = new Set(config.channels.map((channel) => channel.toLowerCase().replace(/^#/u, "")));
    if (!configuredChannels.has(message.channel.toLowerCase())) return;
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const client = readAttachment(socket).client;
      if (client === null || client === "studio") continue;
      send(socket, message);
    }
  }

  async revoke(nextGeneration?: number): Promise<void> {
    this.ensureStorage();
    const current = this.readGeneration() ?? 0;
    const generation = nextGeneration ?? current + 1;
    this.prepareGeneration(generation);
  }

  async fetch(request: Request): Promise<Response> {
    this.ensureStorage();
    if (this.isDeleted()) return Response.json({ error: "overlay-deleted" }, { status: 410 });
    if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return new Response(null, { status: 426 });
    const requestedGeneration = Number(request.headers.get("x-link-generation"));
    if (!Number.isSafeInteger(requestedGeneration) || requestedGeneration < 1) {
      return Response.json({ error: "Invalid link generation" }, { status: 400 });
    }
    try {
      this.prepareGeneration(requestedGeneration);
    } catch (error) {
      if (error instanceof RangeError) return Response.json({ error: "Link generation expired" }, { status: 409 });
      throw error;
    }

    const sockets = this.ctx.getWebSockets(SOCKET_TAG);
    closeDeadSockets(sockets);
    const liveCount = sockets.filter((socket) => socket.readyState === WebSocket.OPEN).length;
    if (liveCount >= MAX_SOCKETS) return Response.json({ error: "Too many open overlays" }, { status: 429, headers: { "Retry-After": "5" } });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    const channel = request.headers.get("x-overlay-channel");
    this.ctx.acceptWebSocket(server, [SOCKET_TAG]);
    writeAttachment(server, emptyAttachment(isValidChannel(channel) ? channel.toLowerCase().replace(/^#/u, "") : null));
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { "Sec-WebSocket-Protocol": "chatwerk-live" },
    });
  }

  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    this.ensureStorage();
    if (this.isDeleted()) {
      try { socket.close(4001, "overlay_deleted"); } catch { /* Socket is already closed. */ }
      return;
    }
    const attachment = readAttachment(socket);
    const now = Date.now();
    if (now - attachment.windowStartedAt >= MESSAGE_WINDOW_MS) {
      attachment.windowStartedAt = now;
      attachment.noRevisionFrameCount = 0;
      attachment.messageByteCount = 0;
    }
    const frameBytes = typeof message === "string" ? frameEncoder.encode(message).byteLength : message.byteLength;
    if (frameBytes > MAX_FRAME_BYTES) {
      try { socket.close(1009, "message_too_large"); } catch { /* already closed */ }
      return;
    }
    attachment.messageByteCount += frameBytes;

    let value: unknown;
    if (typeof message === "string" && message !== "ping" && message !== "pong") {
      try { value = JSON.parse(message) as unknown; } catch { /* malformed frames count as junk */ }
    }
    const isNewAcknowledgement = isRecord(value) && this.isNewAcknowledgement(value, attachment);
    if (!isNewAcknowledgement) attachment.noRevisionFrameCount += 1;
    writeAttachment(socket, attachment);
    if (attachment.messageByteCount > MESSAGE_BYTE_LIMIT || attachment.noRevisionFrameCount > NO_REVISION_FRAME_LIMIT) {
      try { socket.close(4408, "rate_limited"); } catch { /* already closed */ }
      return;
    }
    if (typeof message !== "string" || message === "ping" || message === "pong") return;
    if (!isRecord(value) || typeof value.type !== "string") return;

    if (value.type === "hello") {
      if (!isClientType(value.client)) return;
      attachment.client = value.client;
      writeAttachment(socket, attachment);
      if (value.client === "studio") this.sendCountsTo(socket);
      else send(socket, this.configMessage(attachment.channel));
      return;
    }
    if (value.type === "ack") {
      if (!isValidAck(value, attachment)) return;
      const revision = value.revision as number;
      attachment.acknowledgedRevision = Math.max(attachment.acknowledgedRevision ?? -1, revision);
      attachment.chatStatus = value.chatStatus as ChatStatus;
      attachment.buildId = isBuildId(value.buildId) ? value.buildId : null;
      writeAttachment(socket, attachment);
      if (typeof value.testId === "string" && value.testId.length <= 64) this.acknowledgeTest(value.testId, socket);
      this.broadcastClientStatus();
    }
  }

  webSocketClose(socket: WebSocket): void {
    if (socket.readyState !== WebSocket.OPEN) this.broadcastClientStatus();
  }

  webSocketError(socket: WebSocket): void {
    try { socket.close(4004, "stale_socket"); } catch { /* socket is already dead */ }
    this.broadcastClientStatus();
  }

  private ensureStorage(): void {
    if (this.storageReady) return;
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS overlay_config (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        config_json TEXT NOT NULL,
        revision INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS overlay_link_state (
        singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
        generation INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS overlay_test_lines (
        id TEXT PRIMARY KEY,
        total INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS overlay_test_line_targets (
        test_id TEXT NOT NULL,
        socket_id TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (test_id, socket_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS overlay_undo_snapshots (
        snapshot_id TEXT PRIMARY KEY,
        config_json TEXT NOT NULL,
        theme_from TEXT,
        created_at INTEGER NOT NULL,
        applied_revision INTEGER,
        idempotency_key TEXT,
        result_json TEXT
      )
    `);
    const snapshotColumns = new Set(this.ctx.storage.sql.exec<{ name: string }>("PRAGMA table_info(overlay_undo_snapshots)")
      .toArray().map((column) => column.name));
    for (const [name, type] of [["applied_revision", "INTEGER"], ["idempotency_key", "TEXT"], ["result_json", "TEXT"]] as const) {
      if (!snapshotColumns.has(name)) this.ctx.storage.sql.exec(`ALTER TABLE overlay_undo_snapshots ADD COLUMN ${name} ${type}`);
    }
    this.ctx.storage.sql.exec("CREATE UNIQUE INDEX IF NOT EXISTS overlay_undo_idempotency ON overlay_undo_snapshots(idempotency_key) WHERE idempotency_key IS NOT NULL");
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS overlay_tombstone (singleton INTEGER PRIMARY KEY CHECK (singleton = 1))");
    this.storageReady = true;
  }

  private prepareGeneration(generation: number): void {
    this.ensureStorage();
    this.assertActive();
    if (!Number.isSafeInteger(generation) || generation < 1) {
      throw new RangeError("Link generation must be a positive safe integer");
    }
    const current = this.readGeneration();
    if (current !== null && generation < current) {
      throw new RangeError("Link generation must not go backwards");
    }
    if (current === generation) {
      this.ensureConfig();
      return;
    }
    this.storeGeneration(generation);
    if (current !== null) this.closeSocketsForRevocation();
    this.ensureConfig();
  }

  private isDeleted(): boolean {
    return this.ctx.storage.sql.exec("SELECT singleton FROM overlay_tombstone WHERE singleton = 1").toArray().length !== 0;
  }

  private assertActive(): void {
    if (this.isDeleted()) throw new Error("Overlay was deleted");
  }

  private ensureConfig(): void {
    this.ctx.storage.sql.exec(
      "INSERT OR IGNORE INTO overlay_config(singleton, config_json, revision) VALUES (1, ?, 0)",
      JSON.stringify(DEFAULTS),
    );
  }

  private closeSocketsForRevocation(): void {
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      try { socket.close(4001, "link_revoked"); } catch { /* A concurrently closed socket is already revoked. */ }
    }
  }

  private readSnapshot(): Snapshot {
    const row = this.ctx.storage.sql.exec<{ config_json: string; revision: number }>(
      "SELECT config_json, revision FROM overlay_config WHERE singleton = 1",
    ).toArray()[0];
    if (!row) throw new Error("Overlay config storage is unavailable");
    const stored = JSON.parse(row.config_json) as unknown;
    const config = validateOverlayConfig(stored);
    const themeFrom = isRecord(stored) && typeof stored.themeFrom === "string" ? stored.themeFrom : null;
    return { revision: row.revision, config, themeFrom };
  }

  private writeSnapshot(revision: number, config: OverlayConfig, themeFrom: string | null): void {
    this.ctx.storage.sql.exec(
      "UPDATE overlay_config SET config_json = ?, revision = ? WHERE singleton = 1",
      JSON.stringify({ ...config, themeFrom }), revision,
    );
  }

  private readGeneration(): number | null {
    return this.ctx.storage.sql.exec<{ generation: number }>(
      "SELECT generation FROM overlay_link_state WHERE singleton = 1",
    ).toArray()[0]?.generation ?? null;
  }

  private storeGeneration(generation: number): void {
    this.ctx.storage.sql.exec(
      "INSERT INTO overlay_link_state(singleton, generation) VALUES (1, ?) ON CONFLICT(singleton) DO UPDATE SET generation = excluded.generation",
      generation,
    );
  }

  private configMessage(channel: string | null): Record<string, unknown> {
    const snapshot = this.readSnapshot();
    return {
      type: "config", schemaVersion: SCHEMA_VERSION, revision: snapshot.revision,
      config: snapshot.config, channel,
    };
  }

  private broadcast(message: unknown): void {
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) send(socket, message);
  }

  private broadcastClientStatus(): void {
    const status = this.clientStatus();
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      if (readAttachment(socket).client === "studio") send(socket, { type: "clients", ...status });
    }
  }

  private sendCountsTo(socket: WebSocket): void {
    send(socket, { type: "clients", ...this.clientStatus() });
  }

  private clientStatus(): { counts: Record<ClientType, number>; clients: Array<{ client: ClientType; revision: number; chatStatus: ChatStatus; buildId: string | null }> } {
    const counts: Record<ClientType, number> = { browser: 0, obs: 0, widget: 0, studio: 0 };
    const clients: Array<{ client: ClientType; revision: number; chatStatus: ChatStatus; buildId: string | null }> = [];
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = readAttachment(socket);
      if (attachment.client === null || attachment.acknowledgedRevision === null) continue;
      counts[attachment.client] += 1;
      clients.push({
        client: attachment.client, revision: attachment.acknowledgedRevision, chatStatus: attachment.chatStatus,
        buildId: attachment.buildId,
      });
    }
    return { counts, clients };
  }

  private isNewAcknowledgement(value: Record<string, unknown>, attachment: SocketAttachment): boolean {
    if (!isValidAck(value, attachment)) return false;
    if ((value.revision as number) > (attachment.acknowledgedRevision ?? -1)) return true;
    if (typeof value.testId !== "string" || value.testId.length > 64) return false;
    return this.isUnacknowledgedTarget(value.testId, attachment.socketId);
  }

  private isUnacknowledgedTarget(id: string, socketId: string): boolean {
    return this.ctx.storage.sql.exec<{ acknowledged: number }>(
      "SELECT acknowledged FROM overlay_test_line_targets WHERE test_id = ? AND socket_id = ?",
      id, socketId,
    ).toArray()[0]?.acknowledged === 0;
  }

  private acknowledgeTest(id: string, socket: WebSocket): void {
    const attachment = readAttachment(socket);
    if (attachment.client === null || attachment.client === "studio") return;
    this.ctx.storage.sql.exec(
      "UPDATE overlay_test_line_targets SET acknowledged = 1 WHERE test_id = ? AND socket_id = ? AND acknowledged = 0",
      id, attachment.socketId,
    );
    const line = this.ctx.storage.sql.exec<{ total: number }>(
      "SELECT total FROM overlay_test_lines WHERE id = ?", id,
    ).toArray()[0];
    if (!line) return;
    const shown = this.ctx.storage.sql.exec<{ shown: number }>(
      "SELECT COUNT(*) AS shown FROM overlay_test_line_targets WHERE test_id = ? AND acknowledged = 1", id,
    ).toArray()[0]?.shown ?? 0;
    this.sendTestProgress(id, shown, line.total);
  }

  private sendTestProgress(id: string, shown: number, total: number): void {
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      if (readAttachment(socket).client === "studio") send(socket, { type: "test-progress", id, shown, total });
    }
  }
}

function emptyAttachment(channel: string | null = null): SocketAttachment {
  return {
    socketId: crypto.randomUUID(),
    channel,
    client: null,
    acknowledgedRevision: null,
    chatStatus: "idle",
    buildId: null,
    windowStartedAt: Date.now(),
    noRevisionFrameCount: 0,
    messageByteCount: 0,
  };
}

function validateOverlayConfig(input: unknown): OverlayConfig {
  if (!isRecord(input)) throw new ThemeValidationError("theme", "expected an object");
  const theme = validateTheme(input);
  const config: OverlayConfig = { ...theme };
  if (input.filters !== undefined) {
    if (!isJsonValue(input.filters)) throw new ThemeValidationError("filters", "must be valid JSON data");
    (config as unknown as Record<string, unknown>).filters = input.filters;
  }
  if (input.customCss !== undefined) {
    if (typeof input.customCss !== "string" || new TextEncoder().encode(input.customCss).byteLength > 10_000) {
      throw new ThemeValidationError("customCss", "must be text no larger than 10 KB");
    }
    config.customCss = input.customCss;
  }
  if (input.customCssEnabled !== undefined) {
    if (typeof input.customCssEnabled !== "boolean") {
      throw new ThemeValidationError("customCssEnabled", "must be boolean");
    }
    config.customCssEnabled = input.customCssEnabled;
  }
  return config;
}

function isJsonValue(value: unknown): boolean {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function readAttachment(socket: WebSocket): SocketAttachment {
  const value = socket.deserializeAttachment() as (Partial<SocketAttachment> & Record<string, unknown>) | null;
  const stored: Record<string, unknown> = value ?? {};
  const defaults = emptyAttachment();
  const attachment: SocketAttachment = {
    socketId: typeof stored.socketId === "string" && stored.socketId.length <= 64 ? stored.socketId : crypto.randomUUID(),
    channel: isValidChannel(stored.channel) ? stored.channel.toLowerCase().replace(/^#/u, "") : null,
    client: isClientType(stored.client) ? stored.client : null,
    acknowledgedRevision: Number.isSafeInteger(stored.acknowledgedRevision) && (stored.acknowledgedRevision as number) >= 0
      ? stored.acknowledgedRevision as number
      : null,
    chatStatus: isChatStatus(stored.chatStatus) ? stored.chatStatus : "idle",
    buildId: isBuildId(stored.buildId) ? stored.buildId : null,
    windowStartedAt: Number.isSafeInteger(stored.windowStartedAt) ? stored.windowStartedAt as number : defaults.windowStartedAt,
    noRevisionFrameCount: safeCount(stored.noRevisionFrameCount, NO_REVISION_FRAME_LIMIT),
    messageByteCount: safeCount(stored.messageByteCount, MESSAGE_BYTE_LIMIT),
  };
  const fields = Object.keys(attachment);
  const needsMigration = !value || fields.some((field) => !Object.hasOwn(stored, field)) ||
    Object.keys(stored).some((field) => !fields.includes(field)) ||
    stored.socketId !== attachment.socketId || stored.channel !== attachment.channel || stored.client !== attachment.client ||
    stored.acknowledgedRevision !== attachment.acknowledgedRevision || stored.chatStatus !== attachment.chatStatus ||
    stored.buildId !== attachment.buildId ||
    stored.windowStartedAt !== attachment.windowStartedAt || stored.noRevisionFrameCount !== attachment.noRevisionFrameCount ||
    stored.messageByteCount !== attachment.messageByteCount;
  if (needsMigration) writeAttachment(socket, attachment);
  return attachment;
}

function writeAttachment(socket: WebSocket, attachment: SocketAttachment): void {
  const size = frameEncoder.encode(JSON.stringify(attachment)).byteLength;
  if (size > MAX_ATTACHMENT_BYTES) throw new RangeError("Overlay socket attachment exceeds 2 KiB");
  socket.serializeAttachment(attachment);
}

function isValidAck(value: Record<string, unknown>, attachment: SocketAttachment): boolean {
  return attachment.client !== null && attachment.client !== "studio" && Number.isSafeInteger(value.revision) &&
    (value.revision as number) >= 0 &&
    (value.chatStatus === "connected" || value.chatStatus === "reconnecting" || value.chatStatus === "idle");
}

function isChatStatus(value: unknown): value is ChatStatus {
  return value === "connected" || value === "reconnecting" || value === "idle";
}

function isBuildId(value: unknown): value is string {
  return typeof value === "string" && BUILD_ID_PATTERN.test(value);
}

function safeCount(value: unknown, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? Math.min(value as number, maximum) : 0;
}

function send(socket: WebSocket, value: unknown): void {
  try { socket.send(JSON.stringify(value)); } catch { /* dead socket is reclaimed on the next connect */ }
}

function isClientType(value: unknown): value is ClientType {
  return value === "browser" || value === "obs" || value === "widget" || value === "studio";
}

function isValidChannel(value: unknown): value is string {
  return typeof value === "string" && /^#?[A-Za-z0-9_]{1,25}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
