import { describe, expect, it } from "vitest";
import { calculatePreviewScale, resizePreviewSourceSizeFromDrag } from "../../src/studio/preview-sizing";

describe("preview source drag sizing", () => {
  it("does not enlarge Fit previews when the available stage is larger than the source", () => {
    expect(calculatePreviewScale({ width: 400, height: 150 }, 1_200, 600, 20)).toBe(1);
  });

  it("converts pointer movement through the frozen scale and snaps both axes to ten pixels", () => {
    expect(resizePreviewSourceSizeFromDrag(
      { width: 400, height: 600 }, 51, 31, 0.5, 2_000, 2_000, "both",
    )).toEqual({ width: 500, height: 660 });
  });

  it("changes only the edge axis and clamps to the visible source area", () => {
    expect(resizePreviewSourceSizeFromDrag(
      { width: 400, height: 600 }, 900, 300, 1, 530, 400, "width",
    )).toEqual({ width: 530, height: 600 });
  });

  it("clamps to source limits and never returns a value below the minimum", () => {
    expect(resizePreviewSourceSizeFromDrag(
      { width: 3_800, height: 2_100 }, 500, 500, 1, 4_000, 3_000, "both",
    )).toEqual({ width: 3_840, height: 2_160 });
    expect(resizePreviewSourceSizeFromDrag(
      { width: 100, height: 100 }, -500, -500, 1, 4_000, 3_000, "both",
    )).toEqual({ width: 100, height: 100 });
  });

  it("leaves the size unchanged when the drag scale is invalid", () => {
    expect(resizePreviewSourceSizeFromDrag(
      { width: 400, height: 600 }, 100, 100, 0, 1_000, 1_000, "both",
    )).toEqual({ width: 400, height: 600 });
  });
});
