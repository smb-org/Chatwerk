import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/unit/features-off.test.ts"],
    passWithNoTests: false,
  },
});
