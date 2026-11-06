import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const migrations = await readD1Migrations(resolve("migrations"));

export default defineConfig({
  define: { __CHATWERK_TEST_FEATURES__: JSON.stringify({ reactions: true, hypeTrain: true }) },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: migrations,
          SESSION_KEY: "hype-train-worker-session-key",
          TWITCH_CLIENT_SECRET: "hype-train-test-client-secret",
        },
      },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    exclude: ["tests/worker/features-off.test.ts"],
    setupFiles: ["./tests/worker/setup.ts"],
  },
});
