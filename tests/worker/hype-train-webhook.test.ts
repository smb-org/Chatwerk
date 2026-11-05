import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { env } from "cloudflare:workers";
import { seedOverlay } from "./worker-test-helpers";
import { handleHypeTrainRequest, type HypeTrainEnvironment } from "../../src/worker/hype-train";

const SESSION_KEY = "hype-train-worker-session-key";

afterEach(() => vi.unstubAllGlobals());

describe("Hype Train EventSub webhook signature", () => {
  it.each([
    ["missing", undefined],
    ["incorrect", "sha256=" + "0".repeat(64)],
  ])("rejects a %s signature before returning a challenge", async (_label, signature) => {
    const body = JSON.stringify({ challenge: "verify-me", subscription: { type: "channel.hype_train.begin" } });
    const headers = webhookHeaders(body);
    if (signature) headers.set("Twitch-Eventsub-Message-Signature", signature);
    const response = await SELF.fetch(new Request("https://chatwerk.test/webhooks/twitch", {
      method: "POST", headers, body,
    }));

    expect(response.status).toBe(403);
  });

  it("returns the raw challenge only when its EventSub signature is valid", async () => {
    const body = JSON.stringify({
      challenge: "verify-me",
      subscription: {
        id: "subscription-1", type: "channel.hype_train.begin", version: "2", status: "webhook_callback_verification_pending",
        cost: 0, condition: { broadcaster_user_id: "broadcaster-1" },
        transport: { method: "webhook", callback: "https://chatwerk.test/webhooks/twitch" }, created_at: "2026-11-05T10:00:00Z",
      },
    });
    const headers = await signedWebhookHeaders(body, "message-challenge-1");
    const response = await SELF.fetch(new Request("https://chatwerk.test/webhooks/twitch", {
      method: "POST", headers, body,
    }));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/plain");
    expect(await response.text()).toBe("verify-me");
  });

  it("rejects a correctly signed event older than ten minutes", async () => {
    const body = JSON.stringify({ challenge: "too-old" });
    const headers = await signedWebhookHeaders(body, "message-old-1", new Date(Date.now() - 601_000).toISOString());
    const response = await SELF.fetch(new Request("https://chatwerk.test/webhooks/twitch", { method: "POST", headers, body }));
    expect(response.status).toBe(403);
  });

  it("rejects webhook bodies larger than 64 KB", async () => {
    const body = `{"padding":"${"x".repeat(65_536)}"}`;
    const headers = webhookHeaders(body);
    const response = await SELF.fetch(new Request("https://chatwerk.test/webhooks/twitch", { method: "POST", headers, body }));
    expect(response.status).toBe(413);
  });

  it("rejects a streamed webhook body larger than 64 KB without Content-Length", async () => {
    let emitted = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (emitted >= 65_537) {
          controller.close();
          return;
        }
        const size = Math.min(4_096, 65_537 - emitted);
        controller.enqueue(new Uint8Array(size));
        emitted += size;
      },
    });
    const headers = webhookHeaders("");
    headers.delete("Content-Length");
    const request = new Request("https://chatwerk.test/webhooks/twitch", {
      method: "POST", headers, body, duplex: "half",
    } as RequestInit & { duplex: "half" });
    expect(request.headers.get("Content-Length")).toBeNull();
    const response = await handleHypeTrainRequest(
      request,
      env as HypeTrainEnvironment,
      { waitUntil: () => undefined },
    );

    expect(response?.status).toBe(413);
  });

  it("does not treat a signed notification replayed with a revocation header as a revocation", async () => {
    const overlay = await seedOverlay(env.DB, { ownerId: "replayed-broadcaster", channel: "replayed_broadcaster" });
    await env.DB.prepare("INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)")
      .bind(overlay.ownerId, "replayed_broadcaster").run();
    const body = eventSubBody("notification", overlay.ownerId, "replayed_broadcaster", "channel.hype_train.begin");
    const headers = await signedWebhookHeaders(body, "message-replayed-notification-1");
    headers.set("Twitch-Eventsub-Message-Type", "revocation");
    const response = await handleHypeTrainRequest(
      new Request("https://chatwerk.test/webhooks/twitch", { method: "POST", headers, body }),
      env as HypeTrainEnvironment,
      { waitUntil: () => undefined },
      vi.fn<typeof fetch>(),
    );

    expect(response?.status).toBe(400);
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
      .bind(overlay.ownerId).first()).not.toBeNull();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["too long", "x".repeat(257)],
  ])("rejects an %s Twitch Hype Train id", async (_label, trainId) => {
    const payload = JSON.parse(eventSubBody("notification", "invalid-train-id", "invalid_train_id", "channel.hype_train.begin")) as {
      event: Record<string, unknown>;
    };
    if (trainId === undefined) delete payload.event.id;
    else payload.event.id = trainId;
    const body = JSON.stringify(payload);
    const headers = await signedWebhookHeaders(body, `message-invalid-train-${_label}`);
    headers.set("Twitch-Eventsub-Message-Type", "notification");
    const response = await handleHypeTrainRequest(
      new Request("https://chatwerk.test/webhooks/twitch", { method: "POST", headers, body }),
      env as HypeTrainEnvironment,
      { waitUntil: () => undefined },
      vi.fn<typeof fetch>(),
    );

    expect(response?.status).toBe(400);
  });

  it("deletes consent for any Hype Train revocation status and best-effort removes the other subscriptions", async () => {
    const overlay = await seedOverlay(env.DB, { ownerId: "revoked-broadcaster", channel: "revoked_broadcaster" });
    await env.DB.prepare("INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)").bind(overlay.ownerId, "revoked_broadcaster").run();
    const deleted: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const target = String(input);
      if (target === "https://id.twitch.tv/oauth2/token") return Response.json({ access_token: "transient-app-token" });
      if (target.includes("eventsub/subscriptions?") && !target.includes("?id=") && !target.includes("&after=")) return Response.json({
        data: [
          { id: "revoked-begin", type: "channel.hype_train.begin", condition: { broadcaster_user_id: overlay.ownerId } },
          { id: "revoked-progress", type: "channel.hype_train.progress", condition: { broadcaster_user_id: overlay.ownerId } },
          { id: "revoked-end", type: "channel.hype_train.end", condition: { broadcaster_user_id: overlay.ownerId } },
          { id: "keep-follow", type: "channel.follow", condition: { broadcaster_user_id: overlay.ownerId } },
        ], pagination: {},
      });
      if (target.includes("eventsub/subscriptions?id=") && init?.method === "DELETE") {
        deleted.push(new URL(target).searchParams.get("id")!);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected mocked Twitch request: ${target}`);
    });
    const body = eventSubBody("revocation", overlay.ownerId, "revoked_broadcaster", "channel.hype_train.begin", {
      status: "future_revocation_status",
    });
    const headers = await signedWebhookHeaders(body, "message-revocation-1");
    headers.set("Twitch-Eventsub-Message-Type", "revocation");
    const pending: Promise<unknown>[] = [];
    const response = await handleHypeTrainRequest(
      new Request("https://chatwerk.test/webhooks/twitch", { method: "POST", headers, body }),
      env as HypeTrainEnvironment,
      { waitUntil: (promise) => pending.push(promise) },
      fetcher,
    );

    expect(response?.status).toBe(204);
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?").bind(overlay.ownerId).first()).toBeNull();
    await Promise.all(pending);
    expect(deleted.sort()).toEqual(["revoked-begin", "revoked-end", "revoked-progress"]);
  });

  it("acknowledges notifications without consent and ignores unknown notification types", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "no_consent_room" });
    await configureChannels(overlay.overlayId, ["no_consent_room"]);
    const socket = await openSocket(overlay.token);
    const body = eventSubBody("notification", overlay.ownerId, "no_consent_room", "channel.hype_train.begin");
    const headers = await signedWebhookHeaders(body, "message-no-consent-1");
    headers.set("Twitch-Eventsub-Message-Type", "notification");
    expect((await SELF.fetch(new Request("https://chatwerk.test/webhooks/twitch", { method: "POST", headers, body }))).status).toBe(204);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(socket.messages.some((message) => message.type === "hype-train")).toBe(false);
    socket.socket.close();

    const unknown = eventSubBody("notification", "unknown-broadcaster", "unknown_room", "channel.follow");
    const unknownHeaders = await signedWebhookHeaders(unknown, "message-unknown-type-1");
    unknownHeaders.set("Twitch-Eventsub-Message-Type", "notification");
    expect((await SELF.fetch(new Request("https://chatwerk.test/webhooks/twitch", { method: "POST", headers: unknownHeaders, body: unknown }))).status).toBe(204);
  });
});

type ClientMessage = Record<string, unknown>;
type TestOverlayStub = DurableObjectStub & {
  get(generation: number): Promise<{ revision: number }>;
  save(patch: Record<string, unknown>, baseRevision: number, generation: number): Promise<unknown>;
};

async function configureChannels(overlayId: string, channels: string[]): Promise<void> {
  const stub = env.OVERLAY.get(env.OVERLAY.idFromName(overlayId)) as TestOverlayStub;
  const current = await stub.get(1);
  await stub.save({ channels }, current.revision, 1);
}

async function openSocket(token: string): Promise<{ socket: WebSocket; messages: ClientMessage[] }> {
  const response = await SELF.fetch(new Request("https://chatwerk.test/api/overlay/live", {
    headers: { Upgrade: "websocket", "Sec-WebSocket-Protocol": `chatwerk-live, ${token}` },
  }));
  const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
  if (!socket) throw new Error(`Socket upgrade failed with ${response.status}`);
  socket.accept();
  const messages: ClientMessage[] = [];
  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try { messages.push(JSON.parse(event.data) as ClientMessage); } catch { /* Ignore non-JSON frames. */ }
  });
  socket.send(JSON.stringify({ type: "hello", schemaVersion: 1, client: "widget" }));
  await vi.waitFor(() => expect(messages.some((message) => message.type === "config")).toBe(true));
  return { socket, messages };
}

function webhookHeaders(body: string): Headers {
  return new Headers({
    "Twitch-Eventsub-Message-Id": "message-challenge-1",
    "Twitch-Eventsub-Message-Timestamp": new Date().toISOString(),
    "Twitch-Eventsub-Message-Type": "webhook_callback_verification",
    "Twitch-Eventsub-Subscription-Type": "channel.hype_train.begin",
    "Twitch-Eventsub-Subscription-Version": "2",
    "Content-Type": "application/json",
    "Content-Length": String(new TextEncoder().encode(body).byteLength),
  });
}

async function signedWebhookHeaders(body: string, id: string, timestamp = new Date().toISOString()): Promise<Headers> {
  const headers = webhookHeaders(body);
  headers.set("Twitch-Eventsub-Message-Id", id);
  headers.set("Twitch-Eventsub-Message-Timestamp", timestamp);
  headers.set("Twitch-Eventsub-Message-Signature", `sha256=${await hmacHex(await hmacHex(SESSION_KEY, "eventsub-webhook-v1"), `${id}${headers.get("Twitch-Eventsub-Message-Timestamp")}${body}`)}`);
  return headers;
}

function eventSubBody(
  messageType: "notification" | "revocation",
  broadcasterUserId: string,
  broadcasterUserLogin: string,
  type: string,
  extra: Record<string, unknown> = {},
): string {
  const subscription = {
    id: `subscription-${type}`,
    status: messageType === "revocation" ? "version_removed" : "enabled",
    type,
    version: "2",
    cost: 0,
    condition: { broadcaster_user_id: broadcasterUserId },
    transport: { method: "webhook", callback: "https://chatwerk.test/webhooks/twitch" },
    created_at: new Date().toISOString(),
    ...extra,
  };
  const payload: Record<string, unknown> = { subscription };
  if (messageType === "notification") payload.event = {
    id: "train-id",
    broadcaster_user_id: broadcasterUserId,
    broadcaster_user_login: broadcasterUserLogin,
    broadcaster_user_name: broadcasterUserLogin,
    level: 1,
    expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  return JSON.stringify(payload);
}

async function hmacHex(keyValue: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyValue), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
