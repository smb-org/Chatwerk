import { isAllowedImageUrl } from "../shared/hosts";
import type { IrcBadge } from "./irc-parse";

export interface BadgeImage {
  name: string;
  version: string;
  url: string;
}

export interface EmbeddedBadgeData {
  global: unknown;
  broadcasters: Record<string, unknown>;
}

export type BadgeSource =
  | { type: "route" }
  | { type: "embedded"; data: EmbeddedBadgeData };

export interface BadgeLookup {
  loadGlobal(): Promise<boolean>;
  loadBroadcaster(broadcasterId: string): Promise<boolean>;
  resolve(badges: IrcBadge[], broadcasterId: string | null, sample?: boolean): BadgeImage[];
  dispose(): void;
}

export interface BadgeLookupOptions {
  source: BadgeSource;
  sampleData?: EmbeddedBadgeData;
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

export function createBadgeLookup(options: BadgeLookupOptions): BadgeLookup {
  const fetcher = options.fetcher ?? fetch;
  const source = options.source;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const global = new Map<string, BadgeImage>();
  const broadcaster = new Map<string, Map<string, BadgeImage>>();
  const sampleGlobal = new Map<string, BadgeImage>();
  const sampleBroadcaster = new Map<string, Map<string, BadgeImage>>();
  const broadcasterLoadingData = new Map<string, Map<string, BadgeImage>>();
  const loading = new Map<string, Promise<boolean>>();
  const completed = new Set<string>();
  const retryAfter = new Map<string, number>();
  let disposed = false;

  const load = async (key: string, url: string, receive: (data: unknown) => boolean): Promise<boolean> => {
    if (disposed || completed.has(key) || (retryAfter.get(key) ?? 0) > Date.now()) return false;
    const existing = loading.get(key);
    if (existing) return existing.then(() => false);
    const task = (async () => {
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetcher(url, { signal: controller.signal, mode: "cors" });
          if (!response.ok) throw new Error(`Badge route returned ${response.status}`);
          const data = await response.json() as unknown;
          if (!Array.isArray(data) && !(isRecord(data) && Array.isArray(data.data))) throw new Error("Invalid badge payload");
          const populated = receive(data);
          completed.add(key);
          retryAfter.delete(key);
          return populated;
        } finally {
          clearTimeout(timer);
        }
      } catch {
        // Badge routes can be absent during rollout; an empty cache is a valid fallback.
        retryAfter.set(key, Date.now() + 60_000);
        return false;
      }
    })();
    loading.set(key, task);
    try {
      return await task;
    } finally {
      loading.delete(key);
    }
  };

  const readInto = (data: unknown, target: Map<string, BadgeImage>): boolean => {
    target.clear();
    const parsed = parseBadgeImages(data);
    for (const item of parsed) target.set(`${item.name}/${item.version}`, item);
    return parsed.length > 0;
  };

  if (source.type === "embedded") {
    readInto(source.data.global, global);
    for (const [id, value] of Object.entries(source.data.broadcasters)) {
      const entries = new Map<string, BadgeImage>();
      readInto(value, entries);
      broadcaster.set(id, entries);
    }
  }
  if (options.sampleData) {
    readInto(options.sampleData.global, sampleGlobal);
    for (const [id, value] of Object.entries(options.sampleData.broadcasters)) {
      const entries = new Map<string, BadgeImage>();
      readInto(value, entries);
      sampleBroadcaster.set(id, entries);
    }
  }

  return {
    async loadGlobal() {
      if (source.type === "embedded" || global.size > 0) return false;
      return load("global", "/api/twitch/badges/global", (data) => readInto(data, global));
    },
    async loadBroadcaster(id) {
      if (source.type === "embedded" || !/^\d+$/u.test(id) || broadcaster.has(id)) return false;
      if (broadcaster.size >= 64) broadcaster.delete(broadcaster.keys().next().value as string);
      const entries = broadcasterLoadingData.get(id) ?? new Map<string, BadgeImage>();
      broadcasterLoadingData.set(id, entries);
      const populated = await load(`broadcaster:${id}`, `/api/twitch/badges/${encodeURIComponent(id)}`, (data) => readInto(data, entries));
      if (!disposed && completed.has(`broadcaster:${id}`)) broadcaster.set(id, entries);
      broadcasterLoadingData.delete(id);
      return populated;
    },
    resolve(badges, broadcasterId, sample = false) {
      const channel = broadcasterId ? broadcaster.get(broadcasterId) : undefined;
      const sampleChannel = sample && broadcasterId ? sampleBroadcaster.get(broadcasterId) : undefined;
      return badges.flatMap((badge) => {
        const key = `${badge.name}/${badge.version}`;
        const item = sample
          ? sampleChannel?.get(key) ?? sampleGlobal.get(key)
          : channel?.get(key) ?? global.get(key);
        return item ? [item] : [];
      });
    },
    dispose() {
      disposed = true;
      global.clear();
      broadcaster.clear();
      sampleGlobal.clear();
      sampleBroadcaster.clear();
      broadcasterLoadingData.clear();
      loading.clear();
      completed.clear();
      retryAfter.clear();
    },
  };
}

export function parseBadgeImages(value: unknown): BadgeImage[] {
  const input = Array.isArray(value) ? value : isRecord(value) && Array.isArray(value.data) ? value.data : [];
  const result: BadgeImage[] = [];
  for (const rawSet of input) {
    if (!isRecord(rawSet) || typeof rawSet.set_id !== "string" || !Array.isArray(rawSet.versions)) continue;
    for (const rawVersion of rawSet.versions) {
      if (!isRecord(rawVersion) || typeof rawVersion.id !== "string") continue;
      const url = rawVersion.image_url_2x ?? rawVersion.image_url_1x;
      if (typeof url !== "string" || !isAllowedImageUrl(url)) continue;
      result.push({ name: rawSet.set_id, version: rawVersion.id, url });
    }
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
