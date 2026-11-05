import { expect, test } from "@playwright/test";
import { seedStudioSession } from "./studio-session";

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

  await page.locator("#live-chat").check();
  const preview = page.frameLocator("#studio-preview");
  const highlighted = preview.locator(".chat-highlighted");
  await expect(highlighted).toHaveCount(1);
  const backgroundColor = () => highlighted.evaluate((row) => getComputedStyle(row).backgroundColor);
  await expect.poll(backgroundColor).toBe("rgb(255, 230, 128)");

  await page.locator("#theme-highlightBackgroundColor-hex").fill("#123456");
  await expect.poll(backgroundColor).toBe("rgb(18, 52, 86)");
});
