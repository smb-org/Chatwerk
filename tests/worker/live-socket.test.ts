import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiEnvironment } from "../../src/worker/api";
import { mintSessionCookie, seedOverlay } from "./worker-test-helpers";

const SESSION_KEY = "worker-api-test-session-key";
type Message = Record<string, unknown>;

async function openSocket(token: string, client: "browser" | "obs" | "widget" | "studio") {
  const response = await SELF.fetch(new Request("https://chatwerk.test/api/overlay/live", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `chatwerk-live, ${token}` },
  }));
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  if (!socket) throw new Error(`Socket upgrade failed with ${response.status}`);
  socket.accept();
  const messages: Message[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try { messages.push(JSON.parse(event.data) as Message); } catch { /* ignore malformed test data */ }
  });
  socket.send(JSON.stringify({ type: "hello", schemaVersion: 1, client }));
  return { response, socket, messages };
}

const waitFor = (condition: () => boolean, timeout = 5_000) =>
  vi.waitFor(() => expect(condition()).toBe(true), { timeout });

describe("live socket acknowledgements", () => {
  it("sends config revision and channel in the first frame after hello", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "socket_room" });
    const browser = await openSocket(overlay.token, "widget");
    await waitFor(() => browser.messages.some((message) => message.type === "config"));

    expect(browser.messages[0]).toMatchObject({
      type: "config", schemaVersion: 1, revision: 0, channel: "socket_room", config: expect.any(Object),
    });
    browser.socket.close();
  });

  it("counts a browser only after it acknowledges a revision and sends type counts to studio", async () => {
    const overlay = await seedOverlay(env.DB);
    const studio = await openSocket(overlay.token, "studio");
    const browser = await openSocket(overlay.token, "browser");
    await waitFor(() => browser.messages.some((message) => message.type === "config"));

    expect(studio.messages.some((message) => message.type === "clients" &&
      (message.counts as Record<string, number>).browser === 0)).toBe(true);
    browser.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "connected" }));
    await waitFor(() => studio.messages.some((message) => message.type === "clients" &&
      (message.counts as Record<string, number>).browser === 1));
    expect(studio.messages.at(-1)).toMatchObject({
      type: "clients",
      counts: { browser: 1 },
      clients: [expect.objectContaining({ client: "browser", revision: 0, chatStatus: "connected" })],
    });
    browser.socket.close();
    studio.socket.close();
  });

  it("returns configured channels and acknowledged output counts without counting the Studio socket", async () => {
    const overlay = await seedOverlay(env.DB);
    const object = env.OVERLAY.get(env.OVERLAY.idFromName(overlay.overlayId)) as unknown as {
      get(generation: number): Promise<{ revision: number }>;
      save(patch: Record<string, unknown>, baseRevision: number, generation: number): Promise<unknown>;
      getAdminStats(): Promise<{ channels: string[] | null; connectedOutputs: number }>;
    };
    const snapshot = await object.get(1);
    await object.save({ channels: ["first_room", "second_room"] }, snapshot.revision, 1);
    const studio = await openSocket(overlay.token, "studio");
    const output = await openSocket(overlay.token, "widget");
    await waitFor(() => output.messages.some((message) => message.type === "config"));
    output.socket.send(JSON.stringify({ type: "ack", revision: 1, chatStatus: "connected" }));
    await waitFor(() => studio.messages.some((message) => message.type === "clients" &&
      ((message.counts as Record<string, number>).widget ?? 0) === 1));

    expect(await object.getAdminStats()).toEqual({
      channels: ["first_room", "second_room"], connectedOutputs: 1,
    });
    output.socket.close();
    studio.socket.close();
  });

  it("reports valid build ids and treats missing or malformed ids as unknown", async () => {
    const overlay = await seedOverlay(env.DB);
    const studio = await openSocket(overlay.token, "studio");
    const browser = await openSocket(overlay.token, "widget");
    await waitFor(() => browser.messages.some((message) => message.type === "config"));

    browser.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "connected" }));
    await waitFor(() => studio.messages.some((message) => message.type === "clients" &&
      (message.counts as Record<string, number>).widget === 1));
    expect(studio.messages.at(-1)).toMatchObject({
      clients: [expect.objectContaining({ client: "widget", revision: 0, chatStatus: "connected", buildId: null })],
    });

    browser.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle", buildId: "../invalid" }));
    await waitFor(() => studio.messages.at(-1)?.type === "clients" &&
      (studio.messages.at(-1)?.clients as Array<{ buildId?: unknown; chatStatus?: unknown }> | undefined)?.[0]?.buildId === null &&
      (studio.messages.at(-1)?.clients as Array<{ buildId?: unknown; chatStatus?: unknown }> | undefined)?.[0]?.chatStatus === "idle");
    expect(studio.messages.at(-1)).toMatchObject({
      clients: [expect.objectContaining({ client: "widget", chatStatus: "idle", buildId: null })],
    });

    browser.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "connected", buildId: "0123456789abcdef" }));
    await waitFor(() => (studio.messages.at(-1)?.clients as Array<{ buildId?: unknown }> | undefined)?.[0]?.buildId === "0123456789abcdef");
    expect(studio.messages.at(-1)).toMatchObject({
      clients: [expect.objectContaining({ client: "widget", chatStatus: "connected", buildId: "0123456789abcdef" })],
    });
    browser.socket.close();
    studio.socket.close();
  });

  it("broadcasts one local test event and reports shown of total after acknowledgement", async () => {
    const overlay = await seedOverlay(env.DB);
    const studio = await openSocket(overlay.token, "studio");
    const browser = await openSocket(overlay.token, "widget");
    await waitFor(() => browser.messages.some((message) => message.type === "config"));
    browser.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle" }));
    await waitFor(() => studio.messages.some((message) => message.type === "clients"));

    const cookie = await mintSessionCookie(SESSION_KEY, overlay.ownerId);
    const response = await handleApiRequest(new Request(`https://chatwerk.test/api/overlays/${overlay.overlayId}/test-line`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://chatwerk.test", "Content-Type": "application/json" },
      body: "{}",
    }), { DB: env.DB, OVERLAY: env.OVERLAY, SESSION_KEY } satisfies ApiEnvironment);
    if (!response) throw new Error("test line route did not match");
    const { id } = await response.json() as { id: string };
    await waitFor(() => browser.messages.some((message) => message.type === "test-line" && message.id === id));
    studio.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle", testId: id }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(studio.messages.some((message) => message.type === "test-progress" && message.id === id && message.shown === 1)).toBe(false);
    browser.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle", testId: id }));
    await waitFor(() => studio.messages.some((message) => message.type === "test-progress" && message.id === id && message.shown === 1));

    expect(response.status).toBe(200);
    expect(studio.messages.find((message) => message.type === "test-progress" && message.id === id && message.shown === 1))
      .toMatchObject({ type: "test-progress", id, shown: 1, total: 1 });
    browser.socket.close();
    studio.socket.close();
  });

  it("keeps acknowledged outputs counted when one disconnects before the next ack", async () => {
    const overlay = await seedOverlay(env.DB);
    const studio = await openSocket(overlay.token, "studio");
    const first = await openSocket(overlay.token, "widget");
    const second = await openSocket(overlay.token, "browser");
    await waitFor(() => first.messages.some((message) => message.type === "config"));
    await waitFor(() => second.messages.some((message) => message.type === "config"));
    first.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle" }));
    second.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle" }));
    await waitFor(() => studio.messages.some((message) => message.type === "clients" &&
      (message.counts as Record<string, number>).browser === 1 &&
      (message.counts as Record<string, number>).widget === 1));

    const cookie = await mintSessionCookie(SESSION_KEY, overlay.ownerId);
    const response = await handleApiRequest(new Request(`https://chatwerk.test/api/overlays/${overlay.overlayId}/test-line`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://chatwerk.test", "Content-Type": "application/json" },
      body: "{}",
    }), { DB: env.DB, OVERLAY: env.OVERLAY, SESSION_KEY } satisfies ApiEnvironment);
    if (!response) throw new Error("test line route did not match");
    const { id } = await response.json() as { id: string };
    await waitFor(() => first.messages.some((message) => message.type === "test-line" && message.id === id));
    await waitFor(() => second.messages.some((message) => message.type === "test-line" && message.id === id));

    first.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle", testId: id }));
    await waitFor(() => studio.messages.some((message) => message.type === "test-progress" && message.id === id && message.shown === 1));
    const firstClosed = new Promise<void>((resolve) => first.socket.addEventListener("close", () => resolve(), { once: true }));
    first.socket.close();
    await firstClosed;
    second.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle", testId: id }));
    await waitFor(() => studio.messages.some((message) => message.type === "test-progress" && message.id === id && message.shown === 2), 1_000);

    const late = await openSocket(overlay.token, "obs");
    await waitFor(() => late.messages.some((message) => message.type === "config"));
    late.socket.send(JSON.stringify({ type: "ack", revision: 0, chatStatus: "idle", testId: id }));
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(studio.messages.filter((message) => message.type === "test-progress" && message.id === id).at(-1))
      .toMatchObject({ shown: 2, total: 2 });
    late.socket.close();
    second.socket.close();
    studio.socket.close();
  }, 15_000);

  it("persists rate limits across malformed frames and closes junk senders", async () => {
    const overlay = await seedOverlay(env.DB);
    const { socket } = await openSocket(overlay.token, "widget");
    const closed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("junk socket did not close")), 1_000);
      socket.addEventListener("close", (event) => { clearTimeout(timeout); resolve(event.code); }, { once: true });
    });

    for (let attempt = 0; attempt < 60; attempt += 1) socket.send("{");

    expect(await closed).toBe(4408);
  });

  it("allows one acknowledgement per revision across one thousand quick saves", async () => {
    const overlay = await seedOverlay(env.DB);
    const studio = await openSocket(overlay.token, "studio");
    const browser = await openSocket(overlay.token, "widget");
    const object = env.OVERLAY.get(env.OVERLAY.idFromName(overlay.overlayId)) as unknown as {
      save(patch: Record<string, unknown>, baseRevision: number, generation?: number): Promise<
        { revision: number; config: unknown } | { conflict: true } | { invalid: true }
      >;
    };
    await waitFor(() => browser.messages.some((message) => message.type === "config" && message.revision === 0));
    const acknowledged = new Set<number>();
    browser.socket.addEventListener("message", (event) => {
      if (typeof event.data !== "string") return;
      const message = JSON.parse(event.data) as { type?: string; revision?: number };
      if (message.type !== "config" || !Number.isSafeInteger(message.revision)) return;
      acknowledged.add(message.revision!);
      try {
        browser.socket.send(JSON.stringify({ type: "ack", revision: message.revision, chatStatus: "connected" }));
      } catch {
        // The final acknowledgement assertion detects an unexpected disconnect.
      }
    });

    for (let revision = 1; revision <= 1_000; revision += 1) {
      const result = await object.save({ fontSize: revision % 2 === 0 ? 24 : 25 }, revision - 1, 1);
      if (!("revision" in result)) throw new Error(`Save ${revision} did not advance the revision`);
    }

    await waitFor(() => studio.messages.some((message) => message.type === "clients" &&
      (message.clients as Array<{ revision: number }> | undefined)?.some((client) => client.revision === 1_000)), 10_000);
    expect(acknowledged.size).toBe(1_000);
    expect(browser.socket.readyState).toBe(WebSocket.OPEN);
    browser.socket.close();
    studio.socket.close();
  }, 15_000);

  it("limits byte volume even when each ack introduces a new revision", async () => {
    const overlay = await seedOverlay(env.DB);
    const studio = await openSocket(overlay.token, "studio");
    const browser = await openSocket(overlay.token, "widget");
    await waitFor(() => browser.messages.some((message) => message.type === "config" && message.revision === 0));
    let closeCode: number | undefined;
    browser.socket.addEventListener("close", (event) => { closeCode = event.code; }, { once: true });
    const padding = "x".repeat(3_800);
    let acknowledgedRevision = 0;

    for (let revision = 1; revision <= 300; revision += 1) {
      try {
        browser.socket.send(JSON.stringify({ type: "ack", revision, chatStatus: "connected", padding }));
      } catch {
        break;
      }
      try {
        await waitFor(() => studio.messages.some((message) => message.type === "clients" &&
          (message.clients as Array<{ revision: number }> | undefined)?.some((client) => client.revision === revision)), 1_000);
        acknowledgedRevision = revision;
      } catch {
        break;
      }
    }

    expect(closeCode).toBe(4408);
    expect(acknowledgedRevision).toBeGreaterThan(200);
    browser.socket.close();
    studio.socket.close();
  }, 25_000);

  it("rejects frames larger than four KiB", async () => {
    const overlay = await seedOverlay(env.DB);
    const { socket } = await openSocket(overlay.token, "widget");
    const closed = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("oversized frame socket did not close")), 1_000);
      socket.addEventListener("close", (event) => { clearTimeout(timeout); resolve(event.code); }, { once: true });
    });

    socket.send("x".repeat(4_097));

    expect(await closed).toBe(1009);
  });
});
