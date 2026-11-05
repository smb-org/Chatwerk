import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { DEFAULTS } from "../../src/shared/theme";
import { createChatRenderer } from "../../src/renderer/render";
import { parseIrcLine } from "../../src/renderer/irc-parse";
import { createEmoteLookup } from "../../src/renderer/emotes";
import { createBadgeLookup } from "../../src/renderer/badges";
import { buildPaintStyle, createPaintLookup } from "../../src/renderer/paints";

const dom = new JSDOM("<!doctype html><main id='chat'></main>");
const root = dom.window.document.querySelector("main") as HTMLElement;

afterEach(() => {
  root.replaceChildren();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("text renderer", () => {
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

  it("keeps HTML in chat messages as text", () => {
    const renderer = createChatRenderer({ root, theme: DEFAULTS, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@display-name=Viewer :viewer!viewer@host PRIVMSG #room :<img onerror=x>" )!);
    expect(root.textContent).toContain("<img onerror=x>");
    expect(root.querySelector("img")).toBeNull();
    renderer.dispose();
  });

  it("caps the DOM at 300 messages and batches appends through the scheduler", () => {
    let flush: (() => void) | undefined;
    const renderer = createChatRenderer({
      root,
      theme: DEFAULTS,
      nodeLimit: 900,
      scheduler: (callback) => { flush = callback; return 1; },
      cancelScheduled: () => { flush = undefined; },
    });
    for (let i = 0; i < 300; i += 1) {
      renderer.handle(parseIrcLine(`@id=${i} :viewer!viewer@host PRIVMSG #room :message ${i}`)!);
    }
    expect(root.children).toHaveLength(0);
    flush?.();
    expect(root.children.length).toBe(300);
    renderer.handle(parseIrcLine("@id=300 :viewer!viewer@host PRIVMSG #room :message 300")!);
    flush?.();
    expect(root.children.length).toBe(300);
    expect(root.textContent).not.toContain("message 0");
    renderer.dispose();
  });

  it("uses 100 messages by default and applies fade or no-motion lifetime behavior", () => {
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
    expect(root.querySelector<HTMLElement>(".chat-name")?.style.getPropertyValue("background-image"))
      .toContain("linear-gradient(90deg");
    expect(buildPaintStyle({ function: "URL", image_url: "https://cdn.7tv.app/paint/paint/1x.webp" }))
      .toMatchObject({ type: "image" });
    expect(buildPaintStyle({ function: "URL", image_url: "https://evil.example/paint.png" })).toBeNull();
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
});
