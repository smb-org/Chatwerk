import { isAllowedImageUrl } from "../shared/hosts";

export type ThirdPartyBadgeProvider = "badgesBttv" | "badgesFfz" | "badgesChatterino";

export interface ThirdPartyBadgeImage {
  provider: ThirdPartyBadgeProvider;
  name: string;
  url: string;
}

export interface ThirdPartyBadgeLookup {
  setEnabled(provider: ThirdPartyBadgeProvider, enabled: boolean): void;
  load(twitchUserId: string): Promise<void>;
  resolve(twitchUserId: string): ThirdPartyBadgeImage[];
  subscribe(listener: (twitchUserId: string) => void): () => void;
  dispose(): void;
}

export interface ThirdPartyBadgeLookupOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
}

const SOURCE_URLS: Record<ThirdPartyBadgeProvider, string> = {
  badgesBttv: "https://api.betterttv.net/3/cached/badges/twitch",
  badgesFfz: "https://api.frankerfacez.com/v1/badges/ids",
  badgesChatterino: "https://api.chatterino.com/badges",
};

const EXPECTED_IMAGE_HOSTS: Record<ThirdPartyBadgeProvider, string> = {
  badgesBttv: "cdn.betterttv.net",
  badgesFfz: "cdn.frankerfacez.com",
  badgesChatterino: "fourtf.com",
};

const PROVIDERS = Object.keys(SOURCE_URLS) as ThirdPartyBadgeProvider[];
const MAX_USER_CACHE = 500;
const DEFAULT_TIMEOUT_MS = 4_000;

export function createThirdPartyBadgeLookup(options: ThirdPartyBadgeLookupOptions = {}): ThirdPartyBadgeLookup {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const enabled = new Map<ThirdPartyBadgeProvider, boolean>(PROVIDERS.map((provider) => [provider, false]));
  const sourceData = new Map<ThirdPartyBadgeProvider, Map<string, ThirdPartyBadgeImage[]>>();
  const sourceTasks = new Map<ThirdPartyBadgeProvider, Promise<void>>();
  const sourceFinished = new Set<ThirdPartyBadgeProvider>();
  const sourceRetryAfter = new Map<ThirdPartyBadgeProvider, number>();
  const controllers = new Map<ThirdPartyBadgeProvider, AbortController>();
  const userTasks = new Map<string, Promise<void>>();
  const requestedUsers = new Set<string>();
  const listeners = new Set<(twitchUserId: string) => void>();
  const resolvedCache = new Map<string, ThirdPartyBadgeImage[]>();
  let disposed = false;

  const notify = (userId: string): void => {
    resolvedCache.delete(userId);
    for (const listener of listeners) listener(userId);
  };

  const loadSource = (provider: ThirdPartyBadgeProvider): Promise<void> => {
    if (disposed || !enabled.get(provider) || sourceFinished.has(provider) || (sourceRetryAfter.get(provider) ?? 0) > Date.now()) return Promise.resolve();
    const current = sourceTasks.get(provider);
    if (current) {
      if (controllers.get(provider)?.signal.reason === "disabled") return current.then(() => loadSource(provider));
      return current;
    }
    const controller = new AbortController();
    controllers.set(provider, controller);
    const timer = setTimeout(() => controller.abort("timeout"), timeoutMs);
    const task = (async (): Promise<void> => {
      let parsed = new Map<string, ThirdPartyBadgeImage[]>();
      let succeeded = false;
      try {
        const response = await fetcher(SOURCE_URLS[provider], { mode: "cors", signal: controller.signal });
        if (!response.ok) throw new Error("Badge source unavailable");
        parsed = parseSource(provider, await response.json() as unknown);
        succeeded = true;
      } catch {
        // Each source is optional. Keep its failure isolated from message rendering and other sources.
        if (controller.signal.reason !== "disabled") sourceRetryAfter.set(provider, Date.now() + 60_000);
      } finally {
        clearTimeout(timer);
        controllers.delete(provider);
        sourceTasks.delete(provider);
      }
      if (!disposed && enabled.get(provider)) {
        if (succeeded) {
          sourceFinished.add(provider);
          sourceRetryAfter.delete(provider);
          sourceData.set(provider, parsed);
        }
        for (const userId of requestedUsers) notify(userId);
      }
    })();
    sourceTasks.set(provider, task);
    return task;
  };

  return {
    setEnabled(provider, nextEnabled) {
      if (disposed || enabled.get(provider) === nextEnabled) return;
      enabled.set(provider, nextEnabled);
      if (!nextEnabled) {
        controllers.get(provider)?.abort("disabled");
        for (const userId of requestedUsers) userTasks.delete(userId);
      }
      for (const userId of requestedUsers) notify(userId);
    },
    load(twitchUserId) {
      if (disposed || !/^\d+$/u.test(twitchUserId) || !PROVIDERS.some((provider) => enabled.get(provider))) {
        return Promise.resolve();
      }
      requestedUsers.delete(twitchUserId);
      requestedUsers.add(twitchUserId);
      while (requestedUsers.size > MAX_USER_CACHE) requestedUsers.delete(requestedUsers.values().next().value as string);
      const current = userTasks.get(twitchUserId);
      if (current) return current;
      const task = Promise.all(PROVIDERS.map((provider) => loadSource(provider))).then(() => undefined).finally(() => {
        userTasks.delete(twitchUserId);
      });
      userTasks.set(twitchUserId, task);
      return task;
    },
    resolve(twitchUserId) {
      const cached = resolvedCache.get(twitchUserId);
      if (cached) return [...cached];
      const result = PROVIDERS.flatMap((provider) => {
        if (!enabled.get(provider)) return [];
        return sourceData.get(provider)?.get(twitchUserId) ?? [];
      });
      resolvedCache.set(twitchUserId, result);
      if (resolvedCache.size > MAX_USER_CACHE) resolvedCache.delete(resolvedCache.keys().next().value as string);
      return [...result];
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose() {
      disposed = true;
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
      sourceTasks.clear();
      sourceRetryAfter.clear();
      sourceData.clear();
      userTasks.clear();
      requestedUsers.clear();
      resolvedCache.clear();
      listeners.clear();
    },
  };
}

function parseSource(provider: ThirdPartyBadgeProvider, value: unknown): Map<string, ThirdPartyBadgeImage[]> {
  if (provider === "badgesBttv") return parseBttv(value);
  if (provider === "badgesFfz") return parseFfz(value);
  return parseChatterino(value);
}

function parseBttv(value: unknown): Map<string, ThirdPartyBadgeImage[]> {
  const result = new Map<string, ThirdPartyBadgeImage[]>();
  if (!Array.isArray(value)) return result;
  for (const badge of value) {
    if (!isRecord(badge) || !isTwitchId(badge.providerId) || !isRecord(badge.badge)) continue;
    const name = nonEmptyString(badge.displayName) ?? nonEmptyString(badge.name);
    const url = expectedImageUrl(badge.badge.svg, "badgesBttv");
    if (!name || !url) continue;
    addBadge(result, badge.providerId, { provider: "badgesBttv", name, url });
  }
  return result;
}

function parseFfz(value: unknown): Map<string, ThirdPartyBadgeImage[]> {
  const result = new Map<string, ThirdPartyBadgeImage[]>();
  if (!isRecord(value) || !Array.isArray(value.badges) || !isRecord(value.users)) return result;
  const definitions = new Map<string, ThirdPartyBadgeImage>();
  for (const badge of value.badges) {
    if (!isRecord(badge)) continue;
    const id = String(badge.id ?? "");
    const name = nonEmptyString(badge.name);
    const urls = isRecord(badge.urls) ? badge.urls : {};
    const url = expectedImageUrl(urls["2"] ?? urls["1"] ?? badge.image, "badgesFfz");
    if (id && name && url) definitions.set(id, { provider: "badgesFfz", name, url });
  }
  for (const [badgeId, rawUserIds] of Object.entries(value.users)) {
    const badge = definitions.get(badgeId);
    if (!badge) continue;
    const userIds = Array.isArray(rawUserIds) ? rawUserIds : [rawUserIds];
    for (const rawUserId of userIds) {
      const userId = typeof rawUserId === "number" && Number.isSafeInteger(rawUserId)
        ? String(rawUserId)
        : typeof rawUserId === "string" ? rawUserId : "";
      if (isTwitchId(userId)) addBadge(result, userId, badge);
    }
  }
  return result;
}

function parseChatterino(value: unknown): Map<string, ThirdPartyBadgeImage[]> {
  const result = new Map<string, ThirdPartyBadgeImage[]>();
  if (!isRecord(value) || !Array.isArray(value.badges)) return result;
  for (const badge of value.badges) {
    if (!isRecord(badge) || !Array.isArray(badge.users)) continue;
    const name = nonEmptyString(badge.tooltip);
    const url = expectedImageUrl(badge.image3 ?? badge.image2 ?? badge.image1, "badgesChatterino");
    if (!name || !url) continue;
    for (const rawUserId of badge.users) {
      const userId = typeof rawUserId === "number" && Number.isSafeInteger(rawUserId)
        ? String(rawUserId)
        : typeof rawUserId === "string" ? rawUserId : "";
      if (isTwitchId(userId)) addBadge(result, userId, { provider: "badgesChatterino", name, url });
    }
  }
  return result;
}

function addBadge(target: Map<string, ThirdPartyBadgeImage[]>, userId: string, badge: ThirdPartyBadgeImage): void {
  const badges = target.get(userId) ?? [];
  badges.push(badge);
  target.set(userId, badges);
}

function expectedImageUrl(value: unknown, provider: ThirdPartyBadgeProvider): string | null {
  if (!isAllowedImageUrl(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === EXPECTED_IMAGE_HOSTS[provider] ? url.href : null;
  } catch {
    return null;
  }
}

function isTwitchId(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/u.test(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim().slice(0, 100) : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
