import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const wideSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="192" height="64"><rect width="192" height="64" fill="#f0a"/></svg>';
const ultraWideSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="768" height="64"><rect width="768" height="64" fill="#fa0"/></svg>';
const squareSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#0af"/></svg>';

test("updates a backlog row when its delayed 7TV emote set arrives without moving it", async ({ page }) => {
  let releaseChannelEmotes!: () => void;
  const channelEmotesGate = new Promise<void>((resolve) => { releaseChannelEmotes = resolve; });
  let channelEmotesRequested = false;
  await page.route("https://recent-messages.robotty.de/**", async (route) => {
    const now = Date.now();
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders, "content-type": "application/json" },
      body: JSON.stringify({ messages: [
        `@id=before;tmi-sent-ts=${now - 3_000};historical=1;display-name=Viewer :viewer!viewer@host PRIVMSG #room :before`,
        `@id=late-pog;tmi-sent-ts=${now - 2_000};historical=1;display-name=Viewer :viewer!viewer@host PRIVMSG #room :Pog`,
        `@id=after;tmi-sent-ts=${now - 1_000};historical=1;display-name=Viewer :viewer!viewer@host PRIVMSG #room :after`,
      ], error: null, error_code: null }),
    });
  });
  await page.route("https://7tv.io/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/emote-sets/global")) {
      await route.fulfill({ json: { id: "fixture-global", emotes: [] } });
      return;
    }
    if (/\/users\/twitch\/\d+$/u.test(url.pathname)) {
      channelEmotesRequested = true;
      await channelEmotesGate;
      await route.fulfill({ json: {
        user: { id: "fixture-user" },
        emote_set: { id: "fixture-channel", emotes: [{ id: "pog", name: "Pog" }] },
      } });
      return;
    }
    await route.fulfill({ json: { id: "fixture-set", emotes: [] } });
  });
  await page.route("https://cdn.7tv.app/**", async (route) => {
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body: squareSvg });
  });
  await page.routeWebSocket("wss://events.7tv.io/v3", (socket) => {
    socket.onMessage(() => undefined);
    socket.send(JSON.stringify({ op: 1, d: { heartbeat_interval: 30_000, session_id: "delayed-emote" } }));
  });
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const join = /^JOIN #([a-z0-9_]+)$/u.exec(String(message).trim());
      if (join) socket.send(`@room-id=10 :tmi.twitch.tv ROOMSTATE #${join[1]}`);
    });
  });

  await page.goto("/overlay#channel=room&client=browser");
  const chat = page.locator("#chat");
  const rows = chat.locator(".chat-line");
  const pogRow = rows.nth(1);
  await expect.poll(() => channelEmotesRequested).toBe(true);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("before");
  await expect(rows.nth(1).locator(".chat-message")).toHaveText("Pog");
  await expect(rows.nth(1).locator("img.chat-emote")).toHaveCount(0);
  await expect(rows.nth(2)).toContainText("after");
  expect(await pogRow.evaluate((row) => [...row.parentElement!.children].indexOf(row))).toBe(1);

  releaseChannelEmotes();

  await expect(rows.nth(1).locator('img.chat-emote[alt="Pog"]')).toHaveCount(1);
  await expect(rows).toHaveCount(3);
  await expect(rows.nth(0)).toContainText("before");
  await expect(rows.nth(2)).toContainText("after");
  expect(await pogRow.evaluate((row) => [...row.parentElement!.children].indexOf(row))).toBe(1);
});

test("renders bare backlog words and 7TV emotes from the mocked recent-messages route", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 200 });
  let releaseBacklog!: () => void;
  const backlogGate = new Promise<void>((resolve) => { releaseBacklog = resolve; });
  await page.route("https://recent-messages.robotty.de/**", async (route) => {
    await backlogGate;
    const now = Date.now();
    const messages = [
      `@id=bare-word;tmi-sent-ts=${now - 2_000};historical=1;display-name=Viewer :viewer!viewer@host PRIVMSG #room oldiHiThere`,
      `@id=wide-emote;tmi-sent-ts=${now - 1_500};historical=1;display-name=Viewer :viewer!viewer@host PRIVMSG #room Wide`,
      `@id=zero-width-overlay;tmi-sent-ts=${now - 1_000};historical=1;display-name=Viewer :viewer!viewer@host PRIVMSG #room BaseOverlay`,
    ];
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders, "content-type": "application/json" },
      body: JSON.stringify({ messages, error: null, error_code: null }),
    });
  });
  await page.route("https://7tv.io/**", async (route) => {
    const url = new URL(route.request().url());
    const emotes = [
      { id: "wide", name: "Wide" },
      { id: "base", name: "Base" },
      { id: "overlay", name: "Overlay", flags: 1 },
    ];
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders, "content-type": "application/json" },
      body: JSON.stringify(url.pathname.endsWith("/global")
        ? { id: "fixture-global", emotes }
        : { user: { id: "fixture-user" }, emote_set: { id: "fixture-set", emotes } }),
    });
  });
  await page.route("https://cdn.7tv.app/**", async (route) => {
    const body = route.request().url().includes("/overlay/") ? squareSvg : wideSvg;
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body });
  });
  await page.routeWebSocket("wss://events.7tv.io/v3", (socket) => {
    socket.onMessage(() => undefined);
    socket.send(JSON.stringify({ op: 1, d: { heartbeat_interval: 30_000, session_id: "emote-e2e" } }));
  });
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const join = /^JOIN #([a-z0-9_]+)$/u.exec(String(message).trim());
      if (join) socket.send(`@room-id=10 :tmi.twitch.tv ROOMSTATE #${join[1]}`);
    });
  });

  const globalEmotesResponse = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/v3/emote-sets/global"));
  await page.goto("/overlay#channel=room&client=browser");
  const globalEmotes = await globalEmotesResponse;
  await globalEmotes.finished();
  releaseBacklog();
  const chat = page.locator("#chat");
  await expect(chat.locator(".chat-line").filter({ hasText: "oldiHiThere" })).toHaveCount(1);
  const wide = chat.locator('img.chat-emote[alt="Wide"]');
  await expect(wide).toHaveCount(1);
  await expect(chat.locator('img.chat-emote[alt="Base"]')).toHaveCount(1);
  const overlay = chat.locator('img.chat-emote-overlay[alt="Overlay"]');
  await expect(overlay).toHaveCount(1);
  await expect.poll(() => wide.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(192);
  await expect.poll(() => overlay.evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(64);

  const wrapperGeometry = await overlay.evaluate((image) => {
    const wrapper = image.closest<HTMLElement>(".chat-emote-wrapper")!;
    const wrapperRect = wrapper.getBoundingClientRect();
    const overlayRect = image.getBoundingClientRect();
    return {
      wrapper: { x: wrapperRect.x, y: wrapperRect.y, width: wrapperRect.width, height: wrapperRect.height },
      overlay: { x: overlayRect.x, y: overlayRect.y, width: overlayRect.width, height: overlayRect.height },
      objectPosition: getComputedStyle(image).objectPosition,
    };
  });
  expect(wrapperGeometry.overlay).toEqual(wrapperGeometry.wrapper);
  expect(wrapperGeometry.objectPosition).toBe("50% 50%");
  const backlogEmoteSize = await wide.evaluate((image) => {
    const rect = image.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(backlogEmoteSize.width).toBeCloseTo(81, 0);
  expect(backlogEmoteSize.height).toBe(27);

  const shots = path.resolve(".tmp/shots");
  await mkdir(shots, { recursive: true });
  await page.locator("body").screenshot({ path: path.join(shots, "bare-word-wide-emote.png") });

  const tickerOverlayGeometry = await overlay.evaluate((image) => {
    const chat = image.closest<HTMLElement>("#chat")!;
    const row = image.closest<HTMLElement>(".chat-line")!;
    chat.dataset.layout = "ticker";
    chat.dataset.motion = "none";
    row.classList.add("ticker-line");
    const wrapper = image.closest<HTMLElement>(".chat-emote-wrapper")!;
    const wrapperRect = wrapper.getBoundingClientRect();
    const overlayRect = image.getBoundingClientRect();
    return {
      wrapper: { x: wrapperRect.x, y: wrapperRect.y, width: wrapperRect.width, height: wrapperRect.height },
      overlay: { x: overlayRect.x, y: overlayRect.y, width: overlayRect.width, height: overlayRect.height },
    };
  });
  expect(tickerOverlayGeometry.overlay).toEqual(tickerOverlayGeometry.wrapper);
});

test("keeps a 192x64 emote at 81x27 in stack and ticker, including a 150px stack frame", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 200 });
  await page.route("https://static-cdn.jtvnw.net/**", async (route) => {
    const body = route.request().url().includes("/100/") ? ultraWideSvg : wideSvg;
    await route.fulfill({ status: 200, contentType: "image/svg+xml", body });
  });
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const join = /^JOIN #([a-z0-9_]+)$/u.exec(String(message).trim());
      if (!join) return;
      const channel = join[1]!;
      socket.send(`@room-id=10 :tmi.twitch.tv ROOMSTATE #${channel}`);
      socket.send(`@id=wide;room-id=10;emotes=99:0-3/100:5-9 :viewer!viewer@host PRIVMSG #${channel} :Wide Ultra`);
      socket.send(`@id=gigantified;room-id=10;msg-id=power-up-message;msg-param-power-up-type=gigantify_an_emote;emotes=99:0-3 :viewer!viewer@host PRIVMSG #${channel} :Wide`);
    });
  });

  await page.goto("/overlay#channel=room&client=browser");
  const image = page.locator('img.chat-emote[alt="Wide"]');
  await expect(image).toHaveCount(2);
  await expect.poll(() => image.first().evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(192);
  const stackSize = await image.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height };
  });
  expect(stackSize.width).toBeCloseTo(81, 0);
  expect(stackSize.height).toBe(27);
  const ultra = page.locator('img.chat-emote[alt="Ultra"]');
  await expect(ultra).toHaveCount(1);
  await expect.poll(() => ultra.evaluate((element) => (element as HTMLImageElement).naturalWidth)).toBe(768);
  const gigantified = page.locator(".chat-gigantified img.chat-emote");
  await expect(gigantified).toHaveAttribute("height", "45");
  await expect.poll(() => gigantified.evaluate((element) => element.getBoundingClientRect().height)).toBe(45);

  await page.setViewportSize({ width: 150, height: 200 });
  const standardNarrowBounds = await image.first().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, frameWidth: innerWidth };
  });
  expect(standardNarrowBounds.left).toBeGreaterThanOrEqual(0);
  expect(standardNarrowBounds.right).toBeLessThanOrEqual(standardNarrowBounds.frameWidth);
  const narrowBounds = await ultra.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    return { left: rect.left, right: rect.right, width: rect.width, frameWidth: innerWidth };
  });
  expect(narrowBounds.left).toBeGreaterThanOrEqual(0);
  expect(narrowBounds.right).toBeLessThanOrEqual(narrowBounds.frameWidth);
  expect(narrowBounds.width).toBeLessThan(324);

  await page.setViewportSize({ width: 400, height: 200 });
  const tickerSize = await image.first().evaluate((element) => {
    const chat = element.closest<HTMLElement>("#chat")!;
    const row = element.closest<HTMLElement>(".chat-line")!;
    chat.dataset.layout = "ticker";
    chat.dataset.motion = "none";
    row.classList.add("ticker-line");
    const rect = element.getBoundingClientRect();
    return { width: rect.width, height: rect.height, maxWidth: getComputedStyle(element).maxWidth };
  });
  expect(tickerSize.width).toBeCloseTo(81, 0);
  expect(tickerSize.height).toBe(27);
  expect(tickerSize.maxWidth).toBe("none");
});
