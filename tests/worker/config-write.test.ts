import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleApiRequest, type ApiEnvironment } from "../../src/worker/api";
import { mintSessionCookie, seedOverlay } from "./worker-test-helpers";

const SESSION_KEY = "worker-api-test-session-key";

const apiEnv = (): ApiEnvironment => ({
  DB: env.DB,
  OVERLAY: env.OVERLAY,
  SESSION_KEY,
});

const ownerRequest = async (ownerId: string, url: string, init: RequestInit = {}) => {
  const cookie = await mintSessionCookie(SESSION_KEY, ownerId);
  return new Request(url, {
    ...init,
    headers: {
      Cookie: cookie,
      Origin: "https://chatwerk.test",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
};

describe("overlay config API", () => {
  it("requires a signed owner session for the private overlay list", async () => {
    const response = await handleApiRequest(new Request("https://chatwerk.test/api/overlays"), apiEnv());
    expect(response?.status).toBe(401);
  });

  it("returns only the signed-in owner's overlays", async () => {
    const mine = await seedOverlay(env.DB);
    const other = await seedOverlay(env.DB);
    const response = await handleApiRequest(
      await ownerRequest(mine.ownerId, "https://chatwerk.test/api/overlays"), apiEnv(),
    );
    const body = await response?.json() as { overlays: Array<{ id: string; linkToken: string }> };

    expect(response?.status).toBe(200);
    expect(body.overlays.map(({ id }) => id)).toEqual([mine.overlayId]);
    expect(body.overlays[0]?.linkToken).toBe(mine.token);
    expect(body.overlays.some(({ id }) => id === other.overlayId)).toBe(false);
  });

  it("rejects malformed bearer tokens before resolving an overlay", async () => {
    const response = await handleApiRequest(new Request("https://chatwerk.test/api/overlay/config", {
      headers: { Authorization: "Bearer short", Origin: "null" },
    }), apiEnv());

    expect(response?.status).toBe(400);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(response?.headers.get("vary")).toContain("Authorization");
  });

  it("answers opaque-origin preflight with authorization CORS headers", async () => {
    const response = await handleApiRequest(new Request("https://chatwerk.test/api/overlay/config", {
      method: "OPTIONS",
      headers: { Origin: "null", "Access-Control-Request-Headers": "authorization" },
    }), apiEnv());

    expect(response?.status).toBe(204);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(response?.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response?.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(response?.headers.get("vary")).toContain("Authorization");
  });

  it("loads config through a bearer token without requiring Origin", async () => {
    const overlay = await seedOverlay(env.DB);
    const response = await handleApiRequest(new Request("https://chatwerk.test/api/overlay/config", {
      headers: { Authorization: `Bearer ${overlay.token}` },
    }), apiEnv());
    const body = await response?.json() as { revision: number; config: { fontSize: number } };

    expect(response?.status).toBe(200);
    expect(body.revision).toBe(0);
    expect(body.config.fontSize).toBe(18);
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(response?.headers.get("vary")).toContain("Authorization");
  });

  it("validates patches and advances the revision only when valid", async () => {
    const overlay = await seedOverlay(env.DB);
    const invalid = await handleApiRequest(await ownerRequest(overlay.ownerId,
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, patch: { fontSize: 999 } }),
      }), apiEnv());
    const valid = await handleApiRequest(await ownerRequest(overlay.ownerId,
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/config`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, patch: {
          fontSize: 24, emoteScale: 2.2, showBadges: false, showPronouns: true,
        } }),
      }), apiEnv());

    expect(invalid?.status).toBe(400);
    expect(valid?.status).toBe(200);
    expect(await valid?.json()).toMatchObject({ revision: 1, config: {
      fontSize: 24, emoteScale: 2.2, showBadges: false, showPronouns: true,
    } });
  });

  it("rejects declared and streamed request bodies above 64 KiB before JSON parsing", async () => {
    const overlay = await seedOverlay(env.DB);
    const url = `https://chatwerk.test/api/overlays/${overlay.overlayId}/config`;
    const oversizedBody = " ".repeat(65_537);
    const declaredTooLarge = await handleApiRequest(await ownerRequest(overlay.ownerId, url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": "65537" },
      body: oversizedBody,
    }), apiEnv());
    const streamedTooLarge = await handleApiRequest(await ownerRequest(overlay.ownerId, url, {
      method: "PUT",
      headers: { "Content-Type": "application/json", "Content-Length": "2" },
      body: oversizedBody,
    }), apiEnv());

    expect(declaredTooLarge?.status).toBe(413);
    expect(streamedTooLarge?.status).toBe(413);
  });

  it("maps a stale base revision to 409 without overwriting the current config", async () => {
    const overlay = await seedOverlay(env.DB);
    const url = `https://chatwerk.test/api/overlays/${overlay.overlayId}/config`;
    const first = await handleApiRequest(await ownerRequest(overlay.ownerId, url, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, patch: { fontSize: 24 } }),
    }), apiEnv());
    const stale = await handleApiRequest(await ownerRequest(overlay.ownerId, url, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: 0, patch: { fontSize: 32 } }),
    }), apiEnv());

    expect(first?.status).toBe(200);
    expect(stale?.status).toBe(409);
    expect(await stale?.json()).toMatchObject({ error: "Revision conflict", revision: 1, config: { fontSize: 24 } });
  });

  it("requires same-origin JSON writes and hides another owner's overlay", async () => {
    const overlay = await seedOverlay(env.DB);
    const foreign = await mintSessionCookie(SESSION_KEY, `foreign-${crypto.randomUUID()}`);
    const crossOrigin = await handleApiRequest(new Request(
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/config`, {
        method: "PUT", headers: { Cookie: await mintSessionCookie(SESSION_KEY, overlay.ownerId), Origin: "https://evil.test", "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, patch: { fontSize: 24 } }),
      }), apiEnv());
    const wrongType = await handleApiRequest(new Request(
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/config`, {
        method: "PUT", headers: { Cookie: await mintSessionCookie(SESSION_KEY, overlay.ownerId), Origin: "https://chatwerk.test", "Content-Type": "text/plain" }, body: "{}",
      }), apiEnv());
    const notOwner = await handleApiRequest(new Request(
      `https://chatwerk.test/api/overlays/${overlay.overlayId}/config`, {
        method: "PUT", headers: { Cookie: foreign, Origin: "https://chatwerk.test", "Content-Type": "application/json" },
        body: JSON.stringify({ baseRevision: 0, patch: { fontSize: 24 } }),
      }), apiEnv());

    expect(crossOrigin?.status).toBe(403);
    expect(wrongType?.status).toBe(415);
    expect(notOwner?.status).toBe(404);
  });
});
