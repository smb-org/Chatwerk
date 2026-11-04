import { DurableObject } from "cloudflare:workers";
import { DEFAULTS, SCHEMA_VERSION, ThemeValidationError, validateTheme, type ThemeConfig } from "../shared/theme";

const SOCKET_TAG = "overlay";
const MAX_SOCKETS = 16;
const MAX_FRAME_BYTES = 4 * 1024;
const MAX_ATTACHMENT_BYTES = 2 * 1024;
const NO_REVISION_FRAME_LIMIT = 60;
const MESSAGE_BYTE_LIMIT = 1024 * 1024;
const MESSAGE_WINDOW_MS = 60_000;
const frameEncoder = new TextEncoder();
type ClientType = "browser" | "obs" | "widget" | "studio";
type ChatStatus = "connected" | "reconnecting" | "idle";

interface SocketAttachment {
  socketId: string;
  channel: string | null;
  client: ClientType | null;
  acknowledgedRevision: number | null;
  chatStatus: ChatStatus;
  windowStartedAt: number;
  noRevisionFrameCount: number;
  messageByteCount: number;
}

interface Snapshot {
  revision: number;
  config: ThemeConfig;
}

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
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  async get(generation: number): Promise<Snapshot> {
    this.prepareGeneration(generation);
    return this.readSnapshot();
  }

  async save(
    patch: Record<string, unknown>,
    baseRevision: number,
    generation: number,
  ): Promise<Snapshot | { conflict: true; revision: number; config: ThemeConfig } | { invalid: true; field: string }> {
    this.prepareGeneration(generation);
    const current = this.readSnapshot();
    if (baseRevision !== current.revision) return { conflict: true, revision: current.revision, config: current.config };
    if (!isRecord(patch)) return { invalid: true, field: "theme" };
    let config: ThemeConfig;
    try {
      config = validateTheme({ ...current.config, ...patch, schemaVersion: SCHEMA_VERSION });
    } catch (error) {
      if (error instanceof ThemeValidationError) return { invalid: true, field: error.fieldName };
      throw error;
    }
    const revision = current.revision + 1;
    this.ctx.storage.sql.exec(
      "UPDATE overlay_config SET config_json = ?, revision = ? WHERE singleton = 1",
      JSON.stringify(config), revision,
    );
    this.broadcast({ type: "config", schemaVersion: SCHEMA_VERSION, revision, config });
    return { revision, config };
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

  async revoke(nextGeneration?: number): Promise<void> {
    this.ensureStorage();
    const current = this.readGeneration() ?? 0;
    const generation = nextGeneration ?? current + 1;
    this.prepareGeneration(generation);
  }

  async fetch(request: Request): Promise<Response> {
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
  }

  private prepareGeneration(generation: number): void {
    this.ensureStorage();
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
    const config = validateTheme(JSON.parse(row.config_json) as unknown);
    return { revision: row.revision, config };
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

  private clientStatus(): { counts: Record<ClientType, number>; clients: Array<{ client: ClientType; revision: number; chatStatus: ChatStatus }> } {
    const counts: Record<ClientType, number> = { browser: 0, obs: 0, widget: 0, studio: 0 };
    const clients: Array<{ client: ClientType; revision: number; chatStatus: ChatStatus }> = [];
    for (const socket of this.ctx.getWebSockets(SOCKET_TAG)) {
      if (socket.readyState !== WebSocket.OPEN) continue;
      const attachment = readAttachment(socket);
      if (attachment.client === null || attachment.acknowledgedRevision === null) continue;
      counts[attachment.client] += 1;
      clients.push({ client: attachment.client, revision: attachment.acknowledgedRevision, chatStatus: attachment.chatStatus });
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
    windowStartedAt: Date.now(),
    noRevisionFrameCount: 0,
    messageByteCount: 0,
  };
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
    windowStartedAt: Number.isSafeInteger(stored.windowStartedAt) ? stored.windowStartedAt as number : defaults.windowStartedAt,
    noRevisionFrameCount: safeCount(stored.noRevisionFrameCount, NO_REVISION_FRAME_LIMIT),
    messageByteCount: safeCount(stored.messageByteCount, MESSAGE_BYTE_LIMIT),
  };
  const fields = Object.keys(attachment);
  const needsMigration = !value || fields.some((field) => !Object.hasOwn(stored, field)) ||
    Object.keys(stored).some((field) => !fields.includes(field)) ||
    stored.socketId !== attachment.socketId || stored.channel !== attachment.channel || stored.client !== attachment.client ||
    stored.acknowledgedRevision !== attachment.acknowledgedRevision || stored.chatStatus !== attachment.chatStatus ||
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
