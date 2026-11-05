import { env } from "cloudflare:workers";
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mintSessionCookie, seedOverlay } from "./worker-test-helpers";
import { handleHypeTrainRequest, type HypeTrainEnvironment } from "../../src/worker/hype-train";

const SESSION_KEY = "hype-train-worker-session-key";

afterEach(() => vi.unstubAllGlobals());

describe("Hype Train Studio API", () => {
  it("returns consent status for the active overlay owner", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "status_room" });
    const cookie = await mintSessionCookie(SESSION_KEY, overlay.ownerId);
    const response = await SELF.fetch(new Request(`https://chatwerk.test/api/hype-train?overlayId=${overlay.overlayId}`, {
      headers: { Cookie: cookie },
    }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ role: "owner", connected: false });
  });

  it("blocks a helper from disconnecting the broadcaster's consent", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "shared_hype_room" });
    const helperId = `helper-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO users (id, login) VALUES (?, ?)").bind(helperId, `helper_${crypto.randomUUID().slice(0, 8)}`).run();
    await env.DB.prepare("INSERT INTO overlay_editors (overlay_id, user_id) VALUES (?, ?)").bind(overlay.overlayId, helperId).run();
    await env.DB.prepare("INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)").bind(overlay.ownerId, "shared_hype_room").run();
    const cookie = await mintSessionCookie(SESSION_KEY, helperId);
    const response = await SELF.fetch(new Request("https://chatwerk.test/api/hype-train/disconnect", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://chatwerk.test", "Content-Type": "application/json" },
      body: JSON.stringify({ overlayId: overlay.overlayId }),
    }));

    expect(response.status).toBe(403);
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?").bind(overlay.ownerId).first()).not.toBeNull();
  });

  it("disconnects all three Hype Train subscription types and keeps unrelated types", async () => {
    const overlay = await seedOverlay(env.DB, { channel: "disconnect_room" });
    await env.DB.prepare("INSERT INTO hype_train_consents (user_id, login) VALUES (?, ?)").bind(overlay.ownerId, "disconnect_room").run();
    const deleted: string[] = [];
    const fetcher = vi.fn<typeof fetch>(async (input, init) => {
      const target = String(input);
      if (target === "https://id.twitch.tv/oauth2/token") return Response.json({ access_token: "transient-app-token" });
      if (target.includes("eventsub/subscriptions?") && !target.includes("?id=")) return Response.json({
        data: [
          { id: "disconnect-begin", type: "channel.hype_train.begin", condition: { broadcaster_user_id: overlay.ownerId } },
          { id: "disconnect-progress", type: "channel.hype_train.progress", condition: { broadcaster_user_id: overlay.ownerId } },
          { id: "disconnect-end", type: "channel.hype_train.end", condition: { broadcaster_user_id: overlay.ownerId } },
          { id: "keep-follow", type: "channel.follow", condition: { broadcaster_user_id: overlay.ownerId } },
        ], pagination: {},
      });
      if (target.includes("eventsub/subscriptions?id=") && init?.method === "DELETE") {
        deleted.push(new URL(target).searchParams.get("id")!);
        return new Response(null, { status: 204 });
      }
      throw new Error(`Unexpected mocked Twitch request: ${target}`);
    });
    const cookie = await mintSessionCookie(SESSION_KEY, overlay.ownerId);
    const pending: Promise<unknown>[] = [];
    const response = await handleHypeTrainRequest(new Request("https://chatwerk.test/api/hype-train/disconnect", {
      method: "POST",
      headers: { Cookie: cookie, Origin: "https://chatwerk.test", "Content-Type": "application/json" },
      body: JSON.stringify({ overlayId: overlay.overlayId }),
    }), env as HypeTrainEnvironment, { waitUntil: (promise) => pending.push(promise) }, fetcher);

    expect(response?.status).toBe(200);
    expect((await response!.json() as { connected: boolean }).connected).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(5);
    expect(deleted.sort()).toEqual(["disconnect-begin", "disconnect-end", "disconnect-progress"]);
    expect(await env.DB.prepare("SELECT user_id FROM hype_train_consents WHERE user_id = ?").bind(overlay.ownerId).first()).toBeNull();
  });
});
