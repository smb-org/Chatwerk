import { isValidColor } from "../shared/theme";

export interface IrcBadge {
  name: string;
  version: string;
}

export interface EmoteRange {
  start: number;
  end: number;
}

export interface IrcEmote {
  id: string;
  ranges: EmoteRange[];
}

export interface CommonMessage {
  type: "PRIVMSG" | "USERNOTICE";
  channel: string;
  userLogin: string | null;
  id: string | null;
  roomId: string | null;
  sourceRoomId: string | null;
  sourceRoomName?: string;
  sourceRoomLogo?: string | null;
  sourceId: string | null;
  displayName: string | null;
  color: string | null;
  badges: IrcBadge[];
  emotes: IrcEmote[];
  text: string;
  tags: Record<string, string>;
  historical?: boolean;
}

export type ReactionType = "raid" | "sub" | "resub" | "subgift" | "bits" | "hype";

export interface ParsedReactionEvent {
  type: ReactionType;
  amount: number | null;
}

export type IrcEvent =
  | CommonMessage
  | { type: "CLEARCHAT"; channel: string; target: string | null; targetUserId: string | null; tags: Record<string, string> }
  | { type: "CLEARMSG"; channel: string; messageId: string | null; text: string; tags: Record<string, string> }
  | { type: "ROOMSTATE"; channel: string; tags: Record<string, string> }
  | { type: "PING"; payload: string }
  | { type: "RECONNECT" }
  | { type: "NOTICE"; messageId: string | null; text: string; tags: Record<string, string> };

export function unescapeTagValue(value: string): string {
  return value.replace(/\\([snr:\\])/gu, (_match, escape: string) => {
    switch (escape) {
      case "s": return " ";
      case ":": return ";";
      case "\\": return "\\";
      case "r": return "\r";
      case "n": return "\n";
      default: return escape;
    }
  });
}

export function parseIrcLine(input: string): IrcEvent | null {
  const line = input.replace(/[\r\n]+$/u, "");
  if (line.startsWith("PING ")) return { type: "PING", payload: line.slice(5).replace(/^:/u, "") };

  let rest = line;
  let tags: Record<string, string> = {};
  if (rest.startsWith("@")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    tags = parseTags(rest.slice(1, end));
    rest = rest.slice(end + 1).trimStart();
  }

  let prefix = "";
  if (rest.startsWith(":")) {
    const end = rest.indexOf(" ");
    if (end < 0) return null;
    prefix = rest.slice(1, end);
    rest = rest.slice(end + 1).trimStart();
  }
  const commandEnd = rest.indexOf(" ");
  const command = (commandEnd < 0 ? rest : rest.slice(0, commandEnd)).toUpperCase();
  if (!command) return null;
  const { params, trailing } = parseParams(commandEnd < 0 ? "" : rest.slice(commandEnd + 1));
  const channel = params[0] ?? "";
  const text = trailing ?? params[1] ?? "";

  if (command === "RECONNECT") return { type: "RECONNECT" };
  if (command === "PRIVMSG" || command === "USERNOTICE") {
    if (!channel) return null;
    const userLogin = tags.login ?? /^([^!@\s]+)/u.exec(prefix)?.[1] ?? null;
    return {
      type: command,
      channel,
      userLogin,
      id: tags.id ?? null,
      roomId: tags["room-id"] ?? null,
      sourceRoomId: tags["source-room-id"] ?? null,
      sourceId: tags["source-id"] ?? null,
      displayName: tags["display-name"] ?? null,
      color: tags.color && isValidColor(tags.color) ? tags.color : null,
      badges: parseBadges(tags.badges),
      emotes: parseEmotes(tags.emotes),
      text,
      tags,
      ...(tags.historical === "1" ? { historical: true } : {}),
    };
  }
  if (command === "CLEARCHAT") {
    if (!channel) return null;
    const target = trailing === null ? params[1] ?? null : trailing.trim() || null;
    return { type: "CLEARCHAT", channel, target, targetUserId: tags["target-user-id"] ?? null, tags };
  }
  if (command === "CLEARMSG") {
    if (!channel) return null;
    return { type: "CLEARMSG", channel, messageId: tags["target-msg-id"] ?? null, text, tags };
  }
  if (command === "ROOMSTATE") {
    if (!channel) return null;
    return { type: "ROOMSTATE", channel, tags };
  }
  if (command === "NOTICE") {
    return { type: "NOTICE", messageId: tags["msg-id"] ?? null, text, tags };
  }
  return null;
}

/** Read only the event tags Twitch defines for anonymous IRC reactions. */
export function parseReactionEvent(event: IrcEvent): ParsedReactionEvent | null {
  if ((event.type === "PRIVMSG" || event.type === "USERNOTICE") &&
    (event.historical || event.tags.historical === "1")) return null;
  if (event.type === "USERNOTICE") {
    const type = event.tags["msg-id"] === "sharedchatnotice"
      ? event.tags["source-msg-id"]
      : event.tags["msg-id"];
    if (type !== "raid" && type !== "sub" && type !== "resub" && type !== "subgift") return null;
    const rawAmount = type === "raid"
      ? event.tags["msg-param-viewerCount"]
      : type === "resub" ? event.tags["msg-param-cumulative-months"] : event.tags["msg-param-months"];
    return { type, amount: parseBoundedCount(rawAmount) };
  }
  if (event.type === "PRIVMSG" && "bits" in event.tags) {
    const amount = parseBoundedCount(event.tags.bits);
    return amount === null ? null : { type: "bits", amount };
  }
  return null;
}

function parseTags(source: string): Record<string, string> {
  const result = Object.create(null) as Record<string, string>;
  for (const pair of source.split(";")) {
    const separator = pair.indexOf("=");
    const key = separator < 0 ? pair : pair.slice(0, separator);
    if (key) result[key] = separator < 0 ? "" : unescapeTagValue(pair.slice(separator + 1));
  }
  return result;
}

function parseBoundedCount(value: string | undefined): number | null {
  if (!value || !/^\d{1,7}$/u.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) && count > 0 && count <= 1_000_000 ? count : null;
}

function parseParams(source: string): { params: string[]; trailing: string | null } {
  const params: string[] = [];
  let rest = source.trimStart();
  while (rest) {
    if (rest.startsWith(":")) return { params, trailing: rest.slice(1) };
    const separator = rest.indexOf(" ");
    if (separator < 0) {
      params.push(rest);
      break;
    }
    params.push(rest.slice(0, separator));
    rest = rest.slice(separator + 1).trimStart();
  }
  return { params, trailing: null };
}

function parseBadges(value: string | undefined): IrcBadge[] {
  if (!value) return [];
  return value.split(",").flatMap((badge) => {
    const separator = badge.indexOf("/");
    if (separator <= 0 || separator === badge.length - 1) return [];
    return [{ name: badge.slice(0, separator), version: badge.slice(separator + 1) }];
  });
}

function parseEmotes(value: string | undefined): IrcEmote[] {
  if (!value) return [];
  return value.split("/").flatMap((emote) => {
    const separator = emote.indexOf(":");
    if (separator <= 0) return [];
    const ranges = emote.slice(separator + 1).split(",").flatMap((range) => {
      const match = /^(\d+)-(\d+)$/u.exec(range);
      if (!match) return [];
      const start = Number(match[1]);
      const end = Number(match[2]);
      return end >= start ? [{ start, end }] : [];
    });
    return ranges.length ? [{ id: emote.slice(0, separator), ranges }] : [];
  });
}
