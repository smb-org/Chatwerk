import { describe, expect, it } from "vitest";
import { FEATURES, featureEnabled } from "../../src/shared/features";
import { THEME_FIELDS, THEME_UI_GROUPS, type ThemeUiGroup } from "../../src/shared/theme";
import { isSettingsFieldEnabled, isSettingsRehearsalEnabled, SETTINGS_TABS, settingsTabsFor } from "../../src/studio/settings-tabs";

describe("file feature flags", () => {
  it("loads the checked-in flags as disabled through the typed accessor", () => {
    expect(FEATURES).toEqual({ reactions: false, hypeTrain: false });
    expect(featureEnabled("reactions")).toBe(false);
    expect(featureEnabled("hypeTrain")).toBe(false);
  });

  it("covers every enabled theme group and explicitly excludes disabled Reactions", () => {
    expect(SETTINGS_TABS.map((tab) => tab.id)).toEqual([
      "appearance", "layout", "messages", "emotes-effects", "filters",
    ]);
    const tabGroups = new Set<ThemeUiGroup>(SETTINGS_TABS.flatMap((tab) => tab.groups));
    const groupsWithFields = new Set(Object.values(THEME_FIELDS).map((field) => field.ui.group));

    for (const group of THEME_UI_GROUPS) {
      if (group === "Channels") continue;
      if (group === "Reactions" && !featureEnabled("reactions")) continue;
      if (group === "Advanced" && !groupsWithFields.has(group)) continue;
      expect(tabGroups, `${group} must be assigned to a settings tab`).toContain(group);
    }
  });

  it("keeps Reactions independently available while hiding only Hype Train controls", () => {
    const flags = { reactions: true, hypeTrain: false } as const;
    expect(settingsTabsFor(flags).map((tab) => tab.id)).toContain("reactions");
    expect(isSettingsFieldEnabled("reactionRaid", flags)).toBe(true);
    expect(isSettingsFieldEnabled("reactionHypeTrain", flags)).toBe(false);
    expect(isSettingsRehearsalEnabled("raid", flags)).toBe(true);
    expect(isSettingsRehearsalEnabled("hype-train", flags)).toBe(false);
  });

  it("removes every effect rehearsal when Reactions is off, even if Hype Train is on", () => {
    const flags = { reactions: false, hypeTrain: true } as const;
    for (const scenario of ["raid", "sub", "bits", "hype-train", "rain"]) {
      expect(isSettingsRehearsalEnabled(scenario, flags)).toBe(false);
    }
    expect(isSettingsRehearsalEnabled("quiet", flags)).toBe(true);
    expect(isSettingsRehearsalEnabled("flood", flags)).toBe(true);
  });
});
