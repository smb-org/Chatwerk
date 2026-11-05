import { expect, test } from "@playwright/test";

test("ticker flood and a very long message stay clipped to a 1920 by 1080 viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
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
    frame.width = "1920";
    frame.height = "1080";
    frame.style.border = "0";
    frame.style.position = "fixed";
    frame.style.inset = "0";
    frame.src = "/overlay#client=studio";
    document.body.appendChild(frame);
  });
  const frame = page.frameLocator("#ticker-preview");
  await expect(frame.locator("#chat")).toBeVisible();
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
  await expect.poll(() => frame.locator("#chat").evaluate((chat) => chat.ownerDocument.documentElement.scrollWidth)).toBe(1920);
  const dimensions = await frame.locator(".chat-line").evaluate((line) => {
    const chat = line.parentElement!.getBoundingClientRect();
    const documentWidth = line.ownerDocument.documentElement.scrollWidth;
    return { chatWidth: chat.width, documentWidth, layout: line.parentElement!.getAttribute("data-layout") };
  });
  expect(dimensions).toEqual({ chatWidth: 1920, documentWidth: 1920, layout: "ticker" });

  await page.waitForTimeout(150);
  const before = await frame.locator(".chat-line").boundingBox();
  await page.waitForTimeout(250);
  const after = await frame.locator(".chat-line").boundingBox();
  expect(before).not.toBeNull();
  expect(after).not.toBeNull();
  expect(after!.x).toBeLessThan(before!.x - 1);
});
