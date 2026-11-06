import { deflateSync } from "node:zlib";
import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import { DEFAULTS } from "../../src/shared/theme";
import { addStudioLook, addStudioOverlay, e2eOrigin, seedStudioSession, setRange, type StudioIdentity } from "./studio-session";

type CanvasWindow = Window & { __previewLoads?: number; __previewOriginalDocument?: Document; __activePointerId?: number };

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const name = Buffer.from(type);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(data.length);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])));
  return Buffer.concat([header, name, data, checksum]);
}

function generatedImage(width: number, height: number): { name: string; mimeType: string; buffer: Buffer } {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  const pixels = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * 4 + 1);
    pixels[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const offset = row + 1 + x * 4;
      const block = ((x >> 6) + (y >> 6)) % 2;
      pixels[offset] = block ? 48 : 24;
      pixels[offset + 1] = Math.round(70 + y / height * 100);
      pixels[offset + 2] = Math.round(110 + x / width * 100);
      pixels[offset + 3] = 255;
    }
  }
  return {
    name: `generated-stream-${width}x${height}.png`,
    mimeType: "image/png",
    buffer: Buffer.concat([
      Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      pngChunk("IHDR", header),
      pngChunk("IDAT", deflateSync(pixels)),
      pngChunk("IEND", Buffer.alloc(0)),
    ]),
  };
}

async function openStudio(
  page: Page,
  viewport = { width: 1_440, height: 1_000 },
  setup?: (identity: StudioIdentity) => void,
): Promise<StudioIdentity> {
  await page.setViewportSize(viewport);
  const identity = await seedStudioSession(page);
  setup?.(identity);
  await page.addInitScript((overlayId) => {
    localStorage.setItem(`chatwerk-source-size:${overlayId}`, JSON.stringify({ width: 800, height: 260 }));
  }, identity.overlayId);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
  await expect(page.frameLocator("#studio-preview").locator("#chat")).toBeVisible();
  if (await page.locator("#first-run-done").isVisible()) await page.locator("#first-run-done").click();
  await page.evaluate(() => {
    const frame = document.querySelector<HTMLIFrameElement>("#studio-preview")!;
    const host = window as CanvasWindow;
    host.__previewLoads = 0;
    frame.addEventListener("load", () => { host.__previewLoads = (host.__previewLoads ?? 0) + 1; });
  });
  await page.frameLocator("#studio-preview").locator("body").evaluate((body) => {
    (window as CanvasWindow).__previewOriginalDocument = body.ownerDocument;
  });
  return identity;
}

async function uploadBackground(page: Page, width = 1_920, height = 1_080): Promise<void> {
  await page.locator("#preview-background-file").setInputFiles(generatedImage(width, height));
}

async function moveBy(page: Page, selector: string, deltaX: number, deltaY: number): Promise<void> {
  const bounds = await page.locator(selector).boundingBox();
  if (!bounds) throw new Error(`Missing preview frame ${selector}`);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + deltaX, y + deltaY, { steps: 5 });
  await page.mouse.up();
}

function canvasPositionReadout(page: Page): Promise<string> {
  return page.locator("#preview-position-meta").innerText();
}

async function readCanvasPosition(page: Page): Promise<{ x: number; y: number; width: number; height: number }> {
  const text = await canvasPositionReadout(page);
  const match = text.match(/X\s+(\d+)\s+Y\s+(\d+)\s+(\d+)\s+x\s+(\d+)/u);
  if (!match) throw new Error(`Unexpected canvas readout: ${text}`);
  return { x: Number(match[1]), y: Number(match[2]), width: Number(match[3]), height: Number(match[4]) };
}

test("Fit with an uploaded 16:9 image uses a 1920px canvas scale and a typed OBS position readout", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page);
  const canvas = page.locator("#preview-canvas");
  await expect(page.locator("#preview-window")).toHaveAttribute("data-canvas-mode", "true");
  await expect(canvas).toBeVisible();
  const geometry = await page.evaluate(() => {
    const canvasBounds = document.querySelector<HTMLElement>("#preview-canvas")!.getBoundingClientRect();
    const frameBounds = document.querySelector<HTMLElement>("#preview-frame-wrap")!.getBoundingClientRect();
    return { canvasWidth: canvasBounds.width, canvasHeight: canvasBounds.height, frameWidth: frameBounds.width };
  });
  expect(geometry.canvasWidth / geometry.canvasHeight).toBeCloseTo(16 / 9, 5);
  expect(geometry.frameWidth / geometry.canvasWidth).toBeCloseTo(800 / 1_920, 4);
  expect(await readCanvasPosition(page)).toEqual({ x: 40, y: 780, width: 800, height: 260 });
  await expect(page.locator("#preview-position-meta")).toHaveText("X 40  Y 780  800 x 260");
  await expect(page.locator("#preview-scale")).toHaveText(/\d+%/u);
});

test("selecting 1280x720 scales the frame, keeps the readout right, and persists after reload", async ({ page }) => {
  await mkdir(".tmp/shots", { recursive: true });
  await openStudio(page);
  const canvasSize = page.locator("#preview-canvas-size");
  await expect(canvasSize).toBeHidden();
  await uploadBackground(page);
  await expect(canvasSize).toBeVisible();

  const readoutRightBefore = await page.locator(".preview-readouts").evaluate((element) => element.getBoundingClientRect().right);
  await canvasSize.selectOption("1280x720");
  const geometry = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>("#preview-canvas")!.getBoundingClientRect();
    const frame = document.querySelector<HTMLElement>("#preview-frame-wrap")!.getBoundingClientRect();
    const readouts = document.querySelector<HTMLElement>(".preview-readouts")!.getBoundingClientRect();
    const scaleReadout = document.querySelector<HTMLElement>("#preview-scale")!.parentElement!.getBoundingClientRect();
    const stage = document.querySelector<HTMLElement>("#preview-window")!.getBoundingClientRect();
    return {
      frameToCanvasWidth: frame.width / canvas.width,
      readoutRight: readouts.right,
      scaleReadoutRight: scaleReadout.right,
      stageRight: stage.right,
    };
  });
  expect(geometry.frameToCanvasWidth).toBeCloseTo(0.625, 4);
  expect(geometry.readoutRight).toBeCloseTo(readoutRightBefore, 0);
  expect(geometry.readoutRight).toBeCloseTo(geometry.stageRight - 16, 0);
  expect(geometry.scaleReadoutRight).toBeCloseTo(geometry.readoutRight, 0);
  await expect(canvasSize).toHaveValue("1280x720");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 40, y: 460, width: 800, height: 260 });
  await page.locator(".preview-column").screenshot({ path: ".tmp/shots/canvas-720.png" });

  await page.locator("#preview-size-preset").selectOption("custom");
  await page.locator("#preview-custom-height").fill("820");
  await page.locator("#preview-custom-apply").click();
  await page.locator("#preview-resize-top").focus();
  await page.keyboard.press("ArrowDown");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 40, y: 0, width: 800, height: 720 });
  await page.locator("#preview-custom-height").fill("720");
  await page.locator("#preview-custom-apply").click();
  const handles = await page.evaluate(() => {
    const select = document.querySelector<HTMLElement>("#preview-canvas-size")!.getBoundingClientRect();
    const handle = document.querySelector<HTMLElement>("#preview-resize-top")!.getBoundingClientRect();
    return {
      overlaps: select.left < handle.right && select.right > handle.left && select.top < handle.bottom && select.bottom > handle.top,
      handleHit: document.elementFromPoint(handle.x + handle.width / 2, handle.y + handle.height / 2)?.id,
    };
  });
  expect(handles.overlaps).toBe(false);
  expect(handles.handleHit).toBe("preview-resize-top");

  await page.locator("#preview-move-control").focus();
  for (let step = 0; step < 20; step += 1) await page.keyboard.press("Shift+ArrowRight");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 480, y: 0, width: 800, height: 720 });
  await page.locator("#preview-resize-right").focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 480, y: 0, width: 800, height: 720 });
  await moveBy(page, "#preview-frame-wrap", -10_000, 0);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 0, width: 800, height: 720 });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileLayout = await page.evaluate(() => {
    const bounds = (selector: string) => document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
    const overlaps = (left: DOMRect, right: DOMRect) =>
      left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
    const stage = bounds("#preview-window");
    const readouts = bounds(".preview-readouts");
    const sample = bounds(".preview-mode-chip");
    const topHandle = bounds("#preview-resize-top");
    const cornerHandle = bounds("#preview-resize-corner");
    const frame = bounds("#preview-frame-wrap");
    return {
      readoutRight: readouts.right,
      stageRight: stage.right,
      scaleReadoutRight: document.querySelector<HTMLElement>("#preview-scale")!.parentElement!.getBoundingClientRect().right,
      readoutBelowFrame: readouts.top >= frame.bottom,
      readoutOverlapsSample: overlaps(readouts, sample),
      readoutOverlapsTopHandle: overlaps(readouts, topHandle),
      readoutOverlapsCornerHandle: overlaps(readouts, cornerHandle),
    };
  });
  expect(mobileLayout.readoutRight).toBeCloseTo(mobileLayout.stageRight - 8, 0);
  expect(mobileLayout.scaleReadoutRight).toBeCloseTo(mobileLayout.readoutRight, 0);
  expect(mobileLayout.readoutBelowFrame).toBe(true);
  expect(mobileLayout.readoutOverlapsSample).toBe(false);
  expect(mobileLayout.readoutOverlapsTopHandle).toBe(false);
  expect(mobileLayout.readoutOverlapsCornerHandle).toBe(false);

  await page.reload();
  await expect(canvasSize).toHaveValue("1280x720");
});

test("canvas controls and resize handles stay clickable around the custom size bar", async ({ page }) => {
  await mkdir(".tmp/shots", { recursive: true });
  await openStudio(page);
  await uploadBackground(page);
  await page.locator("#preview-canvas-size").selectOption("1280x720");
  await page.locator("#preview-size-preset").selectOption("custom");
  await expect(page.locator("#preview-custom-size")).toBeVisible();

  for (const width of [1_024, 1_280, 1_440]) {
    await page.setViewportSize({ width, height: 1_000 });
    const geometry = await page.evaluate(() => {
      const bounds = (selector: string) => {
        const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
      };
      const centerHit = (selector: string) => {
        const rect = document.querySelector<HTMLElement>(selector)!.getBoundingClientRect();
        return document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)?.id;
      };
      const overlaps = (left: ReturnType<typeof bounds>, right: ReturnType<typeof bounds>) =>
        left.left < right.right && left.right > right.left && left.top < right.bottom && left.bottom > right.top;
      const row = bounds(".preview-readouts");
      const custom = bounds("#preview-custom-size");
      const chip = bounds(".preview-mode-chip");
      const stage = bounds("#preview-window");
      return {
        canvasMode: document.querySelector<HTMLElement>("#preview-window")!.dataset.canvasMode,
        hits: {
          width: centerHit("#preview-custom-width"),
          height: centerHit("#preview-custom-height"),
          apply: centerHit("#preview-custom-apply"),
          select: centerHit("#preview-canvas-size"),
          topHandle: centerHit("#preview-resize-top"),
          cornerHandle: centerHit("#preview-resize-corner"),
          move: centerHit("#preview-move-control"),
        },
        overlaps: {
          rowAndCustomSize: overlaps(row, custom),
          rowAndModeChip: overlaps(row, chip),
          customSizeAndModeChip: overlaps(custom, chip),
        },
        rowWithinStage: row.left >= stage.left && row.right <= stage.right,
      };
    });

    expect(geometry.canvasMode, `${width}px canvas mode`).toBe("true");
    expect(geometry.hits, `${width}px hit targets`).toEqual({
      width: "preview-custom-width",
      height: "preview-custom-height",
      apply: "preview-custom-apply",
      select: "preview-canvas-size",
      topHandle: "preview-resize-top",
      cornerHandle: "preview-resize-corner",
      move: "preview-move-control",
    });
    expect(geometry.overlaps, `${width}px overlays`).toEqual({
      rowAndCustomSize: false,
      rowAndModeChip: false,
      customSizeAndModeChip: false,
    });
    expect(geometry.rowWithinStage, `${width}px readout row stays in stage`).toBe(true);

    if (width === 1_024) await page.locator(".preview-column").screenshot({ path: ".tmp/shots/canvas-720-1024.png" });
    if (width === 1_440) await page.locator(".preview-column").screenshot({ path: ".tmp/shots/canvas-720.png" });
  }
});

test("an invalid stored canvas size falls back to 1920x1080", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("chatwerk-preview-canvas-size", "2560x1080"));
  await openStudio(page);
  await expect(page.locator("#preview-canvas-size")).toHaveValue("1920x1080");
});

test("canvas sizing remains usable when browser storage throws", async ({ page }) => {
  await page.setViewportSize({ width: 1_440, height: 1_000 });
  await seedStudioSession(page);
  await page.addInitScript(() => Object.defineProperty(window, "localStorage", {
    configurable: true,
    get() { throw new DOMException("Storage is blocked", "SecurityError"); },
  }));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
  const canvasSize = page.locator("#preview-canvas-size");
  await expect(canvasSize).toHaveValue("1920x1080");
  await uploadBackground(page);
  await canvasSize.selectOption("1280x720");
  await expect(canvasSize).toHaveValue("1280x720");
  expect(pageErrors).toEqual([]);
});

test("dragging saves its local position, clamps all edges, preserves it per overlay and does not reload or save config", async ({ page }) => {
  let secondOverlayId = "";
  const identity = await openStudio(page, undefined, (current) => {
    const second = addStudioOverlay(current.ownerId, "Second", "second_room");
    secondOverlayId = second.overlayId;
  });
  await page.evaluate((overlayId) => localStorage.setItem(`chatwerk-source-size:${overlayId}`, JSON.stringify({ width: 800, height: 260 })), secondOverlayId);
  await uploadBackground(page);
  await expect(page.locator("#preview-window")).toHaveAttribute("data-canvas-mode", "true");
  const requests: string[] = [];
  page.on("request", (request) => {
    if (/\/api\/overlays\/[0-9a-f-]+\/config$/u.test(new URL(request.url()).pathname) && ["PUT", "PATCH"].includes(request.method())) {
      requests.push(request.method());
    }
  });
  await moveBy(page, "#preview-frame-wrap", -5_000, -5_000);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 0, width: 800, height: 260 });
  await moveBy(page, "#preview-frame-wrap", 5_000, 5_000);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 1_120, y: 820, width: 800, height: 260 });
  await moveBy(page, "#preview-frame-wrap", -5_000, 0);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 820, width: 800, height: 260 });
  await moveBy(page, "#preview-frame-wrap", 5_000, -5_000);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 1_120, y: 0, width: 800, height: 260 });
  await expect.poll(() => page.evaluate((overlayId) => localStorage.getItem(`chatwerk-preview-position:${overlayId}`), identity.overlayId))
    .toBe(JSON.stringify({ x: 1_120, y: 0 }));
  expect(requests).toEqual([]);
  expect(await page.evaluate(() => (window as CanvasWindow).__previewLoads)).toBe(0);
  expect(await page.frameLocator("#studio-preview").locator("body").evaluate((body) =>
    body.ownerDocument === (window as CanvasWindow).__previewOriginalDocument)).toBe(true);
  const frame = await page.locator("#preview-frame-wrap").boundingBox();
  if (!frame) throw new Error("Missing preview frame before overlay switch");
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width / 2 - 40, frame.y + frame.height / 2 + 40, { steps: 3 });
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 1_010, y: 110, width: 800, height: 260 });
  await expect.poll(() => page.evaluate((overlayId) => localStorage.getItem(`chatwerk-preview-position:${overlayId}`), identity.overlayId))
    .toBe(JSON.stringify({ x: 1_120, y: 0 }));
  await page.locator("#active-overlay-select").selectOption(secondOverlayId);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 40, y: 780, width: 800, height: 260 });
  await page.mouse.up();
  await expect.poll(() => page.evaluate((overlayId) => localStorage.getItem(`chatwerk-preview-position:${overlayId}`), identity.overlayId))
    .toBe(JSON.stringify({ x: 1_120, y: 0 }));
  await page.locator("#active-overlay-select").selectOption(identity.overlayId);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 1_120, y: 0, width: 800, height: 260 });
  await page.reload();
  await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
  await uploadBackground(page);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 1_120, y: 0, width: 800, height: 260 });
});

test("move control uses ten and fifty canvas pixel keyboard steps with localized labeling", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page);
  const control = page.locator("#preview-move-control");
  await expect(control).toHaveAttribute("aria-label", "Move preview frame");
  await control.click();
  await expect(control).toBeFocused();
  await expect(page.locator("#preview-position-meta")).toHaveAttribute("aria-live", "polite");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Shift+ArrowUp");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 50, y: 730, width: 800, height: 260 });
  await page.locator("#account-menu > summary").click();
  await page.locator("#language-de").click();
  await expect(control).toHaveAttribute("aria-label", "Vorschaurahmen verschieben");
});

test("canvas resize keeps the bottom-left fixed and saves maxChatHeight once on release", async ({ page }) => {
  await openStudio(page);
  await setRange(page, "maxChatHeight", 260);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("260");
  await uploadBackground(page);
  const requests: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT" || !/\/api\/overlays\/[0-9a-f-]+\/config$/u.test(new URL(request.url()).pathname)) return;
    const body = request.postDataJSON() as { patch?: Record<string, unknown> };
    if (body.patch) requests.push(body.patch);
  });
  const control = page.locator("#preview-move-control");
  await control.focus();
  await page.keyboard.press("ArrowRight");
  const before = await readCanvasPosition(page);
  const grip = await page.locator("#preview-resize-top").boundingBox();
  if (!grip) throw new Error("Missing top resize handle");
  const canvasWidth = await page.locator("#preview-canvas").evaluate((canvas) => canvas.getBoundingClientRect().width);
  const scale = canvasWidth / 1_920;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, {
    x: grip.x + grip.width / 2,
    y: grip.y + grip.height / 2,
  })).toBe("preview-resize-top");
  await page.mouse.down();
  await expect(page.locator("#preview-size-drag-label")).toBeVisible();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - Math.round(140 * scale), { steps: 3 });
  const during = await readCanvasPosition(page);
  expect(during).toEqual({ x: before.x, y: 640, width: 800, height: 400 });
  await expect(page.locator("#preview-position-meta")).toHaveAttribute("aria-live", "off");
  await page.mouse.up();
  await expect(page.locator("#preview-position-meta")).toHaveAttribute("aria-live", "polite");
  await expect.poll(() => requests.filter((patch) => "maxChatHeight" in patch).length, { timeout: 5_000 }).toBe(1);
  expect(requests.filter((patch) => "maxChatHeight" in patch)).toEqual([expect.objectContaining({ maxChatHeight: 400 })]);
  await expect(page.locator("#preview-window")).toHaveAttribute("data-canvas-mode", "true");
});

test("canvas corner resize snaps to the saved limit while keeping the stored position and readout truthful", async ({ page }) => {
  const identity = await openStudio(page);
  await setRange(page, "maxChatHeight", 300);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  await uploadBackground(page);
  const requests: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT" || !/\/api\/overlays\/[0-9a-f-]+\/config$/u.test(new URL(request.url()).pathname)) return;
    const body = request.postDataJSON() as { patch?: Record<string, unknown> };
    if (body.patch) requests.push(body.patch);
  });

  await page.locator("#preview-size-preset").selectOption("1920x1080");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 0, width: 1_920, height: 1_080 });
  expect(requests).toEqual([]);
  const before = await readCanvasPosition(page);
  const initialFrame = await page.locator("#preview-frame-wrap").boundingBox();
  const grip = await page.locator("#preview-resize-corner").boundingBox();
  const scale = await page.locator("#preview-canvas").evaluate((canvas) => canvas.getBoundingClientRect().width / 1_920);
  if (!initialFrame || !grip) throw new Error("Missing canvas frame or corner handle");
  const x = grip.x + grip.width / 2;
  const y = grip.y + grip.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 780, width: 1_920, height: 300 });
  expect(requests).toEqual([]);
  const snappedFrame = await page.locator("#preview-frame-wrap").boundingBox();
  expect(snappedFrame!.y + snappedFrame!.height).toBeCloseTo(initialFrame.y + initialFrame.height, 1);

  await page.mouse.move(x, y + Math.round(scale * 10), { steps: 1 });
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 790, width: 1_920, height: 290 });
  const resizedFrame = await page.locator("#preview-frame-wrap").boundingBox();
  expect(resizedFrame!.y + resizedFrame!.height).toBeCloseTo(initialFrame.y + initialFrame.height, 1);
  await expect(page.locator("#preview-position-meta")).toHaveText("X 0  Y 790  1920 x 290");
  expect(before.y + before.height).toBe(1_080);
  expect(requests).toEqual([]);

  await page.mouse.up();
  await expect.poll(() => requests.length).toBe(1);
  expect(requests).toEqual([{ maxChatHeight: 290 }]);
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("290");
  await expect.poll(() => page.evaluate((overlayId) => localStorage.getItem(`chatwerk-preview-position:${overlayId}`), identity.overlayId))
    .toBe(JSON.stringify({ x: 0, y: 790 }));
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 790, width: 1_920, height: 290 });
});

test("undo after a canvas handle resize restores its previous Y and readout", async ({ page }) => {
  const identity = await openStudio(page);
  await setRange(page, "maxChatHeight", 260);
  await expect(page.locator("#status-visible")).toContainText(/Saved, rev 1/u);
  await uploadBackground(page);
  const initial = await readCanvasPosition(page);
  expect(initial).toEqual({ x: 40, y: 780, width: 800, height: 260 });

  const grip = await page.locator("#preview-resize-top").boundingBox();
  if (!grip) throw new Error("Missing top resize handle");
  const scale = await page.locator("#preview-canvas").evaluate((canvas) => canvas.getBoundingClientRect().width / 1_920);
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2 - Math.round(140 * scale), { steps: 3 });
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 40, y: 640, width: 800, height: 400 });
  await page.mouse.up();
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2");

  const look = addStudioLook(identity.ownerId, "Canvas height undo", { ...DEFAULTS, maxChatHeight: 260 });
  const copiedResponse = await page.request.post(`${e2eOrigin}/api/looks/${look.slug}/copy`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { overlayId: identity.overlayId },
  });
  expect(copiedResponse.status()).toBe(200);
  const copied = await copiedResponse.json() as { revision: number; snapshotId: string; undoExpiresAt: number };
  const destination = new URL("/studio", e2eOrigin);
  destination.searchParams.set("overlay", identity.overlayId);
  destination.searchParams.set("undo", copied.snapshotId);
  destination.searchParams.set("rev", String(copied.revision));
  destination.searchParams.set("until", String(copied.undoExpiresAt));
  destination.searchParams.set("look", look.slug);
  destination.searchParams.set("lookName", "Canvas height undo");
  await page.goto(destination.toString());
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("260");
  await expect(page.locator("#undo-look")).toBeVisible();
  await uploadBackground(page);
  await expect.poll(() => readCanvasPosition(page)).toEqual(initial);
  await expect(page.locator("#preview-position-meta")).toHaveText("X 40  Y 780  800 x 260");

  await page.locator("#undo-look").click();
  await expect(page.locator("#theme-maxChatHeight")).toHaveValue("400");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 40, y: 640, width: 800, height: 400 });
  await expect(page.locator("#preview-position-meta")).toHaveText("X 40  Y 640  800 x 400");
  await expect.poll(() => page.evaluate((overlayId) => localStorage.getItem(`chatwerk-preview-position:${overlayId}`), identity.overlayId))
    .toBe(JSON.stringify({ x: 40, y: 640 }));
});

test("canvas height slider changes keep the bottom-left fixed", async ({ page }) => {
  await openStudio(page);
  await setRange(page, "maxChatHeight", 260);
  await uploadBackground(page);
  const before = await readCanvasPosition(page);
  await setRange(page, "maxChatHeight", 300);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: before.x, y: 740, width: 800, height: 300 });
  const after = await readCanvasPosition(page);
  expect(after.y + after.height).toBe(before.y + before.height);
});

test("top-right resize from a moved position clamps both axes and keeps the bottom-left fixed", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page);
  await page.locator("#preview-move-control").focus();
  await page.keyboard.press("ArrowRight");
  const before = await readCanvasPosition(page);
  const grip = await page.locator("#preview-resize-corner").boundingBox();
  if (!grip) throw new Error("Missing top-right resize handle");
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await expect(page.locator("#preview-size-drag-label")).toBeVisible();
  await page.mouse.move(grip.x + 5_000, grip.y - 5_000, { steps: 5 });
  await expect.poll(() => readCanvasPosition(page)).toEqual({
    x: before.x,
    y: 0,
    width: 1_920 - before.x,
    height: before.y + before.height,
  });
  await page.mouse.up();
  const after = await readCanvasPosition(page);
  expect(after.x).toBe(before.x);
  expect(after.y + after.height).toBe(before.y + before.height);
});

test("pointer cancel restores the start position", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page);
  const start = await readCanvasPosition(page);
  await page.evaluate(() => {
    document.querySelector<HTMLElement>("#preview-frame-wrap")!.addEventListener("pointerdown", (event) => {
      (window as CanvasWindow).__activePointerId = event.pointerId;
    }, { once: true });
  });
  const frame = await page.locator("#preview-frame-wrap").boundingBox();
  if (!frame) throw new Error("Missing preview frame");
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width / 2 + 80, frame.y + frame.height / 2 + 40, { steps: 3 });
  const during = await readCanvasPosition(page);
  expect(during).not.toEqual(start);
  await page.evaluate(() => {
    const pointerId = (window as CanvasWindow).__activePointerId!;
    document.querySelector<HTMLElement>("#preview-frame-wrap")!.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId }));
  });
  await expect.poll(() => readCanvasPosition(page)).toEqual(start);
  await page.mouse.up();
});

test("resizing the stage during a canvas move defers canvas relayout until release", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page);
  const canvas = page.locator("#preview-canvas");
  const initial = await canvas.evaluate((element) => {
    const style = (element as HTMLElement).style;
    return { left: style.left, top: style.top, width: style.width, height: style.height };
  });
  const frame = await page.locator("#preview-frame-wrap").boundingBox();
  if (!initial || !frame) throw new Error("Missing preview canvas geometry");
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width / 2 + 40, frame.y + frame.height / 2 + 20, { steps: 2 });
  await expect(page.locator("#preview-position-meta")).toHaveAttribute("aria-live", "off");
  await page.setViewportSize({ width: 1_024, height: 850 });
  await page.mouse.move(frame.x + frame.width / 2 + 60, frame.y + frame.height / 2 + 30);
  const during = await canvas.evaluate((element) => {
    const style = (element as HTMLElement).style;
    return { left: style.left, top: style.top, width: style.width, height: style.height };
  });
  expect(during).toEqual(initial);
  await page.mouse.up();
  await expect(page.locator("#preview-position-meta")).toHaveAttribute("aria-live", "polite");
  await expect.poll(async () => {
    const bounds = await canvas.boundingBox();
    return bounds ? bounds.width / bounds.height : 0;
  }).toBeCloseTo(16 / 9, 4);
  const moved = await readCanvasPosition(page);
  const relative = await page.evaluate(() => {
    const canvasBounds = document.querySelector<HTMLElement>("#preview-canvas")!.getBoundingClientRect();
    const frameBounds = document.querySelector<HTMLElement>("#preview-frame-wrap")!.getBoundingClientRect();
    const scale = canvasBounds.width / 1_920;
    return { x: (frameBounds.left - canvasBounds.left) / scale, y: (frameBounds.top - canvasBounds.top) / scale };
  });
  expect(relative.x).toBeCloseTo(moved.x, 0);
  expect(relative.y).toBeCloseTo(moved.y, 0);
});

test("oversize canvas resize clamps the bottom edge and preserves truthful width readout", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page);
  await page.locator("#preview-size-preset").selectOption("custom");
  await page.locator("#preview-custom-width").fill("800");
  await page.locator("#preview-custom-height").fill("1200");
  await page.locator("#preview-custom-apply").click();
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 40, y: 0, width: 800, height: 1_200 });
  const top = await page.locator("#preview-resize-top").boundingBox();
  if (!top) throw new Error("Missing top resize handle");
  const scale = await page.locator("#preview-canvas").evaluate((canvas) => canvas.getBoundingClientRect().width / 1_920);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id, {
    x: top.x + top.width / 2,
    y: top.y + top.height / 2,
  })).toBe("preview-resize-top");
  await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2);
  await page.mouse.down();
  await expect(page.locator("#preview-size-drag-label")).toBeVisible();
  await page.mouse.move(top.x + top.width / 2, top.y + top.height / 2 + Math.round(100 * scale), { steps: 4 });
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 40, y: 0, width: 800, height: 1_080 });
  await page.mouse.up();

  await page.locator("#preview-size-preset").selectOption("custom");
  await page.locator("#preview-custom-width").fill("2000");
  await page.locator("#preview-custom-height").fill("260");
  await page.locator("#preview-custom-apply").click();
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 0, width: 2_000, height: 260 });
  const right = page.locator("#preview-resize-right");
  await right.focus();
  await page.keyboard.press("ArrowRight");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 0, width: 2_000, height: 260 });
  await page.keyboard.press("ArrowLeft");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 0, y: 0, width: 1_990, height: 260 });
});

test("access loss cancels an active canvas move without persisting its provisional position", async ({ page }) => {
  let backupOverlayId = "";
  const identity = await openStudio(page, undefined, (current) => {
    backupOverlayId = addStudioOverlay(current.ownerId, "Backup", current.login).overlayId;
  });
  await page.evaluate((overlayId) => {
    localStorage.setItem(`chatwerk-source-size:${overlayId}`, JSON.stringify({ width: 800, height: 260 }));
    localStorage.setItem(`chatwerk-preview-position:${overlayId}`, JSON.stringify({ x: 200, y: 200 }));
  }, backupOverlayId);
  await uploadBackground(page);
  const start = await readCanvasPosition(page);
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
  const patches: Array<Record<string, unknown>> = [];
  page.on("request", (request) => {
    if (request.method() !== "PUT" || !new URL(request.url()).pathname.endsWith(`/api/overlays/${identity.overlayId}/config`)) return;
    const body = request.postDataJSON() as { patch?: Record<string, unknown> };
    if (body.patch) patches.push(body.patch);
  });
  const frame = await page.locator("#preview-frame-wrap").boundingBox();
  if (!frame) throw new Error("Missing preview frame");
  await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
  await page.mouse.down();
  await page.mouse.move(frame.x + frame.width / 2 + 80, frame.y + frame.height / 2 + 40, { steps: 3 });
  expect(await readCanvasPosition(page)).not.toEqual(start);
  await setRange(page, "fontSize", 27);
  await putStarted;
  const deleted = await page.request.delete(`${e2eOrigin}/api/overlays/${identity.overlayId}`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: {},
  });
  expect(deleted.status()).toBe(204);
  releasePut();
  await expect(page.locator("#status-visible")).toHaveText("Access changed. You were moved to Backup.");
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 200, y: 200, width: 800, height: 260 });
  expect(await page.evaluate((overlayId) => localStorage.getItem(`chatwerk-preview-position:${overlayId}`), identity.overlayId)).toBeNull();
  expect(patches).toEqual([{ fontSize: 27 }]);
  await page.mouse.up();
});

test("one-to-one and non-custom backgrounds keep the preview centered and immovable", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page);
  await page.locator("#preview-move-control").focus();
  await page.keyboard.press("Shift+ArrowRight");
  await page.locator("#preview-one-to-one").click();
  await expect(page.locator("#preview-window")).toHaveAttribute("data-canvas-mode", "false");
  const centered = async () => page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>("#preview-window")!;
    const frame = document.querySelector<HTMLElement>("#preview-frame-wrap")!;
    const stageRect = stage.getBoundingClientRect();
    const frameRect = frame.getBoundingClientRect();
    const style = getComputedStyle(stage);
    const centerX = stageRect.left + (Number.parseFloat(style.borderLeftWidth) || 0) + (Number.parseFloat(style.paddingLeft) || 0) +
      (stage.clientWidth - (Number.parseFloat(style.paddingLeft) || 0) - (Number.parseFloat(style.paddingRight) || 0)) / 2;
    const centerY = stageRect.top + (Number.parseFloat(style.borderTopWidth) || 0) + (Number.parseFloat(style.paddingTop) || 0) +
      (stage.clientHeight - (Number.parseFloat(style.paddingTop) || 0) - (Number.parseFloat(style.paddingBottom) || 0)) / 2;
    return { x: frameRect.left + frameRect.width / 2 - centerX, y: frameRect.top + frameRect.height / 2 - centerY };
  });
  const expectCentered = async () => {
    const center = await centered();
    expect(center.x).toBeCloseTo(0, 0);
    expect(center.y).toBeCloseTo(0, 0);
  };
  await expectCentered();
  const oneToOneStart = await page.locator("#preview-frame-wrap").boundingBox();
  await moveBy(page, "#preview-frame-wrap", 100, 100);
  const oneToOneEnd = await page.locator("#preview-frame-wrap").boundingBox();
  expect(oneToOneEnd?.x).toBe(oneToOneStart?.x);
  expect(oneToOneEnd?.y).toBe(oneToOneStart?.y);
  await expectCentered();
  await page.locator("#preview-fit").click();
  await expect(page.locator("#preview-window")).toHaveAttribute("data-canvas-mode", "true");
  for (const background of ["checker", "dark", "light"]) {
    await page.locator(`input[name="preview-background"][value="${background}"]`).check();
    await expect(page.locator("#preview-window")).toHaveAttribute("data-canvas-mode", "false");
    await expectCentered();
    const fitStart = await page.locator("#preview-frame-wrap").boundingBox();
    await moveBy(page, "#preview-frame-wrap", 100, 100);
    const fitEnd = await page.locator("#preview-frame-wrap").boundingBox();
    expect(fitEnd?.x).toBe(fitStart?.x);
    expect(fitEnd?.y).toBe(fitStart?.y);
  }
  await expect(page.locator("#preview-position-meta")).toBeHidden();
});

test("a non-16:9 uploaded image covers a fitted 16:9 canvas", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page, 1_024, 768);
  await expect(page.locator("#preview-window")).toHaveAttribute("data-canvas-mode", "true");
  await expect(page.locator("#preview-canvas")).toHaveCSS("background-size", "cover");
  const geometry = await page.locator("#preview-canvas").evaluate((canvas) => {
    const { width, height } = canvas.getBoundingClientRect();
    return { width, height };
  });
  expect(geometry.width / geometry.height).toBeCloseTo(16 / 9, 5);
});

test("canvas resizing preserves canvas-pixel position and the 16:9 ratio across stage sizes", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page);
  const initial = await readCanvasPosition(page);
  await moveBy(page, "#preview-frame-wrap", 100, 40);
  const moved = await readCanvasPosition(page);
  await page.setViewportSize({ width: 1_024, height: 850 });
  await expect.poll(() => readCanvasPosition(page)).toEqual(moved);
  const resizedCanvas = await page.locator("#preview-canvas").boundingBox();
  expect(resizedCanvas!.width / resizedCanvas!.height).toBeCloseTo(16 / 9, 5);
  const relative = await page.evaluate(() => {
    const canvas = document.querySelector<HTMLElement>("#preview-canvas")!.getBoundingClientRect();
    const frame = document.querySelector<HTMLElement>("#preview-frame-wrap")!.getBoundingClientRect();
    const scale = canvas.width / 1_920;
    return { x: (frame.left - canvas.left) / scale, y: (frame.top - canvas.top) / scale };
  });
  expect(relative.x).toBeCloseTo(moved.x, 0);
  expect(relative.y).toBeCloseTo(moved.y, 0);
  expect(initial).toEqual({ x: 40, y: 780, width: 800, height: 260 });
});

test("captures the initial and moved canvas at 1440px for visual review", async ({ page }) => {
  await openStudio(page);
  await uploadBackground(page);
  await mkdir(".tmp/shots", { recursive: true });
  await page.locator(".preview-column").screenshot({ path: ".tmp/shots/canvas-1440.png" });
  await moveBy(page, "#preview-frame-wrap", 100, 40);
  await page.locator(".preview-column").screenshot({ path: ".tmp/shots/canvas-moved-1440.png" });
});

test("malformed stored canvas positions fall back to the default", async ({ page }) => {
  const identity = await openStudio(page);
  await page.evaluate((overlayId) => localStorage.setItem(`chatwerk-preview-position:${overlayId}`, JSON.stringify({ x: 141, y: -2 })), identity.overlayId);
  await page.reload();
  await expect(page.locator("#status-visible")).toContainText(/Saved|Gespeichert/u);
  await uploadBackground(page);
  await expect.poll(() => readCanvasPosition(page)).toEqual({ x: 40, y: 780, width: 800, height: 260 });
});
