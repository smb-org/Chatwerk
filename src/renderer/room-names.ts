export interface RoomNameLookup {
  lookup(roomId: string): Promise<RoomNameDetails | null>;
}

export interface RoomNameDetails {
  displayName: string;
  logo: string | null;
}

export interface RoomNameLookupOptions {
  fetcher?: typeof fetch;
  timeoutMs?: number;
  failureTtlMs?: number;
}

const DEFAULT_TIMEOUT_MS = 2_000;
const DEFAULT_FAILURE_TTL_MS = 60_000;
const ROOM_ID_PATTERN = /^\d{1,25}$/u;
const LOGIN_PATTERN = /^[a-z0-9_]{1,25}$/iu;
const DISPLAY_NAME_PATTERN = /^[\p{L}\p{N}_]{1,25}$/u;

interface CachedRoomName {
  details: RoomNameDetails | null;
  expiresAt: number | null;
}

interface LookupResult {
  details: RoomNameDetails | null;
  retryable: boolean;
}

/** Resolve Twitch room IDs to display names and retain both results and brief failure cooldowns. */
export function createRoomNameLookup(options: RoomNameLookupOptions = {}): RoomNameLookup {
  const fetcher = options.fetcher ?? fetch;
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const failureTtlMs = Math.max(1, options.failureTtlMs ?? DEFAULT_FAILURE_TTL_MS);
  const cache = new Map<string, CachedRoomName>();
  const inFlight = new Map<string, Promise<RoomNameDetails | null>>();

  const lookup = (roomId: string): Promise<RoomNameDetails | null> => {
    if (!ROOM_ID_PATTERN.test(roomId)) return Promise.resolve(null);
    const cached = cache.get(roomId);
    if (cached && (cached.expiresAt === null || cached.expiresAt > Date.now())) {
      return Promise.resolve(cached.details);
    }
    if (cached) cache.delete(roomId);
    const existing = inFlight.get(roomId);
    if (existing) return existing;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<LookupResult>((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve({ details: null, retryable: true });
      }, timeoutMs);
    });
    const request = fetcher(
      `https://api.ivr.fi/v2/twitch/user?id=${encodeURIComponent(roomId)}`,
      { mode: "cors", signal: controller.signal },
    ).then(async (response): Promise<LookupResult> => {
      if (response.status === 404) return { details: null, retryable: false };
      if (!response.ok) return { details: null, retryable: true };
      try {
        return { details: readRoomDetails(await response.json()), retryable: false };
      } catch {
        return { details: null, retryable: false };
      }
    }).catch((): LookupResult => ({ details: null, retryable: true }));
    const pending = Promise.race([request, timedOut]).then(({ details, retryable }) => {
      cache.set(roomId, { details, expiresAt: retryable ? Date.now() + failureTtlMs : null });
      return details;
    }).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
      inFlight.delete(roomId);
    });
    inFlight.set(roomId, pending);
    return pending;
  };

  return { lookup };
}

export const roomNameLookup = createRoomNameLookup();

function readRoomDetails(payload: unknown): RoomNameDetails | null {
  if (!Array.isArray(payload) || payload.length === 0) return null;
  const user = payload[0];
  if (!isRecord(user) || typeof user.login !== "string" || !LOGIN_PATTERN.test(user.login)) return null;
  const displayName = user.displayName;
  if (typeof displayName !== "string" || !DISPLAY_NAME_PATTERN.test(displayName)) {
    return null;
  }
  return { displayName, logo: typeof user.logo === "string" ? user.logo : null };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
