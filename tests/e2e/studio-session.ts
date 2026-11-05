import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import type { Page } from "@playwright/test";
import { mintSessionCookie } from "../worker/worker-test-helpers";
import { TEST_SESSION_KEY } from "./test-session";

export const e2ePort = Number(process.env.PLAYWRIGHT_PORT ?? 17474);
export const e2eOrigin = `http://127.0.0.1:${e2ePort}`;

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
    httpOnly: true, secure: false, sameSite: "Lax",
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

export async function setRange(page: Page, field: string, value: number): Promise<void> {
  await page.locator(`#theme-${field}`).evaluate((element, nextValue) => {
    const input = element as HTMLInputElement;
    input.value = String(nextValue);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }, value);
}
