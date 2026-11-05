import { isAllowedImageUrl } from "../shared/hosts";
import { isValidColor } from "../shared/theme";
import type { SevenTvEvent, SevenTvEventApi } from "./seventv-events";

export type PaintStyle =
  | { type: "gradient"; value: string; filter?: string }
  | { type: "image"; value: string; filter?: string }
  | { type: "solid"; value: string; filter?: string };

export interface PaintLookup {
  resolve(twitchUserId: string): PaintStyle | undefined;
  resolveBadge(twitchUserId: string): SevenTvBadge | undefined;
  load(twitchUserId: string): Promise<void>;
  setChannelId(channelId: string): void;
  setEnabled(enabled: boolean): void;
  setBadgesEnabled(enabled: boolean): void;
  set(twitchUserId: string, paint: unknown): void;
  subscribe(listener: (twitchUserId: string) => void): () => void;
  dispose(): void;
}

export interface SevenTvBadge {
  name: string;
  url: string;
}

export interface PaintLookupOptions {
  fetcher?: typeof fetch;
  eventApi?: SevenTvEventApi;
  cacheLimit?: number;
  timeoutMs?: number;
  enabled?: boolean;
  badgesEnabled?: boolean;
}

interface CacheEntry {
  style: PaintStyle | null;
  expiresAt: number;
}

interface EntitlementRecord {
  twitchUserId: string;
  cosmeticId: string;
  kind: "PAINT" | "BADGE";
}

const CACHE_TTL_MS = 5 * 60_000;
const MAX_QUEUE_SIZE = 300;
const MAX_BATCH_SIZE = 25;
const BATCH_COLLECT_MS = 1_500;
const REQUEST_INTERVAL_MS = 2_000;
const MIN_TIMEOUT_MS = 30_000;
const PAINT_QUERY = `query($ids: [String!]!) { cosmetics(list: $ids) { paints { id name color kind gradients { function canvas_repeat canvas_size at stops { at color } image_url shape angle repeat } shadows { x_offset y_offset radius color } } } }`;
const BADGE_QUERY = `query($ids: [String!]!) { cosmetics(list: $ids) { badges { id name tooltip host { url } } } }`;

export function createPaintLookup(options: PaintLookupOptions = {}): PaintLookup {
  const fetcher = options.fetcher ?? fetch;
  const events = options.eventApi;
  const cacheLimit = Math.min(300, Math.max(1, Math.floor(options.cacheLimit ?? 300)));
  const timeoutMs = Math.max(MIN_TIMEOUT_MS, options.timeoutMs ?? MIN_TIMEOUT_MS);
  const cache = new Map<string, CacheEntry>();
  const badgeCache = new Map<string, { badge: SevenTvBadge | null; expiresAt: number }>();
  const pendingUsers = new Set<string>();
  const resolvingUsers = new Set<string>();
  const pendingPaints = new Map<string, Set<string>>();
  const pendingBadges = new Map<string, Set<string>>();
  const paintDefinitions = new Map<string, CacheEntry>();
  const badgeDefinitions = new Map<string, { badge: SevenTvBadge | null; expiresAt: number }>();
  const assignedPaints = new Map<string, string>();
  const assignedBadges = new Map<string, string>();
  const entitlementUsers = new Map<string, EntitlementRecord>();
  const updateListeners = new Set<(twitchUserId: string) => void>();
  const channelSubscriptions: Array<() => void> = [];
  const activeControllers = new Set<AbortController>();
  let batchTimer: ReturnType<typeof setTimeout> | undefined;
  let lastRequestAt = Number.NEGATIVE_INFINITY;
  let channelId = "";
  let enabled = options.enabled ?? true;
  let badgesEnabled = options.badgesEnabled ?? false;
  let disposed = false;
  let batchRunning = false;

  const anyEnabled = (): boolean => enabled || badgesEnabled;

  const notify = (userId: string): void => {
    for (const listener of updateListeners) listener(userId);
  };

  const pendingPaintUserCount = (): number => [...pendingPaints.values(), ...pendingBadges.values()]
    .reduce((count, users) => count + users.size, 0);

  const trimCaches = (): void => {
    while (cache.size + badgeCache.size + paintDefinitions.size + badgeDefinitions.size > cacheLimit) {
      if (cache.size > 0) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          cache.delete(oldest);
          assignedPaints.delete(oldest);
        }
      } else if (badgeCache.size > 0) {
        const oldest = badgeCache.keys().next().value as string | undefined;
        if (oldest !== undefined) {
          badgeCache.delete(oldest);
          assignedBadges.delete(oldest);
        }
      } else if (paintDefinitions.size > 0) {
        const oldest = paintDefinitions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        paintDefinitions.delete(oldest);
      } else {
        const oldest = badgeDefinitions.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        badgeDefinitions.delete(oldest);
      }
    }
  };

  const setCache = (userId: string, style: PaintStyle | null, ttl = CACHE_TTL_MS): void => {
    if (!/^\d+$/u.test(userId) || disposed) return;
    cache.delete(userId);
    cache.set(userId, { style, expiresAt: Date.now() + ttl });
    resolvingUsers.delete(userId);
    trimCaches();
    notify(userId);
  };

  const rememberDefinition = (paintId: string, style: PaintStyle | null): void => {
    const current = paintDefinitions.get(paintId);
    if (style === null && current?.style && current.expiresAt > Date.now()) style = current.style;
    paintDefinitions.delete(paintId);
    paintDefinitions.set(paintId, { style, expiresAt: Date.now() + CACHE_TTL_MS });
    trimCaches();
    const users = pendingPaints.get(paintId) ?? new Set<string>();
    pendingPaints.delete(paintId);
    for (const userId of assignedPaints.keys()) {
      if (assignedPaints.get(userId) === paintId) users.add(userId);
    }
    for (const userId of users) setCache(userId, style);
  };

  const setBadgeCache = (userId: string, badge: SevenTvBadge | null, ttl = CACHE_TTL_MS): void => {
    if (!/^\d+$/u.test(userId) || disposed) return;
    badgeCache.delete(userId);
    badgeCache.set(userId, { badge, expiresAt: Date.now() + ttl });
    resolvingUsers.delete(userId);
    trimCaches();
    notify(userId);
  };

  const rememberBadgeDefinition = (badgeId: string, badge: SevenTvBadge | null): void => {
    const current = badgeDefinitions.get(badgeId);
    if (badge === null && current?.badge && current.expiresAt > Date.now()) badge = current.badge;
    badgeDefinitions.delete(badgeId);
    badgeDefinitions.set(badgeId, { badge, expiresAt: Date.now() + CACHE_TTL_MS });
    trimCaches();
    const users = pendingBadges.get(badgeId) ?? new Set<string>();
    pendingBadges.delete(badgeId);
    for (const userId of assignedBadges.keys()) {
      if (assignedBadges.get(userId) === badgeId) users.add(userId);
    }
    for (const userId of users) setBadgeCache(userId, badge);
  };

  const fetchJson = async (body: Record<string, unknown>): Promise<unknown> => {
    const controller = new AbortController();
    activeControllers.add(controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    lastRequestAt = Date.now();
    try {
      const response = await fetcher("https://7tv.io/v3/gql", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        mode: "cors",
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`7TV API returned ${response.status}`);
      return await response.json() as unknown;
    } finally {
      clearTimeout(timer);
      activeControllers.delete(controller);
    }
  };

  const scheduleBatch = (delay = BATCH_COLLECT_MS): void => {
    if (disposed || !anyEnabled() || batchTimer !== undefined ||
      (pendingUsers.size === 0 && pendingPaints.size === 0 && pendingBadges.size === 0)) return;
    batchTimer = setTimeout(() => {
      batchTimer = undefined;
      void runBatch();
    }, delay);
  };

  const runBatch = async (): Promise<void> => {
    if (batchRunning) return;
    batchRunning = true;
    try {
      await runBatchWork();
    } finally {
      batchRunning = false;
    }
  };

  const runBatchWork = async (): Promise<void> => {
    if (disposed || !anyEnabled() || (pendingUsers.size === 0 && pendingPaints.size === 0 && pendingBadges.size === 0)) return;
    const waitMs = lastRequestAt + REQUEST_INTERVAL_MS - Date.now();
    if (waitMs > 0) {
      scheduleBatch(waitMs);
      return;
    }

    const pendingPaintEntries = enabled && pendingPaints.size > 0
      ? [...pendingPaints.entries()].slice(0, MAX_BATCH_SIZE)
      : [];
    if (pendingPaintEntries.length > 0) {
      const paintIds = pendingPaintEntries.map(([paintId]) => paintId);
      const userByPaint = new Map<string, Set<string>>(pendingPaintEntries);
      for (const paintId of paintIds) pendingPaints.delete(paintId);
      try {
        const result = await fetchJson({ query: PAINT_QUERY, variables: { ids: paintIds } });
        const data = isRecord(result) && isRecord(result.data) ? result.data : null;
        const cosmetics = data && isRecord(data.cosmetics) ? data.cosmetics : null;
        const paints = cosmetics && Array.isArray(cosmetics.paints) ? cosmetics.paints : [];
        for (const paintId of paintIds) {
          const paint = paints.find((value) => isRecord(value) && value.id === paintId);
          const style = paint ? buildPaintStyle(paint) : null;
          rememberDefinition(paintId, style);
        }
      } catch {
        for (const [paintId, users] of userByPaint) {
          for (const userId of users) {
            if (assignedPaints.get(userId) === paintId) setCache(userId, null, 60_000);
          }
        }
      }
      scheduleBatch(REQUEST_INTERVAL_MS);
      return;
    }

    const pendingBadgeEntries = badgesEnabled && pendingBadges.size > 0
      ? [...pendingBadges.entries()].slice(0, MAX_BATCH_SIZE)
      : [];
    if (pendingBadgeEntries.length > 0) {
      const badgeIds = pendingBadgeEntries.map(([badgeId]) => badgeId);
      const userByBadge = new Map<string, Set<string>>(pendingBadgeEntries);
      for (const badgeId of badgeIds) pendingBadges.delete(badgeId);
      try {
        const result = await fetchJson({ query: BADGE_QUERY, variables: { ids: badgeIds } });
        const data = isRecord(result) && isRecord(result.data) ? result.data : null;
        const cosmetics = data && isRecord(data.cosmetics) ? data.cosmetics : null;
        const badges = cosmetics && Array.isArray(cosmetics.badges) ? cosmetics.badges : [];
        for (const badgeId of badgeIds) {
          const value = badges.find((item) => isRecord(item) && item.id === badgeId);
          rememberBadgeDefinition(badgeId, value ? buildSevenTvBadge(value) : null);
        }
      } catch {
        for (const [badgeId, users] of userByBadge) {
          for (const userId of users) {
            if (assignedBadges.get(userId) === badgeId) setBadgeCache(userId, null, 60_000);
          }
        }
      }
      scheduleBatch(REQUEST_INTERVAL_MS);
      return;
    }

    const userIds = [...pendingUsers].slice(0, MAX_BATCH_SIZE);
    for (const userId of userIds) {
      pendingUsers.delete(userId);
      resolvingUsers.add(userId);
    }
    const declarations = userIds.map((_userId, index) => `$id${index}: String!`).join(", ");
    const styleFields = [enabled ? "paint_id" : "", badgesEnabled ? "badge_id" : ""].filter(Boolean).join(" ");
    const fields = userIds.map((_userId, index) =>
      `u${index}: userByConnection(platform: TWITCH, id: $id${index}) { id style { ${styleFields} } }`).join(" ");
    const variables = Object.fromEntries(userIds.map((userId, index) => [`id${index}`, userId]));
    try {
      const result = await fetchJson({ query: `query(${declarations}) { ${fields} }`, variables });
      const data = isRecord(result) && isRecord(result.data) ? result.data : null;
      for (let index = 0; index < userIds.length; index += 1) {
        const userId = userIds[index]!;
        const user = data && isRecord(data[`u${index}`]) ? data[`u${index}`] as Record<string, unknown> : null;
        const style = user && isRecord(user.style) ? user.style : null;
        const currentPaint = cache.get(userId);
        if (enabled && (!currentPaint || currentPaint.expiresAt <= Date.now())) {
          if (assignedPaints.has(userId)) {
            queuePaintDefinition(userId, assignedPaints.get(userId)!);
          } else {
            const paintId = style && typeof style.paint_id === "string" ? style.paint_id : "";
            if (!paintId) {
              assignedPaints.delete(userId);
              setCache(userId, null);
            } else {
              assignedPaints.set(userId, paintId);
              const definition = paintDefinitions.get(paintId);
              if (definition && definition.expiresAt > Date.now()) setCache(userId, definition.style);
              else {
                if (definition) paintDefinitions.delete(paintId);
                let users = pendingPaints.get(paintId);
                if (!users) {
                  users = new Set();
                  pendingPaints.set(paintId, users);
                }
                users.add(userId);
              }
            }
          }
        }
        const currentBadge = badgeCache.get(userId);
        if (badgesEnabled && (!currentBadge || currentBadge.expiresAt <= Date.now())) {
          if (assignedBadges.has(userId)) {
            queueBadgeDefinition(userId, assignedBadges.get(userId)!);
          } else {
            const badgeId = style && typeof style.badge_id === "string" ? style.badge_id : "";
            if (!badgeId) {
              assignedBadges.delete(userId);
              setBadgeCache(userId, null);
            } else {
              assignedBadges.set(userId, badgeId);
              const definition = badgeDefinitions.get(badgeId);
              if (definition && definition.expiresAt > Date.now()) setBadgeCache(userId, definition.badge);
              else {
                if (definition) badgeDefinitions.delete(badgeId);
                let users = pendingBadges.get(badgeId);
                if (!users) {
                  users = new Set();
                  pendingBadges.set(badgeId, users);
                }
                users.add(userId);
              }
            }
          }
        }
      }
    } catch {
      for (const userId of userIds) {
        const currentCache = cache.get(userId);
        if (enabled && !assignedPaints.has(userId) && (!currentCache || currentCache.expiresAt <= Date.now())) setCache(userId, null, 60_000);
        const currentBadge = badgeCache.get(userId);
        if (badgesEnabled && !assignedBadges.has(userId) && (!currentBadge || currentBadge.expiresAt <= Date.now())) setBadgeCache(userId, null, 60_000);
      }
    }
    scheduleBatch(REQUEST_INTERVAL_MS);
  };

  const queuePaintDefinition = (userId: string, paintId: string): void => {
    const alreadyPending = pendingUsers.has(userId) || resolvingUsers.has(userId) ||
      [...pendingPaints.values()].some((users) => users.has(userId));
    if (!alreadyPending && pendingUsers.size + pendingPaintUserCount() >= MAX_QUEUE_SIZE) {
      assignedPaints.delete(userId);
      setCache(userId, null, 60_000);
      return;
    }
    assignedPaints.delete(userId);
    assignedPaints.set(userId, paintId);
    if (assignedPaints.size > cacheLimit) {
      const oldest = assignedPaints.keys().next().value as string | undefined;
      if (oldest !== undefined) assignedPaints.delete(oldest);
    }
    pendingUsers.delete(userId);
    resolvingUsers.add(userId);
    const definition = paintDefinitions.get(paintId);
    if (definition && definition.expiresAt > Date.now()) {
      setCache(userId, definition.style);
      return;
    }
    if (definition) paintDefinitions.delete(paintId);
    let users = pendingPaints.get(paintId);
    if (!users) {
      users = new Set();
      pendingPaints.set(paintId, users);
    }
    users.add(userId);
    scheduleBatch();
  };

  const queueBadgeDefinition = (userId: string, badgeId: string): void => {
    const alreadyPending = pendingUsers.has(userId) || resolvingUsers.has(userId) ||
      [...pendingPaints.values(), ...pendingBadges.values()].some((users) => users.has(userId));
    if (!alreadyPending && pendingUsers.size + pendingPaintUserCount() >= MAX_QUEUE_SIZE) {
      assignedBadges.delete(userId);
      setBadgeCache(userId, null, 60_000);
      return;
    }
    assignedBadges.delete(userId);
    assignedBadges.set(userId, badgeId);
    if (assignedBadges.size > cacheLimit) {
      const oldest = assignedBadges.keys().next().value as string | undefined;
      if (oldest !== undefined) assignedBadges.delete(oldest);
    }
    pendingUsers.delete(userId);
    resolvingUsers.add(userId);
    const definition = badgeDefinitions.get(badgeId);
    if (definition && definition.expiresAt > Date.now()) {
      setBadgeCache(userId, definition.badge);
      return;
    }
    if (definition) badgeDefinitions.delete(badgeId);
    let users = pendingBadges.get(badgeId);
    if (!users) {
      users = new Set();
      pendingBadges.set(badgeId, users);
    }
    users.add(userId);
    scheduleBatch();
  };

  const readEntitlement = (event: SevenTvEvent): EntitlementRecord | null => {
    const object = readEventObject(event.body);
    if (!object || (object.kind !== "PAINT" && object.kind !== "BADGE") || typeof object.ref_id !== "string") return null;
    const user = isRecord(object.user) ? object.user : null;
    const connections = user && Array.isArray(user.connections) ? user.connections : [];
    const connection = connections.find((value) => isRecord(value) && value.platform === "TWITCH" && typeof value.id === "string");
    return isRecord(connection) && typeof connection.id === "string" && /^\d+$/u.test(connection.id)
      ? { twitchUserId: connection.id, cosmeticId: object.ref_id, kind: object.kind }
      : null;
  };

  const handleEvent = (event: SevenTvEvent): void => {
    if (!anyEnabled() || disposed) return;
    if (event.type === "entitlement.create") {
      const entitlement = readEntitlement(event);
      if (!entitlement) return;
      const entitlementId = stringValue(event.body.id);
      if (entitlementId) entitlementUsers.set(entitlementId, entitlement);
      while (entitlementUsers.size > cacheLimit) {
        const oldest = entitlementUsers.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        entitlementUsers.delete(oldest);
      }
      if ((entitlement.kind === "PAINT" && enabled) || (entitlement.kind === "BADGE" && badgesEnabled)) {
        if (entitlement.kind === "PAINT") queuePaintDefinition(entitlement.twitchUserId, entitlement.cosmeticId);
        else queueBadgeDefinition(entitlement.twitchUserId, entitlement.cosmeticId);
      }
      return;
    }
    if (event.type === "entitlement.delete") {
      const entitlementId = stringValue(event.body.id);
      const entitlement = (entitlementId && entitlementUsers.get(entitlementId)) ?? readEntitlement(event);
      if (!entitlement) return;
      entitlementUsers.delete(entitlementId ?? "");
      if (entitlement.kind === "PAINT" && assignedPaints.get(entitlement.twitchUserId) === entitlement.cosmeticId) {
        assignedPaints.delete(entitlement.twitchUserId);
        const users = pendingPaints.get(entitlement.cosmeticId);
        users?.delete(entitlement.twitchUserId);
        if (users?.size === 0) pendingPaints.delete(entitlement.cosmeticId);
        resolvingUsers.delete(entitlement.twitchUserId);
        setCache(entitlement.twitchUserId, null);
      }
      if (entitlement.kind === "BADGE" && assignedBadges.get(entitlement.twitchUserId) === entitlement.cosmeticId) {
        assignedBadges.delete(entitlement.twitchUserId);
        const users = pendingBadges.get(entitlement.cosmeticId);
        users?.delete(entitlement.twitchUserId);
        if (users?.size === 0) pendingBadges.delete(entitlement.cosmeticId);
        resolvingUsers.delete(entitlement.twitchUserId);
        setBadgeCache(entitlement.twitchUserId, null);
      }
      return;
    }
    if (event.type === "cosmetic.create") {
      const cosmetic = readEventObject(event.body);
      const cosmeticId = cosmetic && stringValue(cosmetic.id);
      if (!cosmetic || !cosmeticId) return;
      const kind = cosmetic.kind;
      if (kind === "BADGE" && badgesEnabled) rememberBadgeDefinition(cosmeticId, buildSevenTvBadge(cosmetic));
      else if ((kind === undefined || kind === "PAINT") && enabled) rememberDefinition(cosmeticId, buildPaintStyle(cosmetic));
    }
  };

  const setChannelId = (id: string): void => {
    const nextChannelId = /^\d+$/u.test(id) ? id : "";
    if (nextChannelId === channelId || disposed) return;
    channelId = nextChannelId;
    syncChannelSubscriptions();
  };

  const syncChannelSubscriptions = (): void => {
    for (const unsubscribe of channelSubscriptions.splice(0)) unsubscribe();
    if (!anyEnabled() || !channelId || !events) return;
    const condition = { ctx: "channel", platform: "TWITCH", id: channelId };
    for (const type of ["cosmetic.create", "entitlement.create", "entitlement.delete"]) {
      channelSubscriptions.push(events.subscribe(type, condition, handleEvent));
    }
  };

  const load = async (userId: string): Promise<void> => {
    if (!/^\d+$/u.test(userId) || disposed || !anyEnabled()) return;
    let paintEntry = cache.get(userId);
    if (paintEntry && paintEntry.expiresAt <= Date.now()) {
      cache.delete(userId);
      paintEntry = undefined;
    }
    let badgeEntry = badgeCache.get(userId);
    if (badgeEntry && badgeEntry.expiresAt <= Date.now()) {
      badgeCache.delete(userId);
      badgeEntry = undefined;
    }
    if ((!enabled || paintEntry) && (!badgesEnabled || badgeEntry)) return;
    if (enabled && !paintEntry && assignedPaints.has(userId)) queuePaintDefinition(userId, assignedPaints.get(userId)!);
    if (badgesEnabled && !badgeEntry && assignedBadges.has(userId)) queueBadgeDefinition(userId, assignedBadges.get(userId)!);
    const needsUserLookup = (enabled && !paintEntry && !assignedPaints.has(userId)) ||
      (badgesEnabled && !badgeEntry && !assignedBadges.has(userId));
    if (needsUserLookup && !pendingUsers.has(userId) && !resolvingUsers.has(userId)) {
      if (pendingUsers.size + pendingPaintUserCount() < MAX_QUEUE_SIZE) pendingUsers.add(userId);
    }
    scheduleBatch();
  };

  return {
    resolve(userId) {
      const entry = cache.get(userId);
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry) cache.delete(userId);
        return undefined;
      }
      return entry.style ?? undefined;
    },
    resolveBadge(userId) {
      if (!badgesEnabled) return undefined;
      const entry = badgeCache.get(userId);
      if (!entry || entry.expiresAt <= Date.now()) {
        if (entry) badgeCache.delete(userId);
        return undefined;
      }
      return entry.badge ?? undefined;
    },
    load,
    setChannelId,
    setEnabled(nextEnabled) {
      if (enabled === nextEnabled || disposed) return;
      enabled = nextEnabled;
      syncChannelSubscriptions();
      if (enabled) {
        scheduleBatch();
        return;
      }
      pendingPaints.clear();
      if (anyEnabled()) return;
      if (batchTimer !== undefined) clearTimeout(batchTimer);
      batchTimer = undefined;
      for (const controller of activeControllers) controller.abort();
      pendingUsers.clear();
      resolvingUsers.clear();
      pendingBadges.clear();
    },
    setBadgesEnabled(nextEnabled) {
      if (badgesEnabled === nextEnabled || disposed) return;
      badgesEnabled = nextEnabled;
      syncChannelSubscriptions();
      if (badgesEnabled) {
        scheduleBatch();
        return;
      }
      pendingBadges.clear();
      if (anyEnabled()) return;
      if (batchTimer !== undefined) clearTimeout(batchTimer);
      batchTimer = undefined;
      for (const controller of activeControllers) controller.abort();
      pendingUsers.clear();
      resolvingUsers.clear();
      pendingPaints.clear();
    },
    set(userId, paint) {
      setCache(userId, buildPaintStyle(paint));
    },
    subscribe(listener) {
      updateListeners.add(listener);
      return () => updateListeners.delete(listener);
    },
    dispose() {
      disposed = true;
      if (batchTimer !== undefined) clearTimeout(batchTimer);
      batchTimer = undefined;
      for (const controller of activeControllers) controller.abort();
      activeControllers.clear();
      for (const unsubscribe of channelSubscriptions.splice(0)) unsubscribe();
      cache.clear();
      badgeCache.clear();
      pendingUsers.clear();
      resolvingUsers.clear();
      pendingPaints.clear();
      pendingBadges.clear();
      paintDefinitions.clear();
      badgeDefinitions.clear();
      assignedPaints.clear();
      assignedBadges.clear();
      entitlementUsers.clear();
      updateListeners.clear();
    },
  };
}

export function buildPaintStyle(paint: unknown): PaintStyle | null {
  if (!isRecord(paint)) return null;
  const shadowFilter = buildShadowFilter(paint.shadows);
  if (shadowFilter === null) return null;
  const addFilter = (style: PaintStyle): PaintStyle => shadowFilter ? { ...style, filter: shadowFilter } : style;

  if (Array.isArray(paint.layers)) {
    const values = paint.layers.flatMap((layer) => buildLayerStyle(layer));
    if (values.length !== paint.layers.length || values.length === 0) return null;
    const imageLayers = values.filter((value) => value.type !== "solid").map((value) => value.value);
    return addFilter(imageLayers.length > 0 ? { type: "gradient", value: imageLayers.join(", ") } : values[0]!);
  }

  if (Array.isArray(paint.gradients)) {
    if (paint.gradients.length > 4) return null;
    const gradients = paint.gradients.map(buildGradientStyle);
    if (gradients.some((style) => style === null)) return null;
    if (gradients.length > 0) return addFilter({ type: "gradient", value: gradients.join(", ") });
  }

  const fn = paint.function;
  if (fn === "URL") {
    const url = safeImageUrl(paint.image_url);
    return url ? addFilter({ type: "image", value: `url("${url}")` }) : null;
  }
  if (fn === "LINEAR_GRADIENT" || fn === "RADIAL_GRADIENT") {
    const value = buildGradientStyle(paint);
    return value ? addFilter({ type: "gradient", value }) : null;
  }
  if (typeof paint.color === "string" || typeof paint.color === "number") {
    const color = validatedColor(paint.color);
    return color ? addFilter({ type: "solid", value: color }) : null;
  }
  return null;
}

function buildSevenTvBadge(value: unknown): SevenTvBadge | null {
  if (!isRecord(value)) return null;
  const name = stringValue(value.name) ?? stringValue(value.tooltip);
  const host = isRecord(value.host) ? value.host : null;
  const rawUrl = host && stringValue(host.url);
  if (!name || !rawUrl) return null;
  try {
    const url = new URL(rawUrl.startsWith("//") ? `https:${rawUrl}` : rawUrl);
    if (url.protocol !== "https:" || url.hostname.toLowerCase() !== "cdn.7tv.app" ||
      url.username || url.password || (url.port && url.port !== "443")) return null;
    if (/\/badge\/[^/]+$/u.test(url.pathname)) url.pathname += "/2x.webp";
    else if (/\/[124]x$/u.test(url.pathname)) url.pathname += ".webp";
    if (!isAllowedImageUrl(url.href)) return null;
    return { name: name.trim().slice(0, 100), url: url.href };
  } catch {
    return null;
  }
}

function buildGradientStyle(value: unknown): string | null {
  if (!isRecord(value) || !Array.isArray(value.stops)) return null;
  const stops = validatedStops(value.stops);
  if (!stops) return null;
  const repeat = value.repeat === undefined ? false : value.repeat;
  if (typeof repeat !== "boolean") return null;
  if (value.function === "LINEAR_GRADIENT") {
    if (!finiteRange(value.angle, -360, 360)) return null;
    return `${repeat ? "repeating-" : ""}linear-gradient(${value.angle}deg, ${stops})`;
  }
  if (value.function === "RADIAL_GRADIENT") {
    const shape = value.shape === "ellipse" || value.shape === "ELLIPSE" ? "ellipse"
      : value.shape === "circle" || value.shape === "CIRCLE" || value.shape === undefined ? "circle"
        : null;
    return shape ? `${repeat ? "repeating-" : ""}radial-gradient(${shape}, ${stops})` : null;
  }
  return null;
}

function buildShadowFilter(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (!Array.isArray(value) || value.length > 4) return null;
  const shadows: string[] = [];
  for (const shadow of value) {
    if (!isRecord(shadow) || !finiteRange(shadow.x_offset, -100, 100) ||
      !finiteRange(shadow.y_offset, -100, 100) || !finiteRange(shadow.radius, 0, 100)) return null;
    const color = validatedColor(shadow.color);
    if (!color) return null;
    shadows.push(`drop-shadow(${shadow.x_offset}px ${shadow.y_offset}px ${shadow.radius}px ${color})`);
  }
  return shadows.join(" ");
}

function buildLayerStyle(value: unknown): PaintStyle[] {
  if (!isRecord(value) || !isRecord(value.ty)) return [];
  const layer = value.ty;
  const kind = typeof layer.__typename === "string" ? layer.__typename : "";
  if (kind.includes("LinearGradient")) {
    const stops = validatedStops(layer.stops);
    return stops && finiteRange(layer.angle, -360, 360)
      ? [{ type: "gradient", value: `${layer.repeat === true ? "repeating-" : ""}linear-gradient(${layer.angle}deg, ${stops})` }]
      : [];
  }
  if (kind.includes("RadialGradient")) {
    const stops = validatedStops(layer.stops);
    const shape = layer.shape === "ELLIPSE" ? "ellipse" : layer.shape === "CIRCLE" ? "circle" : "";
    return stops && shape
      ? [{ type: "gradient", value: `${layer.repeat === true ? "repeating-" : ""}radial-gradient(${shape}, ${stops})` }]
      : [];
  }
  if (kind.includes("SingleColor")) {
    const color = validatedColor(layer.color);
    return color ? [{ type: "solid", value: color }] : [];
  }
  if (kind.includes("Image") && Array.isArray(layer.images)) {
    const image = layer.images.find((item) => isRecord(item) && safeImageUrl(item.url));
    const url = isRecord(image) ? safeImageUrl(image.url) : null;
    return url ? [{ type: "image", value: `url("${url}")` }] : [];
  }
  return [];
}

function validatedStops(value: unknown): string | null {
  if (!Array.isArray(value) || value.length < 2 || value.length > 16) return null;
  const stops: string[] = [];
  for (const item of value) {
    if (!isRecord(item) || !finiteRange(item.at, 0, 1)) return null;
    const color = validatedColor(item.color);
    if (!color) return null;
    stops.push(`${color} ${item.at * 100}%`);
  }
  return stops.join(", ");
}

function validatedColor(value: unknown): string | null {
  if (typeof value === "string") return isValidColor(value) ? value : null;
  if (typeof value !== "number" || !Number.isInteger(value) || value < -2_147_483_648 || value > 4_294_967_295) return null;
  return `#${(value >>> 0).toString(16).padStart(8, "0")}`;
}

function safeImageUrl(value: unknown): string | null {
  if (!isAllowedImageUrl(value)) return null;
  try {
    const url = new URL(value);
    return url.hostname.toLowerCase() === "cdn.7tv.app" ? url.href : null;
  } catch {
    return null;
  }
}

function readEventObject(body: Record<string, unknown>): Record<string, unknown> | null {
  if (isRecord(body.object)) {
    const object = body.object;
    if (isRecord(object.data)) {
      const cosmetic = readPaintData(object.data) ?? object.data;
      const kind = stringValue(object.kind) ?? stringValue(cosmetic.kind) ?? stringValue(body.cosmetic_kind);
      return {
        ...cosmetic,
        id: stringValue(cosmetic.id) ?? stringValue(object.id) ?? stringValue(body.id) ?? "",
        ...(kind ? { kind } : {}),
      };
    }
    return object;
  }
  const paint = readPaintData(body);
  if (paint) return typeof paint.id !== "string" && typeof body.id === "string" ? { ...paint, id: body.id } : paint;
  if (typeof body.id === "string" && (isRecord(body.host) || typeof body.name === "string")) return body;
  return null;
}

function readPaintData(value: Record<string, unknown>): Record<string, unknown> | null {
  if (hasPaintFields(value)) return value;
  const changes: Record<string, unknown> = {};
  for (const group of ["added", "updated", "pushed"]) {
    const fields = Array.isArray(value[group]) ? value[group] : [];
    for (const field of fields) {
      if (!isRecord(field) || typeof field.key !== "string") continue;
      const nested = field.nested === true && Array.isArray(field.value)
        ? readPaintData({ updated: field.value })
        : null;
      const next = nested ?? field.value;
      if (group === "pushed") {
        const current = Array.isArray(changes[field.key]) ? changes[field.key] as unknown[] : [];
        changes[field.key] = [...current, ...(Array.isArray(next) ? next : [next])];
      } else {
        changes[field.key] = next;
      }
    }
  }
  if (isRecord(changes.data)) return readPaintData(changes.data);
  return hasPaintFields(changes) ? changes : null;
}

function hasPaintFields(value: Record<string, unknown>): boolean {
  return value.color !== undefined || value.gradients !== undefined || value.function !== undefined ||
    value.layers !== undefined || value.image_url !== undefined;
}

function finiteRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
