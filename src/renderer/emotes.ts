import type { IrcEmote } from "./irc-parse";
import { createSevenTvEventApi, type SevenTvEvent, type SevenTvEventApi } from "./seventv-events";

export interface EmoteAsset {
  name: string;
  url: string;
  provider: string;
  zeroWidth?: boolean;
}

export interface EmoteProvider {
  name: string;
  loadGlobal(onUpdate: (assets: EmoteAsset[]) => void, signal?: AbortSignal): Promise<EmoteAsset[]>;
  loadChannel?(channelId: string, onUpdate: (assets: EmoteAsset[]) => void, signal?: AbortSignal): Promise<EmoteAsset[]>;
  dispose?(): void;
}

export interface EmoteLookup {
  resolve(name: string): EmoteAsset | undefined;
  add(assets: EmoteAsset[]): void;
  setChannelId(channelId: string): void;
  dispose(): void;
}

export interface EmoteLookupOptions {
  providers?: EmoteProvider[];
  fetcher?: typeof fetch;
  eventApi?: SevenTvEventApi;
  timeoutMs?: number;
}

export type MessagePart =
  | { type: "text"; value: string }
  | { type: "emote"; name: string; url: string; zeroWidth: boolean; overlays?: Array<{ name: string; url: string }> };

interface IndexedPart {
  start: number;
  end: number;
  part: MessagePart;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const FIRST_RETRY_MS = 15_000;
const MAX_RETRY_MS = 5 * 60_000;
const JITTER_MIN = 0.8;
const JITTER_RANGE = 0.4;

interface ScopeTask {
  cancelled: boolean;
  controller?: AbortController;
  timeout?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  stopped: Promise<never>;
  stop: () => void;
}

export function createEmoteLookup(options: EmoteLookupOptions = {}): EmoteLookup {
  const events = options.eventApi ?? createSevenTvEventApi();
  const ownsEvents = options.eventApi === undefined;
  const providers = options.providers ?? createDefaultProviders(options.fetcher ?? fetch, events);
  const timeoutMs = Math.max(DEFAULT_TIMEOUT_MS, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const scopes = new Map<string, Map<string, EmoteAsset>>();
  const tasks = new Map<string, ScopeTask>();
  const providerNames = providers.map((provider) => provider.name.trim().toUpperCase());
  let channelId = "";
  let disposed = false;

  const replace = (scope: string, assets: EmoteAsset[]): void => {
    const next = new Map<string, EmoteAsset>();
    for (const item of assets) {
      if (item.name && typeof item.name === "string" && typeof item.url === "string") next.set(item.name, item);
    }
    scopes.set(scope, next);
  };

  const run = async (
    provider: EmoteProvider,
    scope: string,
    load: (onUpdate: (assets: EmoteAsset[]) => void, signal: AbortSignal) => Promise<EmoteAsset[]>,
    isCurrent: () => boolean = () => true,
  ): Promise<void> => {
    cancelTask(scope);
    let stop!: () => void;
    const stopped = new Promise<never>((_resolve, reject) => {
      stop = () => reject(new Error("Emote provider scope stopped"));
    });
    const task: ScopeTask = { cancelled: false, stopped, stop };
    tasks.set(scope, task);
    const update = (assets: EmoteAsset[]): void => {
      if (!disposed && !task.cancelled && isCurrent()) replace(scope, assets);
    };
    try {
      let failures = 0;
      while (!disposed && !task.cancelled && isCurrent()) {
        const controller = new AbortController();
        task.controller = controller;
        let rejectTimeout!: (error: Error) => void;
        const timeout = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
        task.timeout = setTimeout(() => {
          controller.abort();
          rejectTimeout(new Error(`${provider.name} emote provider timed out`));
        }, timeoutMs);
        try {
          const assets = await Promise.race([load(update, controller.signal), timeout, stopped]);
          update(assets);
          return;
        } catch (error) {
          if (task.timeout !== undefined) clearTimeout(task.timeout);
          task.timeout = undefined;
          if (task.controller === controller) task.controller = undefined;
          if (disposed || task.cancelled || !isCurrent()) return;
          const status = requestStatus(error);
          if (status === 404 && scope.endsWith(":channel")) {
            update([]);
            return;
          }
          if (status !== undefined && status >= 400 && status < 500 && status !== 408 && status !== 429) return;
          const retryAfter = status === 429 ? retryAfterMs(error) : undefined;
          await waitForRetry(task, retryAfter ?? retryDelay(failures++));
        } finally {
          if (task.timeout !== undefined) clearTimeout(task.timeout);
          task.timeout = undefined;
          if (task.controller === controller) task.controller = undefined;
        }
      }
    } catch {
      // Disposing or changing channels stops only the affected provider scope.
    } finally {
      if (tasks.get(scope) === task) tasks.delete(scope);
    }
  };

  function cancelTask(scope: string): void {
    const task = tasks.get(scope);
    if (!task || task.cancelled) return;
    task.cancelled = true;
    if (task.timeout !== undefined) clearTimeout(task.timeout);
    if (task.retryTimer !== undefined) clearTimeout(task.retryTimer);
    task.controller?.abort();
    task.stop();
  }

  function waitForRetry(task: ScopeTask, delay: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      task.retryTimer = setTimeout(resolve, delay);
      void task.stopped.catch(reject);
    }).finally(() => {
      if (task.retryTimer !== undefined) clearTimeout(task.retryTimer);
      task.retryTimer = undefined;
    });
  }

  const startGlobal = (): void => {
    const tasks = providers.map((provider) => run(provider, `${scopeProviderName(provider)}:global`, (update, signal) => provider.loadGlobal(update, signal)));
    void Promise.allSettled(tasks);
  };

  const setChannelId = (id: string): void => {
    if (!/^\d+$/u.test(id) || channelId === id || disposed) return;
    for (const scope of tasks.keys()) {
      if (scope.endsWith(":channel")) cancelTask(scope);
    }
    for (const provider of providers) scopes.delete(`${scopeProviderName(provider)}:channel`);
    channelId = id;
    const taskPromises = providers.flatMap((provider) => provider.loadChannel
      ? [run(provider, `${scopeProviderName(provider)}:channel`, (update, signal) => provider.loadChannel!(id, update, signal), () => channelId === id)]
      : []);
    void Promise.allSettled(taskPromises);
  };

  startGlobal();
  return {
    resolve(name) {
      const manual = scopes.get("manual")?.get(name);
      if (manual) return manual;
      for (const scopeKind of ["channel", "global"]) {
        for (const provider of ["7TV", "BTTV", "FFZ"]) {
          if (!providerNames.includes(provider)) continue;
          const scope = `${provider}:${scopeKind}`;
          const match = scopes.get(scope)?.get(name);
          if (match) return match;
        }
        for (const provider of providerNames) {
          if (["7TV", "BTTV", "FFZ"].includes(provider)) continue;
          const scope = `${provider}:${scopeKind}`;
          const match = scopes.get(scope)?.get(name);
          if (match) return match;
        }
      }
      return undefined;
    },
    add(assets) {
      if (disposed) return;
      replace("manual", [...(scopes.get("manual")?.values() ?? []), ...assets]);
    },
    setChannelId,
    dispose() {
      disposed = true;
      for (const scope of [...tasks.keys()]) cancelTask(scope);
      for (const provider of providers) provider.dispose?.();
      scopes.clear();
      if (ownsEvents) events.dispose();
    },
  };
}

function scopeProviderName(provider: EmoteProvider): string {
  return provider.name.trim().toUpperCase();
}

function retryDelay(failures: number): number {
  const nominal = Math.min(MAX_RETRY_MS, FIRST_RETRY_MS * (2 ** failures));
  return Math.min(MAX_RETRY_MS, Math.floor(nominal * (JITTER_MIN + Math.random() * JITTER_RANGE)));
}

function requestStatus(error: unknown): number | undefined {
  return error instanceof ProviderHttpError ? error.status : undefined;
}

function retryAfterMs(error: unknown): number | undefined {
  return error instanceof ProviderHttpError ? error.retryAfterMs : undefined;
}

class ProviderHttpError extends Error {
  constructor(readonly status: number, readonly retryAfterMs: number | undefined) {
    super(`Emote provider returned ${status}`);
  }
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.ceil(seconds * 1_000);
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return undefined;
  return Math.max(0, date - Date.now());
}

export function splitMessage(
  text: string,
  twitchEmotes: IrcEmote[],
  lookup?: Pick<EmoteLookup, "resolve">,
  includeProviderEmotes = true,
): MessagePart[] {
  const indexed: IndexedPart[] = [];
  const codePointToUtf16: number[] = [];
  let utf16Offset = 0;
  for (const codePoint of text) {
    codePointToUtf16.push(utf16Offset);
    utf16Offset += codePoint.length;
  }
  codePointToUtf16.push(utf16Offset);
  for (const emote of twitchEmotes) {
    for (const range of emote.ranges) {
      if (!Number.isInteger(range.start) || !Number.isInteger(range.end) || range.start < 0 ||
        range.end < range.start || range.end + 1 >= codePointToUtf16.length) continue;
      const start = codePointToUtf16[range.start]!;
      const end = codePointToUtf16[range.end + 1]!;
      const name = text.slice(start, end);
      indexed.push({
        start,
        end,
        part: {
          type: "emote",
          name,
          url: `https://static-cdn.jtvnw.net/emoticons/v2/${encodeURIComponent(emote.id)}/default/dark/2.0`,
          zeroWidth: false,
        },
      });
    }
  }
  indexed.sort((first, second) => first.start - second.start || second.end - first.end);
  const selected: IndexedPart[] = [];
  for (const item of indexed) {
    if (selected.length && item.start < selected[selected.length - 1]!.end) continue;
    selected.push(item);
  }

  if (includeProviderEmotes && lookup) {
    for (const match of text.matchAll(/\S+/gu)) {
      const token = match[0];
      const tokenStart = match.index;
      const exact = lookup.resolve(token);
      let startOffset = 0;
      let endOffset = token.length;
      let asset = exact;
      if (!asset) {
        while (startOffset < endOffset && !isWordCharacter(token[startOffset]!)) startOffset += 1;
        while (endOffset > startOffset && !isWordCharacter(token[endOffset - 1]!)) endOffset -= 1;
        if (endOffset > startOffset) asset = lookup.resolve(token.slice(startOffset, endOffset));
      }
      if (!asset) {
        let splitEmotes = false;
        for (let split = 1; split < token.length; split += 1) {
          const base = lookup.resolve(token.slice(0, split));
          const overlay = lookup.resolve(token.slice(split));
          if (!base || !overlay?.zeroWidth) continue;
          selected.push({
            start: tokenStart,
            end: tokenStart + split,
            part: { type: "emote", name: token.slice(0, split), url: base.url, zeroWidth: base.zeroWidth ?? false },
          });
          selected.push({
            start: tokenStart + split,
            end: tokenStart + token.length,
            part: { type: "emote", name: token.slice(split), url: overlay.url, zeroWidth: true },
          });
          asset = base;
          splitEmotes = true;
          break;
        }
        if (splitEmotes) continue;
      }
      if (!asset) continue;
      const start = tokenStart + startOffset;
      const end = tokenStart + endOffset;
      if (selected.some((item) => start < item.end && end > item.start)) continue;
      selected.push({ start, end, part: { type: "emote", name: token.slice(startOffset, endOffset), url: asset.url, zeroWidth: asset.zeroWidth ?? false } });
    }
  }

  selected.sort((first, second) => first.start - second.start || first.end - second.end);
  const parts: MessagePart[] = [];
  let cursor = 0;
  for (let index = 0; index < selected.length; index += 1) {
    const item = selected[index]!;
    if (item.start > cursor) pushText(parts, text.slice(cursor, item.start));
    if (item.start >= cursor) {
      const previous = parts[parts.length - 1];
      if (item.part.type === "emote" && item.part.zeroWidth && previous?.type === "emote") {
        previous.overlays = [...(previous.overlays ?? []), { name: item.part.name, url: item.part.url }];
      } else if (item.part.type === "emote" && item.part.zeroWidth) {
        parts.push({ ...item.part, zeroWidth: false });
      } else {
        parts.push(item.part);
      }
      cursor = item.end;
    }
  }
  if (cursor < text.length) pushText(parts, text.slice(cursor));
  if (parts.length === 0 && text.length > 0) parts.push({ type: "text", value: text });
  return parts;
}

function isWordCharacter(character: string): boolean {
  return /[\p{L}\p{N}_]/u.test(character);
}

function pushText(parts: MessagePart[], value: string): void {
  if (!value) return;
  const previous = parts[parts.length - 1];
  if (previous?.type === "text") previous.value += value;
  else parts.push({ type: "text", value });
}

function createDefaultProviders(fetcher: typeof fetch, events: SevenTvEventApi): EmoteProvider[] {
  return [
    createSevenTvProvider(fetcher, events),
    createBttvProvider(fetcher),
    createFfzProvider(fetcher),
  ];
}

function createSevenTvProvider(fetcher: typeof fetch, events: SevenTvEventApi): EmoteProvider {
  const setSubscriptions = new Map<string, {
    assets: EmoteAsset[];
    updates: Set<(assets: EmoteAsset[]) => void>;
    unsubscribe: () => void;
  }>();
  const cleanups = new Set<() => void>();
  const refreshSet = (setId: string, update: (assets: EmoteAsset[]) => void, cached: EmoteAsset[]): (() => void) => {
    if (!setId) {
      update(cached);
      return () => undefined;
    }
    let state = setSubscriptions.get(setId);
    if (!state) {
      state = { assets: cached, updates: new Set(), unsubscribe: () => undefined };
      state.unsubscribe = events.subscribe("emote_set.update", { object_id: setId }, (event) => {
        const emotes = readEmotesFromEvent(event);
        if (emotes) {
          state!.assets = emotes;
          for (const receive of state!.updates) receive(emotes);
        } else void fetchJson(fetcher, `https://7tv.io/v3/emote-sets/${encodeURIComponent(setId)}`)
          .then(readSevenTvSet)
          .then((assets) => {
            state!.assets = assets;
            for (const receive of state!.updates) receive(assets);
          })
          .catch(() => undefined);
      });
      setSubscriptions.set(setId, state);
    }
    const isNew = !state.updates.has(update);
    state.updates.add(update);
    update(state.assets.length > 0 ? state.assets : cached);
    if (!isNew) return () => undefined;
    return () => {
      const current = setSubscriptions.get(setId);
      current?.updates.delete(update);
      if (current?.updates.size === 0) {
        current.unsubscribe();
        setSubscriptions.delete(setId);
      }
    };
  };
  const channelData = new Map<string, { setId: string; userId: string }>();
  const channelSetCleanups = new Map<string, () => void>();
  const channelUpdates = new Map<string, (assets: EmoteAsset[]) => void>();
  let disposed = false;
  const refreshChannel = async (channelId: string, update: (assets: EmoteAsset[]) => void, signal?: AbortSignal): Promise<EmoteAsset[]> => {
    const connection = await fetchJson(fetcher, `https://7tv.io/v3/users/twitch/${encodeURIComponent(channelId)}`, signal);
    if (disposed) return [];
    channelUpdates.set(channelId, update);
    const set = isRecord(connection) ? connection.emote_set : null;
    const user = isRecord(connection) ? connection.user : null;
    const assets = readSevenTvSet(set);
    if (isRecord(set) && typeof set.id === "string") {
      const previous = channelData.get(channelId);
      if (previous?.setId !== set.id) {
        const previousCleanup = channelSetCleanups.get(channelId);
        if (previousCleanup) {
          previousCleanup();
          channelSetCleanups.delete(channelId);
          cleanups.delete(previousCleanup);
        }
      }
      channelData.set(channelId, { setId: set.id, userId: isRecord(user) && typeof user.id === "string" ? user.id : "" });
      if (!channelSetCleanups.has(channelId)) {
        const cleanup = refreshSet(set.id, update, assets);
        channelSetCleanups.set(channelId, cleanup);
        cleanups.add(cleanup);
      }
    } else {
      const previousCleanup = channelSetCleanups.get(channelId);
      if (previousCleanup) {
        previousCleanup();
        channelSetCleanups.delete(channelId);
        cleanups.delete(previousCleanup);
      }
      channelData.delete(channelId);
      update(assets);
    }
    return assets;
  };

  const stopReconnect = events.onReconnect(() => {
    for (const [setId, state] of setSubscriptions) {
      void fetchJson(fetcher, `https://7tv.io/v3/emote-sets/${encodeURIComponent(setId)}`)
        .then(readSevenTvSet)
        .then((assets) => {
          state.assets = assets;
          for (const update of state.updates) update(assets);
        })
        .catch(() => undefined);
    }
    for (const [id, update] of channelUpdates) void refreshChannel(id, update).catch(() => undefined);
  });
  cleanups.add(stopReconnect);

  return {
    name: "7TV",
    async loadGlobal(update, signal) {
      const globalSet = await fetchJson(fetcher, "https://7tv.io/v3/emote-sets/global", signal);
      if (disposed) return [];
      const assets = readSevenTvSet(globalSet);
      if (isRecord(globalSet) && typeof globalSet.id === "string") cleanups.add(refreshSet(globalSet.id, update, assets));
      return assets;
    },
    async loadChannel(channelId, update, signal) {
      const assets = await refreshChannel(channelId, update, signal);
      return assets;
    },
    dispose() {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      cleanups.clear();
      for (const subscription of setSubscriptions.values()) subscription.unsubscribe();
      setSubscriptions.clear();
      channelData.clear();
      channelSetCleanups.clear();
      channelUpdates.clear();
    },
  };
}

function createBttvProvider(fetcher: typeof fetch): EmoteProvider {
  return {
    name: "BTTV",
    async loadGlobal(_onUpdate, signal) {
      const data = await fetchJson(fetcher, "https://api.betterttv.net/3/cached/emotes/global", signal);
      return readBttvEmotes(data);
    },
    async loadChannel(channelId, _onUpdate, signal) {
      const data = await fetchJson(fetcher, `https://api.betterttv.net/3/cached/users/twitch/${encodeURIComponent(channelId)}`, signal);
      if (!isRecord(data)) return [];
      return [...readBttvEmotes(data.channelEmotes), ...readBttvEmotes(data.sharedEmotes)];
    },
  };
}

function createFfzProvider(fetcher: typeof fetch): EmoteProvider {
  return {
    name: "FFZ",
    async loadGlobal(_onUpdate, signal) {
      const data = await fetchJson(fetcher, "https://api.frankerfacez.com/v1/set/global", signal);
      if (!isRecord(data) || !isRecord(data.sets)) return [];
      const defaults = Array.isArray(data.default_sets) ? new Set(data.default_sets.map(String)) : new Set(Object.keys(data.sets));
      return Object.entries(data.sets).filter(([id]) => defaults.has(id)).flatMap(([, set]) => readFfzSet(set));
    },
    async loadChannel(channelId, _onUpdate, signal) {
      const data = await fetchJson(fetcher, `https://api.frankerfacez.com/v1/room/id/${encodeURIComponent(channelId)}`, signal);
      if (!isRecord(data) || !isRecord(data.sets)) return [];
      return Object.values(data.sets).flatMap(readFfzSet);
    },
  };
}

function readSevenTvSet(value: unknown): EmoteAsset[] {
  const set = isRecord(value) ? value : {};
  if (!Array.isArray(set.emotes)) return [];
  return set.emotes.flatMap((item) => {
    const emote = isRecord(item) ? item : {};
    const data = isRecord(emote.data) ? emote.data : emote;
    const id = stringField(emote, "id") ?? stringField(data, "id");
    const name = stringField(emote, "name") ?? stringField(data, "name");
    if (!id || !name) return [];
    const url = `https://cdn.7tv.app/emote/${encodeURIComponent(id)}/2x.webp`;
    const flags = typeof emote.flags === "number" ? emote.flags : typeof data.flags === "number" ? data.flags : 0;
    return [{ name, url, provider: "7TV", zeroWidth: (flags & 1) !== 0 }];
  });
}

function readEmotesFromEvent(event: SevenTvEvent): EmoteAsset[] | null {
  const set = readObject(event.body.object) ?? readObject(event.body.emote_set) ?? readChangedSet(event.body) ?? event.body;
  if (!Array.isArray(set.emotes)) return null;
  return readSevenTvSet(set);
}

function readChangedSet(body: Record<string, unknown>): Record<string, unknown> | null {
  for (const key of ["added", "updated", "pushed", "pulled", "removed"]) {
    const changes = Array.isArray(body[key]) ? body[key] : [];
    for (const change of changes) {
      if (!isRecord(change) || change.key !== "emotes") continue;
      if (Array.isArray(change.value)) return { id: body.id, emotes: change.value };
    }
  }
  return null;
}

function readBttvEmotes(value: unknown): EmoteAsset[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const emote = isRecord(item) ? item : {};
    const id = stringField(emote, "id");
    const name = stringField(emote, "code");
    if (!id || !name) return [];
    return [{ name, url: `https://cdn.betterttv.net/emote/${encodeURIComponent(id)}/2x.webp`, provider: "BTTV" }];
  });
}

function readFfzSet(value: unknown): EmoteAsset[] {
  const set = isRecord(value) ? value : {};
  if (!Array.isArray(set.emoticons)) return [];
  return set.emoticons.flatMap((item) => {
    const emote = isRecord(item) ? item : {};
    const name = stringField(emote, "name");
    const id = typeof emote.id === "number" || typeof emote.id === "string" ? String(emote.id) : "";
    const urls = isRecord(emote.urls) ? emote.urls : {};
    let url = stringField(urls, "2") ?? stringField(urls, "1") ?? "";
    if (url.startsWith("//")) url = `https:${url}`;
    if (!name || (!url && !id)) return [];
    if (!url) url = `https://cdn.frankerfacez.com/emoticon/${encodeURIComponent(id)}/2`;
    return [{ name, url, provider: "FFZ" }];
  });
}

function readObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function stringField(value: Record<string, unknown> | null, field: string): string | null {
  const result = value?.[field];
  return typeof result === "string" ? result : null;
}

async function fetchJson(fetcher: typeof fetch, url: string, signal?: AbortSignal): Promise<unknown> {
  const response = await fetcher(url, { signal, mode: "cors" });
  if (!response.ok) throw new ProviderHttpError(response.status, parseRetryAfter(response.headers.get("retry-after")));
  return response.json() as Promise<unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
