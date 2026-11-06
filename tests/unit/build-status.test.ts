import { describe, expect, it } from "vitest";
import { countOutdatedOutputs } from "../../src/studio/build-status";

describe("overlay build status", () => {
  it("counts only output clients whose build is different or unknown", () => {
    expect(countOutdatedOutputs([
      { client: "obs", buildId: "0123456789abcdef" },
      { client: "browser", buildId: "fedcba9876543210" },
      { client: "widget", buildId: null },
      { client: "browser" },
      { client: "studio", buildId: null },
    ], "0123456789abcdef")).toBe(3);
  });

  it("does not flag outputs running the same build or count the Studio preview", () => {
    expect(countOutdatedOutputs([
      { client: "obs", buildId: "0123456789abcdef" },
      { client: "browser", buildId: "0123456789abcdef" },
      { client: "studio", buildId: "fedcba9876543210" },
    ], "0123456789abcdef")).toBe(0);
  });
});
