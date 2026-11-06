import { DEFAULTS, SCHEMA_VERSION, type ThemeConfig } from "../shared/theme";
import { decideConfigUpdate, type ChatStatus, type OverlayClientType } from "../shared/protocol";
import { BUILD_ID } from "../shared/build-id";
import { isValidChannel } from "./irc";

export const LIVE_CACHE_KEY = "chatwerk-theme";
export const TEST_LINE_TEXT = "Test line. Your chat appears here.";
export const LIVE_PING_INTERVAL_MS = 20_000;

export interface LiveLocation {
  token: string | null;
  client: OverlayClientType;
  placement: "origin" | "viewport";
  channel: string | null;
}

export interface LiveState {
  revision: number;
  config: ThemeConfig;
}

export interface LiveCache {
  state: LiveState;
  channel: string | null;
}

export interface LiveStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface LiveSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: "open", listener: () => void, options?: AddEventListenerOptions): void;
  addEventListener(type: "message", listener: (event: MessageEvent) => void, options?: AddEventListenerOptions): void;
  addEventListener(type: "close", listener: (event: CloseEvent) => void, options?: AddEventListenerOptions): void;
}

export interface LiveOptions {
  hash: string;
  origin: string;
  userAgent: string;
  fetcher?: typeof fetch;
  socketFactory?: (url: string, protocols: string[]) => LiveSocket;
  storage?: LiveStorage;
  applyTheme(theme: ThemeConfig): void;
  onChannel?(channel: string): void;
  onTestLine?(id: string, onExpire?: () => void): void | (() => void);
  onRevoked?(): void;
  onMessage?(message: Record<string, unknown>): void;
  getChatStatus?(): ChatStatus;
  visibilityTarget?: Pick<Document, "visibilityState" | "addEventListener" | "removeEventListener">;
  registerServiceWorker?: boolean;
  deferUncachedTheme?: boolean;
  random?: () => number;
}

export interface LiveHandle {
  stop(): void;
  acknowledge(): void;
  getState(): LiveState;
}

const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const clients: readonly OverlayClientType[] = ["browser", "obs", "widget", "studio"];

export function parseLiveLocation(hash: string, userAgent: string): LiveLocation {
  const params = new URLSearchParams(hash.replace(/^#/u, ""));
  const rawToken = params.get("token");
  const rawClient = params.get("client");
  const client = isClient(rawClient)
    ? rawClient
    : /OBS\//iu.test(userAgent) ? "obs" : "browser";
  const rawChannel = params.get("channel");
  return {
    token: rawToken && tokenPattern.test(rawToken) ? rawToken : null,
    client,
    placement: params.get("placement") === "origin" ? "origin" : "viewport",
    channel: rawChannel && isValidChannel(rawChannel) ? rawChannel.replace(/^#/u, "").toLowerCase() : null,
  };
}

export function applyConfigRevision(
  current: LiveState,
  incoming: unknown,
): { status: "applied" | "unchanged" | "update-required" | "invalid"; state: LiveState } {
  if (!isRecord(incoming) || !Number.isSafeInteger(incoming.revision) || (incoming.revision as number) <= current.revision) {
    return { status: "unchanged", state: current };
  }
  if (!isRecord(incoming.config)) return { status: "invalid", state: current };
  const schemaVersion = typeof incoming.schemaVersion === "number"
    ? incoming.schemaVersion
    : incoming.config.schemaVersion;
  const decision = decideConfigUpdate(current.config, { ...incoming.config, schemaVersion });
  if (decision.status === "update-required") return { status: "update-required", state: current };
  if (decision.status !== "applied") return { status: "invalid", state: current };
  return {
    status: "applied",
    state: { revision: incoming.revision as number, config: decision.config },
  };
}

export function nextReconnectDelayMs(attempt: number, random: () => number = Math.random, maximumDelayMs = 30_000): number {
  const ceiling = Math.max(1, Math.min(300_000, maximumDelayMs));
  const exponent = Math.min(30, Math.max(0, Math.trunc(attempt)));
  const base = Math.min(ceiling, 1_000 * 2 ** exponent);
  const sample = Math.max(0, Math.min(1, random()));
  const jitter = Math.floor(sample * Math.min(1_000, base * 0.25));
  return Math.min(ceiling, base + jitter);
}

export function readLiveCache(storage?: LiveStorage, token?: string | null): LiveCache {
  const empty: LiveCache = { state: { revision: -1, config: DEFAULTS }, channel: null };
  if (!storage || !token) return empty;
  try {
    const raw = storage.getItem(`${LIVE_CACHE_KEY}:${token}`);
    if (!raw) return empty;
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return empty;
    const envelope = isRecord(parsed.config);
    const configValue = envelope ? parsed.config : parsed;
    const decision = decideConfigUpdate(DEFAULTS, configValue);
    if (decision.status !== "applied") return empty;
    const revision = envelope && Number.isSafeInteger(parsed.revision) && (parsed.revision as number) >= 0
      ? parsed.revision as number
      : -1;
    const channel = typeof parsed.channel === "string" && isValidChannel(parsed.channel)
      ? parsed.channel.toLowerCase().replace(/^#/u, "")
      : null;
    return { state: { revision, config: decision.config }, channel };
  } catch {
    return empty;
  }
}

export function showTestLine(root: HTMLElement, id: string, onExpire?: () => void): () => void {
  const line = root.ownerDocument.createElement("div");
  line.setAttribute("class", "chat-line chat-system");
  line.dataset.testId = id;
  line.textContent = TEST_LINE_TEXT;
  line.style.setProperty("font-family", "var(--t-font-family)");
  line.style.setProperty("font-size", "var(--t-font-size)");
  line.style.setProperty("font-weight", "var(--t-font-weight)");
  line.style.setProperty("gap", "var(--t-spacing)");
  line.style.setProperty("background-color", "var(--t-row-background)");
  line.style.setProperty("color", "var(--t-text-color)");
  line.style.setProperty("-webkit-text-stroke-width", "var(--t-outline)");
  line.style.setProperty("-webkit-text-stroke-color", "var(--t-outline-color)");
  if (root.dataset.lineOrder === "message-first") root.insertBefore(line, root.firstChild);
  else root.appendChild(line);
  const timer = setTimeout(() => {
    line.remove();
    onExpire?.();
  }, 5_000);
  return () => {
    clearTimeout(timer);
    line.remove();
  };
}

export function startLiveUpdates(options: LiveOptions): LiveHandle {
  const location = parseLiveLocation(options.hash, options.userAgent);
  const storage = options.storage ?? safeLocalStorage();
  const fetcher = options.fetcher ?? fetch;
  const socketFactory = options.socketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
  const random = options.random ?? Math.random;
  const cacheKey = location.token ? `${LIVE_CACHE_KEY}:${location.token}` : undefined;
  const cached = readLiveCache(storage, location.token);
  let state = cached.state;
  let channel = location.channel ?? cached.channel;
  let stopped = false;
  let revoked = false;
  let socket: LiveSocket | undefined;
  let retryAttempt = 0;
  let failedUpgrades = 0;
  let limitHit = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let configRetryAttempt = 0;
  let configRetryTimer: ReturnType<typeof setTimeout> | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  const testLineCleanups = new Map<string, () => void>();
  const visibilityTarget = options.visibilityTarget ?? getDocument();

  if (!options.deferUncachedTheme || !location.token || state.revision >= 0) options.applyTheme(state.config);
  if (channel) options.onChannel?.(channel);
  registerServiceWorker(options, location);

  const getChatStatus = (): ChatStatus => options.getChatStatus?.() ?? "idle";
  const saveCache = (): void => {
    if (!storage || !cacheKey || stopped || revoked) return;
    try {
      storage.setItem(cacheKey, JSON.stringify({ revision: state.revision, config: state.config, channel }));
    } catch {
      // Storage is an optional warm-start cache, including in sandboxed widgets.
    }
  };
  const clearCache = (): void => {
    try { if (cacheKey) storage?.removeItem(cacheKey); } catch { /* storage may be blocked */ }
  };
  const clearConfigRetry = (): void => {
    if (configRetryTimer !== undefined) clearTimeout(configRetryTimer);
    configRetryTimer = undefined;
  };
  const scheduleConfigRetry = (status?: number): void => {
    if (stopped || revoked || channel || configRetryTimer !== undefined) return;
    const delay = status === 429 ? 300_000 : nextReconnectDelayMs(configRetryAttempt, random, 300_000);
    configRetryAttempt += 1;
    configRetryTimer = setTimeout(() => {
      configRetryTimer = undefined;
      void fetchConfig();
    }, delay);
  };
  const acknowledge = (testId?: string): void => {
    if (stopped || revoked || !socket || socket.readyState !== 1 || state.revision < 0) return;
    const message: Record<string, unknown> = {
      type: "ack", revision: state.revision, chatStatus: getChatStatus(), buildId: BUILD_ID,
    };
    if (testId) message.testId = testId;
    try { socket.send(JSON.stringify(message)); } catch { /* reconnect will send the latest acknowledgement */ }
  };
  const applyIncoming = (incoming: unknown): void => {
    if (stopped || revoked) return;
    const result = applyConfigRevision(state, incoming);
    if (result.status === "applied") {
      state = result.state;
      options.applyTheme(state.config);
      saveCache();
    }
    acknowledge();
  };
  const updateChannel = (value: unknown): void => {
    if (stopped || revoked || channel || typeof value !== "string" || !isValidChannel(value)) return;
    channel = value.toLowerCase().replace(/^#/u, "");
    clearConfigRetry();
    options.onChannel?.(channel);
    saveCache();
  };
  const fetchConfig = async (): Promise<number | undefined> => {
    if (!location.token || stopped || revoked) return undefined;
    try {
      const response = await fetcher(new URL("/api/overlay/config", options.origin).toString(), {
        headers: { Authorization: `Bearer ${location.token}` },
      });
      if (stopped || revoked) return response.status;
      if (!response.ok) {
        scheduleConfigRetry(response.status);
        return response.status;
      }
      const incoming: unknown = await response.json();
      if (stopped || revoked) return response.status;
      if (!isRecord(incoming)) {
        scheduleConfigRetry();
        return response.status;
      }
      applyIncoming(incoming);
      updateChannel(incoming.channel);
      scheduleConfigRetry();
      return response.status;
    } catch {
      // Keep the current revision, config, and chat running during API failures.
      scheduleConfigRetry();
      return undefined;
    }
  };
  const ping = (): void => {
    if (!socket || socket.readyState !== 1) return;
    try { socket.send("ping"); } catch { /* next reconnect establishes a fresh heartbeat */ }
  };
  const onVisibility = (): void => {
    if (visibilityTarget?.visibilityState === "visible") ping();
  };
  const clearHeartbeat = (): void => {
    if (pingTimer !== undefined) clearInterval(pingTimer);
    pingTimer = undefined;
  };
  const startHeartbeat = (): void => {
    clearHeartbeat();
    pingTimer = setInterval(ping, LIVE_PING_INTERVAL_MS);
  };
  const scheduleReconnect = (): void => {
    if (stopped || revoked || reconnectTimer !== undefined) return;
    const delay = nextReconnectDelayMs(retryAttempt, random, limitHit ? 300_000 : 30_000);
    retryAttempt += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void (async () => {
        if (!limitHit && await fetchConfig() === 429) limitHit = true;
        connect();
      })();
    }, delay);
  };
  const failedUpgrade = (): void => {
    failedUpgrades += 1;
    if (failedUpgrades >= 2) limitHit = true;
    if (limitHit) {
      scheduleReconnect();
      return;
    }
    void fetchConfig().then((status) => {
      if (status === 429) limitHit = true;
      scheduleReconnect();
    });
  };
  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    clearConfigRetry();
    clearHeartbeat();
    visibilityTarget?.removeEventListener("visibilitychange", onVisibility);
    for (const cleanup of testLineCleanups.values()) cleanup();
    testLineCleanups.clear();
    const current = socket;
    socket = undefined;
    if (current && current.readyState < 2) {
      try { current.close(1000, "page_closed"); } catch { /* already closing */ }
    }
  };
  const handleRevocation = (): void => {
    if (revoked || stopped) return;
    revoked = true;
    clearCache();
    for (const cleanup of testLineCleanups.values()) cleanup();
    testLineCleanups.clear();
    const current = socket;
    socket = undefined;
    if (current && current.readyState < 2) {
      try { current.close(1000, "revoked"); } catch { /* already closing */ }
    }
    clearHeartbeat();
    visibilityTarget?.removeEventListener("visibilitychange", onVisibility);
    if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
    reconnectTimer = undefined;
    clearConfigRetry();
    options.onRevoked?.();
  };
  const onSocketMessage = (event: MessageEvent): void => {
    if (stopped || revoked) return;
    if (typeof event.data !== "string") return;
    let message: unknown;
    try { message = JSON.parse(event.data) as unknown; } catch { return; }
    if (!isRecord(message) || typeof message.type !== "string") return;
    if (message.type === "config") {
      applyIncoming(message);
      updateChannel(message.channel);
      return;
    }
    if (message.type === "test-line" && typeof message.id === "string") {
      const testId = message.id;
      const cleanup = options.onTestLine?.(testId, () => testLineCleanups.delete(testId));
      if (cleanup) testLineCleanups.set(testId, cleanup);
      acknowledge(testId);
      return;
    }
    options.onMessage?.(message);
  };
  function connect(): void {
    if (stopped || revoked || !location.token) return;
    const url = new URL("/api/overlay/live", options.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    let nextSocket: LiveSocket;
    try {
      nextSocket = socketFactory(url.toString(), ["chatwerk-live", location.token]);
    } catch {
      failedUpgrade();
      return;
    }
    socket = nextSocket;
    let connectedAt: number | undefined;
    nextSocket.addEventListener("open", () => {
      if (socket !== nextSocket || stopped || revoked) return;
      connectedAt = Date.now();
      failedUpgrades = 0;
      limitHit = false;
      const hello = { type: "hello", schemaVersion: SCHEMA_VERSION, client: location.client };
      try { nextSocket.send(JSON.stringify(hello)); } catch { /* close will schedule a retry */ }
      startHeartbeat();
      acknowledge();
    });
    nextSocket.addEventListener("message", onSocketMessage);
    nextSocket.addEventListener("close", (event) => {
      if (socket === nextSocket) socket = undefined;
      clearHeartbeat();
      if (stopped || revoked) return;
      if (event.code === 4001) {
        handleRevocation();
        return;
      }
      if (connectedAt !== undefined && Date.now() - connectedAt >= LIVE_PING_INTERVAL_MS * 3) retryAttempt = 0;
      if (connectedAt === undefined) {
        failedUpgrade();
        return;
      }
      scheduleReconnect();
    });
  }

  visibilityTarget?.addEventListener("visibilitychange", onVisibility);
  if (location.token) {
    void fetchConfig();
    connect();
  }

  return { stop, acknowledge, getState: () => state };
}

function registerServiceWorker(options: LiveOptions, location: LiveLocation): void {
  const executionOrigin = typeof self === "undefined"
    ? options.origin
    : (self as typeof self & { origin: string }).origin;
  if (options.registerServiceWorker === false || executionOrigin === "null" || location.client === "widget" || location.client === "studio") return;
  try {
    const serviceWorker = typeof navigator === "undefined" ? undefined : navigator.serviceWorker;
    if (!serviceWorker) return;
    void serviceWorker.register("/overlay-sw.js", { scope: "/" }).then(() => {
      const populateCache = (): void => {
        void serviceWorker.ready.then((registration) => {
          registration.active?.postMessage({ type: "populate-overlay" });
        }).catch(() => undefined);
      };
      if (typeof window === "undefined") return;
      if (typeof document !== "undefined" && document.readyState === "complete") populateCache();
      else window.addEventListener("load", populateCache, { once: true });
    }).catch(() => undefined);
  } catch {
    // Service workers are unavailable in some browser-source hosts.
  }
}

function safeLocalStorage(): LiveStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; } catch { return undefined; }
}

function getDocument(): LiveOptions["visibilityTarget"] | undefined {
  return typeof document === "undefined" ? undefined : document;
}

function isClient(value: string | null): value is OverlayClientType {
  return clients.includes(value as OverlayClientType);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
