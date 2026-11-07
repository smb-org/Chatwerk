import { describe, expect, it } from "vitest";
import { DEFAULT_FILTER_RULES, shouldFilterMessage } from "../../src/renderer/filters";

describe("fixed message filter rules", () => {
  it("matches exact words and prefixes case-insensitively", () => {
    const filters = { ...DEFAULT_FILTER_RULES, filterWords: ["spoiler"], filterPrefixes: ["!"] };
    expect(shouldFilterMessage({ text: "SPOILER", userLogin: "viewer" }, filters)).toBe(true);
    expect(shouldFilterMessage({ text: "!commands", userLogin: "viewer" }, filters)).toBe(true);
    expect(shouldFilterMessage({ text: "a spoiler here", userLogin: "viewer" }, filters)).toBe(false);
  });

  it("hides number-only messages and listed bots only when enabled", () => {
    expect(shouldFilterMessage({ text: "123456", userLogin: "viewer" }, { ...DEFAULT_FILTER_RULES, hideNumbers: true })).toBe(true);
    expect(shouldFilterMessage({ text: "hello 123", userLogin: "viewer" }, { ...DEFAULT_FILTER_RULES, hideNumbers: true })).toBe(false);
    expect(shouldFilterMessage({ text: "hello", userLogin: "NightBot" }, {
      ...DEFAULT_FILTER_RULES, hideBots: true,
    })).toBe(true);
    expect(shouldFilterMessage({ text: "hello", userLogin: "NightBot" }, DEFAULT_FILTER_RULES)).toBe(false);
  });

  it("hides partner PRIVMSG and sharedchatnotice USERNOTICE messages when shared chat is disabled", () => {
    const rules = { ...DEFAULT_FILTER_RULES, showSharedChat: false };
    const partnerPrivmsg = {
      type: "PRIVMSG" as const, text: "hello", userLogin: "viewer", roomId: "10", sourceRoomId: "20", tags: {},
    };
    const partnerNotice = {
      type: "USERNOTICE" as const, text: "", userLogin: null, roomId: "10", sourceRoomId: "20",
      tags: { "msg-id": "sharedchatnotice" },
    };

    expect(shouldFilterMessage(partnerPrivmsg, rules)).toBe(true);
    expect(shouldFilterMessage(partnerNotice, rules)).toBe(true);
    expect(shouldFilterMessage({ ...partnerPrivmsg, sourceRoomId: "10" }, rules)).toBe(false);
    expect(shouldFilterMessage({ ...partnerPrivmsg, sourceRoomId: null }, rules)).toBe(false);
    expect(shouldFilterMessage(partnerPrivmsg, DEFAULT_FILTER_RULES)).toBe(false);
  });

  it("handles long hostile input in one deterministic pass", () => {
    const hostile = `${"x".repeat(250_000)}!${"b".repeat(250_000)}`;
    expect(shouldFilterMessage({ text: hostile, userLogin: "viewer" }, {
      ...DEFAULT_FILTER_RULES, filterWords: ["a".repeat(32)], filterPrefixes: ["a".repeat(16)],
    })).toBe(false);
  });
});
