import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { seedStudioSession, setRange } from "./studio-session";

const shots = ".tmp/shots";
const statusResponse = (role: "owner" | "editor", connected: boolean) => ({ role, connected });

test("Hype Train rehearsal shows the frame ring and chip, then clears", async ({ page }) => {
  test.setTimeout(40_000);
  mkdirSync(shots, { recursive: true });
  await seedStudioSession(page);
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({ json: statusResponse("owner", false) }));
  await page.setViewportSize({ width: 1360, height: 900 });
  await page.goto("/studio?hypeTrain=denied");
  await expect(page).toHaveURL(/\/studio$/u);
  await expect(page.locator("#toast-text")).toHaveText("Hype Train permission was not granted.");
  await page.locator("#toast-close").click();
  await page.locator("#first-run-done").click();
  const preview = page.frameLocator("#studio-preview");
  const chat = preview.locator("#chat");
  await page.locator("#preview-size-preset").selectOption("400x600");
  await page.locator("#preview-one-to-one").click();
  await expect.poll(() => page.locator("#studio-preview").evaluate((frame) => {
    const rect = frame.getBoundingClientRect();
    return [rect.width, rect.height];
  })).toEqual([400, 600]);

  await page.locator("#rehearse-hype-train").click();
  const layer = preview.locator(".reaction-layer");
  await expect(layer).toHaveClass(/hype-train-active/u);
  const ring = await layer.evaluate((element) => {
    const style = getComputedStyle(element, "::before");
    return { content: style.content, width: style.borderTopWidth, style: style.borderTopStyle, color: style.borderTopColor };
  });
  expect(ring.content).not.toBe("none");
  expect(ring.content).not.toBe("normal");
  expect(ring.width).toBe("2px");
  expect(ring.style).toBe("solid");
  expect(ring.color).not.toBe("rgba(0, 0, 0, 0)");
  await expect(preview.locator(".hype-train-chip")).toContainText("LV 1");
  await expect(chat.locator(".chat-line")).toHaveCount(3);
  const chatText = await chat.locator(".chat-line").evaluateAll((lines) => lines.map((line) => line.textContent ?? "").join(" "));
  expect(chatText).not.toContain("Hype Train");
  await chat.screenshot({ path: `${shots}/hype-active-400x600.png` });

  const geometry = await layer.evaluate((element) => {
    const frame = element.ownerDocument.querySelector("#chat")!.getBoundingClientRect();
    const bounds = element.getBoundingClientRect();
    return { frame: [frame.width, frame.height], layer: [bounds.width, bounds.height], pointerEvents: getComputedStyle(element).pointerEvents };
  });
  expect(geometry.layer).toEqual(geometry.frame);
  expect(geometry.pointerEvents).toBe("none");

  await setRange(page, "maxChatHeight", 200);
  await expect(chat).toHaveAttribute("data-height-limited", "true");
  await page.locator("#rehearse-hype-train").click();
  await expect(preview.locator(".hype-train-chip")).toBeVisible();
  await page.locator("#theme-panelEnabled").check();
  await page.locator('input[name="theme-layout"][value="ticker"]').check();
  await page.locator("#rehearse-hype-train").click();
  await expect(chat).toHaveAttribute("data-layout", "ticker");
  await expect(preview.locator(".hype-train-chip")).toBeVisible();

  await expect(preview.locator(".hype-train-chip")).toHaveCount(0, { timeout: 12_000 });
  await expect(layer).not.toHaveClass(/hype-train-active/u);
});

test("Studio shows owner connection states and the helper-only notice", async ({ page }) => {
  test.setTimeout(35_000);
  mkdirSync(shots, { recursive: true });
  await seedStudioSession(page);
  let role: "owner" | "editor" = "owner";
  let connected = false;
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({ json: statusResponse(role, connected) }));
  await page.setViewportSize({ width: 1440, height: 960 });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  const consent = page.locator("#hype-train-consent");
  await expect(consent).toHaveAttribute("data-state", "disconnected");
  await expect(consent.getByRole("button", { name: "Connect Hype Train" })).toBeVisible();
  await expect(consent.locator(".hype-consent-copy")).toHaveText("One-time Twitch permission for Hype Train events. Only consent is stored.");
  expect(await consent.locator(".hype-consent-copy").evaluate((copy) => copy.scrollHeight <= copy.clientHeight)).toBe(true);
  await page.locator(".account-menu > summary").click();
  await page.locator("#language-de").click();
  await expect(consent.locator(".hype-consent-copy")).toHaveText("Einmalige Twitch-Erlaubnis für Hype Trains. Gespeichert wird nur die Zustimmung.");
  expect(await consent.locator(".hype-consent-copy").evaluate((copy) => copy.scrollHeight <= copy.clientHeight)).toBe(true);
  await page.locator("#language-en").click();

  connected = true;
  await page.reload();
  await page.locator("#settings-scroll").locator('[data-theme-field="reactionHypeTrain"]').scrollIntoViewIfNeeded();
  await expect(consent).toHaveAttribute("data-state", "connected");
  await expect(consent.getByRole("status")).toHaveText("Connected");
  await expect(consent.getByRole("button", { name: "Disconnect" })).toBeVisible();
  await page.screenshot({ path: `${shots}/hype-studio-owner.png`, fullPage: true });

  role = "editor";
  await page.reload();
  await page.locator("#settings-scroll").locator('[data-theme-field="reactionHypeTrain"]').scrollIntoViewIfNeeded();
  await expect(consent).toHaveAttribute("data-state", "helper");
  await expect(consent.getByText("Only the streamer can connect this overlay.")).toBeVisible();
  await expect(consent.locator("button")).toBeHidden();
  await page.screenshot({ path: `${shots}/hype-studio-helper.png`, fullPage: true });
});
