import { describe, expect, it, vi } from "vitest";
import { createScenarioMessages, runScenario } from "../../src/renderer/scenarios";
import { parseReactionEvent } from "../../src/renderer/irc-parse";

describe("Studio rehearsal scenarios", () => {
  it("creates quiet, flood, raid, sub, and bits samples using ordinary renderer messages", () => {
    const quiet = createScenarioMessages("quiet", "sample");
    const flood = createScenarioMessages("flood", "sample");
    const raid = createScenarioMessages("raid", "sample");
    const sub = createScenarioMessages("sub", "sample");
    const bits = createScenarioMessages("bits", "sample");
    expect(quiet.length).toBeGreaterThan(0);
    expect(flood).toHaveLength(100);
    expect(raid.every((message) => message.type === "USERNOTICE" || message.type === "PRIVMSG")).toBe(true);
    expect([...quiet, ...flood, ...raid, ...sub, ...bits].every((message) => message.channel === "#sample")).toBe(true);
    expect(parseReactionEvent(raid[0]!)).toMatchObject({ type: "raid" });
    expect(parseReactionEvent(sub[0]!)).toMatchObject({ type: "sub" });
    expect(parseReactionEvent(bits[0]!)).toEqual({ type: "bits", amount: 250 });
  });

  it("shows several quiet messages immediately when a preview starts", () => {
    const emit = vi.fn();
    const stop = runScenario("quiet", emit);
    expect(emit).toHaveBeenCalledTimes(3);
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
