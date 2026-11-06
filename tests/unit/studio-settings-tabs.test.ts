import { describe, expect, it } from "vitest";
import { THEME_FIELDS, THEME_UI_GROUPS, type ThemeUiGroup } from "../../src/shared/theme";
import { SETTINGS_TABS } from "../../src/studio/settings-tabs";

describe("studio settings tabs", () => {
  it("covers every non-channel theme group, except empty Advanced", () => {
    const tabGroups = new Set<ThemeUiGroup>(SETTINGS_TABS.flatMap((tab) => tab.groups));
    const groupsWithFields = new Set(Object.values(THEME_FIELDS).map((field) => field.ui.group));

    for (const group of THEME_UI_GROUPS) {
      if (group === "Channels") continue;
      if (group === "Advanced" && !groupsWithFields.has(group)) continue;
      expect(tabGroups, `${group} must be assigned to a settings tab`).toContain(group);
    }
  });
});
