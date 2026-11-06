import { expect, test } from "@playwright/test";
import { seedStudioSession, setRange } from "./studio-session";

test("keeps the channel add input value and focus when another control saves", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await page.locator("#channel-field-button").click();

  const addInput = page.locator("[data-channel-new]");
  await addInput.focus();
  await addInput.fill("second");
  await setRange(page, "fontSize", 22);

  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1", { timeout: 5_000 });
  await expect(addInput).toHaveValue("second");
  await expect(addInput).toBeFocused();
});

test("renews only the channel editor when a channel input changes on tab", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await page.locator("#channel-field-button").click();

  const channelInput = page.locator("[data-channel-value]").first();
  await channelInput.fill("renamed");
  await channelInput.press("Tab");

  const addInput = page.locator("[data-channel-new]");
  await expect(page.locator("[data-channel-value]").first()).toHaveValue("renamed");
  await expect(addInput).toBeFocused();
});

test("removing a channel refreshes the list before a later reorder", async ({ page }) => {
  const { token, login } = await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await page.locator("#channel-field-button").click();

  const savedChannels = async (): Promise<string[]> => {
    const response = await page.request.get("/api/overlay/config", {
      headers: { Authorization: `Bearer ${token}` },
    });
    const snapshot = await response.json() as { config: { channels: string[] } };
    return snapshot.config.channels;
  };
  const addInput = page.locator("[data-channel-new]");
  await addInput.fill("second");
  await page.locator("[data-channel-add]").click();
  await expect.poll(savedChannels).toEqual([login, "second"]);
  await page.locator("[data-channel-new]").fill("third");
  await page.locator("[data-channel-add]").click();
  await expect.poll(savedChannels).toEqual([login, "second", "third"]);

  await page.locator("[data-channel-new]").fill("pending");
  await page.locator("[data-channel-focus=remove-1]").click();
  await expect.poll(savedChannels).toEqual([login, "third"]);
  await expect(page.locator("[data-channel-new]")).toHaveValue("pending");
  await expect(page.locator("[data-channel-focus=remove-1]")).toBeFocused();

  await page.locator("[data-channel-focus=down-0]").click();
  await expect.poll(savedChannels).toEqual(["third", login]);
});
