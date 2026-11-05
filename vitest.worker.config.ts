import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const migrations = await readD1Migrations(resolve("migrations"));

export default defineConfig({
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
    setupFiles: ["./tests/worker/setup.ts"],
  },
});
