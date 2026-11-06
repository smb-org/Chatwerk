import { expect, test } from "@playwright/test";
import { addStudioOverlay, e2eOrigin, fillThemeControl, seedStudioSession } from "./studio-session";

test("updates an existing highlighted row when the live theme color changes", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await page.locator("#first-run-done").click();

  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (!command.startsWith("JOIN #")) return;
      const channel = command.slice("JOIN #".length).trim();
      socket.send(`:tmi.twitch.tv ROOMSTATE #${channel}`);
      socket.send(`@id=highlight;msg-id=highlighted-message :viewer!viewer@host PRIVMSG #${channel} :highlighted`);
    });
  });

  await page.locator("#preview-mode-live").click();
  const preview = page.frameLocator("#studio-preview");
  const highlighted = preview.locator(".chat-highlighted");
  await expect(highlighted).toHaveCount(1);
  const backgroundColor = () => highlighted.evaluate((row) => getComputedStyle(row).backgroundColor);
  await expect.poll(backgroundColor).toBe("rgb(255, 230, 128)");

  await fillThemeControl(page, "highlightBackgroundColor", "#123456", ".hex-control");
  await expect.poll(backgroundColor).toBe("rgb(18, 52, 86)");
});

test("shows live chat connection status until the first preview message arrives", async ({ page }) => {
  const identity = await seedStudioSession(page);
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (!command.startsWith("JOIN #")) return;
      const channel = command.slice("JOIN #".length).trim();
      setTimeout(() => socket.send(`:tmi.twitch.tv ROOMSTATE #${channel}`), 350);
      setTimeout(() => socket.send(`@id=first-line :viewer!viewer@host PRIVMSG #${channel} :hello chat`), 1_300);
    });
  });

  await page.goto("/studio");
  await page.locator("#preview-mode-live").click();
  const status = page.locator("#live-chat-status");
  await expect(status).toHaveText("Connecting...");
  await expect(status).toHaveText(`Connected to ${identity.login}. Waiting for messages.`, { timeout: 3_000 });
  await expect(status).toBeHidden({ timeout: 5_000 });
});

test("names every channel in the initial live waiting status", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const configured = await page.request.put(`${e2eOrigin}/api/overlays/${identity.overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision: 0, patch: { channels: [identity.login, "secondroom"] } },
  });
  expect(configured.status()).toBe(200);

  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (!command.startsWith("JOIN #")) return;
      const channel = command.slice("JOIN #".length).trim();
      socket.send(`:tmi.twitch.tv ROOMSTATE #${channel}`);
    });
  });

  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await page.locator("#preview-mode-live").click();
  const status = page.locator("#live-chat-status");
  await expect(status).toHaveText(`Connected to ${identity.login}, secondroom. Waiting for messages.`);
});

test("returns to waiting with every current channel after a live channel change", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const configured = await page.request.put(`${e2eOrigin}/api/overlays/${identity.overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision: 0, patch: { channels: [identity.login] } },
  });
  expect(configured.status()).toBe(200);

  const joins: string[] = [];
  let sendMessage!: (channel: string) => void;
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    sendMessage = (channel) => socket.send(`@id=live-status :viewer!viewer@host PRIVMSG #${channel} :hello`);
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (!command.startsWith("JOIN #")) return;
      const channel = command.slice("JOIN #".length).trim();
      joins.push(channel);
      socket.send(`:tmi.twitch.tv ROOMSTATE #${channel}`);
    });
  });

  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await page.locator("#preview-mode-live").click();
  const status = page.locator("#live-chat-status");
  await expect(status).toHaveText(`Connected to ${identity.login}. Waiting for messages.`);

  sendMessage(identity.login);
  await expect(status).toBeHidden();
  await page.locator("#channel-field-button").click();
  await page.locator("[data-channel-new]").fill("secondroom");
  await page.locator("[data-channel-add]").click();
  await expect.poll(() => joins).toContain("secondroom");
  await expect(status).toHaveText(`Connected to ${identity.login}, secondroom. Waiting for messages.`);
});

test("keeps the overlay selector and compact OBS size readable at 1024px", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioOverlay(identity.ownerId, "Second", identity.login);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto("/studio");

  const selector = page.locator("#active-overlay-select");
  await expect(selector).toBeVisible();
  await expect.poll(() => selector.evaluate((element) => element.getBoundingClientRect().width)).toBeGreaterThanOrEqual(120);
  await expect.poll(() => selector.evaluate((element) => {
    const parent = element.parentElement;
    return parent !== null && parent.getBoundingClientRect().right >= element.getBoundingClientRect().right;
  })).toBe(true);
  const hint = page.locator("#obs-size-hint");
  await expect(hint).toHaveText("OBS: 400 x 600");
  await expect.poll(() => hint.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
});
