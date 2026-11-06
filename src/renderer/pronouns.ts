const CACHE_KEY = "chatwerk-pronouns-v1";
const CACHE_TTL_MS = 24 * 60 * 60 * 1_000;

interface CachedPronoun {
  value: string | null;
  expiresAt: number;
}

interface PronounLookupOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  requestIntervalMs?: number;
  queueLimit?: number;
  cacheLimit?: number;
  now?: () => number;
  storage?: Pick<Storage, "getItem" | "setItem"> | null;
}

class PronounProviderHttpError extends Error {
  constructor(readonly status: number) {
    super(`Pronoun provider returned ${status}`);
  }
}

export interface PronounLookup {
  lookup(login: string): Promise<string | null>;
  dispose(): void;
}

export function createPronounLookup(options: PronounLookupOptions = {}): PronounLookup {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = options.timeoutMs ?? 5_000;
  const requestIntervalMs = Math.max(100, options.requestIntervalMs ?? 200);
  const queueLimit = Math.max(1, options.queueLimit ?? 20);
  const cacheLimit = Math.max(1, options.cacheLimit ?? 500);
  const now = options.now ?? Date.now;
  const storage = options.storage === undefined ? getLocalStorage() : options.storage;
  const cache = new Map<string, CachedPronoun>();
  const queue = new Map<string, (value: string | null) => void>();
  const pending = new Map<string, Promise<string | null>>();
  const controllers = new Set<AbortController>();
  let labelsPromise: Promise<Map<string, string>> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let nextRequestAt = 0;
  let disposed = false;

  loadCache();

  const saveCache = (): void => {
    try {
      storage?.setItem(CACHE_KEY, JSON.stringify([...cache.entries()]));
    } catch {
      // localStorage is optional, notably in opaque widget frames.
    }
  };

  const cacheValue = (login: string, value: string | null): void => {
    cache.delete(login);
    cache.set(login, { value, expiresAt: now() + CACHE_TTL_MS });
    while (cache.size > cacheLimit) cache.delete(cache.keys().next().value as string);
    saveCache();
  };

  const fetchJson = async (url: string): Promise<unknown> => {
    const controller = new AbortController();
    controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetcher(url, { signal: controller.signal, mode: "cors" });
      if (!response.ok) throw new PronounProviderHttpError(response.status);
      return await response.json() as unknown;
    } finally {
      clearTimeout(timeout);
      controllers.delete(controller);
    }
  };

  const getLabels = (): Promise<Map<string, string>> => {
    if (!labelsPromise) {
      labelsPromise = fetchJson("https://api.pronouns.alejo.io/v1/pronouns").then((value) => {
        const labels = new Map<string, string>();
        if (isRecord(value)) {
          for (const [name, item] of Object.entries(value)) {
            if (isRecord(item) && item.name === name && typeof item.subject === "string" &&
              typeof item.object === "string" && typeof item.singular === "boolean") {
              // Joining both fields preserves the provider's former display labels (including Any/Any).
              labels.set(name, `${item.subject}/${item.object}`);
            }
          }
        }
        return labels;
      }).catch((error: unknown) => {
        labelsPromise = undefined;
        throw error;
      });
    }
    return labelsPromise;
  };

  const fetchPronoun = async (login: string): Promise<string | null> => {
    let user: unknown;
    try {
      user = await fetchJson(`https://api.pronouns.alejo.io/v1/users/${encodeURIComponent(login)}`);
    } catch (error) {
      if (error instanceof PronounProviderHttpError && error.status === 404) return null;
      throw error;
    }
    if (!isRecord(user) || typeof user.channel_id !== "string" || typeof user.channel_login !== "string" ||
      user.channel_login.toLowerCase() !== login || typeof user.pronoun_id !== "string") return null;
    const labels = await getLabels();
    return labels.get(user.pronoun_id) ?? null;
  };

  const drain = (): void => {
    if (disposed || queue.size === 0 || timer !== undefined) return;
    const delay = Math.max(0, nextRequestAt - now());
    timer = setTimeout(() => {
      timer = undefined;
      const next = queue.entries().next().value as [string, (value: string | null) => void] | undefined;
      if (!next) return;
      const [login, resolve] = next;
      queue.delete(login);
      nextRequestAt = now() + requestIntervalMs;
      void fetchPronoun(login).then((value) => {
        cacheValue(login, value);
        resolve(value);
      }).catch(() => {
        resolve(null);
      }).finally(() => {
        pending.delete(login);
        drain();
      });
    }, delay);
  };

  const lookup = (rawLogin: string): Promise<string | null> => {
    const login = rawLogin.trim().toLowerCase();
    if (disposed || !/^[a-z0-9_]{1,25}$/u.test(login)) return Promise.resolve(null);
    const cached = cache.get(login);
    if (cached && cached.expiresAt > now()) return Promise.resolve(cached.value);
    if (cached) cache.delete(login);
    const previous = pending.get(login);
    if (previous) return previous;
    if (queue.size >= queueLimit) return Promise.resolve(null);
    const promise = new Promise<string | null>((resolve) => {
      queue.set(login, resolve);
      drain();
    });
    pending.set(login, promise);
    return promise;
  };

  function loadCache(): void {
    try {
      const raw = storage?.getItem(CACHE_KEY);
      if (!raw) return;
      const entries: unknown = JSON.parse(raw);
      if (!Array.isArray(entries)) return;
      for (const entry of entries) {
        if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isRecord(entry[1]) ||
          typeof entry[1].expiresAt !== "number" || (entry[1].value !== null && typeof entry[1].value !== "string")) continue;
        const [login, item] = entry as [string, CachedPronoun];
        if (/^[a-z0-9_]{1,25}$/u.test(login) && item.expiresAt > now()) cache.set(login, item);
      }
      while (cache.size > cacheLimit) cache.delete(cache.keys().next().value as string);
    } catch {
      // Invalid or unavailable storage does not disable pronouns for this page.
    }
  }

  return {
    lookup,
    dispose() {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      for (const controller of controllers) controller.abort();
      controllers.clear();
      for (const resolve of queue.values()) resolve(null);
      queue.clear();
      pending.clear();
      cache.clear();
    },
  };
}

function getLocalStorage(): Pick<Storage, "getItem" | "setItem"> | null {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
