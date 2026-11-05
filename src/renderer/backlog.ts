import type { ThemeConfig } from "../shared/theme";
import { shouldFilterMessage } from "./filters";
import { parseIrcLine, type CommonMessage } from "./irc-parse";

export interface BacklogMessage {
  event: CommonMessage;
  receivedAt: number;
}

export interface BacklogFetchOptions {
  fetcher?: typeof fetch;
  now?: number;
  timeoutMs?: number;
  live?: boolean;
  signal?: AbortSignal;
}

const BACKLOG_URL = "https://recent-messages.robotty.de/api/v2/recent-messages";
const DEFAULT_TIMEOUT_MS = 1_800;
const MAX_BACKLOG_BYTES = 2 * 1024 * 1024;
const MAX_BACKLOG_MESSAGES = 500;
const MAX_BACKLOG_LINE_BYTES = 8 * 1024;

/** Fetch and validate recent IRC history without holding up the live IRC connection. */
export async function fetchRecentBacklog(
  channels: string[],
  theme: ThemeConfig,
  options: BacklogFetchOptions = {},
): Promise<BacklogMessage[]> {
  if (!theme.backlog || theme.layout === "ticker" || options.live === false || channels.length === 0) return [];
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now();
  const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const selected = [...new Set(channels.map(normalizeChannel).filter(isValidChannel))].slice(0, 5);
  if (selected.length === 0) return [];

  const responses = await Promise.all(selected.map(async (channel) => {
    if (options.signal?.aborted) return [];
    const controller = new AbortController();
    const abortFromParent = (): void => controller.abort();
    options.signal?.addEventListener("abort", abortFromParent, { once: true });
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const url = `${BACKLOG_URL}/${encodeURIComponent(channel)}?limit=${theme.maxLines}`;
      const response = await fetcher(url, { mode: "cors", signal: controller.signal });
      if (!response.ok) return [];
      const payload = await readBoundedJson(response);
      return parseBacklogPayload(payload, now, theme, channel);
    } catch {
      // History is optional. Failed and timed-out requests leave live chat unaffected.
      return [];
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromParent);
    }
  }));

  const merged = responses.flat().sort((left, right) => left.receivedAt - right.receivedAt);
  const ids = new Set<string>();
  const unique = merged.filter(({ event }) => {
    if (!event.id) return true;
    if (ids.has(event.id)) return false;
    ids.add(event.id);
    return true;
  });
  return unique.slice(-theme.maxLines);
}

export function parseBacklogPayload(value: unknown, now: number, theme: ThemeConfig, requestedChannel: string): BacklogMessage[] {
  if (!isRecord(value) || !Array.isArray(value.messages)) return [];
  const result: BacklogMessage[] = [];
  for (const rawLine of value.messages.slice(0, MAX_BACKLOG_MESSAGES)) {
    if (typeof rawLine !== "string" || new TextEncoder().encode(rawLine).byteLength > MAX_BACKLOG_LINE_BYTES) continue;
    const event = parseIrcLine(rawLine);
    if (!event || (event.type !== "PRIVMSG" && event.type !== "USERNOTICE")) continue;
    if (normalizeChannel(event.channel) !== normalizeChannel(requestedChannel)) continue;
    if (Object.hasOwn(event.tags, "rm-deleted") || shouldFilterMessage(event, theme)) continue;
    // ponytail: robotty is trusted for display; stripping Shared Chat decoration limits tag spoofing, but the service can forge message text too.
    for (const tag of Object.keys(event.tags)) {
      if (tag.startsWith("source-")) delete event.tags[tag];
    }
    event.sourceRoomId = null;
    event.sourceId = null;
    event.historical = true;
    const receivedAt = timestampFromTags(event.tags) ?? now;
    const age = Math.max(0, now - receivedAt);
    if (!theme.neverFade && age >= theme.lifetime) continue;
    result.push({ event, receivedAt });
  }
  return result.sort((left, right) => left.receivedAt - right.receivedAt);
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const contentLength = Number(response.headers.get("content-length"));
  const body = response.body;
  if (!body) return null;
  if (Number.isFinite(contentLength) && contentLength > MAX_BACKLOG_BYTES) {
    await body.cancel().catch(() => undefined);
    return null;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteLength += value.byteLength;
      if (byteLength > MAX_BACKLOG_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return null;
  }
}

function timestampFromTags(tags: Record<string, string>): number | null {
  for (const key of ["tmi-sent-ts", "rm-received-ts"]) {
    const value = tags[key];
    if (!value || !/^\d{1,16}$/u.test(value)) continue;
    const timestamp = Number(value);
    if (Number.isSafeInteger(timestamp) && timestamp >= 0) return timestamp;
  }
  return null;
}

function normalizeChannel(value: string): string {
  return value.toLowerCase().replace(/^#/u, "");
}

function isValidChannel(value: string): boolean {
  return /^[a-z0-9_]{1,25}$/u.test(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
