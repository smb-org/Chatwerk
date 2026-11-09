import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPaintStyle, createPaintLookup } from "../../src/renderer/paints";
import type { SevenTvEvent } from "../../src/renderer/seventv-events";

const json = (value: unknown): Response => new Response(JSON.stringify(value), { status: 200 });
const changeMap = (id: string, object: unknown) => ({ id, kind: 0, actor: { id: "actor" }, updated: [], pushed: [], pulled: [], object });

const uraniumPaint = {
  id: "01G9DJJ40G00044BJY7M3198HC",
  name: "Uranium",
  color: null,
  kind: "PAINT",
  function: "RADIAL_GRADIENT",
  repeat: false,
  angle: 0,
  shape: "circle",
  image_url: "",
  stops: [
    { at: 0, color: -285277953 },
    { at: 0.5, color: -1493237505 },
    { at: 1, color: 1573063167 },
  ],
  shadows: [
    { x_offset: 0, y_offset: 0, radius: 0.5, color: 624034303 },
    { x_offset: 0, y_offset: 0, radius: 4, color: -1109325313 },
  ],
  gradients: [],
};

const ghoulishPaint = {
  id: "01M3QBESQ89Z6DDENSWNYJDB1D",
  name: "Ghoulish",
  color: null,
  kind: "PAINT",
  function: "LINEAR_GRADIENT",
  repeat: false,
  angle: 90,
  shape: "circle",
  image_url: "",
  stops: [
    { at: 0.15, color: -1992243969 },
    { at: 0.45, color: 1495449599 },
    { at: 0.65, color: 16712959 },
  ],
  shadows: [{ x_offset: 0, y_offset: 0, radius: 0.1, color: 1140916223 }],
  gradients: [],
};

afterEach(() => vi.useRealTimers());

describe("7TV paints", () => {
  it("builds gradients from the verbatim top-level Uranium and Ghoulish paint fields", () => {
    expect(buildPaintStyle(uraniumPaint)).toEqual({
      type: "gradient",
      value: "radial-gradient(circle, #eeff00ff 0%, #a6ff00ff 50%, #5dc309ff 100%)",
      filter: "drop-shadow(0px 0px 0.5px #253201ff) drop-shadow(0px 0px 4px #bde109ff)",
    });
    expect(buildPaintStyle(ghoulishPaint)).toEqual({
      type: "gradient",
      value: "linear-gradient(90deg, #8940c4ff 15%, #5922bfff 45%, #00ff04ff 65%)",
      filter: "drop-shadow(0px 0px 0.1px #4400ffff)",
    });
  });

  it("rejects an empty URL image while accepting the allowlisted 7TV paint host", () => {
    expect(buildPaintStyle({ function: "URL", image_url: "" })).toBeNull();
    expect(buildPaintStyle({ function: "URL", image_url: "https://cdn.7tv.app/paint/paint/1x.webp" }))
      .toEqual({ type: "image", value: 'url("https://cdn.7tv.app/paint/paint/1x.webp")' });
  });

  it("accepts a bundled image paint and can seed a bundled 7TV badge", () => {
    expect(buildPaintStyle({ function: "URL", image_url: "/assets/samples/name-paint.svg" }))
      .toEqual({ type: "image", value: 'url("/assets/samples/name-paint.svg")' });

    const paints = createPaintLookup({ enabled: false, badgesEnabled: true });
    paints.set("7100002", { function: "URL", image_url: "/assets/samples/name-paint.svg" }, true);
    paints.setBadge("7100002", { name: "Sample 7TV badge", url: "/assets/samples/seventv-badge.svg" }, true);
    expect(paints.resolve("7100002")).toBeUndefined();
    expect(paints.resolve("7100002", true)).toEqual({
      type: "image", value: 'url("/assets/samples/name-paint.svg")',
    });
    expect(paints.resolveBadge("7100002")).toBeUndefined();
    expect(paints.resolveBadge("7100002", true)).toEqual({
      name: "Sample 7TV badge", url: "/assets/samples/seventv-badge.svg",
    });

    vi.useFakeTimers();
    vi.advanceTimersByTime(6 * 60_000);
    expect(paints.resolve("7100002", true)).toEqual({
      type: "image", value: 'url("/assets/samples/name-paint.svg")',
    });
    expect(paints.resolveBadge("7100002", true)).toEqual({
      name: "Sample 7TV badge", url: "/assets/samples/seventv-badge.svg",
    });
    paints.dispose();
  });

  it("does not resolve a live paint with a CSS injection payload", () => {
    const paints = createPaintLookup({ enabled: false });
    paints.set("42", { function: "URL", image_url: '/assets/unused"),url("/health?x' });

    expect(paints.resolve("42")).toBeUndefined();
    paints.dispose();
  });

  it("requests and resolves top-level fields for a first paint lookup", async () => {
    vi.useFakeTimers();
    let paintQuery = "";
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("userByConnection")) {
        return json({ data: { u0: { id: "7tv-user", style: { paint_id: uraniumPaint.id } } } });
      }

      paintQuery = request.query;
      const hasTopLevelPaintFields = request.query.includes(
        "paints { id name color kind function repeat angle shape image_url stops { at color } gradients",
      );
      const { id, name, color, kind, shadows, gradients } = uraniumPaint;
      const paint = {
        id, name, color, kind, shadows, gradients,
        ...(hasTopLevelPaintFields ? {
          function: uraniumPaint.function,
          repeat: uraniumPaint.repeat,
          angle: uraniumPaint.angle,
          shape: uraniumPaint.shape,
          image_url: uraniumPaint.image_url,
          stops: uraniumPaint.stops,
        } : {}),
      };
      return json({ data: { cosmetics: { paints: [paint] } } });
    });
    const paints = createPaintLookup({ fetcher });

    void paints.load("42");
    await vi.advanceTimersByTimeAsync(1_500);
    await vi.advanceTimersByTimeAsync(2_000);

    expect(paintQuery).toContain("paints { id name color kind function repeat angle shape image_url stops { at color } gradients");
    expect(paints.resolve("42")).toEqual({
      type: "gradient",
      value: "radial-gradient(circle, #eeff00ff 0%, #a6ff00ff 50%, #5dc309ff 100%)",
      filter: "drop-shadow(0px 0px 0.5px #253201ff) drop-shadow(0px 0px 4px #bde109ff)",
    });
    paints.dispose();
  });

  it("loads 7TV badges through the shared cosmetics query and entitlement events", async () => {
    vi.useFakeTimers();
    const callbacks = new Map<string, (event: SevenTvEvent) => void>();
    const eventApi = {
      subscribe: vi.fn((type: string, condition: Record<string, string>, listener: (event: SevenTvEvent) => void) => {
        callbacks.set(type, listener);
        void condition;
        return vi.fn();
      }),
      onReconnect: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
    };
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      if (request.query.includes("userByConnection")) {
        expect(request.query).toContain("badge_id");
        return json({ data: { u0: { id: "7tv-user", style: { badge_id: "badge-1" } } } });
      }
      expect(request.query).toContain("badges { id name tooltip host { url } }");
      return json({ data: { cosmetics: { badges: [{
        id: "badge-1", name: "Event winner", tooltip: "Event winner", host: { url: "//cdn.7tv.app/badge/badge-1" },
      }] } } });
    });
    const paints = createPaintLookup({ eventApi, fetcher, enabled: false, badgesEnabled: true });
    paints.setChannelId("1234");
    callbacks.get("entitlement.create")?.({ type: "entitlement.create", body: changeMap("ent-1", {
      kind: "BADGE", ref_id: "badge-1", user: { connections: [{ platform: "TWITCH", id: "42" }] },
    }) });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(paints.resolveBadge("42")).toEqual({
      name: "Event winner", url: "https://cdn.7tv.app/badge/badge-1/2x.webp",
    });

    callbacks.get("entitlement.delete")?.({ type: "entitlement.delete", body: changeMap("ent-1", {
      kind: "BADGE", ref_id: "badge-1", user: { connections: [{ platform: "TWITCH", id: "42" }] },
    }) });
    expect(paints.resolveBadge("42")).toBeUndefined();
    paints.dispose();
  });

  it("does not fetch or subscribe while paints are disabled and resumes when enabled", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => json({ data: {} }));
    const eventApi = {
      subscribe: vi.fn(() => vi.fn()),
      onReconnect: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
    };
    const paints = createPaintLookup({ eventApi, fetcher, enabled: false });
    paints.setChannelId("1234");
    void paints.load("42");
    expect(fetcher).not.toHaveBeenCalled();
    expect(eventApi.subscribe).not.toHaveBeenCalled();

    paints.setEnabled(true);
    paints.setChannelId("1234");
    expect(eventApi.subscribe).toHaveBeenCalledTimes(3);
    void paints.load("42");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetcher).toHaveBeenCalled();
    paints.setEnabled(false);
    const callsWhenDisabled = fetcher.mock.calls.length;
    void paints.load("43");
    expect(fetcher).toHaveBeenCalledTimes(callsWhenDisabled);
    paints.dispose();
  });

  it("subscribes by channel and applies real entitlement and cosmetic change maps", () => {
    const callbacks = new Map<string, (event: SevenTvEvent) => void>();
    const eventApi = {
      subscribe: vi.fn((type: string, condition: Record<string, string>, listener: (event: SevenTvEvent) => void) => {
        callbacks.set(`${type}:${condition.id}`, listener);
        return vi.fn();
      }),
      onReconnect: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
    };
    const paints = createPaintLookup({ eventApi, fetcher: vi.fn() });
    paints.setChannelId("1234");
    expect(eventApi.subscribe).toHaveBeenCalledTimes(3);
    for (const type of ["cosmetic.create", "entitlement.create", "entitlement.delete"]) {
      expect(eventApi.subscribe).toHaveBeenCalledWith(type, { ctx: "channel", platform: "TWITCH", id: "1234" }, expect.any(Function));
    }

    callbacks.get("entitlement.create:1234")?.({ type: "entitlement.create", body: changeMap("ent-1", {
      kind: "PAINT",
      ref_id: "paint-1",
      user: { connections: [{ platform: "TWITCH", id: "42" }] },
    }) });
    callbacks.get("cosmetic.create:1234")?.({ type: "cosmetic.create", body: changeMap("paint-1", {
      id: "paint-1", kind: "PAINT", data: { color: -3648769 },
    }) });
    expect(paints.resolve("42")).toEqual({ type: "solid", value: "#ffc852ff" });

    callbacks.get("cosmetic.create:1234")?.({ type: "cosmetic.create", body: changeMap("paint-1", {
      id: "paint-1", kind: "PAINT", data: {
        id: "paint-1", function: "LINEAR_GRADIENT", angle: 0, repeat: false,
        stops: [{ at: 0, color: -3_648_769 }, { at: 1, color: "#ffffff" }],
        shadows: [{ x_offset: 1, y_offset: 0, radius: 2, color: -3_648_769 }],
      },
    }) });
    expect(paints.resolve("42")).toMatchObject({
      type: "gradient",
      value: "linear-gradient(0deg, #ffc852ff 0%, #ffffff 100%)",
      filter: "drop-shadow(1px 0px 2px #ffc852ff)",
    });

    callbacks.get("cosmetic.create:1234")?.({ type: "cosmetic.create", body: {
      id: "paint-1", kind: 0, actor: { id: "actor" },
      updated: [{ key: "color", value: -3648769 }], pushed: [], pulled: [],
    } });
    expect(paints.resolve("42")).toEqual({ type: "solid", value: "#ffc852ff" });

    callbacks.get("entitlement.delete:1234")?.({ type: "entitlement.delete", body: changeMap("ent-1", {
      kind: "PAINT",
      ref_id: "paint-1",
      user: { connections: [{ platform: "TWITCH", id: "42" }] },
    }) });
    expect(paints.resolve("42")).toBeUndefined();
    paints.dispose();
  });

  it("batches connection aliases and fetches paint definitions with the v3 cosmetics query", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string; variables: Record<string, unknown> };
      if (request.query.includes("userByConnection")) {
        return json({ data: Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`u${i}`, {
          id: `7tv-${i}`, style: { paint_id: `paint-${i}` },
        }])) });
      }
      return json({ data: { cosmetics: { paints: (request.variables.ids as string[]).map((id) => ({
        id, kind: "PAINT", color: -3648769,
      })) } } });
    });
    const paints = createPaintLookup({ fetcher });
    for (let i = 0; i < 25; i += 1) void paints.load(String(100 + i));
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const first = JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body)) as { query: string };
    expect((first.query.match(/userByConnection/gu) ?? [])).toHaveLength(25);
    expect(first.query).toContain("u0:");
    expect(first.query).toContain("u24:");

    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const second = JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body)) as { query: string; variables: { ids: string[] } };
    expect(second.query).toContain("cosmetics(list: $ids)");
    expect(second.variables.ids).toHaveLength(25);
    expect(paints.resolve("100")).toEqual({ type: "solid", value: "#ffc852ff" });
    paints.dispose();
  });

  it("keeps a full cosmetic event paint when a parallel query returns an incomplete definition", async () => {
    vi.useFakeTimers();
    const callbacks = new Map<string, (event: SevenTvEvent) => void>();
    const eventApi = {
      subscribe: vi.fn((type: string, condition: Record<string, string>, listener: (event: SevenTvEvent) => void) => {
        callbacks.set(type, listener);
        void condition;
        return vi.fn();
      }),
      onReconnect: vi.fn(() => vi.fn()),
      dispose: vi.fn(),
    };
    let finishQuery!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { finishQuery = resolve; }));
    const paints = createPaintLookup({ fetcher, eventApi });
    paints.setChannelId("1234");
    callbacks.get("entitlement.create")?.({ type: "entitlement.create", body: changeMap("ent-1", {
      kind: "PAINT", ref_id: "paint-1", user: { connections: [{ platform: "TWITCH", id: "42" }] },
    }) });
    await vi.advanceTimersByTimeAsync(1_500);

    callbacks.get("cosmetic.create")?.({ type: "cosmetic.create", body: changeMap("paint-1", {
      id: "paint-1", kind: "PAINT", data: {
        id: "paint-1", function: "LINEAR_GRADIENT", angle: 90, repeat: false,
        stops: [{ at: 0, color: "#ff0000" }, { at: 1, color: "#0000ff" }],
      },
    }) });
    const expected = { type: "gradient", value: "linear-gradient(90deg, #ff0000 0%, #0000ff 100%)" };
    expect(paints.resolve("42")).toMatchObject(expected);

    finishQuery(json({ data: { cosmetics: { paints: [{ id: "paint-1", kind: "PAINT", color: null, gradients: [], shadows: [] }] } } }));
    await vi.advanceTimersByTimeAsync(0);
    expect(paints.resolve("42")).toMatchObject(expected);
    paints.dispose();
  });

  it("bounds GraphQL fallback work for a channel with 1,000 distinct users", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const request = JSON.parse(String(init?.body)) as { query: string };
      const aliases = [...request.query.matchAll(/(u\d+):userByConnection/gu)].map((match) => match[1]!);
      return json({ data: Object.fromEntries(aliases.map((alias) => [alias, {
        id: "00000000000000000000000000", style: { paint_id: null },
      }])) });
    });
    const eventApi = {
      subscribe: vi.fn((type: string, condition: Record<string, string>, listener: (event: SevenTvEvent) => void) => {
        void type;
        void condition;
        void listener;
        return vi.fn();
      }),
      onReconnect: vi.fn((listener: () => void) => {
        void listener;
        return vi.fn();
      }),
      dispose: vi.fn(),
    };
    const paints = createPaintLookup({ fetcher, eventApi });
    paints.setChannelId("1234");
    expect(eventApi.subscribe).toHaveBeenCalledTimes(3);
    for (let i = 0; i < 1_000; i += 1) void paints.load(String(10_000 + i));
    await vi.advanceTimersByTimeAsync(23_500);
    expect(fetcher).toHaveBeenCalledTimes(12);
    expect(Math.ceil(fetcher.mock.calls.length / (23_500 / 60_000))).toBeLessThanOrEqual(31);
    expect(eventApi.subscribe.mock.calls.map(([type]) => type)).toEqual([
      "cosmetic.create", "entitlement.create", "entitlement.delete",
    ]);
    paints.dispose();
  });

  it("keeps a GQL request alive for at least 30 seconds", async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const fetcher = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      signal = init?.signal as AbortSignal | undefined;
      signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const paints = createPaintLookup({ fetcher, timeoutMs: 1_000 });
    void paints.load("42");
    await vi.advanceTimersByTimeAsync(1_500);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(28_499);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signal?.aborted).toBe(true);
    paints.dispose();
  });

  it("keeps GraphQL batches serialized while a request is slow", async () => {
    vi.useFakeTimers();
    let active = 0;
    let maximumActive = 0;
    const resolvers: Array<(response: Response) => void> = [];
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      resolvers.push((response) => {
        active -= 1;
        resolve(response);
      });
    }));
    const paints = createPaintLookup({ fetcher });
    void paints.load("42");
    await vi.advanceTimersByTimeAsync(1_500);
    void paints.load("43");
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);

    resolvers[0]?.(json({ data: { u0: null } }));
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);
    paints.dispose();
  });

  it("uses RGBA integers for solid colors and supports repeating gradients and safe shadows", () => {
    expect(buildPaintStyle({ color: -3_648_769 })).toEqual({ type: "solid", value: "#ffc852ff" });
    expect(buildPaintStyle({
      gradients: [{
        function: "LINEAR_GRADIENT", angle: 90, repeat: true,
        stops: [{ at: 0, color: -3_648_769 }, { at: 1, color: "#0000ffff" }],
      }],
      shadows: [{ x_offset: 1.5, y_offset: -2, radius: 3, color: -3_648_769 }],
    })).toMatchObject({
      type: "gradient",
      value: "repeating-linear-gradient(90deg, #ffc852ff 0%, #0000ffff 100%)",
      filter: "drop-shadow(1.5px -2px 3px #ffc852ff)",
    });
    expect(buildPaintStyle({
      gradients: [{ function: "RADIAL_GRADIENT", shape: "CIRCLE", repeat: true,
        stops: [{ at: 0, color: "#ffffff" }, { at: 1, color: "#000000" }] }],
    })?.value).toContain("repeating-radial-gradient");
  });

  it("rejects hostile angle, stop position, and shadow inputs independently", () => {
    expect(buildPaintStyle({
      function: "LINEAR_GRADIENT", angle: "90deg; color:red",
      stops: [{ at: 0, color: "#ffffff" }, { at: 1, color: "#000000" }],
    })).toBeNull();
    expect(buildPaintStyle({
      function: "LINEAR_GRADIENT", angle: 90,
      stops: [{ at: "0); color:red", color: "#ffffff" }, { at: 1, color: "#000000" }],
    })).toBeNull();
    expect(buildPaintStyle({ color: "#ffffff", shadows: [{ x_offset: "0px;url(x)", y_offset: 0, radius: 1, color: "#000000" }] })).toBeNull();
  });
});
