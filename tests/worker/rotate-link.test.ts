import { env } from "cloudflare:workers";
import { SELF, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiEnvironment } from "../../src/worker/api";
import type { OverlayObject } from "../../src/worker/overlay-object";
import { mintSessionCookie, seedOverlay } from "./worker-test-helpers";

const SESSION_KEY = "worker-api-test-session-key";
const apiEnv = (): ApiEnvironment => ({ DB: env.DB, OVERLAY: env.OVERLAY, SESSION_KEY });
const closeCode = (socket: WebSocket): Promise<number> => new Promise((resolve, reject) => {
  const timeout = setTimeout(() => reject(new Error("socket did not close")), 1_000);
  socket.addEventListener("close", (event) => { clearTimeout(timeout); resolve(event.code); }, { once: true });
});
const openSocket = async (token: string): Promise<{ status: number; socket?: WebSocket; response: Response }> => {
  const response = await SELF.fetch(new Request("https://chatwerk.test/api/overlay/live", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `chatwerk-live, ${token}` },
  }));
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  socket?.accept();
  return { status: response.status, ...(socket ? { socket } : {}), response };
};

const rotate = async (ownerId: string, overlayId: string) => handleApiRequest(new Request(
  `https://chatwerk.test/api/overlays/${overlayId}/rotate-link`, {
    method: "POST",
    headers: {
      Cookie: await mintSessionCookie(SESSION_KEY, ownerId),
      Origin: "https://chatwerk.test",
      "Content-Type": "application/json",
    },
    body: "{}",
  }), apiEnv());

describe("overlay link rotation and socket limits", () => {
  it("requires an owner session and same-origin JSON for rotation", async () => {
    const overlay = await seedOverlay(env.DB);
    const anonymous = await handleApiRequest(new Request(
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/rotate-link`, { method: "POST" }), apiEnv());
    const crossOrigin = await handleApiRequest(new Request(
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/rotate-link`, {
        method: "POST", headers: { Cookie: await mintSessionCookie(SESSION_KEY, overlay.ownerId), Origin: "https://evil.test", "Content-Type": "application/json" }, body: "{}",
      }), apiEnv());
    const wrongType = await handleApiRequest(new Request(
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/rotate-link`, {
        method: "POST", headers: { Cookie: await mintSessionCookie(SESSION_KEY, overlay.ownerId), Origin: "https://chatwerk.test", "Content-Type": "text/plain" }, body: "{}",
      }), apiEnv());

    expect(anonymous?.status).toBe(401);
    expect(crossOrigin?.status).toBe(403);
    expect(wrongType?.status).toBe(415);
  });

  it("changes only the link token and increments its generation", async () => {
    const overlay = await seedOverlay(env.DB);
    const response = await rotate(overlay.ownerId, overlay.overlayId);
    const result = await response?.json() as { id: string; linkToken: string; generation: number };
    const row = await env.DB.prepare("SELECT id, link_token, link_generation FROM overlays WHERE id = ?")
      .bind(overlay.overlayId).first<{ id: string; link_token: string; link_generation: number }>();
    const stub = env.OVERLAY.get(env.OVERLAY.idFromName(overlay.overlayId)) as unknown as OverlayObject;

    expect(response?.status).toBe(200);
    expect(result.id).toBe(overlay.overlayId);
    expect(result.linkToken).not.toBe(overlay.token);
    expect(result.linkToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(result.generation).toBe(2);
    expect(row).toEqual({ id: overlay.overlayId, link_token: result.linkToken, link_generation: 2 });
    expect(response?.headers.get("location")).toBeNull();
    await expect(stub.revoke(2)).resolves.toBeUndefined();
  });

  it("invalidates the old bearer link and keeps the new link readable", async () => {
    const overlay = await seedOverlay(env.DB);
    const rotated = await rotate(overlay.ownerId, overlay.overlayId);
    const newToken = (await rotated?.json() as { linkToken: string }).linkToken;
    const oldConfig = await SELF.fetch(new Request("https://chatwerk.test/api/overlay/config", {
      headers: { Authorization: `Bearer ${overlay.token}` },
    }));
    const oldSocket = await SELF.fetch(new Request("https://chatwerk.test/api/overlay/live", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `chatwerk-live, ${overlay.token}` },
    }));
    const newConfig = await SELF.fetch(new Request("https://chatwerk.test/api/overlay/config", {
      headers: { Authorization: `Bearer ${newToken}` },
    }));

    expect(oldConfig.status).toBe(404);
    expect(oldSocket.status).toBe(404);
    expect(newConfig.status).toBe(200);
  });

  it("closes connected sockets with 4001 when the link rotates", async () => {
    const overlay = await seedOverlay(env.DB);
    const opened = await openSocket(overlay.token);
    if (!opened.socket) throw new Error(`WebSocket upgrade failed: ${opened.status}`);
    const closed = closeCode(opened.socket);
    const response = await rotate(overlay.ownerId, overlay.overlayId);

    expect(response?.status).toBe(200);
    expect(await closed).toBe(4001);
  });

  it("rejects an upgrade that arrives with the old generation after rotation", async () => {
    const overlay = await seedOverlay(env.DB);
    await rotate(overlay.ownerId, overlay.overlayId);
    const stub = env.OVERLAY.get(env.OVERLAY.idFromName(overlay.overlayId)) as unknown as OverlayObject;
    const response = await stub.fetch(new Request("https://overlay.internal/live", {
      headers: { Upgrade: "websocket", "X-Link-Generation": "1" },
    }));

    expect(response.status).toBe(409);
  });

  it("advances a Durable Object that is behind D1 and closes its existing sockets", async () => {
    const overlay = await seedOverlay(env.DB);
    const old = await openSocket(overlay.token);
    if (!old.socket) throw new Error(`WebSocket upgrade failed: ${old.status}`);
    const oldClosed = closeCode(old.socket);
    const nextToken = "B".repeat(43);
    await env.DB.prepare("UPDATE overlays SET link_token = ?, link_generation = 2 WHERE id = ?")
      .bind(nextToken, overlay.overlayId).run();
    const response = await SELF.fetch(new Request("https://chatwerk.test/api/overlay/live", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `chatwerk-live, ${nextToken}` },
    }));
    const nextSocket = (response as Response & { webSocket?: WebSocket }).webSocket;
    nextSocket?.accept();

    expect(response.status).toBe(101);
    expect(await oldClosed).toBe(4001);
    nextSocket?.close();
  });

  it.each(["config read", "test-line request"] as const)("heals a missed revoke on a later %s", async (action) => {
    const overlay = await seedOverlay(env.DB);
    const old = await openSocket(overlay.token);
    if (!old.socket) throw new Error(`WebSocket upgrade failed: ${old.status}`);
    const closed = closeCode(old.socket);
    const nextToken = `C${"C".repeat(41)}${action === "config read" ? "1" : "2"}`;
    await env.DB.prepare("UPDATE overlays SET link_token = ?, link_generation = 2 WHERE id = ?")
      .bind(nextToken, overlay.overlayId).run();

    let response: Response | null;
    if (action === "config read") {
      response = await SELF.fetch(new Request("https://chatwerk.test/api/overlay/config", {
        headers: { Authorization: `Bearer ${nextToken}` },
      }));
    } else {
      response = await handleApiRequest(new Request(
        `https://chatwerk.test/api/overlays/${overlay.overlayId}/test-line`, {
          method: "POST",
          headers: {
            Cookie: await mintSessionCookie(SESSION_KEY, overlay.ownerId),
            Origin: "https://chatwerk.test",
            "Content-Type": "application/json",
          },
          body: "{}",
        }), apiEnv());
    }

    if (!response) throw new Error("generation recovery route did not match");
    expect(response.status).toBe(200);
    expect(await closed).toBe(4001);
  });

  it("returns the rotated token when Durable Object revocation fails", async () => {
    const overlay = await seedOverlay(env.DB);
    const revoke = vi.fn(async () => { throw new Error("DO unavailable"); });
    const namespace = {
      idFromName: vi.fn(() => "overlay-id"),
      get: vi.fn(() => ({ revoke })),
    } as unknown as DurableObjectNamespace;
    const response = await handleApiRequest(new Request(
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/rotate-link`, {
        method: "POST",
        headers: {
          Cookie: await mintSessionCookie(SESSION_KEY, overlay.ownerId),
          Origin: "https://chatwerk.test",
          "Content-Type": "application/json",
        },
        body: "{}",
      }), { DB: env.DB, OVERLAY: namespace, SESSION_KEY });
    const body = await response?.json() as { linkToken: string; generation: number };

    expect(response?.status).toBe(200);
    expect(body.linkToken).not.toBe(overlay.token);
    expect(body.generation).toBe(2);
    expect(revoke).toHaveBeenCalledWith(2);
  });

  it("heals a failed revoke before a later save and closes the old socket first", async () => {
    const overlay = await seedOverlay(env.DB);
    const opened = await openSocket(overlay.token);
    if (!opened.socket) throw new Error(`WebSocket upgrade failed: ${opened.status}`);
    const messages: Array<{ type?: string; revision?: number }> = [];
    opened.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") messages.push(JSON.parse(event.data) as { type?: string; revision?: number });
    });
    opened.socket.send(JSON.stringify({ type: "hello", schemaVersion: 1, client: "widget" }));
    await vi.waitFor(() => expect(messages.some((message) => message.type === "config" && message.revision === 0)).toBe(true));
    const closed = closeCode(opened.socket);
    const realStub = env.OVERLAY.get(env.OVERLAY.idFromName(overlay.overlayId));
    const failingNamespace = {
      idFromName: (name: string) => env.OVERLAY.idFromName(name),
      get: () => new Proxy(realStub, {
        get(target, property, receiver) {
          if (property === "revoke") return async () => { throw new Error("DO unavailable"); };
          const value: unknown = Reflect.get(target, property, receiver) as unknown;
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
    } as unknown as DurableObjectNamespace;
    const cookie = await mintSessionCookie(SESSION_KEY, overlay.ownerId);
    const rotation = await handleApiRequest(new Request(
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/rotate-link`, {
        method: "POST",
        headers: { Cookie: cookie, Origin: "https://chatwerk.test", "Content-Type": "application/json" },
        body: "{}",
      }), { DB: env.DB, OVERLAY: failingNamespace, SESSION_KEY });
    expect(rotation?.status).toBe(200);

    const save = await handleApiRequest(new Request(
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/config`, {
        method: "PUT",
        headers: { Cookie: cookie, Origin: "https://chatwerk.test", "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, patch: { fontSize: 24 } }),
      }), apiEnv());

    expect(save?.status).toBe(200);
    expect(await closed).toBe(4001);
    expect(messages.filter((message) => message.type === "config").map((message) => message.revision)).toEqual([0]);
  });

  it("rejects query-string tokens and malformed protocol entries", async () => {
    const overlay = await seedOverlay(env.DB);
    const query = await SELF.fetch(new Request(`https://chatwerk.test/api/overlay/live?token=${overlay.token}`, {
      headers: { Upgrade: "websocket" },
    }));
    const malformed = await SELF.fetch(new Request("https://chatwerk.test/api/overlay/live", {
      headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `chatwerk-live, bad, ${overlay.token}` },
    }));

    expect(query.status).toBe(400);
    expect(malformed.status).toBe(400);
  });

  it("accepts a full 16-slot table without evicting a live socket and returns 429 above it", async () => {
    const overlay = await seedOverlay(env.DB);
    const sockets: WebSocket[] = [];
    const closes: number[] = [];
    try {
      for (let index = 0; index < 16; index += 1) {
        const opened = await openSocket(overlay.token);
        expect(opened.status).toBe(101);
        if (!opened.socket) throw new Error("socket is missing");
        opened.socket.addEventListener("close", (event) => closes.push(event.code));
        sockets.push(opened.socket);
      }
      const overflow = await openSocket(overlay.token);
      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(overflow.status).toBe(429);
      expect(closes).toEqual([]);
    } finally {
      for (const socket of sockets) socket.close();
    }
  });

  it("closes dead sockets with code 4004 during slot cleanup", async () => {
    const closed: Array<[number, string]> = [];
    const dead = { readyState: WebSocket.CLOSED, close: (code: number, reason: string) => closed.push([code, reason]) } as unknown as WebSocket;
    const live = { readyState: WebSocket.OPEN, close: () => { throw new Error("live socket evicted"); } } as unknown as WebSocket;

    (await import("../../src/worker/overlay-object")).closeDeadSockets([dead, live]);
    expect(closed).toEqual([[4004, "stale_socket"]]);
  });

  it("stores config and revision in the Durable Object rather than D1", async () => {
    const overlay = await seedOverlay(env.DB);
    const stub = env.OVERLAY.get(env.OVERLAY.idFromName(overlay.overlayId)) as unknown as OverlayObject;
    const initial = await stub.get(1);
    await stub.save({ fontSize: 24 }, 0, 1);
    const after = await stub.get(1);
    const columns = await runInDurableObject(stub as never, (_instance, state) =>
      state.storage.sql.exec("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'overlay_config'").toArray());

    expect(initial.revision).toBe(0);
    expect(after).toMatchObject({ revision: 1, config: { fontSize: 24 } });
    expect(columns).toHaveLength(1);
    expect(await env.DB.prepare("PRAGMA table_info(overlays)").all()).toMatchObject({ results: expect.arrayContaining([
      expect.objectContaining({ name: "link_generation" }),
    ]) });
  });

  it("keeps all socket attachments below two KiB through one thousand test lines", async () => {
    const overlay = await seedOverlay(env.DB);
    const studio = await openSocket(overlay.token);
    if (!studio.socket) throw new Error(`WebSocket upgrade failed: ${studio.status}`);
    const studioMessages: Array<{ type?: string; clients?: unknown[] }> = [];
    studio.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") studioMessages.push(JSON.parse(event.data) as { type?: string; clients?: unknown[] });
    });
    studio.socket.send(JSON.stringify({ type: "hello", schemaVersion: 1, client: "studio" }));

    const outputs: WebSocket[] = [];
    for (let index = 0; index < 15; index += 1) {
      const opened = await openSocket(overlay.token);
      if (!opened.socket) throw new Error(`WebSocket upgrade failed: ${opened.status}`);
      outputs.push(opened.socket);
      opened.socket.send(JSON.stringify({ type: "hello", schemaVersion: 1, client: index % 2 === 0 ? "widget" : "browser" }));
      opened.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle" }));
    }
    await vi.waitFor(() => expect(studioMessages.some((message) => message.type === "clients" && message.clients?.length === 15)).toBe(true));

    const object = env.OVERLAY.get(env.OVERLAY.idFromName(overlay.overlayId)) as unknown as { testLine(generation?: number): Promise<string> };
    for (let index = 0; index < 1_000; index += 1) await object.testLine(1);
    const stub = env.OVERLAY.get(env.OVERLAY.idFromName(overlay.overlayId));
    const sizes = await runInDurableObject(stub as never, (_instance, state) =>
      state.getWebSockets("overlay").map((socket) => new TextEncoder().encode(JSON.stringify(socket.deserializeAttachment())).byteLength));

    expect(sizes).toHaveLength(16);
    expect(Math.max(...sizes)).toBeLessThan(2_048);
    for (const socket of outputs) socket.close();
    studio.socket.close();
  });

  it("drops legacy test-id arrays when a hibernated socket attachment is read", async () => {
    const overlay = await seedOverlay(env.DB);
    const opened = await openSocket(overlay.token);
    if (!opened.socket) throw new Error(`WebSocket upgrade failed: ${opened.status}`);
    const messages: Array<{ type?: string }> = [];
    opened.socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") messages.push(JSON.parse(event.data) as { type?: string });
    });
    const stub = env.OVERLAY.get(env.OVERLAY.idFromName(overlay.overlayId));
    await runInDurableObject(stub as never, (_instance, state) => {
      const socket = state.getWebSockets("overlay")[0]!;
      const attachment = socket.deserializeAttachment() as Record<string, unknown>;
      const legacyIds = Array.from({ length: 24 }, (_, index) => `test-${index.toString().padStart(3, "0")}-${"x".repeat(24)}`);
      socket.serializeAttachment({ ...attachment, targetedTests: legacyIds, acknowledgedTests: legacyIds });
    });

    opened.socket.send(JSON.stringify({ type: "hello", schemaVersion: 1, client: "widget" }));
    await vi.waitFor(() => expect(messages.some((message) => message.type === "config")).toBe(true));
    const attachment = await runInDurableObject(stub as never, (_instance, state) =>
      state.getWebSockets("overlay")[0]!.deserializeAttachment() as Record<string, unknown>);

    expect(attachment).not.toHaveProperty("targetedTests");
    expect(attachment).not.toHaveProperty("acknowledgedTests");
    expect(new TextEncoder().encode(JSON.stringify(attachment)).byteLength).toBeLessThan(2_048);
    opened.socket.close();
  });

  it("uses automatic ping/pong and closes only sockets on the rotated overlay", async () => {
    const first = await seedOverlay(env.DB);
    const second = await seedOverlay(env.DB);
    const socketA = await openSocket(first.token);
    const socketB = await openSocket(second.token);
    if (!socketA.socket || !socketB.socket) throw new Error("socket upgrade failed");
    const closeA = closeCode(socketA.socket);
    const pair = await runInDurableObject(
      env.OVERLAY.get(env.OVERLAY.idFromName(first.overlayId)) as never,
      (_instance, state) => state.getWebSocketAutoResponse(),
    );
    await rotate(first.ownerId, first.overlayId);

    expect(pair?.request).toBe("ping");
    expect(pair?.response).toBe("pong");
    expect(await closeA).toBe(4001);
    expect(socketB.socket.readyState).toBe(WebSocket.OPEN);
    socketB.socket.close();
  });
});
