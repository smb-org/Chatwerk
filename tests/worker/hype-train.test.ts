import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { handleAuthRequest, type AuthEnvironment } from "../../src/worker/auth";
import { cookieValue, mintSessionCookie, seedOverlay } from "./worker-test-helpers";

const SESSION_KEY = "hype-train-worker-session-key";

describe("Hype Train consent OAuth", () => {
  it("starts an owner-only consent flow with the exact scope and signed nonce state", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "hype_owner" });
    const cookie = await mintSessionCookie(SESSION_KEY, overlay.ownerId);
    const response = await handleAuthRequest(new Request(
      `https://chatwerk.test/auth/hype-train?overlayId=${overlay.overlayId}`,
      { headers: { Cookie: cookie } },
    ), {
      DB: env.DB,
      SESSION_KEY,
      TWITCH_CLIENT_ID: "test-client",
      TWITCH_CLIENT_SECRET: "test-client-secret",
    } satisfies AuthEnvironment);

    expect(response?.status).toBe(302);
    const location = new URL(response!.headers.get("location")!);
    expect(location.origin).toBe("https://id.twitch.tv");
    expect(location.searchParams.get("scope")).toBe("channel:read:hype_train");
    expect(location.searchParams.get("redirect_uri")).toBe("https://chatwerk.test/auth/callback");
    expect(location.searchParams.get("state")?.split(".")).toHaveLength(2);
    expect(response!.headers.get("set-cookie")).toContain("oauth_purpose=hype-train");
    expect(response!.headers.get("set-cookie")).toContain("HttpOnly");
  });

  it("does not start consent when the logged-in user is only an overlay helper", async () => {
    const owner = await seedOverlay(env.DB, { channel: "hype_owner" });
    const helperId = `helper-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO users (id, login) VALUES (?, ?)").bind(helperId, `helper_${crypto.randomUUID().slice(0, 8)}`).run();
    await env.DB.prepare("INSERT INTO overlay_editors (overlay_id, user_id) VALUES (?, ?)").bind(owner.overlayId, helperId).run();
    const cookie = await mintSessionCookie(SESSION_KEY, helperId);
    const response = await handleAuthRequest(new Request(
      `https://chatwerk.test/auth/hype-train?overlayId=${owner.overlayId}`,
      { headers: { Cookie: cookie } },
    ), {
      DB: env.DB,
      SESSION_KEY,
      TWITCH_CLIENT_ID: "test-client",
      TWITCH_CLIENT_SECRET: "test-client-secret",
    } satisfies AuthEnvironment);

    expect(response?.status).toBe(403);
    expect(response?.headers.get("location")).toBeNull();
  });

  it("does not create consent when Twitch did not grant the required scope", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "hype_scope" });
    const { request, fetcher } = await callbackRequest(overlay, overlay.ownerId, { scope: [] });
    const response = await handleAuthRequest(request, authEnv(), fetcher);

    expect(new URL(response!.headers.get("location")!).searchParams.get("hypeTrain")).toBe("scope-missing");
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
      .bind(overlay.ownerId).first()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps the session and stores no consent when Twitch returns another user id", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "hype_mismatch" });
    const { request, fetcher } = await callbackRequest(overlay, overlay.ownerId, { twitchUserId: "another-user" });
    const response = await handleAuthRequest(request, authEnv(), fetcher);

    expect(new URL(response!.headers.get("location")!).searchParams.get("hypeTrain")).toBe("user-mismatch");
    expect(response!.headers.get("set-cookie")).not.toContain("session=");
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
      .bind(overlay.ownerId).first()).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("accepts already-existing subscriptions and stores only the broadcaster consent", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "hype_409" });
    const { request, fetcher } = await callbackRequest(overlay, overlay.ownerId, { subscriptionStatus: 409 });
    const response = await handleAuthRequest(request, authEnv(), fetcher);
    const row = await env.DB.prepare("SELECT user_id, login, created_at FROM hype_train_consents WHERE user_id = ?")
      .bind(overlay.ownerId).first<{ user_id: string; login: string; created_at: string }>();

    expect(new URL(response!.headers.get("location")!).searchParams.get("hypeTrain")).toBe("connected");
    expect(row).toMatchObject({ user_id: overlay.ownerId, login: "hype_409" });
    expect(Object.keys(row ?? {}).sort()).toEqual(["created_at", "login", "user_id"]);
    const subscriptions = fetcher.mock.calls
      .filter(([input, init]) => String(input) === "https://api.twitch.tv/helix/eventsub/subscriptions" && init?.method === "POST")
      .map(([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>);
    expect(subscriptions.map((item) => item.type).sort()).toEqual([
      "channel.hype_train.begin", "channel.hype_train.end", "channel.hype_train.progress",
    ]);
    expect(subscriptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ version: "2", condition: { broadcaster_user_id: overlay.ownerId }, transport: expect.objectContaining({
        method: "webhook", callback: "https://chatwerk.test/webhooks/twitch", secret: expect.stringMatching(/^[0-9a-f]{64}$/u),
      }) }),
    ]));
    expect(response!.headers.get("set-cookie")).not.toContain("session=");
  });

  it("removes old subscriptions before creating replacements on reconnect", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "hype_reconnect" });
    await env.DB.prepare("INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)")
      .bind(overlay.ownerId, "hype_reconnect").run();
    const { request, fetcher, callOrder } = await callbackRequest(overlay, overlay.ownerId, {
      existingSubscriptionIds: ["old-begin", "old-progress", "old-end"],
    });
    const response = await handleAuthRequest(request, authEnv(), fetcher);

    expect(new URL(response!.headers.get("location")!).searchParams.get("hypeTrain")).toBe("connected");
    expect(callOrder).toEqual([
      "delete:old-begin", "delete:old-progress", "delete:old-end",
      "create:channel.hype_train.begin", "create:channel.hype_train.progress", "create:channel.hype_train.end",
    ]);
  });

  it("creates no subscriptions when saving consent fails", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "hype_insert_failure" });
    await env.DB.prepare(`
      CREATE TRIGGER fail_hype_consent_insert BEFORE INSERT ON hype_train_consents
      WHEN NEW.user_id = '${overlay.ownerId}' BEGIN SELECT RAISE(FAIL, 'blocked consent insert'); END
    `).run();
    try {
      const { request, fetcher } = await callbackRequest(overlay, overlay.ownerId);
      const response = await handleAuthRequest(request, authEnv(), fetcher);

      expect(new URL(response!.headers.get("location")!).searchParams.get("hypeTrain")).toBe("failed");
      expect(fetcher.mock.calls.some(([input, init]) => String(input) === "https://api.twitch.tv/helix/eventsub/subscriptions" && init?.method === "POST")).toBe(false);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS fail_hype_consent_insert").run();
    }
  });

  it("removes the consent row when replacement subscription creation fails", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "hype_failed_reconnect" });
    await env.DB.prepare("INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)")
      .bind(overlay.ownerId, "hype_failed_reconnect").run();
    const { request, fetcher } = await callbackRequest(overlay, overlay.ownerId, { failSubscriptionNumber: 2 });
    const response = await handleAuthRequest(request, authEnv(), fetcher);

    expect(new URL(response!.headers.get("location")!).searchParams.get("hypeTrain")).toBe("failed");
    expect(fetcher.mock.calls.some(([input, init]) => String(input).includes("eventsub/subscriptions?id=created-subscription-1") && init?.method === "DELETE")).toBe(true);
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
      .bind(overlay.ownerId).first()).toBeNull();
  });

  it("rolls back subscriptions it created when a later subscription fails", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "hype_rollback" });
    const { request, fetcher } = await callbackRequest(overlay, overlay.ownerId, { failSubscriptionNumber: 2 });
    const response = await handleAuthRequest(request, authEnv(), fetcher);

    expect(new URL(response!.headers.get("location")!).searchParams.get("hypeTrain")).toBe("failed");
    expect(fetcher.mock.calls.some(([input, init]) => String(input).includes("eventsub/subscriptions?id=created-subscription-1") && init?.method === "DELETE")).toBe(true);
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
      .bind(overlay.ownerId).first()).toBeNull();
  });

  it("returns a denial status without changing the signed-in session", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "hype_denied" });
    const { request, fetcher } = await callbackRequest(overlay, overlay.ownerId, { denied: true });
    const response = await handleAuthRequest(request, authEnv(), fetcher);

    expect(new URL(response!.headers.get("location")!).searchParams.get("hypeTrain")).toBe("denied");
    expect(response!.headers.get("set-cookie")).not.toContain("session=");
    expect(fetcher).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?")
      .bind(overlay.ownerId).first()).toBeNull();
  });
});

function authEnv(): AuthEnvironment {
  return {
    DB: env.DB,
    SESSION_KEY,
    TWITCH_CLIENT_ID: "test-client",
    TWITCH_CLIENT_SECRET: "test-client-secret",
    PUBLIC_ORIGIN: "https://chatwerk.test",
  };
}

async function callbackRequest(
  overlay: { ownerId: string; overlayId: string },
  sessionUserId: string,
  options: {
    scope?: string[];
    twitchUserId?: string;
    subscriptionStatus?: number;
    failSubscriptionNumber?: number;
    existingSubscriptionIds?: string[];
    denied?: boolean;
  } = {},
): Promise<{ request: Request; fetcher: ReturnType<typeof vi.fn<typeof fetch>>; callOrder: string[] }> {
  const start = await handleAuthRequest(new Request(
    `https://chatwerk.test/auth/hype-train?overlayId=${overlay.overlayId}`,
    { headers: { Cookie: await mintSessionCookie(SESSION_KEY, sessionUserId) } },
  ), authEnv());
  const authorize = new URL(start!.headers.get("location")!);
  const nonce = cookieValue(start!, "oauth_nonce");
  const next = cookieValue(start!, "oauth_next");
  const purpose = cookieValue(start!, "oauth_purpose");
  const cookies = [await mintSessionCookie(SESSION_KEY, sessionUserId), `oauth_nonce=${nonce}`, `oauth_next=${next}`, `oauth_purpose=${purpose}`].join("; ");
  const callback = new URL("/auth/callback", "https://chatwerk.test");
  callback.searchParams.set("state", authorize.searchParams.get("state")!);
  if (options.denied) callback.searchParams.set("error", "access_denied");
  else callback.searchParams.set("code", "one-time-code");

  let subscriptionNumber = 0;
  const callOrder: string[] = [];
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    const target = String(input);
    if (target === "https://id.twitch.tv/oauth2/token" && new URLSearchParams(String(init?.body)).get("grant_type") === "authorization_code") {
      return Response.json({ access_token: "transient-user-token", scope: options.scope ?? ["channel:read:hype_train"] });
    }
    if (target === "https://api.twitch.tv/helix/users") {
      return Response.json({ data: [{ id: options.twitchUserId ?? sessionUserId, login: "Hype_409" }] });
    }
    if (target === "https://id.twitch.tv/oauth2/token") {
      return Response.json({ access_token: "transient-app-token" });
    }
    if (target.startsWith("https://api.twitch.tv/helix/eventsub/subscriptions?user_id=")) {
      return Response.json({ data: (options.existingSubscriptionIds ?? []).map((id, index) => ({
        id,
        type: ["channel.hype_train.begin", "channel.hype_train.progress", "channel.hype_train.end"][index % 3],
        condition: { broadcaster_user_id: sessionUserId },
      })), pagination: {} });
    }
    if (target === "https://api.twitch.tv/helix/eventsub/subscriptions" && init?.method === "POST") {
      subscriptionNumber += 1;
      const postBody = JSON.parse(String(init.body)) as { type: string };
      callOrder.push(`create:${postBody.type}`);
      if (options.failSubscriptionNumber === subscriptionNumber) return new Response("failed", { status: 500 });
      if (options.subscriptionStatus === 409) return new Response(null, { status: 409 });
      return Response.json({ data: [{ id: `created-subscription-${subscriptionNumber}` }] }, { status: 202 });
    }
    if (target.includes("eventsub/subscriptions?id=") && init?.method === "DELETE") {
      callOrder.push(`delete:${new URL(target).searchParams.get("id")}`);
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected mocked Twitch request: ${target}`);
  });
  return { request: new Request(callback, { headers: { Cookie: cookies } }), fetcher, callOrder };
}
