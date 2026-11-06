import { spawnSync } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const flagsOffEnv = { ...process.env, PLAYWRIGHT_PORT: "18535" };
delete flagsOffEnv.CHATWERK_TEST_FEATURES;

const flagsOff = spawnSync(pnpm, ["exec", "playwright", "test", "--config=playwright.flags-off.config.ts"], {
  env: flagsOffEnv,
  stdio: "inherit",
});
const normalEnv = { ...process.env, PLAYWRIGHT_PORT: process.env.PLAYWRIGHT_PORT ?? "17174" };
delete normalEnv.CHATWERK_TEST_FEATURES;
const normal = spawnSync(pnpm, ["exec", "playwright", "test", "--config=playwright.config.ts"], {
  env: normalEnv,
  stdio: "inherit",
});

process.exitCode = flagsOff.error || flagsOff.status !== 0 || normal.error || normal.status !== 0 ? 1 : 0;
