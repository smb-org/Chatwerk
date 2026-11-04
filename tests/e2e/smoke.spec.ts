import { expect, test } from "@playwright/test";

test("serves the studio shell and health endpoint", async ({ page, request }) => {
  await page.goto("/");
  await expect(page).toHaveTitle("Chatwerk");

  const health = await request.get("/health");
  expect(health.ok()).toBe(true);
  await expect(health.json()).resolves.toEqual({ ok: true });
});
