import { afterEach, describe, expect, it, vi } from "vitest";
import { createEmoteLookup, splitMessage, type EmoteAsset } from "../../src/renderer/emotes";
import { createChatRenderer } from "../../src/renderer/render";
import { DEFAULTS } from "../../src/shared/theme";
import { JSDOM } from "jsdom";
import { parseIrcLine } from "../../src/renderer/irc-parse";

const asset = (name: string, provider = "test", zeroWidth = false): EmoteAsset => ({
  name,
  url: `https://cdn.7tv.app/emote/${name}/2x.webp`,
  provider,
  zeroWidth,
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("emote lookup", () => {
  it("uses Twitch code-point ranges after surrogate pairs", () => {
    const parts = splitMessage("😀 Kappa ok", [{ id: "25", ranges: [{ start: 2, end: 6 }] }]);
    expect(parts).toEqual([
      { type: "text", value: "😀 " },
      { type: "emote", name: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0", zeroWidth: false },
      { type: "text", value: " ok" },
    ]);
  });

  it("maps an emote at the end of a message after an emoji", () => {
    expect(splitMessage("Hello 😀Kappa", [{ id: "25", ranges: [{ start: 7, end: 11 }] }])).toEqual([
      { type: "text", value: "Hello 😀" },
      { type: "emote", name: "Kappa", url: "https://static-cdn.jtvnw.net/emoticons/v2/25/default/dark/2.0", zeroWidth: false },
    ]);
  });

  it("loads global and channel emotes into the same name lookup", async () => {
    const provider = {
      name: "test",
      loadGlobal: vi.fn(async () => [asset("Global")]),
      loadChannel: vi.fn(async (channelId: string) => [asset(`Channel${channelId}`)]),
    };
    const lookup = createEmoteLookup({ providers: [provider] });
    lookup.setChannelId("42");
    await vi.waitFor(() => expect(lookup.resolve("Channel42")).toBeDefined());
    expect(lookup.resolve("Global")).toMatchObject({ provider: "test" });
    expect(provider.loadChannel.mock.calls[0]?.[0]).toBe("42");
    lookup.dispose();
  });

  it("loads channel scopes independently and keeps channel assets ahead of global assets", async () => {
    const provider = {
      name: "test",
      loadGlobal: async () => [asset("Shared", "global"), asset("GlobalOnly", "global")],
      loadChannel: async (channelId: string) => [asset("Shared", `room-${channelId}`), asset(`Only${channelId}`)],
    };
    const lookup = createEmoteLookup({ providers: [provider] });
    lookup.setChannelIds(["10", "20"]);
    await vi.waitFor(() => {
      expect(lookup.resolve("Only10", "10")).toBeDefined();
      expect(lookup.resolve("Only20", "20")).toBeDefined();
    });
    expect(lookup.resolve("Shared", "10")?.provider).toBe("room-10");
    expect(lookup.resolve("Shared", "20")?.provider).toBe("room-20");
    expect(lookup.resolve("Shared")?.provider).toBe("room-10");
    expect(lookup.resolve("Only10", "20")).toBeUndefined();
    lookup.dispose();
  });

  it("only treats a zero-width emote after an emote as an overlay", async () => {
    const lookup = createEmoteLookup({ providers: [{
      name: "7tv",
      loadGlobal: async () => [asset("Overlay", "7tv", true)],
    }] });
    await vi.waitFor(() => expect(lookup.resolve("Overlay")?.zeroWidth).toBe(true));
    expect(splitMessage("Overlay", [], lookup)).toEqual([
      { type: "emote", name: "Overlay", url: "https://cdn.7tv.app/emote/Overlay/2x.webp", zeroWidth: false },
    ]);
    expect(splitMessage("text Overlay", [], lookup)).toEqual([
      { type: "text", value: "text " },
      { type: "emote", name: "Overlay", url: "https://cdn.7tv.app/emote/Overlay/2x.webp", zeroWidth: false },
    ]);
    expect(splitMessage("Kappa plain Overlay", [], {
      resolve: (name) => name === "Kappa" ? asset("Kappa") : lookup.resolve(name),
    })).toEqual([
      { type: "emote", name: "Kappa", url: "https://cdn.7tv.app/emote/Kappa/2x.webp", zeroWidth: false },
      { type: "text", value: " plain " },
      { type: "emote", name: "Overlay", url: "https://cdn.7tv.app/emote/Overlay/2x.webp", zeroWidth: false },
    ]);
    expect(splitMessage("KappaOverlay", [], {
      resolve: (name) => name === "Kappa" ? asset("Kappa") : name === "Overlay" ? lookup.resolve(name) : undefined,
    })).toEqual([
      {
        type: "emote", name: "Kappa", url: "https://cdn.7tv.app/emote/Kappa/2x.webp", zeroWidth: false,
        overlays: [{ name: "Overlay", url: "https://cdn.7tv.app/emote/Overlay/2x.webp" }],
      },
    ]);
    lookup.dispose();
  });

  it("uses the fixed provider precedence regardless of completion order", async () => {
    let resolveSeven!: (assets: EmoteAsset[]) => void;
    const lookup = createEmoteLookup({ providers: [
      { name: "FFZ", loadGlobal: async () => [asset("Same", "FFZ")] },
      { name: "BTTV", loadGlobal: async () => [asset("Same", "BTTV")] },
      { name: "7TV", loadGlobal: () => new Promise<EmoteAsset[]>((resolve) => { resolveSeven = resolve; }) },
    ] });
    await vi.waitFor(() => expect(lookup.resolve("Same")?.provider).toBe("BTTV"));
    resolveSeven([asset("Same", "7TV")]);
    await vi.waitFor(() => expect(lookup.resolve("Same")?.provider).toBe("7TV"));
    lookup.dispose();
  });

  it("refreshes the current 7TV emote set after reconnect without duplicate or empty subscriptions", async () => {
    const subscriptions: Array<{ type: string; condition: Record<string, string>; unsubscribe: ReturnType<typeof vi.fn> }> = [];
    let reconnect: (() => void) | undefined;
    const eventApi = {
      subscribe: vi.fn((type: string, condition: string | Record<string, string>) => {
        const normalized = typeof condition === "string" ? { object_id: condition } : condition;
        const unsubscribe = vi.fn();
        subscriptions.push({ type, condition: normalized, unsubscribe });
        return unsubscribe;
      }),
      onReconnect: vi.fn((listener: () => void) => {
        reconnect = listener;
        return vi.fn();
      }),
      dispose: vi.fn(),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/emote-sets/global")) return new Response(JSON.stringify({ id: "global-set", emotes: [] }), { status: 200 });
      if (url.endsWith("/users/twitch/42")) return new Response(JSON.stringify({
        user: { id: "7tv-user" },
        emote_set: { id: "channel-set", emotes: [{ id: "1", name: "ChannelBefore" }] },
      }), { status: 200 });
      if (url.endsWith("/emote-sets/channel-set")) return new Response(JSON.stringify({
        id: "channel-set", emotes: [{ id: "2", name: "ChannelAfter" }],
      }), { status: 200 });
      throw new Error("provider unavailable");
    });
    const lookup = createEmoteLookup({ eventApi, fetcher });
    lookup.setChannelId("42");
    await vi.waitFor(() => expect(lookup.resolve("ChannelBefore")).toBeDefined());
    expect(subscriptions).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "emote_set.update", condition: { object_id: "global-set" } }),
      expect.objectContaining({ type: "emote_set.update", condition: { object_id: "channel-set" } }),
    ]));
    expect(subscriptions.every(({ condition }) => Object.values(condition).every(Boolean))).toBe(true);
    expect(subscriptions.some(({ type }) => type === "user.update")).toBe(false);

    reconnect?.();
    await vi.waitFor(() => expect(lookup.resolve("ChannelAfter")).toBeDefined());
    expect(subscriptions).toHaveLength(2);
    lookup.dispose();
    for (const { unsubscribe } of subscriptions) expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("releases removed channel subscriptions across repeated add/remove cycles and reconnects", async () => {
    const subscriptions: Array<{ condition: Record<string, string>; unsubscribe: ReturnType<typeof vi.fn> }> = [];
    let reconnect: (() => void) | undefined;
    const eventApi = {
      subscribe: vi.fn((_type: string, condition: string | Record<string, string>) => {
        const normalized = typeof condition === "string" ? { object_id: condition } : condition;
        const unsubscribe = vi.fn();
        subscriptions.push({ condition: normalized, unsubscribe });
        return unsubscribe;
      }),
      onReconnect: vi.fn((listener: () => void) => { reconnect = listener; return vi.fn(); }),
      dispose: vi.fn(),
    };
    let channelFetches = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/emote-sets/global")) return new Response(JSON.stringify({ id: "global-set", emotes: [] }), { status: 200 });
      if (url.startsWith("https://7tv.io/v3/users/twitch/42")) {
        channelFetches += 1;
        return new Response(JSON.stringify({ user: { id: "user-42" }, emote_set: { id: "channel-set", emotes: [] } }), { status: 200 });
      }
      throw new Error("unexpected fetch");
    });
    const lookup = createEmoteLookup({ eventApi, fetcher });
    const activeChannelSubscriptions = () => subscriptions.filter(({ condition, unsubscribe }) =>
      condition.object_id === "channel-set" && unsubscribe.mock.calls.length === 0).length;

    for (let cycle = 1; cycle <= 3; cycle += 1) {
      lookup.setChannelIds(["42"]);
      await vi.waitFor(() => expect(channelFetches).toBe(cycle));
      await vi.waitFor(() => expect(activeChannelSubscriptions()).toBe(1));
      lookup.setChannelIds([]);
      await vi.waitFor(() => expect(activeChannelSubscriptions()).toBe(0));
    }

    const channelFetchesBeforeReconnect = channelFetches;
    reconnect?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channelFetches).toBe(channelFetchesBeforeReconnect);
    expect(activeChannelSubscriptions()).toBe(0);
    lookup.dispose();
  });

  it("ignores a reconnect refresh that completes after its channel is removed", async () => {
    const subscriptions: Array<{ condition: Record<string, string>; unsubscribe: ReturnType<typeof vi.fn> }> = [];
    let reconnect: (() => void) | undefined;
    let resolvePendingRefresh: ((response: Response) => void) | undefined;
    let channelFetches = 0;
    const eventApi = {
      subscribe: vi.fn((_type: string, condition: string | Record<string, string>) => {
        const normalized = typeof condition === "string" ? { object_id: condition } : condition;
        const unsubscribe = vi.fn();
        subscriptions.push({ condition: normalized, unsubscribe });
        return unsubscribe;
      }),
      onReconnect: vi.fn((listener: () => void) => { reconnect = listener; return vi.fn(); }),
      dispose: vi.fn(),
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/emote-sets/global")) {
        return new Response(JSON.stringify({ id: "global-set", emotes: [] }), { status: 200 });
      }
      if (url.startsWith("https://7tv.io/v3/users/twitch/42")) {
        channelFetches += 1;
        if (channelFetches === 2) {
          return await new Promise<Response>((resolve) => { resolvePendingRefresh = resolve; });
        }
        return new Response(JSON.stringify({
          user: { id: "user-42" },
          emote_set: { id: "channel-set", emotes: [] },
        }), { status: 200 });
      }
      if (url.startsWith("https://7tv.io/v3/emote-sets/")) {
        return new Response(JSON.stringify({ id: "channel-set", emotes: [] }), { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    const lookup = createEmoteLookup({ eventApi, fetcher });
    const activeChannelSubscriptions = () => subscriptions.filter(({ condition, unsubscribe }) =>
      condition.object_id !== "global-set" && unsubscribe.mock.calls.length === 0).length;

    lookup.setChannelIds(["42"]);
    await vi.waitFor(() => expect(activeChannelSubscriptions()).toBe(1));
    reconnect?.();
    await vi.waitFor(() => expect(channelFetches).toBe(2));
    expect(resolvePendingRefresh).toBeDefined();

    lookup.setChannelIds([]);
    resolvePendingRefresh!(new Response(JSON.stringify({
      user: { id: "user-42" },
      emote_set: { id: "stale-set", emotes: [] },
    }), { status: 200 }));
    await new Promise((resolve) => setTimeout(resolve, 0));

    reconnect?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(channelFetches).toBe(2);
    expect(activeChannelSubscriptions()).toBe(0);
    lookup.dispose();
  });

  it("renders chat immediately when one provider rejects or hangs", async () => {
    vi.useFakeTimers();
    const lookup = createEmoteLookup({
      timeoutMs: 5_000,
      providers: [
        { name: "offline", loadGlobal: async () => { throw new Error("offline"); } },
        { name: "stuck", loadGlobal: () => new Promise<EmoteAsset[]>(() => undefined) },
      ],
    });
    const dom = new JSDOM("<main></main>");
    const root = dom.window.document.querySelector("main") as HTMLElement;
    const renderer = createChatRenderer({ root, theme: DEFAULTS, emotes: lookup, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=live :viewer!viewer@host PRIVMSG #room :chat is not waiting")!);
    expect(root.textContent).toContain("chat is not waiting");
    await vi.advanceTimersByTimeAsync(5_001);
    expect(root.textContent).toContain("chat is not waiting");
    renderer.dispose();
    lookup.dispose();
    vi.useRealTimers();
  });

  it("accepts a provider response that takes 20 seconds", async () => {
    vi.useFakeTimers();
    const lookup = createEmoteLookup({ providers: [{
      name: "slow",
      loadGlobal: () => new Promise<EmoteAsset[]>((resolve) => {
        setTimeout(() => resolve([asset("Slow")]), 20_000);
      }),
    }] });

    await vi.advanceTimersByTimeAsync(5_001);
    expect(lookup.resolve("Slow")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(14_999);
    expect(lookup.resolve("Slow")).toBeDefined();
    lookup.dispose();
  });

  it("uses arriving emotes for new lines and leaves rendered lines unchanged", async () => {
    let finish!: (assets: EmoteAsset[]) => void;
    const lookup = createEmoteLookup({ providers: [{
      name: "late",
      loadGlobal: () => new Promise<EmoteAsset[]>((resolve) => { finish = resolve; }),
    }] });
    const dom = new JSDOM("<main></main>");
    const root = dom.window.document.querySelector("main") as HTMLElement;
    const renderer = createChatRenderer({ root, theme: DEFAULTS, emotes: lookup, scheduler: (callback) => callback() });
    renderer.handle(parseIrcLine("@id=before :viewer!viewer@host PRIVMSG #room :Late")!);
    expect(root.querySelector(".chat-message")?.textContent).toBe("Late");
    expect(root.querySelector(".chat-emote")).toBeNull();

    finish([asset("Late", "late")]);
    await vi.waitFor(() => expect(lookup.resolve("Late")).toBeDefined());
    expect(root.querySelector(".chat-message")?.textContent).toBe("Late");
    expect(root.querySelector(".chat-emote")).toBeNull();
    renderer.handle(parseIrcLine("@id=after :viewer!viewer@host PRIVMSG #room :Late")!);
    expect(root.querySelectorAll(".chat-emote")).toHaveLength(1);
    renderer.dispose();
  });

  it("retries a failed scope after exponential backoff until it succeeds", async () => {
    vi.useFakeTimers();
    const random = vi.spyOn(Math, "random").mockReturnValue(0.5);
    let attempts = 0;
    const lookup = createEmoteLookup({ providers: [{
      name: "retry",
      loadGlobal: async () => {
        attempts += 1;
        if (attempts < 3) throw new Error("temporary failure");
        return [asset("Recovered", "retry")];
      },
    }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(14_999);
    expect(attempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(attempts).toBe(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(attempts).toBe(3);
    expect(random).toHaveBeenCalledTimes(2);
    expect(lookup.resolve("Recovered")).toBeDefined();
    lookup.dispose();
  });

  it("aborts the in-flight provider and clears timers on dispose", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const lookup = createEmoteLookup({ providers: [{
      name: "stuck",
      loadGlobal: (_update, requestSignal) => {
        signal = requestSignal;
        return new Promise<EmoteAsset[]>(() => undefined);
      },
    }] });

    lookup.dispose();
    expect(signal?.aborted).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps scopes independent while another provider retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let retryAttempts = 0;
    const lookup = createEmoteLookup({ providers: [
      {
        name: "retrying",
        loadGlobal: async () => {
          retryAttempts += 1;
          if (retryAttempts === 1) throw new Error("temporary failure");
          return [asset("Recovered", "retrying")];
        },
      },
      { name: "fast", loadGlobal: async () => [asset("Fast", "fast")] },
    ] });

    await vi.advanceTimersByTimeAsync(0);
    expect(lookup.resolve("Fast")).toBeDefined();
    expect(lookup.resolve("Recovered")).toBeUndefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(lookup.resolve("Fast")).toBeDefined();
    expect(lookup.resolve("Recovered")).toBeDefined();
    lookup.dispose();
  });

  it("retries a channel scope without repeating its successful global scope", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let globalAttempts = 0;
    let channelAttempts = 0;
    const lookup = createEmoteLookup({ providers: [{
      name: "scoped",
      loadGlobal: async () => {
        globalAttempts += 1;
        return [asset("Global", "scoped")];
      },
      loadChannel: async () => {
        channelAttempts += 1;
        if (channelAttempts < 3) throw new Error("temporary channel failure");
        return [asset("Channel", "scoped")];
      },
    }] });
    lookup.setChannelId("42");
    await vi.advanceTimersByTimeAsync(0);
    expect(globalAttempts).toBe(1);
    expect(channelAttempts).toBe(1);
    expect(lookup.resolve("Global")).toBeDefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(channelAttempts).toBe(2);
    expect(globalAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(channelAttempts).toBe(3);
    expect(lookup.resolve("Channel")).toBeDefined();
    lookup.dispose();
  });

  it("keeps an update received before a failed attempt through later retries", async () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0.5);
    let attempts = 0;
    const lookup = createEmoteLookup({ providers: [{
      name: "updates",
      loadGlobal: async (onUpdate) => {
        attempts += 1;
        if (attempts === 1) {
          onUpdate([asset("Kept", "updates")]);
          throw new Error("request failed after an update");
        }
        throw new Error("still unavailable");
      },
    }] });
    await vi.advanceTimersByTimeAsync(0);
    expect(lookup.resolve("Kept")).toBeDefined();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(attempts).toBe(2);
    expect(lookup.resolve("Kept")).toBeDefined();
    lookup.dispose();
  });

  it("honors Retry-After and does not retry a missing 7TV channel account", async () => {
    vi.useFakeTimers();
    let channelAttempts = 0;
    let rateLimitedAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("7tv.io") && url.endsWith("/users/twitch/404")) {
        channelAttempts += 1;
        return new Response(null, { status: 404 });
      }
      if (url.includes("7tv.io") && url.endsWith("/users/twitch/429")) {
        rateLimitedAttempts += 1;
        if (rateLimitedAttempts === 1) return new Response(null, { status: 429, headers: { "retry-after": "10" } });
        return new Response(JSON.stringify({ emote_set: { emotes: [{ id: "ok", name: "RateLimited" }] } }), { status: 200 });
      }
      if (url.includes("7tv.io")) return new Response(JSON.stringify({ emotes: [] }), { status: 200 });
      if (url.includes("betterttv.net")) return new Response(JSON.stringify({ channelEmotes: [], sharedEmotes: [] }), { status: 200 });
      return new Response(JSON.stringify({ sets: {}, default_sets: [] }), { status: 200 });
    });
    const eventApi = { subscribe: () => () => undefined, onReconnect: () => () => undefined, dispose: () => undefined };
    const missing = createEmoteLookup({ fetcher, eventApi });
    missing.setChannelId("404");
    await vi.advanceTimersByTimeAsync(0);
    expect(channelAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(channelAttempts).toBe(1);
    missing.dispose();

    const limited = createEmoteLookup({ fetcher, eventApi });
    limited.setChannelId("429");
    await vi.advanceTimersByTimeAsync(0);
    expect(rateLimitedAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(9_999);
    expect(rateLimitedAttempts).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(rateLimitedAttempts).toBe(2);
    expect(limited.resolve("RateLimited")).toBeDefined();
    limited.dispose();
  });

  it("does not replace emote names inside longer words", async () => {
    const lookup = createEmoteLookup({ providers: [{ name: "test", loadGlobal: async () => [asset("Kappa")] }] });
    await vi.waitFor(() => expect(lookup.resolve("Kappa")).toBeDefined());
    expect(splitMessage("Kappa Kappas", [], lookup)).toEqual([
      { type: "emote", name: "Kappa", url: "https://cdn.7tv.app/emote/Kappa/2x.webp", zeroWidth: false },
      { type: "text", value: " Kappas" },
    ]);
    lookup.dispose();
  });

  it("replaces a provider scope when its live set changes", async () => {
    let update: ((assets: EmoteAsset[]) => void) | undefined;
    const lookup = createEmoteLookup({ providers: [{
      name: "7TV",
      loadGlobal: async (onUpdate) => {
        update = onUpdate;
        return [asset("Before", "7TV")];
      },
    }] });
    await vi.waitFor(() => expect(lookup.resolve("Before")).toBeDefined());
    update?.([asset("After", "7TV")]);
    expect(lookup.resolve("Before")).toBeUndefined();
    expect(lookup.resolve("After")).toBeDefined();
    lookup.dispose();
  });

  it("keeps the original text when there are no matching provider emotes", () => {
    expect(splitMessage("plain chat", [])).toEqual([{ type: "text", value: "plain chat" }]);
  });
});
