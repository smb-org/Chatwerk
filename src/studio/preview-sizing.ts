export interface PreviewSourceSize {
  width: number;
  height: number;
}

export const DEFAULT_PREVIEW_SOURCE_SIZE: PreviewSourceSize = Object.freeze({ width: 400, height: 600 });
export const PUBLIC_PREVIEW_SOURCE_SIZE = DEFAULT_PREVIEW_SOURCE_SIZE;

export function isValidPreviewSourceSize(value: unknown): value is PreviewSourceSize {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const size = value as Record<string, unknown>;
  return Number.isInteger(size.width) && Number(size.width) >= 100 && Number(size.width) <= 3840 &&
    Number.isInteger(size.height) && Number(size.height) >= 100 && Number(size.height) <= 2160;
}

export function calculatePreviewScale(
  size: PreviewSourceSize,
  stageWidth: number,
  stageHeight: number,
  inset: number,
): number {
  const availableWidth = Math.max(0, stageWidth - inset * 2);
  const availableHeight = Math.max(0, stageHeight - inset * 2);
  return Math.max(0, Math.min(availableWidth / size.width, availableHeight / size.height));
}
