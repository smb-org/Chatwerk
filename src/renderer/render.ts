import {
  DEFAULTS,
  ensureTagColorContrast,
  effectiveOutline,
  isValidColor,
  themeCssVariables,
  themeRowBackground,
  type ThemeConfig,
} from "../shared/theme";
import type { CommonMessage, IrcEvent } from "./irc-parse";
import { splitMessage, type EmoteLookup } from "./emotes";
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
}

interface RenderedLine {
  node: HTMLElement;
  id: string | null;
  sourceId: string | null;
  channel: string;
  event: CommonMessage;
  userLogin: string;
  userId: string | null;
  lifetimeTimer: ReturnType<typeof setTimeout> | undefined;
  removalTimer: ReturnType<typeof setTimeout> | undefined;
}

export interface ChatRenderer {
  handle(event: IrcEvent): void;
  setTheme(theme: ThemeConfig): void;
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
  let scheduled = false;
  let scheduleHandle: unknown;
  const lines = new Set<RenderedLine>();
  const linesById = new Map<string, RenderedLine>();
  const linesBySourceId = new Map<string, RenderedLine>();
  const unsubscribePaints = options.paints?.subscribe((userId) => refreshPaints(userId));

  const applyTheme = (): void => {
    root.dataset.lineOrder = theme.lineOrder;
    for (const [name, value] of Object.entries(themeCssVariables(theme))) root.style.setProperty(name, value);
    root.style.setProperty("--t-row-background", themeRowBackground(theme));
    const outline = effectiveOutline(theme);
    root.style.setProperty("--t-outline", `${outline.width}px`);
    root.style.setProperty("--t-outline-color", outline.color);
    for (const image of root.querySelectorAll<HTMLImageElement>("img[data-chatwerk-emote]")) setEmoteImageHeight(image, theme);
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
    if (line.id && linesById.get(line.id) === line) linesById.delete(line.id);
    if (line.sourceId && linesBySourceId.get(line.sourceId) === line) linesBySourceId.delete(line.sourceId);
    line.node.remove();
  };

  const flush = (): void => {
    scheduled = false;
    scheduleHandle = undefined;
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
      if (line.record.id) linesById.set(line.record.id, line.record);
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

  const dropQueued = (predicate: (event: CommonMessage) => boolean): void => {
    pending = pending.filter(({ event }) => !predicate(event));
  };

  const enforceCapacity = (): void => {
    while (lines.size + pending.length >= limit) {
      const oldest = lines.values().next().value as RenderedLine | undefined;
      if (oldest) removeLine(oldest);
      else pending.shift();
    }
  };

  const handle = (event: IrcEvent): void => {
    if (event.type === "PRIVMSG" || event.type === "USERNOTICE") {
      if (event.sourceId && (linesBySourceId.has(event.sourceId) || pending.some(({ event: queued }) => queued.sourceId === event.sourceId))) return;
      if (event.id) {
        const previous = linesById.get(event.id);
        if (previous?.channel === event.channel.toLowerCase()) removeLine(previous);
        dropQueued((queued) => queued.id === event.id && queued.channel.toLowerCase() === event.channel.toLowerCase());
      }
      enforceCapacity();
      pending.push({ event, receivedAt: Date.now() });
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
        const line = linesById.get(event.messageId);
        if (line?.channel === event.channel.toLowerCase()) removeLine(line);
        dropQueued((queued) => queued.id === event.messageId && queued.channel.toLowerCase() === event.channel.toLowerCase());
      }
      return;
    }
    if (event.type === "CLEARCHAT") {
      if (!event.target && !event.targetUserId) {
        for (const line of [...lines]) removeLine(line);
        pending = [];
      } else {
        const target = event.target?.toLowerCase();
        const targetUserId = event.targetUserId;
        for (const line of [...lines]) {
          if (line.channel === event.channel.toLowerCase() &&
            (targetUserId ? line.userId === targetUserId : line.userLogin.toLowerCase() === target)) removeLine(line);
        }
        dropQueued((queued) => targetUserId
          ? queued.channel.toLowerCase() === event.channel.toLowerCase() && queued.tags["user-id"] === targetUserId
          : queued.channel.toLowerCase() === event.channel.toLowerCase() && queued.userLogin?.toLowerCase() === target);
      }
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

  applyTheme();
  return {
    handle,
    setTheme(nextTheme) {
      theme = nextTheme;
      applyTheme();
    },
    dispose() {
      if (scheduled && scheduleHandle !== undefined) cancel(scheduleHandle);
      scheduled = false;
      pending = [];
      for (const line of [...lines]) removeLine(line);
      root.replaceChildren();
      linesById.clear();
      linesBySourceId.clear();
      unsubscribePaints?.();
      options.emotes?.dispose();
      options.badges?.dispose();
      options.paints?.dispose();
      options.pronouns?.dispose();
    },
  };

  function buildLine(event: CommonMessage, document: Document, config: ThemeConfig): { node: HTMLElement; record: RenderedLine } {
    const row = document.createElement("div");
    row.setAttribute("class", "chat-line");
    row.style.setProperty("font-family", "var(--t-font-family)");
    row.style.setProperty("font-size", "var(--t-font-size)");
    row.style.setProperty("font-weight", "var(--t-font-weight)");
    row.style.setProperty("gap", "var(--t-spacing)");
    row.style.setProperty("background-color", "var(--t-row-background)");
    row.style.setProperty("-webkit-text-stroke-width", "var(--t-outline)");
    row.style.setProperty("-webkit-text-stroke-color", "var(--t-outline-color)");
    row.style.setProperty("opacity", "1");
    row.style.setProperty("transform", "translateY(0)");
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
    for (const part of splitMessage(text, event.emotes, options.emotes, !foreignRoom)) {
      if (part.type === "text") {
        message.appendChild(document.createTextNode(part.value));
      } else if (isAllowedImageUrl(part.url)) {
        const image = document.createElement("img");
        image.setAttribute("class", "chat-emote");
        image.setAttribute("data-chatwerk-emote", "true");
        image.setAttribute("src", part.url);
        image.setAttribute("alt", part.name);
        image.setAttribute("decoding", "async");
        setEmoteImageHeight(image, config);
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
            overlayImage.setAttribute("src", overlay.url);
            overlayImage.setAttribute("alt", overlay.name);
            overlayImage.setAttribute("decoding", "async");
            setEmoteImageHeight(overlayImage, config);
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
    if (config.lineOrder === "message-first") {
      row.appendChild(message);
      row.appendChild(badges);
      row.appendChild(name);
      row.appendChild(pronouns);
      row.appendChild(sourceRoom);
    } else {
      row.appendChild(badges);
      row.appendChild(name);
      row.appendChild(pronouns);
      row.appendChild(sourceRoom);
      row.appendChild(message);
    }
    const record: RenderedLine = {
      node: row,
      id: event.id,
      sourceId: event.sourceId,
      channel: event.channel.toLowerCase(),
      event,
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

function setEmoteImageHeight(image: HTMLImageElement, theme: ThemeConfig): void {
  const height = Math.max(1, Math.round(theme.fontSize * theme.emoteScale));
  image.setAttribute("height", String(height));
  image.style.setProperty("height", `${height}px`);
  image.style.setProperty("width", "auto");
  image.style.setProperty("vertical-align", "middle");
}
