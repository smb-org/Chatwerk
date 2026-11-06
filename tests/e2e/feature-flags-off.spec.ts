import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { seedStudioSession } from "./studio-session";

test("file flags hide reactions and Hype Train without changing saved themes or chat rows", async ({ page }) => {
  mkdirSync(".tmp/shots", { recursive: true });
  const identity = await seedStudioSession(page);
  const effectRequests: string[] = [];
  const twitchRequests: string[] = [];
  await page.route(/^https:\/\/(?:id|api)\.twitch\.tv\//u, (route) => route.abort());
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith("/effects/")) effectRequests.push(url.pathname);
    if (["id.twitch.tv", "api.twitch.tv", "irc-ws.chat.twitch.tv"].includes(url.hostname)) twitchRequests.push(url.hostname);
  });

  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/studio?hypeTrain=denied");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await expect(page).toHaveURL(/\/studio\?hypeTrain=denied$/u);
  await expect(page.getByRole("tab")).toHaveText(["Appearance", "Layout", "Messages", "Emotes & Effects", "Filters"]);
  await expect(page.locator('[data-theme-field^="reaction"]')).toHaveCount(0);
  await expect(page.locator("#hype-train-consent")).toHaveCount(0);
  for (const id of ["rehearse-raid", "rehearse-sub", "rehearse-bits", "rehearse-hype-train"]) {
    await expect(page.locator(`#${id}`)).toHaveCount(0);
  }
  await expect(page.getByRole("button", { name: "Connect Hype Train" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Disconnect" })).toHaveCount(0);
  await expect(page.locator("#toast-text")).not.toContainText("Hype Train");
  if (await page.locator("#first-run-done").isVisible()) await page.locator("#first-run-done").click();
  await page.screenshot({ path: ".tmp/shots/flags-off-studio.png", fullPage: true });

  await page.goto(`/auth/hype-train?overlayId=${identity.overlayId}`);
  await expect(page).toHaveURL(/\/studio$/u);
  expect(twitchRequests).toEqual([]);

  const saved = await page.evaluate(async ({ overlayId, token }) => {
    const currentResponse = await fetch("/api/overlay/config", {
      headers: { Authorization: `Bearer ${token}` }, cache: "no-store",
    });
    const current = await currentResponse.json() as { revision: number };
    const write = await fetch(`/api/overlays/${overlayId}/config`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision: current.revision, patch: {
        reactionRaid: true, reactionSub: true, reactionResub: true, reactionSubgift: true, reactionBits: true,
        reactionHypeTrain: true, reactionIntensity: 1, reactionSoundEnabled: true, reactionVolume: 1,
      } }),
    });
    return { status: write.status, body: await write.json() as { config?: Record<string, unknown> } };
  }, identity);
  expect(saved.status).toBe(200);
  expect(saved.body.config).toMatchObject({ reactionSub: true, reactionHypeTrain: true, reactionSoundEnabled: true });

  await page.reload();
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  const preview = page.frameLocator("#studio-preview");
  await expect(preview.locator("#chat")).toBeVisible();
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>("#studio-preview")?.contentWindow?.postMessage(
      { type: "chatwerk:studio-scenario", scenario: "sub" }, "*",
    );
  });
  await expect(preview.locator(".chat-line").filter({ hasText: "Thanks for the welcome!" })).toHaveCount(1);
  await expect(preview.locator(".reaction-layer, .reaction-burst, .reaction-rain, .reaction-effect, .chat-reaction-highlight")).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(effectRequests).toEqual([]);
  expect(twitchRequests).toEqual([]);
});
