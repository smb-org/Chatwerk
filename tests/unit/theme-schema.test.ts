import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  LEGIBILITY_MINIMUM_RATIO,
  LEGIBILITY_OUTLINE_OPACITY_THRESHOLD,
  SCHEMA_VERSION,
  THEME_FIELDS,
  THEME_UI_GROUPS,
  cssVariableName,
  effectiveOutline,
  estimateTextLegibility,
  ensureTagColorContrast,
  ensureReadableNameColor,
  getShareableThemeKeys,
  migrate,
  themeCssVariables,
  validateTheme,
  validateShareableTheme,
} from "../../src/shared/theme";
import { isAllowedImageUrl } from "../../src/shared/hosts";

describe("theme schema", () => {
  it("rejects hostile values instead of turning them into CSS", () => {
    for (const fontFamily of ["x;url(https://e)", "}", "@import"]) {
      expect(() => validateTheme({ ...DEFAULTS, fontFamily })).toThrow();
    }
    expect(() => validateTheme({ ...DEFAULTS, textColor: "red" })).toThrow();
    expect(() => validateTheme({ ...DEFAULTS, textColor: "#1234567" })).toThrow();
    expect(() => validateTheme({ ...DEFAULTS, spacing: "1px; color:red" })).toThrow();
  });

  it("ships valid defaults and gives each field ordered UI metadata", () => {
    expect(validateTheme(DEFAULTS)).toEqual(DEFAULTS);
    expect(THEME_UI_GROUPS).toEqual([
      "Text", "Colors", "Panel", "Layout", "Messages", "Emotes & Effects", "Reactions", "Channels", "Filters", "Advanced",
    ]);
    for (const field of Object.values(THEME_FIELDS)) {
      expect(field.ui.label).toBeTruthy();
      expect(THEME_UI_GROUPS).toContain(field.ui.group);
      if (typeof field.defaultValue === "number") {
        expect(field.range).toMatchObject({ min: expect.any(Number), max: expect.any(Number), unit: expect.any(String) });
      }
    }
    const messageFields = Object.values(THEME_FIELDS)
      .filter((field) => field.ui.group === "Messages")
      .sort((left, right) => left.ui.order - right.ui.order);
    expect(messageFields.map((field) => field.ui.label)).toEqual([
      "Lifetime", "Never expire", "Maximum lines", "Maximum chat height", "Line padding", "Text outline", "Motion",
      "Highlight background", "Highlight text", "Emote size", "Gigantified emote size", "Show badges", "Show pronouns",
      "Recent message backlog", "Name on own line", "Hide names", "Readable names",
    ]);
    expect(new Set(messageFields.map((field) => field.ui.order)).size).toBe(messageFields.length);
    const textFields = Object.values(THEME_FIELDS).filter((field) => field.ui.group === "Text");
    expect(new Set(textFields.map((field) => field.ui.order)).size).toBe(textFields.length);
    expect(textFields.sort((left, right) => left.ui.order - right.ui.order).map((field) => field.ui.label)).toEqual([
      "Font", "Text size", "Weight", "Text shadow", "Small caps",
    ]);
  });

  it("migrates idempotently and ignores unknown fields", () => {
    const old = { fontSize: 20, retiredField: "ignored" };
    const once = migrate(old);
    expect(migrate(once)).toEqual(once);
    expect(once.fontSize).toBe(20);
    expect("retiredField" in once).toBe(false);
  });

  it("derives every CSS variable name from the schema fields", () => {
    const fields = Object.keys(THEME_FIELDS) as Array<keyof typeof THEME_FIELDS>;
    expect(fields.map(cssVariableName)).toContain("--t-font-family");
    expect(Object.keys(themeCssVariables(DEFAULTS))).toEqual(fields
      .filter((field) => !["channels", "hideNumbers", "filterWords", "filterPrefixes", "hideBots", "botNames"].includes(field))
      .map(cssVariableName));
    for (const field of ["channels", "hideNumbers", "filterWords", "filterPrefixes", "hideBots", "botNames"] as const) {
      expect(themeCssVariables(DEFAULTS)).not.toHaveProperty(cssVariableName(field));
    }
  });

  it("forces a counterpart outline under 0.35 opacity and estimates both backgrounds", () => {
    const theme = validateTheme({
      ...DEFAULTS,
      backgroundOpacity: 0.34,
      outline: 0,
      textColor: "#111111",
    });
    expect(effectiveOutline(theme)).toEqual({ width: 1, color: "#ffffff" });
    const estimate = estimateTextLegibility("#ffffff", "#000000", 0.5);
    expect(estimate).toMatchObject({ againstBlack: true, againstWhite: false, meetsOnBoth: false });
  });

  it("uses the shared minimum contrast and outline opacity thresholds", () => {
    expect(LEGIBILITY_MINIMUM_RATIO).toBe(4.5);
    expect(LEGIBILITY_OUTLINE_OPACITY_THRESHOLD).toBe(0.35);
    expect(estimateTextLegibility("#ffffff", "#000000", 0.35).meetsOnBoth).toBe(false);
  });

  it("makes unreadable tag colors readable and preserves colors that already pass", () => {
    const darkTheme = { ...DEFAULTS, backgroundColor: "#000000", backgroundOpacity: 1 };
    const adjusted = ensureTagColorContrast("#000000", darkTheme);
    expect(adjusted).toBe("#5a5a5a");
    expect(ensureTagColorContrast("#00ff00", darkTheme)).toBe("#00ff00");
  });

  it("adjusts name colors to 4.5:1 by lightness, and leaves invalid colors untouched", () => {
    const whiteOnWhite = ensureReadableNameColor("#ffffff", "#ffffff");
    const blackOnBlack = ensureReadableNameColor("#000000", "#000000");
    expect(whiteOnWhite).not.toBe("#ffffff");
    expect(estimateTextLegibility(whiteOnWhite, "#ffffff", 1).contrastOnWhite).toBeGreaterThanOrEqual(4.5);
    expect(blackOnBlack).not.toBe("#000000");
    expect(estimateTextLegibility(blackOnBlack, "#000000", 1).contrastOnBlack).toBeGreaterThanOrEqual(4.5);
    expect(ensureReadableNameColor("not-a-color", "#000000")).toBe("not-a-color");
    const translucentFallback = ensureReadableNameColor("#00000001", "#000000");
    expect(translucentFallback).toMatch(/^#[0-9a-f]{6}$/iu);
    expect(estimateTextLegibility(translucentFallback, "#000000", 1).contrastOnBlack).toBeGreaterThanOrEqual(4.5);
    expect(ensureReadableNameColor("#a020f0", "#000000")).not.toBe("#a020f0");
  });

  it("accepts images only from the documented HTTPS hosts", () => {
    expect(isAllowedImageUrl("https://cdn.7tv.app/emote/1x.webp")).toBe(true);
    expect(isAllowedImageUrl("https://evilcdn.7tv.app/emote/1x.webp")).toBe(false);
    expect(isAllowedImageUrl("http://static-cdn.jtvnw.net/badge.png")).toBe(false);
    expect(isAllowedImageUrl("https://cdn.chatterinohomies.com/badges/example/36.webp")).toBe(true);
  });

  it("validates emote scale and chat decoration toggles", () => {
    expect(DEFAULTS.emoteScale).toBe(1.5);
    expect(DEFAULTS.showBadges).toBe(true);
    expect(DEFAULTS.showPronouns).toBe(false);
    expect(validateTheme({ ...DEFAULTS, emoteScale: 2.2, showBadges: false, showPronouns: true }))
      .toMatchObject({ emoteScale: 2.2, showBadges: false, showPronouns: true });
    expect(() => validateTheme({ ...DEFAULTS, emoteScale: "3em" })).toThrow();
  });

  it("validates shareable reaction toggles, intensity, sound, and volume at schema version 1", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(DEFAULTS).toMatchObject({
      reactionRaid: true,
      reactionSub: true,
      reactionResub: true,
      reactionSubgift: true,
      reactionBits: true,
      reactionIntensity: 0.35,
      reactionSoundEnabled: false,
      reactionVolume: 0.4,
    });
    expect(THEME_FIELDS.reactionIntensity.ui).toMatchObject({ group: "Reactions", control: "range" });
    expect(THEME_FIELDS.reactionSoundEnabled.ui).toMatchObject({ group: "Reactions", control: "toggle" });
    expect(THEME_FIELDS.reactionVolume.range).toMatchObject({ min: 0, max: 1, step: 0.05 });
    expect(validateTheme({ schemaVersion: 1, reactionBits: false, reactionVolume: 0.75 }))
      .toMatchObject({ schemaVersion: 1, reactionBits: false, reactionIntensity: 0.35, reactionVolume: 0.75 });
    expect(() => validateTheme({ reactionIntensity: 1.01 })).toThrow();
    expect(() => validateTheme({ reactionVolume: -0.1 })).toThrow();
    expect(getShareableThemeKeys()).toContain("reactionSubgift");
  });

  it("keeps additive values compatible with schema version 1 and loads old-shape themes", () => {
    const expanded = validateTheme({
      schemaVersion: 1,
      fontSize: 20,
      layout: "ticker",
      tickerSpeed: 140,
      channels: ["room"],
      hideNumbers: true,
      filterWords: ["blocked"],
      filterPrefixes: ["!"],
      hideBots: true,
      botNames: ["bot"],
    });
    expect(expanded).toMatchObject({
      schemaVersion: 1,
      fontSize: 20,
      layout: "ticker",
      tickerSpeed: 140,
      channels: ["room"],
      hideNumbers: true,
      filterWords: ["blocked"],
      filterPrefixes: ["!"],
      hideBots: true,
      botNames: ["bot"],
    });

    const oldShape = validateTheme({ schemaVersion: 1, fontSize: 20, textColor: "#abcabc" });
    expect(oldShape).toMatchObject({ schemaVersion: 1, fontSize: 20, textColor: "#abcabc", layout: "stack", channels: [] });
    expect(migrate({ schemaVersion: 1, fontSize: 20 })).toMatchObject({
      schemaVersion: 1,
      fontSize: 20,
      layout: "stack",
      tickerSpeed: 80,
      channels: [],
      hideNumbers: false,
      filterWords: [],
      filterPrefixes: [],
      hideBots: false,
      botNames: expect.arrayContaining(["nightbot", "streamlabs"]),
      gigantifiedScale: 2.5,
      emoteSpacing: 0,
    });
    expect(() => validateTheme({ ...DEFAULTS, channels: ["ok", "not valid"] })).toThrow();
    expect(() => validateTheme({ ...DEFAULTS, channels: Array.from({ length: 6 }, (_, index) => `room${index}`) })).toThrow();
    expect(() => validateTheme({ ...DEFAULTS, filterWords: ["x".repeat(33)] })).toThrow();
    expect(() => validateTheme({ ...DEFAULTS, filterPrefixes: Array.from({ length: 21 }, (_, index) => `p${index}`) })).toThrow();
    expect(() => validateTheme({ ...DEFAULTS, botNames: ["bad bot"] })).toThrow();
    const shareable = getShareableThemeKeys();
    expect(shareable).not.toContain("channels");
    expect(shareable).not.toContain("filterWords");
    expect(shareable).not.toContain("filterPrefixes");
    expect(shareable).not.toContain("hideBots");
    expect(shareable).not.toContain("botNames");
  });

  it("adds display switches without changing version 1 defaults or existing ranges", () => {
    expect(SCHEMA_VERSION).toBe(1);
    const oldShape = validateTheme({ schemaVersion: 1, fontSize: 20 });
    expect(oldShape).toMatchObject({
      emotes7tv: true,
      emotesBttv: true,
      emotesFfz: true,
      showPaints: true,
      badges7tv: true,
      badgesBttv: true,
      badgesFfz: true,
      badgesChatterino: true,
      backlog: true,
      panelEnabled: false,
      panelBackgroundColor: "#000000",
      panelBackgroundOpacity: 0.5,
      panelBorderWidth: 0,
      panelBorderColor: "#ffffff",
      panelRadius: 8,
      panelPadding: 8,
      linePadding: 0,
      neverFade: false,
      maxLines: 100,
      maxChatHeight: 0,
    });
    expect(THEME_FIELDS.maxLines.range).toMatchObject({ min: 1, max: 100, step: 1, unit: "lines" });
    expect(THEME_FIELDS.maxChatHeight.range).toMatchObject({ min: 0, max: 2160, step: 10, unit: "px" });
    expect(() => validateTheme({ maxLines: 0 })).toThrow();
    expect(() => validateTheme({ maxLines: 101 })).toThrow();
    expect(() => validateTheme({ maxChatHeight: 5 })).toThrow();
    expect(() => validateTheme({ maxChatHeight: 2_170 })).toThrow();
    for (const name of ["emotes7tv", "emotesBttv", "emotesFfz", "showPaints", "neverFade", "maxLines", "maxChatHeight"] as const) {
      expect(getShareableThemeKeys()).toContain(name);
    }
    for (const name of ["badges7tv", "badgesBttv", "badgesFfz", "badgesChatterino", "backlog"] as const) {
      expect(getShareableThemeKeys()).toContain(name);
      expect(THEME_FIELDS[name].defaultValue).toBe(true);
    }
    expect(getShareableThemeKeys()).toContain("panelEnabled");
    expect(THEME_FIELDS.panelEnabled.defaultValue).toBe(false);
    expect(THEME_FIELDS.panelBackgroundOpacity.range).toMatchObject({ min: 0, max: 1, step: 0.01, unit: "ratio" });
    expect(THEME_FIELDS.panelBorderWidth.range).toMatchObject({ min: 0, max: 8, step: 1, unit: "px" });
    expect(THEME_FIELDS.panelRadius.range).toMatchObject({ min: 0, max: 32, step: 1, unit: "px" });
    expect(THEME_FIELDS.panelPadding.range).toMatchObject({ min: 0, max: 32, step: 1, unit: "px" });
    expect(THEME_FIELDS.linePadding.range).toMatchObject({ min: 0, max: 16, step: 1, unit: "px" });
    expect(DEFAULTS.panelBackgroundColor).toBe("#000000");
    expect(DEFAULTS.panelBorderColor).toBe("#ffffff");
    expect(() => validateTheme({ panelBackgroundOpacity: 1.01 })).toThrow();
    expect(() => validateTheme({ panelBorderWidth: 9 })).toThrow();
    expect(() => validateTheme({ panelRadius: 33 })).toThrow();
    expect(() => validateTheme({ panelPadding: 33 })).toThrow();
    expect(() => validateTheme({ linePadding: 17 })).toThrow();
  });

  it("adds the ChatIS display fields with compatible defaults and shareable values", () => {
    expect(SCHEMA_VERSION).toBe(1);
    expect(DEFAULTS).toMatchObject({
      textShadow: 0,
      smallCaps: false,
      nameOnOwnLine: false,
      hideNames: false,
      badgesHomies: false,
      readableNames: false,
    });
    expect(THEME_FIELDS.textShadow.range).toMatchObject({ min: 0, max: 8, step: 1, unit: "px" });
    expect(() => validateTheme({ textShadow: -1 })).toThrow();
    expect(() => validateTheme({ textShadow: 8.5 })).toThrow();
    expect(() => validateTheme({ textShadow: 9 })).toThrow();
    const oldConfig = validateTheme({ schemaVersion: 1, fontSize: 20 });
    expect(oldConfig).toMatchObject({
      schemaVersion: 1,
      textShadow: 0,
      smallCaps: false,
      nameOnOwnLine: false,
      hideNames: false,
      badgesHomies: false,
      readableNames: false,
    });
    for (const key of ["textShadow", "smallCaps", "nameOnOwnLine", "hideNames", "badgesHomies", "readableNames"] as const) {
      expect(getShareableThemeKeys()).toContain(key);
      expect(validateShareableTheme({ [key]: DEFAULTS[key] })).toHaveProperty(key, DEFAULTS[key]);
    }
    expect(THEME_FIELDS.badgesHomies.defaultValue).toBe(false);
  });
});
