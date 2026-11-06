import { describe, expect, it } from "vitest";
import {
  calculatePreviewCanvasGeometry,
  calculatePreviewScale,
  defaultPreviewPosition,
  isValidPreviewPosition,
  movePreviewPositionBy,
  movePreviewPositionFromDrag,
  resizePreviewSourceSizeFromDrag,
} from "../../src/studio/preview-sizing";

describe("preview source drag sizing", () => {
  it("does not enlarge Fit previews when the available stage is larger than the source", () => {
    expect(calculatePreviewScale({ width: 400, height: 150 }, 1_200, 600, 20)).toBe(1);
  });

  it("converts pointer movement through the frozen scale and snaps both axes to ten pixels", () => {
    expect(resizePreviewSourceSizeFromDrag(
      { width: 400, height: 600 }, 51, -31, 0.5, 2_000, 2_000, "both",
    )).toEqual({ width: 500, height: 660 });
  });

  it("grows the height when the top edge moves up and clamps at the available stage height", () => {
    expect(resizePreviewSourceSizeFromDrag(
      { width: 400, height: 600 }, 0, -500, 1, 2_000, 470, "height",
    )).toEqual({ width: 400, height: 470 });
  });

  it("changes only the edge axis and clamps to the visible source area", () => {
    expect(resizePreviewSourceSizeFromDrag(
      { width: 400, height: 600 }, 900, 300, 1, 530, 400, "width",
    )).toEqual({ width: 530, height: 600 });
  });

  it("clamps to source limits and never returns a value below the minimum", () => {
    expect(resizePreviewSourceSizeFromDrag(
      { width: 3_800, height: 2_100 }, 500, -500, 1, 4_000, 3_000, "both",
    )).toEqual({ width: 3_840, height: 2_160 });
    expect(resizePreviewSourceSizeFromDrag(
      { width: 100, height: 100 }, -500, 500, 1, 4_000, 3_000, "both",
    )).toEqual({ width: 100, height: 100 });
  });

  it("leaves the size unchanged when the drag scale is invalid", () => {
    expect(resizePreviewSourceSizeFromDrag(
      { width: 400, height: 600 }, 100, 100, 0, 1_000, 1_000, "both",
    )).toEqual({ width: 400, height: 600 });
  });
});

describe("preview canvas geometry", () => {
  it.each([
    { canvasSize: { width: 1_280, height: 720 }, maximumPosition: { x: 480, y: 460 } },
    { canvasSize: { width: 1_920, height: 1_080 }, maximumPosition: { x: 1_120, y: 820 } },
    { canvasSize: { width: 2_560, height: 1_440 }, maximumPosition: { x: 1_760, y: 1_180 } },
    { canvasSize: { width: 3_840, height: 2_160 }, maximumPosition: { x: 3_040, y: 1_900 } },
  ] as const)("uses selected logical canvas $canvasSize.width×$canvasSize.height for scale and movement bounds", ({ canvasSize, maximumPosition }) => {
    expect(calculatePreviewCanvasGeometry(
      1_200,
      800,
      { top: 56, right: 20, bottom: 20, left: 20 },
      canvasSize,
    )).toEqual({
      left: 20,
      top: 91.75,
      width: 1_160,
      height: 652.5,
      scale: 1_160 / canvasSize.width,
    });
    expect(movePreviewPositionBy({ x: 0, y: 0 }, { width: 800, height: 260 }, 5_000, 5_000, canvasSize))
      .toEqual(maximumPosition);
    expect(movePreviewPositionBy({ x: 40, y: 40 }, { width: 800, height: 260 }, 17, 21, canvasSize))
      .toEqual({ x: 60, y: 60 });
    expect(movePreviewPositionFromDrag({ x: 0, y: 0 }, { width: 800, height: 260 }, 5_000, 5_000, 0.5, canvasSize))
      .toEqual(maximumPosition);
    expect(resizePreviewSourceSizeFromDrag(
      { width: 100, height: 100 }, 5_000, -5_000, 1, canvasSize.width, canvasSize.height, "both",
    )).toEqual(canvasSize);
  });

  it("fits a 16:9 canvas inside padded stage content", () => {
    expect(calculatePreviewCanvasGeometry(1_200, 800, { top: 56, right: 20, bottom: 20, left: 20 })).toEqual({
      left: 20,
      top: 91.75,
      width: 1_160,
      height: 652.5,
      scale: 1_160 / 1_920,
    });
  });

  it("defaults the frame to a 40px bottom-left canvas margin", () => {
    expect(defaultPreviewPosition({ width: 800, height: 260 })).toEqual({ x: 40, y: 780 });
  });

  it("moves by canvas coordinates, snaps to ten, and clamps to all canvas edges", () => {
    expect(movePreviewPositionFromDrag({ x: 40, y: 780 }, { width: 800, height: 260 }, 98, -51, 0.5))
      .toEqual({ x: 240, y: 680 });
    expect(movePreviewPositionBy({ x: 40, y: 40 }, { width: 800, height: 260 }, -100, -100))
      .toEqual({ x: 0, y: 0 });
    expect(movePreviewPositionBy({ x: 1_100, y: 800 }, { width: 800, height: 260 }, 50, 50))
      .toEqual({ x: 1_120, y: 820 });
    expect(movePreviewPositionBy({ x: 500, y: 500 }, { width: 2_000, height: 1_200 }, 50, 50))
      .toEqual({ x: 0, y: 0 });
  });

  it("rejects malformed or out-of-canvas stored positions", () => {
    expect(isValidPreviewPosition({ x: 1040, y: 820 })).toBe(true);
    expect(isValidPreviewPosition({ x: 1.5, y: 820 })).toBe(false);
    expect(isValidPreviewPosition({ x: 1041, y: 820 })).toBe(false);
    expect(isValidPreviewPosition({ x: -10, y: 820 })).toBe(false);
    expect(isValidPreviewPosition({ x: 1_930, y: 820 })).toBe(false);
    expect(isValidPreviewPosition(null)).toBe(false);
  });
});
