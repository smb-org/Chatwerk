import { expect, test } from "@playwright/test";
import { seedStudioSession, setRange } from "./studio-session";

test("generated ticker slider and channel editor update a second live overlay", async ({ page }) => {
  const { token, login } = await seedStudioSession(page);
  await page.goto("/studio");

  const overlay = await page.context().newPage();
  const routedCommands: string[] = [];
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      routedCommands.push(command);
      if (command.startsWith("JOIN #")) {
        const channel = command.slice("JOIN #".length).trim();
        socket.send(`:tmi.twitch.tv ROOMSTATE #${channel}`);
        if (channel === "second") socket.send("@id=second;room-id=20 :viewer!viewer@host PRIVMSG #second :hello from second");
      }
    });
  });
  await overlay.goto(`/overlay#token=${token}&client=obs`);
  await expect.poll(() => routedCommands.some((command) => command.startsWith("JOIN #")), { timeout: 5_000 }).toBe(true);

  await setRange(page, "tickerSpeed", 140);
  const addChannel = page.locator("[data-channel-new]");
  await addChannel.fill("second");
  await page.locator("[data-channel-add]").click();

  await expect.poll(async () => {
    const response = await page.request.get("/api/overlay/config", { headers: { Authorization: `Bearer ${token}` } });
    const snapshot = await response.json() as { config: { channels: string[] } };
    return snapshot.config.channels;
  }, { timeout: 5_000 }).toEqual([login, "second"]);
  await expect.poll(() => overlay.locator("#chat").evaluate((root) =>
    getComputedStyle(root).getPropertyValue("--t-ticker-speed").trim()), { timeout: 5_000 }).toBe("140px");
  await expect.poll(() => routedCommands.some((command) => command === "JOIN #second"), { timeout: 5_000 }).toBe(true);
  await expect(overlay.locator(".chat-source-channel")).toHaveText("#second");
  expect(routedCommands.filter((command) => command.startsWith("PART #"))).toEqual([]);
  const secondJoin = routedCommands.indexOf("JOIN #second");
  expect(secondJoin).toBeGreaterThanOrEqual(0);
  expect(routedCommands.slice(secondJoin + 1).filter((command) => command.startsWith("PART #"))).toEqual([]);
  await overlay.close();
});
