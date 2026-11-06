export interface PreviewSourceSize {
  width: number;
  height: number;
}

export interface PreviewCanvasPosition {
  x: number;
  y: number;
}

export interface PreviewCanvasSize {
  width: number;
  height: number;
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
export const PREVIEW_CANVAS_SIZES: readonly PreviewCanvasSize[] = Object.freeze([
  Object.freeze({ width: 1280, height: 720 }),
  Object.freeze({ width: 1920, height: 1080 }),
  Object.freeze({ width: 2560, height: 1440 }),
  Object.freeze({ width: 3840, height: 2160 }),
]);
export const DEFAULT_PREVIEW_CANVAS_SIZE = PREVIEW_CANVAS_SIZES[1]!;
export const PREVIEW_CANVAS_WIDTH = DEFAULT_PREVIEW_CANVAS_SIZE.width;
export const PREVIEW_CANVAS_HEIGHT = DEFAULT_PREVIEW_CANVAS_SIZE.height;
const PREVIEW_POSITION_SNAP = 10;

export function previewCanvasSizeValue(size: PreviewCanvasSize): string {
  return `${size.width}x${size.height}`;
}

export function parsePreviewCanvasSize(value: string | null): PreviewCanvasSize {
  return PREVIEW_CANVAS_SIZES.find((size) => previewCanvasSizeValue(size) === value) ?? DEFAULT_PREVIEW_CANVAS_SIZE;
}

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
  canvasSize: PreviewCanvasSize = DEFAULT_PREVIEW_CANVAS_SIZE,
): PreviewCanvasGeometry {
  const availableWidth = Math.max(0, stageWidth - insets.left - insets.right);
  const availableHeight = Math.max(0, stageHeight - insets.top - insets.bottom);
  const scale = Math.min(availableWidth / canvasSize.width, availableHeight / canvasSize.height);
  const width = canvasSize.width * scale;
  const height = canvasSize.height * scale;
  return {
    left: insets.left + (availableWidth - width) / 2,
    top: insets.top + (availableHeight - height) / 2,
    width,
    height,
    scale,
  };
}

export function isValidPreviewPosition(value: unknown, canvasSize: PreviewCanvasSize = DEFAULT_PREVIEW_CANVAS_SIZE): value is PreviewCanvasPosition {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const position = value as Record<string, unknown>;
  return Number.isInteger(position.x) && Number(position.x) >= 0 && Number(position.x) <= canvasSize.width &&
    Number(position.x) % PREVIEW_POSITION_SNAP === 0 &&
    Number.isInteger(position.y) && Number(position.y) >= 0 && Number(position.y) <= canvasSize.height &&
    Number(position.y) % PREVIEW_POSITION_SNAP === 0;
}

export function defaultPreviewPosition(
  size: PreviewSourceSize,
  canvasSize: PreviewCanvasSize = DEFAULT_PREVIEW_CANVAS_SIZE,
): PreviewCanvasPosition {
  return clampPreviewPosition({
    x: size.width > canvasSize.width ? 0 : 40,
    y: size.height > canvasSize.height ? 0 : canvasSize.height - size.height - 40,
  }, size, canvasSize);
}

export function movePreviewPositionFromDrag(
  start: PreviewCanvasPosition,
  size: PreviewSourceSize,
  deltaX: number,
  deltaY: number,
  scale: number,
  canvasSize: PreviewCanvasSize = DEFAULT_PREVIEW_CANVAS_SIZE,
): PreviewCanvasPosition {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(deltaX) || !Number.isFinite(deltaY)) return start;
  return clampPreviewPosition({
    x: start.x + deltaX / scale,
    y: start.y + deltaY / scale,
  }, size, canvasSize);
}

export function movePreviewPositionBy(
  start: PreviewCanvasPosition,
  size: PreviewSourceSize,
  deltaX: number,
  deltaY: number,
  canvasSize: PreviewCanvasSize = DEFAULT_PREVIEW_CANVAS_SIZE,
): PreviewCanvasPosition {
  return clampPreviewPosition({ x: start.x + deltaX, y: start.y + deltaY }, size, canvasSize);
}

export function clampPreviewPosition(
  position: PreviewCanvasPosition,
  size: PreviewSourceSize,
  canvasSize: PreviewCanvasSize = DEFAULT_PREVIEW_CANVAS_SIZE,
): PreviewCanvasPosition {
  const maxX = Math.max(0, canvasSize.width - size.width);
  const maxY = Math.max(0, canvasSize.height - size.height);
  const snappedX = Math.round(position.x / PREVIEW_POSITION_SNAP) * PREVIEW_POSITION_SNAP;
  const snappedY = Math.round(position.y / PREVIEW_POSITION_SNAP) * PREVIEW_POSITION_SNAP;
  return {
    x: Math.min(Math.floor(maxX / PREVIEW_POSITION_SNAP) * PREVIEW_POSITION_SNAP, Math.max(0, snappedX)),
    y: Math.min(Math.floor(maxY / PREVIEW_POSITION_SNAP) * PREVIEW_POSITION_SNAP, Math.max(0, snappedY)),
  };
}
