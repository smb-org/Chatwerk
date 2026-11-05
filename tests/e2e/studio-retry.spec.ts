import { expect, test } from "@playwright/test";
import { seedStudioSession } from "./studio-session";

test("retries a failed initial Studio load and finishes initialization", async ({ page }) => {
  await seedStudioSession(page);
  let overlayRequests = 0;
  await page.route("**/api/overlays", async (route) => {
    overlayRequests += 1;
    if (overlayRequests === 1) {
      await route.fulfill({ status: 503, body: "temporary failure" });
      return;
    }
    await route.continue();
  });

  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Could not load. Retrying...");
  await expect.poll(() => overlayRequests, { timeout: 8_000 }).toBe(2);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await expect(page.locator("#theme-fontSize")).toBeVisible();
  await expect(page.locator("#overlay-url")).toHaveValue(/\/overlay#token=/u);
});
