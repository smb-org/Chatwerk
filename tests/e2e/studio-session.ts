import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import type { ThemeConfig } from "../../src/shared/theme";
import { mintSessionCookie } from "../worker/worker-test-helpers";
import { TEST_SESSION_KEY } from "./test-session";

export const e2ePort = Number(process.env.PLAYWRIGHT_PORT ?? 17574);
export const e2eOrigin = `https://127.0.0.1:${e2ePort}`;

export interface StudioIdentity {
  ownerId: string;
  overlayId: string;
  token: string;
  login: string;
}

export async function seedStudioSession(page: Page): Promise<StudioIdentity> {
  const ownerId = `owner-${randomBytes(8).toString("hex")}`;
  const login = `e2e_${randomBytes(4).toString("hex")}`;
  const overlayId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  const sql = `INSERT INTO users (id, login) VALUES ('${ownerId}', '${login}'); INSERT INTO overlays (id, owner_id, link_token, name, channel, link_generation) VALUES ('${overlayId}', '${ownerId}', '${token}', 'Main', '${login}', 1);`;
  const registry = path.resolve(".wrangler/registry");
  const localEnv = {
    ...process.env,
    WRANGLER_LOG_PATH: path.resolve(".wrangler/logs/e2e-seed.log"),
    WRANGLER_REGISTRY_PATH: registry,
    MINIFLARE_REGISTRY_PATH: registry,
  };
  execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "chatwerk", "--local"], {
    cwd: process.cwd(), env: localEnv, stdio: "pipe",
  });
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "chatwerk", "--local", "--command", sql], {
    cwd: process.cwd(), env: localEnv, stdio: "pipe",
  });
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
  const registry = path.resolve(".wrangler/registry");
  const localEnv = {
    ...process.env,
    WRANGLER_LOG_PATH: path.resolve(".wrangler/logs/e2e-seed.log"),
    WRANGLER_REGISTRY_PATH: registry,
    MINIFLARE_REGISTRY_PATH: registry,
  };
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "chatwerk", "--local", "--command", sql], {
    cwd: process.cwd(), env: localEnv, stdio: "pipe",
  });
  return { overlayId, token };
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
  const registry = path.resolve(".wrangler/registry");
  const localEnv = {
    ...process.env,
    WRANGLER_LOG_PATH: path.resolve(".wrangler/logs/e2e-seed.log"),
    WRANGLER_REGISTRY_PATH: registry,
    MINIFLARE_REGISTRY_PATH: registry,
  };
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "chatwerk", "--local", "--command", sql], {
    cwd: process.cwd(), env: localEnv, stdio: "pipe",
  });
}

export async function setRange(page: Page, field: string, value: number): Promise<void> {
  await page.locator(`#theme-${field}`).evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
