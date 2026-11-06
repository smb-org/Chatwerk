import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { seedStudioSession, setRange } from "./studio-session";

async function frameSize(page: Page): Promise<{ width: number; height: number }> {
  return page.frameLocator("#studio-preview").locator("body").evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

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
  await expect(effects.getByRole("checkbox", { name: "Chatterino Homies badges" })).not.toBeChecked();
  const messages = page.locator('.settings-group[data-group="Messages"]');
  await expect(messages.getByRole("checkbox", { name: "Name on own line" })).not.toBeChecked();
  await expect(messages.getByRole("checkbox", { name: "Hide names" })).not.toBeChecked();
  await expect(messages.getByRole("checkbox", { name: "Readable names" })).not.toBeChecked();
  await expect(page.locator("#theme-textShadow-readout")).toHaveText("0px");
  await expect(page.getByRole("checkbox", { name: "Small caps" })).not.toBeChecked();
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
  const ownLine = messages.getByRole("checkbox", { name: "Name on own line" });
  await ownLine.check();
  const previewLine = page.frameLocator("#studio-preview").locator(".chat-line").first();
  await page.locator('input[name="theme-layout"][value="ticker"]').check();
  await expect(page.locator("#theme-maxLines")).toBeDisabled();
  await expect(page.locator("#theme-maxChatHeight")).toBeDisabled();
  await expect(lifetime).toBeEnabled();
  await expect(neverFade).toBeDisabled();
  await expect(ownLine).toBeDisabled();
  await expect(previewLine).not.toHaveClass(/chat-name-own-line/u);
  await page.locator('input[name="theme-layout"][value="stack"]').check();
  await expect(lifetime).toBeDisabled();
  await expect(neverFade).toBeEnabled();
  await expect(ownLine).toBeEnabled();
  await expect(previewLine).toHaveClass(/chat-name-own-line/u);
  await neverFade.uncheck();
  await ownLine.uncheck();
  await setRange(page, "maxChatHeight", 200);
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 200 });
  await expect(page.locator("#theme-maxChatHeight-readout")).toHaveText("200px");
  await expect(page.locator("#status-visible")).toContainText("Saved");

  const shots = path.resolve(".tmp/shots");
  await mkdir(shots, { recursive: true });
  const settingsScroll = page.locator("#settings-scroll");
  const textGroup = page.locator('.settings-group[data-group="Text"]');
  const readableNamesControl = messages.getByRole("checkbox", { name: "Readable names" });
  for (const width of [1_024, 1_440]) {
    await page.setViewportSize({ width, height: 900 });
    await settingsScroll.evaluate((element) => { element.scrollTop = 0; });
    await expect(textGroup).toBeVisible();
    await expect(textGroup.getByRole("slider", { name: "Text shadow" })).toBeVisible();
    await page.screenshot({ path: path.join(shots, `studio-display-controls-${width}.png`) });
    await textGroup.screenshot({ path: path.join(shots, `studio-text-controls-${width}.png`) });
    await readableNamesControl.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, `studio-message-controls-${width}.png`) });
    await panel.scrollIntoViewIfNeeded();
    await panel.screenshot({ path: path.join(shots, `studio-panel-controls-${width}.png`) });
    await effects.scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(shots, `studio-display-effects-${width}.png`) });
  }

  await setRange(page, "maxChatHeight", 0);
  await page.locator("#preview-size-preset").selectOption("400x600");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 600 });
  await page.locator("#studio-preview").evaluate((frame) => { (frame as HTMLIFrameElement).style.height = "5000px"; });
  await page.locator("#rehearse-flood").click();
  const sample = page.frameLocator("#studio-preview");
  await expect(sample.locator(".chat-line")).toHaveCount(100, { timeout: 8_000 });
});

test("follows the theme height limit, then keeps a selected 600px frame with full-frame reactions", async ({ page }) => {
  test.setTimeout(30_000);
  await seedStudioSession(page);
  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await setRange(page, "maxChatHeight", 200);
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 200 });
  await page.locator("#preview-size-preset").selectOption("400x600");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 600 });
  await setRange(page, "textShadow", 4);
  await setRange(page, "backgroundOpacity", 0.5);
  await page.locator("#theme-backgroundColor-hex").fill("#090515");
  await page.getByRole("checkbox", { name: "Small caps" }).check();
  await page.getByRole("checkbox", { name: "Name on own line" }).check();
  await page.getByRole("checkbox", { name: "Readable names" }).check();
  await page.locator('input[name="theme-lineOrder"][value="name-first"]').check();
  const featureOverlay = page.frameLocator("#studio-preview");
  const featureChat = featureOverlay.locator("#chat");
  await expect(featureChat.locator(".chat-line").first()).toBeVisible();
  const featureStyle = await featureChat.evaluate((element) => {
    const line = element.querySelector<HTMLElement>(".chat-line")!;
    const name = line.querySelector<HTMLElement>(".chat-name")!;
    const messageNode = line.querySelector<HTMLElement>(".chat-message")!;
    const meta = line.querySelector<HTMLElement>(".chat-meta")!.getBoundingClientRect();
    const message = messageNode.getBoundingClientRect();
    return {
      frame: { width: innerWidth, height: innerHeight },
      overflow: getComputedStyle(element).overflow,
      shadow: getComputedStyle(line).textShadow,
      caps: getComputedStyle(name).fontVariantCaps,
      messageCaps: getComputedStyle(messageNode).fontVariantCaps,
      ownLine: line.classList.contains("chat-name-own-line"),
      nameAboveMessage: meta.top < message.top,
    };
  });
  expect(featureStyle).toEqual({
    frame: { width: 400, height: 600 },
    overflow: "clip",
    shadow: expect.not.stringMatching(/^none$/u),
    caps: "small-caps",
    messageCaps: "small-caps",
    ownLine: true,
    nameAboveMessage: true,
  });
  const shots = path.resolve(".tmp/shots");
  await mkdir(shots, { recursive: true });
  await page.locator("#preview-one-to-one").click();
  await expect(page.locator("#preview-one-to-one")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => featureChat.evaluate((element) => [
    Math.round(element.ownerDocument.defaultView!.innerWidth),
    Math.round(element.ownerDocument.defaultView!.innerHeight),
  ])).toEqual([400, 600]);
  const paintStyle = await featureChat.evaluate((element) => {
    const line = element.querySelector<HTMLElement>(".chat-line")!;
    const name = line.querySelector<HTMLElement>(".chat-name")!;
    name.classList.add("chat-name-painted");
    name.style.setProperty("color", "transparent");
    name.style.setProperty("background-image", "linear-gradient(90deg, #fa376d, #48d7ff)");
    name.style.setProperty("background-clip", "text");
    name.style.setProperty("-webkit-background-clip", "text");
    name.style.setProperty("filter", "drop-shadow(1px 1px 3px #000)");
    const unpaintedLine = line.cloneNode(false) as HTMLElement;
    unpaintedLine.removeAttribute("id");
    const unpaintedName = element.ownerDocument.createElement("span");
    unpaintedName.className = "chat-name";
    unpaintedName.textContent = "Unpainted name";
    unpaintedLine.appendChild(unpaintedName);
    element.appendChild(unpaintedLine);
    return {
      paintedShadow: getComputedStyle(name).textShadow,
      paintFilter: getComputedStyle(name).filter,
      unpaintedShadow: getComputedStyle(unpaintedName).textShadow,
      gradientClip: getComputedStyle(name).backgroundClip,
    };
  });
  expect(paintStyle.paintedShadow).toBe("none");
  expect(paintStyle.paintFilter).toContain("drop-shadow");
  expect(paintStyle.unpaintedShadow).not.toBe("none");
  expect(paintStyle.gradientClip).toBe("text");
  await featureChat.screenshot({ path: path.join(path.resolve(".tmp/shots"), "overlay-gradient-name-shadow-400x600.png") });
  await featureChat.locator(".chat-line").filter({ hasText: "Unpainted name" }).evaluate((line) => line.remove());

  const hiddenMetadata = await featureChat.evaluate((element) => {
    const line = element.querySelector<HTMLElement>(".chat-line")!;
    const meta = line.querySelector<HTMLElement>(".chat-meta")!;
    const name = meta.querySelector<HTMLElement>(".chat-name")!;
    meta.querySelector(".chat-badges")?.replaceChildren();
    meta.querySelector<HTMLElement>(".chat-pronouns")!.textContent = "";
    meta.querySelector<HTMLElement>(".chat-source-room")!.textContent = "";
    meta.querySelector<HTMLElement>(".chat-source-channel")!.hidden = true;
    line.classList.add("chat-name-own-line", "chat-hide-names");
    name.classList.add("chat-sr-only");
    const ownLineHeight = line.getBoundingClientRect().height;
    const metaDisplay = getComputedStyle(meta).display;
    line.classList.remove("chat-name-own-line");
    return { ownLineHeight, normalHeight: line.getBoundingClientRect().height, metaDisplay, name: name.textContent };
  });
  expect(hiddenMetadata.metaDisplay).toBe("contents");
  expect(hiddenMetadata.name).toBeTruthy();
  expect(hiddenMetadata.ownLineHeight).toBe(hiddenMetadata.normalHeight);

  await featureOverlay.locator("body").screenshot({ path: path.join(shots, "overlay-display-features-400x600.png") });
  await page.getByRole("checkbox", { name: "Hide names" }).check();
  await expect(featureOverlay.locator(".chat-name").first()).toHaveClass(/chat-sr-only/u);
  await featureOverlay.locator("body").screenshot({ path: path.join(shots, "overlay-hidden-names-400x600.png") });
  await page.getByRole("checkbox", { name: "Hide names" }).uncheck();
  await page.locator('input[name="theme-lineOrder"][value="message-first"]').check();
  await page.locator("#theme-panelEnabled").check();
  const overlay = featureOverlay;
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

  await overlay.locator("body").screenshot({ path: path.join(shots, "overlay-height-200-raid.png") });

  const beforeResize = await chat.locator(".chat-line").count();
  await page.locator("#studio-preview").evaluate((frame) => { (frame as HTMLIFrameElement).style.height = "120px"; });
  await expect.poll(() => chat.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(120);
  expect(await chat.locator(".chat-line").count()).toBeLessThanOrEqual(beforeResize);
  await setRange(page, "maxChatHeight", 40);
  await expect.poll(() => chat.evaluate((element) => Math.round(element.getBoundingClientRect().height))).toBe(40);
  await expect.poll(() => chat.locator(".chat-line").count()).toBe(1);

  await setRange(page, "maxChatHeight", 100);
  const tallLine = await chat.evaluate((element) => {
    const line = element.querySelector<HTMLElement>(".chat-line")!;
    line.querySelector<HTMLElement>(".chat-message")!.textContent = "W".repeat(12_000);
    const chatStyle = getComputedStyle(element);
    return {
      chatHeight: element.getBoundingClientRect().height,
      lineHeight: line.getBoundingClientRect().height,
      overflow: chatStyle.overflow,
      clipMargin: chatStyle.overflowClipMargin,
    };
  });
  expect(tallLine.chatHeight).toBe(100);
  expect(tallLine.lineHeight).toBeGreaterThan(100);
  expect(tallLine.overflow).toBe("clip");
  expect(tallLine.clipMargin).toBe("10px");
});
