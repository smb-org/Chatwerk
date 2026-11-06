import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { DEFAULTS } from "../../src/shared/theme";
import { addStudioOverlay, e2eOrigin, seedStudioSession, setRange, type StudioIdentity } from "./studio-session";

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

test("Fit drag keeps the frame origin and scale fixed, updates controls, persists, and does not reload the iframe", async ({ page }) => {
  const identity = await studio(page);
  await page.locator("#preview-fit").click();
  await expect(page.locator("#preview-resize-right")).toHaveAttribute("aria-label", "Resize preview width");
  await expect(page.locator("#preview-resize-corner")).toHaveAttribute("aria-label", "Resize preview width and height");
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
  const bottomGrip = page.locator("#preview-resize-bottom");
  expect(await bottomGrip.evaluate((handle) => ({
    width: getComputedStyle(handle, "::after").width,
    height: getComputedStyle(handle, "::after").height,
  }))).toEqual({ width: "32px", height: "4px" });
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
  const stored = await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), identity.overlayId);
  expect(stored).toContain('"width":470');
  expect(stored).toContain('"height":600');
  await page.reload();
  await expect(page.locator("#preview-size-preset")).toHaveValue("custom");
  await expect.poll(() => frameSize(page)).toEqual({ width: 470, height: 600 });
});

test("1:1 corner drag changes both axes, clamps to the visible stage, and leaves preview controls usable", async ({ page }) => {
  await studio(page);
  await page.locator("#preview-one-to-one").click();
  await expect(page.locator("#preview-scale")).toContainText("100%");
  await page.locator("#preview-mode-sample").click();
  await expect(page.locator("#preview-mode-sample")).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator("#preview-scale")).toBeVisible();
  const initial = await page.locator("#preview-frame-wrap").boundingBox();
  await dragHandle(page, "#preview-resize-corner", 50, 40);
  await expect.poll(() => frameSize(page)).toEqual({ width: 450, height: 640 });
  const duringDrag = await page.locator("#preview-frame-wrap").boundingBox();
  expect(duringDrag!.x).toBeCloseTo(initial!.x, 1);
  expect(duringDrag!.y).toBeCloseTo(initial!.y, 1);
  await page.mouse.up();

  await dragHandle(page, "#preview-resize-corner", 700, 120);
  const stage = await page.locator("#preview-window").evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      right: bounds.right - Number.parseFloat(style.paddingRight),
      bottom: bounds.bottom - Number.parseFloat(style.paddingBottom),
    };
  });
  const clamped = await page.locator("#preview-frame-wrap").boundingBox();
  expect(clamped!.x + clamped!.width).toBeLessThanOrEqual(stage.right + 1);
  expect(clamped!.y + clamped!.height).toBeLessThanOrEqual(stage.bottom + 1);
  const clampedSize = await frameSize(page);
  expect(clampedSize.width).toBeGreaterThanOrEqual(100);
  expect(clampedSize.width).toBeLessThanOrEqual(3_840);
  expect(clampedSize.height).toBeGreaterThanOrEqual(100);
  expect(clampedSize.height).toBeLessThanOrEqual(2_160);
  expect(clampedSize.width % 10).toBe(0);
  expect(clampedSize.height % 10).toBe(0);
  await page.mouse.up();
});

test("resize handles support 10 and 50 pixel keyboard steps and translated names, and are absent on public looks", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("chatwerk-language", "de"));
  await studio(page);
  const right = page.locator("#preview-resize-right");
  await expect(right).toHaveAttribute("aria-label", "Vorschau-Breite ändern");
  await right.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 600 });
  const bottom = page.locator("#preview-resize-bottom");
  await expect(bottom).toHaveAttribute("aria-label", "Vorschau-Höhe ändern");
  await expect(page.locator("#preview-resize-corner")).toHaveAttribute("aria-label", "Vorschau-Breite und -Höhe ändern");
  await bottom.focus();
  await page.keyboard.press("Shift+ArrowDown");
  await expect.poll(() => frameSize(page)).toEqual({ width: 410, height: 650 });

  await page.route("**/api/looks", (route) => route.fulfill({ json: { looks: [publicLook] } }));
  await page.route("**/api/looks/resize-public-look", (route) => route.fulfill({ json: publicLook }));
  await page.goto("/t/resize-public-look");
  await expect(page.locator("#look-name")).toHaveText("Resize public look");
  await expect(page.locator(".preview-resize-handle")).toHaveCount(0);
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

test("Fit stays at or below one-to-one after dragging to a short source size", async ({ page }) => {
  await studio(page);
  await page.locator("#preview-fit").click();
  const scale = await page.locator("#studio-preview").evaluate((frame) =>
    Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]));
  const handle = await page.locator("#preview-resize-bottom").boundingBox();
  const x = handle!.x + handle!.width / 2;
  const y = handle!.y + handle!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y - Math.round(scale * 450), { steps: 5 });
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

  const handle = await page.locator("#preview-resize-right").boundingBox();
  const scale = await page.locator("#studio-preview").evaluate((frame) =>
    Number(frame.style.transform.match(/scale\(([\d.]+)\)/u)?.[1]));
  const x = handle!.x + handle!.width / 2;
  const y = handle!.y + handle!.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + Math.round(scale * 50), y, { steps: 3 });
  await expect.poll(() => frameSize(page)).toEqual({ width: 450, height: 600 });
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
  expect(await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-source-size:${overlayId}`), backup.overlayId)).toBeNull();
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

test("shrinking and growing the Sample preview hides and restores complete rows", async ({ page }) => {
  await studio(page);
  await page.locator("#preview-one-to-one").click();
  await page.locator("#rehearse-flood").click();
  const chat = page.frameLocator("#studio-preview").locator("#chat");
  await expect.poll(() => chat.locator(".chat-line").count(), { timeout: 10_000 }).toBeGreaterThan(8);
  await expect.poll(async () => page.frameLocator("#studio-preview").locator(".chat-line").last().textContent())
    .toContain("GGs");
  const rowsBefore = await chat.locator(".chat-line").count();

  const bottomHandle = await page.locator("#preview-resize-bottom").boundingBox();
  const startX = bottomHandle!.x + bottomHandle!.width / 2;
  const startY = bottomHandle!.y + bottomHandle!.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY - 500, { steps: 5 });
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

  await page.locator('input[name="theme-layout"][value="ticker"]').check();
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
