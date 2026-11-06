import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleAuthRequest, type AuthEnvironment } from "../../src/worker/auth";
import { handleHypeTrainRequest, type HypeTrainEnvironment } from "../../src/worker/hype-train";
import { deriveEventSubSecret } from "../../src/worker/twitch-eventsub";
import { mintSessionCookie, seedOverlay } from "./worker-test-helpers";

const SESSION_KEY = "hype-train-worker-session-key";

afterEach(() => vi.unstubAllGlobals());

describe("Hype Train routes with file flags off", () => {
  it("redirects OAuth to Studio and returns 404 for status without calling Twitch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const auth = await handleAuthRequest(
      new Request("https://chatwerk.test/auth/hype-train?overlayId=ignored"),
      env as AuthEnvironment,
      fetcher,
    );
    expect(auth?.status).toBe(302);
    expect(auth?.headers.get("location")).toBe("https://chatwerk.test/studio");
    expect(fetcher).not.toHaveBeenCalled();

    const status = await SELF.fetch("https://chatwerk.test/api/hype-train?overlayId=ignored");
    expect(status.status).toBe(404);
    expect(await status.json()).toEqual({ error: "Hype Train is disabled" });
  });

  it("keeps the disconnect route active while Hype Train is disabled", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "disabled_disconnect" });
    await env.DB.prepare("INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)")
      .bind(overlay.ownerId, "disabled_disconnect").run();
    const cookie = await mintSessionCookie(SESSION_KEY, overlay.ownerId);
    const fetcher = vi.fn<typeof fetch>(async (input) => {
      const target = String(input);
      if (target === "https://id.twitch.tv/oauth2/token") return Response.json({ access_token: "mock-app-token" });
      if (target.startsWith("https://api.twitch.tv/helix/eventsub/subscriptions?")) {
        return Response.json({ data: [], pagination: {} });
      }
      throw new Error(`Unexpected mocked Twitch request: ${target}`);
    });
    const response = await handleHypeTrainRequest(new Request("https://chatwerk.test/api/hype-train/disconnect", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://chatwerk.test", "Content-Type": "application/json" },
      body: JSON.stringify({ overlayId: overlay.overlayId }),
    }), env as HypeTrainEnvironment, { waitUntil: () => undefined }, fetcher);

    expect(response?.status).toBe(200);
    expect(await response!.json()).toEqual({ connected: false });
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
      .bind(overlay.ownerId).first()).toBeNull();
    expect(fetcher).toHaveBeenCalled();
  });

  it("still answers signed webhook challenges and revocations", async () => {
    const challengeBody = JSON.stringify({ challenge: "verify-off-state" });
    const challengeHeaders = await signedWebhookHeaders(challengeBody, "message-off-challenge", "webhook_callback_verification");
    const challenge = await handleHypeTrainRequest(new Request("https://chatwerk.test/webhooks/twitch", {
      method: "POST", headers: challengeHeaders, body: challengeBody,
    }), env as HypeTrainEnvironment, { waitUntil: () => undefined }, vi.fn<typeof fetch>());
    expect(challenge?.status).toBe(200);
    expect(await challenge!.text()).toBe("verify-off-state");

    const broadcasterId = "broadcaster-off-123";
    await seedOverlay(env.DB, { ownerId: broadcasterId, channel: "revoked_off_state" });
    await env.DB.prepare("INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)")
      .bind(broadcasterId, "revoked_off_state").run();
    const revocationBody = JSON.stringify({ subscription: {
      type: "channel.hype_train.begin", version: "2", status: "authorization_revoked",
      condition: { broadcaster_user_id: broadcasterId },
    } });
    const revocationHeaders = await signedWebhookHeaders(revocationBody, "message-off-revocation", "revocation");
    const pending: Promise<unknown>[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => { throw new Error("mocked Twitch is unavailable"); });
    const revocation = await handleHypeTrainRequest(new Request("https://chatwerk.test/webhooks/twitch", {
      method: "POST", headers: revocationHeaders, body: revocationBody,
    }), env as HypeTrainEnvironment, { waitUntil: (promise) => pending.push(promise) }, fetcher);
    await Promise.all(pending);

    expect(revocation?.status).toBe(204);
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
      .bind(broadcasterId).first()).toBeNull();
    expect(fetcher).toHaveBeenCalled();
  });
});

async function signedWebhookHeaders(body: string, id: string, messageType: string): Promise<Headers> {
  const timestamp = new Date().toISOString();
  const signature = await hmacHex(await deriveEventSubSecret(SESSION_KEY), `${id}${timestamp}${body}`);
  return new Headers({
    "Twitch-Eventsub-Message-Id": id,
    "Twitch-Eventsub-Message-Timestamp": timestamp,
    "Twitch-Eventsub-Message-Type": messageType,
    "Twitch-Eventsub-Subscription-Type": "channel.hype_train.begin",
    "Twitch-Eventsub-Subscription-Version": "2",
    "Twitch-Eventsub-Message-Signature": `sha256=${signature}`,
    "Content-Type": "application/json",
    "Content-Length": String(new TextEncoder().encode(body).byteLength),
  });
}

async function hmacHex(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), {
    name: "HMAC", hash: "SHA-256",
  }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(value)));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
