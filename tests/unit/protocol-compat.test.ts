import { describe, expect, it } from "vitest";
import { DEFAULTS } from "../../src/shared/theme";
import { decideConfigUpdate } from "../../src/shared/protocol";

describe("additive config protocol", () => {
  it("ignores fields unknown to this renderer", () => {
    const result = decideConfigUpdate(DEFAULTS, {
      schemaVersion: DEFAULTS.schemaVersion,
      fontSize: 21,
      futureField: { anything: true },
    });
    expect(result.status).toBe("applied");
    expect(result.config.fontSize).toBe(21);
    expect("futureField" in result.config).toBe(false);
  });

  it("applies additive theme fields on schema version 1 without requiring an update", () => {
    const result = decideConfigUpdate(DEFAULTS, {
      schemaVersion: 1,
      layout: "ticker",
      channels: ["room"],
      filterWords: ["blocked"],
    });
    expect(result).toMatchObject({
      status: "applied",
      config: { schemaVersion: 1, layout: "ticker", channels: ["room"], filterWords: ["blocked"] },
      shouldReload: false,
    });
  });

  it("keeps the last config for a higher schema without throwing or reloading", () => {
    const result = decideConfigUpdate(DEFAULTS, {
      schemaVersion: DEFAULTS.schemaVersion + 1,
      fontSize: 40,
    });
    expect(result).toEqual({
      status: "update-required",
      config: DEFAULTS,
      shouldReload: false,
    });
  });
});
