import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { mintSessionCookie } from "../worker/worker-test-helpers";
import { TEST_SESSION_KEY } from "./test-session";
import { addStudioEditor, addStudioOverlay, seedStudioSession, selectSettingsTabForField, setRange, setThemeChecked, setThemeChoice } from "./studio-session";

const shots = ".tmp/shots";
const statusResponse = (role: "owner" | "editor", connected: boolean, ownerLogin: string) => ({ role, connected, ownerLogin });

test("Hype Train rehearsal shows the frame ring and chip, then clears", async ({ page }) => {
  test.setTimeout(40_000);
  mkdirSync(shots, { recursive: true });
  const identity = await seedStudioSession(page);
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({ json: statusResponse("owner", false, identity.login) }));
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto("/studio?hypeTrain=denied");
  await expect(page).toHaveURL(/\/studio$/u);
  await expect(page.locator("#toast-text")).toHaveText("Hype Train permission was not granted.");
  await page.locator("#toast-close").click();
  await page.locator("#first-run-done").click();
  const preview = page.frameLocator("#studio-preview");
  const chat = preview.locator("#chat");
  await page.locator("#preview-size-preset").selectOption("400x600");
  await page.locator("#preview-one-to-one").click();
  await expect.poll(() => page.locator("#studio-preview").evaluate((frame) => {
    const rect = frame.getBoundingClientRect();
    return [rect.width, rect.height];
  })).toEqual([400, 600]);

  await page.locator("#rehearse-hype-train").click();
  const layer = preview.locator(".reaction-layer");
  await expect(layer).toHaveClass(/hype-train-active/u);
  const ring = await layer.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { content: style.content, width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor };
  });
  expect(ring.content).not.toBe("none");
  expect(ring.content).not.toBe("normal");
  expect(ring.width).toBe("2px");
  expect(ring.style).toBe("solid");
  expect(ring.color).not.toBe("rgba(0, 0, 0, 0)");
  await expect(preview.locator(".hype-train-chip")).toContainText("LV 1");
  await expect(chat.locator(".chat-line")).toHaveCount(3);
  const chatText = await chat.locator(".chat-line").evaluateAll((lines) => lines.map((line) => line.textContent ?? "").join(" "));
  expect(chatText).not.toContain("Hype Train");
  await chat.screenshot({ path: `${shots}/hype-active-400x600.png` });

  const geometry = await layer.evaluate((element) => {
    const frame = element.ownerDocument.querySelector("#chat")!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return { frame: [frame.width, frame.height], layer: [bounds.width, bounds.height], pointerEvents: getComputedStyle(element).pointerEvents };
  });
  expect(geometry.layer).toEqual(geometry.frame);
  expect(geometry.pointerEvents).toBe("none");

  await setRange(page, "maxChatHeight", 200);
  await expect(chat).toHaveAttribute("data-height-limited", "true");
  await page.locator("#rehearse-hype-train").click();
  await expect(preview.locator(".hype-train-chip")).toBeVisible();
  await setThemeChecked(page, "panelEnabled");
  await setThemeChoice(page, "layout", "ticker");
  await page.locator("#rehearse-hype-train").click();
  await expect(chat).toHaveAttribute("data-layout", "ticker");
  await expect(preview.locator(".hype-train-chip")).toBeVisible();

  await expect(preview.locator(".hype-train-chip")).toHaveCount(0, { timeout: 12_000 });
  await expect(layer).not.toHaveClass(/hype-train-active/u);
});

test("Studio shows owner connection states and the helper-only notice", async ({ page }) => {
  test.setTimeout(35_000);
  mkdirSync(shots, { recursive: true });
  const identity = await seedStudioSession(page);
  let role: "owner" | "editor" = "owner";
  let connected = false;
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({ json: statusResponse(role, connected, identity.login) }));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await selectSettingsTabForField(page, "reactionHypeTrain");
  const consent = page.locator("#hype-train-consent");
  await expect(consent).toHaveAttribute("data-state", "disconnected");
  await expect(consent.getByRole("button", { name: "Connect Hype Train" })).toBeVisible();
  await expect(consent.locator(".hype-consent-copy")).toHaveText("One-time Twitch permission for Hype Train events. Only consent is stored.");
  expect(await consent.locator(".hype-consent-copy").evaluate((copy) => copy.scrollHeight <= copy.clientHeight)).toBe(true);
  await page.locator(".account-menu > summary").click();
  await page.locator("#language-de").click();
  await expect(consent.locator(".hype-consent-copy")).toHaveText("Einmalige Twitch-Erlaubnis für Hype Trains. Gespeichert wird nur die Zustimmung.");
  expect(await consent.locator(".hype-consent-copy").evaluate((copy) => copy.scrollHeight <= copy.clientHeight)).toBe(true);
  await page.locator("#language-en").click();

  connected = true;
  await page.reload();
  await expect(consent).toHaveAttribute("data-state", "connected");
  await expect(consent.getByRole("status")).toHaveText("Connected");
  await expect(consent.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await page.screenshot({ path: `${shots}/hype-studio-owner.png`, fullPage: true });

  role = "editor";
  await page.reload();
  await expect(consent).toHaveAttribute("data-state", "helper");
  await expect(consent.getByText("Only the streamer can connect this overlay.")).toBeVisible();
  await expect(consent.locator("button")).toBeHidden();
  await page.screenshot({ path: `${shots}/hype-studio-helper.png`, fullPage: true });
});

test("foreign channels grey out Hype Train without changing its saved value", async ({ page }) => {
  test.setTimeout(45_000);
  mkdirSync(shots, { recursive: true });
  const identity = await seedStudioSession(page);
  const secondOverlay = addStudioOverlay(identity.ownerId, "Foreign", "another_channel");
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({ json: statusResponse("owner", false, identity.login) }));
  const configPatches: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT" || !/\/api\/overlays\/[0-9a-f-]+\/config$/u.test(new URL(request.url()).pathname)) return;
    const payload = request.postDataJSON() as { patch?: Record<string, unknown> };
    if (payload.patch) configPatches.push(payload.patch);
  });
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await selectSettingsTabForField(page, "reactionHypeTrain");
  await page.locator("#settings-scroll").locator('[data-theme-field="reactionHypeTrain"]').scrollIntoViewIfNeeded();
  const field = page.locator('[data-theme-field="reactionHypeTrain"]');
  const checkbox = page.locator("#theme-reactionHypeTrain");
  const rehearsal = page.locator("#rehearse-hype-train");
  const consent = page.locator("#hype-train-consent");
  const status = consent.getByRole("status");
  await expect(checkbox).toBeEnabled();
  await expect(rehearsal).toBeEnabled();
  await expect(checkbox).toBeChecked();
  const persistedBefore = await page.evaluate(async (token) => {
    const response = await fetch("/api/overlay/config", { headers: { Authorization: `Bearer ${token}` } });
    return await response.json() as { config: { reactionHypeTrain?: unknown } };
  }, identity.token);
  expect(persistedBefore.config.reactionHypeTrain).toBe(true);
  await setStudioChannel(page, "foreign_room");
  if (await page.locator("#channel-popover [data-channel-value]").count() > 1) {
    await page.locator('#channel-popover [data-channel-focus="remove-1"]').click();
  }
  await expect.poll(async () => {
    const response = await page.request.get("/api/overlay/config", { headers: { Authorization: `Bearer ${identity.token}` } });
    return (await response.json() as { config: { channels: string[] } }).config.channels;
  }).toEqual(["foreign_room"]);
  await expect(checkbox).toBeDisabled();
  await expect(checkbox).toBeChecked();
  await expect(rehearsal).toBeDisabled();
  await expect(status).toHaveText("Only works on your own channel.");
  await expect(consent.getByRole("button", { name: "Connect Hype Train" })).toBeDisabled();
  await expect(field).toHaveAttribute("data-disabled", "true");
  await expectStatusLineFits(status);
  expect(await consent.evaluate((element) => element.clientHeight)).toBe(80);
  expect(await status.evaluate((element) => element.clientHeight)).toBe(18);
  await expect(page.locator("#status-visible")).toHaveText(/^Saved, rev \d+$/u);
  await page.keyboard.press("Escape");
  await page.screenshot({ path: `${shots}/hype-foreign-channel.png`, fullPage: true });

  await page.locator(".account-menu > summary").click();
  await page.locator("#language-de").click();
  await expect(status).toHaveText("Funktioniert nur auf deinem eigenen Kanal.");
  await expectStatusLineFits(status);
  await page.locator("#language-en").click();

  await addStudioChannel(page, identity.login.toUpperCase());
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await expect(rehearsal).toBeEnabled();
  await page.keyboard.press("Escape");
  await page.locator("#preview-mode-live").click();
  await expect(rehearsal).toBeDisabled();
  await removeStudioChannel(page, 1);
  await page.keyboard.press("Escape");
  await expect(status).toHaveText("Only works on your own channel.");
  await expect(checkbox).toBeDisabled();
  await expect(rehearsal).toBeDisabled();
  await page.locator("#preview-mode-sample").click();
  await expect(checkbox).toBeDisabled();
  await expect(rehearsal).toBeDisabled();

  await setStudioChannel(page, identity.login.toUpperCase());
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();
  await expect(rehearsal).toBeEnabled();
  await expect(page.locator("#status-visible")).toHaveText(/^Saved, rev \d+$/u);
  await expect(page.locator("#active-overlay-select")).toBeVisible();
  await page.locator("#active-overlay-select").selectOption(secondOverlay.overlayId);
  await expect(checkbox).toBeDisabled();
  await expect(status).toHaveText("Only works on your own channel.");
  await page.locator("#active-overlay-select").selectOption(identity.overlayId);
  await expect(checkbox).toBeEnabled();
  await expect(checkbox).toBeChecked();

  const persisted = await page.evaluate(async (token) => {
    const response = await fetch("/api/overlay/config", { headers: { Authorization: `Bearer ${token}` } });
    return await response.json() as { config: { reactionHypeTrain?: unknown } };
  }, identity.token);
  expect(persisted.config.reactionHypeTrain).toBe(persistedBefore.config.reactionHypeTrain);
  expect(configPatches.filter((patch) => Object.hasOwn(patch, "reactionHypeTrain"))).toEqual([]);
});

test("Hype Train state follows another editor's channel update and keeps Disconnect usable", async ({ page, browser }) => {
  test.setTimeout(45_000);
  const identity = await seedStudioSession(page);
  const editor = addStudioEditor(identity.overlayId);
  let connected = true;
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({ json: statusResponse("owner", connected, identity.login) }));
  let disconnectRequests = 0;
  await page.route("**/api/hype-train/disconnect", async (route) => {
    disconnectRequests += 1;
    connected = false;
    await route.fulfill({ json: { connected: false } });
  });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await selectSettingsTabForField(page, "reactionHypeTrain");
  const checkbox = page.locator("#theme-reactionHypeTrain");
  const consent = page.locator("#hype-train-consent");
  const status = consent.getByRole("status");
  await expect(checkbox).toBeEnabled();

  const editorContext = await browser.newContext({ ignoreHTTPSErrors: true });
  try {
    const editorCookie = await mintSessionCookie(TEST_SESSION_KEY, editor.userId);
    await editorContext.addCookies([{
      name: "session", value: editorCookie.slice("session=".length), url: new URL(page.url()).origin,
      httpOnly: true, secure: true, sameSite: "Lax",
    }]);
    const editorPage = await editorContext.newPage();
    await editorPage.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({ json: statusResponse("editor", false, identity.login) }));
    await editorPage.goto(new URL("/studio", page.url()).toString());
    await editorPage.locator("#first-run-done").click();
    await selectSettingsTabForField(editorPage, "reactionHypeTrain");
    await expect(editorPage.locator("#theme-reactionHypeTrain")).toBeEnabled();

    expect(await updateChannelsAsEditor(editorPage, identity.overlayId, identity.token, ["foreign_room"])).toBe(200);
    await expect(checkbox).toBeDisabled();
    await expect(status).toHaveText("Only works on your own channel.");
    const editorStatus = editorPage.locator("#hype-train-consent").getByRole("status");
    await expect(editorStatus).toHaveText("Only works on the streamer's own channel.");
    await expectStatusLineFits(editorStatus);
    await expect(editorPage.locator("#theme-reactionHypeTrain")).toBeDisabled();
    await editorPage.locator(".account-menu > summary").click();
    await editorPage.locator("#language-de").click();
    await expect(editorStatus).toHaveText("Funktioniert nur auf dem Kanal des Streamers.");
    await expectStatusLineFits(editorStatus);

    const disconnect = consent.getByRole("button", { name: "Disconnect" });
    await expect(disconnect).toBeEnabled();
    await disconnect.click();
    await expect.poll(() => disconnectRequests).toBe(1);
    await expect(consent.getByRole("button", { name: "Connect Hype Train" })).toBeDisabled();

    expect(await updateChannelsAsEditor(editorPage, identity.overlayId, identity.token, ["foreign_room", identity.login.toUpperCase()])).toBe(200);
    await expect(checkbox).toBeEnabled();
    await expect(status).toHaveText("Not connected");
  } finally {
    await editorContext.close();
  }
});

test("Hype Train controls stay usable while consent status loads or is unavailable", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const releaseStatuses: Array<() => Promise<void>> = [];
  let holdStatuses = true;
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, async (route) => {
    if (!holdStatuses) {
      await route.fulfill({ json: statusResponse("owner", false, identity.login) });
      return;
    }
    await new Promise<void>((resolve) => {
      releaseStatuses.push(async () => {
        await route.fulfill({ json: statusResponse("owner", false, identity.login) });
        resolve();
      });
    });
  });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await selectSettingsTabForField(page, "reactionHypeTrain");
  const checkbox = page.locator("#theme-reactionHypeTrain");
  await expect(checkbox).toBeEnabled();
  await expect(page.locator("#rehearse-hype-train")).toBeEnabled();
  await expect(page.locator("#hype-train-consent").getByRole("status")).toHaveText("Checking Hype Train permission…");
  expect(releaseStatuses.length).toBeGreaterThan(0);
  holdStatuses = false;
  await Promise.all(releaseStatuses.map((release) => release()));
  await expect(page.locator("#hype-train-consent")).toHaveAttribute("data-state", "disconnected");

  await page.unroute(/\/api\/hype-train(?:\?.*)?$/u);
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({ status: 503 }));
  await page.reload();
  await expect(page.locator("#hype-train-consent")).toHaveAttribute("data-state", "unavailable");
  await expect(checkbox).toBeEnabled();
  await expect(page.locator("#rehearse-hype-train")).toBeEnabled();
});

async function setStudioChannel(page: import("@playwright/test").Page, channel: string): Promise<void> {
  if (await page.locator("#channel-popover").isHidden()) await page.locator("#channel-field-button").click();
  const input = page.locator("#channel-popover [data-channel-value]").first();
  await input.fill(channel);
  await input.dispatchEvent("change");
  await expect(page.locator("#channel-field-text")).toContainText(channel);
}

async function addStudioChannel(page: import("@playwright/test").Page, channel: string): Promise<void> {
  if (await page.locator("#channel-popover").isHidden()) await page.locator("#channel-field-button").click();
  await page.locator("#channel-popover [data-channel-new]").fill(channel);
  await page.locator("#channel-popover [data-channel-add]").click();
  await expect(page.locator("#channel-popover [data-channel-value]")).toHaveCount(2);
}

async function removeStudioChannel(page: import("@playwright/test").Page, index: number): Promise<void> {
  if (await page.locator("#channel-popover").isHidden()) await page.locator("#channel-field-button").click();
  await page.locator(`#channel-popover [data-channel-focus="remove-${index}"]`).click();
  await expect(page.locator("#channel-popover [data-channel-value]")).toHaveCount(1);
}

async function expectStatusLineFits(status: import("@playwright/test").Locator): Promise<void> {
  const sizes = await status.evaluate((element) => ({ clientWidth: element.clientWidth, scrollWidth: element.scrollWidth }));
  expect(sizes.scrollWidth).toBeLessThanOrEqual(sizes.clientWidth);
}

async function updateChannelsAsEditor(
  page: import("@playwright/test").Page,
  overlayId: string,
  token: string,
  channels: string[],
): Promise<number> {
  return page.evaluate(async (input) => {
    const snapshotResponse = await fetch("/api/overlay/config", { headers: { Authorization: `Bearer ${input.token}` } });
    const snapshot = await snapshotResponse.json() as { revision: number };
    const response = await fetch(`/api/overlays/${input.overlayId}/config`, {
      method: "PUT", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: snapshot.revision, patch: { channels: input.channels } }),
    });
    return response.status;
  }, { overlayId, token, channels });
}
