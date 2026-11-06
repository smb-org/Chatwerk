import type { ThemeUiGroup } from "../shared/theme";

export const SETTINGS_TABS = [
  { id: "appearance", groups: ["Text", "Colors", "Panel"] },
  { id: "layout", groups: ["Layout"] },
  { id: "messages", groups: ["Messages"] },
  { id: "emotes-effects", groups: ["Emotes & Effects"] },
  { id: "reactions", groups: ["Reactions"] },
  { id: "filters", groups: ["Filters"] },
] as const satisfies readonly { id: string; groups: readonly ThemeUiGroup[] }[];

export type SettingsTabId = (typeof SETTINGS_TABS)[number]["id"];
