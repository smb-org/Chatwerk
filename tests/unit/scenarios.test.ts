import { describe, expect, it, vi } from "vitest";
import { createScenarioMessages, runScenario } from "../../src/renderer/scenarios";
import { parseReactionEvent } from "../../src/renderer/irc-parse";

describe("Studio rehearsal scenarios", () => {
  it("creates quiet, flood, raid, sub, and bits samples using ordinary renderer messages", () => {
    const quiet = createScenarioMessages("quiet", "sample");
    const studioQuiet = createScenarioMessages("quiet", "sample", true);
    const flood = createScenarioMessages("flood", "sample");
    const raid = createScenarioMessages("raid", "sample");
    const sub = createScenarioMessages("sub", "sample");
    const bits = createScenarioMessages("bits", "sample");
    expect(quiet.length).toBeGreaterThan(0);
    expect(studioQuiet.at(-1)).toMatchObject({ sourceRoomId: "10002", roomId: "10001", sourceRoomName: "sample_partner_demo", sourceRoomLogo: null });
    expect(studioQuiet.every((message) => message.tags["chatwerk-sample"] === "1")).toBe(true);
    expect(quiet).toHaveLength(9);
    expect(studioQuiet).toHaveLength(10);
    expect(flood).toHaveLength(100);
    expect(raid.every((message) => message.type === "USERNOTICE" || message.type === "PRIVMSG")).toBe(true);
    expect([...quiet, ...flood, ...raid, ...sub, ...bits].every((message) => message.channel === "#sample")).toBe(true);
    expect(parseReactionEvent(raid[0]!)).toMatchObject({ type: "raid" });
    expect(parseReactionEvent(sub[0]!)).toMatchObject({ type: "sub" });
    expect(parseReactionEvent(bits[0]!)).toEqual({ type: "bits", amount: 250 });
  });

  it("includes supported visual examples and the requested action tag in the quiet sample", () => {
    const quiet = createScenarioMessages("quiet", "sample");
    const bits = createScenarioMessages("bits", "sample");

    expect(quiet.some((message) => message.badges.some((badge) => badge.name === "broadcaster"))).toBe(true);
    expect(quiet.some((message) => message.badges.length > 1)).toBe(true);
    expect(quiet.some((message) => message.tags["sample-paint"] !== undefined)).toBe(true);
    expect(quiet.some((message) => message.emotes.length > 0)).toBe(true);
    expect(quiet.some((message) => message.text.length > 100 && message.text.includes(" "))).toBe(true);
    expect(quiet.some((message) => !message.text.includes(" ") && message.text.length > 100)).toBe(true);
    expect(quiet.some((message) => message.tags["message-type"] === "action")).toBe(true);
    expect(quiet.some((message) => message.tags["msg-id"] === "highlighted-message")).toBe(true);
    expect(quiet.some((message) => message.text === "Cheer250 let's go!")).toBe(true);
    expect(quiet.every((message) => message.tags.bits === undefined)).toBe(true);
    expect(bits[0]?.tags.bits).toBe("250");
  });

  it("shows several quiet messages immediately when a preview starts", () => {
    const emit = vi.fn();
    const stop = runScenario("quiet", emit);
    expect(emit).toHaveBeenCalledTimes(9);
    stop();
  });

  it("stops scheduled rehearsal messages when another scenario starts", () => {
    vi.useFakeTimers();
    const emit = vi.fn();
    const stop = runScenario("flood", emit);
    vi.advanceTimersByTime(0);
    stop();
    vi.runAllTimers();
    expect(emit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });
});
