import {
  DEFAULTS,
  ensureReadableNameColor,
  ensureTagColorContrast,
  effectiveOutline,
  isValidColor,
  LEGIBILITY_OUTLINE_OPACITY_THRESHOLD,
  themeCssVariables,
  themePanelBackground,
  themeRowBackground,
  type ThemeConfig,
} from "../shared/theme";
import { shouldFilterMessage } from "./filters";
import { BoundedTickerQueue } from "./ticker-queue";
import type { CommonMessage, IrcEvent } from "./irc-parse";
import { parseReactionEvent } from "./irc-parse";
import { splitMessage, type EmoteLookup, type MessagePart } from "./emotes";
import { createReactionEffects, type HypeTrainReactionMessage } from "./reactions";
import { isAllowedImageUrl } from "../shared/hosts";
import type { BadgeLookup } from "./badges";
import type { PaintLookup, PaintStyle } from "./paints";
import type { PronounLookup } from "./pronouns";
import type { ThirdPartyBadgeLookup } from "./third-party-badges";
import type { SevenTvBadge } from "./paints";
import { roomNameLookup, type RoomNameLookup } from "./room-names";

export interface ChatRendererOptions {
  root: HTMLElement;
  theme?: ThemeConfig;
  nodeLimit?: number;
  scheduler?: (callback: () => void) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  deferProviderSettings?: boolean;
  emotes?: EmoteLookup;
  badges?: BadgeLookup;
  paints?: PaintLookup;
  pronouns?: PronounLookup;
  thirdPartyBadges?: ThirdPartyBadgeLookup;
  roomNames?: RoomNameLookup;
}

interface PendingMessage {
  event: CommonMessage;
  receivedAt: number;
  aliases: Map<string, MessageAlias>;
}

interface MessageAlias {
  key: string;
  room: string;
  id: string | null;
}

interface RenderedLine {
  node: HTMLElement;
  message: HTMLElement;
  messageParts: MessagePart[];
  sourceId: string | null;
  channel: string;
  aliases: Map<string, MessageAlias>;
  channelMarker: HTMLElement;
  badges: HTMLElement;
  metadata: HTMLElement;
  sourceRoom: HTMLElement;
  sourceRoomName: string | null;
  sourceRoomLogo: string | null;
  sourceLookupStarted: boolean;
  event: CommonMessage;
  receivedAt: number;
  tickerWidth: number;
  userLogin: string;
  userId: string | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  removalTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface ChatRenderer {
  handle(event: IrcEvent, receivedAt?: number): void;
  handleHypeTrain(message: HypeTrainReactionMessage): void;
  beginBacklogFetch(): () => void;
  setTheme(theme: ThemeConfig): void;
  setChannels(channels: string[]): void;
  clear(): void;
  dispose(): void;
}

const MAX_NODE_LIMIT = 300;
const DEFAULT_NODE_LIMIT = 100;
const FADE_DURATION_MS = 200;
const MAX_MODERATION_TOMBSTONES = 500;

export function createChatRenderer(options: ChatRendererOptions): ChatRenderer {
  const { root } = options;
  const limit = Math.min(MAX_NODE_LIMIT, Math.max(1, Math.floor(options.nodeLimit ?? DEFAULT_NODE_LIMIT)));
  const schedule = options.scheduler ?? ((callback: () => void) => setTimeout(callback, 16));
  const cancel = options.cancelScheduled ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const roomNames = options.roomNames ?? roomNameLookup;
  let theme = options.theme ?? DEFAULTS;
  let pending: PendingMessage[] = [];
  let localMessageId = 0;
  const tickerQueue = new BoundedTickerQueue<PendingMessage>(limit);
  let tickerActive: RenderedLine | undefined;
  let activeChannels = normalizeChannels(theme.channels);
  let scheduled = false;
  let scheduleHandle: unknown;
  const lines = new Set<RenderedLine>();
  const heightPrunedLines = new Set<RenderedLine>();
  const linesByAlias = new Map<string, RenderedLine>();
  const linesBySourceId = new Map<string, RenderedLine>();
  const moderatedMessageIds = new Map<string, true>();
  const clearedUserTimestamps = new Map<string, number>();
  const clearedRoomTimestamps = new Map<string, number>();
  let backlogFetches = 0;
  const reactionEffects = createReactionEffects({
    root,
    theme,
    emotes: options.emotes,
    onLineHighlightChange: (line) => refreshName(line),
  });
  const unsubscribePaints = options.paints?.subscribe((userId) => {
    refreshPaints(userId);
    refreshBadges(userId);
  });
  const unsubscribeThirdPartyBadges = options.thirdPartyBadges?.subscribe((userId) => refreshBadges(userId));
  let providerSettingsDeferred = options.deferProviderSettings ?? false;
  let disposed = false;
  let layoutScheduled = false;
  let layoutScheduleHandle: unknown;
  let emoteRefreshScheduled = false;
  let emoteRefreshHandle: unknown;
  let pendingEmoteRefreshAll = false;
  const pendingEmoteRefreshRooms = new Set<string>();
  const watchedImages = new WeakSet<HTMLImageElement>();

  const scheduleHeightPrune = (): void => {
    if (disposed || layoutScheduled) return;
    layoutScheduled = true;
    layoutScheduleHandle = schedule(() => {
      layoutScheduled = false;
      layoutScheduleHandle = undefined;
      pruneToHeight();
    });
  };

  const watchLineImages = (line: HTMLElement): void => {
    for (const image of line.querySelectorAll<HTMLImageElement>("img")) {
      if (watchedImages.has(image)) continue;
      watchedImages.add(image);
      image.addEventListener("load", scheduleHeightPrune, { once: true });
      image.addEventListener("error", scheduleHeightPrune, { once: true });
      if (image.complete) scheduleHeightPrune();
    }
  };

  const scheduleEmoteRefresh = (channelId?: string): void => {
    if (disposed) return;
    if (channelId) pendingEmoteRefreshRooms.add(channelId);
    else pendingEmoteRefreshAll = true;
    if (emoteRefreshScheduled) return;
    emoteRefreshScheduled = true;
    const handle = schedule(() => {
      emoteRefreshScheduled = false;
      emoteRefreshHandle = undefined;
      const allRooms = pendingEmoteRefreshAll;
      const rooms = new Set(pendingEmoteRefreshRooms);
      pendingEmoteRefreshAll = false;
      pendingEmoteRefreshRooms.clear();
      refreshEmotes(rooms, allRooms);
    });
    if (emoteRefreshScheduled) emoteRefreshHandle = handle;
  };
  const unsubscribeEmotes = options.emotes?.subscribe(scheduleEmoteRefresh);

  const applyTheme = (): void => {
    root.dataset.lineOrder = theme.lineOrder;
    root.dataset.layout = theme.layout;
    root.dataset.motion = theme.motion;
    root.dataset.heightLimited = theme.layout === "stack" && theme.maxChatHeight > 0 ? "true" : "false";
    root.dataset.panelEnabled = String(theme.panelEnabled);
    if (!providerSettingsDeferred) {
      options.emotes?.setProviderEnabled("7TV", theme.emotes7tv);
      options.emotes?.setProviderEnabled("BTTV", theme.emotesBttv);
      options.emotes?.setProviderEnabled("FFZ", theme.emotesFfz);
      options.paints?.setEnabled(theme.showPaints);
      options.paints?.setBadgesEnabled(theme.showBadges && theme.badges7tv);
    }
    for (const provider of ["badgesBttv", "badgesFfz", "badgesChatterino", "badgesHomies"] as const) {
      options.thirdPartyBadges?.setEnabled(provider, theme.showBadges && theme[provider]);
    }
    for (const line of lines) applyLineThemeClasses(line.node, theme);
    for (const [name, value] of Object.entries(themeCssVariables(theme))) root.style.setProperty(name, value);
    root.style.setProperty("--t-row-background", themeRowBackground(theme));
    root.style.setProperty("--t-panel-background", themePanelBackground(theme));
    const outline = effectiveOutline(theme);
    root.style.setProperty("--t-outline", `${outline.width}px`);
    root.style.setProperty("--t-outline-color", outline.color);
    root.style.setProperty("--t-ticker-speed", `${theme.tickerSpeed}px`);
    reactionEffects.setTheme(theme);
    for (const line of lines) {
      for (const image of line.node.querySelectorAll<HTMLImageElement>("img[data-chatwerk-emote]")) {
        setEmoteImageHeight(image, theme, isGigantified(line.event));
      }
      if (line.node.classList.contains("ticker-line")) updateTickerDuration(line);
      updateChannelMarker(line);
    }
    for (const line of lines) {
      resolveSourceRoomName(line);
      const badgeContainer = line.node.querySelector<HTMLElement>(".chat-badges");
      if (badgeContainer) {
        appendBadgeImages(badgeContainer, line.event, theme, options.badges, options.paints, options.thirdPartyBadges, true);
      }
      applySourceRoomStyle(line);
      watchLineImages(line.node);
      const pronounContainer = line.node.querySelector<HTMLElement>(".chat-pronouns");
      if ((!theme.showPronouns || theme.hideNames) && pronounContainer) pronounContainer.textContent = "";
      else if (theme.showPronouns && !theme.hideNames && pronounContainer && !pronounContainer.textContent && options.pronouns && line.userLogin) {
        void options.pronouns.lookup(line.userLogin).then((value) => {
          if (value && lines.has(line)) pronounContainer.textContent = ` (${value})`;
        });
      }
      const name = line.node.querySelector<HTMLElement>(".chat-name");
      if (name) {
        const paint = theme.showPaints && !providerSettingsDeferred ? options.paints?.resolve(line.userId ?? "") : undefined;
        applyNamePaint(name, paint, nameColorFor(line.event, theme, isHighlighted(line.node)));
        if (line.userId && !providerSettingsDeferred && (theme.showPaints || (theme.showBadges && theme.badges7tv))) {
          void options.paints?.load(line.userId);
        }
        if (line.userId && theme.showBadges) void options.thirdPartyBadges?.load(line.userId);
      }
      if (theme.layout === "stack" && theme.neverFade) {
        if (line.lifetimeTimer !== undefined) clearTimeout(line.lifetimeTimer);
        if (line.removalTimer !== undefined) clearTimeout(line.removalTimer);
        line.lifetimeTimer = undefined;
        line.removalTimer = undefined;
        line.node.style.setProperty("opacity", "1");
        line.node.style.setProperty("transform", "translateY(0)");
      }
      remeasureTickerWidth(line);
    }
    if (theme.layout === "stack") enforceLineLimit();
    if (lines.size > 0) scheduleHeightPrune();
  };

  const removeLine = (line: RenderedLine): void => {
    const wasVisible = !heightPrunedLines.has(line) && line.node.parentNode === root;
    if (line.lifetimeTimer !== undefined) clearTimeout(line.lifetimeTimer);
    if (line.removalTimer !== undefined) clearTimeout(line.removalTimer);
    lines.delete(line);
    heightPrunedLines.delete(line);
    for (const key of line.aliases.keys()) {
      reactionEffects.detachLine(key);
      if (linesByAlias.get(key) === line) linesByAlias.delete(key);
    }
    if (line.sourceId && linesBySourceId.get(line.sourceId) === line) linesBySourceId.delete(line.sourceId);
    if (tickerActive === line) tickerActive = undefined;
    line.node.remove();
    if (wasVisible && heightPrunedLines.size > 0) scheduleHeightPrune();
  };

  const flush = (): void => {
    scheduled = false;
    scheduleHandle = undefined;
    if (theme.layout === "ticker") {
      if (theme.motion === "none") flushStaticTicker();
      else advanceTicker();
      return;
    }
    if (pending.length === 0) return;
    pending.sort((left, right) => left.receivedAt - right.receivedAt);
    const batch = pending;
    pending = [];
    const fragment = root.ownerDocument.createDocumentFragment();
    const now = Date.now();
    for (const item of batch) {
      const remainingLifetime = theme.lifetime - (now - item.receivedAt);
      if (!theme.neverFade && remainingLifetime <= 0) continue;
      const event = item.event;
      const line = buildLine(event, root.ownerDocument, theme, item.receivedAt);
      lines.add(line.record);
      resolveSourceRoomName(line.record);
      addLineAliases(line.record, item.aliases);
      for (const key of item.aliases.keys()) reactionEffects.attachLine(key, line.node);
      if (line.record.sourceId) linesBySourceId.set(line.record.sourceId, line.record);
      line.record.node = line.node;
      fragment.appendChild(line.node);
      if (!theme.neverFade) armLifetime(line.record, remainingLifetime);
    }
    root.appendChild(fragment);
    for (const line of lines) watchLineImages(line.node);
    pruneToHeight(false);
  };

  const scheduleFlush = (): void => {
    if (scheduled) return;
    scheduled = true;
    scheduleHandle = schedule(flush);
  };

  function addLineAliases(line: RenderedLine, aliases: Map<string, MessageAlias>): void {
    for (const alias of aliases.values()) addAlias(line, alias);
  }

  function addAlias(line: RenderedLine, alias: MessageAlias): void {
    line.aliases.set(alias.key, alias);
    linesByAlias.set(alias.key, line);
  }

  function removeAlias(line: RenderedLine, key: string): void {
    reactionEffects.detachLine(key);
    reactionEffects.cancelAlias(key);
    line.aliases.delete(key);
    if (linesByAlias.get(key) === line) linesByAlias.delete(key);
    if (line.aliases.size === 0) removeLine(line);
  }

  function removeRoomAliases(line: RenderedLine, room: string): void {
    for (const alias of [...line.aliases.values()]) {
      if (alias.room === room) removeAlias(line, alias.key);
    }
  }

  function removeQueuedAlias(key: string): void {
    const strip = (item: PendingMessage): boolean => {
      item.aliases.delete(key);
      return item.aliases.size === 0;
    };
    pending = pending.filter((item) => !strip(item));
    tickerQueue.remove(strip);
  }

  function removeQueuedAliases(predicate: (alias: MessageAlias, item: PendingMessage) => boolean): void {
    const strip = (item: PendingMessage): boolean => {
      for (const alias of [...item.aliases.values()]) {
        if (predicate(alias, item)) item.aliases.delete(alias.key);
      }
      return item.aliases.size === 0;
    };
    pending = pending.filter((item) => !strip(item));
    tickerQueue.remove(strip);
  }

  function findQueued(predicate: (item: PendingMessage) => boolean): PendingMessage | undefined {
    return pending.find(predicate) ?? tickerQueue.toArray().find(predicate);
  }

  function advanceTicker(): void {
    if (tickerActive) return;
    let item = tickerQueue.dequeue();
    const now = Date.now();
    while (item && (item.aliases.size === 0 || theme.lifetime - (now - item.receivedAt) <= 0)) {
      item = tickerQueue.dequeue();
    }
    if (!item) return;
    const line = buildLine(item.event, root.ownerDocument, theme, item.receivedAt);
    line.node.classList.add("ticker-line");
    line.record.node = line.node;
    lines.add(line.record);
    resolveSourceRoomName(line.record);
    addLineAliases(line.record, item.aliases);
    for (const key of item.aliases.keys()) reactionEffects.attachLine(key, line.node);
    if (line.record.sourceId) linesBySourceId.set(line.record.sourceId, line.record);
    tickerActive = line.record;
    root.replaceChildren(line.node);
    updateTickerDuration(line.record);
    line.node.addEventListener("animationend", () => {
      if (tickerActive !== line.record) return;
      removeLine(line.record);
      scheduleFlush();
    }, { once: true });
  }

  function sortStackLines(): void {
    const rows = [...lines]
      .filter((line) => !heightPrunedLines.has(line) && line.node.parentNode === root)
      .sort((left, right) => left.receivedAt - right.receivedAt);
    const currentRows = [...root.children].filter((child) => child.classList.contains("chat-line")) as HTMLElement[];
    let firstOutOfOrder = 0;
    while (firstOutOfOrder < rows.length && currentRows[firstOutOfOrder] === rows[firstOutOfOrder]!.node) firstOutOfOrder += 1;
    for (let index = firstOutOfOrder; index < rows.length; index += 1) root.appendChild(rows[index]!.node);
  }

  function flushStaticTicker(): void {
    let latest: PendingMessage | undefined;
    let item = tickerQueue.dequeue();
    while (item) {
      if (item.aliases.size > 0) latest = item;
      item = tickerQueue.dequeue();
    }
    if (!latest) return;
    if (tickerActive) removeLine(tickerActive);
    const line = buildLine(latest.event, root.ownerDocument, theme, latest.receivedAt);
    line.node.classList.add("ticker-line", "ticker-static");
    line.record.node = line.node;
    lines.add(line.record);
    resolveSourceRoomName(line.record);
    addLineAliases(line.record, latest.aliases);
    for (const key of latest.aliases.keys()) reactionEffects.attachLine(key, line.node);
    if (line.record.sourceId) linesBySourceId.set(line.record.sourceId, line.record);
    tickerActive = line.record;
    root.replaceChildren(line.node);
  }

  function updateTickerDuration(line: RenderedLine): void {
    const speed = Math.max(1, theme.tickerSpeed);
    const viewportWidth = root.ownerDocument.defaultView?.innerWidth ?? 1920;
    const seconds = Math.max(0.05, (viewportWidth + line.tickerWidth) / speed);
    line.node.style.setProperty("--ticker-duration", `${seconds}s`);
  }

  function remeasureTickerWidth(line: RenderedLine): void {
    if (!line.node.classList.contains("ticker-line")) return;
    const displayName = line.node.querySelector<HTMLElement>(".chat-name")?.textContent ?? "";
    line.tickerWidth = measureTickerWidth(
      line.event,
      theme,
      line.messageParts,
      displayName,
      line.badges,
      line.sourceRoom,
      line.channelMarker,
      root.ownerDocument,
    );
    updateTickerDuration(line);
  }

  function resolveSourceRoomName(line: RenderedLine): void {
    const roomId = line.event.sourceRoomId;
    if (!roomId || !line.event.roomId || roomId === line.event.roomId || theme.sharedChatLabel === "hidden" ||
      line.sourceRoomName || line.sourceLookupStarted) return;
    line.sourceLookupStarted = true;
    void roomNames.lookup(roomId).then((details) => {
      if (!details || disposed || !lines.has(line)) return;
      line.sourceRoomName = details.displayName;
      line.sourceRoomLogo = details.logo;
      applySourceRoomStyle(line);
      if (!tickerAnimationStarted(line)) remeasureTickerWidth(line);
      scheduleHeightPrune();
    }).catch(() => undefined);
  }

  function tickerAnimationStarted(line: RenderedLine): boolean {
    if (!line.node.classList.contains("ticker-line") || line.node.classList.contains("ticker-static")) return false;
    return line.node.getAnimations?.().some((animation) => animation.playState !== "idle") ?? false;
  }

  function applySourceRoomStyle(line: RenderedLine): void {
    const { sourceRoom, badges, metadata, channelMarker, event } = line;
    const roomId = event.sourceRoomId;
    const foreignRoom = Boolean(roomId && event.roomId && roomId !== event.roomId);
    const style = theme.sharedChatLabel;
    const name = line.sourceRoomName ?? roomId ?? "";
    sourceRoom.replaceChildren();
    sourceRoom.className = "chat-source-room";
    sourceRoom.dataset.style = style;
    sourceRoom.hidden = !foreignRoom || style === "hidden";
    if (foreignRoom && roomId) sourceRoom.dataset.roomId = roomId;
    else delete sourceRoom.dataset.roomId;
    if (foreignRoom) sourceRoom.setAttribute("aria-label", `Shared chat source room ${name}`);
    else sourceRoom.removeAttribute("aria-label");

    if (foreignRoom && style !== "hidden") {
      if (style === "text") {
        sourceRoom.textContent = theme.sharedChatPrefix ? `${theme.sharedChatPrefix} ${name}` : name;
      } else if (style === "pill" || style === "avatar-pill") {
        const pill = sourceRoom.ownerDocument.createElement("span");
        pill.className = "chat-source-pill";
        pill.textContent = name;
        pill.style.setProperty("color", ensureReadableNameColor(theme.highlightTextColor, theme.highlightBackgroundColor));
        sourceRoom.appendChild(pill);
      }

      if (style === "avatar" || style === "avatar-pill") {
        const slot = sourceRoom.ownerDocument.createElement("span");
        slot.className = "chat-source-avatar-slot";
        if (line.sourceRoomName && line.sourceRoomLogo && isAllowedImageUrl(line.sourceRoomLogo)) {
          const avatar = sourceRoom.ownerDocument.createElement("img");
          avatar.className = "chat-source-avatar";
          avatar.src = line.sourceRoomLogo;
          avatar.alt = line.sourceRoomName;
          avatar.setAttribute("decoding", "async");
          avatar.style.setProperty("height", `${theme.fontSize}px`);
          avatar.style.setProperty("width", `${theme.fontSize}px`);
          slot.appendChild(avatar);
        } else if (line.sourceRoomName) {
          slot.setAttribute("aria-hidden", "true");
          slot.textContent = Array.from(line.sourceRoomName)[0] ?? "";
        }
        sourceRoom.insertBefore(slot, sourceRoom.firstChild);
        badges.appendChild(sourceRoom);
      }
    }
    if (style !== "avatar" && style !== "avatar-pill") metadata.insertBefore(sourceRoom, channelMarker);
  }

  function changeLayout(nextLayout: ThemeConfig["layout"]): void {
    const messages = [...lines].map((line): PendingMessage => ({
      event: line.event,
      receivedAt: line.receivedAt,
      aliases: new Map(line.aliases),
    })).concat(pending, tickerQueue.toArray());
    for (const line of [...lines]) {
      if (line.lifetimeTimer !== undefined) clearTimeout(line.lifetimeTimer);
      if (line.removalTimer !== undefined) clearTimeout(line.removalTimer);
      for (const key of line.aliases.keys()) reactionEffects.detachLine(key);
      line.node.remove();
    }
    lines.clear();
    linesByAlias.clear();
    linesBySourceId.clear();
    heightPrunedLines.clear();
    tickerActive = undefined;
    pending = [];
    tickerQueue.clear();
    if (nextLayout === "ticker") {
      for (const item of messages) tickerQueue.enqueue(item);
    } else {
      pending = messages;
    }
  }

  const lineLimit = (): number => Math.min(limit, theme.maxLines);

  const discardPending = (item: PendingMessage | undefined): void => {
    if (!item) return;
    for (const key of item.aliases.keys()) reactionEffects.cancelAlias(key);
  };

  const enforceLineLimit = (): void => {
    while (lines.size + pending.length > lineLimit()) {
      const oldest = oldestRenderedLine();
      const pendingIndex = oldestPendingIndex();
      if (oldest && (pendingIndex < 0 || oldest.receivedAt <= pending[pendingIndex]!.receivedAt)) removeLine(oldest);
      else if (pendingIndex >= 0) discardPending(pending.splice(pendingIndex, 1)[0]);
      else break;
    }
  };

  const enforceCapacity = (receivedAt: number): boolean => {
    while (lines.size + pending.length >= lineLimit()) {
      const oldest = oldestRenderedLine();
      const pendingIndex = oldestPendingIndex();
      const pendingOldest = pendingIndex >= 0 ? pending[pendingIndex] : undefined;
      const oldestAt = oldest && pendingOldest
        ? Math.min(oldest.receivedAt, pendingOldest.receivedAt)
        : oldest?.receivedAt ?? pendingOldest?.receivedAt;
      if (oldestAt === undefined || receivedAt < oldestAt) return false;
      if (pendingOldest && (!oldest || pendingOldest.receivedAt <= oldest.receivedAt)) {
        discardPending(pending.splice(pendingIndex, 1)[0]);
      } else if (oldest) removeLine(oldest);
      else return false;
    }
    return true;
  };

  function oldestRenderedLine(): RenderedLine | undefined {
    return [...lines].reduce<RenderedLine | undefined>((oldest, line) =>
      !oldest || line.receivedAt < oldest.receivedAt ? line : oldest, undefined);
  }

  function oldestPendingIndex(): number {
    let index = -1;
    for (let candidate = 0; candidate < pending.length; candidate += 1) {
      if (index < 0 || pending[candidate]!.receivedAt < pending[index]!.receivedAt) index = candidate;
    }
    return index;
  }

  function pruneToHeight(restore = true): void {
    if (disposed || theme.layout !== "stack" || lines.size === 0) return;
    if (restore && heightPrunedLines.size > 0) {
      const orderedLines = [...lines].sort((left, right) => left.receivedAt - right.receivedAt);
      for (const line of [...heightPrunedLines].sort((left, right) => left.receivedAt - right.receivedAt)) {
        if (!lines.has(line)) continue;
        const lineIndex = orderedLines.indexOf(line);
        const nextVisible = orderedLines.slice(lineIndex + 1).find((candidate) => candidate.node.parentNode === root);
        root.insertBefore(line.node, nextVisible?.node ?? null);
      }
      heightPrunedLines.clear();
      sortStackLines();
    } else if (!restore) {
      sortStackLines();
    }
    const frame = root.getBoundingClientRect();
    if (frame.height <= 0) return;
    const view = root.ownerDocument.defaultView;
    const style = view?.getComputedStyle(root);
    const verticalInsets = [
      style?.paddingTop, style?.paddingBottom, style?.borderTopWidth, style?.borderBottomWidth,
    ].reduce((sum, value) => sum + (Number.parseFloat(value ?? "") || 0), 0);
    const availableHeight = Math.max(0, frame.height - verticalInsets);
    const visibleRows = [...lines].filter((line) => line.node.parentNode === root && !heightPrunedLines.has(line));
    const measured = visibleRows.map((line) => {
      const bounds = line.node.getBoundingClientRect();
      const margin = Number.parseFloat(view?.getComputedStyle(line.node).marginBlockEnd ?? "") || 0;
      return { line, height: Math.max(0, bounds.height + margin) };
    });
    const insertionOrder = new Map([...lines].map((line, index) => [line, index]));
    const newestFirst = [...measured].sort((left, right) =>
      right.line.receivedAt - left.line.receivedAt ||
      (insertionOrder.get(right.line) ?? 0) - (insertionOrder.get(left.line) ?? 0));
    const visibleLines = new Set<RenderedLine>();
    let totalHeight = 0;
    for (const [index, item] of newestFirst.entries()) {
      visibleLines.add(item.line);
      totalHeight += item.height;
      if (index === 0 && item.height > availableHeight + 1) break;
      if (index > 0 && totalHeight > availableHeight + 1) {
        visibleLines.delete(item.line);
        break;
      }
    }
    for (const item of measured) {
      if (visibleLines.has(item.line)) continue;
      heightPrunedLines.add(item.line);
      item.line.node.remove();
    }
  }

  function rememberModeration(event: Extract<IrcEvent, { type: "CLEARMSG" | "CLEARCHAT" }>): void {
    if (backlogFetches === 0) return;
    const room = moderationRoom(event.tags, event.channel);
    if (event.type === "CLEARMSG") {
      if (event.messageId) rememberTombstone(moderatedMessageIds, aliasKey(room, event.messageId), true);
      return;
    }
    const timestamp = moderationTimestamp(event.tags);
    if (!event.target && !event.targetUserId) {
      rememberTombstone(clearedRoomTimestamps, room, timestamp);
      return;
    }
    if (event.targetUserId) rememberTombstone(clearedUserTimestamps, `${room}\u0000id:${event.targetUserId}`, timestamp);
    if (event.target) rememberTombstone(clearedUserTimestamps, `${room}\u0000login:${event.target.toLowerCase()}`, timestamp);
  }

  function isModeratedBacklog(event: CommonMessage, receivedAt: number): boolean {
    if (backlogFetches === 0) return false;
    const room = moderationRoom(event.tags, event.channel);
    if (event.id && moderatedMessageIds.has(aliasKey(room, event.id))) return true;
    const timestamp = clearedRoomTimestamps.get(room);
    if (timestamp !== undefined && receivedAt <= timestamp) return true;
    const userId = event.tags["user-id"];
    const userTimestamp = userId ? clearedUserTimestamps.get(`${room}\u0000id:${userId}`) : undefined;
    if (userTimestamp !== undefined && receivedAt <= userTimestamp) return true;
    const loginTimestamp = event.userLogin
      ? clearedUserTimestamps.get(`${room}\u0000login:${event.userLogin.toLowerCase()}`)
      : undefined;
    return loginTimestamp !== undefined && receivedAt <= loginTimestamp;
  }

  function rememberTombstone<K, V>(target: Map<K, V>, key: K, value: V): void {
    target.delete(key);
    target.set(key, value);
    if (target.size > MAX_MODERATION_TOMBSTONES) target.delete(target.keys().next().value as K);
  }

  const clearModerationTombstones = (): void => {
    moderatedMessageIds.clear();
    clearedUserTimestamps.clear();
    clearedRoomTimestamps.clear();
  };

  const handle = (event: IrcEvent, receivedAt?: number): void => {
    if (event.type === "PRIVMSG" || event.type === "USERNOTICE") {
      if (shouldFilterMessage(event, theme)) return;
      const timestamp = receivedAt ?? (event.historical ? timestampFromMessage(event) : Date.now());
      if (event.historical && isModeratedBacklog(event, timestamp)) return;
      const alias = messageAlias(event, `local:${++localMessageId}`);
      const reaction = parseReactionEvent(event);
      if (event.sourceId) {
        const rendered = linesBySourceId.get(event.sourceId);
        if (rendered) {
          addAlias(rendered, alias);
          if (reaction) reactionEffects.enqueue(event, reaction, alias);
          reactionEffects.attachLine(alias.key, rendered.node);
          return;
        }
        const queued = findQueued((item) => item.event.sourceId === event.sourceId);
        if (queued) {
          queued.aliases.set(alias.key, alias);
          if (reaction) reactionEffects.enqueue(event, reaction, alias);
          return;
        }
      }
      if (event.id) {
        const previous = linesByAlias.get(alias.key);
        if (previous) {
          if (previous.event.historical && !event.historical) {
            previous.event = event;
            if (reaction) {
              reactionEffects.enqueue(event, reaction, alias);
              reactionEffects.attachLine(alias.key, previous.node);
            }
          }
          return;
        }
        const previousPending = findQueued((item) => item.aliases.has(alias.key));
        if (previousPending) {
          if (previousPending.event.historical && !event.historical) {
            previousPending.event = event;
            if (reaction) reactionEffects.enqueue(event, reaction, alias);
          }
          return;
        }
      }
      if (reaction) reactionEffects.enqueue(event, reaction, alias);
      const item: PendingMessage = { event, receivedAt: timestamp, aliases: new Map([[alias.key, alias]]) };
      if (theme.layout === "ticker") {
        tickerQueue.enqueue(item);
      } else {
        if (!enforceCapacity(timestamp)) return;
        pending.push(item);
      }
      scheduleFlush();
      const broadcasterId = event.sourceRoomId && event.sourceRoomId !== event.roomId ? event.sourceRoomId : event.roomId;
      if (theme.showBadges && options.badges && event.badges.length > 0) {
        const loads = [options.badges.loadGlobal()];
        if (broadcasterId) loads.push(options.badges.loadBroadcaster(broadcasterId));
        void Promise.allSettled(loads).then((results) => {
          if (results.some((result) => result.status === "fulfilled" && result.value)) refreshBadges();
        });
      }
      if ((theme.showPaints || (theme.showBadges && theme.badges7tv)) && !providerSettingsDeferred && event.tags["user-id"] && options.paints) {
        void options.paints.load(event.tags["user-id"]).then(() => refreshPaints(event.tags["user-id"]));
      }
      if (theme.showBadges && event.tags["user-id"] && options.thirdPartyBadges) {
        void options.thirdPartyBadges.load(event.tags["user-id"]);
      }
      return;
    }
    if (event.type === "CLEARMSG") {
      rememberModeration(event);
      if (event.messageId) {
        const room = moderationRoom(event.tags, event.channel);
        const key = aliasKey(room, event.messageId);
        reactionEffects.cancelAlias(key);
        const line = linesByAlias.get(key);
        if (line) removeAlias(line, key);
        removeQueuedAlias(key);
        scheduleFlush();
      }
      return;
    }
    if (event.type === "CLEARCHAT") {
      rememberModeration(event);
      const room = moderationRoom(event.tags, event.channel);
      if (!event.target && !event.targetUserId) {
        reactionEffects.clearRoom(room);
        for (const line of [...lines]) removeRoomAliases(line, room);
        removeQueuedAliases((alias) => alias.room === room);
      } else {
        const target = event.target?.toLowerCase() ?? null;
        const targetUserId = event.targetUserId;
        reactionEffects.clearUser(room, targetUserId, target);
        for (const line of [...lines]) {
          if (targetUserId ? line.userId === targetUserId : line.userLogin.toLowerCase() === target) {
            removeRoomAliases(line, room);
          }
        }
        removeQueuedAliases((alias, item) => alias.room === room && (targetUserId
          ? item.event.tags["user-id"] === targetUserId
          : item.event.userLogin?.toLowerCase() === target));
      }
      scheduleFlush();
      return;
    }
  };

  const armLifetime = (line: RenderedLine, lifetime: number): void => {
    if (theme.neverFade) return;
    line.lifetimeTimer = setTimeout(() => {
      if (theme.motion === "none") {
        removeLine(line);
        return;
      }
      line.node.style.setProperty("opacity", "0");
      line.node.style.setProperty("transform", "translateY(-4px)");
      line.removalTimer = setTimeout(() => removeLine(line), FADE_DURATION_MS);
    }, lifetime);
  };

  const clear = (): void => {
    if (scheduled && scheduleHandle !== undefined) cancel(scheduleHandle);
    scheduled = false;
    scheduleHandle = undefined;
    if (layoutScheduled && layoutScheduleHandle !== undefined) cancel(layoutScheduleHandle);
    layoutScheduled = false;
    layoutScheduleHandle = undefined;
    if (emoteRefreshScheduled && emoteRefreshHandle !== undefined) cancel(emoteRefreshHandle);
    emoteRefreshScheduled = false;
    emoteRefreshHandle = undefined;
    pendingEmoteRefreshAll = false;
    pendingEmoteRefreshRooms.clear();
    pending = [];
    tickerQueue.clear();
    tickerActive = undefined;
    reactionEffects.clear();
    for (const line of [...lines]) removeLine(line);
    root.replaceChildren();
    linesByAlias.clear();
    linesBySourceId.clear();
  };

  const view = root.ownerDocument.defaultView;
  const ResizeObserverClass = view?.ResizeObserver;
  const resizeObserver = ResizeObserverClass ? new ResizeObserverClass(() => pruneToHeight()) : undefined;
  resizeObserver?.observe(root);

  applyTheme();
  return {
    handle,
    handleHypeTrain(message) {
      reactionEffects.handleHypeTrain(message);
    },
    beginBacklogFetch() {
      if (backlogFetches === 0) clearModerationTombstones();
      backlogFetches += 1;
      let ended = false;
      return () => {
        if (ended) return;
        ended = true;
        backlogFetches = Math.max(0, backlogFetches - 1);
        if (backlogFetches === 0) clearModerationTombstones();
      };
    },
    setTheme(nextTheme) {
      const previousLayout = theme.layout;
      const previousMotion = theme.motion;
      const previousNeverFade = theme.neverFade;
      if (previousLayout !== nextTheme.layout) changeLayout(nextTheme.layout);
      else if (previousLayout === "ticker" && previousMotion !== nextTheme.motion) {
        changeLayout("stack");
        changeLayout("ticker");
      }
      theme = nextTheme;
      providerSettingsDeferred = false;
      if (theme.channels.length > 0) activeChannels = normalizeChannels(theme.channels);
      applyTheme();
      if (theme.layout === "stack" && previousNeverFade && !theme.neverFade) {
        for (const line of lines) armLifetime(line, theme.lifetime - (Date.now() - line.receivedAt));
      }
      if (theme.layout === "ticker" && tickerActive && theme.motion === "none") scheduleFlush();
      if (theme.layout === "ticker" && !tickerActive && tickerQueue.size > 0) scheduleFlush();
      if (theme.layout === "stack" && pending.length > 0) scheduleFlush();
    },
    setChannels(channels) {
      activeChannels = normalizeChannels(channels);
      for (const line of lines) updateChannelMarker(line);
      scheduleHeightPrune();
    },
    clear,
    dispose() {
      disposed = true;
      resizeObserver?.disconnect();
      clear();
      reactionEffects.dispose();
      unsubscribeEmotes?.();
      unsubscribePaints?.();
      unsubscribeThirdPartyBadges?.();
      options.emotes?.dispose();
      options.badges?.dispose();
      options.thirdPartyBadges?.dispose();
      options.paints?.dispose();
      options.pronouns?.dispose();
    },
  };

  function buildLine(
    event: CommonMessage,
    document: Document,
    config: ThemeConfig,
    receivedAt = Date.now(),
  ): { node: HTMLElement; record: RenderedLine } {
    const row = document.createElement("div");
    row.setAttribute("class", "chat-line");
    row.dataset.receivedAt = String(receivedAt);
    const highlighted = event.tags["msg-id"] === "highlighted-message";
    const gigantified = isGigantified(event);
    if (highlighted) row.classList.add("chat-highlighted");
    if (gigantified) row.classList.add("chat-gigantified");
    applyLineThemeClasses(row, config);
    row.style.setProperty("font-family", "var(--t-font-family)");
    row.style.setProperty("font-size", "var(--t-font-size)");
    row.style.setProperty("font-weight", "var(--t-font-weight)");
    row.style.setProperty("gap", "var(--t-spacing)");
    row.style.setProperty("background-color", "var(--t-row-background)");
    row.style.setProperty("-webkit-text-stroke-width", "var(--t-outline)");
    row.style.setProperty("-webkit-text-stroke-color", "var(--t-outline-color)");
    row.style.setProperty("opacity", "1");
    row.style.setProperty("transform", "translateY(0)");
    if (highlighted) {
      row.style.setProperty("background-color", "var(--t-highlight-background-color)");
      row.style.setProperty("color", "var(--t-highlight-text-color)");
    }
    const name = document.createElement("span");
    name.setAttribute("class", "chat-name");
    name.classList.toggle("chat-sr-only", config.hideNames);
    const displayName = event.displayName?.trim() || event.userLogin || "system";
    name.textContent = displayName;
    const color = nameColorFor(event, config, highlighted);
    name.style.setProperty("color", color);
    const userId = event.tags["user-id"] ?? "";
    const paint = config.showPaints && !providerSettingsDeferred ? options.paints?.resolve(userId) : undefined;
    applyNamePaint(name, paint, color);
    const pronouns = document.createElement("span");
    pronouns.setAttribute("class", "chat-pronouns");
    const message = document.createElement("span");
    message.setAttribute("class", "chat-message");
    const foreignRoom = Boolean(event.sourceRoomId && event.roomId && event.sourceRoomId !== event.roomId);
    const parts = splitEventMessage(event, options.emotes);
    appendMessageParts(message, parts, config, gigantified);
    const badges = document.createElement("span");
    badges.setAttribute("class", "chat-badges");
    appendBadgeImages(badges, event, config, options.badges, options.paints, options.thirdPartyBadges);
    const sourceRoom = document.createElement("span");
    sourceRoom.setAttribute("class", "chat-source-room");
    if (foreignRoom && event.sourceRoomId) {
      sourceRoom.setAttribute("data-room-id", event.sourceRoomId);
      sourceRoom.setAttribute("aria-label", `Shared chat source room ${event.sourceRoomId}`);
      sourceRoom.textContent = `via ${event.sourceRoomId}`;
    }
    const channelMarker = document.createElement("span");
    channelMarker.setAttribute("class", "chat-source-channel");
    channelMarker.textContent = `#${normalizeChannels([event.channel])[0] ?? ""}`;
    if (activeChannels.length <= 1) channelMarker.hidden = true;
    const metadata = document.createElement("span");
    metadata.setAttribute("class", "chat-meta");
    metadata.appendChild(badges);
    metadata.appendChild(name);
    metadata.appendChild(pronouns);
    metadata.appendChild(sourceRoom);
    metadata.appendChild(channelMarker);
    if (config.lineOrder === "message-first") {
      row.appendChild(message);
      row.appendChild(metadata);
    } else {
      row.appendChild(metadata);
      row.appendChild(message);
    }
    const record: RenderedLine = {
      node: row,
      message,
      messageParts: parts,
      sourceId: event.sourceId,
      channel: event.channel.toLowerCase(),
      aliases: new Map(),
      channelMarker,
      badges,
      metadata,
      sourceRoom,
      sourceRoomName: event.sourceRoomName ?? null,
      sourceRoomLogo: event.sourceRoomLogo ?? null,
      sourceLookupStarted: false,
      event,
      receivedAt,
      tickerWidth: 0,
      userLogin: event.userLogin ?? "",
      userId: event.tags["user-id"] ?? null,
      lifetimeTimer: undefined,
      removalTimer: undefined,
    };
    applySourceRoomStyle(record);
    record.tickerWidth = measureTickerWidth(event, config, parts, displayName, badges, sourceRoom, channelMarker, document);
    if (config.showPronouns && !config.hideNames && options.pronouns && event.userLogin) {
      void options.pronouns.lookup(event.userLogin).then((value) => {
        if (value && lines.has(record) && !theme.hideNames) pronouns.textContent = ` (${value})`;
      });
    }
    return { node: row, record };
  }

  function refreshBadges(userId?: string): void {
    for (const line of lines) {
      if (userId && line.userId !== userId) continue;
      const target = line.node.querySelector<HTMLElement>(".chat-badges");
      if (target) appendBadgeImages(target, line.event, theme, options.badges, options.paints, options.thirdPartyBadges, true);
      watchLineImages(line.node);
    }
    scheduleHeightPrune();
  }

  function refreshEmotes(channelIds: Set<string>, allRooms: boolean): void {
    for (const line of lines) {
      const roomId = emoteRoomIdFor(line.event);
      if (!allRooms && roomId && !channelIds.has(roomId)) continue;
      const parts = splitEventMessage(line.event, options.emotes);
      if (!hasNewEmoteCoverage(line.messageParts, parts)) continue;
      line.message.replaceChildren();
      appendMessageParts(line.message, parts, theme, isGigantified(line.event));
      line.messageParts = parts;
      remeasureTickerWidth(line);
      watchLineImages(line.node);
      scheduleHeightPrune();
    }
  }

  function refreshName(lineNode: HTMLElement): void {
    const line = [...lines].find((candidate) => candidate.node === lineNode);
    const name = lineNode.querySelector<HTMLElement>(".chat-name");
    if (!line || !name) return;
    const paint = theme.showPaints && !providerSettingsDeferred ? options.paints?.resolve(line.userId ?? "") : undefined;
    applyNamePaint(name, paint, nameColorFor(line.event, theme, isHighlighted(lineNode)));
  }

  function updateChannelMarker(line: RenderedLine): void {
    line.channelMarker.textContent = `#${normalizeChannels([line.event.channel])[0] ?? ""}`;
    line.channelMarker.hidden = activeChannels.length <= 1;
  }

  function measureTickerWidth(
    event: CommonMessage,
    config: ThemeConfig,
    parts: ReturnType<typeof splitMessage>,
    displayName: string,
    badges: HTMLElement,
    sourceRoom: HTMLElement,
    channelMarker: HTMLElement,
    document: Document,
  ): number {
    const canvas = document.createElement("canvas");
    const Context = document.defaultView?.CanvasRenderingContext2D;
    const context = Context ? canvas.getContext("2d") : null;
    if (context) context.font = `${config.fontWeight} ${config.fontSize}px "${config.fontFamily}"`;
    const measure = (value: string): number => context
      ? context.measureText(value).width
      : [...value].length * config.fontSize * 0.56;

    const gigantified = isGigantified(event);
    const emoteHeight = config.fontSize * (gigantified ? config.gigantifiedScale : config.emoteScale);
    let messageWidth = 0;
    for (const part of parts) {
      if (part.type === "text") messageWidth += measure(part.value);
      else messageWidth += emoteHeight + config.emoteSpacing;
    }
    const badgeCount = badges.querySelectorAll(":scope > .chat-badge").length;
    const badgeWidth = badgeCount * config.fontSize + Math.max(0, badgeCount - 1) * config.fontSize * 0.15;
    const visibleWidths = [messageWidth];
    if (!config.hideNames) visibleWidths.push(measure(displayName));
    const sourceInBadges = sourceRoom.parentElement === badges;
    if (badgeCount > 0) visibleWidths.push(badgeWidth);
    if (!sourceRoom.hidden && sourceRoom.querySelector(".chat-source-avatar-slot")) {
      const pill = sourceRoom.querySelector<HTMLElement>(".chat-source-pill");
      const avatarAndPillWidth = config.fontSize + (pill ? measure(pill.textContent ?? "") + config.fontSize * 0.95 : 0);
      if (sourceInBadges && badgeCount > 0) visibleWidths[visibleWidths.length - 1] = (visibleWidths.at(-1) ?? 0) + avatarAndPillWidth + config.fontSize * 0.15;
      else visibleWidths.push(avatarAndPillWidth);
    } else if (!sourceRoom.hidden && sourceRoom.textContent && !sourceInBadges) {
      const pill = sourceRoom.querySelector(".chat-source-pill");
      visibleWidths.push(measure(sourceRoom.textContent) + (pill ? config.fontSize * 0.8 : 0));
    }
    if (!channelMarker.hidden) visibleWidths.push(measure(channelMarker.textContent ?? ""));
    if (config.showPronouns && !config.hideNames && event.userLogin) visibleWidths.push(measure(` (${event.userLogin})`));
    return Math.ceil(visibleWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, visibleWidths.length - 1) * config.spacing);
  }

  function refreshPaints(userId?: string): void {
    if (!theme.showPaints || providerSettingsDeferred) return;
    for (const line of lines) {
      if (userId && line.userId !== userId) continue;
      const name = line.node.querySelector<HTMLElement>(".chat-name");
      if (name) applyNamePaint(name, options.paints?.resolve(line.userId ?? ""), nameColorFor(line.event, theme, isHighlighted(line.node)));
    }
  }
}

function appendBadgeImages(
  container: HTMLElement,
  event: CommonMessage,
  theme: ThemeConfig,
  badges: BadgeLookup | undefined,
  paints: PaintLookup | undefined,
  thirdPartyBadges: ThirdPartyBadgeLookup | undefined,
  replace = false,
): void {
  const sourceRoom = replace ? container.querySelector<HTMLElement>(".chat-source-room") : null;
  if (replace) container.replaceChildren();
  if (!theme.showBadges) {
    if (sourceRoom) container.appendChild(sourceRoom);
    return;
  }
  const broadcasterId = event.sourceRoomId && event.sourceRoomId !== event.roomId ? event.sourceRoomId : event.roomId;
  const append = (name: string, url: string, source: string): void => {
    if (!isAllowedImageUrl(url)) return;
    const image = container.ownerDocument.createElement("img");
    image.setAttribute("class", "chat-badge");
    image.dataset.badgeSource = source;
    image.setAttribute("src", url);
    image.setAttribute("alt", name);
    image.setAttribute("title", name);
    image.setAttribute("decoding", "async");
    image.setAttribute("height", String(Math.round(theme.fontSize)));
    image.style.setProperty("height", `${theme.fontSize}px`);
    image.style.setProperty("width", "auto");
    container.appendChild(image);
  };
  for (const badge of badges?.resolve(event.badges, broadcasterId) ?? []) {
    append(`${badge.name} ${badge.version}`, badge.url, "twitch");
  }
  const userId = event.tags["user-id"] ?? "";
  const sevenTvBadge = paints?.resolveBadge(userId) as SevenTvBadge | undefined;
  if (sevenTvBadge && isExpectedBadgeHost(sevenTvBadge.url, "cdn.7tv.app")) {
    append(sevenTvBadge.name, sevenTvBadge.url, "7tv");
  }
  for (const badge of thirdPartyBadges?.resolve(userId) ?? []) {
    const host = badge.provider === "badgesBttv" ? "cdn.betterttv.net"
      : badge.provider === "badgesFfz" ? "cdn.frankerfacez.com"
      : badge.provider === "badgesChatterino" ? "fourtf.com" : "cdn.chatterinohomies.com";
    if (isExpectedBadgeHost(badge.url, host)) append(badge.name, badge.url, badge.provider);
  }
  if (sourceRoom) container.appendChild(sourceRoom);
}

function splitEventMessage(event: CommonMessage, emotes: EmoteLookup | undefined): MessagePart[] {
  const foreignRoom = Boolean(event.sourceRoomId && event.roomId && event.sourceRoomId !== event.roomId);
  const includeProviderEmotes = !foreignRoom;
  const roomId = emoteRoomIdFor(event);
  return splitMessage(event.text || event.tags["system-msg"] || "", event.emotes, emotes, includeProviderEmotes, roomId);
}

function emoteRoomIdFor(event: CommonMessage): string | undefined {
  const foreignRoom = Boolean(event.sourceRoomId && event.roomId && event.sourceRoomId !== event.roomId);
  return foreignRoom ? event.sourceRoomId ?? undefined : event.roomId ?? undefined;
}

function appendMessageParts(message: HTMLElement, parts: MessagePart[], theme: ThemeConfig, gigantified: boolean): void {
  const document = message.ownerDocument;
  for (const part of parts) {
    if (part.type === "text") {
      message.appendChild(document.createTextNode(part.value));
    } else if (isAllowedImageUrl(part.url)) {
      const image = document.createElement("img");
      image.setAttribute("class", "chat-emote");
      image.setAttribute("data-chatwerk-emote", "true");
      if (gigantified) image.setAttribute("data-gigantified", "true");
      image.setAttribute("src", part.url);
      image.setAttribute("alt", part.name);
      image.setAttribute("decoding", "async");
      setEmoteImageHeight(image, theme, gigantified);
      if (part.overlays?.length) {
        const wrapper = document.createElement("span");
        wrapper.setAttribute("class", "chat-emote-wrapper");
        wrapper.style.setProperty("display", "inline-block");
        wrapper.style.setProperty("position", "relative");
        wrapper.style.setProperty("vertical-align", "middle");
        wrapper.appendChild(image);
        for (const overlay of part.overlays) {
          if (!isAllowedImageUrl(overlay.url)) continue;
          const overlayImage = document.createElement("img");
          overlayImage.setAttribute("class", "chat-emote chat-emote-overlay");
          overlayImage.setAttribute("data-chatwerk-emote", "true");
          if (gigantified) overlayImage.setAttribute("data-gigantified", "true");
          overlayImage.setAttribute("src", overlay.url);
          overlayImage.setAttribute("alt", overlay.name);
          overlayImage.setAttribute("decoding", "async");
          setEmoteImageHeight(overlayImage, theme, gigantified);
          overlayImage.style.setProperty("position", "absolute");
          overlayImage.style.setProperty("inset", "0");
          overlayImage.style.setProperty("z-index", "1");
          wrapper.appendChild(overlayImage);
        }
        message.appendChild(wrapper);
      } else message.appendChild(image);
    } else {
      message.appendChild(document.createTextNode(part.name));
    }
  }
}

function hasNewEmoteCoverage(previous: MessagePart[], next: MessagePart[]): boolean {
  const previousRanges = emoteCoverage(previous);
  const nextRanges = emoteCoverage(next);
  return nextRanges.some((range) => !isRangeCovered(previousRanges, range.start, range.end)) &&
    previousRanges.every((range) => isRangeCovered(nextRanges, range.start, range.end));
}

function emoteCoverage(parts: MessagePart[]): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let offset = 0;
  for (const part of parts) {
    if (part.type === "text") {
      offset += part.value.length;
      continue;
    }
    const end = offset + part.name.length + (part.overlays?.reduce((total, overlay) => total + overlay.name.length, 0) ?? 0);
    ranges.push({ start: offset, end });
    offset = end;
  }
  return ranges;
}

function isRangeCovered(ranges: Array<{ start: number; end: number }>, start: number, end: number): boolean {
  let cursor = start;
  for (const range of ranges) {
    if (range.end <= cursor) continue;
    if (range.start > cursor) return false;
    cursor = Math.max(cursor, range.end);
    if (cursor >= end) return true;
  }
  return cursor >= end;
}

function isExpectedBadgeHost(value: string, hostname: string): boolean {
  if (!isAllowedImageUrl(value)) return false;
  try {
    return new URL(value).hostname.toLowerCase() === hostname;
  } catch {
    return false;
  }
}

function applyNamePaint(name: HTMLElement, paint: PaintStyle | undefined, fallbackColor: string): void {
  name.classList.toggle("chat-name-painted", Boolean(paint));
  name.style.removeProperty("background-image");
  name.style.removeProperty("background-clip");
  name.style.removeProperty("-webkit-background-clip");
  name.style.removeProperty("filter");
  if (!paint) {
    name.style.setProperty("color", fallbackColor);
    return;
  }
  if (paint.type === "solid") {
    name.style.setProperty("color", paint.value);
    if (paint.filter) name.style.setProperty("filter", paint.filter);
    return;
  }
  name.style.setProperty("color", "transparent");
  name.style.setProperty("background-image", paint.value);
  name.style.setProperty("background-clip", "text");
  name.style.setProperty("-webkit-background-clip", "text");
  if (paint.filter) name.style.setProperty("filter", paint.filter);
}

function nameColorFor(event: CommonMessage, theme: ThemeConfig, highlighted = false): string {
  if (theme.nameColorMode !== "tag") return theme.textColor;
  if (theme.readableNames) {
    const color = isValidColor(event.color) ? event.color : theme.textColor;
    return ensureReadableNameColor(color, readableNameBackground(theme, highlighted));
  }
  return isValidColor(event.color) ? ensureTagColorContrast(event.color, theme) : theme.textColor;
}

function readableNameBackground(theme: ThemeConfig, highlighted: boolean): string {
  if (highlighted) return theme.highlightBackgroundColor;
  const colorAlpha = theme.backgroundColor.length === 9
    ? Number.parseInt(theme.backgroundColor.slice(7, 9), 16) / 255
    : 1;
  if (theme.backgroundOpacity * colorAlpha < LEGIBILITY_OUTLINE_OPACITY_THRESHOLD && theme.panelEnabled) {
    return theme.panelBackgroundColor;
  }
  return theme.backgroundColor;
}

function applyLineThemeClasses(row: HTMLElement, theme: ThemeConfig): void {
  row.classList.toggle("chat-name-own-line", theme.layout === "stack" && theme.nameOnOwnLine);
  row.classList.toggle("chat-small-caps", theme.smallCaps);
  row.classList.toggle("chat-hide-names", theme.hideNames);
  row.classList.toggle("chat-readable-names", theme.readableNames && theme.nameColorMode === "tag");
  row.querySelector<HTMLElement>(".chat-name")?.classList.toggle("chat-sr-only", theme.hideNames);
}

function isHighlighted(row: HTMLElement): boolean {
  return row.classList.contains("chat-highlighted") || row.classList.contains("chat-reaction-highlight");
}

function setEmoteImageHeight(image: HTMLImageElement, theme: ThemeConfig, gigantified = false): void {
  const scale = gigantified ? theme.gigantifiedScale : theme.emoteScale;
  const height = Math.max(1, Math.round(theme.fontSize * scale));
  image.setAttribute("height", String(height));
  image.style.setProperty("height", `${height}px`);
  image.style.setProperty("width", image.classList.contains("chat-emote-overlay") ? "100%" : "auto");
  image.style.setProperty("vertical-align", "middle");
}

function isGigantified(event: CommonMessage): boolean {
  return event.tags["msg-param-power-up-type"] === "gigantify_an_emote" ||
    event.tags["msg-param-power-up-name"] === "Gigantify an Emote";
}

function timestampFromMessage(event: CommonMessage): number {
  const sentAt = event.tags["tmi-sent-ts"];
  if (sentAt && /^\d{1,16}$/u.test(sentAt)) {
    const timestamp = Number(sentAt);
    if (Number.isSafeInteger(timestamp) && timestamp >= 0) return timestamp;
  }
  return Date.now();
}

function messageAlias(event: CommonMessage, localId: string): MessageAlias {
  const room = event.roomId || normalizeChannels([event.channel])[0] || event.channel.toLowerCase();
  const id = event.id ?? (event.sourceId ? `source:${event.sourceId}` : localId);
  return { key: aliasKey(room, id), room, id };
}

function moderationRoom(tags: Record<string, string>, channel: string): string {
  return tags["room-id"] || normalizeChannels([channel])[0] || channel.toLowerCase();
}

function moderationTimestamp(tags: Record<string, string>): number {
  const value = tags["tmi-sent-ts"];
  if (value && /^\d{1,16}$/u.test(value)) {
    const timestamp = Number(value);
    if (Number.isSafeInteger(timestamp) && timestamp >= 0) return timestamp;
  }
  return Date.now();
}

function aliasKey(room: string, id: string | null): string {
  return `${room}\u0000${id ?? ""}`;
}

function normalizeChannels(channels: string[]): string[] {
  return [...new Set(channels.map((channel) => channel.toLowerCase().replace(/^#/u, "")))].filter(Boolean).slice(0, 5);
}
