import type { CommonMessage } from "./irc-parse";

export type ScenarioName = "quiet" | "flood" | "raid" | "sub" | "bits";

const quietLines = [
  ["pixelfox", "Evening everyone!", "#E9A23B"],
  ["mira_gg", "That was a clean round.", "#89B4FA"],
  ["tobi_builds", "Nice shots!", "#A6E3A1"],
] as const;

const floodLines = [
  ["pixelfox", "Wait, that timing!", "#E9A23B"],
  ["mira_gg", "The whole squad is here", "#89B4FA"],
  ["tobi_builds", "Clip it!", "#A6E3A1"],
  ["amberbyte", "One more round", "#F28B7D"],
  ["pixelfox", "Go left!", "#E9A23B"],
  ["mira_gg", "Huge play", "#89B4FA"],
  ["tobi_builds", "GG", "#A6E3A1"],
  ["amberbyte", "That was close", "#F28B7D"],
  ["pixelfox", "Again again", "#E9A23B"],
  ["mira_gg", "We are so back", "#89B4FA"],
  ["tobi_builds", "No way", "#A6E3A1"],
  ["amberbyte", "Let's go!", "#F28B7D"],
  ["pixelfox", "Chat is moving", "#E9A23B"],
  ["mira_gg", "Great stream", "#89B4FA"],
  ["tobi_builds", "Another one", "#A6E3A1"],
  ["amberbyte", "That was wild", "#F28B7D"],
  ["pixelfox", "W", "#E9A23B"],
  ["mira_gg", "Everybody saw that", "#89B4FA"],
  ["tobi_builds", "Clean finish", "#A6E3A1"],
  ["amberbyte", "GGs", "#F28B7D"],
] as const;

const raidLines = [
  ["newfriend01", "We came from Luna's stream!", "#F28B7D"],
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

export function createScenarioMessages(name: ScenarioName, channel: string): CommonMessage[] {
  const rows = name === "quiet" ? quietLines : name === "raid" ? raidLines
    : name === "sub" ? subLines : name === "bits" ? bitsLines : floodLines;
  return rows.map(([userLogin, text, color], index) => ({
    type: ["raid", "sub"].includes(name) && index === 0 ? "USERNOTICE" : "PRIVMSG",
    channel: `#${channel.replace(/^#/u, "")}`,
    userLogin,
    id: `studio-${name}-${index}`,
    roomId: null,
    sourceRoomId: null,
    sourceId: null,
    displayName: userLogin,
    color,
    badges: [],
    emotes: [],
    text,
    tags: {
      login: userLogin,
      "display-name": userLogin,
      color,
      ...(name === "raid" && index === 0 ? { "msg-id": "raid", "msg-param-viewerCount": "57" } : {}),
      ...(name === "sub" && index === 0 ? { "msg-id": "sub", "msg-param-months": "1" } : {}),
      ...(name === "bits" && index === 0 ? { bits: "250" } : {}),
    },
  }));
}

export function runScenario(
  name: ScenarioName,
  emit: (message: CommonMessage) => void,
  channel = "sample",
): () => void {
  const timers = new Set<ReturnType<typeof setTimeout>>();
  createScenarioMessages(name, channel).forEach((message, index) => {
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
