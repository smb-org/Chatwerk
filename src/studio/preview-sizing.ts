export interface PreviewSourceSize {
  width: number;
  height: number;
}

export type PreviewResizeAxis = "width" | "height" | "both";

export const DEFAULT_PREVIEW_SOURCE_SIZE: PreviewSourceSize = Object.freeze({ width: 400, height: 600 });
export const PUBLIC_PREVIEW_SOURCE_SIZE = DEFAULT_PREVIEW_SOURCE_SIZE;
const MIN_SOURCE_WIDTH = 100;
const MAX_SOURCE_WIDTH = 3840;
const MIN_SOURCE_HEIGHT = 100;
const MAX_SOURCE_HEIGHT = 2160;

export function isValidPreviewSourceSize(value: unknown): value is PreviewSourceSize {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const size = value as Record<string, unknown>;
  return Number.isInteger(size.width) && Number(size.width) >= MIN_SOURCE_WIDTH && Number(size.width) <= MAX_SOURCE_WIDTH &&
    Number.isInteger(size.height) && Number(size.height) >= MIN_SOURCE_HEIGHT && Number(size.height) <= MAX_SOURCE_HEIGHT;
}

export function resizePreviewSourceSizeFromDrag(
  size: PreviewSourceSize,
  deltaX: number,
  deltaY: number,
  scale: number,
  visibleWidth: number,
  visibleHeight: number,
  axis: PreviewResizeAxis,
): PreviewSourceSize {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return size;
  const resizeWidth = axis === "width" || axis === "both";
  const resizeHeight = axis === "height" || axis === "both";
  return {
    width: resizeWidth
      ? resizeSourceAxis(size.width, deltaX, scale, visibleWidth, MIN_SOURCE_WIDTH, MAX_SOURCE_WIDTH)
      : size.width,
    height: resizeHeight
      ? resizeSourceAxis(size.height, -deltaY, scale, visibleHeight, MIN_SOURCE_HEIGHT, MAX_SOURCE_HEIGHT)
      : size.height,
  };
}

function resizeSourceAxis(current: number, delta: number, scale: number, visibleMaximum: number, minimum: number, maximum: number): number {
  if (delta === 0) return current;
  const snapped = Math.round((current + delta / scale) / 10) * 10;
  const maxVisible = Number.isFinite(visibleMaximum) ? visibleMaximum : maximum;
  const maxAllowed = Math.max(minimum, Math.floor(Math.min(maximum, maxVisible) / 10) * 10);
  return Math.min(maxAllowed, Math.max(minimum, snapped));
}

export function calculatePreviewScale(
  size: PreviewSourceSize,
  stageWidth: number,
  stageHeight: number,
  inset: number,
): number {
  const availableWidth = Math.max(0, stageWidth - inset * 2);
  const availableHeight = Math.max(0, stageHeight - inset * 2);
  return Math.max(0, Math.min(1, availableWidth / size.width, availableHeight / size.height));
}
