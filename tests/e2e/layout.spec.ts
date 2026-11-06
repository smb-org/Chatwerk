import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { addStudioOverlay, e2eOrigin, seedStudioSession, selectSettingsTabForField, setRange } from "./studio-session";

test("keeps logged-out Studio access on the login route", async ({ page }) => {
  await page.goto("/studio");
  await expect(page).toHaveURL(/\/login\?next=%2Fstudio$/u);
  await expect(page.getByRole("button", { name: "Log in with Twitch" })).toBeVisible();
});

test("keeps landmarks, accessible controls, and focus in the Studio shell", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.getByRole("banner")).toBeVisible();
  await expect(page.getByRole("main")).toBeVisible();
  await expect(page.getByRole("complementary", { name: "Settings" })).toBeVisible();
  await expect(page.getByRole("contentinfo", { name: "Rehearse" })).toBeVisible();
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Chatwerk");
  await page.keyboard.press("Tab");
  await expect(page.locator(":focus")).toHaveText("Studio");
});

test("loads an existing Main overlay through / with defaults at revision zero", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
  const { token, login } = await seedStudioSession(page);

  await page.goto("/");
  await expect(page).toHaveURL(`${e2eOrigin}/studio`);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await expect(page.locator("#overlay-url")).toHaveValue(`${e2eOrigin}/overlay#token=${token}`);
  await page.locator("#channel-field-button").click();
  await expect(page.locator("#channel-popover [data-channel-value]")).toHaveValue(login);

  const response = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBe(true);
  await expect(response.json()).resolves.toMatchObject({
    revision: 0,
    config: { fontSize: 18, emoteScale: 1.5, showBadges: true, showPronouns: false },
  });
  expect(errors).toEqual([]);

  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  expect(errors).toEqual([]);
});

test("renders theme controls without Channels and links Themes", async ({ page }) => {
  const { login } = await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.locator("#first-run")).toHaveClass(/is-visible/u);

  await selectSettingsTabForField(page, "emoteScale");
  const messages = page.locator('.settings-group[data-group="Messages"]');
  await expect(messages.locator('[data-theme-field="emoteScale"]')).toBeVisible();
  await expect(messages.getByRole("checkbox", { name: "Show badges" })).toBeChecked();
  await expect(messages.getByRole("checkbox", { name: "Show pronouns" })).not.toBeChecked();
  await expect(page.locator('[data-group="Channels"]')).toHaveCount(0);
  await page.locator("#channel-field-button").click();
  await expect(page.locator("#channel-popover [data-channel-value]")).toHaveValue(login);
  await selectSettingsTabForField(page, "hideNumbers");
  await expect(page.locator('[data-group="Filters"]')).toBeVisible();
  await expect(page.locator('[data-theme-field="hideNumbers"]')).toBeVisible();

  const themes = page.getByText("Themes", { exact: true });
  await expect(themes).toHaveAttribute("href", "/themes");

  const borders = await page.locator('.theme-control[data-control], #preview-background-group').evaluateAll((items) =>
    items.map((item) => {
      const style = getComputedStyle(item);
      return { borderStyle: style.borderStyle, borderWidth: style.borderWidth };
    }));
  expect(borders.every(({ borderStyle, borderWidth }) => borderStyle === "none" || borderWidth === "0px")).toBe(true);
});

test("copies the complete origin-based overlay URL including its token hash", async ({ page }) => {
  const { token } = await seedStudioSession(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/studio");
  const link = `${e2eOrigin}/overlay#token=${token}`;
  await expect(page.locator("#overlay-url")).toHaveValue(link);
  await page.locator("#copy-link").click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);
});

test("lists owned overlays from the account API", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await page.locator("#account-menu summary").click();
  await page.getByRole("button", { name: "Overlays" }).click();
  const dialog = page.getByRole("dialog", { name: "Overlays" });
  const overlayList = dialog.getByRole("group", { name: "Your overlays" });
  await expect(overlayList).toBeVisible();
  await expect(overlayList.locator(".manage-row").filter({ hasText: "Main" }).locator(".manage-row-select"))
    .toHaveAttribute("aria-pressed", "true");
});

test("opens Setup from Studio navigation and protects the direct setup asset", async ({ page }) => {
  await seedStudioSession(page, { channel: "" });
  await page.goto("/studio");
  await expect(page.locator(".studio-header .top-nav a[href='/studio/export']")).toHaveText("Setup");

  const [setupResponse] = await Promise.all([
    page.waitForResponse((response) => new URL(response.url()).pathname === "/studio/export"),
    page.locator(".studio-header .top-nav a[href='/studio/export']").click(),
  ]);
  expect(setupResponse.status()).toBe(200);
  await expect(page.locator("#setup-url-streamelements")).toHaveValue(new RegExp(`${e2eOrigin.replaceAll(".", "\\.")}\\/overlay#token=.+&client=widget&placement=origin`, "u"));
  await expect(page.locator("#code-html-streamelements")).toContainText('sandbox="allow-scripts"');
  expect(setupResponse.headers()["x-frame-options"]).toBe("SAMEORIGIN");
  expect(setupResponse.headers()["content-security-policy"]).toContain("frame-ancestors");
  expect(setupResponse.headers()["cache-control"]).toBe("no-cache");

  await page.context().clearCookies();
  await page.goto("/export.html");
  await expect(page).toHaveURL(/\/login\?next=%2Fstudio%2Fexport$/u);
});

test("switches between overlays with the existing owner read API", async ({ page }) => {
  const { ownerId, token: mainToken } = await seedStudioSession(page);
  const alternate = addStudioOverlay(ownerId, "Second", "second_channel");
  await page.goto("/studio");
  await page.locator("#account-menu summary").click();
  await page.getByRole("button", { name: "Overlays" }).click();
  const dialog = page.getByRole("dialog", { name: "Overlays" });
  const overlayList = dialog.getByRole("group", { name: "Your overlays" });
  await expect(overlayList.locator(".manage-row")).toHaveCount(2);
  const main = overlayList.locator(".manage-row").filter({ hasText: "Main" }).locator(".manage-row-select");
  await expect(main).toHaveAttribute("aria-pressed", "true");
  await overlayList.locator(".manage-row").filter({ hasText: "Second" }).locator(".manage-row-select").click();
  await expect(dialog).toBeHidden();
  await expect(page.locator("#overlay-url")).toHaveValue(`${e2eOrigin}/overlay#token=${alternate.token}`);
  await expect(page.locator("#overlay-url")).not.toHaveValue(`${e2eOrigin}/overlay#token=${mainToken}`);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
});

test("keeps fixed areas in place while German copy and preview states change", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  const before = await page.locator(".preview-column").boundingBox();
  await page.locator("#account-menu summary").click();
  await page.getByRole("button", { name: "Deutsch" }).click();
  await page.getByRole("button", { name: "Fertig" }).click();
  await page.locator("#rehearse-flood").click();
  await page.locator("#warning-row").evaluate((element) => {
    element.textContent = "Schrift konnte nicht geladen werden. Ersatzschrift wird angezeigt.";
    element.classList.add("is-visible");
  });
  await expect(page.locator("#warning-row")).toContainText("Ersatzschrift wird angezeigt.");
  const after = await page.locator(".preview-column").boundingBox();
  expect(after).toEqual(before);
});

for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
  for (const language of ["en", "de"] as const) {
    test(`shows all rehearse controls after first run at ${viewport.width}px in ${language}`, async ({ page }) => {
      await seedStudioSession(page);
      await page.setViewportSize(viewport);
      await page.goto("/studio");
      if (language === "de") {
        await page.locator("#account-menu summary").click();
        await page.getByRole("button", { name: "Deutsch" }).click();
      }
      await expect(page.locator("#rehearse-tools")).toBeHidden();
      await page.locator("#first-run-done").click();

      const footer = page.locator(".rehearse-footer");
      await expect(footer).toHaveCSS("height", "64px");
      await expect(page.locator("#test-in-obs")).toBeInViewport();
      await expect(page.locator("#share-look")).toBeInViewport();
      if (viewport.width === 1440 && language === "en") {
        await mkdir(path.resolve(".tmp/shots"), { recursive: true });
        await page.screenshot({ path: ".tmp/shots/studio-after-first-run.png", fullPage: true });
      }
    });
  }
}

for (const width of [1024, 390]) {
  test(`fits the ${width}px viewport without page scrolling`, async ({ page }) => {
    await seedStudioSession(page);
    await page.setViewportSize({ width, height: 800 });
    await page.goto("/studio");
    const dimensions = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
    if (width < 1024) {
      await expect(page.getByText("Editing needs a wider window.")).toBeVisible();
      await expect(page.getByRole("complementary", { name: "Settings" })).toBeHidden();
    } else {
      await expect(page.getByRole("complementary", { name: "Settings" })).toBeVisible();
    }
  });
}

test("keeps the header and footer fixed when the window is short", async ({ page }) => {
  await seedStudioSession(page);
  await page.setViewportSize({ width: 1024, height: 650 });
  await page.goto("/studio");
  const positions = await page.evaluate(() => ({
    header: document.querySelector("header")!.getBoundingClientRect().top,
    footer: document.querySelector("footer")!.getBoundingClientRect().bottom,
    pageHeight: document.documentElement.scrollHeight,
    windowHeight: window.innerHeight,
  }));
  expect(positions.header).toBe(0);
  expect(positions.footer).toBe(positions.windowHeight);
  expect(positions.pageHeight).toBeLessThanOrEqual(positions.windowHeight);
});

test("remains within the viewport at 200 percent zoom", async ({ page }) => {
  await seedStudioSession(page);
  await page.setViewportSize({ width: 1024, height: 650 });
  await page.goto("/studio");
  await page.evaluate(() => { document.documentElement.style.zoom = "2"; });
  const dimensions = await page.evaluate(() => ({
    client: document.documentElement.clientWidth,
    scroll: document.documentElement.scrollWidth,
    pageHeight: document.documentElement.scrollHeight,
    windowHeight: document.documentElement.clientHeight,
  }));
  expect(dimensions.scroll).toBeLessThanOrEqual(dimensions.client);
  expect(dimensions.pageHeight).toBeLessThanOrEqual(dimensions.windowHeight);
});

test("captures required visual review screens", async ({ page }) => {
  await mkdir(path.resolve(".tmp/shots"), { recursive: true });
  await page.goto("/login");
  await page.screenshot({ path: ".tmp/shots/login.png", fullPage: true });
  const { token } = await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.locator("#preview-mode-sample")).toHaveText("Sample");
  await page.screenshot({ path: ".tmp/shots/studio-first-run.png", fullPage: true });
  await setRange(page, "fontSize", 26);
  await expect(page.locator("#status-visible")).toContainText(/Saved, rev/u, { timeout: 5_000 });
  await page.screenshot({ path: ".tmp/shots/studio-look-applied.png", fullPage: true });
  await page.locator("#settings-scroll").evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await page.screenshot({ path: ".tmp/shots/studio-settings-lower.png", fullPage: true });
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.screenshot({ path: ".tmp/shots/studio-1024.png", fullPage: true });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.screenshot({ path: ".tmp/shots/studio-390.png", fullPage: true });
  const overlay = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(overlay.ok()).toBe(true);
});
