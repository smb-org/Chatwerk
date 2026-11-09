import { expect, test, type Page } from "@playwright/test";
import { DEFAULTS } from "../../src/shared/theme";
import { addStudioLook, addStudioOverlay, e2eOrigin, expectActiveOverlay, seedStudioSession, setRange, type StudioIdentity } from "./studio-session";

const validLook = { id: "11111111-1111-4111-8111-111111111111", slug: "sample", name: "Sample", author: "Alice", values: DEFAULTS, parent: null };

async function gallery(page: Page): Promise<void> {
  await seedStudioSession(page);
  await page.route("**/api/looks", (route) => route.fulfill({ json: { looks: [validLook] } }));
  await page.goto("/themes");
  await expect(page.locator("#look-name")).toHaveText("Sample");
}

async function studioWithUndo(page: Page, identity: StudioIdentity): Promise<void> {
  const look = addStudioLook(identity.ownerId, "Undo Race", { ...DEFAULTS, fontSize: 30 });
  const response = await page.request.post(`${e2eOrigin}/api/looks/${look.slug}/copy`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { overlayId: identity.overlayId },
  });
  expect(response.status()).toBe(200);
  const copy = await response.json() as { snapshotId: string; revision: number; undoExpiresAt: number };
  const destination = new URL("/studio", e2eOrigin);
  destination.searchParams.set("overlay", identity.overlayId);
  destination.searchParams.set("undo", copy.snapshotId);
  destination.searchParams.set("rev", String(copy.revision));
  destination.searchParams.set("until", String(copy.undoExpiresAt));
  destination.searchParams.set("lookName", "Undo Race");
  await page.goto(destination.toString());
  await expect(page.locator("#undo-look")).toBeVisible();
}

test("login link preserves its next destination and follows the Twitch redirect", async ({ page }) => {
  await page.goto("/login?next=%2Fthemes");
  const action = page.getByRole("link", { name: "Log in with Twitch" });
  await expect(action).toHaveAttribute("href", "/auth/login?next=%2Fthemes");
  let loginRequestUrl = "";
  const authorizeMock = `${e2eOrigin}/__e2e/twitch/authorize`;
  await page.route("**/auth/login**", async (route) => {
    loginRequestUrl = route.request().url();
    await route.fulfill({
      status: 302,
      headers: { location: authorizeMock },
    });
  });
  await page.route(authorizeMock, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Mock Twitch login</title>" }));

  await action.click();

  await expect(page).toHaveURL(authorizeMock);
  expect(new URL(loginRequestUrl).pathname).toBe("/auth/login");
  expect(new URL(loginRequestUrl).search).toBe("?next=%2Fthemes");
});

test("login link shows its opening state when clicked", async ({ page }) => {
  await page.goto("/login");
  const action = page.locator("#login-button");
  await action.evaluate((link) => {
    link.addEventListener("click", (event) => event.preventDefault(), { capture: true, once: true });
  });
  await action.click();
  await expect(action).toHaveAttribute("aria-disabled", "true");
  await expect(action).toHaveText("Opening Twitch...");
});

test("gallery skips a malformed look and keeps valid rows", async ({ page }) => {
  await seedStudioSession(page);
  await page.route("**/api/looks", (route) => route.fulfill({ json: { looks: [{ ...validLook, id: "bad", values: null }, validLook] } }));
  await page.goto("/themes");
  await expect(page.locator("#look-list [role=option]")).toHaveCount(1);
  await expect(page.locator("#look-name")).toHaveText("Sample");
});

test("public look has a primary login to copy action", async ({ page }) => {
  await page.route("**/api/looks/sample", (route) => route.fulfill({ json: validLook }));
  await page.goto("/t/sample");
  const action = page.getByRole("link", { name: "Log in with Twitch to copy" });
  await expect(action).toBeVisible();
  await expect(action).toHaveAttribute("href", "/auth/login?next=%2Ft%2Fsample");
  await expect(action).toHaveClass(/button-primary/u);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator("#public-copy-login-mobile")).toBeVisible();
});

test("anchor buttons center content without underlines", async ({ page }) => {
  await page.route("**/api/looks/sample", (route) => route.fulfill({ json: validLook }));
  await page.goto("/t/sample");
  const style = await page.locator("#public-login").evaluate((item) => {
    const css = getComputedStyle(item);
    return [css.display, css.alignItems, css.justifyContent, css.textDecorationLine];
  });
  expect(["inline-flex", "flex"]).toContain(style[0]);
  expect(style.slice(1)).toEqual(["center", "center", "none"]);
});

test("export labels its output and test panel in both languages", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio/export");
  await expect(page.locator("#export-actions-title")).toHaveText("Output and test");
  await expect(page.locator("#export-actions-title")).toHaveCSS("align-self", "flex-start");
  await page.evaluate(() => localStorage.setItem("chatwerk-language", "de"));
  await page.reload();
  await expect(page.locator("#export-actions-title")).toHaveText("Ausgabe und Test");
});

test("export places the disabled Test explanation beside its button", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio/export");
  await expect(page.locator("#export-test-in-obs")).toBeDisabled();
  await expect(page.locator("#export-test-hint")).toHaveText("Connect an output first.");
  expect(await page.locator("#export-test-in-obs").evaluate((item) => item.parentElement?.querySelector("#export-test-hint") !== null)).toBe(true);
  expect(await page.locator("#export-test-in-obs").evaluate((item) => item.parentElement?.className)).toBe("export-test-controls");
});

test("every gallery value stays inside the viewport at 1024 by 768", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await gallery(page);
  for (const value of await page.locator("#look-values dd").all()) {
    const bounds = await value.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(768);
  }
});

test("copy session expiry returns to themes", async ({ page }) => {
  await gallery(page);
  await page.route("**/api/looks/sample/copy", (route) => route.fulfill({ status: 401 }));
  await page.route("**/auth/login**", (route) => route.abort());
  const request = page.waitForRequest((item) => item.url().includes("/auth/login"));
  await page.locator("#use-look").click();
  expect(new URL((await request).url()).searchParams.get("next")).toBe("/themes");
});

test("public look shows the active overlay after login", async ({ page }) => {
  await seedStudioSession(page);
  await page.route("**/api/looks/sample", (route) => route.fulfill({ json: validLook }));
  await page.goto("/t/sample");
  await expect(page.locator("#active-overlay-name")).toBeVisible();
  await expectActiveOverlay(page, "Main");
});

test("publish succeeds when the clipboard is blocked", async ({ page }) => {
  await seedStudioSession(page);
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "clipboard", { value: { writeText: () => Promise.reject(new Error("blocked")) } });
    document.execCommand = () => false;
  });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await page.locator("#share-look").click();
  await page.locator("#publish-name").fill("Clipboard Blocked");
  await page.locator("#publish-submit").click();
  await expect(page.locator("#publish-status")).toHaveText("Published. Link not copied.");
  await expect(page.locator("#publish-open")).toBeVisible();
  await expect(page.locator("#publish-submit")).toBeDisabled();
  await page.evaluate(() => localStorage.setItem("chatwerk-language", "de"));
  await page.reload();
  await page.locator("#share-look").click();
  await page.locator("#publish-name").fill("Clipboard Deutsch");
  await page.locator("#publish-submit").click();
  await expect(page.locator("#publish-status")).toHaveText("Veröffentlicht. Link nicht kopiert.");
});

test("my looks reserves its status line before a notice", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await page.locator("#account-menu summary").click();
  await page.getByRole("button", { name: "My looks" }).click();
  const status = page.locator("#dialog-body > .manage-status");
  await expect(status).toHaveCount(1);
  await expect(status).toHaveCSS("display", "block");
  const bounds = await status.boundingBox();
  expect(bounds?.height).toBeGreaterThan(0);
});

test("account menu closes before the modal opens", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await page.locator("#account-menu summary").click();
  await page.getByRole("button", { name: "Overlays" }).click();
  await expect(page.locator("#account-menu")).not.toHaveAttribute("open", "");
});

test("active overlay cannot be deleted while its save is in flight", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Survivor", identity.login);
  let releaseSave!: () => void;
  let markSaveStarted!: () => void;
  const saveHeld = new Promise<void>((resolve) => { releaseSave = resolve; });
  const saveStarted = new Promise<void>((resolve) => { markSaveStarted = resolve; });
  await page.route(`**/api/overlays/${identity.overlayId}/config`, async (route) => {
    if (route.request().method() === "PUT") {
      markSaveStarted();
      await saveHeld;
    }
    await route.continue();
  });
  try {
    await page.goto("/studio");
    await page.locator("#first-run-done").click();
    await setRange(page, "fontSize", 25);
    await saveStarted;
    await page.locator("#account-menu summary").click();
    await page.getByRole("button", { name: "Overlays" }).click();
    const dialog = page.getByRole("dialog", { name: "Overlays" });
    await dialog.getByRole("button", { name: "Delete Main" }).click();
    await expect(dialog.locator(".manage-status")).toHaveText("Wait for the current changes to save before switching overlays.");
    const response = await page.request.get("/api/overlays");
    expect((await response.json() as { overlays: unknown[] }).overlays).toHaveLength(2);
    await expectActiveOverlay(page, "Main");
    releaseSave();
    await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
    await dialog.getByRole("button", { name: "Delete Main" }).click();
    await expect(dialog).toBeHidden();
    await expectActiveOverlay(page, "Survivor");
  } finally {
    releaseSave();
  }
});

test("active overlay editing stays locked if its delete dialog is dismissed", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Survivor", identity.login);
  let releaseDelete!: () => void;
  let markDeleteStarted!: () => void;
  const deletionHeld = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const deletionStarted = new Promise<void>((resolve) => { markDeleteStarted = resolve; });
  let saves = 0;
  await page.route(`**/api/overlays/${identity.overlayId}/config`, async (route) => {
    if (route.request().method() === "PUT") saves += 1;
    await route.continue();
  });
  await page.route(`**/api/overlays/${identity.overlayId}`, async (route) => {
    if (route.request().method() === "DELETE") {
      markDeleteStarted();
      await deletionHeld;
    }
    await route.continue();
  });
  try {
    await page.goto("/studio");
    await page.locator("#first-run-done").click();
    const slider = page.locator("#theme-fontSize");
    await slider.scrollIntoViewIfNeeded();
    const initialValue = await slider.inputValue();
    await page.locator("#account-menu summary").click();
    await page.getByRole("button", { name: "Overlays" }).click();
    await page.getByRole("button", { name: "Delete Main" }).click();
    await deletionStarted;
    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog", { name: "Overlays" })).toBeHidden();
    const bounds = await slider.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width - 2, bounds!.y + bounds!.height / 2);
    await page.waitForTimeout(400);
    expect(await slider.inputValue()).toBe(initialValue);
    expect(saves).toBe(0);
    releaseDelete();
    await expectActiveOverlay(page, "Survivor");
    await expect(page.locator("#theme-controls")).not.toHaveAttribute("inert", "");
  } finally {
    releaseDelete();
  }
});

test("active overlay editing unlocks when deletion fails", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Survivor", identity.login);
  let releaseDelete!: () => void;
  let markDeleteStarted!: () => void;
  const deletionHeld = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const deletionStarted = new Promise<void>((resolve) => { markDeleteStarted = resolve; });
  await page.route(`**/api/overlays/${identity.overlayId}`, async (route) => {
    if (route.request().method() === "DELETE") {
      markDeleteStarted();
      await deletionHeld;
      await route.abort();
    } else await route.continue();
  });
  try {
    await page.goto("/studio");
    await page.locator("#first-run-done").click();
    await page.locator("#account-menu summary").click();
    await page.getByRole("button", { name: "Overlays" }).click();
    await page.getByRole("button", { name: "Delete Main" }).click();
    await deletionStarted;
    await page.keyboard.press("Escape");
    await expect(page.locator("#theme-controls")).toHaveAttribute("inert", "");
    releaseDelete();
    await expect(page.locator("#theme-controls")).not.toHaveAttribute("inert", "");
    const slider = page.locator("#theme-fontSize");
    await slider.scrollIntoViewIfNeeded();
    const initialValue = await slider.inputValue();
    const bounds = await slider.boundingBox();
    expect(bounds).not.toBeNull();
    await page.mouse.click(bounds!.x + bounds!.width - 2, bounds!.y + bounds!.height / 2);
    await expect(slider).not.toHaveValue(initialValue);
  } finally {
    releaseDelete();
  }
});

test("active overlay cannot be deleted while undo is in flight", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Survivor", identity.login);
  let releaseUndo!: () => void;
  let markUndoStarted!: () => void;
  const undoHeld = new Promise<void>((resolve) => { releaseUndo = resolve; });
  const undoStarted = new Promise<void>((resolve) => { markUndoStarted = resolve; });
  let deleteRequests = 0;
  await page.route(`**/api/overlays/${identity.overlayId}/undo`, async (route) => {
    markUndoStarted();
    await undoHeld;
    await route.fulfill({ json: { revision: 2, config: DEFAULTS } });
  });
  await page.route(`**/api/overlays/${identity.overlayId}`, async (route) => {
    if (route.request().method() === "DELETE") deleteRequests += 1;
    await route.continue();
  });
  try {
    await studioWithUndo(page, identity);
    await page.locator("#first-run-done").click();
    await page.locator("#undo-look").click();
    await undoStarted;
    await page.locator("#account-menu summary").click();
    await page.getByRole("button", { name: "Overlays" }).click();
    const dialog = page.getByRole("dialog", { name: "Overlays" });
    await dialog.getByRole("button", { name: "Delete Main" }).click();
    await expect(dialog.locator(".manage-status")).toHaveText("Wait for Undo to finish before deleting this overlay.");
    expect(deleteRequests).toBe(0);
    await expectActiveOverlay(page, "Main");
    releaseUndo();
    await expect(page.locator("#theme-fontSize")).toHaveValue(String(DEFAULTS.fontSize));
    await expect(page.locator("#status-visible")).toHaveText("Previous look restored.");
    await expectActiveOverlay(page, "Main");
  } finally {
    releaseUndo();
  }
});

for (const outcome of ["success", "error"] as const) test(`late undo ${outcome} response cannot replace the surviving overlay state`, async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Survivor", identity.login);
  let releaseUndo!: () => void;
  let markUndoStarted!: () => void;
  const undoHeld = new Promise<void>((resolve) => { releaseUndo = resolve; });
  const undoStarted = new Promise<void>((resolve) => { markUndoStarted = resolve; });
  await page.route(`**/api/overlays/${identity.overlayId}/undo`, async (route) => {
    markUndoStarted();
    await undoHeld;
    if (outcome === "success") await route.fulfill({ json: { revision: 2, config: { ...DEFAULTS, fontSize: 72 } } });
    else await route.fulfill({ status: 409, json: { error: "revision-conflict" } });
  });
  try {
    await studioWithUndo(page, identity);
    await page.locator("#first-run-done").click();
    await page.locator("#undo-look").click();
    await undoStarted;
    await page.locator("#account-menu summary").click();
    await page.getByRole("button", { name: "Overlays" }).click();
    await page.locator(".manage-row").filter({ hasText: "Survivor" }).locator(".manage-row-select").click();
    await expectActiveOverlay(page, "Survivor");
    await expect(page.locator("#theme-fontSize")).toHaveValue(String(DEFAULTS.fontSize));
    const received = page.waitForResponse((response) => response.url().endsWith(`/api/overlays/${identity.overlayId}/undo`));
    releaseUndo();
    await received;
    await page.waitForTimeout(150);
    await expect(page.locator("#theme-fontSize")).toHaveValue(String(DEFAULTS.fontSize));
    await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  } finally {
    releaseUndo();
  }
});

test("undo cannot start during deletion and is restored after failure", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Survivor", identity.login);
  let releaseDelete!: () => void;
  let markDeleteStarted!: () => void;
  const deletionHeld = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const deletionStarted = new Promise<void>((resolve) => { markDeleteStarted = resolve; });
  let undoRequests = 0;
  await page.route(`**/api/overlays/${identity.overlayId}/undo`, async (route) => {
    undoRequests += 1;
    await route.abort();
  });
  await page.route(`**/api/overlays/${identity.overlayId}`, async (route) => {
    if (route.request().method() === "DELETE") {
      markDeleteStarted();
      await deletionHeld;
      await route.abort();
    } else await route.continue();
  });
  try {
    await studioWithUndo(page, identity);
    await page.locator("#first-run-done").click();
    await page.locator("#account-menu summary").click();
    await page.getByRole("button", { name: "Overlays" }).click();
    await page.getByRole("button", { name: "Delete Main" }).click();
    await deletionStarted;
    await page.keyboard.press("Escape");
    const undo = page.locator("#undo-look");
    await expect(undo).toBeDisabled();
    await undo.dispatchEvent("click");
    await page.waitForTimeout(200);
    expect(undoRequests).toBe(0);
    releaseDelete();
    await expect(undo).toBeEnabled();
  } finally {
    releaseDelete();
  }
});

test("copy retries retain a client idempotency key", async ({ page }) => {
  await gallery(page);
  const keys: (string | undefined)[] = [];
  await page.route("**/api/looks/sample/copy", (route) => {
    keys.push(route.request().headers()["idempotency-key"]);
    return route.fulfill({ status: 503 });
  });
  await page.locator("#use-look").click();
  await expect(page.locator("#gallery-toast")).toContainText("Could not copy");
  await page.reload();
  await expect(page.locator("#look-name")).toHaveText("Sample");
  await page.locator("#use-look").click();
  await expect.poll(() => keys.length).toBe(2);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/u);
  expect(keys[1]).toBe(keys[0]);
});


test("look preview seeds chat quickly inside a visible stage boundary", async ({ page }) => {
  await gallery(page);
  await expect(page.frameLocator("#look-preview").locator("#chat > *")).toHaveCount(9, { timeout: 1000 });
  await expect(page.locator("#gallery-frame-wrap")).toHaveCSS("outline-style", "solid");
  await page.route("**/api/looks/sample", (route) => route.fulfill({ json: validLook }));
  await page.goto("/t/sample");
  await expect(page.frameLocator("#look-preview").locator("#chat > *")).toHaveCount(9, { timeout: 1000 });
});
