import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { handleApiRequest, type ApiEnvironment } from "../../src/worker/api";
import type { OverlayObject } from "../../src/worker/overlay-object";
import { mintSessionCookie, seedOverlay } from "./worker-test-helpers";

const SESSION_KEY = "gallery-api-test-session-key";
const apiEnv = (): ApiEnvironment => ({ DB: env.DB, OVERLAY: env.OVERLAY, SESSION_KEY });

async function requestAs(ownerId: string, url: string, init: RequestInit = {}): Promise<Request> {
  return new Request(url, {
    ...init,
    headers: {
      Cookie: await mintSessionCookie(SESSION_KEY, ownerId),
      Origin: "https://chatwerk.test",
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

async function publish(ownerId: string, overlayId: string, name: string, origin = "https://chatwerk.test") {
  return handleApiRequest(await requestAs(ownerId, `${origin}/api/looks`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ overlayId, name }),
  }), apiEnv());
}

async function lookBySlug(slug: string) {
  return handleApiRequest(new Request(`https://chatwerk.test/api/looks/${slug}`), apiEnv());
}

const overlayObject = (id: string): OverlayObject =>
  env.OVERLAY.get(env.OVERLAY.idFromName(id)) as unknown as OverlayObject;

async function removeOverlay(ownerId: string, overlayId: string, environment = apiEnv()) {
  return handleApiRequest(await requestAs(ownerId, `https://chatwerk.test/api/overlays/${overlayId}`, {
    method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}",
  }), environment);
}

async function copyLook(ownerId: string, overlayId: string, slug: string, key = crypto.randomUUID(), environment = apiEnv()) {
  return handleApiRequest(await requestAs(ownerId, `https://chatwerk.test/api/looks/${slug}/copy`, {
    method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": key }, body: JSON.stringify({ overlayId }),
  }), environment);
}

async function undoLook(ownerId: string, overlayId: string, snapshotId: string, expectedRevision: number) {
  return handleApiRequest(await requestAs(ownerId, `https://chatwerk.test/api/overlays/${overlayId}/undo`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ snapshotId, expectedRevision }),
  }), apiEnv());
}

function interceptDeletes(db: D1Database, beforeDelete: () => Promise<void>): D1Database {
  return interceptStatements(db, /^\s*DELETE\s+FROM\s+overlays\b/iu, beforeDelete);
}

function interceptStatements(db: D1Database, pattern: RegExp, beforeExecution: () => Promise<void>): D1Database {
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement => new Proxy(statement, {
    get(target, property, receiver) {
      if (property === "bind") return (...values: unknown[]) => wrapStatement(target.bind(...values));
      const value: unknown = Reflect.get(target, property, receiver) as unknown;
      if ((property === "run" || property === "first") && typeof value === "function") {
        return async (...args: unknown[]) => {
          await beforeExecution();
          return Reflect.apply(value, target, args) as unknown;
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === "prepare") return (sql: string) => {
        const statement = target.prepare(sql);
        return pattern.test(sql) ? wrapStatement(statement) : statement;
      };
      const value: unknown = Reflect.get(target, property, receiver) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function interceptObject(id: string, method: string, replacement: (...args: unknown[]) => Promise<unknown>): DurableObjectNamespace {
  const realStub = env.OVERLAY.get(env.OVERLAY.idFromName(id));
  return {
    idFromName: (name: string) => env.OVERLAY.idFromName(name),
    get: () => new Proxy(realStub, {
      get(target, property, receiver) {
        if (property === method) return replacement;
        const value: unknown = Reflect.get(target, property, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }),
  } as unknown as DurableObjectNamespace;
}

describe("look gallery API", () => {
  it("publishes only shareable theme values to D1 and public API responses", async () => {
    const source = await seedOverlay(env.DB);
    const stub = env.OVERLAY.get(env.OVERLAY.idFromName(source.overlayId)) as unknown as {
      save(patch: Record<string, unknown>, baseRevision: number, generation: number): Promise<unknown>;
    };
    await stub.save({
      fontSize: 24,
      customCss: ".chat { background: url(https://bad.test) }",
      customCssEnabled: true,
      channels: ["first", "second", "third"],
      hideNumbers: true,
      filterWords: ["spoiler"],
      filterPrefixes: ["!private"],
      hideBots: true,
      botNames: ["mybot"],
      sharedChatLabel: "avatar-pill",
      sharedChatPrefix: "from",
    } as never, 0, 1);

    const response = await publish(source.ownerId, source.overlayId, "Night Ledger");
    const published = await response?.json() as { id: string; slug: string; values: Record<string, unknown> };
    const [listedResponse, fetched] = await Promise.all([
      handleApiRequest(await requestAs(source.ownerId, "https://chatwerk.test/api/looks"), apiEnv()),
      lookBySlug(published.slug),
    ]);
    const listed = await listedResponse?.json() as { looks: Array<{ id: string; values: Record<string, unknown> }> };
    const result = await fetched?.json() as { values: Record<string, unknown> };
    const stored = await env.DB.prepare("SELECT values_json FROM themes WHERE id = ?")
      .bind(published.id).first<{ values_json: string }>();
    const storedValues = JSON.parse(stored!.values_json) as Record<string, unknown>;
    const listedValues = listed.looks.find((look) => look.id === published.id)!.values;
    const privateKeys = ["channels", "hideNumbers", "filterWords", "filterPrefixes", "hideBots", "showSharedChat", "botNames"];

    expect(response?.status).toBe(201);
    for (const values of [storedValues, published.values, listedValues, result.values]) {
      expect(values).toMatchObject({ fontSize: 24 });
      expect(values).toMatchObject({ sharedChatLabel: "avatar-pill", sharedChatPrefix: "from" });
      expect(values).not.toHaveProperty("customCss");
      expect(values).not.toHaveProperty("customCssEnabled");
      for (const key of privateKeys) expect(values).not.toHaveProperty(key);
    }
  });

  it("strips private fields from old rows on both public look routes", async () => {
    const owner = await seedOverlay(env.DB);
    const id = crypto.randomUUID();
    const values = JSON.stringify({
      fontSize: 29,
      channels: ["one", "two", "three"],
      hideNumbers: true,
      filterWords: ["spoiler"],
      filterPrefixes: ["!private"],
      hideBots: true,
      botNames: ["mybot"],
      sharedChatLabel: "pill",
      sharedChatPrefix: "via",
    });
    await env.DB.prepare("INSERT INTO themes(id, owner_id, slug, name, name_key, values_json) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, owner.ownerId, "old-private-look", "Old private look", "old private look", values).run();

    const [listResponse, publicResponse] = await Promise.all([
      handleApiRequest(await requestAs(owner.ownerId, "https://chatwerk.test/api/looks"), apiEnv()),
      lookBySlug("old-private-look"),
    ]);
    const list = await listResponse?.json() as { looks: Array<{ id: string; values: Record<string, unknown> }> };
    const publicLook = await publicResponse?.json() as { values: Record<string, unknown> };
    const privateKeys = ["channels", "hideNumbers", "filterWords", "filterPrefixes", "hideBots", "showSharedChat", "botNames"];
    const listed = list.looks.find((look) => look.id === id)!.values;

    expect(listResponse?.status).toBe(200);
    expect(publicResponse?.status).toBe(200);
    for (const result of [listed, publicLook.values]) {
      expect(result).toMatchObject({ fontSize: 29 });
      expect(result).toMatchObject({ sharedChatLabel: "pill", sharedChatPrefix: "via" });
      for (const key of privateKeys) expect(result).not.toHaveProperty(key);
    }
  });

  it("rejects a second active look with the same normalized name", async () => {
    const source = await seedOverlay(env.DB);
    const first = await publish(source.ownerId, source.overlayId, "Night Ledger");
    const crossOrigin = await handleApiRequest(await requestAs(source.ownerId, "https://chatwerk.test/api/looks", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.test" },
      body: JSON.stringify({ overlayId: source.overlayId, name: "Cross Origin" }),
    }), apiEnv());
    const duplicate = await publish(source.ownerId, source.overlayId, "  night ledger  ");

    expect(first?.status).toBe(201);
    expect(crossOrigin?.status).toBe(403);
    expect(duplicate?.status).toBe(409);
    await expect(duplicate?.json()).resolves.toMatchObject({ error: "duplicate-name" });
  });

  it("enforces the ten active looks per account limit on the server", async () => {
    const source = await seedOverlay(env.DB);
    for (let index = 0; index < 10; index += 1) {
      expect((await publish(source.ownerId, source.overlayId, `Look ${index + 1}`))?.status).toBe(201);
    }
    const capped = await publish(source.ownerId, source.overlayId, "Look 11");

    expect(capped?.status).toBe(409);
    await expect(capped?.json()).resolves.toMatchObject({ error: "look-limit", limit: 10 });
  });

  it("keeps public slugs unique when different owners use the same name", async () => {
    const firstOwner = await seedOverlay(env.DB);
    const secondOwner = await seedOverlay(env.DB);
    const first = await publish(firstOwner.ownerId, firstOwner.overlayId, "Slate");
    const second = await publish(secondOwner.ownerId, secondOwner.overlayId, "Slate");
    const firstBody = await first?.json() as { slug: string };
    const secondBody = await second?.json() as { slug: string };

    expect(first?.status).toBe(201);
    expect(second?.status).toBe(201);
    expect(firstBody.slug).not.toBe(secondBody.slug);
    expect((await lookBySlug(firstBody.slug))?.status).toBe(200);
    expect((await lookBySlug(secondBody.slug))?.status).toBe(200);
  });

  it("requires a session to list looks", async () => {
    const response = await handleApiRequest(new Request("https://chatwerk.test/api/looks"), apiEnv());
    expect(response?.status).toBe(401);
  });

  it.each(["/api/looks", "/api/looks/mine"])("skips corrupt look rows in %s while keeping valid looks", async (path) => {
    const source = await seedOverlay(env.DB);
    const validResponse = await publish(source.ownerId, source.overlayId, "Valid look");
    const valid = await validResponse?.json() as { id: string };
    const badIds: string[] = [];
    for (const [index, values] of ["{invalid", JSON.stringify({ fontSize: "invalid" })].entries()) {
      const id = crypto.randomUUID();
      badIds.push(id);
      await env.DB.prepare("INSERT INTO themes(id, owner_id, slug, name, name_key, values_json) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(id, source.ownerId, `broken-${id}`, `Broken ${index}`, `broken ${index}`, values).run();
    }

    const response = await handleApiRequest(await requestAs(source.ownerId, `https://chatwerk.test${path}`), apiEnv());
    const body = await response?.json() as { looks: Array<{ id: string }> };

    expect(response?.status).toBe(200);
    expect(body.looks.some((look) => look.id === valid.id)).toBe(true);
    expect(body.looks.some((look) => badIds.includes(look.id))).toBe(false);
  });

  it("forbids copying a look onto another account's overlay", async () => {
    const owner = await seedOverlay(env.DB);
    const foreign = await seedOverlay(env.DB);
    const look = await publish(owner.ownerId, owner.overlayId, "Slate");
    const { slug } = await look?.json() as { slug: string };
    const crossOrigin = await handleApiRequest(await requestAs(owner.ownerId, `https://chatwerk.test/api/looks/${slug}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://attacker.test" },
      body: JSON.stringify({ overlayId: owner.overlayId }),
    }), apiEnv());
    const response = await handleApiRequest(await requestAs(owner.ownerId, `https://chatwerk.test/api/looks/${slug}/copy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overlayId: foreign.overlayId }),
    }), apiEnv());

    expect(crossOrigin?.status).toBe(403);
    expect(response?.status).toBe(404);
  });

  it("copies only shareable values and undo restores every private target value", async () => {
    const owner = await seedOverlay(env.DB);
    const source = await seedOverlay(env.DB, { ownerId: owner.ownerId, name: "Source" });
    const target = await seedOverlay(env.DB, { ownerId: owner.ownerId, name: "Target", channel: "keep_me" });
    const sourceStub = env.OVERLAY.get(env.OVERLAY.idFromName(source.overlayId)) as unknown as {
      save(patch: Record<string, unknown>, baseRevision: number, generation: number): Promise<unknown>;
    };
    await sourceStub.save({
      fontSize: 20,
      channels: ["source_one", "source_two", "source_three"],
      filterWords: ["source-spoiler"],
      filterPrefixes: ["!source"],
      hideNumbers: true,
      hideBots: true,
      botNames: ["sourcebot"],
    }, 0, 1);
    const targetStub = overlayObject(target.overlayId);
    const original = {
      fontSize: 22,
      channels: ["keep_me", "target_two", "target_three"],
      filterWords: ["target-spoiler"],
      filterPrefixes: ["!target"],
      hideNumbers: true,
      hideBots: true,
      botNames: ["targetbot"],
      customCss: ".chat { color: red }",
      customCssEnabled: true,
    };
    await targetStub.save(original, 0, 1);
    const lookResponse = await publish(source.ownerId, source.overlayId, "Slate");
    const { slug } = await lookResponse?.json() as { slug: string };
    const copy = await copyLook(owner.ownerId, target.overlayId, slug);
    const copied = await copy?.json() as { revision: number; snapshotId: string };
    const copiedSnapshot = await targetStub.get(1);
    const undo = await undoLook(owner.ownerId, target.overlayId, copied.snapshotId, copied.revision);
    const snapshot = await targetStub.get(1);

    expect(copy?.status).toBe(200);
    expect(copied.snapshotId).toBeTruthy();
    expect(copiedSnapshot.config).toMatchObject({
      fontSize: 20,
      channels: original.channels,
      filterWords: original.filterWords,
      filterPrefixes: original.filterPrefixes,
      hideNumbers: original.hideNumbers,
      hideBots: original.hideBots,
      botNames: original.botNames,
      customCss: original.customCss,
      customCssEnabled: false,
    });
    expect(undo?.status).toBe(200);
    expect(snapshot.config).toMatchObject(original);
  });

  it("disables existing custom CSS on copy when the enabled flag was absent", async () => {
    const source = await seedOverlay(env.DB);
    const published = await publish(source.ownerId, source.overlayId, "CSS-safe look");
    const { slug } = await published?.json() as { slug: string };
    const target = await seedOverlay(env.DB);
    const stub = overlayObject(target.overlayId);
    await stub.save({ customCss: ".chat { color: red }" }, 0, 1);

    const response = await copyLook(target.ownerId, target.overlayId, slug);

    expect(response?.status).toBe(200);
    expect((await stub.get(1)).config).toMatchObject({ customCss: ".chat { color: red }", customCssEnabled: false });
  });

  it("refuses a late undo without deleting a newer valid snapshot", async () => {
    const source = await seedOverlay(env.DB);
    const firstLook = await publish(source.ownerId, source.overlayId, "Look A");
    const firstSlug = (await firstLook?.json() as { slug: string }).slug;
    await overlayObject(source.overlayId).save({ fontSize: 24 }, 0, 1);
    const secondLook = await publish(source.ownerId, source.overlayId, "Look B");
    const secondSlug = (await secondLook?.json() as { slug: string }).slug;
    const target = await seedOverlay(env.DB);
    const firstCopy = await copyLook(target.ownerId, target.overlayId, firstSlug);
    const first = await firstCopy?.json() as { revision: number; snapshotId: string };
    const secondCopy = await copyLook(target.ownerId, target.overlayId, secondSlug);
    const second = await secondCopy?.json() as { revision: number; snapshotId: string };

    const staleUndo = await undoLook(target.ownerId, target.overlayId, first.snapshotId, first.revision);
    expect(staleUndo?.status).toBe(409);
    await expect(staleUndo?.json()).resolves.toEqual({ error: "revision-conflict", revision: second.revision });
    const stillPresent = await runInDurableObject(overlayObject(target.overlayId) as never, (_instance, state) =>
      state.storage.sql.exec("SELECT snapshot_id FROM overlay_undo_snapshots").toArray());
    expect(stillPresent).toContainEqual({ snapshot_id: second.snapshotId });

    const validUndo = await undoLook(target.ownerId, target.overlayId, second.snapshotId, second.revision);
    expect(validUndo?.status).toBe(200);
    expect((await overlayObject(target.overlayId).get(1)).config.fontSize).toBe(18);
  });

  it("ties each undo snapshot to the revision that applied its look", async () => {
    const source = await seedOverlay(env.DB);
    const published = await publish(source.ownerId, source.overlayId, "Revision-bound look");
    const { slug } = await published?.json() as { slug: string };
    const target = await seedOverlay(env.DB);
    await overlayObject(target.overlayId).save({ fontSize: 30 }, 0, 1);
    const firstResponse = await copyLook(target.ownerId, target.overlayId, slug);
    const first = await firstResponse?.json() as { revision: number; snapshotId: string };
    const secondResponse = await copyLook(target.ownerId, target.overlayId, slug);
    const second = await secondResponse?.json() as { revision: number; snapshotId: string };

    const mismatched = await undoLook(target.ownerId, target.overlayId, first.snapshotId, second.revision);

    expect(mismatched?.status).toBe(409);
    await expect(mismatched?.json()).resolves.toEqual({ error: "revision-conflict", revision: second.revision });
    const currentUndo = await undoLook(target.ownerId, target.overlayId, second.snapshotId, second.revision);
    expect(currentUndo?.status).toBe(200);
  });

  it("replays a committed copy after a lost reply so undo retains the original config", async () => {
    const source = await seedOverlay(env.DB);
    const published = await publish(source.ownerId, source.overlayId, "Retry-safe look");
    const { slug } = await published?.json() as { slug: string };
    const target = await seedOverlay(env.DB);
    const stub = overlayObject(target.overlayId);
    await stub.save({ fontSize: 30 }, 0, 1);
    let committed: { revision: number; snapshotId: string; undoExpiresAt: number } | undefined;
    let loseReply = true;
    const namespace = interceptObject(target.overlayId, "applyLook", async (...args) => {
      const result = await Reflect.apply(stub.applyLook, stub, args) as Awaited<ReturnType<OverlayObject["applyLook"]>>;
      committed ??= result;
      if (loseReply) {
        loseReply = false;
        throw new Error("Injected lost reply after commit");
      }
      return result;
    });
    const key = crypto.randomUUID();
    const first = await copyLook(target.ownerId, target.overlayId, slug, key, { ...apiEnv(), OVERLAY: namespace });
    const retry = await copyLook(target.ownerId, target.overlayId, slug, key, { ...apiEnv(), OVERLAY: namespace });
    const replay = await retry?.json() as { revision: number; snapshotId: string; undoExpiresAt: number };

    expect(first?.status).toBe(500);
    expect(retry?.status).toBe(200);
    expect(replay).toEqual({ revision: committed?.revision, snapshotId: committed?.snapshotId, undoExpiresAt: committed?.undoExpiresAt });
    expect((await stub.get(1)).revision).toBe(committed?.revision);
    const restored = await undoLook(target.ownerId, target.overlayId, replay.snapshotId, replay.revision);
    expect(restored?.status).toBe(200);
    expect((await stub.get(1)).config.fontSize).toBe(30);
  });

  it("enforces overlay limits and forbids deleting the last overlay", async () => {
    const first = await seedOverlay(env.DB);
    const create = async (name: string) => handleApiRequest(await requestAs(first.ownerId, "https://chatwerk.test/api/overlays", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
    }), apiEnv());
    const second = await create("Stream");
    const third = await create("Vertical");
    const capped = await create("Fourth");
    const secondBody = await second?.json() as { id: string };
    const rename = await handleApiRequest(await requestAs(first.ownerId, `https://chatwerk.test/api/overlays/${secondBody.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Just Chatting" }),
    }), apiEnv());
    const crossOriginDelete = await handleApiRequest(await requestAs(first.ownerId, `https://chatwerk.test/api/overlays/${secondBody.id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json", Origin: "https://attacker.test" }, body: "{}",
    }), apiEnv());
    const deleteSecond = await handleApiRequest(await requestAs(first.ownerId, `https://chatwerk.test/api/overlays/${secondBody.id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}",
    }), apiEnv());
    const thirdBody = await third?.json() as { id: string };
    const deleteThird = await handleApiRequest(await requestAs(first.ownerId, `https://chatwerk.test/api/overlays/${thirdBody.id}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}",
    }), apiEnv());
    const deleteLast = await handleApiRequest(await requestAs(first.ownerId, `https://chatwerk.test/api/overlays/${first.overlayId}`, {
      method: "DELETE", headers: { "Content-Type": "application/json" }, body: "{}",
    }), apiEnv());

    expect(second?.status).toBe(201);
    expect(third?.status).toBe(201);
    expect(capped?.status).toBe(409);
    expect(rename?.status).toBe(200);
    expect(crossOriginDelete?.status).toBe(403);
    expect(deleteSecond?.status).toBe(204);
    expect(deleteThird?.status).toBe(204);
    expect(deleteLast?.status).toBe(409);
  });

  it("atomically permits only one concurrent rename to the same normalized overlay name", async () => {
    const first = await seedOverlay(env.DB);
    const second = await seedOverlay(env.DB, { ownerId: first.ownerId, name: "Second" });
    let arrivals = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => { release = resolve; });
    const gatedDB = interceptStatements(env.DB, /^\s*UPDATE\s+overlays\s+SET\s+name\b/iu, async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothReady;
    });
    const rename = async (id: string, name: string) => handleApiRequest(await requestAs(first.ownerId,
      `https://chatwerk.test/api/overlays/${id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      }), { ...apiEnv(), DB: gatedDB });

    const responses = await Promise.all([rename(first.overlayId, "Shared"), rename(second.overlayId, "sHARED")]);

    expect(responses.map((response) => response?.status).sort()).toEqual([200, 409]);
    await expect(responses.find((response) => response?.status === 409)?.json()).resolves.toEqual({ error: "overlay-name" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM overlays WHERE owner_id = ? AND lower(name) = 'shared'")
      .bind(first.ownerId).first("count")).toBe(1);
  });

  it("refuses a rename when a concurrent create claims the same normalized overlay name", async () => {
    const first = await seedOverlay(env.DB);
    let reachedUpdate!: () => void;
    let releaseUpdate!: () => void;
    const updateReady = new Promise<void>((resolve) => { reachedUpdate = resolve; });
    const updateReleased = new Promise<void>((resolve) => { releaseUpdate = resolve; });
    const pausedDB = interceptStatements(env.DB, /^\s*UPDATE\s+overlays\s+SET\s+name\b/iu, async () => {
      reachedUpdate();
      await updateReleased;
    });
    const pendingRename = handleApiRequest(await requestAs(first.ownerId,
      `https://chatwerk.test/api/overlays/${first.overlayId}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Shared" }),
      }), { ...apiEnv(), DB: pausedDB });
    await updateReady;
    let created: Response | null;
    try {
      created = await handleApiRequest(await requestAs(first.ownerId, "https://chatwerk.test/api/overlays", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "sHARED" }),
      }), apiEnv());
    } finally {
      releaseUpdate();
    }
    const renamed = await pendingRename;

    expect(created?.status).toBe(201);
    expect(renamed?.status).toBe(409);
    await expect(renamed?.json()).resolves.toEqual({ error: "overlay-name" });
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM overlays WHERE owner_id = ? AND lower(name) = 'shared'")
      .bind(first.ownerId).first("count")).toBe(1);
  });

  it("keeps Durable Object config when the D1 delete fails", async () => {
    const first = await seedOverlay(env.DB);
    const target = await seedOverlay(env.DB, { ownerId: first.ownerId, name: "Keep state" });
    const stub = overlayObject(target.overlayId);
    await stub.save({ fontSize: 31, customCss: ".chat { color: red }" }, 0, 1);
    const failingDB = interceptDeletes(env.DB, async () => { throw new Error("Injected D1 delete failure"); });

    const response = await removeOverlay(first.ownerId, target.overlayId, { ...apiEnv(), DB: failingDB });

    expect(response?.status).toBe(500);
    expect(await stub.get(1)).toMatchObject({ revision: 1, config: { fontSize: 31, customCss: ".chat { color: red }" } });
    expect(await env.DB.prepare("SELECT id FROM overlays WHERE id = ?").bind(target.overlayId).first()).not.toBeNull();
  });

  it("atomically permits only one of two parallel deletes when two overlays remain", async () => {
    const first = await seedOverlay(env.DB);
    const second = await seedOverlay(env.DB, { ownerId: first.ownerId, name: "Second" });
    let arrivals = 0;
    let release!: () => void;
    const bothReady = new Promise<void>((resolve) => { release = resolve; });
    const gatedDB = interceptDeletes(env.DB, async () => {
      arrivals += 1;
      if (arrivals === 2) release();
      await bothReady;
    });
    const environment = { ...apiEnv(), DB: gatedDB };

    const responses = await Promise.all([
      removeOverlay(first.ownerId, first.overlayId, environment),
      removeOverlay(first.ownerId, second.overlayId, environment),
    ]);

    expect(responses.map((response) => response?.status).sort()).toEqual([204, 409]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS count FROM overlays WHERE owner_id = ?").bind(first.ownerId).first("count")).toBe(1);
  });

  it("returns 204 and logs failed DO cleanup after committing the D1 delete", async () => {
    const first = await seedOverlay(env.DB);
    const target = await seedOverlay(env.DB, { ownerId: first.ownerId, name: "Orphaned state" });
    await overlayObject(target.overlayId).save({ fontSize: 31 }, 0, 1);
    const failingNamespace = interceptObject(target.overlayId, "resetForDelete", async () => { throw new Error("Injected DO failure"); });
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await removeOverlay(first.ownerId, target.overlayId, { ...apiEnv(), OVERLAY: failingNamespace });

      expect(response?.status).toBe(204);
      expect(await env.DB.prepare("SELECT id FROM overlays WHERE id = ?").bind(target.overlayId).first()).toBeNull();
      expect(log).toHaveBeenCalled();
      expect((await overlayObject(target.overlayId).get(1)).config.fontSize).toBe(31);
    } finally {
      log.mockRestore();
    }
  });

  it("clears deleted object data, closes its live socket with 4001, and rejects later RPCs", async () => {
    const first = await seedOverlay(env.DB);
    const target = await seedOverlay(env.DB, { ownerId: first.ownerId, name: "Deleted state" });
    const stub = overlayObject(target.overlayId);
    await stub.save({ fontSize: 31 }, 0, 1);
    const upgrade = await stub.fetch(new Request("https://overlay.internal/live", {
      headers: { Upgrade: "websocket", "x-link-generation": "1" },
    }));
    const socket = upgrade.webSocket;
    if (!socket) throw new Error(`Socket upgrade failed: ${upgrade.status}`);
    socket.accept();
    let closeCode: number | undefined;
    socket.addEventListener("close", (event) => { closeCode = event.code; }, { once: true });

    const response = await removeOverlay(first.ownerId, target.overlayId);

    expect(response?.status).toBe(204);
    await vi.waitFor(() => expect(closeCode).toBe(4001), { timeout: 1_000 });
    const rows = await runInDurableObject(stub as never, (_instance, state) => ({
      config: state.storage.sql.exec("SELECT * FROM overlay_config").toArray(),
      generations: state.storage.sql.exec("SELECT * FROM overlay_link_state").toArray(),
      snapshots: state.storage.sql.exec("SELECT * FROM overlay_undo_snapshots").toArray(),
    }));
    expect(rows).toEqual({ config: [], generations: [], snapshots: [] });
    const requests = [
      stub.get(1), stub.save({ fontSize: 32 }, 0, 1), stub.applyLook({ fontSize: 24 }, crypto.randomUUID(), 1),
      stub.undoLook(crypto.randomUUID(), 1, 1), stub.testLine(1), stub.revoke(2), stub.resetForDelete(),
    ];
    const results = await Promise.allSettled(requests);
    for (const result of results) {
      expect(result).toMatchObject({ status: "rejected", reason: expect.objectContaining({ message: expect.stringContaining("deleted") }) });
    }
  });

  it("rejects a socket upgrade whose token lookup already passed before deletion", async () => {
    const first = await seedOverlay(env.DB);
    const target = await seedOverlay(env.DB, { ownerId: first.ownerId, name: "Late socket" });
    const stub = overlayObject(target.overlayId);
    await stub.get(1);
    // Retaining the stub and generation simulates the lookup completed by an in-flight request.
    expect((await removeOverlay(first.ownerId, target.overlayId))?.status).toBe(204);

    const response = await stub.fetch(new Request("https://overlay.internal/live", {
      headers: { Upgrade: "websocket", "x-link-generation": "1" },
    }));
    response.webSocket?.accept();
    response.webSocket?.close();

    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toMatchObject({ error: "overlay-deleted" });
  });

  it("withdraws a parent look but keeps child lineage marked as removed", async () => {
    const owner = await seedOverlay(env.DB);
    const parentResponse = await publish(owner.ownerId, owner.overlayId, "First look");
    const parent = await parentResponse?.json() as { id: string; slug: string };
    const copy = await handleApiRequest(await requestAs(owner.ownerId, `https://chatwerk.test/api/looks/${parent.slug}/copy`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overlayId: owner.overlayId }),
    }), apiEnv());
    expect(copy?.status).toBe(200);
    const childResponse = await publish(owner.ownerId, owner.overlayId, "Second look");
    const child = await childResponse?.json() as { slug: string };
    const withdraw = await handleApiRequest(await requestAs(owner.ownerId, `https://chatwerk.test/api/looks/${parent.slug}/withdraw`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: "{}",
    }), apiEnv());
    const publicParent = await lookBySlug(parent.slug);
    const publicChild = await lookBySlug(child.slug);
    const childBody = await publicChild?.json() as { parent: { removed: boolean } };

    expect(withdraw?.status).toBe(204);
    expect(publicParent?.status).toBe(404);
    expect(childBody.parent.removed).toBe(true);
  });
});
