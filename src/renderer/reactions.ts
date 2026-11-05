import type { ThemeConfig, ThemeFieldName } from "../shared/theme";
import { isAllowedImageUrl } from "../shared/hosts";
import type { CommonMessage, ParsedReactionEvent, ReactionType } from "./irc-parse";
import type { EmoteLookup } from "./emotes";

export const MAX_REACTION_ELEMENTS = 24;
export const MAX_QUEUED_REACTIONS = 8;
export const REACTION_COOLDOWN_MS = 1_200;
export const REACTION_DURATION_MS = 3_500;
const MAX_RAIN_EMOTES = 5;
const MAX_SEEN_SOURCE_IDS = 300;

export interface ReactionAlias {
  key: string;
  room: string;
  id: string | null;
}

export interface ReactionEffectsOptions {
  root: HTMLElement;
  theme: ThemeConfig;
  emotes?: EmoteLookup;
  fetcher?: typeof fetch;
}

export interface ReactionEffects {
  enqueue(event: CommonMessage, reaction: ParsedReactionEvent, alias: ReactionAlias): void;
  cancelAlias(aliasKey: string): void;
  clearRoom(room: string): void;
  clearUser(room: string, userId: string | null, userLogin: string | null): void;
  attachLine(aliasKey: string, line: HTMLElement): void;
  detachLine(aliasKey: string): void;
  setTheme(theme: ThemeConfig): void;
  clear(): void;
  dispose(): void;
}

type EffectKind = "raid" | "sub" | "bits";
interface EffectAsset {
  image: string;
  sound: string;
}
type EffectManifest = Record<EffectKind, EffectAsset>;

interface ReactionRequest {
  id: number;
  sourceId: string | null;
  event: CommonMessage;
  reaction: ParsedReactionEvent;
  aliases: Map<string, ReactionAlias>;
  pendingLineAliases: Set<string>;
  highlightedLines: Set<HTMLElement>;
  highlightTimers: Map<HTMLElement, ReturnType<typeof setTimeout>>;
  active: boolean;
  visualActive: boolean;
  timer: ReturnType<typeof setTimeout> | undefined;
  fallbackTimer: ReturnType<typeof setTimeout> | undefined;
  burst: HTMLElement | undefined;
  audio: HTMLAudioElement | undefined;
  objectUrl: string | undefined;
}

const DEFAULT_RAIN = [
  "/effects/rain-star.svg",
  "/effects/rain-heart.svg",
  "/effects/rain-spark.svg",
  "/effects/rain-diamond.svg",
  "/effects/rain-dot.svg",
];
const EFFECT_KINDS = ["raid", "sub", "bits"] as const;

export function createReactionEffects(options: ReactionEffectsOptions): ReactionEffects {
  const { root } = options;
  const document = root.ownerDocument;
  const fetcher = options.fetcher ?? fetch;
  const layer = document.createElement("div");
  layer.className = "reaction-layer";
  layer.setAttribute("aria-hidden", "true");
  document.body.appendChild(layer);

  let theme = options.theme;
  let nextId = 1;
  let nextAllowedAt = 0;
  let cooldownTimer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  const queue: ReactionRequest[] = [];
  const requests = new Set<ReactionRequest>();
  const requestByAlias = new Map<string, ReactionRequest>();
  const requestBySourceId = new Map<string, ReactionRequest>();
  const seenSourceIds = new Set<string>();
  const seenSourceOrder: string[] = [];
  const linesByAlias = new Map<string, HTMLElement>();
  const highlightCounts = new Map<HTMLElement, number>();
  const soundBlobs = new Map<string, Promise<Blob | null>>();
  const manifestPromise = loadManifest(fetcher);

  const attachHighlight = (request: ReactionRequest, line: HTMLElement): void => {
    if (request.highlightedLines.has(line)) return;
    request.highlightedLines.add(line);
    highlightCounts.set(line, (highlightCounts.get(line) ?? 0) + 1);
    line.classList.add("chat-reaction-highlight");
  };

  const detachHighlight = (request: ReactionRequest, line: HTMLElement): void => {
    if (!request.highlightedLines.delete(line)) return;
    const count = (highlightCounts.get(line) ?? 1) - 1;
    if (count > 0) highlightCounts.set(line, count);
    else {
      highlightCounts.delete(line);
      line.classList.remove("chat-reaction-highlight");
    }
  };

  const stopSound = (request: ReactionRequest): void => {
    try { request.audio?.pause(); } catch { /* Ignore media shutdown failures. */ }
    request.audio = undefined;
    if (request.objectUrl) {
      URL.revokeObjectURL(request.objectUrl);
      request.objectUrl = undefined;
    }
  };

  const dropRequest = (request: ReactionRequest): void => {
    const queuedAt = queue.indexOf(request);
    if (queuedAt >= 0) queue.splice(queuedAt, 1);
    if (request.timer !== undefined) clearTimeout(request.timer);
    request.timer = undefined;
    if (request.fallbackTimer !== undefined) clearTimeout(request.fallbackTimer);
    request.fallbackTimer = undefined;
    for (const timer of request.highlightTimers.values()) clearTimeout(timer);
    request.highlightTimers.clear();
    request.active = false;
    request.visualActive = false;
    stopSound(request);
    request.burst?.remove();
    request.burst = undefined;
    for (const line of [...request.highlightedLines]) detachHighlight(request, line);
    for (const key of request.aliases.keys()) {
      if (requestByAlias.get(key) === request) requestByAlias.delete(key);
    }
    request.aliases.clear();
    if (request.sourceId && requestBySourceId.get(request.sourceId) === request) requestBySourceId.delete(request.sourceId);
    requests.delete(request);
  };

  const finishRequestIfIdle = (request: ReactionRequest): void => {
    if (!request.active || request.visualActive || request.pendingLineAliases.size > 0 || request.highlightTimers.size > 0) return;
    dropRequest(request);
  };

  const syncFallbackTimer = (request: ReactionRequest): void => {
    if (request.pendingLineAliases.size === 0) {
      if (request.fallbackTimer !== undefined) clearTimeout(request.fallbackTimer);
      request.fallbackTimer = undefined;
      return;
    }
    if (request.fallbackTimer !== undefined) return;
    request.fallbackTimer = setTimeout(() => {
      request.fallbackTimer = undefined;
      dropRequest(request);
      drainQueue();
    }, Math.max(0, theme.lifetime));
  };

  const armHighlight = (request: ReactionRequest, line: HTMLElement): void => {
    if (!request.active || request.highlightTimers.has(line)) return;
    attachHighlight(request, line);
    const timer = setTimeout(() => {
      request.highlightTimers.delete(line);
      detachHighlight(request, line);
      finishRequestIfIdle(request);
    }, REACTION_DURATION_MS);
    request.highlightTimers.set(line, timer);
  };

  const expireRequest = (request: ReactionRequest): void => {
    if (!request.active || !request.visualActive) return;
    request.timer = undefined;
    request.visualActive = false;
    request.burst?.remove();
    request.burst = undefined;
    stopSound(request);
    finishRequestIfIdle(request);
    drainQueue();
  };

  const playSound = async (request: ReactionRequest, manifest: EffectManifest): Promise<void> => {
    if (!theme.reactionSoundEnabled || theme.reactionVolume <= 0 || disposed) return;
    const path = manifest[effectKind(request.reaction.type)].sound;
    const blob = await getSoundBlob(path);
    if (!blob || !request.active || !request.visualActive || disposed || !theme.reactionSoundEnabled || theme.reactionVolume <= 0) return;
    let objectUrl: string | undefined;
    try {
      objectUrl = URL.createObjectURL(blob);
      const audio = new Audio(objectUrl);
      request.objectUrl = objectUrl;
      request.audio = audio;
      audio.volume = Math.max(0, Math.min(1, theme.reactionVolume));
      const release = (): void => {
        if (request.objectUrl !== objectUrl) return;
        request.objectUrl = undefined;
        request.audio = undefined;
        URL.revokeObjectURL(objectUrl!);
      };
      audio.addEventListener("ended", release, { once: true });
      void audio.play().catch(release);
    } catch {
      if (request.objectUrl === objectUrl) stopSound(request);
      else if (objectUrl) URL.revokeObjectURL(objectUrl);
    }
  };

  const makeRainItems = (event: CommonMessage): string[] => {
    const items: string[] = [];
    const foreignRoom = Boolean(event.sourceRoomId && event.roomId && event.sourceRoomId !== event.roomId);
    const channelId = foreignRoom ? event.sourceRoomId ?? undefined : event.roomId ?? undefined;
    for (const emote of event.emotes) {
      for (const range of emote.ranges) {
        const name = event.text.slice(range.start, range.end + 1);
        const asset = options.emotes?.resolve(name, channelId);
        if (!asset || !isAllowedImageUrl(asset.url)) continue;
        items.push(asset.url);
        if (items.length >= MAX_RAIN_EMOTES) return items;
      }
    }
    if (items.length > 0) return items;
    return DEFAULT_RAIN.slice(0, MAX_RAIN_EMOTES);
  };

  const addVisuals = (request: ReactionRequest, manifest: EffectManifest): void => {
    if (!request.active || !request.visualActive || disposed || theme.motion === "none" || theme.reactionIntensity <= 0) return;
    const kind = effectKind(request.reaction.type);
    const items = makeRainItems(request.event);
    const size = 2 + items.length;
    if (layer.querySelectorAll("*").length + size > MAX_REACTION_ELEMENTS) return;

    const burst = document.createElement("div");
    burst.className = "reaction-burst";
    burst.dataset.eventType = request.reaction.type;
    burst.dataset.effect = kind;
    burst.style.setProperty("--reaction-intensity", String(theme.reactionIntensity));
    const image = document.createElement("img");
    image.className = "reaction-effect";
    image.src = manifest[kind].image;
    image.alt = "";
    image.decoding = "async";
    burst.appendChild(image);

    items.forEach((item, index) => {
      const rain = document.createElement("img");
      rain.className = "reaction-rain";
      rain.setAttribute("aria-hidden", "true");
      rain.style.setProperty("--reaction-x", `${8 + (index * 19) % 84}%`);
      rain.style.setProperty("--reaction-delay", `${index * 0.08}s`);
      rain.src = item;
      rain.alt = "";
      rain.decoding = "async";
      burst.appendChild(rain);
    });
    layer.appendChild(burst);
    request.burst = burst;
  };

  const startRequest = (request: ReactionRequest): void => {
    if (!request.aliases.size || !isEnabled(theme, request.reaction.type)) {
      dropRequest(request);
      drainQueue();
      return;
    }
    request.active = true;
    request.visualActive = true;
    nextAllowedAt = Date.now() + REACTION_COOLDOWN_MS;
    for (const key of request.aliases.keys()) {
      const line = linesByAlias.get(key);
      if (line) {
        request.pendingLineAliases.delete(key);
        armHighlight(request, line);
      }
    }
    syncFallbackTimer(request);
    request.timer = setTimeout(() => expireRequest(request), REACTION_DURATION_MS);
    void manifestPromise.then((manifest) => {
      if (!manifest || !request.active || !request.visualActive || disposed) return;
      addVisuals(request, manifest);
      void playSound(request, manifest);
    });
    scheduleDrain();
  };

  function scheduleDrain(): void {
    if (cooldownTimer !== undefined || queue.length === 0 || disposed) return;
    const delay = Math.max(0, nextAllowedAt - Date.now());
    cooldownTimer = setTimeout(() => {
      cooldownTimer = undefined;
      drainQueue();
    }, delay);
  }

  function drainQueue(): void {
    if (disposed || queue.length === 0 || cooldownTimer !== undefined) return;
    if (Date.now() < nextAllowedAt) {
      scheduleDrain();
      return;
    }
    const next = queue.shift();
    if (next) startRequest(next);
  }

  async function getSoundBlob(path: string): Promise<Blob | null> {
    let pending = soundBlobs.get(path);
    if (!pending) {
      pending = fetcher(path, { cache: "force-cache" })
        .then((response) => response.ok ? response.blob() : null)
        .catch(() => null);
      soundBlobs.set(path, pending);
    }
    return pending;
  }

  function addAlias(request: ReactionRequest, alias: ReactionAlias): void {
    if (request.aliases.has(alias.key)) return;
    request.aliases.set(alias.key, alias);
    request.pendingLineAliases.add(alias.key);
    requestByAlias.set(alias.key, request);
    const line = linesByAlias.get(alias.key);
    if (line) {
      request.pendingLineAliases.delete(alias.key);
      if (request.active) armHighlight(request, line);
    }
    syncFallbackTimer(request);
  }

  function cancelAlias(aliasKey: string): void {
    const request = requestByAlias.get(aliasKey);
    if (!request) return;
    request.aliases.delete(aliasKey);
    requestByAlias.delete(aliasKey);
    request.pendingLineAliases.delete(aliasKey);
    const line = linesByAlias.get(aliasKey);
    if (line && ![...request.aliases.keys()].some((key) => linesByAlias.get(key) === line)) {
      const timer = request.highlightTimers.get(line);
      if (timer !== undefined) clearTimeout(timer);
      request.highlightTimers.delete(line);
      detachHighlight(request, line);
    }
    if (request.aliases.size === 0) {
      dropRequest(request);
      drainQueue();
    } else {
      syncFallbackTimer(request);
      finishRequestIfIdle(request);
    }
  }

  return {
    enqueue(event, reaction, alias) {
      if (disposed || !isEnabled(theme, reaction.type)) return;
      const sourceId = event.sourceId && event.sourceId.length <= 256 ? event.sourceId : null;
      if (sourceId && seenSourceIds.has(sourceId)) {
        const existing = requestBySourceId.get(sourceId);
        if (existing) addAlias(existing, alias);
        return;
      }
      if (sourceId) {
        seenSourceIds.add(sourceId);
        seenSourceOrder.push(sourceId);
        while (seenSourceOrder.length > MAX_SEEN_SOURCE_IDS) {
          const oldest = seenSourceOrder.shift();
          if (oldest) seenSourceIds.delete(oldest);
        }
      }
      const request: ReactionRequest = {
        id: nextId++,
        sourceId,
        event,
        reaction,
        aliases: new Map(),
        pendingLineAliases: new Set(),
        highlightedLines: new Set(),
        highlightTimers: new Map(),
        active: false,
        visualActive: false,
        timer: undefined,
        fallbackTimer: undefined,
        burst: undefined,
        audio: undefined,
        objectUrl: undefined,
      };
      addAlias(request, alias);
      requests.add(request);
      if (sourceId) requestBySourceId.set(sourceId, request);
      queue.push(request);
      if (queue.length > MAX_QUEUED_REACTIONS) dropRequest(queue[0]!);
      drainQueue();
    },
    cancelAlias,
    clearRoom(room) {
      for (const request of [...requests]) {
        for (const alias of [...request.aliases.values()]) {
          if (alias.room === room) cancelAlias(alias.key);
        }
      }
    },
    clearUser(room, userId, userLogin) {
      for (const request of [...requests]) {
        const sameUser = userId ? request.event.tags["user-id"] === userId
          : Boolean(userLogin && request.event.userLogin?.toLowerCase() === userLogin.toLowerCase());
        if (!sameUser) continue;
        for (const alias of [...request.aliases.values()]) {
          if (alias.room === room) cancelAlias(alias.key);
        }
      }
    },
    attachLine(aliasKey, line) {
      linesByAlias.set(aliasKey, line);
      const request = requestByAlias.get(aliasKey);
      if (request) {
        request.pendingLineAliases.delete(aliasKey);
        if (request.active) armHighlight(request, line);
        syncFallbackTimer(request);
        finishRequestIfIdle(request);
      }
    },
    detachLine(aliasKey) {
      const line = linesByAlias.get(aliasKey);
      linesByAlias.delete(aliasKey);
      const request = requestByAlias.get(aliasKey);
      if (!line || !request) return;
      if (![...request.aliases.keys()].some((key) => linesByAlias.get(key) === line)) {
        const timer = request.highlightTimers.get(line);
        if (timer !== undefined) clearTimeout(timer);
        request.highlightTimers.delete(line);
        detachHighlight(request, line);
        request.pendingLineAliases.add(aliasKey);
        syncFallbackTimer(request);
        finishRequestIfIdle(request);
      }
    },
    setTheme(nextTheme) {
      const soundDisabled = !nextTheme.reactionSoundEnabled || nextTheme.reactionVolume <= 0;
      theme = nextTheme;
      if (soundDisabled) for (const request of requests) stopSound(request);
      if (theme.motion === "none" || theme.reactionIntensity <= 0) {
        layer.replaceChildren();
        for (const request of requests) request.burst = undefined;
      }
      else {
        for (const request of requests) request.burst?.style.setProperty("--reaction-intensity", String(theme.reactionIntensity));
      }
    },
    clear() {
      if (cooldownTimer !== undefined) clearTimeout(cooldownTimer);
      cooldownTimer = undefined;
      queue.length = 0;
      for (const request of [...requests]) dropRequest(request);
      layer.replaceChildren();
      seenSourceIds.clear();
      seenSourceOrder.length = 0;
      nextAllowedAt = 0;
    },
    dispose() {
      if (disposed) return;
      this.clear();
      disposed = true;
      layer.remove();
      soundBlobs.clear();
    },
  };
}

function isEnabled(theme: ThemeConfig, type: ReactionType): boolean {
  const fieldName = `reaction${type[0]!.toUpperCase()}${type.slice(1)}` as ThemeFieldName;
  return Boolean(theme[fieldName]);
}

function effectKind(type: ReactionType): EffectKind {
  return type === "raid" ? "raid" : type === "bits" ? "bits" : "sub";
}

async function loadManifest(fetcher: typeof fetch): Promise<EffectManifest | null> {
  try {
    const response = await fetcher("/effects/manifest.json", { cache: "force-cache" });
    if (!response.ok) return null;
    const raw: unknown = await response.json();
    if (!isRecord(raw)) return null;
    const manifest = {} as EffectManifest;
    for (const kind of EFFECT_KINDS) {
      const asset = raw[kind];
      if (!isRecord(asset) || !isEffectPath(asset.image, /\.(?:svg|png|webp)$/u) ||
        !isEffectPath(asset.sound, /\.(?:mp3|ogg|wav)$/u)) return null;
      manifest[kind] = { image: asset.image, sound: asset.sound };
    }
    return manifest;
  } catch {
    return null;
  }
}

function isEffectPath(value: unknown, extension: RegExp): value is string {
  return typeof value === "string" && /^\/effects\/[a-z0-9-]+\.[a-z0-9]+$/u.test(value) && extension.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
