import { expect, test } from "@playwright/test";
import { e2eOrigin, seedStudioSession, setRange } from "./studio-session";

test("coalesces slider changes while one delayed save is in flight", async ({ page }) => {
  const { overlayId, token } = await seedStudioSession(page);
  await page.goto("/studio");
  const bodies: Array<{ baseRevision: number; patch: Record<string, unknown> }> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  await page.route(`**/api/overlays/${overlayId}/config`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    bodies.push(route.request().postDataJSON() as { baseRevision: number; patch: Record<string, unknown> });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
    concurrent -= 1;
  });

  await setRange(page, "fontSize", 20);
  await page.waitForTimeout(240);
  await setRange(page, "fontSize", 24);
  await page.waitForTimeout(60);
  await setRange(page, "fontSize", 28);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2", { timeout: 5_000 });
  expect(bodies.length).toBe(2);
  expect(maxConcurrent).toBe(1);
  expect(bodies[1]).toEqual({ baseRevision: 1, patch: { fontSize: 28 } });

  const response = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expect(response.json()).resolves.toMatchObject({ revision: 2, config: { fontSize: 28 } });
});

test("reloads after a 409 and reapplies the pending slider change", async ({ page }) => {
  const { overlayId, token } = await seedStudioSession(page);
  await page.goto("/studio");
  await page.waitForTimeout(150);
  const external = await page.request.put(`${e2eOrigin}/api/overlays/${overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision: 0, patch: { fontWeight: 700 } },
  });
  expect(external.status()).toBe(200);

  await setRange(page, "fontSize", 30);
  await expect(page.locator("#status-visible")).toHaveText("Changed in another tab. Reloaded and applied your last change.", { timeout: 5_000 });
  const response = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expect(response.json()).resolves.toMatchObject({
    revision: 2,
    config: { fontSize: 30, fontWeight: 700 },
  });
  await expect(page.locator("#studio-preview").contentFrame().locator("#chat"))
    .toHaveCSS("--t-font-size", "30px");
});

test("uses a local object URL for Mine without sending a network request", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.locator("#preview-background-file").setInputFiles({
    name: "local.png", mimeType: "image/png", buffer: Buffer.from("local-test-image"),
  });
  await expect(page.getByRole("radio", { name: "Mine" })).toBeChecked();
  expect(requests.filter((url) => new URL(url).origin !== e2eOrigin)).toEqual([]);
  expect(requests.filter((url) => url.includes("local.png"))).toEqual([]);
});
