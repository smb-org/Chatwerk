import { describe, expect, it } from "vitest";
import {
  DEFAULTS,
  LEGIBILITY_MINIMUM_RATIO,
  LEGIBILITY_OUTLINE_OPACITY_THRESHOLD,
  THEME_FIELDS,
  THEME_UI_GROUPS,
  cssVariableName,
  effectiveOutline,
  estimateTextLegibility,
  ensureTagColorContrast,
  getShareableThemeKeys,
  migrate,
  themeCssVariables,
  validateTheme,
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
      "Text", "Colors", "Layout", "Messages", "Channels", "Filters", "Advanced",
    ]);
    for (const field of Object.values(THEME_FIELDS)) {
      expect(field.ui.label).toBeTruthy();
      expect(THEME_UI_GROUPS).toContain(field.ui.group);
      if (typeof field.defaultValue === "number") {
        expect(field.range).toMatchObject({ min: expect.any(Number), max: expect.any(Number), unit: expect.any(String) });
      }
    }
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

  it("accepts images only from the documented HTTPS hosts", () => {
    expect(isAllowedImageUrl("https://cdn.7tv.app/emote/1x.webp")).toBe(true);
    expect(isAllowedImageUrl("https://evilcdn.7tv.app/emote/1x.webp")).toBe(false);
    expect(isAllowedImageUrl("http://static-cdn.jtvnw.net/badge.png")).toBe(false);
  });

  it("validates emote scale and chat decoration toggles", () => {
    expect(DEFAULTS.emoteScale).toBe(1.5);
    expect(DEFAULTS.showBadges).toBe(true);
    expect(DEFAULTS.showPronouns).toBe(false);
    expect(validateTheme({ ...DEFAULTS, emoteScale: 2.2, showBadges: false, showPronouns: true }))
      .toMatchObject({ emoteScale: 2.2, showBadges: false, showPronouns: true });
    expect(() => validateTheme({ ...DEFAULTS, emoteScale: "3em" })).toThrow();
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
});
