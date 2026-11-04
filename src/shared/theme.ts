export const SCHEMA_VERSION = 1;

export const THEME_UI_GROUPS = [
  "Text",
  "Colors",
  "Layout",
  "Messages",
  "Channels",
  "Filters",
  "Advanced",
] as const;

export type ThemeUiGroup = (typeof THEME_UI_GROUPS)[number];
export type ThemeControl = "select" | "range" | "color" | "segmented";

export const FONT_FAMILIES = [
  "Arial",
  "Arial Black",
  "Georgia",
  "Trebuchet MS",
  "Verdana",
] as const;
export type FontFamily = (typeof FONT_FAMILIES)[number];
export type NameColorMode = "tag" | "text";
export type LineOrder = "name-first" | "message-first";
export type Motion = "fade" | "none";

interface ThemeUi {
  group: ThemeUiGroup;
  order: number;
  label: string;
  control: ThemeControl;
}

interface ThemeField<T> {
  defaultValue: T;
  validate(value: unknown): value is T;
  toCssValue(value: T): string;
  ui: ThemeUi;
  range?: { min: number; max: number; step: number; unit: string };
}

const field = <T>(
  defaultValue: T,
  validate: (value: unknown) => value is T,
  toCssValue: (value: T) => string,
  ui: ThemeUi,
  range?: ThemeField<T>["range"],
): ThemeField<T> => ({ defaultValue, validate, toCssValue, ui, ...(range ? { range } : {}) });

const numberIn = (min: number, max: number, step = 0) =>
  (value: unknown): value is number =>
    typeof value === "number" && Number.isFinite(value) && value >= min && value <= max &&
    (step === 0 || Math.abs((value - min) / step - Math.round((value - min) / step)) < 1e-8);

export const isValidColor = (value: unknown): value is string =>
  typeof value === "string" && /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/iu.test(value);

export const THEME_FIELDS = {
  fontFamily: field<FontFamily>(
    "Arial",
    (value): value is FontFamily => typeof value === "string" && FONT_FAMILIES.includes(value as FontFamily),
    (value) => `"${value}", sans-serif`,
    { group: "Text", order: 1, label: "Font", control: "select" },
  ),
  fontSize: field(18, numberIn(14, 72, 1), (value) => `${value}px`,
    { group: "Text", order: 2, label: "Text size", control: "range" },
    { min: 14, max: 72, step: 1, unit: "px" }),
  fontWeight: field(600, numberIn(300, 900, 100), (value) => String(value),
    { group: "Text", order: 3, label: "Weight", control: "range" },
    { min: 300, max: 900, step: 100, unit: "unitless" }),
  textColor: field("#ffffff", isValidColor, (value) => value,
    { group: "Colors", order: 1, label: "Text color", control: "color" }),
  nameColorMode: field<NameColorMode>("tag", (value): value is NameColorMode => value === "tag" || value === "text",
    (value) => value, { group: "Colors", order: 2, label: "Name color", control: "segmented" }),
  backgroundColor: field("#000000", isValidColor, (value) => value,
    { group: "Colors", order: 3, label: "Background color", control: "color" }),
  backgroundOpacity: field(0.65, numberIn(0, 1, 0.01), (value) => String(value),
    { group: "Colors", order: 4, label: "Background opacity", control: "range" },
    { min: 0, max: 1, step: 0.01, unit: "ratio" }),
  spacing: field(8, numberIn(0, 32, 1), (value) => `${value}px`,
    { group: "Layout", order: 1, label: "Message spacing", control: "range" },
    { min: 0, max: 32, step: 1, unit: "px" }),
  lineOrder: field<LineOrder>("name-first", (value): value is LineOrder => value === "name-first" || value === "message-first",
    (value) => value, { group: "Layout", order: 2, label: "Line order", control: "segmented" }),
  lifetime: field(12_000, numberIn(1_000, 120_000, 1_000), (value) => `${value}ms`,
    { group: "Messages", order: 1, label: "Lifetime", control: "range" },
    { min: 1_000, max: 120_000, step: 1_000, unit: "ms" }),
  outline: field(0, numberIn(0, 4, 0.5), (value) => `${value}px`,
    { group: "Messages", order: 2, label: "Text outline", control: "range" },
    { min: 0, max: 4, step: 0.5, unit: "px" }),
  motion: field<Motion>("fade", (value): value is Motion => value === "fade" || value === "none",
    (value) => value, { group: "Messages", order: 3, label: "Motion", control: "segmented" }),
} as const;

export type ThemeFieldName = keyof typeof THEME_FIELDS;
export type ThemeValues = {
  [K in ThemeFieldName]: (typeof THEME_FIELDS)[K]["defaultValue"];
};
export type ThemeConfig = ThemeValues & { schemaVersion: number };

export const DEFAULTS: ThemeConfig = {
  schemaVersion: SCHEMA_VERSION,
  fontFamily: "Arial",
  fontSize: 18,
  fontWeight: 600,
  textColor: "#ffffff",
  nameColorMode: "tag",
  backgroundColor: "#000000",
  backgroundOpacity: 0.65,
  spacing: 8,
  lineOrder: "name-first",
  lifetime: 12_000,
  outline: 0,
  motion: "fade",
};

export class ThemeValidationError extends TypeError {
  constructor(readonly fieldName: string, message: string) {
    super(`Invalid theme field ${fieldName}: ${message}`);
    this.name = "ThemeValidationError";
  }
}

export function validateTheme(input: unknown): ThemeConfig {
  if (!isRecord(input)) throw new ThemeValidationError("theme", "expected an object");
  const rawVersion = input.schemaVersion;
  if (rawVersion !== undefined && (!Number.isInteger(rawVersion) || (rawVersion as number) < 0 ||
    (rawVersion as number) > SCHEMA_VERSION)) {
    throw new ThemeValidationError("schemaVersion", "unsupported schema version");
  }

  const result = { ...DEFAULTS };
  for (const key of Object.keys(THEME_FIELDS) as ThemeFieldName[]) {
    if (!(key in input)) continue;
    const definition = THEME_FIELDS[key] as ThemeField<ThemeValues[typeof key]>;
    const value = input[key];
    if (!definition.validate(value)) throw new ThemeValidationError(key, "value is outside its schema");
    (result as unknown as Record<string, unknown>)[key] = value;
  }
  return result;
}

/** Upgrade older stored themes to the current schema; already migrated themes are unchanged. */
export function migrate(input: unknown): ThemeConfig {
  if (!isRecord(input)) throw new ThemeValidationError("theme", "expected an object");
  const version = input.schemaVersion ?? 0;
  if (!Number.isInteger(version) || typeof version !== "number" || version < 0) {
    throw new ThemeValidationError("schemaVersion", "expected a non-negative integer");
  }
  if (version > SCHEMA_VERSION) throw new ThemeValidationError("schemaVersion", "newer schema needs a newer renderer");
  return validateTheme({ ...input, schemaVersion: SCHEMA_VERSION });
}

export function cssVariableName(fieldName: ThemeFieldName): `--t-${string}` {
  const kebab = fieldName.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`);
  return `--t-${kebab}`;
}

export function themeCssVariables(theme: ThemeConfig): Record<`--t-${string}`, string> {
  const entries = (Object.keys(THEME_FIELDS) as ThemeFieldName[]).map((key) => {
    const definition = THEME_FIELDS[key] as ThemeField<ThemeValues[typeof key]>;
    return [cssVariableName(key), definition.toCssValue(theme[key])] as const;
  });
  return Object.fromEntries(entries) as Record<`--t-${string}`, string>;
}

export function themeRowBackground(theme: ThemeConfig): string {
  const { rgb, alpha } = colorChannels(theme.backgroundColor);
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${theme.backgroundOpacity * alpha})`;
}

export function ensureTagColorContrast(color: string, theme: ThemeConfig): string {
  if (!isValidColor(color)) return color;

  const background = colorChannels(theme.backgroundColor);
  const counterpart = colorChannels(counterpartColor(theme.backgroundColor)).rgb;
  const rowBackground = composite(background.rgb, counterpart, background.alpha * theme.backgroundOpacity);
  const foreground = colorChannels(color);
  const visibleColor = composite(foreground.rgb, rowBackground, foreground.alpha);
  if (contrast(visibleColor, rowBackground) >= 3) return color;

  const black = [0, 0, 0];
  const white = [255, 255, 255];
  const target = contrast(black, rowBackground) > contrast(white, rowBackground) ? black : white;
  let low = 0;
  let high = 1;
  for (let iteration = 0; iteration < 24; iteration += 1) {
    const amount = (low + high) / 2;
    const candidate = visibleColor.map((channel, index) => channel + (target[index]! - channel) * amount);
    if (contrast(candidate, rowBackground) >= 3) high = amount;
    else low = amount;
  }
  const adjusted = visibleColor.map((channel, index) => {
    const candidate = channel + (target[index]! - channel) * high;
    return target[index]! > channel ? Math.ceil(candidate) : Math.floor(candidate);
  });
  return `#${adjusted.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
}

export function effectiveOutline(theme: ThemeConfig): { width: number; color: string } {
  const forced = theme.backgroundOpacity * colorChannels(theme.backgroundColor).alpha < 0.35;
  return {
    width: forced ? Math.max(1, theme.outline) : theme.outline,
    color: counterpartColor(theme.textColor),
  };
}

export interface TextLegibilityEstimate {
  againstBlack: boolean;
  againstWhite: boolean;
  meetsOnBoth: boolean;
  contrastOnBlack: number;
  contrastOnWhite: number;
}

/** Estimate WCAG contrast after compositing a translucent message background on either video extreme. */
export function estimateTextLegibility(
  textColor: string,
  backgroundColor: string,
  backgroundOpacity: number,
  minimumRatio = 4.5,
): TextLegibilityEstimate {
  if (!isValidColor(textColor) || !isValidColor(backgroundColor) || !numberIn(0, 1)(backgroundOpacity)) {
    throw new ThemeValidationError("legibility", "invalid color or opacity");
  }
  const black = [0, 0, 0];
  const white = [255, 255, 255];
  const background = colorChannels(backgroundColor);
  const foreground = colorChannels(textColor);
  const contrastOnBlack = contrast(
    composite(foreground.rgb, composite(background.rgb, black, background.alpha * backgroundOpacity), foreground.alpha),
    composite(background.rgb, black, background.alpha * backgroundOpacity),
  );
  const contrastOnWhite = contrast(
    composite(foreground.rgb, composite(background.rgb, white, background.alpha * backgroundOpacity), foreground.alpha),
    composite(background.rgb, white, background.alpha * backgroundOpacity),
  );
  const againstBlack = contrastOnBlack >= minimumRatio;
  const againstWhite = contrastOnWhite >= minimumRatio;
  return { againstBlack, againstWhite, meetsOnBoth: againstBlack && againstWhite, contrastOnBlack, contrastOnWhite };
}

function counterpartColor(color: string): string {
  const { rgb } = colorChannels(color);
  const luminance = linear(rgb[0]) * 0.2126 + linear(rgb[1]) * 0.7152 + linear(rgb[2]) * 0.0722;
  return luminance < 0.5 ? "#ffffff" : "#000000";
}

function colorChannels(color: string): { rgb: number[]; alpha: number } {
  const hex = color.slice(1);
  return {
    rgb: [0, 2, 4].map((offset) => Number.parseInt(hex.slice(offset, offset + 2), 16)),
    alpha: hex.length === 8 ? Number.parseInt(hex.slice(6, 8), 16) / 255 : 1,
  };
}

function composite(foreground: number[], background: number[], alpha: number): number[] {
  return foreground.map((channel, index) => channel * alpha + background[index]! * (1 - alpha));
}

function contrast(first: number[], second: number[]): number {
  const values = [luminance(first), luminance(second)].sort((a, b) => b - a);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

function luminance(rgb: number[]): number {
  return linear(rgb[0]!) * 0.2126 + linear(rgb[1]!) * 0.7152 + linear(rgb[2]!) * 0.0722;
}

function linear(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
