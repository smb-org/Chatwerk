import { afterEach, describe, expect, it, vi } from "vitest";
import { JSDOM } from "jsdom";
import { DEFAULTS } from "../../src/shared/theme";
import { createChatRenderer } from "../../src/renderer/render";
import { parseIrcLine } from "../../src/renderer/irc-parse";

const dom = new JSDOM("<!doctype html><main id='chat'></main>");
const root = dom.window.document.querySelector("main") as HTMLElement;

afterEach(() => {
  root.replaceChildren();
  vi.restoreAllMocks();
});

describe("text renderer", () => {
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
});
