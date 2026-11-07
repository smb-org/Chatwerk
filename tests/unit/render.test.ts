import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { DEFAULTS, ensureReadableNameColor, estimateTextLegibility, validateTheme } from "../../src/shared/theme";
import { createChatRenderer } from "../../src/renderer/render";
import { parseIrcLine } from "../../src/renderer/irc-parse";
import { createEmoteLookup, type EmoteAsset } from "../../src/renderer/emotes";
import { createBadgeLookup } from "../../src/renderer/badges";
import { buildPaintStyle, createPaintLookup } from "../../src/renderer/paints";

const dom = new JSDOM("<!doctype html><main id='chat'></main>");
const root = dom.window.document.querySelector("main") as HTMLElement;
let restoreResizeObserver: (() => void) | undefined;

afterEach(() => {
  restoreResizeObserver?.();
  restoreResizeObserver = undefined;
  root.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function rect(top: number, height: number, width: number): DOMRect {
  return {
    x: 0, y: top, width, height, top, right: width, bottom: top + height, left: 0,
    toJSON: () => ({}),
  };
}

describe("text renderer", () => {
  it("refreshes backlog rows when channel emotes arrive for messages without a room id", () => {
    let publishChannelEmotes!: (assets: EmoteAsset[]) => void;
    const emotes = createEmoteLookup({ providers: [{
      name: "7TV",
      loadGlobal() {
        return new Promise<EmoteAsset[]>(() => undefined);
      },
      loadChannel(_channelId, onUpdate) {
        publishChannelEmotes = onUpdate;
        return new Promise<EmoteAsset[]>(() => undefined);
      },
    }] });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, emotes7tv: true },
      emotes,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=backlog-emote;historical=1 :viewer!viewer@host PRIVMSG #room :Pog")!);
    const row = root.querySelector<HTMLElement>(".chat-line")!;
    emotes.setChannelIds(["10"]);

    expect(row.querySelector("img.chat-emote")).toBeNull();
    publishChannelEmotes([{ name: "Pog", url: "https://cdn.7tv.app/emote/pog/2x.webp", provider: "7TV" }]);

    expect(row.querySelector('img.chat-emote[alt="Pog"]')).not.toBeNull();
    renderer.dispose();
  });

  it("re-tokenizes only matching existing rows after emote assets arrive without extending their lifetime", () => {
    vi.useFakeTimers();
    let publish!: (assets: EmoteAsset[]) => void;
    const emotes = createEmoteLookup({ providers: [{
      name: "7TV",
      loadGlobal(onUpdate) {
        publish = onUpdate;
        return new Promise<EmoteAsset[]>(() => undefined);
      },
    }] });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, lifetime: 1_000, motion: "none" },
      emotes,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=late-emote;msg-id=highlighted-message :viewer!viewer@host PRIVMSG #room :Pog")!);
    renderer.handle(parseIrcLine("@id=unrelated :viewer!viewer@host PRIVMSG #room :ordinary text")!);
    const emoteRow = root.querySelector<HTMLElement>("[data-received-at]")!;
    const unrelatedRow = [...root.querySelectorAll<HTMLElement>(".chat-line")].find((line) => line.textContent?.includes("ordinary text"))!;
    const unrelatedContent = unrelatedRow.querySelector(".chat-message")!.firstChild;
    const receivedAt = emoteRow.dataset.receivedAt;

    expect(emoteRow.querySelector("img.chat-emote")).toBeNull();
    vi.advanceTimersByTime(600);
    publish([{ name: "Pog", url: "https://cdn.7tv.app/emote/pog/2x.webp", provider: "7TV" }]);

    expect(emoteRow.querySelector('img.chat-emote[alt="Pog"]')).not.toBeNull();
    expect(root.querySelectorAll(".chat-line")[0]).toBe(emoteRow);
    expect(root.querySelectorAll(".chat-line")[1]).toBe(unrelatedRow);
    expect(unrelatedRow.querySelector(".chat-message")!.firstChild).toBe(unrelatedContent);
    expect(emoteRow.classList.contains("chat-highlighted")).toBe(true);
    expect(emoteRow.dataset.receivedAt).toBe(receivedAt);
    vi.advanceTimersByTime(399);
    expect(emoteRow.isConnected).toBe(true);
    expect(unrelatedRow.isConnected).toBe(true);
    vi.advanceTimersByTime(1);
    expect(emoteRow.isConnected).toBe(false);
    expect(unrelatedRow.isConnected).toBe(false);
    renderer.dispose();
  });

  it("preserves Twitch ranges and zero-width overlays when a late asset update re-tokenizes rows", () => {
    let publish!: (assets: EmoteAsset[]) => void;
    const emotes = createEmoteLookup({ providers: [{
      name: "7TV",
      loadGlobal(onUpdate) {
        publish = onUpdate;
        return new Promise<EmoteAsset[]>(() => undefined);
      },
    }] });
    const renderer = createChatRenderer({ root, theme: DEFAULTS, emotes, scheduler: (callback) => { callback(); return 1; } });
    renderer.handle(parseIrcLine("@id=native;emotes=25:0-4 :viewer!viewer@host PRIVMSG #room :Kappa Pog")!);
    renderer.handle(parseIrcLine("@id=overlay :viewer!viewer@host PRIVMSG #room :BaseOverlay")!);
    const nativeRow = root.querySelector<HTMLElement>("[data-received-at]")!;
    const overlayRow = [...root.querySelectorAll<HTMLElement>(".chat-line")].find((line) => line.querySelector(".chat-message")?.textContent === "BaseOverlay")!;

    publish([
      { name: "Pog", url: "https://cdn.7tv.app/emote/pog/2x.webp", provider: "7TV" },
      { name: "Base", url: "https://cdn.7tv.app/emote/base/2x.webp", provider: "7TV" },
      { name: "Overlay", url: "https://cdn.7tv.app/emote/overlay/2x.webp", provider: "7TV", zeroWidth: true },
    ]);

    expect([...nativeRow.querySelectorAll<HTMLImageElement>("img.chat-emote")].map((image) => image.alt)).toEqual(["Kappa", "Pog"]);
    expect(overlayRow.querySelector(".chat-emote-wrapper img.chat-emote[alt=\"Base\"]")).not.toBeNull();
    expect(overlayRow.querySelector("img.chat-emote-overlay[alt=\"Overlay\"]")).not.toBeNull();
    renderer.dispose();
  });

  it("updates hidden height-pruned rows when matching emotes arrive", () => {
    const nativeGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, 30, 400);
      if (this.classList.contains("chat-line")) return rect(0, 30, 400);
      return nativeGetBoundingClientRect.call(this);
    });
    let publish!: (assets: EmoteAsset[]) => void;
    const emotes = createEmoteLookup({ providers: [{
      name: "7TV",
      loadGlobal(onUpdate) {
        publish = onUpdate;
        return new Promise<EmoteAsset[]>(() => undefined);
      },
    }] });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 30 },
      emotes,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=hidden-emote :viewer!viewer@host PRIVMSG #room :Pog")!);
    const hiddenRow = root.firstElementChild as HTMLElement;
    renderer.handle(parseIrcLine("@id=newest :viewer!viewer@host PRIVMSG #room :newest")!);
    expect(hiddenRow.isConnected).toBe(false);

    publish([{ name: "Pog", url: "https://cdn.7tv.app/emote/pog/2x.webp", provider: "7TV" }]);

    expect(hiddenRow.querySelector('img.chat-emote[alt="Pog"]')).not.toBeNull();
    expect(hiddenRow.isConnected).toBe(false);
    renderer.dispose();
  });

  it("batches emote refreshes to one scheduled tick across more than 100 rows", () => {
    let publish!: (assets: EmoteAsset[]) => void;
    const emotes = createEmoteLookup({ providers: [{
      name: "7TV",
      loadGlobal(onUpdate) {
        publish = onUpdate;
        return new Promise<EmoteAsset[]>(() => undefined);
      },
    }] });
    const callbacks: Array<{ id: number; callback: () => void }> = [];
    let scheduledCount = 0;
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxLines: 150 },
      nodeLimit: 200,
      emotes,
      scheduler: (callback) => {
        const id = ++scheduledCount;
        callbacks.push({ id, callback });
        return id;
      },
      cancelScheduled: (handle) => {
        const index = callbacks.findIndex((item) => item.id === handle);
        if (index >= 0) callbacks.splice(index, 1);
      },
    });
    for (let index = 0; index < 120; index += 1) {
      renderer.handle(parseIrcLine(`@id=batch-${index} :viewer!viewer@host PRIVMSG #room :Pog ${index}`)!);
    }
    callbacks.shift()!.callback();
    const countBeforeUpdates = scheduledCount;

    publish([{ name: "Pog", url: "https://cdn.7tv.app/emote/pog/2x.webp", provider: "7TV" }]);
    publish([
      { name: "Pog", url: "https://cdn.7tv.app/emote/pog/2x.webp", provider: "7TV" },
      { name: "Other", url: "https://cdn.7tv.app/emote/other/2x.webp", provider: "7TV" },
    ]);

    expect(scheduledCount - countBeforeUpdates).toBe(1);
    callbacks.shift()!.callback();
    expect(root.querySelectorAll('img.chat-emote[alt="Pog"]')).toHaveLength(120);
    renderer.dispose();
  });

  it("leaves already-rendered 7TV emotes in place when the provider is switched off", async () => {
    const emotes = createEmoteLookup({ providers: [{
      name: "7TV",
      async loadGlobal() {
        return [{ name: "Pog", url: "https://cdn.7tv.app/emote/pog/2x.webp", provider: "7TV" }];
      },
    }] });
    await vi.waitFor(() => expect(emotes.resolve("Pog")).toBeDefined());
    const renderer = createChatRenderer({ root, theme: DEFAULTS, emotes, scheduler: (callback) => { callback(); return 1; } });
    renderer.handle(parseIrcLine("@id=before-off :viewer!viewer@host PRIVMSG #room :Pog")!);
    const existingRow = root.querySelector<HTMLElement>(".chat-line")!;

    renderer.setTheme({ ...DEFAULTS, emotes7tv: false });

    expect(existingRow.querySelector('img.chat-emote[alt="Pog"]')).not.toBeNull();
    renderer.handle(parseIrcLine("@id=after-off :viewer!viewer@host PRIVMSG #room :Pog")!);
    expect(root.querySelectorAll('img.chat-emote[alt="Pog"]')).toHaveLength(1);
    expect(root.textContent).toContain("Pog");
    renderer.dispose();
  });

  it("keeps a default-theme message after 12 seconds and removes it after 120 seconds", () => {
    vi.useFakeTimers();
    const renderer = createChatRenderer({
      root,
      theme: DEFAULTS,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=default-lifetime :viewer!viewer@host PRIVMSG #room :still here")!);
    const row = root.querySelector<HTMLElement>(".chat-line");

    vi.advanceTimersByTime(12_001);
    expect(row?.textContent).toContain("still here");
    expect(row?.style.getPropertyValue("opacity")).toBe("1");

    vi.advanceTimersByTime(107_999);
    expect(row?.style.getPropertyValue("opacity")).toBe("0");
    vi.advanceTimersByTime(200);
    expect(root.children).toHaveLength(0);
    renderer.dispose();
  });

  it("keeps a 300-second message row after 120 seconds", () => {
    vi.useFakeTimers();
    const theme = validateTheme({ ...DEFAULTS, lifetime: 300_000 });
    const renderer = createChatRenderer({
      root,
      theme,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=long-lifetime :viewer!viewer@host PRIVMSG #room :still here")!);
    const row = root.querySelector<HTMLElement>(".chat-line");

    vi.advanceTimersByTime(120_001);

    expect(row?.isConnected).toBe(true);
    expect(row?.textContent).toContain("still here");
    renderer.dispose();
  });

  it("keeps HTML in chat messages as text", () => {
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@display-name=Viewer :viewer!viewer@host PRIVMSG #room :<img onerror=x>" )!);
    expect(root.textContent).toContain("<img onerror=x>");
    expect(root.querySelector("img")).toBeNull();
    renderer.dispose();
  });

  it("does not restore pronouns when a pending lookup resolves after names are hidden", async () => {
    let resolvePronouns!: (value: string | null) => void;
    const pronouns = {
      lookup: vi.fn(() => new Promise<string | null>((resolve) => { resolvePronouns = resolve; })),
      dispose: vi.fn(),
    };
    const theme = { ...DEFAULTS, showPronouns: true };
    const renderer = createChatRenderer({ root, theme, pronouns, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=pending-pronouns;display-name=Viewer;login=viewer :viewer!viewer@host PRIVMSG #room :still hidden")!);
    const pronounNode = root.querySelector<HTMLElement>(".chat-pronouns")!;
    expect(pronouns.lookup).toHaveBeenCalledWith("viewer");

    renderer.setTheme({ ...theme, hideNames: true });
    resolvePronouns("They/Them");
    await Promise.resolve();
    expect(pronounNode.textContent).toBe("");
    renderer.dispose();
  });

  it("caps the DOM at 100 messages and batches appends through the scheduler", () => {
    let flush: (() => void) | undefined;
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxLines: 100 },
      nodeLimit: 900,
      scheduler: (callback) => { flush = callback; return 1; },
      cancelScheduled: () => { flush = undefined; },
    });
    for (let i = 0; i < 300; i += 1) {
      renderer.handle(parseIrcLine(`@id=${i} :viewer!viewer@host PRIVMSG #room :message ${i}`)!);
    }
    expect(root.children).toHaveLength(0);
    flush?.();
    expect(root.children.length).toBe(100);
    renderer.handle(parseIrcLine("@id=300 :viewer!viewer@host PRIVMSG #room :message 300")!);
    flush?.();
    expect(root.children.length).toBe(100);
    expect(root.textContent).not.toContain("message 0");
    renderer.dispose();
  });

  it("uses 100 lines by default and applies fade or no-motion lifetime behavior", () => {
    vi.useFakeTimers();
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, lifetime: 1_000 },
      scheduler: (callback) => { callback(); return 1; },
    });
    for (let i = 0; i < 101; i += 1) {
      renderer.handle(parseIrcLine(`@id=${i} :viewer!viewer@host PRIVMSG #room :message ${i}`)!);
    }
    expect(root.children).toHaveLength(100);
    expect(root.textContent).not.toContain("message 0");
    vi.advanceTimersByTime(1_000);
    expect(root.firstElementChild?.getAttribute("style")).toContain("opacity: 0");
    expect(root.firstElementChild?.getAttribute("style")).toContain("translateY(-4px)");
    vi.advanceTimersByTime(200);
    expect(root.children).toHaveLength(0);
    renderer.setTheme({ ...DEFAULTS, lifetime: 1_000, motion: "none" });
    renderer.handle(parseIrcLine("@id=none :viewer!viewer@host PRIVMSG #room :no fade")!);
    vi.advanceTimersByTime(1_000);
    expect(root.children).toHaveLength(0);
    renderer.dispose();
  });

  it("keeps never-fade lines past lifetime but still removes the oldest at maxLines", () => {
    vi.useFakeTimers();
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, lifetime: 1_000, neverFade: true, maxLines: 2 },
      scheduler: (callback) => { callback(); return 1; },
    });
    const send = (id: string, message: string): void => {
      renderer.handle(parseIrcLine(`@id=${id} :viewer!viewer@host PRIVMSG #room :${message}`)!);
    };
    send("never-1", "first");
    const first = root.firstElementChild as HTMLElement;
    vi.advanceTimersByTime(5_000);
    expect(first.isConnected).toBe(true);
    send("never-2", "second");
    send("never-3", "third");
    expect(root.querySelectorAll(".chat-line")).toHaveLength(2);
    expect(first.isConnected).toBe(false);
    expect(root.textContent).toContain("second");
    expect(root.textContent).toContain("third");
    renderer.dispose();
  });

  it("uses maxLines for a burst and detaches reaction state from the removed line", () => {
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxLines: 1 },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=raid;msg-id=raid;msg-param-viewerCount=10 :tmi.twitch.tv USERNOTICE #room :Raiding")!);
    const raid = root.querySelector<HTMLElement>(".chat-line")!;
    expect(raid.classList.contains("chat-reaction-highlight")).toBe(true);
    renderer.handle(parseIrcLine("@id=after-raid :viewer!viewer@host PRIVMSG #room :new line")!);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(raid.isConnected).toBe(false);
    expect(raid.classList.contains("chat-reaction-highlight")).toBe(false);
    expect(root.textContent).toContain("new line");
    renderer.dispose();
  });

  it.each(["name-first", "message-first"] as const)("hides oldest lines on shrink and restores valid lines on grow with %s order", (lineOrder) => {
    let frameHeight = 200;
    const nativeGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    let resizeCallback: ResizeObserverCallback | undefined;
    const originalResizeObserver = Object.getOwnPropertyDescriptor(dom.window, "ResizeObserver");
    Object.defineProperty(dom.window, "ResizeObserver", {
      configurable: true,
      value: class {
        constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
        observe(): void { /* The test triggers frame resizes directly. */ }
        unobserve(): void { /* The test observes only the renderer root. */ }
        disconnect(): void { /* No browser resources are held by this fake. */ }
      },
    });
    restoreResizeObserver = () => {
      if (originalResizeObserver) Object.defineProperty(dom.window, "ResizeObserver", originalResizeObserver);
      else delete (dom.window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    };
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, frameHeight, 400);
      if (!this.classList.contains("chat-line")) return nativeGetBoundingClientRect.call(this);
      const rows = [...root.querySelectorAll<HTMLElement>(".chat-line")];
      const index = rows.indexOf(this);
      const heights = rows.map((row) => Number(row.dataset.testHeight ?? 60));
      const total = heights.reduce((sum, height) => sum + height, 0);
      const top = frameHeight - total + heights.slice(0, index).reduce((sum, height) => sum + height, 0);
      return rect(top, heights[index]!, 400);
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 200, lineOrder },
      scheduler: (callback) => { callback(); return 1; },
    });
    const send = (id: string, value: string): HTMLElement => {
      renderer.handle(parseIrcLine(`@id=${id} :viewer!viewer@host PRIVMSG #room :${value}`)!);
      return root.lastElementChild as HTMLElement;
    };
    send("height-1", "old one");
    send("height-2", "old two");
    send("height-3", "middle");
    const newest = send("height-4", "newest");
    expect(root.querySelectorAll(".chat-line")).toHaveLength(3);
    expect(root.textContent).not.toContain("old one");
    expect(root.textContent).toContain("old two");
    expect(newest.isConnected).toBe(true);
    expect([...root.querySelectorAll<HTMLElement>(".chat-line")].every((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.top >= 0 && bounds.bottom <= frameHeight;
    })).toBe(true);

    frameHeight = 120;
    resizeCallback?.([], {} as ResizeObserver);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(2);
    expect(root.textContent).toContain("newest");

    frameHeight = 300;
    resizeCallback?.([], {} as ResizeObserver);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(4);
    expect(root.textContent).toContain("old one");
    renderer.dispose();
    restoreResizeObserver();
    restoreResizeObserver = undefined;
  });

  it("keeps an oversized newest row and hides every older row behind it", () => {
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, 100, 400);
      if (!this.classList.contains("chat-line")) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
      const rows = [...root.querySelectorAll<HTMLElement>(".chat-line")];
      const index = rows.indexOf(this);
      const lineHeight = (row: HTMLElement): number => row.textContent?.includes("huge") ? 250 : 60;
      const height = lineHeight(this);
      const top = 100 - rows.reduce((sum, row) => sum + lineHeight(row), 0) + rows.slice(0, index).reduce((sum, row) => sum + lineHeight(row), 0);
      return rect(top, height, 400);
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 100, panelEnabled: true },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=short-old :viewer!viewer@host PRIVMSG #room :short old")!);
    renderer.handle(parseIrcLine("@id=short-middle :viewer!viewer@host PRIVMSG #room :short middle")!);
    renderer.handle(parseIrcLine("@id=huge :viewer!viewer@host PRIVMSG #room :huge")!);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.textContent).toContain("huge");
    expect(root.textContent).not.toContain("short middle");
    expect(root.textContent).not.toContain("short old");
    expect(root.querySelector<HTMLElement>(".chat-line")!.getBoundingClientRect().top).toBeLessThan(0);
    expect(root.querySelector<HTMLElement>(".chat-line")!.getBoundingClientRect().bottom).toBe(100);
    renderer.dispose();
  });

  it("restores an older height-pruned row after the visible newest row is moderated", () => {
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, 100, 400);
      if (!this.classList.contains("chat-line")) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
      return rect(40, 60, 400);
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 100 },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=older;room-id=10 :viewer!viewer@host PRIVMSG #room :older")!);
    renderer.handle(parseIrcLine("@id=newest;room-id=10 :viewer!viewer@host PRIVMSG #room :newest")!);
    expect(root.textContent).toContain("newest");
    expect(root.textContent).not.toContain("older");

    renderer.handle(parseIrcLine("@room-id=10;target-msg-id=newest :tmi.twitch.tv CLEARMSG #room :newest")!);

    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.textContent).toContain("older");
    renderer.dispose();
  });

  it("does not move settled rows when sorting a new append preserves their order", () => {
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, 200, 400);
      if (!this.classList.contains("chat-line")) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
      return rect(140, 60, 400);
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 200 },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=settled-1 :viewer!viewer@host PRIVMSG #room :first")!);
    renderer.handle(parseIrcLine("@id=settled-2 :viewer!viewer@host PRIVMSG #room :second")!);
    renderer.handle(parseIrcLine("@id=settled-3 :viewer!viewer@host PRIVMSG #room :third")!);
    const settledRows = [...root.querySelectorAll<HTMLElement>(".chat-line")];
    const appendSpy = vi.spyOn(root, "appendChild");

    renderer.handle(parseIrcLine("@id=settled-4 :viewer!viewer@host PRIVMSG #room :fourth")!);

    expect(appendSpy.mock.calls.filter(([node]) => settledRows.includes(node as HTMLElement)).length).toBe(0);
    renderer.dispose();
  });

  it("does not reattach height-pruned rows just to measure newly flushed rows", () => {
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, 120, 400);
      if (!this.classList.contains("chat-line")) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
      return rect(60, 60, 400);
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 120 },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=hidden-old :viewer!viewer@host PRIVMSG #room :hidden old")!);
    const hiddenOld = root.querySelector<HTMLElement>(".chat-line")!;
    renderer.handle(parseIrcLine("@id=middle :viewer!viewer@host PRIVMSG #room :middle")!);
    renderer.handle(parseIrcLine("@id=newest :viewer!viewer@host PRIVMSG #room :newest")!);
    expect(hiddenOld.isConnected).toBe(false);
    const appendSpy = vi.spyOn(root, "appendChild");

    renderer.handle(parseIrcLine("@id=next :viewer!viewer@host PRIVMSG #room :next")!);

    expect(appendSpy.mock.calls.filter(([node]) => node === hiddenOld).length).toBe(0);
    renderer.dispose();
  });

  it("keeps pending pronouns on a row while it is detached for height pruning", async () => {
    let frameHeight = 100;
    const resolvePronouns = new Map<string, (value: string | null) => void>();
    let resizeCallback: ResizeObserverCallback | undefined;
    const originalResizeObserver = Object.getOwnPropertyDescriptor(dom.window, "ResizeObserver");
    Object.defineProperty(dom.window, "ResizeObserver", {
      configurable: true,
      value: class {
        constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
        observe(): void { /* The test changes the measured frame size directly. */ }
        disconnect(): void { /* No browser resources are held by this fake. */ }
      },
    });
    restoreResizeObserver = () => {
      if (originalResizeObserver) Object.defineProperty(dom.window, "ResizeObserver", originalResizeObserver);
      else delete (dom.window as unknown as { ResizeObserver?: unknown }).ResizeObserver;
    };
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, frameHeight, 400);
      if (!this.classList.contains("chat-line")) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
      return rect(frameHeight - root.querySelectorAll(".chat-line").length * 60, 60, 400);
    });
    const pronouns = {
      lookup: vi.fn((login: string) => new Promise<string | null>((resolve) => { resolvePronouns.set(login, resolve); })),
      dispose: vi.fn(),
    };
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 100, showPronouns: true },
      pronouns,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=pronoun-old;display-name=Old;login=old :old!old@host PRIVMSG #room :older")!);
    const oldRow = root.querySelector<HTMLElement>(".chat-line")!;
    renderer.handle(parseIrcLine("@id=pronoun-new;display-name=New;login=new :new!new@host PRIVMSG #room :newer")!);
    expect(oldRow.isConnected).toBe(false);

    resolvePronouns.get("old")?.("They/Them");
    await Promise.resolve();
    expect(oldRow.querySelector(".chat-pronouns")?.textContent).toBe(" (They/Them)");
    frameHeight = 200;
    resizeCallback?.([], {} as ResizeObserver);
    expect(oldRow.isConnected).toBe(true);
    expect(oldRow.textContent).toContain("(They/Them)");
    renderer.dispose();
    restoreResizeObserver();
    restoreResizeObserver = undefined;
  });

  it("uses a historical timestamp for ordering and restores height-pruned history before live lines", () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    let frameHeight = 300;
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, frameHeight, 400);
      if (!this.classList.contains("chat-line")) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
      const rows = [...root.querySelectorAll<HTMLElement>(".chat-line")];
      const index = rows.indexOf(this);
      const height = 60;
      return rect(frameHeight - rows.length * height + index * height, height, 400);
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 300, neverFade: true },
      scheduler: (callback) => { callback(); return 1; },
    });

    renderer.handle(parseIrcLine("@id=live-first :viewer!viewer@host PRIVMSG #room :live first")!, 1_000);
    renderer.handle(parseIrcLine("@id=live-second :viewer!viewer@host PRIVMSG #room :live second")!, 1_000);
    renderer.handle(parseIrcLine("@id=history;tmi-sent-ts=500;historical=1 :viewer!viewer@host PRIVMSG #room :history")!, 500);

    expect([...root.querySelectorAll<HTMLElement>(".chat-line")].map((row) => Number(row.dataset.receivedAt)))
      .toEqual([500, 1_000, 1_000]);
    expect(root.firstElementChild?.textContent).toContain("history");

    frameHeight = 120;
    renderer.setTheme({ ...DEFAULTS, maxChatHeight: 120, neverFade: true });
    expect(root.textContent).not.toContain("history");
    expect(root.textContent).toContain("live first");
    expect(root.textContent).toContain("live second");
    frameHeight = 300;
    renderer.setTheme({ ...DEFAULTS, maxChatHeight: 300, neverFade: true });
    expect(root.textContent).toContain("history");
    renderer.dispose();
  });

  it.each([
    ["message", "@room-id=10;target-msg-id=history-id :tmi.twitch.tv CLEARMSG #room :removed"],
    ["user", "@room-id=10;target-user-id=42;tmi-sent-ts=10000 :tmi.twitch.tv CLEARCHAT #room :viewer"],
    ["room", "@room-id=10;tmi-sent-ts=10000 :tmi.twitch.tv CLEARCHAT #room"],
  ] as const)("does not restore a historical message after a %s moderation event", (_kind, moderationLine) => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => { callback(); return 1; } });
    const beginFetch = (renderer as unknown as { beginBacklogFetch?: () => () => void }).beginBacklogFetch;
    const finishFetch = beginFetch?.call(renderer);
    renderer.handle(parseIrcLine(moderationLine)!);
    renderer.handle(parseIrcLine("@id=history-id;room-id=10;user-id=42;tmi-sent-ts=9000;historical=1 :viewer!viewer@host PRIVMSG #room :deleted history")!, 9_000);

    expect(root.querySelectorAll(".chat-line")).toHaveLength(0);
    finishFetch?.();
    renderer.dispose();
  });

  it("prunes lines after asynchronously refreshed badge images change their height", async () => {
    let badgeListener: ((userId: string) => void) | undefined;
    let badgesReady = false;
    const scheduled: Array<() => void> = [];
    const runScheduled = (): void => {
      const callbacks = scheduled.splice(0);
      for (const callback of callbacks) callback();
    };
    const thirdParty = {
      setEnabled: vi.fn(),
      load: vi.fn(async () => undefined),
      resolve: () => badgesReady ? [{ provider: "badgesBttv" as const, name: "Late", url: "https://cdn.betterttv.net/badge.png" }] : [],
      subscribe: (listener: (userId: string) => void) => { badgeListener = listener; return () => { badgeListener = undefined; }; },
      dispose: vi.fn(),
    };
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, 70, 400);
      if (!this.classList.contains("chat-line")) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
      const rows = [...root.querySelectorAll<HTMLElement>(".chat-line")];
      const index = rows.indexOf(this);
      const height = 30 + this.querySelectorAll("img.chat-badge").length * 20;
      const total = rows.reduce((sum, row) => sum + 30 + row.querySelectorAll("img.chat-badge").length * 20, 0);
      const before = rows.slice(0, index).reduce((sum, row) => sum + 30 + row.querySelectorAll("img.chat-badge").length * 20, 0);
      return rect(70 - total + before, height, 400);
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 70 },
      thirdPartyBadges: thirdParty as unknown as import("../../src/renderer/third-party-badges").ThirdPartyBadgeLookup,
      scheduler: (callback) => { scheduled.push(callback); return scheduled.length; },
    });
    renderer.handle(parseIrcLine("@id=badge-old;user-id=42 :viewer!viewer@host PRIVMSG #room :old")!);
    runScheduled();
    renderer.handle(parseIrcLine("@id=badge-new;user-id=42 :viewer!viewer@host PRIVMSG #room :new")!);
    runScheduled();
    expect(root.querySelectorAll(".chat-line")).toHaveLength(2);

    badgesReady = true;
    badgeListener?.("42");
    await Promise.resolve();

    expect(root.querySelectorAll(".chat-line")).toHaveLength(2);
    expect(scheduled).toHaveLength(1);
    runScheduled();
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.textContent).toContain("new");
    expect(root.textContent).not.toContain("old");
    renderer.dispose();
  });

  it("allows a one pixel height measurement tolerance at the full-frame limit", () => {
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, 600, 400);
      if (!this.classList.contains("chat-line")) return { x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) };
      const rows = [...root.querySelectorAll<HTMLElement>(".chat-line")];
      const index = rows.indexOf(this);
      const height = 300.15;
      return rect(600 - rows.length * height + index * height, height, 400);
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 0 },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=rounding-1 :viewer!viewer@host PRIVMSG #room :first")!);
    renderer.handle(parseIrcLine("@id=rounding-2 :viewer!viewer@host PRIVMSG #room :second")!);

    expect(root.querySelectorAll(".chat-line")).toHaveLength(2);
    renderer.dispose();
  });

  it("does not cap ticker queue entries with stack limits", () => {
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 100, maxLines: 1, layout: "ticker" },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=ticker-1 :viewer!viewer@host PRIVMSG #room :first")!);
    renderer.handle(parseIrcLine("@id=ticker-2 :viewer!viewer@host PRIVMSG #room :second")!);
    renderer.handle(parseIrcLine("@id=ticker-3 :viewer!viewer@host PRIVMSG #room :third")!);
    root.querySelector(".ticker-line")?.dispatchEvent(new dom.window.Event("animationend"));
    expect(root.textContent).toContain("second");
    expect(root.textContent).not.toContain("third");
    root.querySelector(".ticker-line")?.dispatchEvent(new dom.window.Event("animationend"));
    expect(root.textContent).toContain("third");
    renderer.dispose();
  });

  it("keeps ticker lifetime behavior when neverFade is enabled", () => {
    vi.useFakeTimers();
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, layout: "ticker", neverFade: true, lifetime: 1_000 },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=ticker-live :viewer!viewer@host PRIVMSG #room :active")!);
    renderer.handle(parseIrcLine("@id=ticker-expired :viewer!viewer@host PRIVMSG #room :queued and expired")!);
    vi.advanceTimersByTime(1_001);
    root.querySelector(".ticker-line")?.dispatchEvent(new dom.window.Event("animationend"));
    expect(root.querySelectorAll(".chat-line")).toHaveLength(0);
    expect(root.textContent).not.toContain("queued and expired");
    renderer.dispose();
  });

  it("keeps a busy stack burst within maxLines while appending batches", () => {
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxLines: 17 },
      scheduler: (callback) => { callback(); return 1; },
    });
    for (let index = 0; index < 500; index += 1) {
      renderer.handle(parseIrcLine(`@id=burst-${index} :viewer!viewer@host PRIVMSG #room :burst ${index}`)!);
      expect(root.querySelectorAll(".chat-line").length).toBeLessThanOrEqual(17);
    }
    expect(root.querySelectorAll(".chat-line")).toHaveLength(17);
    expect(root.textContent).not.toContain("burst 0");
    expect(root.textContent).toContain("burst 499");
    renderer.dispose();
  });


  it("removes a single message and clears a user or the whole room", () => {
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => callback() });
    const send = (id: string, user: string, text: string) =>
      renderer.handle(parseIrcLine(`@id=${id} :${user}!${user}@host PRIVMSG #room :${text}`)!);
    send("one", "alice", "one");
    send("two", "alice", "two");
    send("three", "bob", "three");
    renderer.handle(parseIrcLine("@target-msg-id=two :tmi.twitch.tv CLEARMSG #room :two")!);
    expect(root.textContent).not.toContain("two");
    renderer.handle(parseIrcLine(":tmi.twitch.tv CLEARCHAT #room :alice")!);
    expect(root.textContent).not.toContain("one");
    expect(root.textContent).toContain("three");
    renderer.handle(parseIrcLine(":tmi.twitch.tv CLEARCHAT #room")!);
    expect(root.children).toHaveLength(0);
    renderer.dispose();
  });

  it("removes USERNOTICE by target user id whether rendered or queued", () => {
    let flush: (() => void) | undefined;
    const queuedRenderer = createChatRenderer({
      root,
      theme: DEFAULTS,
      scheduler: (callback) => { flush = callback; return 1; },
      cancelScheduled: () => { flush = undefined; },
    });
    queuedRenderer.handle(parseIrcLine("@id=queued;login=alice;user-id=42 :tmi.twitch.tv USERNOTICE #room :Welcome")!);
    queuedRenderer.handle(parseIrcLine("@target-user-id=42 :tmi.twitch.tv CLEARCHAT #room :alice")!);
    flush?.();
    expect(root.textContent).not.toContain("Welcome");
    queuedRenderer.dispose();

    const renderedRenderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => callback() });
    renderedRenderer.handle(parseIrcLine("@id=rendered;login=alice;user-id=42 :tmi.twitch.tv USERNOTICE #room :Welcome")!);
    expect(root.textContent).toContain("Welcome");
    renderedRenderer.handle(parseIrcLine("@target-user-id=42 :tmi.twitch.tv CLEARCHAT #room :alice")!);
    expect(root.textContent).not.toContain("Welcome");
    renderedRenderer.dispose();
  });

  it("deduplicates source-id messages across rooms while applying clear commands per room", () => {
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=one;room-id=10;source-id=shared :viewer!viewer@host PRIVMSG #one :same")!);
    renderer.handle(parseIrcLine("@id=two;room-id=20;source-id=shared :viewer!viewer@host PRIVMSG #two :same")!);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);

    renderer.handle(parseIrcLine("@room-id=20;target-msg-id=two :tmi.twitch.tv CLEARMSG #two :same")!);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    renderer.handle(parseIrcLine("@room-id=10;target-msg-id=one :tmi.twitch.tv CLEARMSG #one :same")!);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(0);
    renderer.dispose();
  });

  it("filters queued and rendered messages and styles observed power-up tags", () => {
    let flush: (() => void) | undefined;
    const renderer = createChatRenderer({
      root,
      theme: {
        ...DEFAULTS,
        hideNumbers: true,
        filterWords: ["blocked"],
        layout: "ticker",
        channels: ["main", "second"],
        gigantifiedScale: 3,
      },
      scheduler: (callback) => { flush = callback; return 1; },
      cancelScheduled: () => { flush = undefined; },
    });
    renderer.handle(parseIrcLine("@id=numbers;room-id=10 :viewer!viewer@host PRIVMSG #main :12345")!);
    renderer.handle(parseIrcLine("@id=filtered;room-id=10 :viewer!viewer@host PRIVMSG #main :blocked")!);
    renderer.handle(parseIrcLine("@id=power;room-id=10;msg-id=power-up-message;msg-param-power-up-type=gigantify_an_emote;emotes=25:0-4 :viewer!viewer@host PRIVMSG #main :Kappa")!);
    flush?.();
    expect(root.dataset.layout).toBe("ticker");
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.querySelector(".chat-line")?.classList.contains("chat-gigantified")).toBe(true);
    expect(root.querySelector<HTMLImageElement>(".chat-emote")?.getAttribute("height")).toBe("54");
    expect(root.querySelector(".chat-source-channel")?.textContent).toBe("#main");
    renderer.dispose();
  });

  it("does not render a partner PRIVMSG when shared chat is disabled", () => {
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, showSharedChat: false },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=partner;room-id=10;source-room-id=20 :viewer!viewer@host PRIVMSG #main :hello")!);

    expect(root.querySelectorAll(".chat-line")).toHaveLength(0);
    renderer.dispose();
  });

  it("does not render a partner sharedchatnotice USERNOTICE when shared chat is disabled", () => {
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, showSharedChat: false },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=partner-notice;msg-id=sharedchatnotice;source-msg-id=raid;room-id=10;source-room-id=20 :tmi.twitch.tv USERNOTICE #main :Raid")!);

    expect(root.querySelectorAll(".chat-line")).toHaveLength(0);
    renderer.dispose();
  });

  it("updates the existing shared-chat source label and accessible name after resolution", async () => {
    let resolveName!: (name: { displayName: string; logo: string | null } | null) => void;
    const roomNames = { lookup: vi.fn(() => new Promise<{ displayName: string; logo: string | null } | null>((resolve) => { resolveName = resolve; })) };
    const renderer = createChatRenderer({
      root,
      theme: DEFAULTS,
      roomNames,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=partner;room-id=10;source-room-id=20 :viewer!viewer@host PRIVMSG #main :hello")!);
    const row = root.querySelector<HTMLElement>(".chat-line")!;
    const source = row.querySelector<HTMLElement>(".chat-source-room")!;

    expect(source.textContent).toBe("via 20");
    expect(source.getAttribute("aria-label")).toBe("Shared chat source room 20");
    resolveName({ displayName: "PartnerName", logo: null });
    await Promise.resolve();

    expect(root.querySelector(".chat-line")).toBe(row);
    expect(source.textContent).toBe("via PartnerName");
    expect(source.getAttribute("aria-label")).toBe("Shared chat source room PartnerName");
    expect(source.dataset.roomId).toBe("20");
    renderer.dispose();
  });

  it("does not reset an active ticker duration when the source name resolves", async () => {
    let resolveName!: (name: { displayName: string; logo: string | null } | null) => void;
    const roomNames = { lookup: vi.fn(() => new Promise<{ displayName: string; logo: string | null } | null>((resolve) => { resolveName = resolve; })) };
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, layout: "ticker" },
      roomNames,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=ticker-partner;room-id=10;source-room-id=20 :viewer!viewer@host PRIVMSG #main :hello")!);
    const row = root.querySelector<HTMLElement>(".chat-line")!;
    Object.defineProperty(row, "getAnimations", { value: () => [{ playState: "running" }] });
    const duration = row.style.getPropertyValue("--ticker-duration");

    resolveName({ displayName: "A much longer partner channel name", logo: null });
    await Promise.resolve();

    expect(root.querySelector(".chat-source-room")?.textContent).toBe("via A much longer partner channel name");
    expect(row.style.getPropertyValue("--ticker-duration")).toBe(duration);
    renderer.dispose();
  });

  it("keeps the numeric source label when a room name lookup fails", async () => {
    const roomNames = { lookup: vi.fn(async () => null) };
    const renderer = createChatRenderer({
      root,
      theme: DEFAULTS,
      roomNames,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=partner;room-id=10;source-room-id=20 :viewer!viewer@host PRIVMSG #main :hello")!);
    await Promise.resolve();

    expect(root.querySelector(".chat-source-room")?.textContent).toBe("via 20");
    expect(root.querySelector(".chat-source-room")?.getAttribute("aria-label")).toBe("Shared chat source room 20");
    renderer.dispose();
  });

  it.each([
    "text", "pill", "avatar", "avatar-pill", "hidden",
  ] as const)("renders the %s Shared Chat source label style", async (sharedChatLabel) => {
    const roomNames = { lookup: vi.fn(async () => ({
      displayName: "PartnerName", logo: "https://static-cdn.jtvnw.net/user.png",
    })) };
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, sharedChatLabel, sharedChatPrefix: "from" },
      roomNames,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=partner;room-id=10;source-room-id=20 :viewer!viewer@host PRIVMSG #main :hello")!);
    await Promise.resolve();

    const row = root.querySelector<HTMLElement>(".chat-line")!;
    const source = row.querySelector<HTMLElement>(".chat-source-room")!;
    expect(row.querySelector(".chat-message")?.textContent).toBe("hello");
    expect(source.getAttribute("aria-label")).toBe(sharedChatLabel === "hidden"
      ? "Shared chat source room 20"
      : "Shared chat source room PartnerName");
    if (sharedChatLabel === "text") expect(source.textContent).toBe("from PartnerName");
    if (sharedChatLabel === "pill") {
      expect(source.dataset.style).toBe("pill");
      expect(source.textContent).toBe("PartnerName");
      expect(source.querySelector(".chat-source-pill")?.textContent).toBe("PartnerName");
    }
    if (sharedChatLabel === "avatar" || sharedChatLabel === "avatar-pill") {
      expect(source.parentElement?.classList.contains("chat-badges")).toBe(true);
      expect(source.querySelector("img.chat-source-avatar")?.getAttribute("src")).toBe("https://static-cdn.jtvnw.net/user.png");
      expect(source.querySelector("img.chat-source-avatar")?.getAttribute("alt")).toBe("PartnerName");
      expect(source.querySelector(".chat-source-avatar-slot")?.hasAttribute("aria-hidden")).toBe(false);
      if (sharedChatLabel === "avatar") expect(source.querySelector(".chat-source-pill")).toBeNull();
      else expect(source.querySelector(".chat-source-pill")?.textContent).toBe("PartnerName");
    }
    if (sharedChatLabel === "hidden") {
      expect(source.hidden).toBe(true);
      expect(roomNames.lookup).not.toHaveBeenCalled();
    } else expect(roomNames.lookup).toHaveBeenCalledTimes(1);
    renderer.dispose();
  });

  it("reserves an avatar slot before resolution and ignores unsafe profile images", async () => {
    let resolveName!: (name: { displayName: string; logo: string | null } | null) => void;
    const roomNames = { lookup: vi.fn(() => new Promise<{ displayName: string; logo: string | null } | null>((resolve) => { resolveName = resolve; })) };
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, sharedChatLabel: "avatar" },
      roomNames,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=partner-avatar;room-id=10;source-room-id=20 :viewer!viewer@host PRIVMSG #main :hello")!);
    const row = root.querySelector<HTMLElement>(".chat-line")!;
    const source = row.querySelector<HTMLElement>(".chat-source-room")!;
    expect(source.querySelector(".chat-source-avatar-slot")).not.toBeNull();
    expect(source.querySelector("img")).toBeNull();
    resolveName({ displayName: "PartnerName", logo: "https://evil.invalid/user.png" });
    await Promise.resolve();
    expect(source.getAttribute("aria-label")).toBe("Shared chat source room PartnerName");
    expect(source.querySelector("img")).toBeNull();
    renderer.dispose();
  });

  it("uses fixed Studio partner metadata without looking up its fake room ID", () => {
    const roomNames = { lookup: vi.fn(async () => ({ displayName: "WrongName", logo: null })) };
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, sharedChatLabel: "avatar" },
      roomNames,
      scheduler: (callback) => { callback(); return 1; },
    });
    const event = parseIrcLine("@id=studio-partner;room-id=10001;source-room-id=10002 :guest!guest@host PRIVMSG #sample :hello")!;
    if (event.type !== "PRIVMSG") throw new Error("Expected a chat message");
    renderer.handle({ ...event, sourceRoomName: "LunaLive", sourceRoomLogo: null });

    expect(roomNames.lookup).not.toHaveBeenCalled();
    expect(root.querySelector(".chat-source-room")?.getAttribute("aria-label")).toBe("Shared chat source room LunaLive");
    expect(root.querySelector(".chat-source-avatar-slot")?.textContent).toBe("L");
    renderer.dispose();
  });

  it("styles highlighted messages and leaves animated power-ups at normal size", () => {
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, highlightBackgroundColor: "#123456", highlightTextColor: "#abcdef" },
      scheduler: (callback) => callback(),
    });
    renderer.handle(parseIrcLine("@id=highlight;msg-id=highlighted-message :viewer!viewer@host PRIVMSG #room :highlighted")!);
    renderer.handle(parseIrcLine("@id=animated;msg-id=power-up-message;msg-param-power-up-type=animated_emote;emotes=25:0-4 :viewer!viewer@host PRIVMSG #room :Kappa")!);
    const highlighted = root.querySelector<HTMLElement>(".chat-highlighted");
    const animated = root.querySelector<HTMLImageElement>('img[alt="Kappa"]')?.closest<HTMLElement>(".chat-line");
    expect(highlighted?.classList.contains("chat-highlighted")).toBe(true);
    expect(highlighted?.style.getPropertyValue("background-color")).toBe("var(--t-highlight-background-color)");
    expect(root.style.getPropertyValue("--t-highlight-background-color")).toBe("#123456");
    expect(root.style.getPropertyValue("--t-highlight-text-color")).toBe("#abcdef");
    expect(highlighted?.style.getPropertyValue("--t-highlight-background-color")).toBe("");
    expect(highlighted?.style.getPropertyValue("--t-highlight-text-color")).toBe("");
    expect(animated?.classList.contains("chat-gigantified")).toBe(false);
    expect(animated?.classList.contains("chat-highlighted")).toBe(false);
    expect(animated?.querySelector(".chat-emote")?.getAttribute("height")).toBe(String(DEFAULTS.fontSize * DEFAULTS.emoteScale));
    renderer.dispose();
  });

  it("keeps only the latest static ticker line when theme motion is none", () => {
    vi.useFakeTimers();
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, layout: "ticker", motion: "none", lifetime: 1_000 },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=old;room-id=10 :viewer!viewer@host PRIVMSG #room :old line")!);
    renderer.handle(parseIrcLine("@id=new;room-id=10 :viewer!viewer@host PRIVMSG #room :latest line")!);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.textContent).toContain("latest line");
    expect(root.textContent).not.toContain("old line");
    expect(root.querySelector(".ticker-static")).not.toBeNull();
    vi.advanceTimersByTime(200_000);
    expect(root.textContent).toContain("latest line");
    renderer.dispose();
  });

  it("skips expired queued ticker entries before showing the next live message", () => {
    vi.useFakeTimers();
    let flush: (() => void) | undefined;
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, layout: "ticker", lifetime: 2_000 },
      scheduler: (callback) => { flush = callback; return 1; },
      cancelScheduled: () => { flush = undefined; },
    });
    renderer.handle(parseIrcLine("@id=old;room-id=10 :viewer!viewer@host PRIVMSG #room :expired queued item")!);
    vi.advanceTimersByTime(2_001);
    renderer.handle(parseIrcLine("@id=current;room-id=10 :viewer!viewer@host PRIVMSG #room :current queued item")!);
    flush?.();

    expect(root.textContent).toContain("current queued item");
    expect(root.textContent).not.toContain("expired queued item");
    renderer.dispose();
  });

  it("moderates ticker messages while they are queued", () => {
    let flush: (() => void) | undefined;
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, layout: "ticker" },
      scheduler: (callback) => { flush = callback; return 1; },
      cancelScheduled: () => { flush = undefined; },
    });
    renderer.handle(parseIrcLine("@id=active;room-id=10;login=alice :alice!alice@host PRIVMSG #room :active")!);
    renderer.handle(parseIrcLine("@id=queued;room-id=10;login=alice :alice!alice@host PRIVMSG #room :queued")!);
    flush?.();
    renderer.handle(parseIrcLine("@room-id=10;target-msg-id=queued :tmi.twitch.tv CLEARMSG #room :queued")!);
    root.querySelector(".ticker-line")?.dispatchEvent(new dom.window.Event("animationend"));
    flush?.();
    expect(root.textContent).not.toContain("queued");
    expect(root.children).toHaveLength(0);
    renderer.dispose();
  });

  it("keeps a queued ticker raid highlighted when its line finally appears", () => {
    vi.useFakeTimers();
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, layout: "ticker", tickerSpeed: 400 },
    });
    renderer.handle(parseIrcLine("@id=backlog-one;room-id=10 :viewer!viewer@host PRIVMSG #room :backlog one")!);
    renderer.handle(parseIrcLine("@id=backlog-two;room-id=10 :viewer!viewer@host PRIVMSG #room :backlog two")!);
    renderer.handle(parseIrcLine("@id=backlog-raid;room-id=10;msg-id=raid;msg-param-viewerCount=12 :tmi.twitch.tv USERNOTICE #room :Raiding")!);
    vi.advanceTimersByTime(16);
    vi.advanceTimersByTime(4_000);

    const advanceTicker = (): void => {
      root.querySelector(".ticker-line")?.dispatchEvent(new dom.window.Event("animationend"));
      vi.advanceTimersByTime(16);
    };
    advanceTicker();
    advanceTicker();

    expect(root.querySelector(".chat-line")?.textContent).toContain("Raiding");
    expect(root.querySelector(".chat-line")?.classList.contains("chat-reaction-highlight")).toBe(true);
    renderer.dispose();
  });

  it("detaches reaction highlights when changing layout removes the old line", () => {
    const renderer = createChatRenderer({
      root,
      theme: DEFAULTS,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=layout-raid;room-id=10;msg-id=raid;msg-param-viewerCount=12 :tmi.twitch.tv USERNOTICE #room :Raiding")!);
    const oldLine = root.querySelector<HTMLElement>(".chat-line")!;
    expect(oldLine.classList.contains("chat-reaction-highlight")).toBe(true);

    renderer.setTheme({ ...DEFAULTS, layout: "ticker" });

    expect(oldLine.isConnected).toBe(false);
    expect(oldLine.classList.contains("chat-reaction-highlight")).toBe(false);
    renderer.dispose();
  });

  it("uses a timer for the default batch and drops stale messages after a delayed flush", () => {
    vi.useFakeTimers();
    const renderer = createChatRenderer({ root, theme: { ...DEFAULTS, lifetime: 1_000 } });
    renderer.handle(parseIrcLine("@id=default :viewer!viewer@host PRIVMSG #room :timer batch")!);
    expect(root.children).toHaveLength(0);
    vi.advanceTimersByTime(15);
    expect(root.children).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(root.textContent).toContain("timer batch");
    renderer.dispose();

    let delayedFlush: (() => void) | undefined;
    const delayedRenderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, lifetime: 1_000 },
      scheduler: (callback) => { delayedFlush = callback; return 1; },
      cancelScheduled: () => { delayedFlush = undefined; },
    });
    delayedRenderer.handle(parseIrcLine("@id=stale :viewer!viewer@host PRIVMSG #room :stale")!);
    vi.advanceTimersByTime(1_000);
    delayedFlush?.();
    expect(root.textContent).not.toContain("stale");

    delayedRenderer.handle(parseIrcLine("@id=remaining :viewer!viewer@host PRIVMSG #room :remaining")!);
    vi.advanceTimersByTime(700);
    delayedFlush?.();
    const row = root.querySelector<HTMLElement>(".chat-line");
    expect(row?.textContent).toContain("remaining");
    vi.advanceTimersByTime(299);
    expect(row?.style.getPropertyValue("opacity")).toBe("1");
    vi.advanceTimersByTime(1);
    expect(row?.style.getPropertyValue("opacity")).toBe("0");
    delayedRenderer.dispose();
  });

  it("updates the background color variable on existing rows when the theme changes", () => {
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=theme :viewer!viewer@host PRIVMSG #room :themed")!);
    const row = root.querySelector<HTMLElement>(".chat-line");
    expect(row?.style.getPropertyValue("background-color")).toBe("var(--t-row-background)");
    const previous = root.style.getPropertyValue("--t-row-background");
    renderer.setTheme({ ...DEFAULTS, backgroundColor: "#204060", backgroundOpacity: 0.4 });
    expect(root.style.getPropertyValue("--t-row-background")).not.toBe(previous);
    expect(row?.style.getPropertyValue("background-color")).toBe("var(--t-row-background)");
    renderer.dispose();
  });

  it("renders emotes only from the shared image host allowlist", () => {
    const emotes = createEmoteLookup({ providers: [] });
    emotes.add([
      { name: "Safe", url: "https://cdn.7tv.app/emote/safe/2x.webp", provider: "test" },
      { name: "Unsafe", url: "https://evil.example/emote.png", provider: "test" },
    ]);
    const renderer = createChatRenderer({ root, theme: DEFAULTS, emotes, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine(":viewer!viewer@host PRIVMSG #room :Safe Unsafe")!);
    expect(root.querySelectorAll("img.chat-emote")).toHaveLength(1);
    expect(root.querySelector("img.chat-emote")?.getAttribute("alt")).toBe("Safe");
    expect(root.textContent).toContain("Unsafe");
    renderer.dispose();
    emotes.dispose();
  });

  it("shows no paint styling or requests while paints are off, then applies it on a live toggle", () => {
    const fetcher = vi.fn(async () => new Response("{}", { status: 200 }));
    const paints = createPaintLookup({ fetcher, enabled: false });
    paints.set("42", { color: "#ff0000" });
    const theme = { ...DEFAULTS, showPaints: false, nameColorMode: "text" as const, textColor: "#123456" };
    const renderer = createChatRenderer({
      root,
      theme,
      paints,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=paint;user-id=42;color=#123456 :viewer!viewer@host PRIVMSG #room :paint test")!);
    const name = root.querySelector<HTMLElement>(".chat-name")!;
    expect(name.style.getPropertyValue("color")).toBe("rgb(18, 52, 86)");
    expect(name.style.getPropertyValue("background-image")).toBe("");
    expect(fetcher).not.toHaveBeenCalled();

    renderer.setTheme({ ...theme, showPaints: true });
    expect(name.style.getPropertyValue("color")).toBe("rgb(255, 0, 0)");
    renderer.setTheme({ ...theme, showPaints: false });
    expect(name.style.getPropertyValue("color")).toBe("rgb(18, 52, 86)");
    expect(fetcher).not.toHaveBeenCalled();
    renderer.dispose();
  });

  it("clears rehearsal messages without disposing the shared emote pipeline", () => {
    const emotes = createEmoteLookup({ providers: [] });
    emotes.add([{ name: "Kappa", url: "https://cdn.7tv.app/emote/kappa/2x.webp", provider: "test" }]);
    const renderer = createChatRenderer({ root, theme: DEFAULTS, emotes, scheduler: (callback) => callback() });
    const message = () => parseIrcLine(":viewer!viewer@host PRIVMSG #room :Kappa")!;

    renderer.handle(message());
    expect(root.querySelector("img.chat-emote")?.getAttribute("alt")).toBe("Kappa");
    renderer.clear();
    expect(root.children).toHaveLength(0);
    renderer.handle(message());
    expect(root.querySelector("img.chat-emote")?.getAttribute("alt")).toBe("Kappa");

    renderer.dispose();
    emotes.dispose();
  });

  it("renders adjacent zero-width emotes as absolute overlays on their base emote", () => {
    const emotes = createEmoteLookup({ providers: [] });
    emotes.add([
      { name: "Base", url: "https://cdn.7tv.app/emote/base/2x.webp", provider: "test" },
      { name: "Overlay", url: "https://cdn.7tv.app/emote/overlay/2x.webp", provider: "test", zeroWidth: true },
    ]);
    const renderer = createChatRenderer({ root, theme: DEFAULTS, emotes, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine(":viewer!viewer@host PRIVMSG #room :BaseOverlay")!);
    const wrapper = root.querySelector<HTMLElement>(".chat-emote-wrapper");
    expect(wrapper?.style.getPropertyValue("position")).toBe("relative");
    expect(wrapper?.style.getPropertyValue("display")).toBe("inline-block");
    expect(wrapper?.querySelectorAll("img.chat-emote-overlay")).toHaveLength(1);
    expect(wrapper?.querySelector(".chat-emote-overlay")?.getAttribute("alt")).toBe("Overlay");
    renderer.dispose();
    emotes.dispose();
  });

  it("rejects a hostile paint stop position and keeps the tag color", () => {
    const paints = createPaintLookup({ fetcher: fetch });
    paints.set("42", {
      function: "LINEAR_GRADIENT",
      angle: 90,
      stops: [{ at: "0); url(javascript:alert(1))", color: "red" }, { at: 1, color: "#ffffff" }],
    });
    const renderer = createChatRenderer({ root, theme: DEFAULTS, paints, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@user-id=42;color=#00ff00;display-name=Viewer :viewer!viewer@host PRIVMSG #room :hello")!);
    const name = root.querySelector<HTMLElement>(".chat-name");
    expect(name?.style.getPropertyValue("background-image")).toBe("");
    expect(name?.style.getPropertyValue("color")).toBe("rgb(0, 255, 0)");
    renderer.dispose();
  });

  it("rejects a hostile paint angle and keeps the tag color", () => {
    const paints = createPaintLookup({ fetcher: fetch });
    paints.set("42", {
      function: "LINEAR_GRADIENT",
      angle: "90deg; background-image: url(javascript:alert(1))",
      stops: [{ at: 0, color: "#ff0000" }, { at: 1, color: "#ffffff" }],
    });
    const renderer = createChatRenderer({ root, theme: DEFAULTS, paints, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@user-id=42;color=#00ff00;display-name=Viewer :viewer!viewer@host PRIVMSG #room :hello")!);
    const name = root.querySelector<HTMLElement>(".chat-name");
    expect(name?.style.getPropertyValue("background-image")).toBe("");
    expect(name?.style.getPropertyValue("color")).toBe("rgb(0, 255, 0)");
    renderer.dispose();
  });

  it("applies a validated paint update and accepts only allowlisted paint images", () => {
    const paints = createPaintLookup();
    const renderer = createChatRenderer({ root, theme: DEFAULTS, paints, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@user-id=42;color=#00ff00 :viewer!viewer@host PRIVMSG #room :painted")!);
    paints.set("42", {
      function: "LINEAR_GRADIENT",
      angle: 90,
      stops: [{ at: 0, color: "#ff0000" }, { at: 1, color: "#0000ff" }],
    });
    const name = root.querySelector<HTMLElement>(".chat-name")!;
    expect(name.style.getPropertyValue("background-image"))
      .toContain("linear-gradient(90deg");
    expect(name.classList.contains("chat-name-painted")).toBe(true);
    expect(buildPaintStyle({ function: "URL", image_url: "https://cdn.7tv.app/paint/paint/1x.webp" }))
      .toMatchObject({ type: "image" });
    expect(buildPaintStyle({ function: "URL", image_url: "" })).toBeNull();
    expect(buildPaintStyle({ function: "URL", image_url: "https://evil.example/paint.png" })).toBeNull();

    for (const image_url of ["", "https://evil.example/paint.png"]) {
      paints.set("42", { function: "URL", image_url });
      expect(name.classList.contains("chat-name-painted")).toBe(false);
      expect(name.style.getPropertyValue("background-image")).toBe("");
      expect(name.style.getPropertyValue("color")).toBe("rgb(0, 255, 0)");
    }
    renderer.dispose();
  });

  it("keeps a 7TV shadow filter on gradient painted names", () => {
    const paints = createPaintLookup();
    paints.set("42", {
      function: "LINEAR_GRADIENT",
      angle: 90,
      stops: [{ at: 0, color: "#ff0000" }, { at: 1, color: "#0000ff" }],
      shadows: [{ x_offset: 1, y_offset: 1, radius: 3, color: "#000000" }],
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, textShadow: 4 },
      paints,
      scheduler: (callback) => callback(),
    });
    renderer.handle(parseIrcLine("@user-id=42 :viewer!viewer@host PRIVMSG #room :painted")!);
    const name = root.querySelector<HTMLElement>(".chat-name")!;
    expect(name.classList.contains("chat-name-painted")).toBe(true);
    expect(name.style.getPropertyValue("filter")).toContain("drop-shadow(");
    renderer.dispose();
  });

  it("keeps existing badge image nodes when later messages do not load badge data", async () => {
    const badges = createBadgeLookup({ source: { type: "embedded", data: {
      global: { data: [{ set_id: "subscriber", versions: [
        { id: "1", image_url_1x: "https://static-cdn.jtvnw.net/badges/subscriber.png" },
      ] }] },
      broadcasters: {},
    } } });
    const renderer = createChatRenderer({ root, theme: DEFAULTS, badges, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=badge-0;badges=subscriber/1 :viewer!viewer@host PRIVMSG #room :first")!);
    const originalImages = [...root.querySelectorAll("img.chat-badge")];
    for (let i = 1; i <= 20; i += 1) {
      renderer.handle(parseIrcLine(`@id=badge-${i};badges=subscriber/1 :viewer!viewer@host PRIVMSG #room :message ${i}`)!);
    }
    await Promise.resolve();
    expect(originalImages).toHaveLength(1);
    expect(root.querySelector(".chat-line img.chat-badge")).toBe(originalImages[0]);
    renderer.dispose();
  });

  it("reports one populated badge fetch when messages share an in-flight load", async () => {
    let finish!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finish = resolve; }));
    const badges = createBadgeLookup({ source: { type: "route" }, fetcher });
    const first = badges.loadGlobal();
    const second = badges.loadGlobal();
    finish(new Response(JSON.stringify({ data: [{ set_id: "subscriber", versions: [
      { id: "1", image_url_1x: "https://static-cdn.jtvnw.net/badges/subscriber.png" },
    ] }] }), { status: 200 }));
    expect(await Promise.all([first, second])).toEqual([true, false]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    badges.dispose();
  });

  it("retries badge loads after sixty seconds following a failure", async () => {
    vi.useFakeTimers();
    const response = new Response(JSON.stringify({ data: [{ set_id: "subscriber", versions: [
      { id: "1", image_url_1x: "https://static-cdn.jtvnw.net/badges/subscriber.png" },
    ] }] }), { status: 200 });
    const fetcher = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(response);
    const badges = createBadgeLookup({ source: { type: "route" }, fetcher });
    expect(await badges.loadGlobal()).toBe(false);
    expect(await badges.loadGlobal()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await badges.loadGlobal()).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(2);
    badges.dispose();
  });

  it("renders chat when route badge lookups are unavailable", async () => {
    const badges = createBadgeLookup({ source: { type: "route" }, fetcher: vi.fn().mockRejectedValue(new Error("missing route")) });
    await badges.loadGlobal();
    await badges.loadBroadcaster("123");
    const renderer = createChatRenderer({ root, theme: DEFAULTS, badges, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@badges=subscriber/12 :viewer!viewer@host PRIVMSG #room :message remains")!);
    expect(root.textContent).toContain("message remains");
    expect(root.querySelectorAll(".chat-badge")).toHaveLength(0);
    renderer.dispose();
    badges.dispose();
  });

  it("renders embedded badge images through the same host allowlist", () => {
    const badges = createBadgeLookup({ source: { type: "embedded", data: {
      global: { data: [{ set_id: "subscriber", versions: [
        { id: "12", image_url_1x: "https://static-cdn.jtvnw.net/badges/12.png" },
        { id: "13", image_url_1x: "https://evil.example/badge.png" },
      ] }] },
      broadcasters: {},
    } } });
    const renderer = createChatRenderer({ root, theme: DEFAULTS, badges, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@badges=subscriber/12,subscriber/13 :viewer!viewer@host PRIVMSG #room :has badge")!);
    expect(root.querySelectorAll("img.chat-badge")).toHaveLength(1);
    expect(root.querySelector("img.chat-badge")?.getAttribute("alt")).toBe("subscriber 12");
    renderer.dispose();
  });

  it("renders Twitch badges before allowlisted third-party badges with source names as alt and title", () => {
    const twitch = createBadgeLookup({ source: { type: "embedded", data: {
      global: { data: [{ set_id: "moderator", versions: [
        { id: "1", image_url_1x: "https://static-cdn.jtvnw.net/badges/mod.png" },
      ] }] },
      broadcasters: {},
    } } });
    const thirdParty = {
      setEnabled: vi.fn(),
      load: vi.fn(async () => undefined),
      resolve: () => [
        { provider: "badgesBttv", name: "BTTV VIP", url: "https://cdn.betterttv.net/badges/vip.png" },
        { provider: "badgesFfz", name: "FFZ VIP", url: "https://cdn.frankerfacez.com/badge/7/2" },
        { provider: "badgesChatterino", name: "Chatterino VIP", url: "https://fourtf.com/chatterino/vip.png" },
        { provider: "badgesHomies", name: "Homies member", url: "https://cdn.chatterinohomies.com/badges/42/36.webp" },
      ],
      subscribe: () => () => undefined,
      dispose: vi.fn(),
    };
    const paints = {
      resolve: () => undefined,
      resolveBadge: () => ({ name: "7TV Winner", url: "https://cdn.7tv.app/badge/winner/2x.webp" }),
      load: vi.fn(async () => undefined),
      setEnabled: vi.fn(),
      setBadgesEnabled: vi.fn(),
      setChannelId: vi.fn(),
      set: vi.fn(),
      subscribe: () => () => undefined,
      dispose: vi.fn(),
    };
    const renderer = createChatRenderer({
      root, theme: DEFAULTS, badges: twitch,
      paints: paints as unknown as import("../../src/renderer/paints").PaintLookup,
      thirdPartyBadges: thirdParty as unknown as import("../../src/renderer/third-party-badges").ThirdPartyBadgeLookup,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=badge-order;user-id=42;badges=moderator/1 :viewer!viewer@host PRIVMSG #room :badged")!);

    const images = [...root.querySelectorAll<HTMLImageElement>(".chat-badges img")];
    expect(images.map((image) => image.dataset.badgeSource)).toEqual(["twitch", "7tv", "badgesBttv", "badgesFfz", "badgesChatterino", "badgesHomies"]);
    expect(images.slice(1).map((image) => [image.alt, image.title])).toEqual([
      ["7TV Winner", "7TV Winner"],
      ["BTTV VIP", "BTTV VIP"],
      ["FFZ VIP", "FFZ VIP"],
      ["Chatterino VIP", "Chatterino VIP"],
      ["Homies member", "Homies member"],
    ]);
    renderer.dispose();
  });

  it("refreshes an existing line after badge data arrives and makes no request when badges are hidden", async () => {
    let listener: ((userId: string) => void) | undefined;
    let resolved: Array<{ provider: "badgesBttv"; name: string; url: string }> = [];
    const thirdParty = {
      setEnabled: vi.fn(),
      load: vi.fn(async () => undefined),
      resolve: () => resolved,
      subscribe: (next: (userId: string) => void) => { listener = next; return () => { listener = undefined; }; },
      dispose: vi.fn(),
    };
    const hidden = createChatRenderer({
      root, theme: { ...DEFAULTS, showBadges: false },
      thirdPartyBadges: thirdParty as unknown as import("../../src/renderer/third-party-badges").ThirdPartyBadgeLookup,
      scheduler: (callback) => { callback(); return 1; },
    });
    hidden.handle(parseIrcLine("@id=hidden-badge;user-id=42 :viewer!viewer@host PRIVMSG #room :still visible")!);
    expect(thirdParty.load).not.toHaveBeenCalled();
    expect(root.querySelectorAll(".chat-badges img")).toHaveLength(0);
    hidden.dispose();

    const renderer = createChatRenderer({
      root, theme: DEFAULTS,
      thirdPartyBadges: thirdParty as unknown as import("../../src/renderer/third-party-badges").ThirdPartyBadgeLookup,
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=late-badge;user-id=42 :viewer!viewer@host PRIVMSG #room :line stays")!);
    const line = root.querySelector(".chat-line");
    resolved = [{ provider: "badgesBttv", name: "Late Badge", url: "https://cdn.betterttv.net/badges/late.png" }];
    listener?.("42");
    await Promise.resolve();
    expect(root.querySelector(".chat-line")).toBe(line);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.querySelector("img.chat-badge")?.getAttribute("title")).toBe("Late Badge");
    expect(root.querySelector<HTMLImageElement>("img.chat-badge")?.style.getPropertyValue("height")).toBe("18px");
    renderer.dispose();
  });

  it("uses a historical message's remaining lifetime and deduplicates its live copy", () => {
    vi.useFakeTimers();
    vi.setSystemTime(100_000);
    const renderer = createChatRenderer({
      root, theme: { ...DEFAULTS, lifetime: 10_000 },
      scheduler: (callback) => { callback(); return 1; },
    });
    const historical = parseIrcLine("@id=history-live;tmi-sent-ts=95000;historical=1 :viewer!viewer@host PRIVMSG #room :same message")!;
    const live = parseIrcLine("@id=history-live :viewer!viewer@host PRIVMSG #room :same message")!;
    renderer.handle(historical, 95_000);
    const firstLine = root.querySelector(".chat-line");
    renderer.handle(live, 100_000);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.querySelector(".chat-line")).toBe(firstLine);
    vi.advanceTimersByTime(4_999);
    expect(firstLine?.getAttribute("style")).toContain("opacity: 1");
    vi.advanceTimersByTime(1);
    expect(firstLine?.getAttribute("style")).toContain("opacity: 0");
    renderer.dispose();
  });

  it("does not create reaction bursts or rain for historical events", () => {
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => { callback(); return 1; } });
    const historicalRaid = parseIrcLine("@historical=1;msg-id=raid;msg-param-viewerCount=10 :tmi.twitch.tv USERNOTICE #room :Historical raid")!;
    renderer.handle(historicalRaid);
    expect(dom.window.document.querySelectorAll(".reaction-burst, .reaction-rain")).toHaveLength(0);
    expect(root.textContent).toContain("Historical raid");
    renderer.dispose();
  });

  it("fires a live reaction when a historical raid is deduplicated", () => {
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => { callback(); return 1; } });
    const historicalRaid = parseIrcLine("@id=history-raid;historical=1;msg-id=raid;msg-param-viewerCount=10 :tmi.twitch.tv USERNOTICE #room :Raid")!;
    const liveRaid = parseIrcLine("@id=history-raid;msg-id=raid;msg-param-viewerCount=10 :tmi.twitch.tv USERNOTICE #room :Raid")!;
    renderer.handle(historicalRaid);
    expect(dom.window.document.querySelectorAll(".reaction-burst, .reaction-rain")).toHaveLength(0);
    const originalLine = root.querySelector(".chat-line");
    renderer.handle(liveRaid);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.querySelector(".chat-line")).toBe(originalLine);
    expect(root.querySelectorAll(".chat-line.chat-reaction-highlight")).toHaveLength(1);
    renderer.dispose();
  });

  it("drops duplicate Shared Chat source ids and marks a foreign source room", () => {
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=first;source-id=shared-1;room-id=11;source-room-id=22 :viewer!viewer@host PRIVMSG #room :original")!);
    renderer.handle(parseIrcLine("@id=second;source-id=shared-1;room-id=11;source-room-id=22 :viewer!viewer@host PRIVMSG #room :duplicate")!);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.textContent).toContain("original");
    expect(root.textContent).not.toContain("duplicate");
    expect(root.querySelector(".chat-source-room")?.getAttribute("data-room-id")).toBe("22");
    renderer.dispose();
  });

  it("keeps foreign-room emote codes as text and hides pronoun lookups until enabled", () => {
    const emotes = createEmoteLookup({ providers: [] });
    emotes.add([{ name: "ForeignEmote", url: "https://cdn.7tv.app/emote/foreign/2x.webp", provider: "7TV" }]);
    const lookup = { lookup: vi.fn().mockResolvedValue("They/Them"), dispose: vi.fn() };
    const renderer = createChatRenderer({ root, theme: DEFAULTS, emotes, pronouns: lookup, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=shared;room-id=11;source-room-id=22;user-id=42;login=viewer :viewer!viewer@host PRIVMSG #room :ForeignEmote")!);
    expect(root.querySelector("img.chat-emote")).toBeNull();
    expect(root.textContent).toContain("ForeignEmote");
    expect(lookup.lookup).not.toHaveBeenCalled();
    renderer.setTheme({ ...DEFAULTS, showPronouns: true });
    return vi.waitFor(() => {
      expect(lookup.lookup).toHaveBeenCalledWith("viewer");
      expect(root.textContent).toContain("They/Them");
    }).finally(() => renderer.dispose());
  });

  it("keeps opt-in display settings off without changing the default line appearance", () => {
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=default-look;display-name=Viewer :viewer!viewer@host PRIVMSG #room :default look")!);
    const line = root.querySelector<HTMLElement>(".chat-line")!;
    expect(DEFAULTS).toMatchObject({ textShadow: 0, smallCaps: false, nameOnOwnLine: false, hideNames: false, readableNames: false });
    expect(line.classList.contains("chat-name-own-line")).toBe(false);
    expect(line.classList.contains("chat-small-caps")).toBe(false);
    expect(line.classList.contains("chat-hide-names")).toBe(false);
    expect(line.classList.contains("chat-readable-names")).toBe(false);
    expect(root.style.getPropertyValue("--t-text-shadow")).toBe("none");
    expect(line.querySelector(".chat-name")?.classList.contains("chat-sr-only")).toBe(false);
    expect(line.textContent).toContain("Viewer");
    expect(line.textContent).toContain("default look");
    renderer.dispose();
  });

  it.each(["name-first", "message-first"] as const)("keeps badges and names together above the message in %s order", (lineOrder) => {
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, nameOnOwnLine: true, lineOrder },
      scheduler: (callback) => callback(),
    });
    renderer.handle(parseIrcLine("@id=own-line;display-name=Viewer;badges=subscriber/1;emotes=25:0-4 :viewer!viewer@host PRIVMSG #room :Kappa hello")!);
    const line = root.querySelector<HTMLElement>(".chat-line")!;
    const meta = line.querySelector<HTMLElement>(".chat-meta")!;
    const message = line.querySelector<HTMLElement>(".chat-message")!;
    expect(line.classList.contains("chat-name-own-line")).toBe(true);
    expect(meta.querySelector(".chat-badges")).not.toBeNull();
    expect(meta.querySelector(".chat-name")?.textContent).toBe("Viewer");
    expect(message.querySelector(".chat-emote")).not.toBeNull();
    expect([...line.children].map((child) => child.className)).toEqual(lineOrder === "name-first"
      ? ["chat-meta", "chat-message"]
      : ["chat-message", "chat-meta"]);
    renderer.dispose();
  });

  it("hides names visually while keeping accessible names, badges, highlights, and system messages", () => {
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, hideNames: true },
      scheduler: (callback) => callback(),
    });
    renderer.handle(parseIrcLine("@id=hidden-highlight;display-name=Viewer;msg-id=highlighted-message :viewer!viewer@host PRIVMSG #room :highlight still reads")!);
    renderer.handle(parseIrcLine("@id=hidden-system;display-name=System :tmi.twitch.tv USERNOTICE #room :System message remains")!);
    const lines = [...root.querySelectorAll<HTMLElement>(".chat-line")];
    expect(lines).toHaveLength(2);
    expect(lines[0]?.classList.contains("chat-highlighted")).toBe(true);
    expect(lines.every((line) => line.classList.contains("chat-hide-names"))).toBe(true);
    expect(lines.every((line) => line.querySelector(".chat-name")?.classList.contains("chat-sr-only"))).toBe(true);
    expect(lines[0]?.querySelector(".chat-name")?.textContent).toBe("Viewer");
    expect(lines[0]?.querySelector(".chat-badges")).not.toBeNull();
    expect(lines[0]?.querySelector(".chat-message")?.textContent).toContain("highlight still reads");
    expect(lines[1]?.querySelector(".chat-message")?.textContent).toContain("System message remains");
    renderer.dispose();
  });

  it("adds an independent dark text shadow and readable tag colors while preserving text colors and paints", () => {
    const darkTheme = {
      ...DEFAULTS,
      textShadow: 4,
      outline: 2,
      backgroundColor: "#090515",
      backgroundOpacity: 1,
      readableNames: true,
    };
    const paints = {
      resolve: () => ({ type: "solid" as const, value: "#123456" }),
      resolveBadge: () => undefined,
      load: vi.fn(async () => undefined),
      setChannelId: vi.fn(),
      setEnabled: vi.fn(),
      setBadgesEnabled: vi.fn(),
      set: vi.fn(),
      subscribe: () => () => undefined,
      dispose: vi.fn(),
    };
    const renderer = createChatRenderer({ root, theme: darkTheme, paints, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=readable;display-name=Viewer;color=#21133e;user-id=42 :viewer!viewer@host PRIVMSG #room :readable")!);
    const line = root.querySelector<HTMLElement>(".chat-line")!;
    const name = line.querySelector<HTMLElement>(".chat-name")!;
    expect(root.style.getPropertyValue("--t-text-shadow")).toContain("4px");
    expect(root.style.getPropertyValue("--t-outline")).toBe("2px");
    expect(line.classList.contains("chat-readable-names")).toBe(true);
    expect(name.style.color).toBe("rgb(18, 52, 86)");
    renderer.dispose();

    root.replaceChildren();
    const tagRenderer = createChatRenderer({ root, theme: darkTheme, scheduler: (callback) => callback() });
    tagRenderer.handle(parseIrcLine("@id=readable-tag;display-name=Viewer;color=#21133e :viewer!viewer@host PRIVMSG #room :readable")!);
    const adjusted = root.querySelector<HTMLElement>(".chat-name")?.style.color ?? "";
    const expectedStyle = dom.window.document.createElement("span");
    expectedStyle.style.color = ensureReadableNameColor("#21133e", "#090515");
    expect(adjusted).toBe(expectedStyle.style.color);
    expect(estimateTextLegibility(ensureReadableNameColor("#21133e", "#090515"), "#090515", 1).contrastOnBlack).toBeGreaterThanOrEqual(4.5);
    tagRenderer.setTheme({ ...darkTheme, nameColorMode: "text" });
    expectedStyle.style.color = darkTheme.textColor;
    expect(root.querySelector<HTMLElement>(".chat-name")?.style.color).toBe(expectedStyle.style.color);
    tagRenderer.dispose();
  });

  it("uses the highlight color and the enabled panel color as readable-name backgrounds", () => {
    const highlightBackground = "#ffffff";
    const highlightedRenderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, readableNames: true, highlightBackgroundColor: highlightBackground },
      scheduler: (callback) => callback(),
    });
    highlightedRenderer.handle(parseIrcLine("@id=readable-highlight;display-name=Viewer;color=#21133e;msg-id=highlighted-message :viewer!viewer@host PRIVMSG #room :highlight")!);
    const highlightedName = root.querySelector<HTMLElement>(".chat-name")!;
    const expectedStyle = dom.window.document.createElement("span");
    expectedStyle.style.color = ensureReadableNameColor("#21133e", highlightBackground);
    expect(highlightedName.style.color).toBe(expectedStyle.style.color);
    highlightedRenderer.dispose();

    root.replaceChildren();
    const panelBackground = "#ffffff";
    const panelRenderer = createChatRenderer({
      root,
      theme: {
        ...DEFAULTS,
        readableNames: true,
        backgroundOpacity: 0.2,
        panelEnabled: true,
        panelBackgroundColor: panelBackground,
      },
      scheduler: (callback) => callback(),
    });
    panelRenderer.handle(parseIrcLine("@id=readable-panel;display-name=Viewer;color=#21133e :viewer!viewer@host PRIVMSG #room :panel")!);
    expectedStyle.style.color = ensureReadableNameColor("#21133e", panelBackground);
    expect(root.querySelector<HTMLElement>(".chat-name")?.style.color).toBe(expectedStyle.style.color);
    panelRenderer.dispose();
  });

  it("recalculates readable names when a reaction highlights a line", () => {
    const highlightBackground = "#ffffff";
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, readableNames: true, highlightBackgroundColor: highlightBackground },
      scheduler: (callback) => { callback(); return 1; },
    });
    renderer.handle(parseIrcLine("@id=readable-raid;display-name=Viewer;color=#000000;msg-id=raid;msg-param-viewerCount=4 :tmi.twitch.tv USERNOTICE #room :Raid")!);
    const line = root.querySelector<HTMLElement>(".chat-line")!;
    const name = line.querySelector<HTMLElement>(".chat-name")!;
    const expectedStyle = dom.window.document.createElement("span");
    expectedStyle.style.color = ensureReadableNameColor("#000000", highlightBackground);
    expect(line.classList.contains("chat-reaction-highlight")).toBe(true);
    expect(name.style.color).toBe(expectedStyle.style.color);
    renderer.dispose();
  });

  it("keeps a contiguous newest suffix when a middle row cannot fit", () => {
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, 100, 400);
      if (!this.classList.contains("chat-line")) return rect(0, 0, 0);
      const message = this.querySelector(".chat-message")?.textContent ?? "";
      const height = message === "old" ? 20 : message === "middle" ? 80 : 40;
      return rect(0, height, 400);
    });
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 100 },
      scheduler: (callback) => { callback(); return 1; },
    });
    for (const message of ["old", "middle", "newest"]) {
      renderer.handle(parseIrcLine(`@id=row-${message} :viewer!viewer@host PRIVMSG #room :${message}`)!);
    }
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.textContent).toContain("newest");
    expect(root.textContent).not.toContain("middle");
    expect(root.textContent).not.toContain("old");
    renderer.dispose();
  });

  it.each([
    ["nameOnOwnLine", "chat-name-own-line"],
    ["smallCaps", "chat-small-caps"],
    ["hideNames", "chat-hide-names"],
  ] as const)("still prunes to the height limit when %s changes line metrics", (option, className) => {
    const originalGetBoundingClientRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    vi.spyOn(dom.window.HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      if (this === root) return rect(0, 120, 400);
      if (!this.classList.contains("chat-line")) return originalGetBoundingClientRect.call(this);
      const height = this.classList.contains(className) ? 90 : 40;
      return rect(0, height, 400);
    });
    const optionValue = { [option]: true };
    const renderer = createChatRenderer({
      root,
      theme: { ...DEFAULTS, maxChatHeight: 120, ...optionValue },
      scheduler: (callback) => { callback(); return 1; },
    });
    for (let index = 0; index < 3; index += 1) {
      renderer.handle(parseIrcLine(`@id=metric-${option}-${index} :viewer!viewer@host PRIVMSG #room :line ${index}`)!);
    }
    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(root.textContent).toContain("line 2");
    renderer.dispose();
  });
});
