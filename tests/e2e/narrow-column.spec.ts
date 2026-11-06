import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";

interface FixtureMessage {
  channel: string;
  id: string;
  name: string;
  text: string;
  badgeCount: number;
}

interface ChatMutationState {
  batches: Array<{ added: string[]; removed: string[] }>;
  resizeObserverErrors: string[];
  observer?: MutationObserver;
}

interface NarrowColumnWindow extends Window {
  __chatMutationState?: ChatMutationState;
}

const badgeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="8" fill="#f0a"/></svg>';

async function openRenderer(
  page: Page,
  width: number,
  height: number,
  messages: FixtureMessage[],
  badgeImageGate?: Promise<void>,
): Promise<(message: FixtureMessage) => void> {
  await page.setViewportSize({ width, height });
  await page.route("**/api/twitch/badges/global", (route) => route.fulfill({
    status: 200,
    headers: { "access-control-allow-origin": "*", "content-type": "application/json" },
    body: JSON.stringify(messages.reduce<Record<string, unknown>[]>((sets, message) => {
      for (let index = 0; index < message.badgeCount; index += 1) {
        const id = `b${index}`;
        if (!sets.some((set) => set.set_id === id)) {
          sets.push({
            set_id: id,
            versions: [{ id: "1", image_url_2x: `https://static-cdn.jtvnw.net/badges/v1/${id}/1` }],
          });
        }
      }
      return sets;
    }, [])),
  }));
  await page.route("https://static-cdn.jtvnw.net/badges/v1/**", async (route) => {
    if (badgeImageGate) await badgeImageGate;
    await route.fulfill({
      status: 200,
      contentType: "image/svg+xml",
      body: badgeSvg,
    });
  });
  let sendFixtureMessage: ((message: FixtureMessage) => void) | undefined;
  const encodeMessage = (message: FixtureMessage): string => {
    const badges = Array.from({ length: message.badgeCount }, (_, index) => `b${index}/1`).join(",");
    return `@id=${message.id};display-name=${message.name};badges=${badges} :viewer!viewer@host PRIVMSG #${message.channel} :${message.text}`;
  };
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    sendFixtureMessage = (message) => socket.send(encodeMessage(message));
    socket.onMessage((data) => {
      const join = /^JOIN #([a-z0-9_]+)$/iu.exec(String(data).trim());
      if (!join) return;
      for (const message of messages.filter((item) => item.channel === join[1]!.toLowerCase())) {
        socket.send(encodeMessage(message));
      }
    });
  });

  await page.goto("/");
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "renderer-preview";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;border:0";
    frame.src = "/overlay#client=studio";
    document.body.appendChild(frame);
  });
  await expect(page.frameLocator("#renderer-preview").locator("#chat")).toBeVisible();
  return (message) => {
    if (!sendFixtureMessage) throw new Error("Mock IRC socket is not connected");
    sendFixtureMessage(message);
  };
}

async function startMessages(page: Page, channel: string, theme: Record<string, unknown> = {}): Promise<void> {
  await expect.poll(() => page.frameLocator("#renderer-preview").locator("body").evaluate((body) => body.ownerDocument.readyState)).toBe("complete");
  await page.evaluate(({ channel, theme }) => {
    const preview = document.querySelector<HTMLIFrameElement>("#renderer-preview")!.contentWindow!;
    preview.postMessage({
      type: "chatwerk:studio-theme",
      theme: {
        motion: "none",
        showBadges: true,
        emotes7tv: false,
        emotesBttv: false,
        emotesFfz: false,
        showPaints: false,
        badges7tv: false,
        badgesBttv: false,
        badgesFfz: false,
        badgesChatterino: false,
        backlog: false,
        ...theme,
      },
    }, "*");
    preview.postMessage({ type: "chatwerk:studio-live", enabled: true, channel }, "*");
  }, { channel, theme });
}

async function expectBadges(page: Page, count: number): Promise<void> {
  await expect(page.frameLocator("#renderer-preview").locator("img.chat-badge")).toHaveCount(count);
}

async function captureResizeObserverLoopErrors(page: Page): Promise<void> {
  await page.frameLocator("#renderer-preview").locator("body").evaluate((body) => {
    const frameWindow = body.ownerDocument.defaultView! as NarrowColumnWindow;
    const host = frameWindow;
    host.__chatMutationState ??= { batches: [], resizeObserverErrors: [] };
    frameWindow.addEventListener("error", (event) => {
      if (/ResizeObserver loop/iu.test(event.message)) host.__chatMutationState!.resizeObserverErrors.push(event.message);
    });
  });
}

test("keeps a two-badge long message beside the name with its own wrapping column at 400px", async ({ page }) => {
  await openRenderer(page, 400, 600, [{
    channel: "two_badges", id: "two-badges", name: "Viewer", text: "a long message ".repeat(18), badgeCount: 2,
  }]);
  await startMessages(page, "two_badges");
  const row = page.frameLocator("#renderer-preview").locator(".chat-line");
  await expect(row).toHaveCount(1);
  await expectBadges(page, 2);
  const geometry = await row.evaluate((element) => {
    const name = element.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
    const message = element.querySelector<HTMLElement>(".chat-message")!;
    const bounds = message.getBoundingClientRect();
    return { beside: bounds.left >= name.right, width: bounds.width, height: bounds.height, scrollWidth: message.scrollWidth, clientWidth: message.clientWidth };
  });
  expect(geometry.beside).toBe(true);
  expect(geometry.width).toBeGreaterThanOrEqual(180);
  expect(geometry.height).toBeGreaterThan(18);
  expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
});

test("short messages hug beside the name with zero to two badges on one line", async ({ page }) => {
  const messages = [0, 1, 2].map((badgeCount) => ({
    channel: "short_badges_small",
    id: `short-${badgeCount}`,
    name: "Viewer",
    text: "hi",
    badgeCount,
  }));
  await openRenderer(page, 400, 600, messages);
  await startMessages(page, "short_badges_small");
  const rows = page.frameLocator("#renderer-preview").locator(".chat-line");
  await expect(rows).toHaveCount(3);

  const geometry = await rows.evaluateAll((elements) => elements.map((element) => {
    const name = element.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
    const message = element.querySelector<HTMLElement>(".chat-message")!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return {
      badgeCount: element.querySelectorAll("img.chat-badge").length,
      nameMessageTopDelta: Math.abs(message.top - name.top),
      rowHeight: bounds.height,
      oneLineHeight: Math.max(name.height, message.height, element.querySelector<HTMLElement>(".chat-badges")!.getBoundingClientRect().height),
    };
  }));

  expect(geometry.map((row) => row.badgeCount)).toEqual([0, 1, 2]);
  for (const row of geometry) {
    expect(row.nameMessageTopDelta).toBeLessThanOrEqual(1);
    expect(row.rowHeight).toBeLessThanOrEqual(row.oneLineHeight + 4);
  }
});

test("keeps a short message beside nine badges and sizes the row to its content", async ({ page }) => {
  await openRenderer(page, 400, 600, [{
    channel: "short_badges", id: "short-badges", name: "Viewer", text: "hi", badgeCount: 9,
  }]);
  await startMessages(page, "short_badges");
  const row = page.frameLocator("#renderer-preview").locator(".chat-line");
  await expect(row).toHaveCount(1);
  await expectBadges(page, 9);
  const geometry = await row.evaluate((element) => {
    const bounds = element.getBoundingClientRect();
    const name = element.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
    const message = element.querySelector<HTMLElement>(".chat-message")!.getBoundingClientRect();
    const badges = element.querySelector<HTMLElement>(".chat-badges")!.getBoundingClientRect();
    return {
      rowWidth: bounds.width,
      contentRight: Math.max(name.right, message.right, badges.right),
      nameAndMessageShareLine: name.top === message.top,
      messageLeft: message.left,
      rowLeft: bounds.left,
    };
  });
  expect(geometry.nameAndMessageShareLine).toBe(true);
  expect(geometry.rowWidth).toBeLessThan(400);
  expect(geometry.rowWidth - (geometry.contentRight - geometry.rowLeft)).toBeLessThanOrEqual(1);
});

test("moves a long message below nine one-line badges at 400px", async ({ page }) => {
  await openRenderer(page, 400, 600, [{
    channel: "long_badges", id: "long-badges", name: "Viewer", text: "a long message ".repeat(18), badgeCount: 9,
  }]);
  await startMessages(page, "long_badges");
  const row = page.frameLocator("#renderer-preview").locator(".chat-line");
  await expect(row).toHaveCount(1);
  await expectBadges(page, 9);
  const geometry = await row.evaluate((element) => {
    const rowBounds = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const badges = element.querySelector<HTMLElement>(".chat-badges")!;
    const badgeBounds = [...badges.querySelectorAll("img")].map((image) => image.getBoundingClientRect());
    const name = element.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
    const message = element.querySelector<HTMLElement>(".chat-message")!.getBoundingClientRect();
    return {
      messageUnderName: message.top > name.top,
      messageStartsAtRow: Math.abs(message.left - rowBounds.left) < 1,
      badgesOneLine: badgeBounds.every((badge) => Math.abs(badge.top - badgeBounds[0]!.top) < 1),
      badgeNameGap: name.left - badgeBounds.at(-1)!.right,
      columnGap: Number.parseFloat(style.columnGap),
      messageWidth: message.width,
      messageHeight: message.height,
      rowWidth: rowBounds.width,
    };
  });
  expect(geometry.messageUnderName).toBe(true);
  expect(geometry.messageStartsAtRow).toBe(true);
  expect(geometry.badgesOneLine).toBe(true);
  expect(geometry.badgeNameGap).toBeCloseTo(geometry.columnGap, 1);
  expect(geometry.messageWidth).toBe(400);
  expect(geometry.messageHeight).toBeGreaterThan(18);
  expect(geometry.rowWidth).toBe(400);

  await mkdir(path.resolve(".tmp/shots"), { recursive: true });
  await page.frameLocator("#renderer-preview").locator("body").screenshot({ path: ".tmp/shots/narrow-400.png" });
});

test("keeps the existing stack wrapping rule at 240px", async ({ page }) => {
  await openRenderer(page, 240, 600, [{
    channel: "small_width", id: "small-width", name: "Viewer", text: "a narrow message ".repeat(8), badgeCount: 9,
  }]);
  await startMessages(page, "small_width");
  const row = page.frameLocator("#renderer-preview").locator(".chat-line");
  await expect(row).toHaveCount(1);
  const rules = await row.evaluate((element) => ({
    lineWrap: getComputedStyle(element).flexWrap,
    messageBasis: getComputedStyle(element.querySelector<HTMLElement>(".chat-message")!).flexBasis,
    badgeWrap: getComputedStyle(element.querySelector<HTMLElement>(".chat-badges")!).flexWrap,
  }));
  expect(rules).toEqual({ lineWrap: "wrap", messageBasis: "100%", badgeWrap: "wrap" });
});

test("preserves own-line names and panel geometry", async ({ page }) => {
  await openRenderer(page, 400, 600, [{
    channel: "layout_modes", id: "layout-modes", name: "Viewer", text: "a long message ".repeat(18), badgeCount: 9,
  }]);
  await startMessages(page, "layout_modes", {
    nameOnOwnLine: true,
    panelEnabled: true,
    panelBorderWidth: 2,
    panelPadding: 8,
  });
  const preview = page.frameLocator("#renderer-preview");
  const chat = preview.locator("#chat");
  const row = preview.locator(".chat-line");
  await expect(row).toHaveCount(1);
  await expect(row).toHaveClass(/chat-name-own-line/u);
  await expect(chat).toHaveAttribute("data-panel-enabled", "true");
  await expect(chat).toHaveCSS("border-top-width", "2px");
  await expect(chat).toHaveCSS("padding-top", "8px");
  await expect.poll(() => row.evaluate((element) => {
    return element.querySelector(".chat-name")!.getBoundingClientRect().top <
      element.querySelector(".chat-message")!.getBoundingClientRect().top;
  })).toBe(true);
});

test("does not apply automatic wrapping to message-first rows", async ({ page }) => {
  await openRenderer(page, 400, 600, [{
    channel: "message_first", id: "message-first", name: "Viewer", text: "a long message ".repeat(18), badgeCount: 9,
  }]);
  await startMessages(page, "message_first", { lineOrder: "message-first" });
  const chat = page.frameLocator("#renderer-preview").locator("#chat");
  const row = page.frameLocator("#renderer-preview").locator(".chat-line");
  await expect(row).toHaveCount(1);
  await expect(chat).toHaveAttribute("data-line-order", "message-first");
  await expect.poll(() => row.evaluate((element) => element.firstElementChild?.classList.contains("chat-message"))).toBe(true);
  await expect.poll(() => row.evaluate((element) => {
    const message = element.querySelector<HTMLElement>(".chat-message")!.getBoundingClientRect();
    const name = element.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
    return Math.abs(message.top - name.top) < 1;
  })).toBe(true);
});

test("keeps ticker rows on one line with panel styling", async ({ page }) => {
  await openRenderer(page, 400, 600, [{
    channel: "ticker_modes", id: "ticker-modes", name: "Viewer", text: "a long message ".repeat(18), badgeCount: 9,
  }]);
  await startMessages(page, "ticker_modes", {
    layout: "ticker",
    panelEnabled: true,
    panelBorderWidth: 2,
    panelPadding: 8,
  });
  const chat = page.frameLocator("#renderer-preview").locator("#chat");
  const row = page.frameLocator("#renderer-preview").locator(".chat-line");
  await expect(row).toHaveCount(1);
  await expect(chat).toHaveAttribute("data-layout", "ticker");
  await expect(row).toHaveClass(/ticker-line/u);
  await expect(row.locator(".chat-message")).toHaveCSS("white-space", "pre");
  await expect(chat).toHaveAttribute("data-panel-enabled", "true");
  await expect(chat).toHaveCSS("border-top-width", "2px");
  await expect(chat).toHaveCSS("padding-top", "8px");
});

test("keeps height pruning correct while resize loops preserve each width's row layout", async ({ page }) => {
  const long = "a long message ".repeat(8);
  await openRenderer(page, 400, 600, [
    { channel: "pruning", id: "prune-1", name: "Viewer", text: `one ${long}`, badgeCount: 9 },
    { channel: "pruning", id: "prune-2", name: "Viewer", text: `two ${long}`, badgeCount: 9 },
    { channel: "pruning", id: "prune-3", name: "Viewer", text: `three ${long}`, badgeCount: 9 },
    { channel: "pruning", id: "prune-4", name: "Viewer", text: `four ${long}`, badgeCount: 9 },
  ]);
  await captureResizeObserverLoopErrors(page);
  await startMessages(page, "pruning");
  const preview = page.frameLocator("#renderer-preview");
  const chat = preview.locator("#chat");
  const rows = preview.locator(".chat-line");
  await expect(rows).toHaveCount(4);
  await expectBadges(page, 36);
  await page.setViewportSize({ width: 400, height: 140 });
  await expect.poll(() => chat.evaluate((element) => element.ownerDocument.defaultView!.innerHeight)).toBe(140);
  await expect.poll(() => rows.count()).toBeLessThan(4);
  const prunedGeometry = await chat.evaluate((element) => {
    const frame = element.getBoundingClientRect();
    const rows = [...element.querySelectorAll<HTMLElement>(".chat-line")].map((line) => line.getBoundingClientRect());
    const visibleCount = rows.filter((bounds) => bounds.top >= frame.top - 0.5 && bounds.bottom <= frame.bottom + 0.5).length;
    return { frame, rows, visibleCount };
  });
  expect(prunedGeometry.visibleCount).toBe(1);
  expect(prunedGeometry.rows).toHaveLength(1);
  expect(prunedGeometry.rows.every((bounds) => bounds.top >= prunedGeometry.frame.top - 0.5 && bounds.bottom <= prunedGeometry.frame.bottom + 0.5)).toBe(true);

  await page.setViewportSize({ width: 400, height: 600 });
  await expect(rows).toHaveCount(4);
  await expect(rows.last().locator(".chat-message")).toContainText("four");

  const layouts: Array<{ width: number; under: boolean }> = [];
  for (const width of [400, 520, 400, 520, 400, 520, 400]) {
    await page.setViewportSize({ width, height: 600 });
    await expect.poll(() => preview.locator("#chat").evaluate((element) => element.ownerDocument.defaultView!.innerWidth)).toBe(width);
    const under = await rows.first().evaluate((element) => {
      const name = element.querySelector<HTMLElement>(".chat-name")!.getBoundingClientRect();
      const message = element.querySelector<HTMLElement>(".chat-message")!.getBoundingClientRect();
      return message.top > name.top;
    });
    layouts.push({ width, under });
    const visibleGeometry = await chat.evaluate((element) => {
      const frame = element.getBoundingClientRect();
      const visibleRows = [...element.querySelectorAll<HTMLElement>(".chat-line")].map((line) => line.getBoundingClientRect());
      return { frame, rows: visibleRows };
    });
    expect(visibleGeometry.rows.every((bounds) => bounds.top >= visibleGeometry.frame.top - 0.5 && bounds.bottom <= visibleGeometry.frame.bottom + 0.5)).toBe(true);
  }
  expect(layouts).toEqual([
    { width: 400, under: true },
    { width: 520, under: false },
    { width: 400, under: true },
    { width: 520, under: false },
    { width: 400, under: true },
    { width: 520, under: false },
    { width: 400, under: true },
  ]);
  await expect.poll(() => preview.locator("body").evaluate(() => (window as NarrowColumnWindow).__chatMutationState?.resizeObserverErrors)).toEqual([]);
});

test("height pruning removes one oldest short two-badge row per message without adding rows back", async ({ page }) => {
  let releaseBadgeImages!: () => void;
  const badgeImageGate = new Promise<void>((resolve) => { releaseBadgeImages = resolve; });
  const initialMessages = [1, 2].map((index) => ({
    channel: "height_pruning_short",
    id: `initial-${index}`,
    name: "Viewer",
    text: `initial-${index}`,
    badgeCount: 2,
  }));
  const sendFixtureMessage = await openRenderer(page, 400, 200, initialMessages, badgeImageGate);
  await captureResizeObserverLoopErrors(page);
  await startMessages(page, "height_pruning_short", { maxChatHeight: 80, neverFade: true });
  const preview = page.frameLocator("#renderer-preview");
  const chat = preview.locator("#chat");
  const rows = chat.locator(".chat-line");
  await expect(rows).toHaveCount(2);
  await expectBadges(page, 4);
  await expect.poll(() => chat.evaluate((element) => [...element.querySelectorAll<HTMLElement>(".chat-line")].map((row) => row.querySelector(".chat-message")!.textContent?.trim()))).toEqual(["initial-1", "initial-2"]);

  await preview.locator("body").evaluate(async (body) => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    const root = body.ownerDocument.querySelector<HTMLElement>("#chat")!;
    const host = window as NarrowColumnWindow;
    const state: ChatMutationState = { batches: [], resizeObserverErrors: host.__chatMutationState?.resizeObserverErrors ?? [] };
    host.__chatMutationState = state;
    window.addEventListener("error", (event) => {
      if (/ResizeObserver loop/iu.test(event.message)) state.resizeObserverErrors.push(event.message);
    });
    const rowKey = (node: Node): string | undefined => {
      if (!(node instanceof HTMLElement) || !node.classList.contains("chat-line")) return undefined;
      return node.querySelector(".chat-message")?.textContent?.trim() ?? undefined;
    };
    const observer = new MutationObserver((records) => {
      const added = records.flatMap((record) => [...record.addedNodes]).map(rowKey).filter((key): key is string => Boolean(key));
      const removed = records.flatMap((record) => [...record.removedNodes]).map(rowKey).filter((key): key is string => Boolean(key));
      if (added.length > 0 || removed.length > 0) state.batches.push({ added, removed });
    });
    observer.observe(root, { childList: true });
    state.observer = observer;
  });

  let oldestVisible = "initial-1";
  for (let index = 1; index <= 4; index += 1) {
    const message = {
      channel: "height_pruning_short",
      id: `live-${index}`,
      name: "Viewer",
      text: `live-${index}`,
      badgeCount: 2,
    };
    const priorBatchCount = await preview.locator("body").evaluate((body) => (body.ownerDocument.defaultView as NarrowColumnWindow).__chatMutationState!.batches.length);
    sendFixtureMessage(message);
    await expect.poll(() => chat.locator(".chat-line").evaluateAll((visibleRows) => visibleRows.map((row) => row.querySelector(".chat-message")!.textContent?.trim()))).toEqual([oldestVisible === "initial-1" ? "initial-2" : `live-${index - 1}`, `live-${index}`]);
    await expect.poll(() => preview.locator("body").evaluate((body) => (body.ownerDocument.defaultView as NarrowColumnWindow).__chatMutationState!.batches.length)).toBeGreaterThan(priorBatchCount);
    await preview.locator("body").evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

    const changes = await preview.locator("body").evaluate((body, since) => (body.ownerDocument.defaultView as NarrowColumnWindow).__chatMutationState!.batches.slice(since), priorBatchCount);
    expect(changes.flatMap((batch) => batch.added)).toEqual([`live-${index}`]);
    expect(changes.flatMap((batch) => batch.removed)).toEqual([oldestVisible]);
    oldestVisible = oldestVisible === "initial-1" ? "initial-2" : `live-${index - 1}`;
  }

  await preview.locator("body").evaluate(() => (window as NarrowColumnWindow).__chatMutationState!.observer?.disconnect());
  releaseBadgeImages();
  await expect.poll(() => chat.locator("img.chat-badge").evaluateAll((images) => images.every((image) => (image as HTMLImageElement).complete && (image as HTMLImageElement).naturalWidth > 0))).toBe(true);
  await preview.locator("body").evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect.poll(() => preview.locator("body").evaluate((body) => (body.ownerDocument.defaultView as NarrowColumnWindow).__chatMutationState!.resizeObserverErrors)).toEqual([]);
});
