import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { handleApiRequest, type ApiEnvironment } from "../../src/worker/api";
import { DEFAULTS } from "../../src/shared/theme";
import { mintSessionCookie, seedOverlay } from "./worker-test-helpers";

const SESSION_KEY = "worker-editors-test-session-key";
const apiEnv = (): ApiEnvironment => ({ DB: env.DB, OVERLAY: env.OVERLAY, SESSION_KEY });
const origin = "https://chatwerk.test";

async function requestAs(userId: string, path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Cookie", await mintSessionCookie(SESSION_KEY, userId));
  headers.set("Origin", origin);
  if (init.method && init.method !== "GET" && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return await handleApiRequest(new Request(new URL(path, origin), { ...init, headers }), apiEnv()) ?? new Response(null, { status: 404 });
}

async function addUser(userId = `helper-${crypto.randomUUID()}`): Promise<string> {
  const login = `login_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await env.DB.prepare("INSERT INTO users (id, login) VALUES (?, ?)").bind(userId, login).run();
  return userId;
}

async function addEditor(overlayId: string, userId: string): Promise<void> {
  await env.DB.prepare("INSERT INTO overlay_editors (overlay_id, user_id) VALUES (?, ?)").bind(overlayId, userId).run();
}

async function createInvite(ownerId: string, overlayId: string): Promise<{ inviteUrl: string; expiresAt: string }> {
  const response = await requestAs(ownerId, `/api/overlays/${overlayId}/invite`, { method: "POST", body: "{}" });
  expect(response.status).toBe(200);
  return await response.json() as { inviteUrl: string; expiresAt: string };
}

const configWrite = (patch: Record<string, unknown>, baseRevision = 0) =>
  ({ method: "PUT", body: JSON.stringify({ baseRevision, patch }) });

async function seedLook(ownerId: string, slug = `look-${crypto.randomUUID().slice(0, 8)}`): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO themes (id, owner_id, slug, name, name_key, values_json) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(id, ownerId, slug, "Shared look", "shared look", JSON.stringify(DEFAULTS)).run();
  return slug;
}

describe("overlay editors and invitations", () => {
  it("returns private access for strangers and lets an editor use shared overlay actions", async () => {
    const overlay = await seedOverlay(env.DB);
    const helperId = await addUser();
    const strangerId = await addUser();
    const slug = await seedLook(overlay.ownerId);
    await addEditor(overlay.overlayId, helperId);

    const strangerWrites = await Promise.all([
      requestAs(strangerId, `/api/overlays/${overlay.overlayId}/config`, configWrite({ fontSize: 22 })),
      requestAs(strangerId, `/api/overlays/${overlay.overlayId}/undo`, { method: "POST", body: JSON.stringify({ snapshotId: crypto.randomUUID(), expectedRevision: 1 }) }),
      requestAs(strangerId, `/api/overlays/${overlay.overlayId}/test-line`, { method: "POST", body: "{}" }),
      requestAs(strangerId, `/api/looks/${slug}/copy`, { method: "POST", body: JSON.stringify({ overlayId: overlay.overlayId }) }),
      requestAs(strangerId, "/api/looks", { method: "POST", body: JSON.stringify({ overlayId: overlay.overlayId, name: "Private look" }) }),
    ]);
    expect(strangerWrites.map((response) => response.status)).toEqual([404, 404, 404, 404, 404]);

    const write = await requestAs(helperId, `/api/overlays/${overlay.overlayId}/config`, configWrite({ fontSize: 24 }));
    const testLine = await requestAs(helperId, `/api/overlays/${overlay.overlayId}/test-line`, { method: "POST", body: "{}" });
    const copy = await requestAs(helperId, `/api/looks/${slug}/copy`, { method: "POST", body: JSON.stringify({ overlayId: overlay.overlayId }) });
    expect(write.status).toBe(200);
    expect(testLine.status).toBe(200);
    expect(copy.status).toBe(200);
    const copied = await copy.json() as { revision: number; snapshotId: string };
    const undone = await requestAs(helperId, `/api/overlays/${overlay.overlayId}/undo`, {
      method: "POST", body: JSON.stringify({ snapshotId: copied.snapshotId, expectedRevision: copied.revision }),
    });
    expect(undone.status).toBe(200);

    const published = await requestAs(helperId, "/api/looks", { method: "POST", body: JSON.stringify({ overlayId: overlay.overlayId, name: "Helper look" }) });
    expect(published.status).toBe(201);
    const publishedLook = await published.json() as { slug: string };
    const author = await env.DB.prepare("SELECT owner_id FROM themes WHERE slug = ?").bind(publishedLook.slug).first<{ owner_id: string }>();
    expect(author?.owner_id).toBe(helperId);
  });

  it("allows owners to keep custom CSS and blocks either CSS field for editors before config changes", async () => {
    const overlay = await seedOverlay(env.DB);
    const helperId = await addUser();
    await addEditor(overlay.overlayId, helperId);
    const url = `/api/overlays/${overlay.overlayId}/config`;

    const helperCss = await requestAs(helperId, url, configWrite({ customCss: "body { background: red }" }));
    const helperEnabled = await requestAs(helperId, url, configWrite({ customCssEnabled: true }));
    const ownerCss = await requestAs(overlay.ownerId, url, configWrite({ customCss: "body { color: red }", customCssEnabled: true }));

    expect(helperCss.status).toBe(403);
    expect(await helperCss.json()).toMatchObject({ error: "owner-only-field" });
    expect(helperEnabled.status).toBe(403);
    expect(await helperEnabled.json()).toMatchObject({ error: "owner-only-field" });
    expect(ownerCss.status).toBe(200);
    expect(await ownerCss.json()).toMatchObject({ revision: 1, config: { customCss: "body { color: red }", customCssEnabled: true } });
  });

  it("counts published looks against the editor's own limit and disables stored CSS when copying a look", async () => {
    const overlay = await seedOverlay(env.DB);
    const helperId = await addUser();
    await addEditor(overlay.overlayId, helperId);
    const look = await seedLook(overlay.ownerId);
    const values = JSON.stringify(DEFAULTS).replaceAll("'", "''");
    for (let index = 0; index < 10; index += 1) {
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO themes (id, owner_id, slug, name, name_key, values_json) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, helperId, id, `Helper look ${index}`, `helper look ${index}`, values).run();
    }

    const cappedPublish = await requestAs(helperId, "/api/looks", {
      method: "POST", body: JSON.stringify({ overlayId: overlay.overlayId, name: "Eleventh helper look" }),
    });
    expect(cappedPublish.status).toBe(409);
    expect(await cappedPublish.json()).toMatchObject({ error: "look-limit", limit: 10 });

    const ownerCss = await requestAs(overlay.ownerId, `/api/overlays/${overlay.overlayId}/config`, configWrite({
      customCss: "body { color: red }", customCssEnabled: true,
    }));
    expect(ownerCss.status).toBe(200);
    const copied = await requestAs(helperId, `/api/looks/${look}/copy`, {
      method: "POST", body: JSON.stringify({ overlayId: overlay.overlayId }),
    });
    expect(copied.status).toBe(200);
    const linkedConfig = await requestAs(helperId, "/api/overlay/config", { headers: { Authorization: `Bearer ${overlay.token}` } });
    expect(await linkedConfig.json()).toMatchObject({ config: { customCss: "body { color: red }", customCssEnabled: false } });
  });

  it("blocks editor escalation while allowing self-removal", async () => {
    const overlay = await seedOverlay(env.DB);
    const secondOverlay = await seedOverlay(env.DB, { ownerId: overlay.ownerId, name: "Second" });
    const helperId = await addUser();
    const otherHelperId = await addUser();
    await addEditor(overlay.overlayId, helperId);
    await addEditor(overlay.overlayId, otherHelperId);

    const helperEscalations = await Promise.all([
      requestAs(helperId, `/api/overlays/${overlay.overlayId}`, { method: "PATCH", body: JSON.stringify({ name: "Renamed" }) }),
      requestAs(helperId, `/api/overlays/${overlay.overlayId}`, { method: "DELETE", body: "{}" }),
      requestAs(helperId, `/api/overlays/${overlay.overlayId}/rotate-link`, { method: "POST", body: "{}" }),
      requestAs(helperId, `/api/overlays/${overlay.overlayId}/invite`, { method: "POST", body: "{}" }),
      requestAs(helperId, `/api/overlays/${overlay.overlayId}/editors/${otherHelperId}`, { method: "DELETE", body: "{}" }),
    ]);
    expect(helperEscalations.map((response) => response.status)).toEqual([403, 403, 403, 403, 403]);
    expect((await requestAs(helperId, `/api/overlays/${overlay.overlayId}/editors/${helperId}`, { method: "DELETE", body: "{}" })).status).toBe(204);

    expect((await requestAs(overlay.ownerId, `/api/overlays/${overlay.overlayId}/editors/${otherHelperId}`, { method: "DELETE", body: "{}" })).status).toBe(204);
    expect((await requestAs(overlay.ownerId, `/api/overlays/${secondOverlay.overlayId}`, { method: "DELETE", body: "{}" })).status).toBe(204);
  });

  it("lists own overlays first with role-specific owner and helper details", async () => {
    const mine = await seedOverlay(env.DB);
    const sharedOwner = await seedOverlay(env.DB);
    const helperId = await addUser();
    await addEditor(sharedOwner.overlayId, helperId);
    const invited = await createInvite(mine.ownerId, mine.overlayId);

    const ownerList = await requestAs(mine.ownerId, "/api/overlays");
    const ownerBody = await ownerList.json() as { overlays: Array<Record<string, unknown>> };
    expect(ownerBody.overlays[0]).toMatchObject({ id: mine.overlayId, role: "owner", editors: [], invite: { expiresAt: invited.expiresAt } });

    const helperList = await requestAs(helperId, "/api/overlays");
    const helperBody = await helperList.json() as { overlays: Array<Record<string, unknown>> };
    expect(helperBody.overlays[0]).toMatchObject({ id: sharedOwner.overlayId, role: "editor" });
    expect(helperBody.overlays[0]?.ownerLogin).toEqual(await env.DB.prepare("SELECT login FROM users WHERE id = ?").bind(sharedOwner.ownerId).first<string>("login"));
    expect(helperBody.overlays[0]).not.toHaveProperty("editors");
    expect(helperBody.overlays[0]).not.toHaveProperty("invite");
  });

  it("counts only owned overlays against the three-overlay creation limit", async () => {
    const capped = await seedOverlay(env.DB);
    await seedOverlay(env.DB, { ownerId: capped.ownerId, name: "Owned two" });
    await seedOverlay(env.DB, { ownerId: capped.ownerId, name: "Owned three" });
    for (let index = 0; index < 2; index += 1) {
      const source = await seedOverlay(env.DB);
      await addEditor(source.overlayId, capped.ownerId);
    }
    const denied = await requestAs(capped.ownerId, "/api/overlays", { method: "POST", body: JSON.stringify({ name: "Blocked" }) });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ error: "overlay-limit", limit: 3 });

    const allowed = await seedOverlay(env.DB);
    await seedOverlay(env.DB, { ownerId: allowed.ownerId, name: "Owned two" });
    for (let index = 0; index < 3; index += 1) {
      const source = await seedOverlay(env.DB);
      await addEditor(source.overlayId, allowed.ownerId);
    }
    const created = await requestAs(allowed.ownerId, "/api/overlays", { method: "POST", body: JSON.stringify({ name: "Allowed" }) });
    expect(created.status).toBe(201);
  });

  it("creates, replaces, expires, revokes, and accepts a single-use invite link", async () => {
    const overlay = await seedOverlay(env.DB);
    const helperId = await addUser();
    const anotherUserId = await addUser();
    await addEditor(overlay.overlayId, helperId);
    const first = await createInvite(overlay.ownerId, overlay.overlayId);
    expect(new URL(first.inviteUrl).search).toBe(`?invite=${new URL(first.inviteUrl).searchParams.get("invite")}`);
    expect(new URL(first.inviteUrl).origin).toBe(origin);
    expect(new Date(first.expiresAt).getTime() - Date.now()).toBeGreaterThan(47 * 60 * 60 * 1000);

    const ownerAccept = await requestAs(overlay.ownerId, `/api/invites/${new URL(first.inviteUrl).searchParams.get("invite")}/accept`, { method: "POST", body: "{}" });
    expect(ownerAccept.status).toBe(400);
    expect(await ownerAccept.json()).toMatchObject({ error: "own-overlay" });

    const accepted = await requestAs(helperId, `/api/invites/${new URL(first.inviteUrl).searchParams.get("invite")}/accept`, { method: "POST", body: "{}" });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ overlay: { id: overlay.overlayId, role: "editor" } });
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM overlay_invites WHERE overlay_id = ?")
      .bind(overlay.overlayId).first<{ count: number }>())?.count).toBe(1);
    const intendedHelper = await requestAs(anotherUserId, `/api/invites/${new URL(first.inviteUrl).searchParams.get("invite")}/accept`, { method: "POST", body: "{}" });
    expect(intendedHelper.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM overlay_invites WHERE overlay_id = ?")
      .bind(overlay.overlayId).first<{ count: number }>())?.count).toBe(0);

    const idempotentLink = await createInvite(overlay.ownerId, overlay.overlayId);
    const idempotent = await requestAs(helperId, `/api/invites/${new URL(idempotentLink.inviteUrl).searchParams.get("invite")}/accept`, { method: "POST", body: "{}" });
    expect(idempotent.status).toBe(200);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM overlay_invites WHERE overlay_id = ?")
      .bind(overlay.overlayId).first<{ count: number }>())?.count).toBe(1);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM overlay_editors WHERE overlay_id = ? AND user_id = ?").bind(overlay.overlayId, helperId).first<{ count: number }>())?.count).toBe(1);

    const expired = await createInvite(overlay.ownerId, overlay.overlayId);
    const expiredToken = new URL(expired.inviteUrl).searchParams.get("invite")!;
    await env.DB.prepare("UPDATE overlay_invites SET expires_at = ? WHERE overlay_id = ?").bind(Math.floor(Date.now() / 1000) - 1, overlay.overlayId).run();
    const expiredAccept = await requestAs(anotherUserId, `/api/invites/${expiredToken}/accept`, { method: "POST", body: "{}" });
    expect(expiredAccept.status).toBe(410);

    const replaced = await createInvite(overlay.ownerId, overlay.overlayId);
    const current = await createInvite(overlay.ownerId, overlay.overlayId);
    const replacedAccept = await requestAs(anotherUserId, `/api/invites/${new URL(replaced.inviteUrl).searchParams.get("invite")}/accept`, { method: "POST", body: "{}" });
    expect(replacedAccept.status).toBe(410);
    const revokedToken = new URL(current.inviteUrl).searchParams.get("invite")!;
    expect((await requestAs(overlay.ownerId, `/api/overlays/${overlay.overlayId}/invite`, { method: "DELETE", body: "{}" })).status).toBe(204);
    const revokedAccept = await requestAs(anotherUserId, `/api/invites/${revokedToken}/accept`, { method: "POST", body: "{}" });
    expect(revokedAccept.status).toBe(410);
  });

  it("enforces five editors and serializes concurrent acceptances", async () => {
    const full = await seedOverlay(env.DB);
    for (let index = 0; index < 5; index += 1) await addEditor(full.overlayId, await addUser());
    const sixthUser = await addUser();
    const fullInvite = await createInvite(full.ownerId, full.overlayId);
    const fullResult = await requestAs(sixthUser, `/api/invites/${new URL(fullInvite.inviteUrl).searchParams.get("invite")}/accept`, { method: "POST", body: "{}" });
    expect(fullResult.status).toBe(409);
    expect(await fullResult.json()).toMatchObject({ error: "helper-limit" });

    const concurrent = await seedOverlay(env.DB);
    const userA = await addUser();
    const userB = await addUser();
    const link = await createInvite(concurrent.ownerId, concurrent.overlayId);
    const token = new URL(link.inviteUrl).searchParams.get("invite");
    const results = await Promise.all([
      requestAs(userA, `/api/invites/${token}/accept`, { method: "POST", body: "{}" }),
      requestAs(userB, `/api/invites/${token}/accept`, { method: "POST", body: "{}" }),
    ]);
    expect(results.map((response) => response.status).sort()).toEqual([200, 410]);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM overlay_editors WHERE overlay_id = ?").bind(concurrent.overlayId).first<{ count: number }>())?.count).toBe(1);
  });

  it("removes access on leave or owner removal while the overlay link remains readable until rotation", async () => {
    const overlay = await seedOverlay(env.DB);
    await seedOverlay(env.DB, { ownerId: overlay.ownerId, name: "Keep owner account alive" });
    const helperId = await addUser();
    const leaverId = await addUser();
    await addEditor(overlay.overlayId, helperId);
    await addEditor(overlay.overlayId, leaverId);

    expect((await requestAs(overlay.ownerId, `/api/overlays/${overlay.overlayId}/editors/${helperId}`, { method: "DELETE", body: "{}" })).status).toBe(204);
    expect((await requestAs(helperId, `/api/overlays/${overlay.overlayId}/config`, configWrite({ fontSize: 26 }))).status).toBe(404);
    expect((await requestAs(helperId, "/api/overlay/config", { headers: { Authorization: `Bearer ${overlay.token}` } })).status).toBe(200);

    expect((await requestAs(leaverId, `/api/overlays/${overlay.overlayId}/editors/${leaverId}`, { method: "DELETE", body: "{}" })).status).toBe(204);
    expect((await requestAs(leaverId, `/api/overlays/${overlay.overlayId}/config`, configWrite({ fontSize: 27 }))).status).toBe(404);

    const rotated = await requestAs(overlay.ownerId, `/api/overlays/${overlay.overlayId}/rotate-link`, { method: "POST", body: "{}" });
    expect(rotated.status).toBe(200);
    expect((await requestAs(helperId, "/api/overlay/config", { headers: { Authorization: `Bearer ${overlay.token}` } })).status).toBe(404);
  });

  it("rechecks editor membership after a streamed config body finishes", async () => {
    const overlay = await seedOverlay(env.DB);
    const helperId = await addUser();
    await addEditor(overlay.overlayId, helperId);

    let markBodyRead!: () => void;
    let releaseBody!: () => void;
    const bodyRead = new Promise<void>((resolve) => { markBodyRead = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        markBodyRead();
        return new Promise<void>((resolve) => {
          releaseBody = () => {
            controller.enqueue(new TextEncoder().encode(JSON.stringify({ baseRevision: 0, patch: { fontSize: 41 } })));
            controller.close();
            resolve();
          };
        });
      },
    });
    const headers = new Headers({
      Cookie: await mintSessionCookie(SESSION_KEY, helperId),
      Origin: origin,
      "Content-Type": "application/json",
    });
    const request = new Request(new URL(`/api/overlays/${overlay.overlayId}/config`, origin), {
      method: "PUT",
      headers,
      body,
      duplex: "half",
    } as RequestInit & { duplex: "half" });
    const pendingResponse = handleApiRequest(request, apiEnv());

    await bodyRead;
    expect((await requestAs(overlay.ownerId, `/api/overlays/${overlay.overlayId}/editors/${helperId}`, {
      method: "DELETE", body: "{}",
    })).status).toBe(204);
    releaseBody();

    const response = await pendingResponse;
    expect(response?.status).toBe(404);
    const linked = await requestAs(overlay.ownerId, "/api/overlay/config", {
      headers: { Authorization: `Bearer ${overlay.token}` },
    });
    expect(await linked.json()).toMatchObject({ revision: 0, config: { fontSize: 18 } });
  });

  it("cascades editor and invite rows when an overlay is deleted", async () => {
    const overlay = await seedOverlay(env.DB);
    await seedOverlay(env.DB, { ownerId: overlay.ownerId, name: "Second overlay" });
    await addEditor(overlay.overlayId, await addUser());
    await createInvite(overlay.ownerId, overlay.overlayId);

    expect((await requestAs(overlay.ownerId, `/api/overlays/${overlay.overlayId}`, { method: "DELETE", body: "{}" })).status).toBe(204);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM overlay_editors WHERE overlay_id = ?").bind(overlay.overlayId).first<{ count: number }>())?.count).toBe(0);
    expect((await env.DB.prepare("SELECT COUNT(*) AS count FROM overlay_invites WHERE overlay_id = ?").bind(overlay.overlayId).first<{ count: number }>())?.count).toBe(0);
  });
});
