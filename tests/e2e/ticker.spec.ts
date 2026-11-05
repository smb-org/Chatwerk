import { expect, test } from "@playwright/test";

test("ticker flood enters and moves through a 400 by 600 browser source", async ({ page }) => {
  await page.setViewportSize({ width: 400, height: 600 });
  const messages = Array.from({ length: 105 }, (_, index) =>
    `@id=ticker-${index};room-id=10;display-name=Viewer :viewer!viewer@host PRIVMSG #ticker :${index === 49 ? "x".repeat(10_000) : `message ${index}`}`);
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      if (String(message).startsWith("JOIN #ticker")) socket.send(messages.join("\r\n"));
    });
  });
  await page.goto("/");
  await page.evaluate(() => {
    const frame = document.createElement("iframe");
    frame.id = "ticker-preview";
    frame.setAttribute("sandbox", "allow-scripts");
    frame.width = "400";
    frame.height = "600";
    frame.style.border = "0";
    frame.style.position = "fixed";
    frame.style.inset = "0";
    frame.src = "/overlay#client=studio";
    document.body.appendChild(frame);
  });
  const frame = page.frameLocator("#ticker-preview");
  await expect(frame.locator("#chat")).toBeVisible();
  await expect(frame.locator(".chat-empty")).toHaveText("No channel set. Open Studio to add one.");
  await page.evaluate(() => {
    const preview = document.querySelector<HTMLIFrameElement>("#ticker-preview")!.contentWindow!;
    preview.postMessage({
      type: "chatwerk:studio-theme", theme: { layout: "ticker", tickerSpeed: 400 },
    }, "*");
    preview.postMessage({
      type: "chatwerk:studio-live", enabled: true, channel: "ticker",
    }, "*");
  });
  await expect(frame.locator(".chat-line")).toHaveCount(1);
  await expect(frame.locator(".chat-line")).toContainText("message 5");
  await expect.poll(() => frame.locator("#chat").evaluate((chat) => chat.ownerDocument.documentElement.scrollWidth)).toBe(400);
  const dimensions = await frame.locator(".chat-line").evaluate((line) => {
    const chat = line.parentElement!.getBoundingClientRect();
    const documentWidth = line.ownerDocument.documentElement.scrollWidth;
    const animation = line.getAnimations()[0];
    if (animation) animation.currentTime = 0;
    const startX = line.getBoundingClientRect().left;
    if (animation) animation.currentTime = 200;
    const progressedX = line.getBoundingClientRect().left;
    return {
      chatWidth: chat.width,
      documentWidth,
      layout: line.parentElement!.getAttribute("data-layout"),
      duration: Number.parseFloat(getComputedStyle(line).animationDuration),
      lineWidth: line.getBoundingClientRect().width,
      startX,
      progressedX,
      viewportWidth: line.ownerDocument.defaultView!.innerWidth,
    };
  });
  expect(dimensions.chatWidth).toBe(400);
  expect(dimensions.documentWidth).toBe(400);
  expect(dimensions.layout).toBe("ticker");
  expect(dimensions.viewportWidth).toBe(400);
  expect(dimensions.startX).toBeCloseTo(400, 0);
  expect(dimensions.progressedX).toBeLessThan(dimensions.startX);
  expect(dimensions.duration).toBeCloseTo((400 + dimensions.lineWidth) / 400, 1);

  await page.waitForTimeout(150);
  const before = await frame.locator(".chat-line").boundingBox();
  await page.waitForTimeout(250);
  const after = await frame.locator(".chat-line").boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after!.x).toBeLessThan(before!.x - 1);
});
