import { expect, test } from "@playwright/test";
import { e2eOrigin, seedStudioSession, setThemeChecked } from "./studio-session";

test("Studio quiet sample renders bundled badges, a paint and emotes with external requests blocked", async ({ page }) => {
  await page.route("**/*", (route) => {
    try {
      if (new URL(route.request().url()).origin !== e2eOrigin) return route.abort();
    } catch {
      return route.abort();
    }
    return route.continue();
  });
  await page.setViewportSize({ width: 1_440, height: 960 });
  await seedStudioSession(page);
  await page.goto("/studio");

  const chat = page.frameLocator("#studio-preview").locator("#chat");
  await expect(chat.locator(".chat-line")).toHaveCount(10);
  const badge = chat.locator("img.chat-badge").first();
  const paintedName = chat.locator(".chat-name-painted").first();
  const emote = chat.locator("img.chat-emote").first();
  await expect(badge).toBeVisible();
  await expect(paintedName).toBeVisible();
  await expect(emote).toBeVisible();
  await expect(chat.locator('img.chat-emote[alt="WaveHi"]')).toBeVisible();
  await expect(chat.locator('img.chat-emote[alt="PartyPop"]')).toBeVisible();
  const imagePaintName = chat.locator(".chat-name-painted").filter({ hasText: "sample_tobi" });
  await expect(imagePaintName).toBeVisible();
  await expect.poll(() => imagePaintName.evaluate((name) => getComputedStyle(name).backgroundImage))
    .toContain("/assets/samples/name-paint.svg");
  await expect.poll(() => Promise.all([
    badge.evaluate((image) => (image as HTMLImageElement).naturalWidth),
    emote.evaluate((image) => (image as HTMLImageElement).naturalWidth),
  ])).toEqual([36, 36]);

  const imageOrigins = await chat.locator("img.chat-badge, img.chat-emote").evaluateAll((images) =>
    images.map((image) => new URL((image as HTMLImageElement).src).origin));
  expect(imageOrigins.length).toBeGreaterThan(0);
  expect(imageOrigins.every((origin) => origin === e2eOrigin)).toBe(true);

  await setThemeChecked(page, "emotes7tv", false);
  await expect(chat.locator('img.chat-emote[alt="WaveHi"]')).toHaveCount(0);
  await expect(chat.locator(".chat-line").filter({ hasText: "WaveHi" })).toBeVisible();
  await setThemeChecked(page, "emotes7tv", true);
  await expect(chat.locator('img.chat-emote[alt="WaveHi"]')).toBeVisible();

  await setThemeChecked(page, "emotesBttv", false);
  await expect(chat.locator('img.chat-emote[alt="PartyPop"]')).toHaveCount(0);
  await setThemeChecked(page, "emotesBttv", true);
  await expect(chat.locator('img.chat-emote[alt="PartyPop"]')).toBeVisible();

  await setThemeChecked(page, "showBadges", false);
  await expect(chat.locator("img.chat-badge")).toHaveCount(0);
  await setThemeChecked(page, "showBadges", true);
  await expect(chat.locator("img.chat-badge").first()).toBeVisible();
  await setThemeChecked(page, "showPaints", false);
  await expect(chat.locator(".chat-name-painted")).toHaveCount(0);
  await setThemeChecked(page, "showPaints", true);
  await expect(chat.locator(".chat-name-painted").first()).toBeVisible();
});

test("quiet sample's long word wraps at a 150px source without horizontal overflow", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 960 });
  await seedStudioSession(page);
  await page.goto("/studio");
  if (await page.locator("#first-run-done").isVisible()) await page.locator("#first-run-done").click();

  await page.locator("#preview-size-preset").selectOption("custom");
  await page.locator("#preview-custom-width").fill("150");
  await page.locator("#preview-custom-height").fill("1000");
  await page.locator("#preview-custom-apply").click();

  const chat = page.frameLocator("#studio-preview").locator("#chat");
  const row = chat.locator(".chat-line").filter({ hasText: "supercalifragilisticexpialidocious" });
  await expect(row).toBeVisible();
  const layout = await row.evaluate((line) => {
    const message = line.querySelector<HTMLElement>(".chat-message")!;
    return {
      lineWidth: line.clientWidth,
      lineScrollWidth: line.scrollWidth,
      messageWidth: message.clientWidth,
      messageScrollWidth: message.scrollWidth,
      sourceWidth: document.documentElement.scrollWidth,
    };
  });
  expect(layout.lineScrollWidth).toBeLessThanOrEqual(layout.lineWidth);
  expect(layout.messageScrollWidth).toBeLessThanOrEqual(layout.messageWidth);
  expect(layout.sourceWidth).toBeLessThanOrEqual(150);
});
