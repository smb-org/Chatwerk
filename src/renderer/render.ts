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

export interface ChatRendererOptions {
  root: HTMLElement;
  theme?: ThemeConfig;
  nodeLimit?: number;
  scheduler?: (callback: () => void) => unknown;
  cancelScheduled?: (handle: unknown) => void;
}

interface PendingMessage {
  event: CommonMessage;
  receivedAt: number;
}

interface RenderedLine {
  node: HTMLElement;
  id: string | null;
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

  const applyTheme = (): void => {
    root.dataset.lineOrder = theme.lineOrder;
    for (const [name, value] of Object.entries(themeCssVariables(theme))) root.style.setProperty(name, value);
    root.style.setProperty("--t-row-background", themeRowBackground(theme));
    const outline = effectiveOutline(theme);
    root.style.setProperty("--t-outline", `${outline.width}px`);
    root.style.setProperty("--t-outline-color", outline.color);
  };

  const removeLine = (line: RenderedLine): void => {
    if (line.lifetimeTimer !== undefined) clearTimeout(line.lifetimeTimer);
    if (line.removalTimer !== undefined) clearTimeout(line.removalTimer);
    lines.delete(line);
    if (line.id && linesById.get(line.id) === line) linesById.delete(line.id);
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
      if (event.id) {
        const previous = linesById.get(event.id);
        if (previous) removeLine(previous);
        dropQueued((queued) => queued.id === event.id);
      }
      enforceCapacity();
      pending.push({ event, receivedAt: Date.now() });
      scheduleFlush();
      return;
    }
    if (event.type === "CLEARMSG") {
      if (event.messageId) {
        const line = linesById.get(event.messageId);
        if (line) removeLine(line);
        dropQueued((queued) => queued.id === event.messageId);
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
          if (targetUserId ? line.userId === targetUserId : line.userLogin.toLowerCase() === target) removeLine(line);
        }
        dropQueued((queued) => targetUserId
          ? queued.tags["user-id"] === targetUserId
          : queued.userLogin?.toLowerCase() === target);
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
    const color = config.nameColorMode === "tag" && isValidColor(event.color)
      ? ensureTagColorContrast(event.color, config)
      : config.textColor;
    name.style.setProperty("color", color);
    const message = document.createElement("span");
    message.setAttribute("class", "chat-message");
    message.textContent = event.text || event.tags["system-msg"] || "";
    if (config.lineOrder === "message-first") {
      row.appendChild(message);
      row.appendChild(name);
    } else {
      row.appendChild(name);
      row.appendChild(message);
    }
    const record: RenderedLine = {
      node: row,
      id: event.id,
      userLogin: event.userLogin ?? "",
      userId: event.tags["user-id"] ?? null,
      lifetimeTimer: undefined,
      removalTimer: undefined,
    };
    return { node: row, record };
  }
}
