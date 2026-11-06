import type { ThemeUiGroup } from "../shared/theme";
import { FEATURES, featureEnabled, type FeatureFlags } from "../shared/features";

const ALL_SETTINGS_TABS = [
  { id: "appearance", groups: ["Text", "Colors", "Panel"] },
  { id: "layout", groups: ["Layout"] },
  { id: "messages", groups: ["Messages"] },
  { id: "emotes-effects", groups: ["Emotes & Effects"] },
  { id: "reactions", groups: ["Reactions"] },
  { id: "filters", groups: ["Filters"] },
] as const satisfies readonly { id: string; groups: readonly ThemeUiGroup[] }[];

export function settingsTabsFor(flags: Readonly<FeatureFlags> = FEATURES) {
  return ALL_SETTINGS_TABS.filter((tab) => tab.id !== "reactions" || featureEnabled("reactions", flags));
}

export function isSettingsFieldEnabled(name: string, flags: Readonly<FeatureFlags> = FEATURES): boolean {
  if (name === "reactionHypeTrain") return featureEnabled("reactions", flags) && featureEnabled("hypeTrain", flags);
  return !name.startsWith("reaction") || featureEnabled("reactions", flags);
}

export function isSettingsRehearsalEnabled(scenario: string, flags: Readonly<FeatureFlags> = FEATURES): boolean {
  if (scenario === "quiet" || scenario === "flood") return true;
  if (!featureEnabled("reactions", flags)) return false;
  return scenario !== "hype-train" || featureEnabled("hypeTrain", flags);
}

export const SETTINGS_TABS = settingsTabsFor();
export type SettingsTabId = (typeof ALL_SETTINGS_TABS)[number]["id"];
