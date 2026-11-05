import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { randomBytes, randomUUID } from "node:crypto";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { mintSessionCookie } from "../worker/worker-test-helpers";
import { TEST_SESSION_KEY } from "./test-session";
import { seedStudioSession } from "./studio-session";

const port = Number(process.env.PLAYWRIGHT_PORT ?? 17474);
const localOrigin = `https://127.0.0.1:${port}`;

function seedLocalOverlay(ownerId: string, login: string, overlayId: string, token: string): void {
  const sql = `INSERT INTO users (id, login) VALUES ('${ownerId}', '${login}'); INSERT INTO overlays (id, owner_id, link_token, name, channel, link_generation) VALUES ('${overlayId}', '${ownerId}', '${token}', 'Main', '${login}', 1);`;
  const registry = path.resolve(".wrangler/registry");
  const localEnv = {
    ...process.env,
    WRANGLER_LOG_PATH: path.resolve(".wrangler/logs/e2e-seed.log"),
    WRANGLER_REGISTRY_PATH: registry,
    MINIFLARE_REGISTRY_PATH: registry,
  };
  execFileSync("pnpm", ["exec", "wrangler", "d1", "migrations", "apply", "chatwerk", "--local"], {
    cwd: process.cwd(), env: localEnv, stdio: "pipe",
  });
  execFileSync("pnpm", ["exec", "wrangler", "d1", "execute", "chatwerk", "--local", "--command", sql], {
    cwd: process.cwd(), env: localEnv, stdio: "pipe",
  });
}

test("sandbox overlay receives an owner config update and acknowledged test line over real local sockets", async ({ browser }) => {
  const ownerId = `99${randomBytes(8).toString("hex")}`;
  const login = `e2e_${randomBytes(4).toString("hex")}`;
  const overlayId = randomUUID();
  const token = randomBytes(32).toString("base64url");
  seedLocalOverlay(ownerId, login, overlayId, token);

  const contextA = await browser.newContext();
  const contextB = await browser.newContext();
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();
  const socketUrls: string[] = [];
  pageA.on("websocket", (socket) => socketUrls.push(socket.url()));
  pageA.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      if (String(message).includes(`JOIN #${login}`)) socket.send(`:tmi.twitch.tv ROOMSTATE #${login}`);
    });
  });
  await pageA.addInitScript(() => {
    const violations: string[] = [];
    Object.defineProperty(window, "__chatwerkCspViolations", { value: violations, configurable: true });
    document.addEventListener("securitypolicyviolation", (event) => {
      violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    });
  });
  await pageA.goto("/");
  const topUrl = pageA.url();
  await pageA.evaluate((src) => {
    const frame = document.createElement("iframe");
    frame.id = "chatwerk-widget";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.src = src;
    document.body.appendChild(frame);
  }, `/overlay#token=${token}&client=widget`);

  const frame = pageA.frameLocator("#chatwerk-widget");
  await expect(frame.locator("#chat")).toBeVisible();
  await expect.poll(() => socketUrls.some((url) => url.startsWith(`wss://${new URL(localOrigin).host}/api/overlay/live`)), { timeout: 5_000 }).toBe(true);
  await expect.poll(async () => frame.locator("#chat").evaluate((root) => getComputedStyle(root).getPropertyValue("--t-font-size").trim()), { timeout: 5_000 }).toBe("18px");
  await pageA.evaluate((linkToken) => {
    const studioSocket = new WebSocket(
      `${location.protocol === "https:" ? "wss:" : "ws:"}//${location.host}/api/overlay/live`,
      ["chatwerk-live", linkToken],
    );
    (window as Window & { __studioMessages?: Array<Record<string, unknown>>; __studioSocket?: WebSocket }).__studioMessages = [];
    (window as Window & { __studioMessages?: Array<Record<string, unknown>>; __studioSocket?: WebSocket }).__studioSocket = studioSocket;
    studioSocket.addEventListener("open", () => studioSocket.send(JSON.stringify({ type: "hello", schemaVersion: 1, client: "studio" })));
    studioSocket.addEventListener("message", (event) => {
      try {
        (window as Window & { __studioMessages?: Array<Record<string, unknown>> }).__studioMessages?.push(JSON.parse(String(event.data)) as Record<string, unknown>);
      } catch { /* Ignore unexpected protocol frames in this assertion harness. */ }
    });
  }, token);
  await expect.poll(() => pageA.evaluate(() =>
    (window as Window & { __studioSocket?: WebSocket }).__studioSocket?.readyState === WebSocket.OPEN), { timeout: 5_000 }).toBe(true);
  const overlayUrl = frame.locator("body");
  const iframeUrl = pageA.frames().find((candidate) => candidate.url().includes("/overlay"))?.url();

  const cookie = await mintSessionCookie(TEST_SESSION_KEY, ownerId);
  const cookieValue = cookie.slice("session=".length);
  await contextB.addCookies([{
    name: "session", value: cookieValue, url: localOrigin, httpOnly: true, secure: false, sameSite: "Lax",
  }]);
  await pageB.goto("/");
  const headers = { Origin: localOrigin, "Content-Type": "application/json" };
  const update = await pageB.request.put(`${localOrigin}/api/overlays/${overlayId}/config`, {
    headers,
    data: { baseRevision: 0, patch: { fontSize: 28 } },
  });
  expect(update.status()).toBe(200);
  await expect.poll(async () => frame.locator("#chat").evaluate((root) => getComputedStyle(root).getPropertyValue("--t-font-size").trim()), { timeout: 1_000 }).toBe("28px");
  expect(pageA.url()).toBe(topUrl);
  expect(pageA.frames().find((candidate) => candidate.url().includes("/overlay"))?.url()).toBe(iframeUrl);
  expect(await overlayUrl.evaluate((body) => body.ownerDocument.defaultView?.origin)).toBe("null");

  const testLine = await pageB.request.post(`${localOrigin}/api/overlays/${overlayId}/test-line`, { headers, data: {} });
  expect(testLine.status()).toBe(200);
  const { id } = await testLine.json() as { id: string };
  await expect(frame.locator(".chat-system")).toHaveText("Test line. Your chat appears here.");
  await expect.poll(() => pageA.evaluate((testId) =>
    (window as Window & { __studioMessages?: Array<Record<string, unknown>> }).__studioMessages?.some((message) =>
      message.type === "test-progress" && message.id === testId && Number(message.shown) >= 1 && Number(message.total) >= 1), id),
  { timeout: 5_000 }).toBe(true);
  expect(socketUrls.every((url) => !url.includes(token))).toBe(true);
  const log = await readFile(path.resolve(".wrangler/logs/wrangler.log"), "utf8").catch(() => "");
  expect(log).not.toContain(token);
  const violations = await frame.locator("body").evaluate((body) =>
    (body.ownerDocument.defaultView as Window & { __chatwerkCspViolations?: string[] }).__chatwerkCspViolations ?? []);
  expect(violations).toEqual([]);
  expect(id).toMatch(/^[0-9a-f-]{36}$/u);
  await pageA.evaluate(() => (window as Window & { __studioSocket?: WebSocket }).__studioSocket?.close());

  await contextA.close();
  await contextB.close();
});

test("a real Studio slider drag updates a second overlay page within one second without navigation", async ({ page }) => {
  const { token } = await seedStudioSession(page);
  await page.goto("/studio");
  const overlay = await page.context().newPage();
  overlay.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      if (String(message).includes("JOIN #")) socket.send(":tmi.twitch.tv ROOMSTATE #sample");
    });
  });
  await overlay.goto(`/overlay#token=${token}&client=obs`);
  await expect.poll(() => overlay.locator("#chat").evaluate((root) =>
    getComputedStyle(root).getPropertyValue("--t-font-size").trim()), { timeout: 5_000 }).toBe("18px");
  const studioUrl = page.url();
  const overlayUrl = overlay.url();
  const slider = page.locator("#theme-fontSize");
  const bounds = await slider.boundingBox();
  expect(bounds).not.toBeNull();
  const startX = bounds!.x + bounds!.width * 0.08;
  const endX = bounds!.x + bounds!.width * 0.5;
  const centerY = bounds!.y + bounds!.height / 2;
  await page.mouse.move(startX, centerY);
  await page.mouse.down();
  await page.mouse.move(endX, centerY, { steps: 8 });
  await page.mouse.up();
  await expect.poll(() => overlay.locator("#chat").evaluate((root) =>
    getComputedStyle(root).getPropertyValue("--t-font-size").trim()), { timeout: 1_000 }).toBe("43px");
  expect(page.url()).toBe(studioUrl);
  expect(overlay.url()).toBe(overlayUrl);
  await overlay.close();
});

test("only the tokenless Studio preview accepts parent messages", async ({ page }) => {
  const { token } = await seedStudioSession(page);
  const ircConnections: string[] = [];
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    ircConnections.push(socket.url());
  });
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");

  await page.evaluate((linkToken) => {
    for (const client of ["widget", "studio"]) {
      const frame = document.createElement("iframe");
      frame.id = `hostile-${client}`;
      frame.setAttribute("sandbox", "allow-scripts");
      frame.src = `/overlay#token=${linkToken}&client=${client}`;
      document.body.appendChild(frame);
    }
  }, token);

  const widget = page.frameLocator("#hostile-widget").locator("#chat");
  const tokenedStudio = page.frameLocator("#hostile-studio").locator("#chat");
  await expect(widget).toBeVisible();
  await expect(tokenedStudio).toBeVisible();
  await expect.poll(() => widget.evaluate((root) => getComputedStyle(root).getPropertyValue("--t-font-size").trim()))
    .toBe("18px");
  await expect.poll(() => tokenedStudio.evaluate((root) => getComputedStyle(root).getPropertyValue("--t-font-size").trim()))
    .toBe("18px");
  await expect.poll(() => ircConnections.length).toBe(2);
  const expectedIrcConnections = ircConnections.length;

  const preview = page.frameLocator("#studio-preview").locator("#chat");
  await page.evaluate(() => {
    document.querySelector<HTMLIFrameElement>("#studio-preview")?.contentWindow?.postMessage({
      type: "chatwerk:studio-theme", theme: { fontSize: 34 },
    }, "*");
  });
  await expect.poll(() => preview.evaluate((root) => getComputedStyle(root).getPropertyValue("--t-font-size").trim()))
    .toBe("34px");

  await page.evaluate(() => {
    const hostileMessages = [
      { type: "chatwerk:studio-theme", theme: { fontSize: 58 } },
      { type: "chatwerk:studio-scenario", scenario: "flood" },
      { type: "chatwerk:studio-live", enabled: true, channel: "hostile_channel" },
    ];
    for (const frameId of ["hostile-widget", "hostile-studio"]) {
      const child = document.getElementById(frameId) as HTMLIFrameElement | null;
      for (const message of hostileMessages) child?.contentWindow?.postMessage(message, "*");
    }
  });

  await expect.poll(() => widget.evaluate((root) => getComputedStyle(root).getPropertyValue("--t-font-size").trim()))
    .toBe("18px");
  await expect.poll(() => tokenedStudio.evaluate((root) => getComputedStyle(root).getPropertyValue("--t-font-size").trim()))
    .toBe("18px");
  expect(ircConnections).toHaveLength(expectedIrcConnections);
});
