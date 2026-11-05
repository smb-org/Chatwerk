import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { seedOverlay } from "./worker-test-helpers";
import { deriveEventSubSecret } from "../../src/worker/twitch-eventsub";

type ClientMessage = Record<string, unknown>;
type TestOverlayStub = DurableObjectStub & {
  get(generation: number): Promise<{ revision: number }>;
  save(patch: Record<string, unknown>, baseRevision: number, generation: number): Promise<unknown>;
};

describe("Hype Train Durable Object fan-out", () => {
  it("forwards a valid event only to owner overlays configured for the broadcaster channel", async () => {
    const broadcasterUserId = `broadcaster-${crypto.randomUUID()}`;
    const matching = await seedOverlay(env.DB, { ownerId: broadcasterUserId, channel: "alice" });
    const otherChannel = await seedOverlay(env.DB, { ownerId: broadcasterUserId, channel: "alice", name: "Secondary" });
    await configureChannels(matching.overlayId, ["alice"]);
    await configureChannels(otherChannel.overlayId, ["elsewhere"]);
    await env.DB.prepare("INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)")
      .bind(broadcasterUserId, "alice").run();
    const matchingSocket = await openSocket(matching.token);
    const otherSocket = await openSocket(otherChannel.token);
    const body = JSON.stringify({
      subscription: {
        id: "hype-begin-subscription", type: "channel.hype_train.begin", version: "2", status: "enabled", cost: 0,
        condition: { broadcaster_user_id: broadcasterUserId },
        transport: { method: "webhook", callback: "https://chatwerk.test/webhooks/twitch" },
        created_at: new Date().toISOString(),
      },
      event: {
        id: "train-123", broadcaster_user_id: broadcasterUserId, broadcaster_user_login: "alice",
        broadcaster_user_name: "Alice", total: 100, progress: 100, goal: 500,
        top_contributions: [], shared_train_participants: null, level: 101,
        started_at: new Date().toISOString(), expires_at: new Date(Date.now() + 60_000).toISOString(),
        is_shared_train: false, type: "regular",
      },
    });
    const headers = await signatureHeaders(body, "fanout-event-message");
    headers.set("Twitch-Eventsub-Message-Type", "notification");
    headers.set("Twitch-Eventsub-Subscription-Type", "channel.hype_train.begin");
    const response = await SELF.fetch(new Request("https://chatwerk.test/webhooks/twitch", { method: "POST", headers, body }));

    expect(response.status).toBe(204);
    await vi.waitFor(() => expect(matchingSocket.messages.some((message) => message.type === "hype-train")).toBe(true));
    expect(matchingSocket.messages.find((message) => message.type === "hype-train")).toEqual({
      type: "hype-train", id: "fanout-event-message", trainId: "train-123", channel: "alice", phase: "begin", level: 101,
      expiresAt: expect.any(String),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(otherSocket.messages.some((message) => message.type === "hype-train")).toBe(false);
    matchingSocket.socket.close();
    otherSocket.socket.close();
  });

  it("does not allow an overlay renderer socket to inject a Hype Train event", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "socket_inject" });
    const sender = await openSocket(overlay.token);
    const receiver = await openSocket(overlay.token);
    sender.socket.send(JSON.stringify({
      type: "hype-train", id: "forged", trainId: "forged-train", channel: "socket_inject", phase: "begin", level: 5, expiresAt: null,
    }));
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(sender.messages.some((message) => message.type === "hype-train")).toBe(false);
    expect(receiver.messages.some((message) => message.type === "hype-train")).toBe(false);
    sender.socket.close();
    receiver.socket.close();
  });
});

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

async function signatureHeaders(body: string, id: string): Promise<Headers> {
  const timestamp = new Date().toISOString();
  const sessionKey = "hype-train-worker-session-key";
  const secret = await deriveEventSubSecret(sessionKey);
  const signature = await hmacHex(secret, `${id}${timestamp}${body}`);
  return new Headers({
    "Twitch-Eventsub-Message-Id": id,
    "Twitch-Eventsub-Message-Timestamp": timestamp,
    "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
    "Twitch-Eventsub-Message-Type": "notification",
    "Twitch-Eventsub-Subscription-Type": "channel.hype_train.begin",
    "Twitch-Eventsub-Subscription-Version": "2",
    "Content-Type": "application/json",
  });
}

async function hmacHex(keyValue: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(keyValue), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
