import { expect, test } from "@playwright/test";
import { seedAdminSession } from "./studio-session";

test("renders the operator overview for an allowlisted session without page overflow", async ({ page }) => {
  const admin = await seedAdminSession(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin");

  await expect(page.locator("#admin-title")).toHaveText(/Operator admin|Operator-Übersicht/u);
  await expect(page.locator("#admin-table tbody tr").filter({ hasText: admin.login })).toHaveCount(1);
  await expect(page.locator("#admin-total-users")).not.toHaveText("—");
  await expect(page.getByRole("navigation").getByRole("link")).toHaveCount(3);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);

  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
  await expect.poll(() => page.locator("#admin-table-viewport").evaluate((element) => element.scrollWidth - element.clientWidth)).toBeGreaterThan(0);
});
