import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { expect, test } from "@playwright/test";
import { mintSessionCookie } from "../worker/worker-test-helpers";
import { TEST_SESSION_KEY } from "./test-session";
import { addStudioOverlay, e2eOrigin, seedStudioSession, setRange } from "./studio-session";

function executeLocalSql(sql: string): void {
  const registry = path.resolve(".wrangler/registry");
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "chatwerk", "--local", "--command", sql], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      WRANGLER_LOG_PATH: path.resolve(".wrangler/logs/e2e-seed.log"),
      WRANGLER_REGISTRY_PATH: registry,
      MINIFLARE_REGISTRY_PATH: registry,
    },
    stdio: "pipe",
  });
}

async function capture(page: import("@playwright/test").Page, name: string): Promise<void> {
  const directory = path.resolve(".tmp/shots");
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: path.join(directory, name), fullPage: true });
}

async function openOverlays(page: import("@playwright/test").Page): Promise<void> {
  await page.locator("#account-menu summary").click();
  await page.locator("#open-overlays").click();
}

async function expandHelpers(page: import("@playwright/test").Page): Promise<void> {
  const main = page.locator(".overlay-manager-item").filter({ has: page.locator(".manage-row-name", { hasText: /^Main$/u }) });
  const toggle = main.getByRole("button", { name: "Helpers" });
  if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
}

test("invites a helper through login, syncs edits, revokes access, and shows owner/helper Studio states", async ({ page, browser }) => {
  test.setTimeout(60_000);
  const owner = await seedStudioSession(page);
  const helperId = `helper-${randomBytes(8).toString("hex")}`;
  const helperLogin = `helper_${randomBytes(4).toString("hex")}`;
  executeLocalSql(`INSERT INTO users (id, login) VALUES ('${helperId}', '${helperLogin}');`);

  const liveSockets: string[] = [];
  page.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname === "/api/overlay/live") liveSockets.push(socket.url());
  });
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");

  await openOverlays(page);
  await expandHelpers(page);
  await page.getByRole("button", { name: "Create link" }).click();
  await expect(page.locator("#dialog-body")).toContainText("Invite link created.");
  const inviteInput = page.getByRole("textbox", { name: "Helper invite link" });
  await expect(inviteInput).toBeVisible();
  const inviteUrl = await inviteInput.inputValue();
  const inviteToken = new URL(inviteUrl).searchParams.get("invite");
  expect(inviteToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  await page.getByRole("button", { name: "Revoke" }).waitFor();
  await page.locator("#dialog-close").click();

  const helperContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const helperPage = await helperContext.newPage();
  const helperSockets: string[] = [];
  helperPage.on("websocket", (socket) => {
    if (new URL(socket.url()).pathname === "/api/overlay/live") helperSockets.push(socket.url());
  });
  await helperPage.goto(inviteUrl);
  await expect(helperPage).toHaveURL(/\/login\?/u);
  const loginNext = `/studio?invite=${inviteToken}`;
  expect(new URL(await helperPage.locator("#login-button").getAttribute("href") ?? "", helperPage.url()).searchParams.get("next")).toBe(loginNext);
  const cookie = await mintSessionCookie(TEST_SESSION_KEY, helperId);
  await helperContext.addCookies([{
    name: "session", value: cookie.slice("session=".length), url: e2eOrigin,
    httpOnly: true, secure: true, sameSite: "Lax",
  }]);
  await helperPage.goto(loginNext);
  await expect(helperPage.getByRole("heading", { name: "Shared overlay invitation" })).toBeVisible();
  await expect(helperPage.getByRole("button", { name: "Accept" })).toBeVisible();
  await capture(helperPage, "invite-accept.png");
  const acceptUrl = `${e2eOrigin}/api/invites/${inviteToken}/accept`;
  await helperPage.route(acceptUrl, (route) => route.fulfill({ status: 401, contentType: "application/json", body: JSON.stringify({ error: "Authentication required" }) }));
  await helperPage.getByRole("button", { name: "Accept" }).click();
  await expect(helperPage).toHaveURL(/\/login\?/u);
  expect(new URL(await helperPage.locator("#login-button").getAttribute("href") ?? "", helperPage.url()).searchParams.get("next")).toBe(loginNext);
  await helperPage.unroute(acceptUrl);
  await helperPage.goto(loginNext);
  await expect(helperPage.getByRole("button", { name: "Accept" })).toBeVisible();
  await helperPage.getByRole("button", { name: "Accept" }).click();
  await expect(helperPage).toHaveURL(`${e2eOrigin}/studio`);
  await expect(helperPage.locator("#status-visible")).toHaveText(`You are now editing Main by ${owner.login}.`);
  await expect(helperPage.locator("#active-overlay-text")).toContainText("Main");
  await expect.poll(() => helperSockets.length).toBe(1);

  const helperOwnOverlay = addStudioOverlay(helperId, "Main", helperLogin);
  await setRange(helperPage, "fontSize", 33);
  await expect.poll(async () => Number(await page.locator("#theme-fontSize").inputValue())).toBe(33);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  await expect.poll(() => liveSockets.length).toBe(1);

  let signalOwnerConfigResponse!: () => void;
  const ownerConfigResponse = new Promise<void>((resolve) => { signalOwnerConfigResponse = resolve; });
  await page.route(`${e2eOrigin}/api/overlays/${owner.overlayId}/config`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    const response = await route.fetch();
    signalOwnerConfigResponse();
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.fulfill({ response });
  });
  await setRange(page, "fontSize", 35);
  await ownerConfigResponse;
  await expect(helperPage.locator("#status-visible")).toHaveText("Saved, rev 2");
  await setRange(helperPage, "fontSize", 39);
  await expect(helperPage.locator("#status-visible")).toHaveText("Saved, rev 3");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 3");
  await expect.poll(async () => Number(await page.locator("#theme-fontSize").inputValue())).toBe(39);

  await openOverlays(page);
  await expandHelpers(page);
  await expect(page.getByText(helperLogin, { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Create link" }).click();
  const nextInviteInput = page.getByRole("textbox", { name: "Helper invite link" });
  await expect(nextInviteInput).toBeVisible();
  await capture(page, "overlays-owner.png");
  await page.locator("#dialog-close").click();
  addStudioOverlay(owner.ownerId, "Secondary", owner.login);
  await openOverlays(page);
  const secondaryRow = page.locator(".overlay-manager-item").filter({ has: page.locator(".manage-row-name", { hasText: /^Secondary$/u }) });
  const mainOverlayUrl = await page.locator("#overlay-url").inputValue();
  await page.once("dialog", (dialog) => dialog.accept());
  await secondaryRow.getByRole("button", { name: "New link" }).click();
  await expect(page.locator("#dialog-body")).toContainText("Overlay link regenerated. Update OBS with the new link.");
  await expect(page.locator("#overlay-url")).toHaveValue(mainOverlayUrl);

  await helperPage.setViewportSize({ width: 1440, height: 960 });
  await openOverlays(helperPage);
  await expect(helperPage.getByText(`Shared with you`, { exact: true })).toBeVisible();
  await expect(helperPage.locator(".manage-row-meta").filter({ hasText: owner.login })).toBeVisible();
  await capture(helperPage, "overlays-helper.png");
  await helperPage.locator("#dialog-close").click();
  await expect(helperPage.locator("#active-overlay-select option:checked")).toContainText(`by ${owner.login}`);

  await helperPage.setViewportSize({ width: 1024, height: 800 });
  await expect(helperPage.locator("#active-overlay-select")).toBeVisible();
  await expect.poll(() => helperPage.locator("#active-overlay-select").evaluate((node) => node.getBoundingClientRect().width))
    .toBeGreaterThanOrEqual(120);
  await expect(helperPage.locator("#obs-size-hint")).toHaveText("OBS: 400 x 600");
  await expect.poll(() => helperPage.locator("#obs-size-hint").evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
  await capture(helperPage, "header-helper-1024.png");
  await helperPage.setViewportSize({ width: 1440, height: 960 });
  await capture(helperPage, "header-helper-1440.png");

  await page.getByRole("button", { name: `Remove ${helperLogin}` }).click();
  const removedMessage = "Removed. They keep read access through the overlay link until you create a new one.";
  await expect(page.locator("#dialog-body")).toContainText(removedMessage);

  await openOverlays(helperPage);
  await expect(helperPage.locator("#dialog-body")).toContainText("No overlays shared with you yet.");
  await expect(helperPage.locator("#status-visible")).toHaveText("Access changed. You were moved to Main.");
  await expect(helperPage.locator("#active-overlay-text")).toHaveText("Active overlay: Main");
  await expect(helperPage.locator("#active-overlay-select")).toBeHidden();
  await helperPage.locator("#dialog-close").click();
  await expect(helperPage.locator("#active-overlay-text")).toHaveText("Active overlay: Main");
  await setRange(helperPage, "fontSize", 37);
  await expect(helperPage.locator("#status-visible")).toHaveText("Saved, rev 1");
  const helperOwnedConfig = await helperPage.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${helperOwnOverlay.token}` },
  });
  expect(await helperOwnedConfig.json()).toMatchObject({ revision: 1, config: { fontSize: 37 } });
  const readableBeforeRotation = await helperPage.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  expect(readableBeforeRotation.status()).toBe(200);
  await expect.poll(() => helperSockets.length).toBe(2);
  await helperPage.waitForTimeout(2_200);
  expect(helperSockets).toHaveLength(2);
  expect(await helperPage.locator("#active-overlay-select").isHidden()).toBe(true);

  let failedRefreshes = 0;
  await page.route(`${e2eOrigin}/api/overlays`, async (route) => {
    if (route.request().method() === "GET" && failedRefreshes === 0) {
      failedRefreshes += 1;
      await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporary" }) });
      return;
    }
    await route.continue();
  });
  await page.once("dialog", (dialog) => dialog.accept());
  await page.locator("#dialog-body .manage-status-line").getByRole("button", { name: "New link" }).click();
  await expect(page.locator("#dialog-body")).toContainText("Overlay link regenerated. Update OBS with the new link.");
  await expect.poll(() => liveSockets.length).toBe(2);
  await expect.poll(() => failedRefreshes).toBe(1);
  await page.unroute(`${e2eOrigin}/api/overlays`);
  const unreadableAfterRotation = await helperPage.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${owner.token}` },
  });
  expect(unreadableAfterRotation.status()).toBe(404);

  await page.locator("#dialog-close").click();
  const unknownToken = randomBytes(32).toString("base64url");
  await helperPage.goto(`/studio?invite=${unknownToken}`);
  await expect(helperPage.getByRole("heading", { name: "Shared overlay invitation" })).toBeVisible();
  await helperPage.getByRole("button", { name: "Accept" }).click();
  await expect(helperPage.locator("#dialog-body")).toContainText("Link expired or already used.");

  const inviteAgainResponse = await page.request.post(`${e2eOrigin}/api/overlays/${owner.overlayId}/invite`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" }, data: {},
  });
  expect(inviteAgainResponse.status()).toBe(200);
  const expiredInvite = await inviteAgainResponse.json() as { inviteUrl: string };
  const expiredToken = new URL(expiredInvite.inviteUrl).searchParams.get("invite")!;
  executeLocalSql(`UPDATE overlay_invites SET expires_at = ${Math.floor(Date.now() / 1000) - 1} WHERE overlay_id = '${owner.overlayId}';`);
  await helperPage.goto(`/studio?invite=${expiredToken}`);
  await helperPage.getByRole("button", { name: "Accept" }).click();
  await expect(helperPage.locator("#dialog-body")).toContainText("Link expired or already used.");
  expect(expiredToken).toMatch(/^[A-Za-z0-9_-]{43}$/u);

  await helperContext.close();
  expect(helperOwnOverlay.overlayId).toMatch(/^[0-9a-f-]{36}$/u);
});

test("keeps a pending shared-overlay patch out of the next owned overlay after access is lost", async ({ page, browser }) => {
  const owner = await seedStudioSession(page);
  addStudioOverlay(owner.ownerId, "Owner Backup", owner.login);
  const helperId = `race-helper-${randomBytes(8).toString("hex")}`;
  const helperLogin = `race_${randomBytes(4).toString("hex")}`;
  executeLocalSql(`INSERT INTO users (id, login) VALUES ('${helperId}', '${helperLogin}');`);
  const helperOwned = addStudioOverlay(helperId, "Helper Owned", helperLogin);
  executeLocalSql(`INSERT INTO overlay_editors (overlay_id, user_id) VALUES ('${owner.overlayId}', '${helperId}');`);

  const helperContext = await browser.newContext({ ignoreHTTPSErrors: true });
  const helperPage = await helperContext.newPage();
  const cookie = await mintSessionCookie(TEST_SESSION_KEY, helperId);
  await helperContext.addCookies([{
    name: "session", value: cookie.slice("session=".length), url: e2eOrigin,
    httpOnly: true, secure: true, sameSite: "Lax",
  }]);
  await helperPage.addInitScript((overlayId) => localStorage.setItem("chatwerk-overlay-id", overlayId), owner.overlayId);

  const writesToNextOverlay: string[] = [];
  helperPage.on("request", (request) => {
    if (request.method() === "PUT" && request.url().includes(`/api/overlays/${helperOwned.overlayId}/config`)) {
      writesToNextOverlay.push(request.postData() ?? "");
    }
  });
  let signalSave!: () => void;
  let releaseSave!: () => void;
  const saveStarted = new Promise<void>((resolve) => { signalSave = resolve; });
  const holdSave = new Promise<void>((resolve) => { releaseSave = resolve; });
  await helperPage.route(`${e2eOrigin}/api/overlays/${owner.overlayId}/config`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    signalSave();
    await holdSave;
    await route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "temporary" }) });
  });

  await helperPage.goto("/studio");
  await expect(helperPage.locator("#active-overlay-select option:checked")).toHaveText(`Main by ${owner.login}`);
  await setRange(helperPage, "fontSize", 31);
  await saveStarted;

  const deleted = await page.request.delete(`${e2eOrigin}/api/overlays/${owner.overlayId}`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: {},
  });
  expect(deleted.status()).toBe(204);
  await expect(helperPage.locator("#status-visible")).toHaveText("Access changed. You were moved to Helper Owned.");
  releaseSave();
  await helperPage.waitForTimeout(1_300);

  expect(writesToNextOverlay).toEqual([]);
  await helperContext.close();
});

test("labels an open invite as a replacement on another device in both languages", async ({ page }) => {
  const owner = await seedStudioSession(page);
  const response = await page.request.post(`${e2eOrigin}/api/overlays/${owner.overlayId}/invite`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: {},
  });
  expect(response.status()).toBe(200);

  await page.goto("/studio");
  await openOverlays(page);
  const main = page.locator(".overlay-manager-item").filter({ has: page.locator(".manage-row-name", { hasText: /^Main$/u }) });
  await main.getByRole("button", { name: "Helpers" }).click();
  await expect(main.locator(".invite-create")).toHaveText("Replace link");

  await page.locator("#dialog-close").click();
  await page.evaluate(() => localStorage.setItem("chatwerk-language", "de"));
  await page.reload();
  await openOverlays(page);
  const germanMain = page.locator(".overlay-manager-item").filter({ has: page.locator(".manage-row-name", { hasText: /^Main$/u }) });
  await germanMain.getByRole("button", { name: "Helfer" }).click();
  await expect(germanMain.locator(".invite-create")).toHaveText("Link ersetzen");
});

test("restores keyboard focus to the overlay action after its list rerenders", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await openOverlays(page);
  const main = page.locator(".overlay-manager-item").filter({ has: page.locator(".manage-row-name", { hasText: /^Main$/u }) });
  await main.getByRole("button", { name: "Helpers" }).press("Enter");

  await expect(main.getByRole("button", { name: "Helpers" })).toBeFocused();
});

test("hides the regular close controls while an invite awaits acceptance", async ({ page }) => {
  await seedStudioSession(page);
  const inviteToken = randomBytes(32).toString("base64url");
  await page.goto(`/studio?invite=${inviteToken}`);

  await expect(page.getByRole("heading", { name: "Shared overlay invitation" })).toBeVisible();
  await expect(page.locator("#dialog-close").locator("xpath=.." )).toBeHidden();
  await expect(page.locator("#dialog-x")).toBeHidden();
  await expect(page.getByRole("button", { name: "Decline" })).toBeVisible();
  await capture(page, "invite-accept.png");
});
