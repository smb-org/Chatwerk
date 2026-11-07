import { expect, test } from "@playwright/test";
import { e2eOrigin, seedStudioSession, selectSettingsTabForField, setThemeChecked } from "./studio-session";

test("resolves and updates the source label for an existing Shared Chat row", async ({ page }) => {
  let nameRequestCount = 0;
  await page.route("https://api.ivr.fi/**", async (route) => {
    nameRequestCount += 1;
    await new Promise((resolve) => setTimeout(resolve, 250));
    await route.fulfill({ json: [{ id: "20", login: "partner", displayName: "PartnerName" }] });
  });
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (!command.startsWith("JOIN #")) return;
      const channel = command.slice("JOIN #".length);
      socket.send(`@room-id=10 :tmi.twitch.tv ROOMSTATE #${channel}`);
      socket.send(`@id=shared-name;room-id=10;source-room-id=20;display-name=Viewer :viewer!viewer@host PRIVMSG #${channel} :hello`);
    });
  });
  await page.goto("/overlay#channel=sharedroom&client=browser");

  const row = page.locator(".chat-line");
  const source = row.locator(".chat-source-room");
  await expect(source).toHaveText("via 20");
  await row.evaluate((element) => element.setAttribute("data-row-marker", "kept"));
  await expect(source).toHaveText("via PartnerName");
  await expect(source).toHaveAttribute("aria-label", "Shared chat source room PartnerName");
  await expect(row).toHaveAttribute("data-row-marker", "kept");
  expect(nameRequestCount).toBe(1);
});

test("the Filters tab toggle hides partner messages before resolving their source room", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const configured = await page.request.put(`${e2eOrigin}/api/overlays/${identity.overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision: 0, patch: { channels: [identity.login] } },
  });
  expect(configured.status()).toBe(200);
  let nameRequestCount = 0;
  await page.route("https://api.ivr.fi/**", async (route) => {
    nameRequestCount += 1;
    await route.fulfill({ json: [{ id: "20", login: "partner", displayName: "PartnerName" }] });
  });
  await page.route("https://recent-messages.robotty.de/**", (route) => route.fulfill({ json: { messages: [] } }));
  await page.addInitScript(() => localStorage.setItem("chatwerk-language", "de"));
  let partnerMessageSent = false;
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      for (const command of String(message).split(/\r?\n/u)) {
        const match = /^JOIN #([a-z0-9_]+)$/u.exec(command.trim());
        if (!match) continue;
        const channel = match[1]!;
        socket.send(`@room-id=10 :tmi.twitch.tv ROOMSTATE #${channel}`);
        socket.send(`@id=visible-own;room-id=10 :viewer!viewer@host PRIVMSG #${channel} :own message`);
        socket.send(`@id=hidden-shared;room-id=10;source-room-id=20 :viewer!viewer@host PRIVMSG #${channel} :partner message`);
        partnerMessageSent = true;
      }
    });
  });

  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await setThemeChecked(page, "showSharedChat", false);
  await expect(page.locator('[data-theme-field="showSharedChat"] label')).toHaveText("Nachrichten aus geteiltem Chat anzeigen");
  await page.locator("#preview-mode-live").click();

  const preview = page.frameLocator("#studio-preview");
  await expect.poll(() => partnerMessageSent).toBe(true);
  await expect(preview.locator(".chat-line")).toHaveCount(1);
  await expect(preview.locator(".chat-line").first()).toContainText("own message");
  expect(nameRequestCount).toBe(0);
  await expect(page.locator('[data-theme-field="showSharedChat"] input')).not.toBeChecked();
});

test("renders Shared Chat pill and avatar source labels using the mocked partner profile", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const configured = await page.request.put(`${e2eOrigin}/api/overlays/${identity.overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision: 0, patch: { channels: [identity.login], sharedChatLabel: "pill" } },
  });
  expect(configured.status()).toBe(200);
  let nameRequestCount = 0;
  await page.route("https://api.ivr.fi/**", async (route) => {
    nameRequestCount += 1;
    await route.fulfill({ json: [{ id: "20", login: "partner", displayName: "PartnerName", logo: "https://static-cdn.jtvnw.net/user.png" }] });
  });
  await page.route("https://static-cdn.jtvnw.net/**", (route) => route.fulfill({
    status: 200,
    contentType: "image/png",
    body: Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/8ZcAAAAASUVORK5CYII=", "base64"),
  }));
  await page.route("https://recent-messages.robotty.de/**", (route) => route.fulfill({ json: { messages: [] } }));
  let partnerMessageSent = false;
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      for (const command of String(message).split(/\r?\n/u)) {
        const match = /^JOIN #([a-z0-9_]+)$/u.exec(command.trim());
        if (!match) continue;
        const channel = match[1]!;
        socket.send(`@room-id=10 :tmi.twitch.tv ROOMSTATE #${channel}`);
        socket.send(`@id=styled-shared;room-id=10;source-room-id=20 :viewer!viewer@host PRIVMSG #${channel} :partner message`);
        partnerMessageSent = true;
      }
    });
  });
  await page.addInitScript(() => localStorage.setItem("chatwerk-language", "de"));

  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await page.locator("#preview-mode-live").click();
  const preview = page.frameLocator("#studio-preview");
  const source = preview.locator(".chat-source-room");
  await expect.poll(() => partnerMessageSent).toBe(true);
  await expect(source).toHaveAttribute("data-style", "pill");
  await expect(source.locator(".chat-source-pill")).toHaveText("PartnerName");

  await selectSettingsTabForField(page, "sharedChatLabel");
  await page.locator("#theme-sharedChatLabel").selectOption("avatar");
  await expect(source).toHaveAttribute("data-style", "avatar");
  await expect(source.locator("img.chat-source-avatar")).toHaveAttribute("alt", "PartnerName");
  await expect(source.locator("img.chat-source-avatar")).toHaveAttribute("src", "https://static-cdn.jtvnw.net/user.png");
  await expect(page.locator("#theme-sharedChatPrefix")).toBeDisabled();
  await page.locator("#theme-sharedChatLabel").selectOption("text");
  await expect(page.locator("#theme-sharedChatPrefix")).toBeEnabled();
  expect(nameRequestCount).toBe(1);
});
