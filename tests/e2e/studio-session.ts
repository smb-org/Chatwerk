import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { expect } from "@playwright/test";
import type { Page } from "@playwright/test";
import type { ThemeConfig } from "../../src/shared/theme";
import { mintSessionCookie } from "../worker/worker-test-helpers";
import { TEST_SESSION_KEY } from "./test-session";

export const e2ePort = Number(process.env.PLAYWRIGHT_PORT ?? 17574);
export const e2eOrigin = `https://127.0.0.1:${e2ePort}`;
let localMigrationsApplied = false;

export interface StudioIdentity {
  ownerId: string;
  overlayId: string;
  token: string;
  login: string;
}

export async function expectActiveOverlay(page: Page, name: string): Promise<void> {
  await expect.poll(() => page.locator("#active-overlay-name").evaluate((root) => {
    const text = root.querySelector("#active-overlay-text")?.textContent ?? "";
    const select = root.querySelector("#active-overlay-select") as HTMLSelectElement | null;
    return select && !select.hidden ? `${text}${select.selectedOptions[0]?.textContent ?? ""}` : text;
  })).toBe(`Active overlay: ${name}`);
}

export async function seedStudioSession(page: Page, options: { channel?: string } = {}): Promise<StudioIdentity> {
  const ownerId = `owner-${randomBytes(8).toString("hex")}`;
  const login = `e2e_${randomBytes(4).toString("hex")}`;
  const overlayId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const channel = options.channel ?? login;
  const sql = `INSERT INTO users (id, login) VALUES ('${ownerId}', '${login}'); INSERT INTO overlays (id, owner_id, link_token, name, channel, link_generation) VALUES ('${overlayId}', '${ownerId}', '${token}', 'Main', '${channel}', 1);`;
  executeLocalSql(sql);
  const cookie = await mintSessionCookie(TEST_SESSION_KEY, ownerId);
  await page.context().addCookies([{
    name: "session", value: cookie.slice("session=".length), url: e2eOrigin,
    httpOnly: true, secure: true, sameSite: "Lax",
  }]);
  return { ownerId, overlayId, token, login };
}

export function addStudioOverlay(ownerId: string, name: string, channel: string): { overlayId: string; token: string } {
  const overlayId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const sql = `INSERT INTO overlays (id, owner_id, link_token, name, channel, link_generation) VALUES ('${overlayId}', '${ownerId}', '${token}', '${name}', '${channel}', 1);`;
  executeLocalSql(sql);
  return { overlayId, token };
}

export function addStudioEditor(overlayId: string): { userId: string; login: string } {
  const userId = `editor-${randomBytes(8).toString("hex")}`;
  const login = `editor_${randomBytes(4).toString("hex")}`;
  executeLocalSql(`INSERT INTO users (id, login) VALUES ('${userId}', '${login}'); INSERT INTO overlay_editors (overlay_id, user_id) VALUES ('${overlayId}', '${userId}');`);
  return { userId, login };
}

export function addStudioSharedOverlay(editorId: string, name: string, channel = "shared_room"): {
  overlayId: string;
  token: string;
  ownerLogin: string;
} {
  const ownerId = `shared-${randomBytes(8).toString("hex")}`;
  const ownerLogin = `shared_owner_${randomBytes(4).toString("hex")}`;
  const overlayId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const sql = `INSERT INTO users (id, login) VALUES ('${ownerId}', '${ownerLogin}'); INSERT INTO overlays (id, owner_id, link_token, name, channel, link_generation) VALUES ('${overlayId}', '${ownerId}', '${token}', '${name.replaceAll("'", "''")}', '${channel.replaceAll("'", "''")}', 1); INSERT INTO overlay_editors (overlay_id, user_id) VALUES ('${overlayId}', '${editorId}');`;
  executeLocalSql(sql);
  return { overlayId, token, ownerLogin };
}

export function addStudioLook(ownerId: string, name: string, values: ThemeConfig, parentThemeId: string | null = null): { id: string; slug: string } {
  const id = randomUUID();
  const base = name.normalize("NFKD").replace(/[^a-zA-Z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").toLowerCase().slice(0, 40) || "look";
  const slug = `${base}-${randomUUID().slice(0, 8)}`;
  const escapeSql = (value: string) => value.replaceAll("'", "''");
  const sql = `INSERT INTO themes (id, owner_id, slug, name, name_key, values_json, parent_theme_id) VALUES ('${id}', '${escapeSql(ownerId)}', '${slug}', '${escapeSql(name)}', '${escapeSql(name.trim().toLowerCase())}', '${escapeSql(JSON.stringify(values))}', ${parentThemeId ? `'${escapeSql(parentThemeId)}'` : "NULL"});`;
  executeLocalSql(sql);
  return { id, slug };
}

export function seedStudioLooks(ownerId: string, count: number, values: ThemeConfig): string[] {
  const slugs: string[] = [];
  const escapeSql = (value: string) => value.replaceAll("'", "''");
  const statements: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const name = `Look ${String(index + 1).padStart(3, "0")}`;
    const id = randomUUID();
    const slug = `layout-${index + 1}-${randomUUID().slice(0, 8)}`;
    slugs.push(slug);
    statements.push(`INSERT INTO themes (id, owner_id, slug, name, name_key, values_json) VALUES ('${id}', '${escapeSql(ownerId)}', '${slug}', '${name}', '${name.toLowerCase()}', '${escapeSql(JSON.stringify(values))}');`);
  }
  executeLocalSql(statements.join(" "));
  return slugs;
}

export function clearStudioLooks(): void {
  executeLocalSql("DELETE FROM themes;");
}

function executeLocalSql(sql: string): void {
  const localEnv = localWranglerEnvironment();
  if (!localMigrationsApplied) {
    execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "chatwerk", "--local"], {
      cwd: process.cwd(), env: localEnv, stdio: "pipe",
    });
    localMigrationsApplied = true;
  }
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "chatwerk", "--local", "--command", sql], {
    cwd: process.cwd(), env: localEnv, stdio: "pipe",
  });
}

function localWranglerEnvironment(): NodeJS.ProcessEnv {
  const registry = path.resolve(".wrangler/registry");
  return {
    ...process.env,
    WRANGLER_LOG_PATH: path.resolve(".wrangler/logs/e2e-seed.log"),
    WRANGLER_REGISTRY_PATH: registry,
    MINIFLARE_REGISTRY_PATH: registry,
  };
}

export async function setRange(page: Page, field: string, value: number): Promise<void> {
  await page.locator(`#theme-${field}`).evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
