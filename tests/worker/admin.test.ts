import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleApiRequest, type ApiEnvironment } from "../../src/worker/api";
import { mintSessionCookie, seedOverlay } from "./worker-test-helpers";

const SESSION_KEY = "worker-admin-test-session-key";

const apiEnv = (adminIds?: string): ApiEnvironment => ({
  DB: env.DB,
  OVERLAY: env.OVERLAY,
  SESSION_KEY,
  ...(adminIds === undefined ? {} : { ADMIN_TWITCH_IDS: adminIds }),
});

async function adminRequest(userId: string, init: RequestInit = {}): Promise<Request> {
  return new Request("https://chatwerk.test/api/admin/overview", {
    ...init,
    headers: {
      Cookie: await mintSessionCookie(SESSION_KEY, userId),
      Origin: "https://chatwerk.test",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

describe("read-only operator admin API", () => {
  it("hides the overview when the allowlist is missing, empty, or does not include the session user", async () => {
    const userId = "812345678";
    await env.DB.prepare("INSERT INTO users (id, login) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
      .bind(userId, "admin_auth_test").run();
    const missingUserId = `9${Date.now()}${Math.floor(Math.random() * 10000)}`;
    await env.DB.prepare("DELETE FROM users WHERE id = ?").bind(missingUserId).run();
    const cases: Array<{ name: string; ids?: string; request?: Request }> = [
      { name: "missing secret", request: await adminRequest(userId) },
      { name: "empty secret", ids: "  ", request: await adminRequest(userId) },
      { name: "no session", ids: userId, request: new Request("https://chatwerk.test/api/admin/overview") },
      { name: "not allowlisted", ids: "987654321", request: await adminRequest(userId) },
      { name: "allowlisted session without a user row", ids: missingUserId, request: await adminRequest(missingUserId) },
      { name: "foreign origin", ids: userId, request: await adminRequest(userId, { headers: { Origin: "https://evil.test" } }) },
      { name: "unknown admin path", request: new Request("https://chatwerk.test/api/admin/unknown") },
    ];

    for (const testCase of cases) {
      const response = await handleApiRequest(testCase.request!, apiEnv(testCase.ids));
      expect(response?.status, testCase.name).toBe(404);
    }
  });

  it("returns only the overview fields and never serializes credential material", async () => {
    const ownerId = "823456789";
    const overlay = await seedOverlay(env.DB, { ownerId, name: "Main office", channel: "primary_room" });
    await env.DB.prepare("UPDATE users SET login = ?, created_at = ?, last_login_at = ? WHERE id = ?")
      .bind("admin_viewer", "2025-01-02 03:04:05", "2026-04-05 06:07:08", ownerId).run();
    const editorId = `editor-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO users (id, login) VALUES (?, ?)").bind(editorId, "helper_viewer").run();
    await env.DB.prepare("INSERT INTO overlay_editors (overlay_id, user_id) VALUES (?, ?)")
      .bind(overlay.overlayId, editorId).run();
    const inviteToken = `private-invite-${crypto.randomUUID()}`;
    await env.DB.prepare("INSERT INTO overlay_invites (overlay_id, token, expires_at) VALUES (?, ?, ?)")
      .bind(overlay.overlayId, inviteToken, Math.floor(Date.now() / 1000) + 3600).run();
    await env.DB.prepare("INSERT INTO themes (id, owner_id, slug, name, values_json) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), ownerId, `active-${crypto.randomUUID()}`, "Public look", "{}").run();
    await env.DB.prepare("INSERT INTO themes (id, owner_id, slug, name, values_json, withdrawn_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), ownerId, `withdrawn-${crypto.randomUUID()}`, "Old look", "{}", "2026-01-01").run();
    const request = await adminRequest(ownerId);
    const sessionCookie = request.headers.get("cookie")!;

    const response = await handleApiRequest(request, apiEnv(ownerId));
    const body = await response?.json() as {
      totals: { users: number; overlays: number; connectedOutputs: number | null };
      users: Array<{
        twitchId: string; login: string; createdAt: string; lastLoginAt: string | null;
        overlays: Array<{ name: string; channels: string[]; createdAt: string; connectedOutputs: number | null }>;
        editorLogins: string[]; pendingInvite: boolean; activeGalleryLooks: number;
      }>;
    };
    const user = body.users.find((entry) => entry.twitchId === ownerId)!;
    const serialized = JSON.stringify(body).toLowerCase();
    const fieldNames = (value: unknown): string[] => value && typeof value === "object"
      ? Object.entries(value).flatMap(([key, child]) => [key, ...fieldNames(child)])
      : [];

    expect(response?.status).toBe(200);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(user).toMatchObject({
      twitchId: ownerId,
      login: "admin_viewer",
      createdAt: "2025-01-02 03:04:05",
      lastLoginAt: "2026-04-05 06:07:08",
      editorLogins: ["helper_viewer"],
      pendingInvite: true,
      activeGalleryLooks: 1,
    });
    expect(user.overlays).toHaveLength(1);
    expect(body.users.findIndex((entry) => entry.twitchId === ownerId))
      .toBeLessThan(body.users.findIndex((entry) => entry.login === "helper_viewer"));
    expect(user.overlays[0]).toMatchObject({
      name: "Main office", channels: ["primary_room"], connectedOutputs: 0,
    });
    expect(body.totals).toMatchObject({ overlays: 1, connectedOutputs: 0 });
    expect(fieldNames(body).join(" ")).not.toMatch(/token|hash|session|secret|consent/iu);
    expect(serialized).not.toMatch(/token|hash|session|secret|consent/iu);
    expect(serialized).not.toContain(overlay.token.toLowerCase());
    expect(serialized).not.toContain(inviteToken.toLowerCase());
    expect(serialized).not.toContain(sessionCookie.toLowerCase());
  });

  it("shows an unknown output count when an overlay Durable Object call fails", async () => {
    const ownerId = "834567891";
    await seedOverlay(env.DB, { ownerId, name: "Unavailable overlay", channel: "fallback_room" });
    const unavailableNamespace = {
      idFromName: (name: string) => name,
      get: () => ({ getAdminStats: async () => { throw new Error("offline"); } }),
    } as unknown as DurableObjectNamespace;

    const response = await handleApiRequest(await adminRequest(ownerId), {
      ...apiEnv(ownerId), OVERLAY: unavailableNamespace,
    });
    const body = await response?.json() as {
      totals: { connectedOutputs: number | null };
      users: Array<{ twitchId: string; overlays: Array<{ channels: string[]; connectedOutputs: number | null }> }>;
    };
    const user = body.users.find((entry) => entry.twitchId === ownerId)!;

    expect(response?.status).toBe(200);
    expect(user.overlays[0]).toMatchObject({ channels: ["fallback_room"], connectedOutputs: null });
    expect(body.totals.connectedOutputs).toBeNull();
  });
});
