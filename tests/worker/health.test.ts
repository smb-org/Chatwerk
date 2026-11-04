import { env, exports } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const worker = exports as unknown as {
  default: { fetch(request: string): Promise<Response> };
};

describe("Worker scaffold", () => {
  it("returns a healthy JSON response", async () => {
    const response = await worker.default.fetch("http://chatwerk.test/health");

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ ok: true });
  });

  it("returns a JSON 404 for unknown API paths", async () => {
    const response = await worker.default.fetch("http://chatwerk.test/api/x");

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("keeps the Durable Object counter between calls", async () => {
    const id = env.OVERLAY.newUniqueId();
    const overlay = env.OVERLAY.get(id);

    expect(await overlay.ping()).toBe(1);
    expect(await overlay.ping()).toBe(2);
  });

  it("applies the D1 migration and enforces unique overlay link tokens", async () => {
    const ownerId = crypto.randomUUID();
    const overlayId = crypto.randomUUID();

    const table = await env.DB.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'overlays'",
    ).first<{ name: string }>();
    expect(table?.name).toBe("overlays");

    await env.DB.prepare("INSERT INTO users (id, login) VALUES (?, ?)")
      .bind(ownerId, `user-${ownerId}`)
      .run();
    await env.DB.prepare(
      "INSERT INTO overlays (id, owner_id, link_token, name) VALUES (?, ?, ?, ?)",
    )
      .bind(overlayId, ownerId, `token-${overlayId}`, "First overlay")
      .run();

    await expect(
      env.DB.prepare(
        "INSERT INTO overlays (id, owner_id, link_token, name) VALUES (?, ?, ?, ?)",
      )
        .bind(crypto.randomUUID(), ownerId, `token-${overlayId}`, "Duplicate token")
        .run(),
    ).rejects.toThrow();
  });
});
