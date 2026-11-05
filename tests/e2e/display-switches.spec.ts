import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { seedStudioSession, setRange } from "./studio-session";

test("shows display controls, disables dependent fields, and captures Studio at both widths", async ({ page }) => {
  await seedStudioSession(page);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText("Saved");
  await page.locator("#first-run-done").click();

  const effects = page.locator('.settings-group[data-group="Emotes & Effects"]');
  await expect(effects.getByRole("checkbox", { name: "7TV emotes" })).toBeChecked();
  await expect(effects.getByRole("checkbox", { name: "BTTV emotes" })).toBeChecked();
  await expect(effects.getByRole("checkbox", { name: "FFZ emotes" })).toBeChecked();
  await expect(effects.getByRole("checkbox", { name: "7TV paints" })).toBeChecked();
  for (const label of ["7TV badges", "BTTV badges", "FFZ badges", "Chatterino badges"]) {
    await expect(effects.getByRole("checkbox", { name: label })).toBeChecked();
  }
  const messages = page.locator('.settings-group[data-group="Messages"]');
  await expect(messages.getByRole("checkbox", { name: "Load recent messages" })).toBeChecked();
  await expect(messages.locator(".control-hint")).toContainText("Ticker skips recent messages");
  const panel = page.locator('.settings-group[data-group="Panel"]');
  const panelToggle = panel.getByRole("checkbox", { name: "Panel" });
  await expect(panelToggle).not.toBeChecked();
  for (const field of ["panelBackgroundColor", "panelBackgroundOpacity", "panelBorderWidth", "panelBorderColor", "panelRadius", "panelPadding"]) {
    await expect.poll(() => page.locator(`[data-theme-field="${field}"] input`).evaluateAll((inputs) =>
      inputs.every((input) => (input as HTMLInputElement).disabled))).toBe(true);
  }
  await panelToggle.check();
  await expect(page.locator('#theme-panelBorderColor-color')).toBeEnabled();
  await panelToggle.uncheck();
  await expect(page.locator("#theme-maxChatHeight-readout")).toHaveText("Full height");

  const neverFade = page.getByRole("checkbox", { name: "Never expire" });
  const lifetime = page.locator("#theme-lifetime");
  await neverFade.check();
  await expect(lifetime).toBeDisabled();
  await neverFade.uncheck();
  await expect(lifetime).toBeEnabled();

  await neverFade.check();
  await page.locator('input[name="theme-layout"][value="ticker"]').check();
  await expect(page.locator("#theme-maxLines")).toBeDisabled();
  await expect(page.locator("#theme-maxChatHeight")).toBeDisabled();
  await expect(lifetime).toBeEnabled();
  await expect(neverFade).toBeDisabled();
  await page.locator('input[name="theme-layout"][value="stack"]').check();
  await expect(lifetime).toBeDisabled();
  await expect(neverFade).toBeEnabled();
  await neverFade.uncheck();
  await setRange(page, "maxChatHeight", 200);
  await expect(page.locator("#theme-maxChatHeight-readout")).toHaveText("200px");
  await expect(page.locator("#status-visible")).toContainText("Saved");

  const shots = path.resolve(".tmp/shots");
  await mkdir(shots, { recursive: true });
  for (const width of [1_024, 1_440]) {
    await page.setViewportSize({ width, height: 900 });
    await page.locator("#theme-maxChatHeight").scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, `studio-display-controls-${width}.png`) });
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.join(shots, `studio-panel-controls-${width}.png`) });
    await effects.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, `studio-display-effects-${width}.png`) });
  }

  await setRange(page, "maxChatHeight", 0);
  await page.locator("#studio-preview").evaluate((frame) => { (frame as HTMLIFrameElement).style.height = "5000px"; });
  await page.locator("#rehearse-flood").click();
  const sample = page.frameLocator("#studio-preview");
  await expect(sample.locator(".chat-line")).toHaveCount(100, { timeout: 8_000 });
});

test("keeps the 400 by 600 frame, limits chat to 200px, and leaves reactions full-frame", async ({ page }) => {
  test.setTimeout(30_000);
  await seedStudioSession(page);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await setRange(page, "maxChatHeight", 200);
  await page.locator('input[name="theme-lineOrder"][value="message-first"]').check();
  await page.locator("#theme-panelEnabled").check();
  const overlay = page.frameLocator("#studio-preview");
  const chat = overlay.locator("#chat");
  const defaultBoxStyle = await chat.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      borderWidth: style.borderTopWidth,
      padding: style.paddingTop,
      radius: style.borderTopLeftRadius,
      linePadding: style.getPropertyValue("--t-line-padding").trim(),
      panelEnabled: element.dataset.panelEnabled,
    };
  });
  expect(defaultBoxStyle).toEqual({ borderWidth: "0px", padding: "0px", radius: "0px", linePadding: "0px", panelEnabled: "false" });
  await expect(chat).toHaveAttribute("data-height-limited", "true");
  await page.locator("#rehearse-raid").click();
  await expect(overlay.locator(".reaction-burst")).toHaveCount(1, { timeout: 5_000 });
  await expect(chat).toContainText("Welcome, everyone!", { timeout: 5_000 });

  const geometry = await chat.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const lines = [...element.querySelectorAll(".chat-line")].map((line) => {
      const rect = line.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    const layer = element.ownerDocument.querySelector(".reaction-layer")!.getBoundingClientRect();
    return {
      chat: { top: box.top, bottom: box.bottom, height: box.height },
      frame: { width: innerWidth, height: innerHeight },
      lines,
      layer: { top: layer.top, bottom: layer.bottom, width: layer.width, height: layer.height },
    };
  });
  expect(geometry.frame).toEqual({ width: 400, height: 600 });
  expect(geometry.chat.height).toBe(200);
  expect(geometry.chat.bottom).toBe(600);
  expect(geometry.lines.length).toBeGreaterThan(0);
  expect(geometry.lines.every((line) => line.top >= geometry.chat.top && line.bottom <= geometry.chat.bottom)).toBe(true);
  expect(geometry.layer).toEqual({ top: 0, bottom: 600, width: 400, height: 600 });

  await page.locator("#rehearse-flood").click();
  await expect.poll(() => chat.locator(".chat-line").count()).toBeLessThan(100);
  const panelGeometry = await chat.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const inset = Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
    const bottomInset = Number.parseFloat(style.borderBottomWidth) + Number.parseFloat(style.paddingBottom);
    const lines = [...element.querySelectorAll<HTMLElement>(".chat-line")].map((line) => {
      const rect = line.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    return { top: box.top + inset, bottom: box.bottom - bottomInset, lines };
  });
  expect(panelGeometry.lines.length).toBeGreaterThan(0);
  expect(panelGeometry.lines.every((line) => line.top >= panelGeometry.top - 0.5 && line.bottom <= panelGeometry.bottom + 0.5)).toBe(true);

  const shots = path.resolve(".tmp/shots");
  await mkdir(shots, { recursive: true });
  await overlay.locator("body").screenshot({ path: path.join(shots, "overlay-height-200-raid.png") });

  const beforeResize = await chat.locator(".chat-line").count();
  await page.locator("#studio-preview").evaluate((frame) => { (frame as HTMLIFrameElement).style.height = "120px"; });
  await expect.poll(() => chat.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(120);
  expect(await chat.locator(".chat-line").count()).toBeLessThanOrEqual(beforeResize);
  await setRange(page, "maxChatHeight", 40);
  await expect.poll(() => chat.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(40);
  await expect.poll(() => chat.locator(".chat-line").count()).toBe(1);
});
