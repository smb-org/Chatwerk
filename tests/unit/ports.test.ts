import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("fixed local ports", () => {
  it("keeps the project dev and Playwright defaults on the main branch ports", () => {
    const packageJson = JSON.parse(readFileSync(resolve("package.json"), "utf8")) as {
      scripts: { dev: string };
    };
    const wrangler = JSON.parse(readFileSync(resolve("wrangler.jsonc"), "utf8")) as {
      dev: { port: number };
    };
    const playwright = readFileSync(resolve("playwright.config.ts"), "utf8");

    expect(packageJson.scripts.dev).toContain("scripts/wrangler-dev.mjs 17173");
    expect(wrangler.dev.port).toBe(17173);
    expect(playwright).toMatch(/process\.env\.PLAYWRIGHT_PORT\s*\?\?\s*17174/u);
  });
});
