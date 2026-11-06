import fileFeatures from "./features.json";

export interface FeatureFlags {
  reactions: boolean;
  hypeTrain: boolean;
}

declare const __CHATWERK_TEST_FEATURES__: FeatureFlags | undefined;

export const FILE_FEATURES: Readonly<FeatureFlags> = fileFeatures;
export const FEATURES: Readonly<FeatureFlags> = typeof __CHATWERK_TEST_FEATURES__ === "undefined"
  ? FILE_FEATURES
  : __CHATWERK_TEST_FEATURES__;

export function featureEnabled(feature: keyof FeatureFlags, flags: Readonly<FeatureFlags> = FEATURES): boolean {
  return flags[feature];
}
