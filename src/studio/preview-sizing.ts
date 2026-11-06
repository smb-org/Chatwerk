export interface PreviewSourceSize {
  width: number;
  height: number;
}

export interface PreviewCanvasPosition {
  x: number;
  y: number;
}

export interface PreviewCanvasInsets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export interface PreviewCanvasGeometry {
  left: number;
  top: number;
  width: number;
  height: number;
  scale: number;
}

export type PreviewResizeAxis = "width" | "height" | "both";

export const DEFAULT_PREVIEW_SOURCE_SIZE: PreviewSourceSize = Object.freeze({ width: 400, height: 600 });
export const PUBLIC_PREVIEW_SOURCE_SIZE = DEFAULT_PREVIEW_SOURCE_SIZE;
const MIN_SOURCE_WIDTH = 100;
const MAX_SOURCE_WIDTH = 3840;
const MIN_SOURCE_HEIGHT = 100;
const MAX_SOURCE_HEIGHT = 2160;
export const PREVIEW_CANVAS_WIDTH = 1920;
export const PREVIEW_CANVAS_HEIGHT = 1080;
const PREVIEW_POSITION_SNAP = 10;

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

export function calculatePreviewCanvasGeometry(
  stageWidth: number,
  stageHeight: number,
  insets: PreviewCanvasInsets,
): PreviewCanvasGeometry {
  const availableWidth = Math.max(0, stageWidth - insets.left - insets.right);
  const availableHeight = Math.max(0, stageHeight - insets.top - insets.bottom);
  const scale = Math.min(availableWidth / PREVIEW_CANVAS_WIDTH, availableHeight / PREVIEW_CANVAS_HEIGHT);
  const width = PREVIEW_CANVAS_WIDTH * scale;
  const height = PREVIEW_CANVAS_HEIGHT * scale;
  return {
    left: insets.left + (availableWidth - width) / 2,
    top: insets.top + (availableHeight - height) / 2,
    width,
    height,
    scale,
  };
}

export function isValidPreviewPosition(value: unknown): value is PreviewCanvasPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  return Number.isInteger(position.x) && Number(position.x) >= 0 && Number(position.x) <= PREVIEW_CANVAS_WIDTH &&
    Number(position.x) % PREVIEW_POSITION_SNAP === 0 &&
    Number.isInteger(position.y) && Number(position.y) >= 0 && Number(position.y) <= PREVIEW_CANVAS_HEIGHT &&
    Number(position.y) % PREVIEW_POSITION_SNAP === 0;
}

export function defaultPreviewPosition(size: PreviewSourceSize): PreviewCanvasPosition {
  return clampPreviewPosition({
    x: size.width > PREVIEW_CANVAS_WIDTH ? 0 : 40,
    y: size.height > PREVIEW_CANVAS_HEIGHT ? 0 : PREVIEW_CANVAS_HEIGHT - size.height - 40,
  }, size);
}

export function movePreviewPositionFromDrag(
  start: PreviewCanvasPosition,
  size: PreviewSourceSize,
  deltaX: number,
  deltaY: number,
  scale: number,
): PreviewCanvasPosition {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return start;
  return clampPreviewPosition({
    x: start.x + deltaX / scale,
    y: start.y + deltaY / scale,
  }, size);
}

export function movePreviewPositionBy(
  start: PreviewCanvasPosition,
  size: PreviewSourceSize,
  deltaX: number,
  deltaY: number,
): PreviewCanvasPosition {
  return clampPreviewPosition({ x: start.x + deltaX, y: start.y + deltaY }, size);
}

export function clampPreviewPosition(position: PreviewCanvasPosition, size: PreviewSourceSize): PreviewCanvasPosition {
  const maxX = Math.max(0, PREVIEW_CANVAS_WIDTH - size.width);
  const maxY = Math.max(0, PREVIEW_CANVAS_HEIGHT - size.height);
  const snappedX = Math.round(position.x / PREVIEW_POSITION_SNAP) * PREVIEW_POSITION_SNAP;
  const snappedY = Math.round(position.y / PREVIEW_POSITION_SNAP) * PREVIEW_POSITION_SNAP;
  return {
    x: Math.min(Math.floor(maxX / PREVIEW_POSITION_SNAP) * PREVIEW_POSITION_SNAP, Math.max(0, snappedX)),
    y: Math.min(Math.floor(maxY / PREVIEW_POSITION_SNAP) * PREVIEW_POSITION_SNAP, Math.max(0, snappedY)),
  };
}
