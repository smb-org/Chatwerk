export interface SevenTvEvent {
  type: string;
  body: Record<string, unknown>;
}

export type SevenTvCondition = Readonly<Record<string, string>>;

export interface SevenTvEventApi {
  subscribe(type: string, condition: string | SevenTvCondition, listener: (event: SevenTvEvent) => void): () => void;
  onReconnect(listener: () => void): () => void;
  dispose(): void;
}

interface EventSocket {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event | MessageEvent) => void): void;
}

interface EventApiOptions {
  socketFactory?: (url: string) => EventSocket;
  url?: string;
  random?: () => number;
}

interface Subscription {
  type: string;
  condition: SevenTvCondition;
  listeners: Set<(event: SevenTvEvent) => void>;
}

const OPEN = 1;
const DEFAULT_HEARTBEAT_MS = 30_000;
const RESUME_ACK_TIMEOUT_MS = 5_000;

export function createSevenTvEventApi(options: EventApiOptions = {}): SevenTvEventApi {
  const socketFactory = options.socketFactory ?? ((url) => new WebSocket(url));
  const url = options.url ?? "wss://events.7tv.io/v3";
  const random = options.random ?? Math.random;
  const listeners = new Map<string, Subscription>();
  const reconnectListeners = new Set<() => void>();
  const serverSubscriptions = new Set<string>();
  let socket: EventSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;
  let resumeTimer: ReturnType<typeof setTimeout> | undefined;
  let reconnectAttempt = 0;
  let sessionId: string | null = null;
  let helloSessionId: string | null = null;
  let heartbeatInterval = DEFAULT_HEARTBEAT_MS;
  let resumePending = false;
  let hadConnection = false;
  let ready = false;
  let disposed = false;

  const send = (op: number, data: Record<string, unknown>, target: EventSocket | null = socket): void => {
    if (target?.readyState === OPEN) target.send(JSON.stringify({ op, d: data }));
  };

  const sendSubscribe = (key: string, subscription: Subscription): void => {
    send(35, { type: subscription.type, condition: subscription.condition });
    serverSubscriptions.add(key);
    knownSubscriptions.set(key, subscription);
  };

  const sendUnsubscribe = (key: string, subscription: Subscription): void => {
    if (!serverSubscriptions.has(key)) return;
    send(36, { type: subscription.type, condition: subscription.condition });
    serverSubscriptions.delete(key);
  };

  const sendDesiredSubscriptions = (): void => {
    for (const [key, subscription] of listeners) sendSubscribe(key, subscription);
  };

  const reconcileResumedSubscriptions = (): void => {
    for (const key of [...serverSubscriptions]) {
      const subscription = listeners.get(key);
      if (!subscription) {
        const previous = knownSubscriptions.get(key);
        if (previous) sendUnsubscribe(key, previous);
        knownSubscriptions.delete(key);
      }
    }
    for (const [key, subscription] of listeners) {
      if (!serverSubscriptions.has(key)) sendSubscribe(key, subscription);
    }
    for (const key of [...serverSubscriptions]) if (!listeners.has(key)) serverSubscriptions.delete(key);
  };

  const knownSubscriptions = new Map<string, Subscription>();

  const notifyReconnect = (): void => {
    for (const listener of [...reconnectListeners]) listener();
  };

  const clearResumeTimer = (): void => {
    if (resumeTimer !== undefined) clearTimeout(resumeTimer);
    resumeTimer = undefined;
  };

  const completeResume = (): void => {
    if (!resumePending) return;
    resumePending = false;
    clearResumeTimer();
    reconnectAttempt = 0;
    reconcileResumedSubscriptions();
    notifyReconnect();
  };

  const fallbackFromResume = (current: EventSocket): void => {
    if (!resumePending || socket !== current) return;
    resumePending = false;
    clearResumeTimer();
    sessionId = null;
    ready = false;
    serverSubscriptions.clear();
    current.close();
  };

  const armWatchdog = (current: EventSocket): void => {
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = setTimeout(() => {
      watchdogTimer = undefined;
      if (socket === current && current.readyState === OPEN) current.close();
    }, heartbeatInterval * 3);
  };

  const recover = (current: EventSocket): void => {
    if (socket !== current) return;
    socket = null;
    ready = false;
    if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
    watchdogTimer = undefined;
    clearResumeTimer();
    resumePending = false;
    if (disposed || listeners.size === 0 || reconnectTimer !== undefined) return;
    reconnectAttempt += 1;
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt - 1, 5));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      connect();
    }, Math.round(base * (0.75 + random() * 0.5)));
  };

  const connect = (): void => {
    if (disposed || socket || listeners.size === 0) return;
    try {
      const current = socketFactory(url);
      socket = current;
      current.addEventListener("open", () => undefined);
      current.addEventListener("message", (raw) => {
        if (socket !== current) return;
        const message = parseMessage((raw as MessageEvent).data);
        if (!message) return;
        if (message.op === 1) {
          const data = isRecord(message.d) ? message.d : {};
          heartbeatInterval = finiteNumber(data.heartbeat_interval) && data.heartbeat_interval > 0
            ? data.heartbeat_interval
            : DEFAULT_HEARTBEAT_MS;
          helloSessionId = stringValue(data.session_id);
          ready = true;
          armWatchdog(current);
          if (hadConnection && sessionId) {
            resumePending = true;
            send(34, { session_id: sessionId }, current);
            resumeTimer = setTimeout(() => fallbackFromResume(current), RESUME_ACK_TIMEOUT_MS);
          } else {
            sessionId = helloSessionId;
            serverSubscriptions.clear();
            knownSubscriptions.clear();
            sendDesiredSubscriptions();
            if (hadConnection) notifyReconnect();
          }
          hadConnection = true;
          return;
        }
        if (message.op === 2) {
          armWatchdog(current);
          return;
        }
        if (message.op === 5) {
          reconnectAttempt = 0;
          if (resumePending) {
            completeResume();
          } else if (!sessionId && helloSessionId) {
            sessionId = helloSessionId;
          }
          return;
        }
        if (message.op === 6) {
          if (resumePending) {
            resumePending = false;
            clearResumeTimer();
            sessionId = helloSessionId;
            serverSubscriptions.clear();
            knownSubscriptions.clear();
            sendDesiredSubscriptions();
            reconnectAttempt = 0;
            notifyReconnect();
          }
          return;
        }
        if (message.op === 0 && isRecord(message.d) && typeof message.d.type === "string" && isRecord(message.d.body)) {
          reconnectAttempt = 0;
          if (resumePending) completeResume();
          const body = message.d.body;
          for (const subscription of listeners.values()) {
            if (subscription.type !== message.d.type) continue;
            const objectId = subscription.condition.object_id;
            const eventObjectId = stringValue(body.id) ?? stringValue(body.object_id);
            if (objectId && eventObjectId && objectId !== eventObjectId) continue;
            const event = { type: message.d.type, body };
            for (const listener of [...subscription.listeners]) listener(event);
          }
          return;
        }
        if (message.op === 4 || message.op === 7) current.close();
      });
      current.addEventListener("close", () => recover(current));
      current.addEventListener("error", () => {
        recover(current);
        current.close();
      });
    } catch {
      socket = null;
      if (!disposed && listeners.size > 0 && reconnectTimer === undefined) {
        reconnectAttempt += 1;
        const base = Math.min(30_000, 1_000 * 2 ** Math.min(reconnectAttempt - 1, 5));
        reconnectTimer = setTimeout(() => {
          reconnectTimer = undefined;
          connect();
        }, Math.round(base * (0.75 + random() * 0.5)));
      }
    }
  };

  return {
    subscribe(type, conditionValue, listener) {
      const condition = typeof conditionValue === "string" ? { object_id: conditionValue } : { ...conditionValue };
      if (!type || Object.keys(condition).length === 0 || Object.values(condition).some((value) => !value)) return () => undefined;
      const key = subscriptionKey(type, condition);
      let subscription = listeners.get(key);
      if (!subscription) {
        subscription = { type, condition, listeners: new Set() };
        listeners.set(key, subscription);
        knownSubscriptions.set(key, subscription);
        if (socket?.readyState === OPEN && ready && !resumePending) sendSubscribe(key, subscription);
      }
      subscription.listeners.add(listener);
      connect();
      return () => {
        const current = listeners.get(key);
        current?.listeners.delete(listener);
        if (current && current.listeners.size === 0) {
          listeners.delete(key);
          if (socket?.readyState === OPEN && ready && !resumePending) {
            sendUnsubscribe(key, current);
            knownSubscriptions.delete(key);
          }
        }
        if (listeners.size === 0) {
          if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
          if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
          watchdogTimer = undefined;
          clearResumeTimer();
          resumePending = false;
          socket?.close();
          socket = null;
          serverSubscriptions.clear();
          knownSubscriptions.clear();
          sessionId = null;
          hadConnection = false;
          ready = false;
        }
      };
    },
    onReconnect(listener) {
      reconnectListeners.add(listener);
      return () => reconnectListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      listeners.clear();
      reconnectListeners.clear();
      knownSubscriptions.clear();
      serverSubscriptions.clear();
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      if (watchdogTimer !== undefined) clearTimeout(watchdogTimer);
      clearResumeTimer();
      reconnectTimer = undefined;
      watchdogTimer = undefined;
      socket?.close();
      socket = null;
      ready = false;
    },
  };
}

function subscriptionKey(type: string, condition: SevenTvCondition): string {
  const sorted = Object.fromEntries(Object.entries(condition).sort(([first], [second]) => first.localeCompare(second)));
  return `${type}:${JSON.stringify(sorted)}`;
}

function parseMessage(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "string") return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return isRecord(parsed) && finiteNumber(parsed.op) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}
