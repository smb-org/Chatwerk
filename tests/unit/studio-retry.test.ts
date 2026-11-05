import { describe, expect, it } from "vitest";
import { initialLoadRetryDelayMs } from "../../src/studio/retry";

describe("Studio initial-load retry delay", () => {
  it("backs off from two seconds and caps at thirty seconds", () => {
    expect([0, 1, 2, 3, 4, 5].map(initialLoadRetryDelayMs))
      .toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
  });
});
