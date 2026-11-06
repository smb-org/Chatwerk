import { mkdir } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { seedStudioSession, setRange, setThemeChecked } from "./studio-session";

const corsHeaders = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
};
const badgeSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="18" height="18"><circle cx="9" cy="9" r="8" fill="#f0a"/></svg>';

test("Studio Live preview loads backlog and all badge sources from its opaque origin", async ({ page }) => {
  test.setTimeout(30_000);
  const identity = await seedStudioSession(page);
  const requestOrigins: Array<string | undefined> = [];
  let backlogCalls = 0;
  let releaseBacklog!: () => void;
  const backlogGate = new Promise<void>((resolve) => { releaseBacklog = resolve; });
  let sendLiveRaid: (() => void) | undefined;

  await page.route("https://recent-messages.robotty.de/**", async (route) => {
    backlogCalls += 1;
    requestOrigins.push(route.request().headers().origin);
    await backlogGate;
    const now = Date.now();
    const history = Array.from({ length: 2 }, (_, index) => {
      const sentAt = now - (4_000 - index * 1_000);
      return `@id=history-${index};tmi-sent-ts=${sentAt};historical=1;user-id=${100 + index};display-name=Viewer${index} :viewer!viewer@host PRIVMSG #${identity.login} :History line ${index}`;
    });
    history.push(`@id=history-raid;tmi-sent-ts=${now - 2_000};historical=1;room-id=10;user-id=7;display-name=Raider;msg-id=raid;msg-param-viewerCount=20 :raider!raider@host USERNOTICE #${identity.login} :History raid`);
    history.push(`@id=history-badge;tmi-sent-ts=${now - 500};historical=1;room-id=10;user-id=42;display-name=BadgeViewer :viewer!viewer@host PRIVMSG #${identity.login} :Badge history`);
    await route.fulfill({
      status: 200,
      headers: { ...corsHeaders, "content-type": "application/json" },
      body: JSON.stringify({ messages: history, error: null, error_code: null }),
    });
  });

  await page.route("https://api.betterttv.net/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/badges/twitch")) {
      requestOrigins.push(route.request().headers().origin);
      await route.fulfill({
        status: 200, headers: { ...corsHeaders, "content-type": "application/json" },
        body: JSON.stringify([{ id: "bttv", providerId: "42", name: "BTTV Supporter", displayName: "BTTV Supporter", badge: { svg: "https://cdn.betterttv.net/badges/bttv.svg" } }]),
      });
      return;
    }
    await route.fulfill({ status: 200, headers: { ...corsHeaders, "content-type": "application/json" }, body: "{}" });
  });
  await page.route("https://api.frankerfacez.com/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/badges/ids")) {
      requestOrigins.push(route.request().headers().origin);
      await route.fulfill({
        status: 200, headers: { ...corsHeaders, "content-type": "application/json" },
        body: JSON.stringify({ badges: [{ id: 7, name: "FFZ Supporter", urls: { "2": "https://cdn.frankerfacez.com/badge/7/2" } }], users: { "7": [42] } }),
      });
      return;
    }
    await route.fulfill({ status: 200, headers: { ...corsHeaders, "content-type": "application/json" }, body: JSON.stringify({ sets: {} }) });
  });
  await page.route("https://api.chatterino.com/badges", async (route) => {
    requestOrigins.push(route.request().headers().origin);
    await route.fulfill({
      status: 200, headers: { ...corsHeaders, "content-type": "application/json" },
      body: JSON.stringify({ badges: [{ tooltip: "Chatterino Supporter", users: ["42"], image3: "https://fourtf.com/chatterino/badges/supporter.png" }] }),
    });
  });
  await page.route("https://7tv.io/**", async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.endsWith("/gql")) {
      if (route.request().method() === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders });
        return;
      }
      requestOrigins.push(route.request().headers().origin);
      const requestBody = JSON.parse(route.request().postData() ?? "{}") as { query?: string; variables?: Record<string, unknown> };
      const query = requestBody.query ?? "";
      if (query.includes("userByConnection")) {
        const data: Record<string, unknown> = {};
        for (const match of query.matchAll(/(u\d+): userByConnection\(platform: TWITCH, id: \$id(\d+)\)/gu)) {
          const alias = match[1]!;
          const userIndex = Number(match[2]);
          const userId = requestBody.variables?.[`id${userIndex}`];
          data[alias] = { id: String(userId ?? ""), style: userId === "42" ? { badge_id: "fixture-badge" } : {} };
        }
        await route.fulfill({ status: 200, headers: { ...corsHeaders, "content-type": "application/json" }, body: JSON.stringify({ data }) });
        return;
      }
      await route.fulfill({
        status: 200, headers: { ...corsHeaders, "content-type": "application/json" },
        body: JSON.stringify({ data: { cosmetics: { badges: [{ id: "fixture-badge", name: "7TV Supporter", host: { url: "//cdn.7tv.app/badge/fixture-badge" } }] } } }),
      });
      return;
    }
    await route.fulfill({
      status: 200, headers: { ...corsHeaders, "content-type": "application/json" },
      body: JSON.stringify({ user: { id: "7tv-channel" }, emote_set: { id: "fixture-set", emotes: [] } }),
    });
  });
  for (const host of ["cdn.betterttv.net", "cdn.frankerfacez.com", "fourtf.com", "cdn.7tv.app"]) {
    await page.route(`https://${host}/**`, (route) => route.fulfill({
      status: 200, contentType: "image/svg+xml", body: badgeSvg,
    }));
  }
  await page.routeWebSocket("wss://events.7tv.io/v3", (socket) => {
    socket.onMessage(() => undefined);
    socket.send(JSON.stringify({ op: 1, d: { heartbeat_interval: 30_000, session_id: "badge-e2e" } }));
  });
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const join = /^JOIN #([a-z0-9_]+)$/u.exec(String(message).trim());
      if (!join) return;
      const channel = join[1]!;
      socket.send(`@room-id=10 :tmi.twitch.tv ROOMSTATE #${channel}`);
      sendLiveRaid = () => {
        socket.send(`@id=history-raid;room-id=10;user-id=7;msg-id=raid;msg-param-viewerCount=20 :raider!raider@host USERNOTICE #${channel} :Live raid copy`);
        socket.send(`@id=live-activity;room-id=10;user-id=42;display-name=BadgeViewer :viewer!viewer@host PRIVMSG #${channel} :Live activity`);
      };
    });
  });

  const consoleErrors: string[] = [];
  page.on("console", (message) => { if (message.type() === "error") consoleErrors.push(message.text()); });
  page.on("pageerror", (error) => consoleErrors.push(error.name));

  await page.setViewportSize({ width: 1_440, height: 900 });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await expect.poll(() => backlogCalls).toBe(0);
  for (const field of ["emotes7tv", "emotesBttv", "emotesFfz", "showPaints"]) await setThemeChecked(page, field, false);
  await setThemeChecked(page, "panelEnabled");
  await setRange(page, "panelBorderWidth", 4);
  await setRange(page, "panelPadding", 12);
  await setRange(page, "linePadding", 4);
  await setRange(page, "backgroundOpacity", 0);
  await setRange(page, "maxLines", 20);
  await setRange(page, "maxChatHeight", 200);
  await page.locator("#preview-mode-live").click();

  const preview = page.frameLocator("#studio-preview");
  await expect.poll(() => backlogCalls).toBe(1);
  await expect.poll(() => sendLiveRaid).toBeTruthy();
  const chat = preview.locator("#chat");
  const beforeBacklog = await chat.boundingBox();
  expect(beforeBacklog).not.toBeNull();
  releaseBacklog();
  await expect(preview.locator(".chat-line").filter({ hasText: "Badge history" })).toHaveCount(1, { timeout: 8_000 });
  await expect(preview.locator(".chat-line").filter({ hasText: "History raid" })).toHaveCount(1);
  await expect(preview.locator(".reaction-burst")).toHaveCount(0);
  await expect.poll(() => chat.boundingBox()).toEqual(beforeBacklog);
  expect(backlogCalls).toBe(1);

  await sendLiveRaid?.();
  await expect(preview.locator(".reaction-burst")).toHaveCount(1, { timeout: 5_000 });
  await expect(preview.locator(".chat-line").filter({ hasText: "History raid" })).toHaveCount(1);
  for (const source of ["7tv", "badgesBttv", "badgesFfz", "badgesChatterino"]) {
    await expect(preview.locator(`img.chat-badge[data-badge-source="${source}"]`)).toHaveCount(2, { timeout: 8_000 });
  }
  const badgeLine = preview.locator(".chat-line").filter({ hasText: "Badge history" });
  await expect(badgeLine.locator("img.chat-badge")).toHaveCount(4);
  for (const image of await badgeLine.locator("img.chat-badge").all()) {
    await expect(image).toHaveAttribute("alt", /Supporter/u);
    await expect(image).toHaveAttribute("title", /Supporter/u);
    expect(await image.evaluate((node) => (node as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  }
  expect(requestOrigins.length).toBeGreaterThanOrEqual(4);
  expect(requestOrigins.every((origin) => origin === "null")).toBe(true);
  expect(consoleErrors.filter((message) => /Content Security Policy|CSP|blocked by/i.test(message))).toEqual([]);

  const geometry = await chat.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    const lines = [...element.querySelectorAll<HTMLElement>(".chat-line")].map((line) => {
      const rect = line.getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom };
    });
    const border = Number.parseFloat(style.borderTopWidth);
    const padding = Number.parseFloat(style.paddingTop);
    const layer = element.ownerDocument.querySelector(".reaction-layer")!.getBoundingClientRect();
    return {
      box: { top: box.top, bottom: box.bottom, height: box.height, width: box.width },
      innerTop: box.top + border + padding,
      innerBottom: box.bottom - border - padding,
      lines,
      frame: { width: innerWidth, height: innerHeight },
      layer: { top: layer.top, bottom: layer.bottom, width: layer.width, height: layer.height },
      border: style.borderTopWidth,
      padding: style.paddingTop,
    };
  });
  expect(geometry.frame).toEqual({ width: 400, height: 200 });
  expect(geometry.box).toEqual({ top: 0, bottom: 200, height: 200, width: 400 });
  expect(geometry.border).toBe("4px");
  expect(geometry.padding).toBe("12px");
  expect(geometry.lines.length).toBeGreaterThan(0);
  expect(geometry.lines.every((line) => line.top >= geometry.innerTop - 0.5 && line.bottom <= geometry.innerBottom + 0.5)).toBe(true);
  expect(geometry.layer).toEqual({ top: 0, bottom: 200, width: 400, height: 200 });

  const configSave = page.waitForResponse((response) =>
    response.request().method() === "PUT" && new URL(response.url()).pathname.endsWith("/config"));
  await setRange(page, "maxLines", 19);
  await configSave;
  await page.waitForTimeout(250);
  expect(backlogCalls).toBe(1);

  const shots = path.resolve(".tmp/shots");
  await mkdir(shots, { recursive: true });
  await preview.locator("body").screenshot({ path: path.join(shots, "overlay-panel-backlog-400x200.png") });
  await badgeLine.screenshot({ path: path.join(shots, "third-party-badges-line.png") });
});

test("showBadges and backlog off send no provider or history requests from an opaque frame", async ({ page }) => {
  const requests = new Map<string, number>();
  const count = (key: string) => requests.set(key, (requests.get(key) ?? 0) + 1);
  let joined = false;
  await page.route("https://recent-messages.robotty.de/**", async (route) => {
    count("backlog");
    await route.fulfill({ status: 200, headers: { ...corsHeaders, "content-type": "application/json" }, body: JSON.stringify({ messages: [] }) });
  });
  await page.route("https://api.betterttv.net/3/cached/badges/twitch", async (route) => {
    count("bttv");
    await route.fulfill({ status: 200, headers: { ...corsHeaders, "content-type": "application/json" }, body: "[]" });
  });
  await page.route("https://api.frankerfacez.com/v1/badges/ids", async (route) => {
    count("ffz");
    await route.fulfill({ status: 200, headers: { ...corsHeaders, "content-type": "application/json" }, body: "{}" });
  });
  await page.route("https://api.chatterino.com/badges", async (route) => {
    count("chatterino");
    await route.fulfill({ status: 200, headers: { ...corsHeaders, "content-type": "application/json" }, body: "{}" });
  });
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const join = /^JOIN #([a-z0-9_]+)$/u.exec(String(message).trim());
      if (join) {
        joined = true;
        socket.send(`@room-id=10 :tmi.twitch.tv ROOMSTATE #${join[1]}`);
      }
    });
  });
  await page.goto("/");
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "opaque-chat";
    frame.width = "400";
    frame.height = "600";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = "/overlay#client=studio";
    document.body.appendChild(frame);
  });
  const frame = page.frameLocator("#opaque-chat");
  await expect(frame.locator("#chat")).toBeVisible();
  await expect(frame.locator("#chat")).toHaveAttribute("data-placement", "viewport");
  await page.evaluate(() => {
    const preview = document.querySelector<HTMLIFrameElement>("#opaque-chat")!.contentWindow!;
    preview.postMessage({
      type: "chatwerk:studio-theme",
      theme: { backlog: false, showBadges: false, showPaints: false, emotes7tv: false, emotesBttv: false, emotesFfz: false },
    }, "*");
    preview.postMessage({ type: "chatwerk:studio-live", enabled: true, channel: "switches" }, "*");
  });
  await expect.poll(() => joined).toBe(true);
  await expect(frame.locator(".chat-empty")).toHaveCount(0);
  await page.waitForTimeout(250);
  expect([...requests.values()].reduce((sum, value) => sum + value, 0)).toBe(0);
});
