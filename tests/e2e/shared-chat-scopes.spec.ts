import { expect, test } from "@playwright/test";

test("alternating Shared Chat source rooms do not churn channel emote provider scopes", async ({ page }) => {
  const channelFetches: string[] = [];
  const eventCommands: Array<{ op: number; d?: { type?: string; condition?: Record<string, string> } }> = [];
  await page.route("https://7tv.io/**", async (route) => {
    const url = new URL(route.request().url());
    const channelMatch = /\/users\/twitch\/([^/]+)$/u.exec(url.pathname);
    if (channelMatch) {
      const channelId = decodeURIComponent(channelMatch[1]!);
      channelFetches.push(channelId);
      await route.fulfill({ json: {
        user: { id: `7tv-user-${channelId}` },
        emote_set: { id: `channel-set-${channelId}`, emotes: [] },
      } });
      return;
    }
    if (url.pathname.endsWith("/emote-sets/global")) {
      await route.fulfill({ json: { id: "global-set", emotes: [] } });
      return;
    }
    await route.fulfill({ json: { id: "set", emotes: [] } });
  });
  await page.route("https://api.betterttv.net/**", (route) => route.fulfill({ json: {} }));
  await page.route("https://api.frankerfacez.com/**", (route) => route.fulfill({ json: { sets: {} } }));
  await page.routeWebSocket("wss://events.7tv.io/v3", (socket) => {
    socket.onMessage((message) => {
      try { eventCommands.push(JSON.parse(String(message)) as typeof eventCommands[number]); } catch { /* Ignore non-JSON frames. */ }
    });
    socket.send(JSON.stringify({ op: 1, d: { heartbeat_interval: 30_000, session_id: "e2e-session" } }));
  });

  const joins: string[] = [];
  let sendIrc: ((line: string) => void) | undefined;
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    sendIrc = (line) => socket.send(line);
    socket.onMessage((message) => {
      for (const command of String(message).split(/\r?\n/u)) {
        const match = /^JOIN #([a-z0-9_]+)$/u.exec(command.trim());
        if (!match) continue;
        const channel = match[1]!;
        joins.push(channel);
        socket.send(`@room-id=${channel === "main" ? "10" : "20"} :tmi.twitch.tv ROOMSTATE #${channel}`);
      }
    });
  });

  await page.goto("/");
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "shared-chat-preview";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.style.width = "400px";
    frame.style.height = "600px";
    frame.src = "/overlay#client=studio";
    document.body.appendChild(frame);
  });
  const frame = page.frameLocator("#shared-chat-preview");
  await expect(frame.locator("#chat")).toBeVisible();
  await expect(frame.locator(".chat-empty")).toHaveText("No channel set. Open Studio to add one.");
  await page.evaluate(() => {
    const preview = document.querySelector<HTMLIFrameElement>("#shared-chat-preview")!.contentWindow!;
    preview.postMessage({ type: "chatwerk:studio-theme", theme: { channels: ["main", "second"] } }, "*");
    preview.postMessage({ type: "chatwerk:studio-live", enabled: true, channels: ["main", "second"] }, "*");
  });

  await expect.poll(() => joins.slice().sort()).toEqual(["main", "second"]);
  await expect.poll(() => channelFetches.slice().sort()).toEqual(["10", "20"]);
  const paintEventTypes = ["cosmetic.create", "entitlement.create", "entitlement.delete"];
  await expect.poll(() => eventCommands.filter((command) => command.op === 35 &&
    paintEventTypes.includes(command.d?.type ?? "") && command.d?.condition?.id === "10")).toHaveLength(3);
  for (let index = 0; index < 6; index += 1) {
    const channel = index % 2 === 0 ? "main" : "second";
    const roomId = index % 2 === 0 ? "10" : "20";
    const sourceRoomId = index % 2 === 0 ? "30" : "40";
    sendIrc?.(`@id=shared-${index};room-id=${roomId};source-room-id=${sourceRoomId} :viewer!viewer@host PRIVMSG #${channel} :message ${index}`);
  }
  await expect(frame.locator(".chat-line")).toHaveCount(6);
  expect(channelFetches.slice().sort()).toEqual(["10", "20"]);

  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>("#shared-chat-preview")!.contentWindow!.postMessage({
      type: "chatwerk:studio-live", enabled: false,
    }, "*");
  });
  await expect.poll(() => eventCommands.filter((command) => command.op === 36 &&
    paintEventTypes.includes(command.d?.type ?? "") && command.d?.condition?.id === "10")).toHaveLength(3);
});
