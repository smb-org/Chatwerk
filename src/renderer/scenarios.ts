import type { CommonMessage } from "./irc-parse";
import type { EmoteAsset } from "./emotes";
import type { EmbeddedBadgeData } from "./badges";
import type { SevenTvBadge } from "./paints";
import type { HypeTrainReactionMessage } from "./reactions";

export type ScenarioName = "quiet" | "flood" | "raid" | "sub" | "bits";

export function runHypeTrainScenario(emit: (message: HypeTrainReactionMessage) => void): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const startedAt = Date.now();
  const events: Array<[number, HypeTrainReactionMessage["phase"], number]> = [
    [0, "begin", 1], [3_000, "progress", 2], [6_000, "progress", 3], [9_800, "end", 3],
  ];
  for (const [delay, phase, level] of events) {
    const timer = setTimeout(() => {
      timers.delete(timer);
      emit({
        type: "hype-train", id: `studio-hype-${startedAt}-${phase}-${level}`, trainId: `studio-hype-${startedAt}`, channel: "sample", phase, level,
        expiresAt: phase === "end" ? null : new Date(startedAt + 9_900).toISOString(),
      });
    }, delay);
    timers.add(timer);
  }
  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}

export const QUIET_SAMPLE_PAINTS: Record<string, unknown> = {
  "7100002": {
    function: "LINEAR_GRADIENT",
    angle: 90,
    stops: [{ at: 0, color: "#f48fb1" }, { at: 1, color: "#80deea" }],
  },
  "7100003": { function: "URL", image_url: "/assets/samples/name-paint.svg" },
  "7100004": { color: "#a78bfa" },
};

export const QUIET_SAMPLE_SEVENTV_BADGE: SevenTvBadge = {
  name: "Sample 7TV badge",
  url: "/assets/samples/seventv-badge.svg",
};

export const QUIET_SAMPLE_TWITCH_BADGES: EmbeddedBadgeData = {
  global: [
    { set_id: "moderator", versions: [{ id: "1", image_url_2x: "/assets/samples/moderator-badge.svg" }] },
    { set_id: "vip", versions: [{ id: "1", image_url_2x: "/assets/samples/vip-badge.svg" }] },
    { set_id: "subscriber", versions: [{ id: "12", image_url_2x: "/assets/samples/subscriber-badge.svg" }] },
  ],
  broadcasters: {
    "7100001": [{ set_id: "broadcaster", versions: [{ id: "1", image_url_2x: "/assets/samples/broadcaster-badge.svg" }] }],
  },
};

export const QUIET_SAMPLE_EMOTES: EmoteAsset[] = [
  { name: "Kappa", url: "/assets/samples/twitch-emote.svg", provider: "TWITCH" },
  { name: "WaveHi", url: "/assets/samples/seventv-emote.svg", provider: "7TV" },
  { name: "PartyPop", url: "/assets/samples/bttv-emote.svg", provider: "BTTV" },
];

const quietLines = [
  ["sample_pixelfox", "That round felt endless, but the team stayed calm, rotated together, and made the final move work exactly as planned.", "#E9A23B"],
  ["sample_mira", "Kappa that was a clean round.", "#89B4FA"],
  ["sample_tobi", "WaveHi good to see everyone here.", "#A6E3A1"],
  ["sample_amber", "PartyPop the timing was perfect!", "#F28B7D"],
  ["sample_modmoth", "Moderator, subscriber, and VIP all in one chat.", "#CBA6F7"],
  ["sample_jay", "waves hello to @sample as everyone arrives!", "#94E2D5"],
  ["sample_ember", "Thanks for the highlighted reward message!", "#F5C2E7"],
  ["sample_cheer", "Cheer250 let's go!", "#E9A23B"],
  ["sample_wordsmith", "supercalifragilisticexpialidocious".repeat(3), "#A6E3A1"],
] as const;

const quietDetails: Array<Partial<Pick<CommonMessage, "badges" | "emotes">> & { tags: Record<string, string> }> = [
  { badges: [{ name: "broadcaster", version: "1" }], tags: { "user-id": "7100001" } },
  { badges: [{ name: "moderator", version: "1" }], tags: { "user-id": "7100002", "sample-paint": "gradient" }, emotes: [{ id: "25", ranges: [{ start: 0, end: 4 }] }] },
  { badges: [{ name: "vip", version: "1" }], tags: { "user-id": "7100003", "sample-paint": "image" } },
  { badges: [{ name: "subscriber", version: "12" }], tags: { "user-id": "7100004", "sample-paint": "solid" } },
  { badges: [{ name: "moderator", version: "1" }, { name: "subscriber", version: "12" }, { name: "vip", version: "1" }], tags: { "user-id": "7100005" } },
  { tags: { "user-id": "7100006", "message-type": "action" } },
  { badges: [{ name: "vip", version: "1" }], tags: { "user-id": "7100007", "msg-id": "highlighted-message", "custom-reward-id": "sample-reward" } },
  { badges: [{ name: "subscriber", version: "12" }], tags: { "user-id": "7100008" } },
  { tags: { "user-id": "7100009" } },
];

const floodLines = [
  ["sample_pixelfox", "Wait, that timing!", "#E9A23B"],
  ["sample_mira", "The whole squad is here", "#89B4FA"],
  ["sample_tobi", "Clip it!", "#A6E3A1"],
  ["sample_amber", "One more round", "#F28B7D"],
  ["sample_pixelfox", "Go left!", "#E9A23B"],
  ["sample_mira", "Huge play", "#89B4FA"],
  ["sample_tobi", "GG", "#A6E3A1"],
  ["sample_amber", "That was close", "#F28B7D"],
  ["sample_pixelfox", "Again again", "#E9A23B"],
  ["sample_mira", "We are so back", "#89B4FA"],
  ["sample_tobi", "No way", "#A6E3A1"],
  ["sample_amber", "Let's go!", "#F28B7D"],
  ["sample_pixelfox", "Chat is moving", "#E9A23B"],
  ["sample_mira", "Great stream", "#89B4FA"],
  ["sample_tobi", "Another one", "#A6E3A1"],
  ["sample_amber", "That was wild", "#F28B7D"],
  ["sample_pixelfox", "W", "#E9A23B"],
  ["sample_mira", "Everybody saw that", "#89B4FA"],
  ["sample_tobi", "Clean finish", "#A6E3A1"],
  ["sample_amber", "GGs", "#F28B7D"],
] as const;

const raidLines = [
  ["newfriend01", "We came from sample_partner_demo's stream!", "#F28B7D"],
  ["newfriend02", "Thanks for welcoming us", "#89B4FA"],
  ["newfriend03", "Raid party checking in", "#A6E3A1"],
  ["newfriend04", "Hello, Chatwerk!", "#E9A23B"],
  ["newfriend05", "That was a great stream", "#CBA6F7"],
  ["newfriend06", "Happy to be here", "#F5C2E7"],
  ["newfriend07", "Let's keep it going", "#94E2D5"],
  ["newfriend08", "Welcome, everyone!", "#FAB387"],
] as const;

const subLines = [["newfriend09", "Thanks for the welcome!", "#CBA6F7"]] as const;
const bitsLines = [["cheerer", "Cheer250 That was huge!", "#E9A23B"]] as const;

export function createScenarioMessages(name: ScenarioName, channel: string, includeSharedChat = false): CommonMessage[] {
  const rows = name === "flood"
    ? Array.from({ length: 100 }, (_, index) => index % 3 === 2
      ? quietLines[Math.floor(index / 3) % quietLines.length]!
      : floodLines[(index - Math.floor(index / 3)) % floodLines.length]!)
    : name === "quiet" ? quietLines : name === "raid" ? raidLines : name === "sub" ? subLines : bitsLines;
  const messages: CommonMessage[] = rows.map(([userLogin, text, color], index): CommonMessage => {
    const quietSampleIndex = name === "quiet" ? index : name === "flood" && index % 3 === 2
      ? Math.floor(index / 3) % quietLines.length
      : null;
    const detailIndex = quietSampleIndex ?? (name === "flood" && userLogin === "sample_mira" ? 1 : null);
    const isSample = name === "quiet" || name === "flood";
    return {
      type: ["raid", "sub"].includes(name) && index === 0 ? "USERNOTICE" : "PRIVMSG",
      channel: `#${channel.replace(/^#/u, "")}`,
      userLogin,
      id: `studio-${name}-${index}`,
      roomId: isSample ? "7100001" : null,
      sourceRoomId: null,
      sourceId: null,
      displayName: userLogin,
      color,
      badges: detailIndex !== null ? quietDetails[detailIndex]?.badges ?? [] : [],
      emotes: quietSampleIndex !== null ? quietDetails[quietSampleIndex]?.emotes ?? [] : [],
      text,
      tags: {
        login: userLogin,
        "display-name": userLogin,
        color,
        ...(isSample ? { "chatwerk-sample": "1", ...(detailIndex !== null ? quietDetails[detailIndex]?.tags : {}) } : {}),
        ...(name === "raid" && index === 0 ? { "msg-id": "raid", "msg-param-viewerCount": "57" } : {}),
        ...(name === "sub" && index === 0 ? { "msg-id": "sub", "msg-param-months": "1" } : {}),
        ...(name === "bits" && index === 0 ? { bits: "250" } : {}),
      },
    };
  });
  if (name === "quiet" && includeSharedChat) {
    messages.push({
      type: "PRIVMSG",
      channel: `#${channel.replace(/^#/u, "")}`,
      userLogin: "sample_guest",
      id: "studio-quiet-shared-chat",
      roomId: "10001",
      sourceRoomId: "10002",
      sourceRoomName: "sample_partner_demo",
      sourceRoomLogo: null,
      sourceId: null,
      displayName: "sample_guest",
      color: "#CBA6F7",
      badges: [],
      emotes: [],
      text: "Joining from the partner stream!",
      tags: { login: "sample_guest", "display-name": "sample_guest", color: "#CBA6F7", "chatwerk-sample": "1" },
    });
  }
  return messages;
}

export function runScenario(
  name: ScenarioName,
  emit: (message: CommonMessage) => void,
  channel = "sample",
  includeSharedChat = false,
): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  createScenarioMessages(name, channel, includeSharedChat).forEach((message, index) => {
    if (name === "quiet") {
      emit(message);
      return;
    }
    const interval = name === "raid" ? 110 : 54;
    const timer = setTimeout(() => {
      timers.delete(timer);
      emit(message);
    }, index * interval);
    timers.add(timer);
  });
  return () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
}
