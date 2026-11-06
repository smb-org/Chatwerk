import { defineConfig } from "@playwright/test";
import { TEST_SESSION_KEY } from "./tests/e2e/test-session";

const port = 18535;

export default defineConfig({
  testDir: "./tests/e2e",
  testMatch: "feature-flags-off.spec.ts",
  workers: 1,
  use: {
    baseURL: `https://127.0.0.1:${port}`,
    ignoreHTTPSErrors: true,
    launchOptions: {
      args: [
        "--ignore-certificate-errors",
        "--disable-features=LocalNetworkAccessChecks",
        "--host-resolver-rules=MAP irc-ws.chat.twitch.tv 127.0.0.1, MAP id.twitch.tv 127.0.0.1, MAP api.twitch.tv 127.0.0.1",
      ],
    },
  },
  webServer: {
    command: `pnpm run build && node scripts/wrangler-dev.mjs ${port}`,
    url: `https://127.0.0.1:${port}/`,
    reuseExistingServer: false,
    ignoreHTTPSErrors: true,
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
