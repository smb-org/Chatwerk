import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { DEFAULTS } from "../../src/shared/theme";
import { addStudioLook, addStudioOverlay, e2eOrigin, seedStudioSession, setRange, type StudioIdentity } from "./studio-session";
import { fillThemeControl, setThemeChoice } from "./studio-session";

const publicLook = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "resize-public-look",
  name: "Resize public look",
  author: "Alice",
  values: DEFAULTS,
  parent: null,
};

interface ResizeTestWindow extends Window {
  __resizeOriginalDocument?: Document;
  __resizeLoadCount?: number;
  __resizeFadeState?: { moved: boolean; animation: Animation; observer: MutationObserver };
  __resizePointerId?: number;
}

async function studio(page: Page, viewport = { width: 1_440, height: 1_000 }): Promise<StudioIdentity> {
  await page.setViewportSize(viewport);
  const identity = await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
  await expect(page.frameLocator("#studio-preview").locator("#chat")).toBeVisible();
  if (await page.locator("#first-run-done").isVisible()) await page.locator("#first-run-done").click();
  return identity;
}

async function frameSize(page: Page): Promise<{ width: number; height: number }> {
  return page.frameLocator("#studio-preview").locator("body").evaluate(() => ({ width: innerWidth, height: innerHeight }));
}

async function chooseLimited1080Preset(page: Page, limit = 300): Promise<void> {
  await setRange(page, "maxChatHeight", limit);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  await page.locator("#preview-size-preset").selectOption("1920x1080");
  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 1_080 });
  await expect(page.frameLocator("#studio-preview").locator("#chat")).toHaveCSS("max-height", `${limit}px`);
}

async function trackPreviewDocument(page: Page): Promise<void> {
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#studio-preview")!;
    const host = window as ResizeTestWindow;
    host.__resizeLoadCount = 0;
    frame.addEventListener("load", () => { host.__resizeLoadCount = (host.__resizeLoadCount ?? 0) + 1; });
  });
  await page.frameLocator("#studio-preview").locator("body").evaluate((body) => {
    (window as ResizeTestWindow).__resizeOriginalDocument = body.ownerDocument;
  });
}

async function dragHandle(page: Page, selector: string, deltaX: number, deltaY: number): Promise<void> {
  const bounds = await page.locator(selector).boundingBox();
  if (!bounds) throw new Error(`Missing resize handle ${selector}`);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y + deltaY, { steps: 4 });
}

function trackConfigPatches(page: Page): Array<Record<string, unknown>> {
  const patches: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT" || !/\/api\/overlays\/[0-9a-f-]+\/config$/u.test(new URL(request.url()).pathname)) return;
    const payload = request.postDataJSON() as { patch?: Record<string, unknown> };
    if (payload.patch) patches.push(payload.patch);
  });
  return patches;
}

test("Fit drag keeps the frame origin and scale fixed, updates controls, persists, and does not reload the iframe", async ({ page }) => {
  const identity = await studio(page);
  await page.locator("#preview-fit").click();
  await expect(page.locator("#preview-resize-right")).toHaveAttribute("aria-label", "Resize preview width");
  await expect(page.locator("#preview-resize-corner")).toHaveAttribute("aria-label", "Resize preview width and height");
  await expect(page.locator("#preview-resize-top")).toHaveAttribute("aria-label", "Resize preview height");
  await expect(page.locator("#preview-resize-bottom")).toHaveCount(0);
  const rightGrip = page.locator("#preview-resize-right");
  const idleGripOpacity = await rightGrip.evaluate((handle) => Number.parseFloat(getComputedStyle(handle, "::after").opacity));
  expect(await rightGrip.evaluate((handle) => ({
    width: getComputedStyle(handle, "::after").width,
    height: getComputedStyle(handle, "::after").height,
  }))).toEqual({ width: "4px", height: "32px" });
  await rightGrip.hover();
  expect(await rightGrip.evaluate((handle) => Number.parseFloat(getComputedStyle(handle, "::after").opacity)))
    .toBeGreaterThan(idleGripOpacity);
  await rightGrip.focus();
  expect(await rightGrip.evaluate((handle) => getComputedStyle(handle, "::after").boxShadow)).not.toBe("none");
  const topGrip = page.locator("#preview-resize-top");
  expect(await topGrip.evaluate((handle) => ({
    width: getComputedStyle(handle, "::after").width,
    height: getComputedStyle(handle, "::after").height,
  }))).toEqual({ width: "32px", height: "4px" });
  const configPatches = trackConfigPatches(page);
  const toolbarBefore = await page.locator(".preview-toolbar").boundingBox();
  await trackPreviewDocument(page);
  const initial = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#studio-preview")!;
    const wrap = document.querySelector<HTMLElement>("#preview-frame-wrap")!.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>("#preview-window")!.getBoundingClientRect();
    return {
      scale: Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]),
      left: wrap.left,
      top: wrap.top,
      stageWidth: stage.width,
      stageHeight: stage.height,
    };
  });
  const dx = Math.round(initial.scale * 70);
  await dragHandle(page, "#preview-resize-right", dx, 0);

  await expect.poll(() => frameSize(page)).toEqual({ width: 470, height: 600 });
  const duringDrag = await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#studio-preview")!;
    const wrap = document.querySelector<HTMLElement>("#preview-frame-wrap")!.getBoundingClientRect();
    return {
      scale: Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]),
      left: wrap.left,
      top: wrap.top,
      stageWidth: document.querySelector<HTMLElement>("#preview-window")!.getBoundingClientRect().width,
      stageHeight: document.querySelector<HTMLElement>("#preview-window")!.getBoundingClientRect().height,
    };
  });
  expect(duringDrag.scale).toBe(initial.scale);
  expect(duringDrag.left).toBeCloseTo(initial.left, 1);
  expect(duringDrag.top).toBeCloseTo(initial.top, 1);
  expect(duringDrag.stageWidth).toBeCloseTo(initial.stageWidth, 1);
  expect(duringDrag.stageHeight).toBeCloseTo(initial.stageHeight, 1);
  expect(await page.frameLocator("#studio-preview").locator("body").evaluate((body) =>
    (window as ResizeTestWindow).__resizeOriginalDocument === body.ownerDocument)).toBe(true);
  expect(await page.evaluate(() => (window as ResizeTestWindow).__resizeLoadCount)).toBe(0);
  await expect(page.locator("#preview-size-preset")).toHaveValue("custom");
  await expect(page.locator("#preview-custom-size")).toBeVisible();
  await expect(page.locator("#preview-custom-width")).toHaveValue("470");
  await expect(page.locator("#preview-custom-height")).toHaveValue("600");
  await expect(page.locator("#obs-size-hint")).toHaveText("In OBS, set the browser source to 470 x 600.");
  await expect(page.locator("#preview-size-drag-label")).toHaveText("470 × 600");
  expect(await page.locator(".preview-toolbar").boundingBox()).toEqual(toolbarBefore);

  await page.mouse.up();
  expect(configPatches).toEqual([]);
  const stored = await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), identity.overlayId);
  expect(stored).toContain('"width":470');
  expect(stored).toContain('"height":600');
  await page.reload();
  await expect(page.locator("#preview-size-preset")).toHaveValue("custom");
  await expect.poll(() => frameSize(page)).toEqual({ width: 470, height: 600 });
});

test("Fit keeps a tall custom preview top handle clear of the size bar and stage clamp", async ({ page }) => {
  const identity = await seedStudioSession(page);
  await page.addInitScript((overlayId) => {
    localStorage.setItem(`chatwerk-source-size:${overlayId}`, JSON.stringify({ width: 400, height: 1_600 }));
  }, identity.overlayId);
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
  await expect(page.frameLocator("#studio-preview").locator("#chat")).toBeVisible();
  if (await page.locator("#first-run-done").isVisible()) await page.locator("#first-run-done").click();
  await page.locator("#preview-fit").click();
  await expect(page.locator("#preview-size-preset")).toHaveValue("custom");
  await expect(page.locator("#preview-custom-size")).toBeVisible();
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 1_600 });
  await expect(page.locator("#preview-window")).toHaveCSS("padding-top", "56px");

  await mkdir(".tmp/shots", { recursive: true });
  await page.locator(".preview-column").screenshot({ path: ".tmp/shots/resize-top-tall.png" });
  const hitTestTopHandle = () => page.evaluate(() => {
    const handle = document.querySelector<HTMLElement>("#preview-resize-top")!;
    const bounds = handle.getBoundingClientRect();
    return document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2) === handle;
  });
  expect(await hitTestTopHandle()).toBe(true);

  await dragHandle(page, "#preview-resize-top", 0, -5_000);
  expect(await hitTestTopHandle()).toBe(true);
  const clampedFrame = await page.locator("#preview-frame-wrap").boundingBox();
  const stageTop = await page.locator("#preview-window").evaluate((stage) => {
    const bounds = stage.getBoundingClientRect();
    const style = getComputedStyle(stage);
    return bounds.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop);
  });
  expect(clampedFrame!.y).toBeGreaterThanOrEqual(stageTop - 1);
  await page.mouse.up();

  await page.setViewportSize({ width: 1_000, height: 850 });
  await expect(page.locator("#preview-window")).toHaveCSS("padding-top", "56px");
  await page.locator("#preview-fit").click();
  expect(await hitTestTopHandle()).toBe(true);
});

test("theme height changes sync the frame on load, undo and slider edits without color changes resetting presets", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const initialLook = addStudioLook(identity.ownerId, "Height limit 300", { ...DEFAULTS, maxChatHeight: 300 });
  const initialCopyResponse = await page.request.post(`${e2eOrigin}/api/looks/${initialLook.slug}/copy`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { overlayId: identity.overlayId },
  });
  expect(initialCopyResponse.status()).toBe(200);
  const initialCopy = await initialCopyResponse.json() as { revision: number; snapshotId: string; undoExpiresAt: number };
  const initialDestination = new URL("/studio", e2eOrigin);
  initialDestination.searchParams.set("overlay", identity.overlayId);
  initialDestination.searchParams.set("undo", initialCopy.snapshotId);
  initialDestination.searchParams.set("rev", String(initialCopy.revision));
  initialDestination.searchParams.set("until", String(initialCopy.undoExpiresAt));
  initialDestination.searchParams.set("look", initialLook.slug);
  initialDestination.searchParams.set("lookName", "Height limit 300");

  await page.addInitScript((overlayId) => {
    if (sessionStorage.getItem("resize-source-size-seeded") === "1") return;
    localStorage.setItem(`chatwerk-source-size:${overlayId}`, JSON.stringify({ width: 400, height: 600 }));
    sessionStorage.setItem("resize-source-size-seeded", "1");
  }, identity.overlayId);
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  const configPatches = trackConfigPatches(page);
  await page.goto(initialDestination.toString());
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("300");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 300 });
  await expect(page.locator("#preview-size-preset")).toHaveValue("custom");
  await expect(page.locator("#preview-custom-height")).toHaveValue("300");
  await page.waitForTimeout(250);
  expect(configPatches).toEqual([]);

  const nextLook = addStudioLook(identity.ownerId, "Height limit 400", { ...DEFAULTS, maxChatHeight: 400 });
  const nextCopyResponse = await page.request.post(`${e2eOrigin}/api/looks/${nextLook.slug}/copy`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { overlayId: identity.overlayId },
  });
  expect(nextCopyResponse.status()).toBe(200);
  const nextCopy = await nextCopyResponse.json() as { revision: number; snapshotId: string; undoExpiresAt: number };
  const nextDestination = new URL("/studio", e2eOrigin);
  nextDestination.searchParams.set("overlay", identity.overlayId);
  nextDestination.searchParams.set("undo", nextCopy.snapshotId);
  nextDestination.searchParams.set("rev", String(nextCopy.revision));
  nextDestination.searchParams.set("until", String(nextCopy.undoExpiresAt));
  nextDestination.searchParams.set("look", nextLook.slug);
  nextDestination.searchParams.set("lookName", "Height limit 400");
  await page.goto(nextDestination.toString());
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("400");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 400 });
  await expect(page.locator("#undo-look")).toBeVisible();
  await page.locator("#undo-look").click();
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("300");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 300 });

  await page.locator("#preview-size-preset").selectOption("1920x1080");
  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 1_080 });
  await expect(page.frameLocator("#studio-preview").locator("#chat")).toHaveCSS("max-height", "300px");
  expect(configPatches).toEqual([]);
  await fillThemeControl(page, "textColor", "#fdf2ee", ".hex-control");
  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 1_080 });
  await expect.poll(() => configPatches.length).toBe(1);
  expect(configPatches).toEqual([{ textColor: "#fdf2ee" }]);

  await page.locator("#preview-size-preset").selectOption("custom");
  await page.locator("#preview-custom-width").fill("420");
  await page.locator("#preview-custom-height").fill("800");
  await page.locator("#preview-custom-apply").click();
  await expect.poll(() => frameSize(page)).toEqual({ width: 420, height: 800 });
  expect(configPatches).toEqual([{ textColor: "#fdf2ee" }]);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("300");

  await setRange(page, "maxChatHeight", 400);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("400");
  await expect.poll(() => frameSize(page)).toEqual({ width: 420, height: 400 });
  await expect.poll(() => configPatches.length).toBe(2);
  expect(configPatches).toEqual([{ textColor: "#fdf2ee" }, { maxChatHeight: 400 }]);
});

test("incoming maxChatHeight config does not move the frame during a pointer resize", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const look = addStudioLook(identity.ownerId, "Height limit 300", { ...DEFAULTS, maxChatHeight: 300 });
  const copyResponse = await page.request.post(`${e2eOrigin}/api/looks/${look.slug}/copy`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { overlayId: identity.overlayId },
  });
  expect(copyResponse.status()).toBe(200);
  const copied = await copyResponse.json() as { revision: number; snapshotId: string; undoExpiresAt: number };
  const destination = new URL("/studio", e2eOrigin);
  destination.searchParams.set("overlay", identity.overlayId);
  destination.searchParams.set("undo", copied.snapshotId);
  destination.searchParams.set("rev", String(copied.revision));
  destination.searchParams.set("until", String(copied.undoExpiresAt));
  destination.searchParams.set("look", look.slug);
  destination.searchParams.set("lookName", "Height limit 300");
  const studioSocket = page.waitForEvent("websocket", (socket) => socket.url().includes("/api/overlay/live"));
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await page.goto(destination.toString());
  await studioSocket;
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("300");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 300 });

  await dragHandle(page, "#preview-resize-top", 0, 100);
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 200 });
  const updateResponse = await page.request.put(`${e2eOrigin}/api/overlays/${identity.overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision: copied.revision, patch: { maxChatHeight: 400 } },
  });
  expect(updateResponse.status()).toBe(200);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("400");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 200 });
  await page.mouse.up();
});

test("top drag anchors the bottom, prunes rows, saves maxChatHeight once on release, and undo restores it", async ({ page }) => {
  const identity = await studio(page);
  const connectedOverlay = await page.context().newPage();
  connectedOverlay.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      if (String(message).includes("JOIN #")) socket.send(":tmi.twitch.tv ROOMSTATE #sample");
    });
  });
  await connectedOverlay.goto(`/overlay#token=${identity.token}&client=browser`);
  await expect(connectedOverlay.locator("#chat")).toHaveAttribute("data-height-limited", "false");
  await page.locator("#preview-fit").click();
  await page.locator("#rehearse-flood").click();
  const chat = page.frameLocator("#studio-preview").locator("#chat");
  await expect.poll(() => chat.locator(".chat-line").count(), { timeout: 10_000 }).toBeGreaterThan(8);
  const rowsBefore = await chat.locator(".chat-line").count();
  const initial = await page.locator("#preview-frame-wrap").boundingBox();
  const stageBefore = await page.locator("#preview-window").boundingBox();
  const outsideBefore = await Promise.all([
    page.locator(".preview-toolbar").boundingBox(),
    page.locator(".settings-panel").boundingBox(),
    page.locator(".preview-meta").boundingBox(),
  ]);
  const scale = await page.locator("#studio-preview").evaluate((frame) =>
    Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]));
  const configPatches = trackConfigPatches(page);
  await trackPreviewDocument(page);

  await mkdir(".tmp/shots", { recursive: true });
  await page.locator("#preview-window").screenshot({ path: ".tmp/shots/resize-top-before.png" });
  await dragHandle(page, "#preview-resize-top", 0, Math.round(scale * 200));
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 400 });
  const scaleDuring = await page.locator("#studio-preview").evaluate((frame) =>
    Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]));
  expect(scaleDuring).toBe(scale);
  expect(await page.frameLocator("#studio-preview").locator("body").evaluate((body) =>
    (window as ResizeTestWindow).__resizeOriginalDocument === body.ownerDocument)).toBe(true);
  expect(await page.evaluate(() => (window as ResizeTestWindow).__resizeLoadCount)).toBe(0);
  const during = await page.locator("#preview-frame-wrap").boundingBox();
  const stageDuring = await page.locator("#preview-window").boundingBox();
  expect(during!.y + during!.height).toBeCloseTo(initial!.y + initial!.height, 1);
  expect(during!.y).toBeGreaterThan(initial!.y);
  expect(stageDuring!.x).toBeCloseTo(stageBefore!.x, 1);
  expect(stageDuring!.y).toBeCloseTo(stageBefore!.y, 1);
  expect(stageDuring!.width).toBeCloseTo(stageBefore!.width, 1);
  expect(stageDuring!.height).toBeCloseTo(stageBefore!.height, 1);
  expect(await Promise.all([
    page.locator(".preview-toolbar").boundingBox(),
    page.locator(".settings-panel").boundingBox(),
    page.locator(".preview-meta").boundingBox(),
  ])).toEqual(outsideBefore);
  await expect.poll(() => chat.locator(".chat-line").count()).toBeLessThan(rowsBefore);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("0");
  expect(configPatches).toEqual([]);
  await page.locator("#preview-window").screenshot({ path: ".tmp/shots/resize-top-after.png" });

  await page.mouse.up();
  await expect.poll(() => configPatches.length).toBe(1);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  expect(configPatches).toEqual([{ maxChatHeight: 400 }]);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("400");
  await expect(connectedOverlay.locator("#chat")).toHaveAttribute("data-height-limited", "true", { timeout: 5_000 });
  await expect(connectedOverlay.locator("#chat")).toHaveCSS("max-height", "400px");
  const stored = await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), identity.overlayId);
  expect(stored).toContain('"height":400');

  const look = addStudioLook(identity.ownerId, "Resize undo", { ...DEFAULTS, maxChatHeight: 200 });
  const copyResponse = await page.request.post(`${e2eOrigin}/api/looks/${look.slug}/copy`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { overlayId: identity.overlayId },
  });
  expect(copyResponse.status()).toBe(200);
  const copied = await copyResponse.json() as { revision: number; snapshotId: string; undoExpiresAt: number };
  const destination = new URL("/studio", e2eOrigin);
  destination.searchParams.set("overlay", identity.overlayId);
  destination.searchParams.set("undo", copied.snapshotId);
  destination.searchParams.set("rev", String(copied.revision));
  destination.searchParams.set("until", String(copied.undoExpiresAt));
  destination.searchParams.set("look", look.slug);
  destination.searchParams.set("lookName", "Resize undo");
  await page.goto(destination.toString());
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("200");
  await expect(page.locator("#undo-look")).toBeVisible();
  await page.locator("#undo-look").click();
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("400");
  await expect(connectedOverlay.locator("#chat")).toHaveCSS("max-height", "400px");
  await connectedOverlay.close();
});

test("1:1 top-right corner drag changes both axes, clamps to the visible stage, and leaves preview controls usable", async ({ page }) => {
  await studio(page);
  await expect(page.locator("#preview-resize-corner")).toHaveCSS("cursor", "nesw-resize");
  await page.locator("#preview-one-to-one").click();
  await expect(page.locator("#preview-scale")).toContainText("100%");
  await page.locator("#preview-mode-sample").click();
  await expect(page.locator("#preview-mode-sample")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-scale")).toBeVisible();
  const initial = await page.locator("#preview-frame-wrap").boundingBox();
  await dragHandle(page, "#preview-resize-corner", 50, -40);
  await expect.poll(() => frameSize(page)).toEqual({ width: 450, height: 640 });
  const duringDrag = await page.locator("#preview-frame-wrap").boundingBox();
  expect(duringDrag!.x).toBeCloseTo(initial!.x, 1);
  expect(duringDrag!.y + duringDrag!.height).toBeCloseTo(initial!.y + initial!.height, 1);
  await page.mouse.up();

  await dragHandle(page, "#preview-resize-corner", 700, -120);
  const stage = await page.locator("#preview-window").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      right: bounds.right - Number.parseFloat(style.paddingRight),
      top: bounds.top + Number.parseFloat(style.borderTopWidth) + Number.parseFloat(style.paddingTop),
    };
  });
  const clamped = await page.locator("#preview-frame-wrap").boundingBox();
  expect(clamped!.x + clamped!.width).toBeLessThanOrEqual(stage.right + 1);
  expect(clamped!.y).toBeGreaterThanOrEqual(stage.top - 1);
  const clampedSize = await frameSize(page);
  expect(clampedSize.width).toBeGreaterThanOrEqual(100);
  expect(clampedSize.width).toBeLessThanOrEqual(3_840);
  expect(clampedSize.height).toBeGreaterThanOrEqual(100);
  expect(clampedSize.height).toBeLessThanOrEqual(2_160);
  expect(clampedSize.width % 10).toBe(0);
  expect(clampedSize.height % 10).toBe(0);
  await page.mouse.up();
});

test("resize handles support directional keyboard steps and translated names, and are absent on public looks", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("chatwerk-language", "de"));
  const identity = await studio(page);
  const right = page.locator("#preview-resize-right");
  await expect(right).toHaveAttribute("aria-label", "Vorschau-Breite ändern");
  await right.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 600 });
  const top = page.locator("#preview-resize-top");
  await expect(top).toHaveAttribute("aria-label", "Vorschau-Höhe ändern");
  await expect(page.locator("#preview-resize-corner")).toHaveAttribute("aria-label", "Vorschau-Breite und -Höhe ändern");
  expect(await page.locator("#preview-resize-bottom").count()).toBe(0);
  const configPatches = trackConfigPatches(page);
  const waitForConfigSave = () => page.waitForResponse((response) =>
    response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith(`/api/overlays/${identity.overlayId}/config`) && response.ok());
  await top.focus();
  const topUpSave = waitForConfigSave();
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 650 });
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("650");
  await topUpSave;
  expect(configPatches).toEqual([{ maxChatHeight: 650 }]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 650 });
  const downSave = waitForConfigSave();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 640 });
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("640");
  await downSave;
  expect(configPatches).toEqual([{ maxChatHeight: 650 }, { maxChatHeight: 640 }]);
  const corner = page.locator("#preview-resize-corner");
  await corner.focus();
  const cornerUpSave = waitForConfigSave();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 650 });
  await cornerUpSave;
  expect(configPatches).toEqual([{ maxChatHeight: 650 }, { maxChatHeight: 640 }, { maxChatHeight: 650 }]);
  const cornerDownSave = waitForConfigSave();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 640 });
  await cornerDownSave;
  expect(configPatches).toEqual([{ maxChatHeight: 650 }, { maxChatHeight: 640 }, { maxChatHeight: 650 }, { maxChatHeight: 640 }]);
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frameSize(page)).toEqual({ width: 420, height: 640 });
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 640 });

  await page.route("**/api/looks", (route) => route.fulfill({ json: { looks: [publicLook] } }));
  await page.route("**/api/looks/resize-public-look", (route) => route.fulfill({ json: publicLook }));
  await page.goto("/t/resize-public-look");
  await expect(page.locator("#look-name")).toHaveText("Resize public look");
  await expect(page.locator(".preview-resize-handle")).toHaveCount(0);
});

test("keyboard height resizing snaps a custom height to the theme control step", async ({ page }) => {
  const identity = await seedStudioSession(page);
  await page.addInitScript((overlayId) => {
    localStorage.setItem(`chatwerk-source-size:${overlayId}`, JSON.stringify({ width: 400, height: 605 }));
  }, identity.overlayId);
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  const configPatches = trackConfigPatches(page);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
  await page.locator("#preview-resize-top").focus();
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 620 });
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("620");
  await expect.poll(() => configPatches.length).toBe(1);
  expect(configPatches).toEqual([{ maxChatHeight: 620 }]);
});

test("keyboard resizing is ignored while a pointer resize is active", async ({ page }) => {
  await studio(page);
  const handle = page.locator("#preview-resize-right");
  const bounds = await handle.boundingBox();
  const scale = await page.locator("#studio-preview").evaluate((frame) =>
    Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]));
  const x = bounds!.x + bounds!.width / 2;
  const y = bounds!.y + bounds!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await handle.press("ArrowRight");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 600 });
  await expect(page.locator("#preview-custom-width")).toHaveValue("400");
  await page.mouse.move(x + Math.round(scale * 10), y);
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 600 });
  await page.mouse.up();
});

test("pointercancel restores the drag-start size without persisting or saving", async ({ page }) => {
  const identity = await studio(page);
  const heightBefore = await page.locator("#theme-maxChatHeight").inputValue();
  const configPatches = trackConfigPatches(page);
  await page.evaluate(() => {
    document.querySelector<HTMLButtonElement>("#preview-resize-top")!.addEventListener("pointerdown", (event) => {
      (window as ResizeTestWindow).__resizePointerId = event.pointerId;
    }, { once: true });
  });
  const handle = await page.locator("#preview-resize-top").boundingBox();
  const x = handle!.x + handle!.width / 2;
  const y = handle!.y + handle!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 100, { steps: 3 });
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 500 });
  const pointerId = await page.evaluate(() => (window as ResizeTestWindow).__resizePointerId!);
  await page.evaluate((id) => {
    document.querySelector<HTMLButtonElement>("#preview-resize-top")!
      .dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: id }));
  }, pointerId);
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 600 });
  await expect(page.locator("#preview-size-drag-label")).toBeHidden();
  await page.mouse.up();
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue(heightBefore);
  await page.waitForTimeout(250);
  expect(configPatches).toEqual([]);
  expect(await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), identity.overlayId)).toBeNull();
});

test("height drag stays preview-only when the maxChatHeight control is disabled", async ({ page }) => {
  const identity = await studio(page);
  await setThemeChoice(page, "layout", "ticker");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  await expect(page.locator("#theme-maxChatHeight")).toBeDisabled();
  const configPatches = trackConfigPatches(page);
  await dragHandle(page, "#preview-resize-top", 0, 100);
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 500 });
  await page.mouse.up();
  await page.waitForTimeout(250);
  expect(configPatches).toEqual([]);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("0");
  expect(await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), identity.overlayId))
    .toContain('"height":500');
});

test("height drag stays preview-only while deleting the active overlay", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Survivor", identity.login);
  let releaseDelete!: () => void;
  let markDeleteStarted!: () => void;
  const deletionHeld = new Promise<void>((resolve) => { releaseDelete = resolve; });
  const deletionStarted = new Promise<void>((resolve) => { markDeleteStarted = resolve; });
  await page.route(`**/api/overlays/${identity.overlayId}`, async (route) => {
    if (route.request().method() !== "DELETE") return route.continue();
    markDeleteStarted();
    await deletionHeld;
    await route.continue();
  });
  try {
    await page.setViewportSize({ width: 1_440, height: 1_000 });
    await page.goto("/studio");
    await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
    if (await page.locator("#first-run-done").isVisible()) await page.locator("#first-run-done").click();
    await page.locator("#account-menu summary").click();
    await page.locator("#open-overlays").click();
    await page.getByRole("button", { name: "Delete Main" }).click();
    await deletionStarted;
    await page.keyboard.press("Escape");
    await expect(page.locator("#theme-controls")).toHaveAttribute("inert", "");
    const configPatches = trackConfigPatches(page);
    await dragHandle(page, "#preview-resize-top", 0, 100);
    await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 500 });
    await page.mouse.up();
    await page.waitForTimeout(250);
    expect(configPatches).toEqual([]);
    await expect(page.locator("#theme-maxChatHeight")).toHaveValue("0");
  } finally {
    releaseDelete();
  }
  await expect(page.locator("#active-overlay-text")).toContainText("Survivor");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 600 });
});

test("Fit stays at or below one-to-one after dragging to a short source size", async ({ page }) => {
  await studio(page);
  await page.locator("#preview-fit").click();
  const scale = await page.locator("#studio-preview").evaluate((frame) =>
    Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]));
  const handle = await page.locator("#preview-resize-top").boundingBox();
  const x = handle!.x + handle!.width / 2;
  const y = handle!.y + handle!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + Math.round(scale * 450), { steps: 5 });
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 150 });
  await page.mouse.up();

  const fitScale = await page.locator("#studio-preview").evaluate((frame) =>
    Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]));
  expect(fitScale).toBeLessThanOrEqual(1);
  await page.locator("#preview-one-to-one").click();
  await expect(page.locator("#preview-scale")).toContainText("100%");
  await page.locator("#preview-resize-right").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 150 });
  await expect(page.locator("#preview-scale")).toContainText("100%");
});

test("access loss during a preview drag cancels the drag before switching overlays", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const backup = addStudioOverlay(identity.ownerId, "Backup", identity.login);
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
  if (await page.locator("#first-run-done").isVisible()) await page.locator("#first-run-done").click();

  let signalPut!: () => void;
  let releasePut!: () => void;
  const putStarted = new Promise<void>((resolve) => { signalPut = resolve; });
  const heldPut = new Promise<void>((resolve) => { releasePut = resolve; });
  await page.route(`${e2eOrigin}/api/overlays/${identity.overlayId}/config`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    signalPut();
    await heldPut;
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
  });

  const handle = await page.locator("#preview-resize-top").boundingBox();
  const x = handle!.x + handle!.width / 2;
  const y = handle!.y + handle!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 100, { steps: 3 });
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 500 });
  await setRange(page, "fontSize", 27);
  await putStarted;

  const deleted = await page.request.delete(`${e2eOrigin}/api/overlays/${identity.overlayId}`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: {},
  });
  expect(deleted.status()).toBe(204);
  releasePut();
  await expect(page.locator("#status-visible")).toHaveText("Access changed. You were moved to Backup.");

  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 600 });
  await expect(page.locator("#preview-size-drag-label")).toBeHidden();
  expect(await page.locator("#preview-frame-wrap").evaluate((wrap) => (wrap as HTMLElement).style.position)).toBe("");
  await page.mouse.up();
  expect(await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), identity.overlayId)).toBeNull();
  expect(await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), backup.overlayId)).toBeNull();
});

test("access loss without another overlay restores the top drag start size and makes no height save", async ({ page }) => {
  const identity = await studio(page);
  const configPatches = trackConfigPatches(page);
  await page.route(`${e2eOrigin}/api/overlays/${identity.overlayId}/config`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    await route.fulfill({ status: 404, contentType: "application/json", body: JSON.stringify({ error: "not_found" }) });
  });
  const handle = await page.locator("#preview-resize-top").boundingBox();
  const x = handle!.x + handle!.width / 2;
  const y = handle!.y + handle!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + 100, { steps: 3 });
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 500 });
  await setRange(page, "fontSize", 27);
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 600 });
  await page.mouse.up();
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("0");
  expect(await page.locator("#preview-frame-wrap").evaluate((wrap) => (wrap as HTMLElement).style.position)).toBe("");
  expect(configPatches).toEqual([{ fontSize: 27 }]);
  expect(await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), identity.overlayId)).toBeNull();
});

test("a fading row keeps its transition when the iframe resizes", async ({ page }) => {
  await studio(page);
  await page.locator("#preview-one-to-one").click();
  await page.locator("#rehearse-flood").click();
  const chat = page.frameLocator("#studio-preview").locator("#chat");
  await expect.poll(() => chat.locator(".chat-line").count(), { timeout: 10_000 }).toBeGreaterThan(8);
  await expect.poll(async () => chat.locator(".chat-line").last().textContent()).toContain("GGs");
  const sampleRow = chat.locator(".chat-line").filter({ hasText: "GGs" }).first();
  await expect(sampleRow).toBeVisible();
  await sampleRow.evaluate((element) => { element.dataset.resizeFadeRow = "true"; });
  const row = chat.locator('.chat-line[data-resize-fade-row="true"]');
  await row.evaluate(async (element) => {
    const root = element.ownerDocument.querySelector("#chat")!;
    const host = window as ResizeTestWindow;
    const observer = new MutationObserver((records) => {
      if (records.some((record) => [...record.removedNodes].includes(element))) host.__resizeFadeState!.moved = true;
    });
    observer.observe(root, { childList: true });
    element.style.transitionDuration = "30s";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const initialOpacity = Number(getComputedStyle(element).opacity);
    if (initialOpacity !== 1) throw new Error(`Expected an opaque row before fading, received ${initialOpacity}`);
    element.style.opacity = "0";
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    const animation = element.getAnimations().find((candidate) => candidate.playState === "running");
    if (!animation) throw new Error("Expected the row opacity transition to start");
    host.__resizeFadeState = { moved: false, animation, observer };
  });
  await expect.poll(() => row.evaluate(() => (window as ResizeTestWindow).__resizeFadeState?.animation.playState))
    .toBe("running");
  const opacityBeforeResize = await row.evaluate((element) => Number(getComputedStyle(element).opacity));

  await page.locator("#preview-size-preset").selectOption("300x900");
  await expect.poll(() => frameSize(page)).toEqual({ width: 300, height: 900 });
  await setRange(page, "fontSize", 19);
  await expect.poll(() => chat.evaluate((root) => getComputedStyle(root).getPropertyValue("--t-font-size").trim())).toBe("19px");
  await expect.poll(() => row.evaluate((element) => {
    const state = (window as ResizeTestWindow).__resizeFadeState!;
    return { moved: state.moved, running: element.getAnimations().some((animation) => animation.playState === "running"), opacity: Number(getComputedStyle(element).opacity) };
  })).toMatchObject({ moved: false, running: true });
  expect(await row.evaluate((element) => Number(getComputedStyle(element).opacity))).toBeLessThan(opacityBeforeResize);
  await row.evaluate(() => (window as ResizeTestWindow).__resizeFadeState?.observer.disconnect());
});

test("shrinking and growing the Sample preview from its top hides and restores complete rows", async ({ page }) => {
  await studio(page);
  await page.locator("#preview-one-to-one").click();
  await page.locator("#rehearse-flood").click();
  const chat = page.frameLocator("#studio-preview").locator("#chat");
  await expect.poll(() => chat.locator(".chat-line").count(), { timeout: 10_000 }).toBeGreaterThan(8);
  await expect.poll(async () => page.frameLocator("#studio-preview").locator(".chat-line").last().textContent())
    .toContain("GGs");
  const rowsBefore = await chat.locator(".chat-line").count();

  const topHandle = await page.locator("#preview-resize-top").boundingBox();
  const startX = topHandle!.x + topHandle!.width / 2;
  const startY = topHandle!.y + topHandle!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + 500, { steps: 5 });
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 100 });
  await expect.poll(() => page.frameLocator("#studio-preview").locator(".chat-line").evaluateAll((rows) =>
    rows.every((row) => {
      const rect = row.getBoundingClientRect();
      return rect.top >= -0.5 && rect.bottom <= innerHeight + 0.5;
    }))).toBe(true);
  const shortLayout = await page.frameLocator("#studio-preview").locator(".chat-line").evaluateAll((rows) => ({
    count: rows.length,
    height: innerHeight,
    bounds: rows.map((row) => {
      const rect = row.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    }),
  }));
  expect(shortLayout.count).toBeLessThan(rowsBefore);
  expect(shortLayout.count).toBeGreaterThan(0);
  expect(shortLayout.bounds.every(({ top, bottom }) => top >= -0.5 && bottom <= shortLayout.height + 0.5), JSON.stringify(shortLayout)).toBe(true);
  await page.mouse.move(startX, startY, { steps: 5 });
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 600 });
  await expect.poll(() => chat.locator(".chat-line").count()).toBe(rowsBefore);
  const grownRows = await chat.locator(".chat-line").evaluateAll((rows) => rows.map((row) => {
    const rect = row.getBoundingClientRect();
    return { top: rect.top, bottom: rect.bottom };
  }));
  expect(grownRows.every(({ top, bottom }) => top >= -0.5 && bottom <= 600.5)).toBe(true);
  await page.mouse.up();
});

test("Live preview wraps a long word at 150px and stays connected through resize without Twitch access", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const longWord = "x".repeat(240);
  const sixtyCharacterMessage = "m".repeat(60);
  const longName = "Viewer";
  const joins: string[] = [];
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (!command.startsWith("JOIN #")) return;
      const channel = command.slice("JOIN #".length).trim();
      joins.push(channel);
      socket.send(`:tmi.twitch.tv ROOMSTATE #${channel}\r\n@id=resize-long;display-name=${longName} :viewer!viewer@host PRIVMSG #${channel} :${longWord}\r\n@id=resize-sixty;display-name=Viewer :sixty!sixty@host PRIVMSG #${channel} :${sixtyCharacterMessage}\r\n@id=resize-short;display-name=Short :short!short@host PRIVMSG #${channel} :hi`);
    });
  });
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText("Saved");
  await page.locator("#preview-mode-live").click();
  const chat = page.frameLocator("#studio-preview").locator("#chat");
  await expect(chat.locator(".chat-line").filter({ hasText: longWord })).toBeVisible();
  await expect(chat.locator(".chat-line").filter({ hasText: sixtyCharacterMessage })).toBeVisible();
  expect(joins).toContain(identity.login);
  await trackPreviewDocument(page);

  const widePlacement = await chat.locator(".chat-line").filter({ hasText: sixtyCharacterMessage }).evaluate((line) => {
    const name = line.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
    const message = line.querySelector<HTMLElement>(".chat-message")!.getBoundingClientRect();
    return { nameTop: name.top, messageTop: message.top };
  });
  expect(widePlacement.messageTop).toBeCloseTo(widePlacement.nameTop, 1);
  await mkdir(".tmp/shots", { recursive: true });
  await page.locator("#preview-window").screenshot({ path: ".tmp/shots/resize-long-message-400.png" });

  await page.locator("#preview-size-preset").selectOption("custom");
  await page.locator("#preview-custom-width").fill("150");
  await page.locator("#preview-custom-height").fill("600");
  await page.locator("#preview-custom-apply").click();
  await expect.poll(() => frameSize(page)).toEqual({ width: 150, height: 600 });
  const wrapping = await chat.locator(".chat-line").filter({ hasText: longWord }).evaluate((line) => {
    const message = line.querySelector<HTMLElement>(".chat-message")!;
    const name = line.querySelector<HTMLElement>(".chat-name")!;
    return {
      documentWidth: document.documentElement.scrollWidth,
      lineWidth: line.getBoundingClientRect().width,
      lineScrollWidth: (line as HTMLElement).scrollWidth,
      messageWidth: message.clientWidth,
      messageScrollWidth: message.scrollWidth,
      messageHeight: message.getBoundingClientRect().height,
      nameWidth: name.clientWidth,
      nameScrollWidth: name.scrollWidth,
    };
  });
  expect(wrapping.documentWidth).toBeLessThanOrEqual(150);
  expect(wrapping.lineWidth).toBeLessThanOrEqual(150);
  expect(wrapping.lineScrollWidth).toBeLessThanOrEqual(wrapping.lineWidth);
  expect(wrapping.messageScrollWidth).toBeLessThanOrEqual(wrapping.messageWidth);
  expect(wrapping.messageHeight).toBeGreaterThan(24);
  expect(wrapping.nameWidth).toBeGreaterThan(0);
  expect(wrapping.nameScrollWidth).toBeLessThanOrEqual(wrapping.nameWidth);
  const narrowLayout = await chat.locator(".chat-line").evaluateAll((rows) => rows.map((line) => {
    const bounds = line.getBoundingClientRect();
    const name = line.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
    const message = line.querySelector<HTMLElement>(".chat-message")!.getBoundingClientRect();
    return {
      lineWidth: bounds.width,
      lineScrollWidth: (line as HTMLElement).scrollWidth,
      nameBottom: name.bottom,
      messageTop: message.top,
      messageWidth: line.querySelector<HTMLElement>(".chat-message")!.clientWidth,
      messageScrollWidth: line.querySelector<HTMLElement>(".chat-message")!.scrollWidth,
    };
  }));
  expect(narrowLayout).toHaveLength(3);
  expect(narrowLayout.every((row) => row.messageTop >= row.nameBottom - 1)).toBe(true);
  expect(narrowLayout.every((row) => row.lineScrollWidth <= row.lineWidth && row.messageScrollWidth <= row.messageWidth)).toBe(true);
  const assets = await chat.evaluate((root) => {
    const line = root.ownerDocument.createElement("div");
    line.className = "chat-line";
    line.style.fontSize = "36px";
    line.style.gap = "8px";
    const metadata = root.ownerDocument.createElement("span");
    metadata.className = "chat-meta";
    const badges = root.ownerDocument.createElement("span");
    badges.className = "chat-badges";
    for (let index = 0; index < 4; index += 1) {
      const badge = root.ownerDocument.createElement("img");
      badge.className = "chat-badge";
      badge.width = 36;
      badge.height = 36;
      badge.alt = `Badge ${index}`;
      badges.appendChild(badge);
    }
    const name = root.ownerDocument.createElement("span");
    name.className = "chat-name";
    name.textContent = "W".repeat(25);
    metadata.appendChild(badges);
    metadata.appendChild(name);
    const message = root.ownerDocument.createElement("span");
    message.className = "chat-message";
    message.appendChild(root.ownerDocument.createTextNode("Text "));
    const emote = root.ownerDocument.createElement("img");
    emote.className = "chat-emote";
    emote.width = 27;
    emote.height = 27;
    emote.alt = "Emote";
    message.appendChild(emote);
    line.appendChild(metadata);
    line.appendChild(message);
    root.appendChild(line);
    const result = [false, true].map((ownLine) => {
      line.classList.toggle("chat-name-own-line", ownLine);
      const lineRect = line.getBoundingClientRect();
      const badgeRect = badges.getBoundingClientRect();
      const messageRect = message.getBoundingClientRect();
      const emoteRect = emote.getBoundingClientRect();
      const nameRect = name.getBoundingClientRect();
      const metadataRect = metadata.getBoundingClientRect();
      const badgeContainerStyle = getComputedStyle(metadata);
      return {
        ownLine,
        lineWidth: lineRect.width,
        lineScrollWidth: line.scrollWidth,
        lineDirection: getComputedStyle(line).flexDirection,
        nameWidth: nameRect.width,
        nameScrollWidth: name.scrollWidth,
        nameX: nameRect.x,
        metadataWidth: metadataRect.width,
        metadataX: metadataRect.x,
        metadataFlexWrap: badgeContainerStyle.flexWrap,
        badgeWidth: badgeRect.width,
        badgeScrollWidth: badges.scrollWidth,
        badgeX: badgeRect.x,
        emoteWidth: emoteRect.width,
        messageWidth: messageRect.width,
        messageScrollWidth: message.scrollWidth,
        messageX: messageRect.x,
        documentWidth: root.ownerDocument.documentElement.scrollWidth,
      };
    });
    line.remove();
    return result;
  });
  for (const layout of assets) {
    expect(layout.lineScrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.lineWidth);
    expect(layout.badgeScrollWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.badgeWidth);
    expect(layout.emoteWidth, JSON.stringify(layout)).toBeLessThanOrEqual(layout.messageWidth);
    expect(layout.documentWidth, JSON.stringify(layout)).toBeLessThanOrEqual(150);
  }

  await setThemeChoice(page, "layout", "ticker");
  const tickerLine = chat.locator(".ticker-line").filter({ hasText: longWord });
  await expect(tickerLine).toBeVisible();
  const tickerLayout = await tickerLine.evaluate((line) => ({
    lineWidth: line.getBoundingClientRect().width,
    animationName: getComputedStyle(line).animationName,
    documentWidth: document.documentElement.scrollWidth,
  }));
  expect(tickerLayout.lineWidth).toBeGreaterThan(150);
  expect(tickerLayout.animationName).toBe("chatwerk-ticker");
  expect(tickerLayout.documentWidth).toBeLessThanOrEqual(150);

  await page.locator("#preview-fit").click();
  await dragHandle(page, "#preview-resize-right", 40, 0);
  await expect.poll(() => frameSize(page)).toEqual({ width: 190, height: 600 });
  const connected = {
    sameDocument: await page.frameLocator("#studio-preview").locator("body").evaluate((body) =>
      (window as ResizeTestWindow).__resizeOriginalDocument === body.ownerDocument),
    loads: await page.evaluate(() => (window as ResizeTestWindow).__resizeLoadCount),
  };
  expect(connected).toEqual({ sameDocument: true, loads: 0 });
  await expect(chat.locator(".chat-line").filter({ hasText: longWord })).toHaveCount(1);
});

test("all default stack messages move below their names at 150px without horizontal overflow", async ({ page }) => {
  await seedStudioSession(page);
  const longWord = "x".repeat(240);
  const sixtyCharacterMessage = "m".repeat(60);
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (!command.startsWith("JOIN #")) return;
      const channel = command.slice("JOIN #".length).trim();
      socket.send(`:tmi.twitch.tv ROOMSTATE #${channel}\r\n@id=long;display-name=LongName :long!long@host PRIVMSG #${channel} :${longWord}\r\n@id=sixty;display-name=Viewer :sixty!sixty@host PRIVMSG #${channel} :${sixtyCharacterMessage}\r\n@id=short;display-name=Short :short!short@host PRIVMSG #${channel} :hi`);
    });
  });
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText("Saved");
  await page.locator("#preview-mode-live").click();
  const chat = page.frameLocator("#studio-preview").locator("#chat");
  await expect(chat.locator(".chat-line").filter({ hasText: longWord })).toBeVisible();
  await expect(chat.locator(".chat-line").filter({ hasText: sixtyCharacterMessage })).toBeVisible();
  await expect(chat.locator(".chat-line").filter({ hasText: "hi" })).toBeVisible();

  await page.locator("#preview-size-preset").selectOption("custom");
  await page.locator("#preview-custom-width").fill("150");
  await page.locator("#preview-custom-height").fill("600");
  await page.locator("#preview-custom-apply").click();
  await expect.poll(() => frameSize(page)).toEqual({ width: 150, height: 600 });
  const rows = await chat.locator(".chat-line").evaluateAll((lines) => lines.map((line) => {
    const name = line.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
    const message = line.querySelector<HTMLElement>(".chat-message")!;
    return {
      belowName: message.getBoundingClientRect().top >= name.bottom - 1,
      lineWidth: line.getBoundingClientRect().width,
      lineScrollWidth: (line as HTMLElement).scrollWidth,
      messageWidth: message.clientWidth,
      messageScrollWidth: message.scrollWidth,
      documentWidth: document.documentElement.scrollWidth,
    };
  }));
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.belowName)).toBe(true);
  expect(rows.every((row) => row.lineScrollWidth <= row.lineWidth && row.messageScrollWidth <= row.messageWidth && row.documentWidth <= 150)).toBe(true);
});

test("badge metadata stays on one line beside the name at 400px and wraps above the message at 150px", async ({ page }) => {
  await mkdir(".tmp/shots", { recursive: true });
  await studio(page);
  await page.locator("#preview-size-preset").selectOption("400x600");
  await expect.poll(() => frameSize(page)).toEqual({ width: 400, height: 600 });

  const chat = page.frameLocator("#studio-preview").locator("#chat");
  await chat.locator(".chat-line").first().evaluate((renderedRow) => {
    const root = renderedRow.ownerDocument.querySelector<HTMLElement>("#chat")!;
    const rows = [...root.querySelectorAll<HTMLElement>(".chat-line")];
    const longRow = rows[0]!;
    rows.slice(1).forEach((row) => row.remove());
    const shortRow = longRow.cloneNode(true) as HTMLElement;

    const prepareRow = (row: HTMLElement, messageText: string, marker: string) => {
      row.dataset.badgeWrap = marker;
      row.querySelector<HTMLElement>(".chat-name")!.textContent = "Viewer";
      row.querySelector<HTMLElement>(".chat-pronouns")!.textContent = "they/them";
      row.querySelector<HTMLElement>(".chat-source-room")!.textContent = "via s";
      row.querySelector<HTMLElement>(".chat-source-room")!.setAttribute("aria-label", "Shared chat source room shared-stream");
      row.querySelector<HTMLElement>(".chat-message")!.textContent = messageText;

      const badges = row.querySelector<HTMLElement>(".chat-badges")!;
      const colors = ["e76f51", "2a9d8f", "457b9d", "e9c46a"];
      badges.replaceChildren(...Array.from({ length: 9 }, (_, index) => {
        const badge = row.ownerDocument.createElement("img");
        badge.className = "chat-badge";
        badge.width = 18;
        badge.height = 18;
        badge.alt = `Fixture badge ${index + 1}`;
        badge.src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="8" fill="#${colors[index % colors.length]}"/></svg>`)}`;
        return badge;
      }));
    };

    prepareRow(longRow, "x".repeat(120), "long");
    prepareRow(shortRow, "hi", "short");
    root.appendChild(shortRow);
  });

  const longRow = chat.locator('.chat-line[data-badge-wrap="long"]');
  const shortRow = chat.locator('.chat-line[data-badge-wrap="short"]');
  await expect(longRow.locator("img.chat-badge")).toHaveCount(9);
  await expect(shortRow.locator("img.chat-badge")).toHaveCount(9);

  const measureRows = async () => chat.locator(".chat-line[data-badge-wrap]").evaluateAll((rows) => rows.map((row) => {
    const badges = [...row.querySelectorAll<HTMLImageElement>("img.chat-badge")];
    const lastBadge = badges.at(-1)!.getBoundingClientRect();
    const name = row.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
    const pronouns = row.querySelector<HTMLElement>(".chat-pronouns")!;
    const pronounRange = document.createRange();
    pronounRange.selectNodeContents(pronouns);
    const message = row.querySelector<HTMLElement>(".chat-message")!;
    const messageRange = document.createRange();
    messageRange.selectNodeContents(message);
    const visualLineCount = (range: Range) => new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size;
    const messageRect = message.getBoundingClientRect();
    return {
      marker: (row as HTMLElement).dataset.badgeWrap,
      rowLeft: row.getBoundingClientRect().left,
      badgeTops: badges.map((badge) => badge.getBoundingClientRect().top),
      badgeNameGap: name.left - lastBadge.right,
      pronounLineCount: visualLineCount(pronounRange),
      messageLineCount: visualLineCount(messageRange),
      messageLeft: messageRect.left,
      messageTop: messageRect.top,
      nameRight: name.right,
      nameBottom: name.bottom,
    };
  }));

  const rowsAt400 = await measureRows();
  const longAt400 = rowsAt400.find((row) => row.marker === "long")!;
  const shortAt400 = rowsAt400.find((row) => row.marker === "short")!;
  await page.locator("#studio-preview").screenshot({ path: ".tmp/shots/badge-wrap-400.png" });

  await page.locator("#preview-size-preset").selectOption("custom");
  await page.locator("#preview-custom-width").fill("150");
  await page.locator("#preview-custom-height").fill("600");
  await page.locator("#preview-custom-apply").click();
  await expect.poll(() => frameSize(page)).toEqual({ width: 150, height: 600 });
  const longAt150 = (await measureRows()).find((row) => row.marker === "long")!;
  await page.locator("#studio-preview").screenshot({ path: ".tmp/shots/badge-wrap-150.png" });

  expect(longAt400.badgeTops.every((top) => Math.abs(top - longAt400.badgeTops[0]!) <= 1), JSON.stringify({ longAt400, shortAt400 })).toBe(true);
  expect(shortAt400.badgeTops.every((top) => Math.abs(top - shortAt400.badgeTops[0]!) <= 1)).toBe(true);
  expect(longAt400.badgeNameGap).toBeGreaterThanOrEqual(-2);
  expect(longAt400.badgeNameGap).toBeLessThanOrEqual(shortAt400.badgeNameGap + 2);
  expect(longAt400.pronounLineCount).toBe(1);
  expect(longAt400.messageLineCount).toBeGreaterThanOrEqual(3);
  expect(Math.abs(longAt400.messageLeft - longAt400.rowLeft)).toBeLessThanOrEqual(1);
  expect(new Set(longAt150.badgeTops.map((top) => Math.round(top))).size).toBeGreaterThan(1);
  expect(longAt150.messageTop).toBeGreaterThanOrEqual(longAt150.nameBottom - 1);
});

test("captures wide, narrow, and short resize screenshots", async ({ page }) => {
  await mkdir(".tmp/shots", { recursive: true });
  await studio(page);
  await page.locator("#preview-size-preset").selectOption("custom");
  for (const [width, height, filename] of [
    [800, 600, "resize-wide.png"],
    [150, 600, "resize-narrow.png"],
    [400, 150, "resize-short.png"],
  ] as const) {
    await page.locator("#preview-custom-width").fill(String(width));
    await page.locator("#preview-custom-height").fill(String(height));
    await page.locator("#preview-custom-apply").click();
    await expect.poll(() => frameSize(page)).toEqual({ width, height });
    await page.locator("#preview-window").screenshot({ path: `.tmp/shots/${filename}` });
  }
});

test("top-handle drag starts from the saved height limit and saves the dragged height once", async ({ page }) => {
  const identity = await studio(page);
  await chooseLimited1080Preset(page);
  const configPatches = trackConfigPatches(page);
  const handle = page.locator("#preview-resize-top");
  const handleBounds = await handle.boundingBox();
  const initialFrame = await page.locator("#preview-frame-wrap").boundingBox();
  const scale = await page.locator("#studio-preview").evaluate((frame) =>
    Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]));
  const untouched = await Promise.all([
    page.locator(".preview-toolbar").boundingBox(),
    page.locator(".settings-panel").boundingBox(),
    page.locator(".preview-meta").boundingBox(),
  ]);
  if (!handleBounds || !initialFrame) throw new Error("Missing top resize handle or frame");
  const x = handleBounds.x + handleBounds.width / 2;
  const y = handleBounds.y + handleBounds.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 300 });
  const snappedFrame = await page.locator("#preview-frame-wrap").boundingBox();
  expect(snappedFrame!.y + snappedFrame!.height).toBeCloseTo(initialFrame.y + initialFrame.height, 1);
  expect(await Promise.all([
    page.locator(".preview-toolbar").boundingBox(),
    page.locator(".settings-panel").boundingBox(),
    page.locator(".preview-meta").boundingBox(),
  ])).toEqual(untouched);
  expect(configPatches).toEqual([]);
  await page.mouse.move(x, y + Math.round(scale * 10), { steps: 1 });
  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 290 });
  const draggedFrame = await page.locator("#preview-frame-wrap").boundingBox();
  expect(draggedFrame!.y + draggedFrame!.height).toBeCloseTo(initialFrame.y + initialFrame.height, 1);
  expect(await Promise.all([
    page.locator(".preview-toolbar").boundingBox(),
    page.locator(".settings-panel").boundingBox(),
    page.locator(".preview-meta").boundingBox(),
  ])).toEqual(untouched);
  expect(configPatches).toEqual([]);

  await page.mouse.up();
  await expect.poll(() => configPatches.length).toBe(1);
  expect(configPatches).toEqual([{ maxChatHeight: 290 }]);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("290");
  const stored = await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), identity.overlayId);
  expect(stored).toContain('"height":290');
});

test("top-handle press and release without movement restores the preset and saves nothing", async ({ page }) => {
  const identity = await studio(page);
  await chooseLimited1080Preset(page);
  const configPatches = trackConfigPatches(page);
  const before = await page.evaluate((overlayId) => ({
    size: localStorage.getItem(`chatwerk-source-size:${overlayId}`),
    position: localStorage.getItem(`chatwerk-preview-position:${overlayId}`),
  }), identity.overlayId);
  const handle = await page.locator("#preview-resize-top").boundingBox();
  if (!handle) throw new Error("Missing top resize handle");
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 300 });
  await page.mouse.up();

  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 1_080 });
  expect(await page.evaluate((overlayId) => ({
    size: localStorage.getItem(`chatwerk-source-size:${overlayId}`),
    position: localStorage.getItem(`chatwerk-preview-position:${overlayId}`),
  }), identity.overlayId)).toEqual(before);
  expect(configPatches).toEqual([]);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("300");
});

test("top and corner keyboard resizing start from the saved height limit", async ({ page }) => {
  await studio(page);
  await chooseLimited1080Preset(page);
  const configPatches = trackConfigPatches(page);

  for (const [index, selector] of ["#preview-resize-top", "#preview-resize-corner"].entries()) {
    if (index > 0) {
      await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2");
      await setRange(page, "maxChatHeight", 300);
      await expect(page.locator("#status-visible")).toHaveText("Saved, rev 3");
      await page.locator("#preview-size-preset").selectOption("1920x1080");
      await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 1_080 });
      configPatches.length = 0;
    }
    const initialFrame = await page.locator("#preview-frame-wrap").boundingBox();
    await page.locator(selector).focus();
    await page.keyboard.press("ArrowDown");
    await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 290 });
    const resizedFrame = await page.locator("#preview-frame-wrap").boundingBox();
    expect(resizedFrame!.y + resizedFrame!.height).toBeCloseTo(initialFrame!.y + initialFrame!.height, 1);
    await expect.poll(() => configPatches.length).toBe(1);
    expect(configPatches).toEqual([{ maxChatHeight: 290 }]);
    await expect(page.locator("#theme-maxChatHeight")).toHaveValue("290");
    await expect(page.locator("#status-visible")).toHaveText(`Saved, rev ${index === 0 ? 2 : 4}`);
  }
});

test("a zero height limit leaves pointer resize behavior unchanged", async ({ page }) => {
  await studio(page);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("0");
  await page.locator("#preview-size-preset").selectOption("1920x1080");
  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 1_080 });
  const configPatches = trackConfigPatches(page);
  const handle = await page.locator("#preview-resize-top").boundingBox();
  const scale = await page.locator("#studio-preview").evaluate((frame) =>
    Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]));
  if (!handle) throw new Error("Missing top resize handle");
  const x = handle.x + handle.width / 2;
  const y = handle.y + handle.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 1_080 });
  await page.mouse.move(x, y + Math.round(scale * 10), { steps: 1 });
  await expect.poll(() => frameSize(page)).toEqual({ width: 1_920, height: 1_070 });
  await page.mouse.up();
  await expect.poll(() => configPatches.length).toBe(1);
  expect(configPatches).toEqual([{ maxChatHeight: 1_070 }]);
});
