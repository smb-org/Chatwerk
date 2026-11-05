import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { DEFAULTS } from "../../src/shared/theme";
import { addStudioLook, addStudioOverlay, seedStudioSession, e2eOrigin, setRange } from "./studio-session";

interface IrcTrace {
  joins: string[];
  parts: string[];
  closes: number;
}

async function routeIrc(page: Page, trace: IrcTrace, sendPreviewMessages = true): Promise<void> {
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const line = String(message);
      if (line.startsWith("JOIN #")) {
        const channel = line.slice("JOIN #".length).trim().toLowerCase();
        trace.joins.push(channel);
        socket.send(`:tmi.twitch.tv ROOMSTATE #${channel}`);
        if (sendPreviewMessages) {
          socket.send(`@id=preview-${channel};display-name=PreviewViewer :previewviewer!previewviewer@host PRIVMSG #${channel} :mock preview line`);
        }
      } else if (line.startsWith("PART #")) {
        trace.parts.push(line.slice("PART #".length).trim().toLowerCase());
      }
    });
    socket.onClose(() => { trace.closes += 1; });
  });
}

function trace(): IrcTrace {
  return { joins: [], parts: [], closes: 0 };
}

test("channel popover is anchored, does not move the page, and closes with focus restored", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");

  const workspace = page.locator("#workspace");
  const before = await workspace.boundingBox();
  const field = page.locator("#channel-field-button");
  await field.focus();
  await page.keyboard.press("Enter");
  const popover = page.locator("#channel-popover");
  await expect(popover).toBeVisible();
  const after = await workspace.boundingBox();
  const popupBox = await popover.boundingBox();
  const fieldBox = await field.boundingBox();
  expect(after).toEqual(before);
  expect(popupBox!.x).toBeGreaterThanOrEqual(fieldBox!.x - 1);
  expect(popupBox!.y).toBeGreaterThan(fieldBox!.y);
  await expect(page.locator("[data-channel-new]")).toBeFocused();
  await page.locator("[data-channel-new]").fill("draftroom");

  await page.keyboard.press("Escape");
  await expect(popover).toBeHidden();
  await expect(field).toBeFocused();
  await field.click();
  await expect(popover).toBeVisible();
  await expect(page.locator("[data-channel-new]")).toHaveValue("draftroom");
  await page.locator("#preview-window").click({ position: { x: 20, y: 80 } });
  await expect(popover).toBeHidden();
  await expect(field).toBeFocused();
});

test("tokened overlays join on initial config and receive a header channel edit without reload", async ({ page }) => {
  const identity = await seedStudioSession(page, { channel: "" });
  const irc = trace();
  await routeIrc(page, irc);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");

  const overlayPage = await page.context().newPage();
  await routeIrc(overlayPage, irc);
  await overlayPage.goto(`/overlay#token=${identity.token}`);
  await expect(overlayPage.locator("#chat")).toBeVisible();
  await expect.poll(() => irc.joins).toEqual([]);
  const overlayUrl = overlayPage.url();

  await page.locator("#channel-field-button").click();
  await page.locator("[data-channel-new]").fill("secondroom");
  await page.locator("[data-channel-add]").click();
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1", { timeout: 5_000 });
  await expect.poll(() => irc.joins).toContain("secondroom");
  expect(overlayPage.url()).toBe(overlayUrl);

  await page.locator("#preview-mode-live").click();
  await expect(page.locator("#preview-mode-live")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#rehearse-quiet")).toBeDisabled();
  await expect.poll(() => irc.joins.filter((channel) => channel === "secondroom").length).toBeGreaterThan(1);
  const previewLines = page.frameLocator("#studio-preview").locator(".chat-line");
  await expect(previewLines).toHaveCount(1);
  await setRange(page, "fontSize", 24);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2", { timeout: 5_000 });
  await expect(previewLines).toHaveCount(1);
  expect(await page.locator("#live-chat").count()).toBe(0);
  const mode = await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-live-mode:${overlayId}`), identity.overlayId);
  expect(mode).toBe("1");

  const closesBeforeSample = irc.closes;
  await page.locator("#preview-mode-sample").click();
  await expect(page.locator("#preview-mode-sample")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => irc.closes).toBeGreaterThan(closesBeforeSample);
  await page.locator("#preview-mode-live").click();
  const joinsBeforeReload = irc.joins.length;
  await page.reload();
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2");
  await expect(page.locator("#preview-mode-live")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => irc.joins.length).toBeGreaterThan(joinsBeforeReload);

  await overlayPage.close();
});

test("live without a channel shows the header hint and rehearsal stays unavailable", async ({ page }) => {
  await seedStudioSession(page, { channel: "" });
  const irc = trace();
  await routeIrc(page, irc);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await page.locator("#preview-mode-live").click();
  await expect(page.locator("#live-no-channel-message")).toHaveText("No channel set. Add one using the Channel field above.");
  await expect(page.locator("#channel-field-button")).toHaveAttribute("data-empty", "true");
  const [channelColor, warningColor] = await page.evaluate(() => {
    const fieldColor = getComputedStyle(document.querySelector("#channel-field-button")!).color;
    const reference = document.createElement("span");
    reference.style.color = "var(--ui-danger)";
    document.body.appendChild(reference);
    const dangerColor = getComputedStyle(reference).color;
    reference.remove();
    return [fieldColor, dangerColor];
  });
  expect(channelColor).toBe(warningColor);
  await expect(page.locator("#rehearse-quiet")).toBeDisabled();
  expect(irc.joins).toEqual([]);

  await page.evaluate(() => localStorage.setItem("chatwerk-language", "de"));
  await page.reload();
  await expect(page.locator("#status-visible")).toHaveText("Gespeichert, Rev. 0");
  await page.locator("#preview-mode-live").click();
  await expect(page.locator("#live-no-channel-message")).toHaveText("Kein Kanal festgelegt. Füge oben über das Kanalfeld einen hinzu.");
  await expect(page.locator("#preview-mode-sample")).toHaveText("Beispiel");
});

test("header channel shows the effective list and the editor validates its five channel limit", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const response = await page.request.put(`${e2eOrigin}/api/overlays/${identity.overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision: 0, patch: { channels: ["alpha", "beta", "gamma"] } },
  });
  expect(response.status()).toBe(200);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  await expect(page.locator("#channel-field-text")).toHaveText("Channel: alpha");
  await expect(page.locator("#channel-field-count")).toHaveText("+2");
  await expect(page.locator("#channel-field-button")).toHaveAttribute("aria-label", "Channel: alpha, +2. Edit channels");

  await page.locator("#channel-field-button").click();
  await page.locator("[data-channel-new]").fill("alpha");
  await page.locator("[data-channel-add]").click();
  await expect(page.locator("[data-channel-new]")).toHaveAttribute("aria-invalid", "true");
  await page.locator("[data-channel-new]").fill("delta");
  await page.locator("[data-channel-add]").click();
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2");
  await page.locator("[data-channel-new]").fill("fifth");
  await page.locator("[data-channel-add]").click();
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 3");
  await expect(page.locator("[data-channel-add]")).toBeDisabled();
  await expect(page.locator("#channel-field-count")).toHaveText("+4");
});

test("the header overlay select switches overlays and fits at 1024 pixels", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Vertical", "vertical_room");
  const irc = trace();
  await routeIrc(page, irc);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  const select = page.locator("#active-overlay-select");
  await expect(select).toBeVisible();
  await expect(select.locator("option")).toHaveCount(2);
  await page.locator("#preview-mode-live").click();
  await expect(page.locator("#preview-mode-live")).toHaveAttribute("aria-pressed", "true");
  await select.selectOption({ label: "Vertical" });
  await expect(page.locator("#channel-field-button")).toContainText("vertical_room");
  await expect(page.locator("#preview-mode-sample")).toHaveAttribute("aria-pressed", "true");
  await page.locator("#preview-mode-live").click();
  await select.selectOption({ label: "Main" });
  await expect(page.locator("#preview-mode-live")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => irc.joins).toContain(identity.login);
  await expect(page.frameLocator("#studio-preview").locator(".chat-line")).toHaveCount(1);
  const closesBeforeLiveSwitch = irc.closes;
  const verticalJoinsBeforeSwitch = irc.joins.filter((channel) => channel === "vertical_room").length;
  await select.selectOption({ label: "Vertical" });
  await expect(page.locator("#preview-mode-live")).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => irc.closes).toBeGreaterThan(closesBeforeLiveSwitch);
  await expect.poll(() => irc.joins.filter((channel) => channel === "vertical_room").length).toBeGreaterThan(verticalJoinsBeforeSwitch);
  await expect(page.frameLocator("#studio-preview").locator(".chat-line")).toHaveCount(1);
  await expect(select).toHaveValue(/.+/u);
  await expect(page.locator("#active-overlay-name")).toContainText("Vertical");
  await expect(page.locator("#live-chat")).toHaveCount(0);
  const headerBounds = await page.locator(".studio-header").boundingBox();
  expect(headerBounds?.width).toBe(1024);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(1024);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#channel-field-button").click();
  const mobilePopover = await page.locator("#channel-popover").boundingBox();
  expect(mobilePopover!.x).toBeGreaterThanOrEqual(0);
  expect(mobilePopover!.x + mobilePopover!.width).toBeLessThanOrEqual(390);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
});

test("a late config response from an earlier visit cannot replace the same overlay after switching back", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const stream = addStudioOverlay(identity.ownerId, "Stream", "stream_room");
  const streamConfig = await page.request.put(`${e2eOrigin}/api/overlays/${stream.overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision: 0, patch: { fontSize: 28 } },
  });
  expect(streamConfig.status()).toBe(200);
  let releaseInitialMain!: () => void;
  let markInitialMainCaptured!: () => void;
  let heldInitialMain = false;
  const initialMainGate = new Promise<void>((resolve) => { releaseInitialMain = resolve; });
  const initialMainCaptured = new Promise<void>((resolve) => { markInitialMainCaptured = resolve; });
  await page.route("**/api/overlay/config", async (route) => {
    if (!heldInitialMain && route.request().headers().authorization === `Bearer ${identity.token}`) {
      heldInitialMain = true;
      const response = await route.fetch();
      const snapshot = await response.json() as { revision: number; config: Record<string, unknown> };
      markInitialMainCaptured();
      await initialMainGate;
      await route.fulfill({ response, json: { ...snapshot, config: { ...snapshot.config, fontSize: 60 } } });
      return;
    }
    await route.continue();
  });
  await page.goto("/studio");
  const select = page.locator("#active-overlay-select");
  await expect(select).toBeVisible();
  await initialMainCaptured;

  await select.selectOption({ label: "Stream" });
  await expect(page.locator("#theme-fontSize")).toHaveValue("28");
  await select.selectOption({ label: "Main" });
  await expect(select).toHaveValue(identity.overlayId);
  await expect(page.locator("#theme-fontSize")).toHaveValue("18");
  const lateMainResponse = page.waitForResponse((response) =>
    response.request().headers().authorization === `Bearer ${identity.token}`);
  releaseInitialMain();
  await lateMainResponse;
  await expect(page.locator("#theme-fontSize")).toHaveValue("18");
  await expect(page.locator("#active-overlay-select")).toHaveValue(identity.overlayId);
});

test("themes and public look pages use the same active overlay selector", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Vertical", "vertical_room");
  const look = addStudioLook(identity.ownerId, "Slate", DEFAULTS);

  await page.goto("/themes");
  const select = page.locator("#active-overlay-select");
  await expect(select).toBeVisible();
  await select.selectOption({ label: "Vertical" });
  await expect(page.locator("#active-overlay-name")).toContainText("Vertical");

  await page.goto(`/t/${look.slug}`);
  await expect(page.locator("#active-overlay-select")).toBeVisible();
  await expect(page.locator("#active-overlay-select")).toHaveValue(/.+/u);
  await expect(page.locator("#active-overlay-name")).toContainText("Vertical");
});

test("captures the requested Studio states at desktop and narrow desktop widths", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Vertical", "vertical_room");
  const irc = trace();
  await routeIrc(page, irc, false);
  const shots = path.resolve(".tmp/shots");
  await mkdir(shots, { recursive: true });

  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/studio");
    await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
    const width = viewport.width;
    await page.locator("#channel-field-button").click();
    await expect(page.locator("#channel-popover")).toBeVisible();
    await page.screenshot({ path: path.join(shots, `studio-${width}-popover.png`) });
    await page.keyboard.press("Escape");

    await page.locator("#preview-mode-live").click();
    await expect(page.locator("#preview-mode-live")).toHaveAttribute("aria-pressed", "true");
    await expect(page.frameLocator("#studio-preview").locator(".chat-line")).toHaveCount(0);
    await page.screenshot({ path: path.join(shots, `studio-${width}-live.png`) });

    await page.locator("#active-overlay-select").selectOption({ label: "Vertical" });
    await expect(page.locator("#active-overlay-name")).toContainText("Vertical");
    await page.screenshot({ path: path.join(shots, `studio-${width}-two-overlays.png`) });
  }

  expect(irc.joins.length).toBeGreaterThan(0);
  expect(page.url()).toBe(`${e2eOrigin}/studio`);
});
