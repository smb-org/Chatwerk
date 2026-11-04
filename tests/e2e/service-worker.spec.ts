import { expect, test } from "@playwright/test";

test("the first successful overlay load asks the active service worker to cache its HTML and assets", async ({ page }) => {
  const response = await page.goto("/overlay");
  expect(response?.ok()).toBe(true);

  await expect.poll(() => page.evaluate(async () => {
    if (!("serviceWorker" in navigator)) return false;
    await navigator.serviceWorker.ready;
    const htmlResponse = await caches.match(`${location.origin}/overlay`);
    if (!htmlResponse) return false;
    const html = await htmlResponse.text();
    const assets = [...html.matchAll(/(?:src|href)\s*=\s*["']([^"']*\/assets\/[^"']+)["']/giu)]
      .map((match) => new URL(match[1]!, location.origin).href);
    return assets.length > 0 && (await Promise.all(assets.map(async (asset) => (await caches.match(asset)) !== undefined)))
      .every(Boolean);
  }), { timeout: 10_000 }).toBe(true);
});
