import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { DEFAULTS } from "../../src/shared/theme";
import { addStudioOverlay, seedStudioSession } from "./studio-session";

const publicLook = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "sample-size",
  name: "Sample",
  author: "Alice",
  values: DEFAULTS,
  parent: null,
};

async function studio(page: Page, viewport = { width: 1440, height: 900 }): Promise<void> {
  await page.setViewportSize(viewport);
  await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.locator("#preview-size-preset")).toBeVisible();
  await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
}

async function frameSize(page: Page): Promise<{ width: number; height: number }> {
  return page.frameLocator("#studio-preview").locator("body").evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
  }));
}

test("defaults Studio to a 400 by 600 source and resizes the real preview frame with a preset", async ({ page }) => {
  await studio(page);
  await expect(page.locator("#preview-size-preset")).toHaveValue("400x600");
  expect(await frameSize(page)).toEqual({ width: 400, height: 600 });
  await expect(page.locator("#obs-size-hint")).toHaveText("In OBS, set the browser source to 400 x 600.");

  const before = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    scrollX,
    scrollY,
    workspace: document.querySelector("#workspace")!.getBoundingClientRect().toJSON(),
  }));
  await page.locator("#preview-size-preset").selectOption("300x900");
  await expect.poll(() => frameSize(page)).toEqual({ width: 300, height: 900 });
  await expect(page.locator("#obs-size-hint")).toHaveText("In OBS, set the browser source to 300 x 900.");
  const stageRatio = await page.locator("#preview-frame-wrap").evaluate((wrap) => wrap.clientWidth / wrap.clientHeight);
  expect(stageRatio).toBeCloseTo(300 / 900, 2);
  const badgeMatchesFrame = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#studio-preview")!;
    const scale = Number.parseFloat(frame.style.transform.match(/scale\(([\d.]+)\)/u)![1]!);
    const label = document.querySelector("#preview-scale")!.textContent!;
    return Math.round(scale * 100) === Number(label.match(/(\d+)\s*%/u)![1]);
  });
  expect(badgeMatchesFrame).toBe(true);
  const after = await page.evaluate(() => ({
    width: document.documentElement.scrollWidth,
    height: document.documentElement.scrollHeight,
    scrollX,
    scrollY,
    workspace: document.querySelector("#workspace")!.getBoundingClientRect().toJSON(),
  }));
  expect(after).toEqual(before);
});

test("keeps the selected source size after reload and stores it separately per overlay", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const second = addStudioOverlay(identity.ownerId, "Second", "second");
  await page.goto("/studio");
  await page.locator("#preview-size-preset").selectOption("300x900");
  await page.reload();
  await expect(page.locator("#preview-size-preset")).toHaveValue("300x900");
  expect(await frameSize(page)).toEqual({ width: 300, height: 900 });

  await page.goto(`/studio?overlay=${second.overlayId}`);
  await expect(page.locator("#preview-size-preset")).toHaveValue("400x600");
  expect(await frameSize(page)).toEqual({ width: 400, height: 600 });

  await page.goto(`/studio?overlay=${identity.overlayId}`);
  await expect(page.locator("#preview-size-preset")).toHaveValue("300x900");
  expect(await frameSize(page)).toEqual({ width: 300, height: 900 });
});

test("keeps the source preview usable when localStorage rejects size reads and writes", async ({ page }) => {
  await page.addInitScript(() => {
    const originalGetItem = Storage.prototype.getItem;
    const originalSetItem = Storage.prototype.setItem;
    Storage.prototype.getItem = function (key: string): string | null {
      if (key.startsWith("chatwerk-source-size:")) throw new DOMException("Storage blocked", "SecurityError");
      return originalGetItem.call(this, key);
    };
    Storage.prototype.setItem = function (key: string, value: string): void {
      if (key.startsWith("chatwerk-source-size:")) throw new DOMException("Storage blocked", "SecurityError");
      originalSetItem.call(this, key, value);
    };
  });
  await studio(page);
  await page.locator("#preview-size-preset").selectOption("300x900");
  await expect.poll(() => frameSize(page)).toEqual({ width: 300, height: 900 });
  await expect(page.locator("#obs-size-hint")).toHaveText("In OBS, set the browser source to 300 x 900.");
  await page.reload();
  await expect(page.locator("#preview-size-preset")).toHaveValue("400x600");
  expect(await frameSize(page)).toEqual({ width: 400, height: 600 });
});

test("refuses an out of range custom source size without changing the preview or OBS hint", async ({ page }) => {
  await studio(page);
  await page.locator("#preview-size-preset").selectOption("custom");
  for (const invalid of [{ width: "99", height: "600" }, { width: "3841", height: "600" }, { width: "400", height: "2161" }]) {
    await page.locator("#preview-custom-width").fill(invalid.width);
    await page.locator("#preview-custom-height").fill(invalid.height);
    await page.locator("#preview-custom-apply").click();

    await expect(page.locator("#preview-size-error")).toBeVisible();
    await expect(page.locator("#preview-size-preset")).toHaveValue("custom");
    expect(await frameSize(page)).toEqual({ width: 400, height: 600 });
    await expect(page.locator("#obs-size-hint")).toHaveText("In OBS, set the browser source to 400 x 600.");
  }
});

test("applies a valid custom source size and updates the fixed OBS hint", async ({ page }) => {
  await studio(page);
  await page.locator("#preview-size-preset").selectOption("custom");
  for (const size of [{ width: 100, height: 100 }, { width: 3840, height: 2160 }, { width: 500, height: 900 }]) {
    await page.locator("#preview-custom-width").fill(String(size.width));
    await page.locator("#preview-custom-height").fill(String(size.height));
    await page.locator("#preview-custom-apply").click();
    await expect.poll(() => frameSize(page)).toEqual(size);
  }
  await expect(page.locator("#obs-size-hint")).toHaveText("In OBS, set the browser source to 500 x 900.");
});

test("keeps /themes and public look previews at a 400 by 600 source size", async ({ page }) => {
  await seedStudioSession(page);
  await page.route("**/api/looks", (route) => route.fulfill({ json: { looks: [publicLook] } }));
  await page.route("**/api/looks/sample-size", (route) => route.fulfill({ json: publicLook }));
  await page.goto("/themes");
  await expect(page.locator("#look-name")).toHaveText("Sample");
  const themeFrame = page.frameLocator("#look-preview");
  await expect.poll(() => themeFrame.locator("body").evaluate(() => [innerWidth, innerHeight])).toEqual([400, 600]);

  await page.goto("/t/sample-size");
  await expect(page.locator("#look-name")).toHaveText("Sample");
  const publicFrame = page.frameLocator("#look-preview");
  await expect.poll(() => publicFrame.locator("body").evaluate(() => [innerWidth, innerHeight])).toEqual([400, 600]);
});

test("translates the source size control and OBS hint into German", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("chatwerk-language", "de"));
  await studio(page);
  await expect(page.locator("label[for=preview-size-preset]")).toHaveText("Quellgröße");
  await expect(page.locator("#preview-size-preset option[value=custom]")).toHaveText("Benutzerdefiniert");
  await expect(page.locator("#obs-size-hint")).toHaveText("Stelle die Browserquelle in OBS auf 400 x 600 ein.");
  await page.locator("#preview-size-preset").selectOption("1920x1080");
  await expect(page.locator("#obs-size-hint")).toHaveText("Stelle die Browserquelle in OBS auf 1920 x 1080 ein.");
});

test("captures the requested Studio and Themes preview screenshots", async ({ page }) => {
  await mkdir(".tmp/shots", { recursive: true });
  await seedStudioSession(page);
  await page.route("**/api/looks", (route) => route.fulfill({ json: { looks: [publicLook] } }));

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/studio");
  await expect(page.locator("#preview-size-preset")).toHaveValue("400x600");
  await expect(page.frameLocator("#studio-preview").locator(".chat-line")).toHaveCount(4);
  if (await page.locator("#first-run-done").isVisible()) await page.locator("#first-run-done").click();
  await page.screenshot({ path: ".tmp/shots/studio-1440x900.png" });

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.screenshot({ path: ".tmp/shots/studio-1024x768.png" });

  await page.goto("/themes");
  await expect(page.locator("#look-name")).toHaveText("Sample");
  await expect(page.frameLocator("#look-preview").locator(".chat-line")).toHaveCount(3);
  await page.screenshot({ path: ".tmp/shots/themes.png" });
});

test("keeps 100 routed messages inside 400 by 600 and 300 by 900 browser sources", async ({ page }) => {
  const longLink = `https://example.test/${"x".repeat(4000)}`;
  const messages = Array.from({ length: 100 }, (_, index) =>
    `@id=small-${index};display-name=Viewer :viewer!viewer@host PRIVMSG #small_source :${index === 99 ? `message ${index} ${longLink.slice(0, 600)}` : `message ${index}`}`);
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      if (String(message).startsWith("JOIN #small_source")) socket.send(messages.join("\r\n"));
    });
  });

  for (const size of [{ width: 400, height: 600 }, { width: 300, height: 900 }]) {
    await page.setViewportSize(size);
    await page.goto("/overlay#channel=small_source&client=browser");
    await expect.poll(() => page.locator(".chat-line").count()).toBeGreaterThan(0);
    await expect.poll(() => page.locator(".chat-line").count()).toBeLessThanOrEqual(100);
    const layout = await page.evaluate(() => {
      const last = document.querySelectorAll<HTMLElement>(".chat-line").item(document.querySelectorAll(".chat-line").length - 1);
      const bounds = last.getBoundingClientRect();
      const message = document.querySelectorAll<HTMLElement>(".chat-message").item(document.querySelectorAll(".chat-message").length - 1);
      return {
        viewportWidth: innerWidth,
        viewportHeight: innerHeight,
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        lastBottom: bounds.bottom,
        longMessageHeight: message.getBoundingClientRect().height,
        longMessageWidth: message.clientWidth,
        longMessageScrollWidth: message.scrollWidth,
        lastText: last.querySelector(".chat-message")?.textContent,
      };
    });
    expect(layout.viewportWidth).toBe(size.width);
    expect(layout.viewportHeight).toBe(size.height);
    expect(layout.documentWidth).toBeLessThanOrEqual(size.width);
    expect(layout.bodyWidth).toBeLessThanOrEqual(size.width);
    expect(layout.lastBottom).toBeLessThanOrEqual(size.height);
    expect(size.height - layout.lastBottom).toBeLessThanOrEqual(40);
    expect(layout.lastText).toContain("message 99");
    expect(layout.longMessageHeight).toBeGreaterThan(20);
    expect(layout.longMessageScrollWidth).toBeLessThanOrEqual(layout.longMessageWidth);
  }
});
