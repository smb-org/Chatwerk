export const SCHEMA_VERSION = 1;
export const LEGIBILITY_MINIMUM_RATIO = 4.5;
export const LEGIBILITY_OUTLINE_OPACITY_THRESHOLD = 0.35;

export const THEME_UI_GROUPS = [
  "Text",
  "Colors",
  "Panel",
  "Layout",
  "Messages",
  "Emotes & Effects",
  "Reactions",
  "Channels",
  "Filters",
  "Advanced",
] as const;

export type ThemeUiGroup = (typeof THEME_UI_GROUPS)[number];
export type ThemeControl = "select" | "range" | "color" | "segmented" | "toggle" | "list" | "channels" | "text";

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
export type SharedChatLabel = "text" | "pill" | "avatar" | "avatar-pill" | "hidden";
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
  textShadow: field(0, numberIn(0, 8, 1), (value) => value === 0 ? "none" : `0 1px ${value}px rgba(0, 0, 0, 0.9)`,
    { group: "Text", order: 4, label: "Text shadow", control: "range" },
    { min: 0, max: 8, step: 1, unit: "px" }),
  smallCaps: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Text", order: 5, label: "Small caps", control: "toggle" }),
  textColor: field("#ffffff", isValidColor, (value) => value,
    { group: "Colors", order: 1, label: "Text color", control: "color" }),
  nameColorMode: field<NameColorMode>("tag", (value): value is NameColorMode => value === "tag" || value === "text",
    (value) => value, { group: "Colors", order: 2, label: "Name color", control: "segmented" }),
  backgroundColor: field("#000000", isValidColor, (value) => value,
    { group: "Colors", order: 3, label: "Background color", control: "color" }),
  backgroundOpacity: field(0.65, numberIn(0, 1, 0.01), (value) => String(value),
    { group: "Colors", order: 4, label: "Background opacity", control: "range" },
    { min: 0, max: 1, step: 0.01, unit: "ratio" }),
  panelEnabled: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Panel", order: 1, label: "Panel", control: "toggle" }),
  panelBackgroundColor: field("#000000", isValidColor, (value) => value,
    { group: "Panel", order: 2, label: "Panel background", control: "color" }),
  panelBackgroundOpacity: field(0.5, numberIn(0, 1, 0.01), (value) => String(value),
    { group: "Panel", order: 3, label: "Panel background opacity", control: "range" },
    { min: 0, max: 1, step: 0.01, unit: "ratio" }),
  panelBorderWidth: field(0, numberIn(0, 8, 1), (value) => `${value}px`,
    { group: "Panel", order: 4, label: "Panel border width", control: "range" },
    { min: 0, max: 8, step: 1, unit: "px" }),
  panelBorderColor: field("#ffffff", isValidColor, (value) => value,
    { group: "Panel", order: 5, label: "Panel border color", control: "color" }),
  panelRadius: field(8, numberIn(0, 32, 1), (value) => `${value}px`,
    { group: "Panel", order: 6, label: "Panel corner radius", control: "range" },
    { min: 0, max: 32, step: 1, unit: "px" }),
  panelPadding: field(8, numberIn(0, 32, 1), (value) => `${value}px`,
    { group: "Panel", order: 7, label: "Panel padding", control: "range" },
    { min: 0, max: 32, step: 1, unit: "px" }),
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
  lifetime: field(120_000, numberIn(1_000, 300_000, 1_000), (value) => `${value}ms`,
    { group: "Messages", order: 1, label: "Lifetime", control: "range" },
    { min: 1_000, max: 300_000, step: 1_000, unit: "ms" }),
  neverFade: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Messages", order: 2, label: "Never expire", control: "toggle" }),
  maxLines: field(100, numberIn(1, 100, 1), (value) => String(value),
    { group: "Messages", order: 3, label: "Maximum lines", control: "range" },
    { min: 1, max: 100, step: 1, unit: "lines" }),
  maxChatHeight: field(0, numberIn(0, 2_160, 10), (value) => `${value}px`,
    { group: "Messages", order: 4, label: "Maximum chat height", control: "range" },
    { min: 0, max: 2_160, step: 10, unit: "px" }),
  linePadding: field(0, numberIn(0, 16, 1), (value) => `${value}px`,
    { group: "Messages", order: 5, label: "Line padding", control: "range" },
    { min: 0, max: 16, step: 1, unit: "px" }),
  outline: field(0, numberIn(0, 4, 0.5), (value) => `${value}px`,
    { group: "Messages", order: 6, label: "Text outline", control: "range" },
    { min: 0, max: 4, step: 0.5, unit: "px" }),
  motion: field<Motion>("fade", (value): value is Motion => value === "fade" || value === "none",
    (value) => value, { group: "Messages", order: 7, label: "Motion", control: "segmented" }),
  emoteScale: field(1.5, numberIn(0.5, 3, 0.1), (value) => `${value}em`,
    { group: "Messages", order: 10, label: "Emote size", control: "range" },
    { min: 0.5, max: 3, step: 0.1, unit: "em" }),
  gigantifiedScale: field(2.5, numberIn(1, 5, 0.1), (value) => `${value}em`,
    { group: "Messages", order: 11, label: "Gigantified emote size", control: "range" },
    { min: 1, max: 5, step: 0.1, unit: "em" }),
  showBadges: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Messages", order: 12, label: "Show badges", control: "toggle" }),
  backlog: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Messages", order: 14, label: "Recent message backlog", control: "toggle" }),
  nameOnOwnLine: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Messages", order: 15, label: "Name on own line", control: "toggle" }),
  hideNames: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Messages", order: 16, label: "Hide names", control: "toggle" }),
  readableNames: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Messages", order: 17, label: "Readable names", control: "toggle" }),
  showPronouns: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Messages", order: 13, label: "Show pronouns", control: "toggle" }),
  emotes7tv: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Emotes & Effects", order: 1, label: "7TV emotes", control: "toggle" }),
  emotesBttv: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Emotes & Effects", order: 2, label: "BTTV emotes", control: "toggle" }),
  emotesFfz: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Emotes & Effects", order: 3, label: "FFZ emotes", control: "toggle" }),
  showPaints: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Emotes & Effects", order: 4, label: "7TV paints", control: "toggle" }),
  badges7tv: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Emotes & Effects", order: 5, label: "7TV badges", control: "toggle" }),
  badgesBttv: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Emotes & Effects", order: 6, label: "BTTV badges", control: "toggle" }),
  badgesFfz: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Emotes & Effects", order: 7, label: "FFZ badges", control: "toggle" }),
  badgesChatterino: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Emotes & Effects", order: 8, label: "Chatterino badges", control: "toggle" }),
  badgesHomies: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Emotes & Effects", order: 9, label: "Chatterino Homies badges", control: "toggle" }),
  reactionRaid: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Reactions", order: 1, label: "Raid", control: "toggle" }),
  reactionSub: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Reactions", order: 2, label: "New subscription", control: "toggle" }),
  reactionResub: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Reactions", order: 3, label: "Resubscription", control: "toggle" }),
  reactionSubgift: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Reactions", order: 4, label: "Gift subscription", control: "toggle" }),
  reactionBits: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Reactions", order: 5, label: "Bits", control: "toggle" }),
  reactionHypeTrain: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Reactions", order: 6, label: "Hype Train", control: "toggle" }),
  reactionIntensity: field(0.35, numberIn(0, 1, 0.05), (value) => String(value),
    { group: "Reactions", order: 7, label: "Effect intensity", control: "range" },
    { min: 0, max: 1, step: 0.05, unit: "ratio" }),
  reactionSoundEnabled: field(false, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Reactions", order: 8, label: "Sound effects", control: "toggle" }),
  reactionVolume: field(0.4, numberIn(0, 1, 0.05), (value) => String(value),
    { group: "Reactions", order: 9, label: "Sound volume", control: "range" },
    { min: 0, max: 1, step: 0.05, unit: "ratio" }),
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
  showSharedChat: field(true, (value): value is boolean => typeof value === "boolean", (value) => String(value),
    { group: "Filters", order: 5, label: "Show shared chat messages", control: "toggle" }),
  sharedChatLabel: field<SharedChatLabel>("text", (value): value is SharedChatLabel =>
    value === "text" || value === "pill" || value === "avatar" || value === "avatar-pill" || value === "hidden",
  (value) => value, { group: "Messages", order: 18, label: "Shared Chat source label", control: "select" }),
  sharedChatPrefix: field("via", (value): value is string =>
    typeof value === "string" && Array.from(value).length <= 12 && !Array.from(value).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint < 0x20 || (codePoint >= 0x7f && codePoint <= 0x9f);
    }),
  (value) => value, { group: "Messages", order: 19, label: "Text label prefix", control: "text" }),
  botNames: field<string[]>([...DEFAULT_BOT_NAMES], isValidBotNameList, (value) => JSON.stringify(value),
    { group: "Filters", order: 6, label: "Bot names", control: "list" }),
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
  textShadow: 0,
  smallCaps: false,
  textColor: "#ffffff",
  nameColorMode: "tag",
  backgroundColor: "#000000",
  backgroundOpacity: 0.65,
  panelEnabled: false,
  panelBackgroundColor: "#000000",
  panelBackgroundOpacity: 0.5,
  panelBorderWidth: 0,
  panelBorderColor: "#ffffff",
  panelRadius: 8,
  panelPadding: 8,
  spacing: 8,
  lineOrder: "name-first",
  layout: "stack",
  tickerSpeed: 80,
  emoteSpacing: 0,
  lifetime: 120_000,
  neverFade: false,
  maxLines: 100,
  maxChatHeight: 0,
  outline: 0,
  motion: "fade",
  emoteScale: 1.5,
  gigantifiedScale: 2.5,
  showBadges: true,
  backlog: true,
  nameOnOwnLine: false,
  hideNames: false,
  readableNames: false,
  linePadding: 0,
  showPronouns: false,
  emotes7tv: true,
  emotesBttv: true,
  emotesFfz: true,
  showPaints: true,
  badges7tv: true,
  badgesBttv: true,
  badgesFfz: true,
  badgesChatterino: true,
  badgesHomies: false,
  reactionRaid: true,
  reactionSub: true,
  reactionResub: true,
  reactionSubgift: true,
  reactionBits: true,
  reactionHypeTrain: true,
  reactionIntensity: 0.35,
  reactionSoundEnabled: false,
  reactionVolume: 0.4,
  highlightBackgroundColor: "#ffe680",
  highlightTextColor: "#17181b",
  channels: [],
  hideNumbers: false,
  filterWords: [],
  filterPrefixes: [],
  hideBots: false,
  showSharedChat: true,
  sharedChatLabel: "text",
  sharedChatPrefix: "via",
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
  "channels", "hideNumbers", "filterWords", "filterPrefixes", "hideBots", "showSharedChat", "botNames",
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

export function themePanelBackground(theme: ThemeConfig): string {
  const { rgb, alpha } = colorChannels(theme.panelBackgroundColor);
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${theme.panelBackgroundOpacity * alpha})`;
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

/** Adjust a valid foreground along its HSL lightness axis until it meets 4.5:1 contrast. */
export function ensureReadableNameColor(color: string, backgroundColor: string): string {
  if (!isValidColor(color) || !isValidColor(backgroundColor)) return color;

  const background = colorChannels(backgroundColor).rgb;
  const foreground = colorChannels(color);
  if (contrast(composite(foreground.rgb, background, foreground.alpha), background) >= LEGIBILITY_MINIMUM_RATIO) return color;

  const { hue, saturation, lightness } = rgbToHsl(foreground.rgb);
  const dark = hslToRgb(hue, saturation, 0);
  const light = hslToRgb(hue, saturation, 1);
  let alpha = foreground.alpha;
  let darkContrast = contrast(composite(dark, background, alpha), background);
  let lightContrast = contrast(composite(light, background, alpha), background);
  if (Math.max(darkContrast, lightContrast) < LEGIBILITY_MINIMUM_RATIO) {
    alpha = 1;
    darkContrast = contrast(dark, background);
    lightContrast = contrast(light, background);
  }
  const lighten = lightContrast >= darkContrast;
  const target = lighten ? 1 : 0;
  let low = lighten ? lightness : target;
  let high = lighten ? target : lightness;
  let passing = target;
  for (let iteration = 0; iteration < 32; iteration += 1) {
    const midpoint = (low + high) / 2;
    const candidate = hslToRgb(hue, saturation, midpoint);
    const meets = contrast(composite(candidate, background, alpha), background) >= LEGIBILITY_MINIMUM_RATIO;
    if (lighten) {
      if (meets) { high = midpoint; passing = midpoint; }
      else low = midpoint;
    } else if (meets) {
      low = midpoint;
      passing = midpoint;
    } else high = midpoint;
  }
  const adjusted = hslToRgb(hue, saturation, passing);
  const rgb = `#${adjusted.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`;
  const result = alpha < 1
    ? `${rgb}${Math.round(alpha * 255).toString(16).padStart(2, "0")}`
    : rgb;
  return result;
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

function rgbToHsl(rgb: number[]): { hue: number; saturation: number; lightness: number } {
  const [red, green, blue] = rgb.map((channel) => channel / 255) as [number, number, number];
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const delta = maximum - minimum;
  const lightness = (maximum + minimum) / 2;
  if (delta === 0) return { hue: 0, saturation: 0, lightness };
  const saturation = delta / (1 - Math.abs(2 * lightness - 1));
  const hue = maximum === red ? ((green - blue) / delta) % 6
    : maximum === green ? (blue - red) / delta + 2
    : (red - green) / delta + 4;
  return { hue: ((hue * 60) + 360) % 360, saturation, lightness };
}

function hslToRgb(hue: number, saturation: number, lightness: number): number[] {
  const chroma = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const sector = hue / 60;
  const secondary = chroma * (1 - Math.abs((sector % 2) - 1));
  const match = lightness - chroma / 2;
  const channels = sector < 1 ? [chroma, secondary, 0]
    : sector < 2 ? [secondary, chroma, 0]
    : sector < 3 ? [0, chroma, secondary]
    : sector < 4 ? [0, secondary, chroma]
    : sector < 5 ? [secondary, 0, chroma]
    : [chroma, 0, secondary];
  return channels.map((channel) => Math.round((channel + match) * 255));
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
