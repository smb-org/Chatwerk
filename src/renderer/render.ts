import {
  DEFAULTS,
  ensureTagColorContrast,
  effectiveOutline,
  isValidColor,
  themeCssVariables,
  themeRowBackground,
  type ThemeConfig,
} from "../shared/theme";
import { shouldFilterMessage } from "./filters";
import { BoundedTickerQueue } from "./ticker-queue";
import type { CommonMessage, IrcEvent } from "./irc-parse";
import { parseReactionEvent } from "./irc-parse";
import { splitMessage, type EmoteLookup } from "./emotes";
import { createReactionEffects } from "./reactions";
import { isAllowedImageUrl } from "../shared/hosts";
import type { BadgeLookup } from "./badges";
import type { PaintLookup, PaintStyle } from "./paints";
import type { PronounLookup } from "./pronouns";

export interface ChatRendererOptions {
  root: HTMLElement;
  theme?: ThemeConfig;
  nodeLimit?: number;
  scheduler?: (callback: () => void) => unknown;
  cancelScheduled?: (handle: unknown) => void;
  emotes?: EmoteLookup;
  badges?: BadgeLookup;
  paints?: PaintLookup;
  pronouns?: PronounLookup;
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
  sourceId: string | null;
  channel: string;
  aliases: Map<string, MessageAlias>;
  channelMarker: HTMLElement;
  event: CommonMessage;
  receivedAt: number;
  tickerWidth: number;
  userLogin: string;
  userId: string | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  removalTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface ChatRenderer {
  handle(event: IrcEvent): void;
  setTheme(theme: ThemeConfig): void;
  setChannels(channels: string[]): void;
  clear(): void;
  dispose(): void;
}

const MAX_NODE_LIMIT = 300;
const DEFAULT_NODE_LIMIT = 100;
const FADE_DURATION_MS = 200;

export function createChatRenderer(options: ChatRendererOptions): ChatRenderer {
  const { root } = options;
  const limit = Math.min(MAX_NODE_LIMIT, Math.max(1, Math.floor(options.nodeLimit ?? DEFAULT_NODE_LIMIT)));
  const schedule = options.scheduler ?? ((callback: () => void) => setTimeout(callback, 16));
  const cancel = options.cancelScheduled ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  let theme = options.theme ?? DEFAULTS;
  let pending: PendingMessage[] = [];
  let localMessageId = 0;
  const tickerQueue = new BoundedTickerQueue<PendingMessage>(limit);
  let tickerActive: RenderedLine | undefined;
  let activeChannels = normalizeChannels(theme.channels);
  let scheduled = false;
  let scheduleHandle: unknown;
  const lines = new Set<RenderedLine>();
  const linesByAlias = new Map<string, RenderedLine>();
  const linesBySourceId = new Map<string, RenderedLine>();
  const reactionEffects = createReactionEffects({ root, theme, emotes: options.emotes });
  const unsubscribePaints = options.paints?.subscribe((userId) => refreshPaints(userId));

  const applyTheme = (): void => {
    root.dataset.lineOrder = theme.lineOrder;
    root.dataset.layout = theme.layout;
    root.dataset.motion = theme.motion;
    for (const [name, value] of Object.entries(themeCssVariables(theme))) root.style.setProperty(name, value);
    root.style.setProperty("--t-row-background", themeRowBackground(theme));
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
      const badgeContainer = line.node.querySelector<HTMLElement>(".chat-badges");
      if (badgeContainer) {
        if (theme.showBadges) appendBadgeImages(badgeContainer, line.event, theme, options.badges, true);
        else badgeContainer.replaceChildren();
      }
      const pronounContainer = line.node.querySelector<HTMLElement>(".chat-pronouns");
      if (!theme.showPronouns && pronounContainer) pronounContainer.textContent = "";
      else if (theme.showPronouns && pronounContainer && !pronounContainer.textContent && options.pronouns && line.userLogin) {
        void options.pronouns.lookup(line.userLogin).then((value) => {
          if (value && pronounContainer.isConnected) pronounContainer.textContent = ` (${value})`;
        });
      }
      const name = line.node.querySelector<HTMLElement>(".chat-name");
      if (name) applyNamePaint(name, options.paints?.resolve(line.userId ?? ""), nameColorFor(line.event, theme));
    }
  };

  const removeLine = (line: RenderedLine): void => {
    if (line.lifetimeTimer !== undefined) clearTimeout(line.lifetimeTimer);
    if (line.removalTimer !== undefined) clearTimeout(line.removalTimer);
    lines.delete(line);
    for (const key of line.aliases.keys()) {
      reactionEffects.detachLine(key);
      if (linesByAlias.get(key) === line) linesByAlias.delete(key);
    }
    if (line.sourceId && linesBySourceId.get(line.sourceId) === line) linesBySourceId.delete(line.sourceId);
    if (tickerActive === line) tickerActive = undefined;
    line.node.remove();
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
    const batch = pending;
    pending = [];
    const fragment = root.ownerDocument.createDocumentFragment();
    const now = Date.now();
    for (const item of batch) {
      const remainingLifetime = theme.lifetime - (now - item.receivedAt);
      if (remainingLifetime <= 0) continue;
      const event = item.event;
      const line = buildLine(event, root.ownerDocument, theme);
      lines.add(line.record);
      addLineAliases(line.record, item.aliases);
      for (const key of item.aliases.keys()) reactionEffects.attachLine(key, line.node);
      if (line.record.sourceId) linesBySourceId.set(line.record.sourceId, line.record);
      line.record.node = line.node;
      fragment.appendChild(line.node);
      armLifetime(line.record, remainingLifetime);
    }
    root.appendChild(fragment);
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
    tickerActive = undefined;
    pending = [];
    tickerQueue.clear();
    if (nextLayout === "ticker") {
      for (const item of messages) tickerQueue.enqueue(item);
    } else {
      pending = messages;
    }
  }

  const enforceCapacity = (): void => {
    while (lines.size + pending.length >= limit) {
      const oldest = lines.values().next().value as RenderedLine | undefined;
      if (oldest) removeLine(oldest);
      else pending.shift();
    }
  };

  const handle = (event: IrcEvent): void => {
    if (event.type === "PRIVMSG" || event.type === "USERNOTICE") {
      if (shouldFilterMessage(event, theme)) return;
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
        if (previous) removeAlias(previous, alias.key);
        removeQueuedAlias(alias.key);
        reactionEffects.cancelAlias(alias.key);
      }
      if (reaction) reactionEffects.enqueue(event, reaction, alias);
      const item: PendingMessage = { event, receivedAt: Date.now(), aliases: new Map([[alias.key, alias]]) };
      if (theme.layout === "ticker") {
        tickerQueue.enqueue(item);
      } else {
        enforceCapacity();
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
      if (event.tags["user-id"] && options.paints) {
        void options.paints.load(event.tags["user-id"]).then(() => refreshPaints(event.tags["user-id"]));
      }
      return;
    }
    if (event.type === "CLEARMSG") {
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
    pending = [];
    tickerQueue.clear();
    tickerActive = undefined;
    reactionEffects.clear();
    for (const line of [...lines]) removeLine(line);
    root.replaceChildren();
    linesByAlias.clear();
    linesBySourceId.clear();
  };

  applyTheme();
  return {
    handle,
    setTheme(nextTheme) {
      const previousLayout = theme.layout;
      const previousMotion = theme.motion;
      if (previousLayout !== nextTheme.layout) changeLayout(nextTheme.layout);
      else if (previousLayout === "ticker" && previousMotion !== nextTheme.motion) {
        changeLayout("stack");
        changeLayout("ticker");
      }
      theme = nextTheme;
      if (theme.channels.length > 0) activeChannels = normalizeChannels(theme.channels);
      applyTheme();
      if (theme.layout === "ticker" && tickerActive && theme.motion === "none") scheduleFlush();
      if (theme.layout === "ticker" && !tickerActive && tickerQueue.size > 0) scheduleFlush();
      if (theme.layout === "stack" && pending.length > 0) scheduleFlush();
    },
    setChannels(channels) {
      activeChannels = normalizeChannels(channels);
      for (const line of lines) updateChannelMarker(line);
    },
    clear,
    dispose() {
      clear();
      reactionEffects.dispose();
      unsubscribePaints?.();
      options.emotes?.dispose();
      options.badges?.dispose();
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
    const highlighted = event.tags["msg-id"] === "highlighted-message";
    const gigantified = isGigantified(event);
    if (highlighted) row.classList.add("chat-highlighted");
    if (gigantified) row.classList.add("chat-gigantified");
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
    const displayName = event.displayName?.trim() || event.userLogin || "system";
    name.textContent = displayName;
    const color = nameColorFor(event, config);
    name.style.setProperty("color", color);
    const userId = event.tags["user-id"] ?? "";
    applyNamePaint(name, options.paints?.resolve(userId), color);
    const pronouns = document.createElement("span");
    pronouns.setAttribute("class", "chat-pronouns");
    if (config.showPronouns && options.pronouns && event.userLogin) {
      void options.pronouns.lookup(event.userLogin).then((value) => {
        if (value && name.isConnected) pronouns.textContent = ` (${value})`;
      });
    }
    const message = document.createElement("span");
    message.setAttribute("class", "chat-message");
    const text = event.text || event.tags["system-msg"] || "";
    const foreignRoom = Boolean(event.sourceRoomId && event.roomId && event.sourceRoomId !== event.roomId);
    const emoteRoomId = foreignRoom ? event.sourceRoomId ?? undefined : event.roomId ?? undefined;
    const parts = splitMessage(text, event.emotes, options.emotes, !foreignRoom, emoteRoomId);
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
        setEmoteImageHeight(image, config, gigantified);
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
            setEmoteImageHeight(overlayImage, config, gigantified);
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
    const badges = document.createElement("span");
    badges.setAttribute("class", "chat-badges");
    appendBadgeImages(badges, event, config, options.badges);
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
    if (config.lineOrder === "message-first") {
      row.appendChild(message);
      row.appendChild(badges);
      row.appendChild(name);
      row.appendChild(pronouns);
      row.appendChild(sourceRoom);
      row.appendChild(channelMarker);
    } else {
      row.appendChild(badges);
      row.appendChild(name);
      row.appendChild(pronouns);
      row.appendChild(sourceRoom);
      row.appendChild(channelMarker);
      row.appendChild(message);
    }
    const record: RenderedLine = {
      node: row,
      sourceId: event.sourceId,
      channel: event.channel.toLowerCase(),
      aliases: new Map(),
      channelMarker,
      event,
      receivedAt,
      tickerWidth: measureTickerWidth(event, config, parts, displayName, badges, sourceRoom, channelMarker, document),
      userLogin: event.userLogin ?? "",
      userId: event.tags["user-id"] ?? null,
      lifetimeTimer: undefined,
      removalTimer: undefined,
    };
    return { node: row, record };
  }

  function refreshBadges(): void {
    if (!theme.showBadges || !options.badges) return;
    for (const line of lines) {
      const target = line.node.querySelector<HTMLElement>(".chat-badges");
      if (target) appendBadgeImages(target, line.event, theme, options.badges, true);
    }
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
    const badgeCount = badges.querySelectorAll(".chat-badge").length;
    const badgeWidth = badgeCount * config.fontSize + Math.max(0, badgeCount - 1) * config.fontSize * 0.15;
    const visibleWidths = [messageWidth, measure(displayName)];
    if (badgeCount > 0) visibleWidths.push(badgeWidth);
    if (sourceRoom.textContent) visibleWidths.push(measure(sourceRoom.textContent));
    if (!channelMarker.hidden) visibleWidths.push(measure(channelMarker.textContent ?? ""));
    if (config.showPronouns && event.userLogin) visibleWidths.push(measure(` (${event.userLogin})`));
    return Math.ceil(visibleWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, visibleWidths.length - 1) * config.spacing);
  }

  function refreshPaints(userId?: string): void {
    for (const line of lines) {
      if (userId && line.userId !== userId) continue;
      const name = line.node.querySelector<HTMLElement>(".chat-name");
      if (name) applyNamePaint(name, options.paints?.resolve(line.userId ?? ""), nameColorFor(line.event, theme));
    }
  }
}

function appendBadgeImages(
  container: HTMLElement,
  event: CommonMessage,
  theme: ThemeConfig,
  badges: BadgeLookup | undefined,
  replace = false,
): void {
  if (!theme.showBadges || !badges) return;
  if (replace) container.replaceChildren();
  const broadcasterId = event.sourceRoomId && event.sourceRoomId !== event.roomId ? event.sourceRoomId : event.roomId;
  for (const badge of badges.resolve(event.badges, broadcasterId)) {
    if (!isAllowedImageUrl(badge.url)) continue;
    const image = container.ownerDocument.createElement("img");
    image.setAttribute("class", "chat-badge");
    image.setAttribute("src", badge.url);
    image.setAttribute("alt", `${badge.name} ${badge.version}`);
    image.setAttribute("title", `${badge.name} ${badge.version}`);
    image.setAttribute("decoding", "async");
    image.setAttribute("height", String(Math.round(theme.fontSize)));
    image.style.setProperty("height", `${theme.fontSize}px`);
    image.style.setProperty("width", "auto");
    container.appendChild(image);
  }
}

function applyNamePaint(name: HTMLElement, paint: PaintStyle | undefined, fallbackColor: string): void {
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

function nameColorFor(event: CommonMessage, theme: ThemeConfig): string {
  return theme.nameColorMode === "tag" && isValidColor(event.color)
    ? ensureTagColorContrast(event.color, theme)
    : theme.textColor;
}

function setEmoteImageHeight(image: HTMLImageElement, theme: ThemeConfig, gigantified = false): void {
  const scale = gigantified ? theme.gigantifiedScale : theme.emoteScale;
  const height = Math.max(1, Math.round(theme.fontSize * scale));
  image.setAttribute("height", String(height));
  image.style.setProperty("height", `${height}px`);
  image.style.setProperty("width", "auto");
  image.style.setProperty("vertical-align", "middle");
}

function isGigantified(event: CommonMessage): boolean {
  return event.tags["msg-param-power-up-type"] === "gigantify_an_emote" ||
    event.tags["msg-param-power-up-name"] === "Gigantify an Emote";
}

function messageAlias(event: CommonMessage, localId: string): MessageAlias {
  const room = event.roomId || normalizeChannels([event.channel])[0] || event.channel.toLowerCase();
  const id = event.id ?? (event.sourceId ? `source:${event.sourceId}` : localId);
  return { key: aliasKey(room, id), room, id };
}

function moderationRoom(tags: Record<string, string>, channel: string): string {
  return tags["room-id"] || normalizeChannels([channel])[0] || channel.toLowerCase();
}

function aliasKey(room: string, id: string | null): string {
  return `${room}\u0000${id ?? ""}`;
}

function normalizeChannels(channels: string[]): string[] {
  return [...new Set(channels.map((channel) => channel.toLowerCase().replace(/^#/u, "")))].filter(Boolean).slice(0, 5);
}
