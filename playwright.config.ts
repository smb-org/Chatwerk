import { defineConfig } from "@playwright/test";
import { TEST_SESSION_KEY } from "./tests/e2e/test-session";
const port = Number(process.env.PLAYWRIGHT_PORT ?? 17174);

export default defineConfig({
  testDir: "./tests/e2e",
  use: {
    baseURL: `http://127.0.0.1:${port}`,
  },
  webServer: {
    command: `pnpm run build && node scripts/wrangler-dev.mjs ${port}`,
    url: `http://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    timeout: 120_000,
    env: {
      ...process.env,
      CHATWERK_E2E: "1",
      SESSION_KEY: TEST_SESSION_KEY,
      TWITCH_CLIENT_ID: "chatwerk-e2e-client",
      TWITCH_CLIENT_SECRET: "chatwerk-e2e-secret",
    },
  },
});
