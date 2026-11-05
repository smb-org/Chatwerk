import { describe, expect, it, vi } from "vitest";
import { createScenarioMessages, runScenario } from "../../src/renderer/scenarios";

describe("Studio rehearsal scenarios", () => {
  it("creates quiet, flood, and raid samples using ordinary renderer messages", () => {
    const quiet = createScenarioMessages("quiet", "sample");
    const flood = createScenarioMessages("flood", "sample");
    const raid = createScenarioMessages("raid", "sample");
    expect(quiet.length).toBeGreaterThan(0);
    expect(flood.length).toBeGreaterThan(quiet.length);
    expect(raid.every((message) => message.type === "USERNOTICE" || message.type === "PRIVMSG")).toBe(true);
    expect([...quiet, ...flood, ...raid].every((message) => message.channel === "#sample")).toBe(true);
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
