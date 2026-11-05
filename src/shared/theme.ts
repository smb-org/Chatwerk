export const SCHEMA_VERSION = 1;
export const LEGIBILITY_MINIMUM_RATIO = 4.5;
export const LEGIBILITY_OUTLINE_OPACITY_THRESHOLD = 0.35;

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
export type ThemeControl = "select" | "range" | "color" | "segmented" | "toggle" | "list" | "channels";

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
export type MessageLayout = "stack" | "ticker";
export type ChannelLogin = string;
export const DEFAULT_BOT_NAMES = [
  "nightbot", "streamlabs", "streamelements", "moobot", "fossabot",
  "wizebot", "sery_bot", "deepbot", "phantombot", "coebot",
] as const;

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
  layout: field<MessageLayout>("stack", (value): value is MessageLayout => value === "stack" || value === "ticker",
    (value) => value, { group: "Layout", order: 3, label: "Layout", control: "segmented" }),
  tickerSpeed: field(80, numberIn(20, 400, 1), (value) => `${value}px`,
    { group: "Layout", order: 4, label: "Ticker speed", control: "range" },
    { min: 20, max: 400, step: 1, unit: "px/s" }),
  emoteSpacing: field(0, numberIn(0, 16, 1), (value) => `${value}px`,
    { group: "Layout", order: 5, label: "Emote spacing", control: "range" },
    { min: 0, max: 16, step: 1, unit: "px" }),
  lifetime: field(120_000, numberIn(1_000, 120_000, 1_000), (value) => `${value}ms`,
    { group: "Messages", order: 1, label: "Lifetime", control: "range" },
    { min: 1_000, max: 120_000, step: 1_000, unit: "ms" }),
  outline: field(0, numberIn(0, 4, 0.5), (value) => `${value}px`,
    { group: "Messages", order: 2, label: "Text outline", control: "range" },
    { min: 0, max: 4, step: 0.5, unit: "px" }),
  motion: field<Motion>("fade", (value): value is Motion => value === "fade" || value === "none",
    (value) => value, { group: "Messages", order: 3, label: "Motion", control: "segmented" }),
  emoteScale: field(1.5, numberIn(0.5, 3, 0.1), (value) => `${value}em`,
    { group: "Messages", order: 4, label: "Emote size", control: "range" },
    { min: 0.5, max: 3, step: 0.1, unit: "em" }),
  gigantifiedScale: field(2.5, numberIn(1, 5, 0.1), (value) => `${value}em`,
    { group: "Messages", order: 5, label: "Gigantified emote size", control: "range" },
    { min: 1, max: 5, step: 0.1, unit: "em" }),
  showBadges: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Messages", order: 6, label: "Show badges", control: "toggle" }),
  showPronouns: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Messages", order: 7, label: "Show pronouns", control: "toggle" }),
  highlightBackgroundColor: field("#ffe680", isValidColor, (value) => value,
    { group: "Messages", order: 8, label: "Highlight background", control: "color" }),
  highlightTextColor: field("#17181b", isValidColor, (value) => value,
    { group: "Messages", order: 9, label: "Highlight text", control: "color" }),
  channels: field<ChannelLogin[]>([], isValidChannelList, (value) => JSON.stringify(value),
    { group: "Channels", order: 1, label: "Channels", control: "channels" }),
  hideNumbers: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Filters", order: 1, label: "Hide number-only messages", control: "toggle" }),
  filterWords: field<string[]>([], (value): value is string[] => isValidStringList(value, 50, 32), (value) => JSON.stringify(value),
    { group: "Filters", order: 2, label: "Exact words", control: "list" }),
  filterPrefixes: field<string[]>([], (value): value is string[] => isValidStringList(value, 20, 16), (value) => JSON.stringify(value),
    { group: "Filters", order: 3, label: "Message prefixes", control: "list" }),
  hideBots: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Filters", order: 4, label: "Hide bots", control: "toggle" }),
  botNames: field<string[]>([...DEFAULT_BOT_NAMES], isValidBotNameList, (value) => JSON.stringify(value),
    { group: "Filters", order: 5, label: "Bot names", control: "list" }),
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
  layout: "stack",
  tickerSpeed: 80,
  emoteSpacing: 0,
  lifetime: 120_000,
  outline: 0,
  motion: "fade",
  emoteScale: 1.5,
  gigantifiedScale: 2.5,
  showBadges: true,
  showPronouns: false,
  highlightBackgroundColor: "#ffe680",
  highlightTextColor: "#17181b",
  channels: [],
  hideNumbers: false,
  filterWords: [],
  filterPrefixes: [],
  hideBots: false,
  botNames: [...DEFAULT_BOT_NAMES],
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
  const entries = (Object.keys(THEME_FIELDS) as ThemeFieldName[]).filter((key) => !PRIVATE_THEME_FIELDS.has(key)).map((key) => {
    const definition = THEME_FIELDS[key] as ThemeField<ThemeValues[typeof key]>;
    return [cssVariableName(key), definition.toCssValue(theme[key])] as const;
  });
  return Object.fromEntries(entries) as Record<`--t-${string}`, string>;
}

const PRIVATE_THEME_FIELDS = new Set<ThemeFieldName>([
  "channels", "hideNumbers", "filterWords", "filterPrefixes", "hideBots", "botNames",
]);

/** Shareable appearance keys for gallery looks; overlay-local routing and filtering never cross this boundary. */
export function getShareableThemeKeys(): ThemeFieldName[] {
  return (Object.keys(THEME_FIELDS) as ThemeFieldName[]).filter((key) => !PRIVATE_THEME_FIELDS.has(key));
}

/** Validate a look while retaining only values that can be shared with another overlay. */
export function validateShareableTheme(input: unknown): Partial<ThemeConfig> {
  if (!isRecord(input)) throw new ThemeValidationError("theme", "expected an object");
  const values: Record<string, unknown> = Object.fromEntries(
    getShareableThemeKeys().filter((key) => key in input).map((key) => [key, input[key]]),
  );
  if ("schemaVersion" in input) values.schemaVersion = input.schemaVersion;
  const validated = validateTheme(values);
  return Object.fromEntries(getShareableThemeKeys().map((key) => [key, validated[key]])) as Partial<ThemeConfig>;
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
  const forced = theme.backgroundOpacity * colorChannels(theme.backgroundColor).alpha < LEGIBILITY_OUTLINE_OPACITY_THRESHOLD;
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
  minimumRatio = LEGIBILITY_MINIMUM_RATIO,
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

function isValidStringList(value: unknown, maximumItems: number, maximumLength: number): value is string[] {
  return Array.isArray(value) && value.length <= maximumItems && value.every((item) =>
    typeof item === "string" && item.length > 0 && item.length <= maximumLength && item === item.trim());
}

function isValidChannelList(value: unknown): value is ChannelLogin[] {
  if (!Array.isArray(value) || value.length > 5) return false;
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !/^[a-z0-9_]{1,25}$/iu.test(item)) return false;
    const normalized = item.toLowerCase();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
  }
  return true;
}

function isValidBotNameList(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 50 && value.every((item) =>
    typeof item === "string" && /^[a-z0-9_]{1,32}$/iu.test(item));
}
