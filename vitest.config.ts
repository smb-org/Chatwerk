import { defineConfig } from "vitest/config";

export default defineConfig({
  define: { __CHATWERK_TEST_FEATURES__: JSON.stringify({ reactions: true, hypeTrain: true }) },
  test: {
    include: ["tests/unit/**/*.test.ts"],
    exclude: ["tests/unit/features-off.test.ts"],
    passWithNoTests: true,
  },
});
