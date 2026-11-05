// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/shared/theme";
import { parseIrcLine, type CommonMessage, type ReactionType } from "../../src/renderer/irc-parse";
import { MAX_REACTION_ELEMENTS, createReactionEffects, type ReactionAlias } from "../../src/renderer/reactions";
import { createChatRenderer } from "../../src/renderer/render";

const manifest = {
  raid: { image: "/effects/raid.svg", sound: "/effects/raid.mp3" },
  sub: { image: "/effects/sub.svg", sound: "/effects/sub.mp3" },
  bits: { image: "/effects/bits.svg", sound: "/effects/bits.mp3" },
  hype: { image: "/effects/hype.svg", sound: "/effects/hype.mp3" },
};

type HypeTrainMessage = { type: "hype-train"; id: string; trainId: string; channel: string; phase: "begin" | "progress" | "end"; level: number; expiresAt: string | null };
function hype(
  id: string,
  phase: HypeTrainMessage["phase"],
  level: number,
  expiresAt: string | null = new Date(Date.now() + 20_000).toISOString(),
  trainId = id,
): HypeTrainMessage {
  return { type: "hype-train", id, trainId, channel: "sample", phase, level, expiresAt };
}
function sendHype(effects: ReturnType<typeof createReactionEffects>, message: HypeTrainMessage): void {
  (effects as unknown as { handleHypeTrain(message: HypeTrainMessage): void }).handleHypeTrain(message);
}

function fixture(type: ReactionType, id: string, room = "10", sourceId?: string): CommonMessage {
  const tags = type === "bits"
    ? `bits=100;msg-id=;`
    : `msg-id=${type};msg-param-viewerCount=12;msg-param-months=6;`;
  const source = sourceId ? `;source-id=${sourceId}` : "";
  const line = `@id=${id};room-id=${room}${source};${tags}display-name=Viewer :tmi.twitch.tv ${type === "bits" ? "PRIVMSG" : "USERNOTICE"} #room :${type === "bits" ? "Cheer100" : "Thanks"}`;
  return parseIrcLine(line) as CommonMessage;
}

function alias(message: CommonMessage): ReactionAlias {
  return { key: `${message.roomId}\u0000${message.id}`, room: message.roomId ?? "", id: message.id };
}

function makeEffects(theme = DEFAULTS, fetcher: typeof fetch = async (input) => {
  if (String(input).endsWith("manifest.json")) return Response.json(manifest);
  return new Response(null, { status: 404 });
}): ReturnType<typeof createReactionEffects> {
  const root = document.createElement("main");
  root.style.width = "400px";
  root.style.height = "600px";
  document.body.appendChild(root);
  return createReactionEffects({ root, theme, fetcher });
}

async function settleEffects(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("stream reactions", () => {
  it("shows a Hype Train ring and chip at begin, then clears on end", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    sendHype(effects, hype("begin-1", "begin", 1));
    await settleEffects();
    expect(document.querySelector(".reaction-layer")?.classList.contains("hype-train-active")).toBe(true);
    expect(document.querySelector(".hype-train-chip")?.textContent).toContain("LV 1");
    sendHype(effects, hype("end-1", "end", 1, null));
    expect(document.querySelector(".hype-train-chip")).toBeNull();
    expect(document.querySelector(".reaction-layer")?.classList.contains("hype-train-active")).toBe(false);
    effects.dispose();
  });

  it("keeps the Hype Train ring but skips its burst and sound when a cached manifest lacks Hype", async () => {
    vi.useFakeTimers();
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const legacyManifest = {
      raid: manifest.raid, sub: manifest.sub, bits: manifest.bits,
    };
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("manifest.json")
      ? Response.json(legacyManifest) : (requested.push(String(input)), new Response(new Uint8Array([1]), { status: 200 })));
    const effects = makeEffects({ ...DEFAULTS, reactionSoundEnabled: true }, fetcher);
    const raid = fixture("raid", "legacy-raid");
    effects.enqueue(raid, { type: "raid", amount: 1 }, alias(raid));
    sendHype(effects, hype("legacy-manifest-hype", "begin", 1));
    await settleEffects();
    expect(document.querySelector('.reaction-burst[data-effect="raid"]')).not.toBeNull();
    expect(fetcher).toHaveBeenCalledWith("/effects/manifest.json", { cache: "no-cache" });
    await vi.advanceTimersByTimeAsync(1_200);
    await settleEffects();
    expect(document.querySelector(".hype-train-chip")).not.toBeNull();
    expect(document.querySelector('.reaction-burst[data-effect="hype"]')).toBeNull();
    expect(requested).not.toContain("/effects/hype.mp3");
    effects.dispose();
  });

  it("drops late events for ended trains while accepting another train and evicting old ended ids", () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    sendHype(effects, hype("a-begin", "begin", 1, undefined, "train-a"));
    sendHype(effects, hype("a-end", "end", 1, null, "train-a"));
    sendHype(effects, hype("a-late", "progress", 8, undefined, "train-a"));
    expect(document.querySelector(".hype-train-chip")).toBeNull();

    sendHype(effects, hype("b-begin", "begin", 2, undefined, "train-b"));
    expect(document.querySelector(".hype-train-chip")?.textContent).toContain("LV 2");
    sendHype(effects, hype("b-end", "end", 2, null, "train-b"));
    for (let index = 0; index < 16; index += 1) {
      sendHype(effects, hype(`ended-${index}`, "end", 1, null, `ended-train-${index}`));
    }
    sendHype(effects, hype("a-late-after-eviction", "progress", 3, undefined, "train-a"));
    expect(document.querySelector(".hype-train-chip")?.textContent).toContain("LV 3");
    effects.dispose();
  });

  it("ignores expired Hype Train begin and progress events without visual or sound effects", async () => {
    vi.useFakeTimers();
    vi.spyOn(window.HTMLMediaElement.prototype, "play").mockResolvedValue();
    vi.spyOn(window.HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const requested: string[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      requested.push(String(input));
      return String(input).endsWith("manifest.json") ? Response.json(manifest) : new Response(new Uint8Array([1]));
    });
    const effects = makeEffects({ ...DEFAULTS, reactionSoundEnabled: true }, fetcher);
    const expired = new Date(Date.now() - 1).toISOString();
    sendHype(effects, hype("expired-begin", "begin", 1, expired, "expired-train"));
    await settleEffects();
    expect(document.querySelector(".hype-train-chip")).toBeNull();
    expect(document.querySelector('.reaction-burst[data-effect="hype"]')).toBeNull();
    expect(requested).not.toContain("/effects/hype.mp3");

    sendHype(effects, hype("live-begin", "begin", 1, undefined, "live-train"));
    await settleEffects();
    const soundRequests = requested.filter((path) => path === "/effects/hype.mp3").length;
    const burstCount = document.querySelectorAll('.reaction-burst[data-effect="hype"]').length;
    sendHype(effects, hype("expired-progress", "progress", 9, expired, "live-train"));
    await settleEffects();
    expect(document.querySelector(".hype-train-chip")?.textContent).toContain("LV 1");
    expect(document.querySelectorAll('.reaction-burst[data-effect="hype"]')).toHaveLength(burstCount);
    expect(requested.filter((path) => path === "/effects/hype.mp3")).toHaveLength(soundRequests);
    effects.dispose();
  });

  it("keeps Hype Train message ids deduped after 300 chat source ids", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    sendHype(effects, hype("hype-retry-id", "begin", 1, undefined, "stable-train"));
    for (let index = 0; index < 300; index += 1) {
      const message = fixture("raid", `chat-${index}`, "10", `chat-source-${index}`);
      effects.enqueue(message, { type: "raid", amount: 1 }, alias(message));
      effects.clearRoom("10");
    }
    sendHype(effects, hype("hype-retry-id", "progress", 9, undefined, "stable-train"));
    await settleEffects();
    expect(document.querySelector(".hype-train-chip")?.textContent).toContain("LV 1");
    expect(document.querySelectorAll('.reaction-burst[data-effect="hype"]')).toHaveLength(1);
    effects.dispose();
  });

  it("keeps the active ring and chip when motion is disabled, but removes its burst", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    sendHype(effects, hype("motion-none", "begin", 1));
    await settleEffects();
    effects.setTheme({ ...DEFAULTS, motion: "none" });
    expect(document.querySelector(".reaction-layer")?.classList.contains("hype-train-active")).toBe(true);
    expect(document.querySelector(".hype-train-chip")).not.toBeNull();
    expect(document.querySelectorAll(".reaction-burst")).toHaveLength(0);
    effects.dispose();
  });

  it("bursts only when progress raises the level and does not add sound bursts otherwise", async () => {
    vi.useFakeTimers();
    const effects = makeEffects({ ...DEFAULTS, reactionSoundEnabled: true });
    sendHype(effects, hype("progress-join", "progress", 1));
    await settleEffects();
    expect(document.querySelectorAll('.reaction-burst[data-effect="hype"]')).toHaveLength(0);
    sendHype(effects, hype("progress-same", "progress", 1));
    sendHype(effects, hype("progress-up", "progress", 2));
    sendHype(effects, hype("progress-late", "progress", 1, new Date(Date.now() + 30_000).toISOString()));
    await settleEffects();
    expect(document.querySelectorAll('.reaction-burst[data-effect="hype"]')).toHaveLength(1);
    expect(document.querySelector(".hype-train-chip")?.textContent).toContain("LV 2");
    await vi.advanceTimersByTimeAsync(20_001);
    expect(document.querySelector(".hype-train-chip")).not.toBeNull();
    effects.dispose();
  });

  it("expires the active look at expiresAt", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    sendHype(effects, hype("expire", "begin", 3, new Date(Date.now() + 2_000).toISOString()));
    expect(document.querySelector(".hype-train-chip")).not.toBeNull();
    await vi.advanceTimersByTimeAsync(2_001);
    expect(document.querySelector(".hype-train-chip")).toBeNull();
    effects.dispose();
  });

  it("clears Hype Train expiry and burst timers on dispose", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    sendHype(effects, hype("dispose", "begin", 1));
    await settleEffects();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    effects.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops repeated EventSub message ids", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    sendHype(effects, hype("same-id", "begin", 1));
    sendHype(effects, hype("same-id", "progress", 9));
    await settleEffects();
    expect(document.querySelector(".hype-train-chip")?.textContent).toContain("LV 1");
    expect(document.querySelectorAll('.reaction-burst[data-effect="hype"]')).toHaveLength(1);
    effects.dispose();
  });

  it("ends the active look immediately when the toggle is disabled", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    sendHype(effects, hype("toggle-on", "begin", 1));
    effects.setTheme({ ...DEFAULTS, reactionHypeTrain: false });
    expect(document.querySelector(".hype-train-chip")).toBeNull();
    sendHype(effects, hype("toggle-off", "begin", 2));
    expect(document.querySelector(".hype-train-chip")).toBeNull();
    effects.dispose();
  });

  it("shows no look or burst at zero reaction intensity", async () => {
    vi.useFakeTimers();
    const effects = makeEffects({ ...DEFAULTS, reactionIntensity: 0 });
    sendHype(effects, hype("zero", "begin", 1));
    await settleEffects();
    expect(document.querySelector(".hype-train-chip")).toBeNull();
    expect(document.querySelectorAll('.reaction-burst[data-effect="hype"]')).toHaveLength(0);
    effects.dispose();
  });

  it("keeps 200 gift-sub reactions under the element cap and drops the oldest queued work", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    effects.enqueue(fixture("raid", "raid-first"), { type: "raid", amount: 12 }, alias(fixture("raid", "raid-first")));
    for (let index = 0; index < 199; index += 1) {
      const message = fixture("subgift", `gift-${index}`);
      effects.enqueue(message, { type: "subgift", amount: 1 }, alias(message));
    }
    const finalBits = fixture("bits", "bits-last");
    effects.enqueue(finalBits, { type: "bits", amount: 100 }, alias(finalBits));
    await settleEffects();

    const layer = document.querySelector<HTMLElement>(".reaction-layer")!;
    expect(layer.querySelectorAll("*").length).toBeLessThanOrEqual(MAX_REACTION_ELEMENTS);
    expect(layer.querySelector('[data-effect="raid"]')).not.toBeNull();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(layer.querySelector('[data-effect="bits"]')).not.toBeNull();
    expect(layer.querySelectorAll("*").length).toBeLessThanOrEqual(MAX_REACTION_ELEMENTS);
    effects.dispose();
  });

  it("enforces a cooldown while still processing queued reactions", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    const raid = fixture("raid", "raid-1");
    const sub = fixture("sub", "sub-1");
    effects.enqueue(raid, { type: "raid", amount: 12 }, alias(raid));
    effects.enqueue(sub, { type: "sub", amount: null }, alias(sub));
    await settleEffects();
    const layer = document.querySelector<HTMLElement>(".reaction-layer")!;
    expect(layer.querySelectorAll(".reaction-burst")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1_200);
    expect(layer.querySelectorAll(".reaction-burst")).toHaveLength(2);
    effects.dispose();
  });

  it("deduplicates a Shared Chat source id and keeps the surviving room alias", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    const home = fixture("raid", "raid-home", "10", "shared-event");
    const shared = fixture("raid", "raid-shared", "20", "shared-event");
    effects.enqueue(home, { type: "raid", amount: 12 }, alias(home));
    effects.enqueue(shared, { type: "raid", amount: 12 }, alias(shared));
    await settleEffects();
    const layer = document.querySelector<HTMLElement>(".reaction-layer")!;
    expect(layer.querySelectorAll(".reaction-burst")).toHaveLength(1);

    effects.cancelAlias(alias(home).key);
    expect(layer.querySelectorAll(".reaction-burst")).toHaveLength(1);
    effects.cancelAlias(alias(shared).key);
    expect(layer.querySelectorAll(".reaction-burst")).toHaveLength(0);
    effects.dispose();
  });

  it("cancels a moderated event before it can start or remain visible", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    const first = fixture("raid", "raid-active");
    const queued = fixture("sub", "sub-removed");
    effects.enqueue(first, { type: "raid", amount: 12 }, alias(first));
    effects.enqueue(queued, { type: "sub", amount: null }, alias(queued));
    effects.cancelAlias(alias(queued).key);
    await settleEffects();
    const layer = document.querySelector<HTMLElement>(".reaction-layer")!;
    expect(layer.querySelector('[data-effect="sub"]')).toBeNull();
    effects.cancelAlias(alias(first).key);
    expect(layer.querySelectorAll(".reaction-burst")).toHaveLength(0);
    effects.dispose();
  });

  it("removes a real IRC reaction and its line when CLEARMSG targets its room and id", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => Response.json(manifest));
    const root = document.createElement("main");
    document.body.appendChild(root);
    const renderer = createChatRenderer({ root });
    renderer.handle(parseIrcLine("@id=raid-1;room-id=10;msg-id=raid;msg-param-viewerCount=12;display-name=Raider;system-msg=Raiding :tmi.twitch.tv USERNOTICE #room")!);
    await vi.advanceTimersByTimeAsync(16);
    await settleEffects();

    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(document.querySelector('[data-effect="raid"]')).not.toBeNull();
    renderer.handle(parseIrcLine("@room-id=10;target-msg-id=raid-1 :tmi.twitch.tv CLEARMSG #room :Raiding")!);
    expect(root.querySelectorAll(".chat-line")).toHaveLength(0);
    expect(document.querySelector('[data-effect="raid"]')).toBeNull();
    renderer.dispose();
  });

  it("uses a static line highlight with motion none and creates no animated elements", async () => {
    vi.useFakeTimers();
    const root = document.createElement("main");
    document.body.appendChild(root);
    const effects = createReactionEffects({ root, theme: { ...DEFAULTS, motion: "none" }, fetcher: async () => Response.json(manifest) });
    const line = document.createElement("div");
    root.appendChild(line);
    const message = fixture("raid", "raid-static");
    effects.attachLine(alias(message).key, line);
    effects.enqueue(message, { type: "raid", amount: 12 }, alias(message));
    await settleEffects();

    expect(line.classList.contains("chat-reaction-highlight")).toBe(true);
    expect(document.querySelectorAll(".reaction-burst, .reaction-rain, .reaction-effect")).toHaveLength(0);
    effects.setTheme(DEFAULTS);
    expect(line.classList.contains("chat-reaction-highlight")).toBe(true);
    await vi.advanceTimersByTimeAsync(3_500);
    expect(line.classList.contains("chat-reaction-highlight")).toBe(false);
    effects.dispose();
  });

  it("expires the highlight fallback when a reaction line is never shown", async () => {
    vi.useFakeTimers();
    const effects = makeEffects({ ...DEFAULTS, lifetime: 1_000 });
    const message = fixture("raid", "never-shown");
    const line = document.createElement("div");
    effects.enqueue(message, { type: "raid", amount: 12 }, alias(message));
    await settleEffects();
    await vi.advanceTimersByTimeAsync(1_000);
    effects.attachLine(alias(message).key, line);

    expect(line.classList.contains("chat-reaction-highlight")).toBe(false);
    effects.dispose();
  });

  it("fails quietly when a fixed sound file is absent or autoplay is blocked", async () => {
    vi.useFakeTimers();
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const play = vi.fn().mockRejectedValue(new Error("autoplay blocked"));
    vi.stubGlobal("Audio", class { volume = 0; addEventListener(): void {} play = play; });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("manifest.json")
      ? Response.json(manifest)
      : new Response(null, { status: 404 }));
    const effects = makeEffects({ ...DEFAULTS, reactionSoundEnabled: true }, fetcher as typeof fetch);
    const message = fixture("raid", "raid-sound");
    effects.enqueue(message, { type: "raid", amount: 12 }, alias(message));
    await settleEffects();
    expect(fetcher).toHaveBeenCalledWith("/effects/raid.mp3", expect.anything());
    expect(play).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    effects.dispose();
  });

  it("tries an available sound once, applies its volume, and ignores autoplay rejection", async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const play = vi.fn().mockRejectedValue(new Error("autoplay blocked"));
    class FakeAudio {
      volume = 0;
      addEventListener(): void {}
      play = play;
    }
    class FakeURL extends URL {
      static createObjectURL(): string { return "blob:reaction-sound"; }
      static revokeObjectURL(): void {}
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", FakeURL);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).endsWith("manifest.json")
      ? Response.json(manifest)
      : new Response(new Uint8Array([1, 2, 3]), { status: 200 }));
    const effects = makeEffects({ ...DEFAULTS, reactionSoundEnabled: true, reactionVolume: 0.65 }, fetcher as typeof fetch);
    const message = fixture("raid", "raid-audio");
    effects.enqueue(message, { type: "raid", amount: 12 }, alias(message));
    await settleEffects();

    expect(play).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/effects/raid.mp3", expect.anything());
    expect(errors).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(play).toHaveBeenCalledTimes(1);
    effects.dispose();
  });

  it("deduplicates a Shared Chat raid notice across both configured channels", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", async () => Response.json(manifest));
    const root = document.createElement("main");
    document.body.appendChild(root);
    const renderer = createChatRenderer({ root, theme: { ...DEFAULTS, channels: ["home", "partner"] } });
    renderer.setChannels(["home", "partner"]);
    renderer.handle(parseIrcLine("@id=relay-home;msg-id=sharedchatnotice;source-msg-id=raid;msg-param-viewerCount=12;room-id=10;source-room-id=20;source-id=shared-raid;display-name=Raider :tmi.twitch.tv USERNOTICE #home")!);
    renderer.handle(parseIrcLine("@id=relay-partner;msg-id=sharedchatnotice;source-msg-id=raid;msg-param-viewerCount=12;room-id=20;source-room-id=10;source-id=shared-raid;display-name=Raider :tmi.twitch.tv USERNOTICE #partner")!);
    await vi.advanceTimersByTimeAsync(16);
    await settleEffects();

    expect(root.querySelectorAll(".chat-line")).toHaveLength(1);
    expect(document.querySelectorAll('.reaction-burst[data-effect="raid"]')).toHaveLength(1);
    renderer.dispose();
  });

  it("drains past queued gift subs disabled while a raid waits behind them", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    const firstRaid = fixture("raid", "raid-first");
    const giftOne = fixture("subgift", "gift-one");
    const giftTwo = fixture("subgift", "gift-two");
    const queuedRaid = fixture("raid", "raid-queued");
    effects.enqueue(firstRaid, { type: "raid", amount: 12 }, alias(firstRaid));
    effects.enqueue(giftOne, { type: "subgift", amount: 1 }, alias(giftOne));
    effects.enqueue(giftTwo, { type: "subgift", amount: 1 }, alias(giftTwo));
    effects.enqueue(queuedRaid, { type: "raid", amount: 8 }, alias(queuedRaid));
    effects.setTheme({ ...DEFAULTS, reactionSubgift: false });

    await vi.advanceTimersByTimeAsync(1_200);
    await settleEffects();

    expect(document.querySelectorAll('.reaction-burst[data-effect="raid"]')).toHaveLength(2);
    effects.dispose();
  });

  it.each([
    ["raid", "reactionRaid"],
    ["sub", "reactionSub"],
    ["resub", "reactionResub"],
    ["subgift", "reactionSubgift"],
    ["bits", "reactionBits"],
  ] as const)("does not animate when the %s type is disabled", async (type, field) => {
    vi.useFakeTimers();
    const effects = makeEffects({ ...DEFAULTS, [field]: false });
    const message = fixture(type, `disabled-${type}`);
    effects.enqueue(message, { type, amount: 1 }, alias(message));
    await settleEffects();

    expect(document.querySelectorAll(".reaction-burst, .reaction-rain")).toHaveLength(0);
    effects.dispose();
  });

  it("does not build reaction visuals when intensity is zero", async () => {
    vi.useFakeTimers();
    const effects = makeEffects({ ...DEFAULTS, reactionIntensity: 0 });
    const message = fixture("raid", "zero-intensity");
    effects.enqueue(message, { type: "raid", amount: 12 }, alias(message));
    await settleEffects();

    expect(document.querySelectorAll(".reaction-burst, .reaction-rain, .reaction-effect")).toHaveLength(0);
    effects.dispose();
  });

  it("uses a resolvable emote as rain art", async () => {
    vi.useFakeTimers();
    const emotes = {
      resolve: vi.fn(() => ({ name: "Kappa", url: "https://cdn.7tv.app/emote/kappa/2x.webp", provider: "test" })),
      add: vi.fn(), setChannelId: vi.fn(), setChannelIds: vi.fn(), dispose: vi.fn(),
    };
    const effects = createReactionEffects({
      root: document.createElement("main"), theme: DEFAULTS, emotes,
      fetcher: async () => Response.json(manifest),
    });
    const message = parseIrcLine("@id=emote;room-id=10;bits=100;emotes=25:0-4 :viewer!viewer@host PRIVMSG #room :Kappa") as CommonMessage;
    effects.enqueue(message, { type: "bits", amount: 100 }, alias(message));
    await settleEffects();

    expect(document.querySelector<HTMLImageElement>(".reaction-rain")?.getAttribute("src"))
      .toBe("https://cdn.7tv.app/emote/kappa/2x.webp");
    effects.dispose();
  });

  it("rejects a disallowed emote URL and uses only same-origin SVG rain", async () => {
    vi.useFakeTimers();
    const emotes = {
      resolve: vi.fn(() => ({ name: "Kappa", url: "https://evil.example/emote.png", provider: "test" })),
      add: vi.fn(), setChannelId: vi.fn(), setChannelIds: vi.fn(), dispose: vi.fn(),
    };
    const effects = createReactionEffects({
      root: document.createElement("main"), theme: DEFAULTS, emotes,
      fetcher: async () => Response.json(manifest),
    });
    const message = parseIrcLine("@id=emote;room-id=10;bits=100;emotes=25:0-4 :viewer!viewer@host PRIVMSG #room :Kappa") as CommonMessage;
    effects.enqueue(message, { type: "bits", amount: 100 }, alias(message));
    await settleEffects();

    const rain = [...document.querySelectorAll<HTMLImageElement>(".reaction-rain")];
    expect(rain).toHaveLength(5);
    expect(rain.every((image) => image.getAttribute("src")?.startsWith("/effects/rain-") && image.getAttribute("src")?.endsWith(".svg"))).toBe(true);
    expect(rain.some((image) => image.getAttribute("src")?.includes("evil.example"))).toBe(false);
    effects.dispose();
  });

  it("looks up Shared Chat rain emotes in the foreign source room", async () => {
    vi.useFakeTimers();
    const emotes = {
      resolve: vi.fn(() => ({ name: "Kappa", url: "https://cdn.7tv.app/emote/kappa/2x.webp", provider: "test" })),
      add: vi.fn(), setChannelId: vi.fn(), setChannelIds: vi.fn(), dispose: vi.fn(),
    };
    const effects = createReactionEffects({
      root: document.createElement("main"), theme: DEFAULTS, emotes,
      fetcher: async () => Response.json(manifest),
    });
    const message = parseIrcLine("@id=emote;room-id=10;source-room-id=20;bits=100;emotes=25:0-4 :viewer!viewer@host PRIVMSG #room :Kappa") as CommonMessage;
    effects.enqueue(message, { type: "bits", amount: 100 }, alias(message));
    await settleEffects();

    expect(emotes.resolve).toHaveBeenCalledWith("Kappa", "20");
    effects.dispose();
  });

  it("pauses active audio when sound is disabled", async () => {
    vi.useFakeTimers();
    const instances: Array<{ pause: ReturnType<typeof vi.fn> }> = [];
    class FakeAudio {
      volume = 0;
      pause = vi.fn();
      addEventListener(): void {}
      play = vi.fn().mockResolvedValue(undefined);
      constructor() { instances.push(this); }
    }
    class FakeURL extends URL {
      static createObjectURL(): string { return "blob:reaction-sound"; }
      static revokeObjectURL(): void {}
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", FakeURL);
    const fetcher = async (input: RequestInfo | URL) => String(input).endsWith("manifest.json")
      ? Response.json(manifest) : new Response(new Uint8Array([1]), { status: 200 });
    const effects = makeEffects({ ...DEFAULTS, reactionSoundEnabled: true }, fetcher as typeof fetch);
    const message = fixture("raid", "sound-off");
    effects.enqueue(message, { type: "raid", amount: 12 }, alias(message));
    await settleEffects();

    effects.setTheme({ ...DEFAULTS, reactionSoundEnabled: false });
    expect(instances).toHaveLength(1);
    expect(instances[0]!.pause).toHaveBeenCalledTimes(1);
    effects.dispose();
  });

  it.each(["clear", "dispose", "clearRoom", "clearUser"] as const)("pauses active audio on %s", async (action) => {
    vi.useFakeTimers();
    const instances: Array<{ pause: ReturnType<typeof vi.fn> }> = [];
    class FakeAudio {
      volume = 0;
      pause = vi.fn();
      addEventListener(): void {}
      play = vi.fn().mockResolvedValue(undefined);
      constructor() { instances.push(this); }
    }
    class FakeURL extends URL {
      static createObjectURL(): string { return "blob:reaction-sound"; }
      static revokeObjectURL(): void {}
    }
    vi.stubGlobal("Audio", FakeAudio);
    vi.stubGlobal("URL", FakeURL);
    const fetcher = async (input: RequestInfo | URL) => String(input).endsWith("manifest.json")
      ? Response.json(manifest) : new Response(new Uint8Array([1]), { status: 200 });
    const effects = makeEffects({ ...DEFAULTS, reactionSoundEnabled: true }, fetcher as typeof fetch);
    const message = fixture("raid", `sound-${action}`);
    effects.enqueue(message, { type: "raid", amount: 12 }, alias(message));
    await settleEffects();

    if (action === "clear") effects.clear();
    else if (action === "dispose") effects.dispose();
    else if (action === "clearRoom") effects.clearRoom("10");
    else effects.clearUser("10", null, "tmi.twitch.tv");

    expect(instances).toHaveLength(1);
    expect(instances[0]!.pause).toHaveBeenCalledTimes(1);
    effects.dispose();
  });

  it("clears all effect timers and removes the reaction layer on dispose", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    const first = fixture("raid", "dispose-active");
    const queued = fixture("sub", "dispose-queued");
    effects.enqueue(first, { type: "raid", amount: 12 }, alias(first));
    effects.enqueue(queued, { type: "sub", amount: null }, alias(queued));
    await settleEffects();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    expect(document.querySelector(".reaction-layer")).not.toBeNull();

    effects.dispose();

    expect(vi.getTimerCount()).toBe(0);
    expect(document.querySelector(".reaction-layer")).toBeNull();
  });

  it("clears active room and user effects at the effects level", async () => {
    vi.useFakeTimers();
    const effects = makeEffects();
    const roomMessage = fixture("raid", "room-clear");
    const roomLine = document.createElement("div");
    effects.attachLine(alias(roomMessage).key, roomLine);
    effects.enqueue(roomMessage, { type: "raid", amount: 12 }, alias(roomMessage));
    await settleEffects();
    expect(document.querySelectorAll(".reaction-burst")).toHaveLength(1);
    expect(roomLine.classList.contains("chat-reaction-highlight")).toBe(true);
    effects.clearRoom("10");
    expect(document.querySelectorAll(".reaction-burst")).toHaveLength(0);
    expect(roomLine.classList.contains("chat-reaction-highlight")).toBe(false);

    const userMessage = fixture("sub", "user-clear");
    const userLine = document.createElement("div");
    effects.attachLine(alias(userMessage).key, userLine);
    effects.enqueue(userMessage, { type: "sub", amount: null }, alias(userMessage));
    await vi.advanceTimersByTimeAsync(1_200);
    await settleEffects();
    expect(document.querySelectorAll(".reaction-burst")).toHaveLength(1);
    expect(userLine.classList.contains("chat-reaction-highlight")).toBe(true);
    effects.clearUser("10", null, "tmi.twitch.tv");
    expect(document.querySelectorAll(".reaction-burst")).toHaveLength(0);
    expect(userLine.classList.contains("chat-reaction-highlight")).toBe(false);
    effects.dispose();
  });
});
