import { expect, test } from "@playwright/test";

const expectTwitchConnectPolicy = (headers: Record<string, string>) => {
  const policies = headers["content-security-policy"]?.split(",").map((policy) => policy.trim()) ?? [];
  expect(policies.length).toBeGreaterThan(0);
  for (const policy of policies) {
    expect(policy).toMatch(/connect-src[^;]*wss:\/\/irc-ws\.chat\.twitch\.tv/u);
  }
};

const tryUnroutedTwitchSocket = async (context: import("@playwright/test").Page) => context.evaluate(async () => {
  const violations: string[] = [];
  const listen = (event: SecurityPolicyViolationEvent) => {
    violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
  };
  document.addEventListener("securitypolicyviolation", listen);
  const socket = new WebSocket("wss://irc-ws.chat.twitch.tv");
  await new Promise<void>((resolve) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => resolve(), { once: true });
    setTimeout(resolve, 500);
  });
  socket.close();
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.removeEventListener("securitypolicyviolation", listen);
  return violations;
});

const probeProviderConnections = async () => {
  const violations: string[] = [];
  const listen = (event: SecurityPolicyViolationEvent) => {
    violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
  };
  document.addEventListener("securitypolicyviolation", listen);
  const requests = [
    "https://7tv.io/v3/emote-sets/global",
    "https://api.betterttv.net/3/cached/emotes/global",
    "https://api.frankerfacez.com/v1/set/global",
    "https://pronouns.alejo.io/api/pronouns",
  ].map((url) => fetch(url, { mode: "no-cors" }).catch(() => undefined));
  const socket = new WebSocket("wss://events.7tv.io/v3");
  await new Promise<void>((resolve) => {
    socket.addEventListener("open", () => resolve(), { once: true });
    socket.addEventListener("error", () => resolve(), { once: true });
    setTimeout(resolve, 700);
  });
  socket.close();
  await Promise.race([Promise.all(requests), new Promise((resolve) => setTimeout(resolve, 700))]);
  await new Promise((resolve) => setTimeout(resolve, 100));
  document.removeEventListener("securitypolicyviolation", listen);
  return violations;
};

const messageWithHtml = "@id=e2e-1;display-name=Viewer :viewer!viewer@host PRIVMSG #test :<img src=x onerror=alert(1)>";

test("overlay policies permit unrouted Twitch sockets in regular and sandboxed pages", async ({ page }) => {
  const response = await page.goto("/overlay#channel=Foo%20Bar");
  expect(response).not.toBeNull();
  expectTwitchConnectPolicy(response!.headers());
  expect(await tryUnroutedTwitchSocket(page)).toEqual([]);

  await page.goto("/");
  const frameResponse = page.waitForResponse((candidate) =>
    new URL(candidate.url()).pathname === "/overlay" && candidate.request().resourceType() === "document");
  await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.id = "csp-probe";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.src = "/overlay#channel=Foo%20Bar";
    document.body.appendChild(iframe);
  });
  expectTwitchConnectPolicy((await frameResponse).headers());
  const frame = page.frameLocator("#csp-probe");
  await expect(frame.locator("#chat")).toBeVisible();
  expect(await frame.locator("body").evaluate(async (body) => {
    const violations: string[] = [];
    const listen = (event: SecurityPolicyViolationEvent) => {
      violations.push(`${event.effectiveDirective}: ${event.blockedURI}`);
    };
    body.ownerDocument.addEventListener("securitypolicyviolation", listen);
    const socket = new WebSocket("wss://irc-ws.chat.twitch.tv");
    await new Promise<void>((resolve) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => resolve(), { once: true });
      setTimeout(resolve, 500);
    });
    socket.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    body.ownerDocument.removeEventListener("securitypolicyviolation", listen);
    return violations;
  })).toEqual([]);
});

test("overlay CSP permits unrouted emote and pronoun provider fetches in both documents", async ({ page }) => {
  await page.goto("/overlay#channel=Foo%20Bar");
  expect(await page.evaluate(probeProviderConnections)).toEqual([]);

  await page.goto("/");
  await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.id = "provider-csp-probe";
    iframe.name = "provider-csp-probe";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.src = "/overlay#channel=Foo%20Bar";
    document.body.appendChild(iframe);
  });
  await expect(page.frameLocator("#provider-csp-probe").locator("#chat")).toBeVisible();
  const frame = page.frame({ name: "provider-csp-probe" });
  expect(frame).not.toBeNull();
  expect(await frame!.evaluate(probeProviderConnections)).toEqual([]);
});

test("invalid encoded channels show the no-channel system line", async ({ page }) => {
  await page.goto("/overlay");
  await expect(page.locator(".chat-empty")).toHaveText("No channel set. Open Studio to add one.");
  await page.goto("/overlay#channel=Foo%20Bar");
  await expect(page.locator(".chat-empty")).toHaveText("No channel set. Open Studio to add one.");
});

test("renders IRC text as text in regular and opaque sandboxed origins", async ({ page }) => {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      if (String(message).startsWith("JOIN #test")) socket.send(messageWithHtml);
    });
  });

  await page.goto("/overlay#channel=test&client=browser");
  const chat = page.locator("#chat");
  await expect(chat).toContainText("<img src=x onerror=alert(1)>");
  await expect(chat.locator("img")).toHaveCount(0);

  await page.goto("/");
  await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.id = "widget";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.src = "/overlay#channel=test&client=browser";
    document.body.appendChild(iframe);
    window.addEventListener("message", (event) => {
      if (event.data === "chatwerk-origin-probe") document.documentElement.dataset.frameOrigin = event.origin;
    });
  });
  const frame = page.frameLocator("#widget");
  await expect(frame.locator("#chat")).toContainText("<img src=x onerror=alert(1)>");
  await frame.locator("body").evaluate(() => parent.postMessage("chatwerk-origin-probe", "*"));
  await expect.poll(() => page.locator("html").getAttribute("data-frame-origin")).toBe("null");
  expect(await frame.locator("body").evaluate(() => {
    try { return { blocked: false, value: localStorage.getItem("chatwerk-theme") }; }
    catch (error) { return { blocked: true, name: (error as Error).name }; }
  })).toEqual({ blocked: true, name: "SecurityError" });
  await expect(frame.locator("#chat img")).toHaveCount(0);
  expect(consoleErrors).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test("keeps one spacing gap between the name and message when optional items are empty", async ({ page }) => {
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      if (String(message).startsWith("JOIN #spacing")) {
        socket.send("@id=spacing;display-name=Viewer :viewer!viewer@host PRIVMSG #spacing :hello");
      }
    });
  });
  await page.goto("/overlay#channel=spacing&client=browser");
  const line = page.locator(".chat-line");
  await expect(line).toHaveCount(1);
  const geometry = await line.evaluate((row) => {
    const name = row.querySelector(".chat-name")!.getBoundingClientRect();
    const message = row.querySelector(".chat-message")!.getBoundingClientRect();
    return {
      gap: message.left - name.right,
      spacing: Number.parseFloat(getComputedStyle(row).gap),
      hiddenOptionalCount: [...row.querySelectorAll(".chat-badges, .chat-pronouns, .chat-source-room")]
        .filter((element) => getComputedStyle(element).display === "none").length,
    };
  });
  expect(geometry.gap).toBeCloseTo(geometry.spacing, 1);
  expect(geometry.hiddenOptionalCount).toBe(3);
});

test("keeps chat rows inside the viewport and anchors the newest row for each line order", async ({ page }) => {
  await page.setViewportSize({ width: 1920, height: 1080 });
  const messages = Array.from({ length: 100 }, (_, index) => {
    const text = index === 49 ? "x".repeat(10_000) : `message ${index}`;
    return `@id=layout-${index};display-name=Viewer :viewer!viewer@host PRIVMSG #test :${text}`;
  });
  const shortMessages = [
    "@id=short-0;display-name=Viewer :viewer!viewer@host PRIVMSG #small :short 0",
    "@id=short-1;display-name=Viewer :viewer!viewer@host PRIVMSG #small :short 1",
  ];
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const line = String(message);
      if (line.startsWith("JOIN #test")) socket.send(messages.join("\r\n"));
      if (line.startsWith("JOIN #small")) socket.send(shortMessages.join("\r\n"));
    });
  });

  await page.goto("/overlay#channel=test&client=browser");
  await expect(page.locator(".chat-line")).toHaveCount(100);
  const defaultLayout = await page.locator(".chat-line").last().evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const chat = document.querySelector("#chat")!.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      rowHeight: bounds.height,
      spacing: Number.parseFloat(getComputedStyle(row).marginBlockEnd),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      htmlHeight: document.documentElement.getBoundingClientRect().height,
      bodyHeight: document.body.getBoundingClientRect().height,
      chatHeight: chat.height,
    };
  });
  expect(defaultLayout.bottom).toBeLessThanOrEqual(defaultLayout.viewportHeight);
  expect(defaultLayout.viewportHeight - defaultLayout.bottom)
    .toBeLessThanOrEqual(defaultLayout.rowHeight + defaultLayout.spacing);
  expect(defaultLayout.documentHeight).toBeLessThanOrEqual(defaultLayout.viewportHeight);
  expect(defaultLayout.documentWidth).toBeLessThanOrEqual(defaultLayout.viewportWidth);
  expect(defaultLayout.htmlHeight).toBe(defaultLayout.viewportHeight);
  expect(defaultLayout.bodyHeight).toBe(defaultLayout.viewportHeight);
  expect(defaultLayout.chatHeight).toBe(defaultLayout.viewportHeight);

  const longMessage = await page.locator(".chat-line").nth(49).locator(".chat-message").evaluate((message) => ({
    height: message.getBoundingClientRect().height,
    scrollWidth: message.scrollWidth,
    clientWidth: message.clientWidth,
  }));
  expect(longMessage.height).toBeGreaterThan(20);
  expect(longMessage.scrollWidth).toBeLessThanOrEqual(longMessage.clientWidth);

  await page.goto("/overlay#channel=small&client=browser");
  await page.reload();
  await expect(page.locator(".chat-line")).toHaveCount(2);
  const shortRows = await page.locator(".chat-line").evaluateAll((rows) => rows.map((row) => ({
    top: row.getBoundingClientRect().top,
    bottom: row.getBoundingClientRect().bottom,
    width: row.getBoundingClientRect().width,
    height: row.getBoundingClientRect().height,
    spacing: Number.parseFloat(getComputedStyle(row).marginBlockEnd),
  })));
  expect(shortRows[0]!.top).toBeGreaterThan(540);
  expect(shortRows[0]!.width).toBeLessThan(1920);
  expect(1080 - shortRows.at(-1)!.bottom)
    .toBeLessThanOrEqual(shortRows.at(-1)!.height + shortRows.at(-1)!.spacing);

  const reverseToken = "R".repeat(43);
  await page.evaluate((token) => localStorage.setItem(`chatwerk-theme:${token}`, JSON.stringify({
    revision: 0,
    config: { schemaVersion: 1, lineOrder: "message-first" },
    channel: "test",
  })), reverseToken);
  await page.goto(`/overlay?reverse=1#token=${reverseToken}&client=browser`);
  await page.reload();
  await expect(page.locator(".chat-line")).toHaveCount(100);
  const reversedRows = await page.locator(".chat-line").evaluateAll((rows) => rows.map((row) => ({
    text: row.querySelector(".chat-message")?.textContent,
    top: row.getBoundingClientRect().top,
    bottom: row.getBoundingClientRect().bottom,
    height: row.getBoundingClientRect().height,
    spacing: Number.parseFloat(getComputedStyle(row).marginBlockEnd),
  })));
  const newestReversed = reversedRows.at(-1)!;
  expect(newestReversed.text).toBe("message 99");
  expect(newestReversed.top).toBeGreaterThanOrEqual(0);
  expect(newestReversed.top).toBeLessThanOrEqual(newestReversed.height + newestReversed.spacing);
  expect(reversedRows[0]!.top).toBeGreaterThanOrEqual(1080);

  await page.goto("/");
  await page.evaluate(() => {
    const iframe = document.createElement("iframe");
    iframe.id = "sized-overlay";
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.src = "/overlay#channel=test&client=browser";
    iframe.style.cssText = "display:block;width:800px;height:600px;border:0";
    document.body.appendChild(iframe);
  });
  const frame = page.frameLocator("#sized-overlay");
  await expect(frame.locator(".chat-line")).toHaveCount(100);
  const frameLayout = await frame.locator(".chat-line").last().evaluate((row) => {
    const bounds = row.getBoundingClientRect();
    const chat = document.querySelector("#chat")!.getBoundingClientRect();
    return {
      bottom: bounds.bottom,
      rowHeight: bounds.height,
      spacing: Number.parseFloat(getComputedStyle(row).marginBlockEnd),
      viewportHeight: window.innerHeight,
      viewportWidth: window.innerWidth,
      documentHeight: document.documentElement.scrollHeight,
      documentWidth: document.documentElement.scrollWidth,
      htmlHeight: document.documentElement.getBoundingClientRect().height,
      bodyHeight: document.body.getBoundingClientRect().height,
      chatHeight: chat.height,
    };
  });
  expect(frameLayout.viewportWidth).toBe(800);
  expect(frameLayout.viewportHeight).toBe(600);
  expect(frameLayout.bottom).toBeLessThanOrEqual(frameLayout.viewportHeight);
  expect(frameLayout.viewportHeight - frameLayout.bottom)
    .toBeLessThanOrEqual(frameLayout.rowHeight + frameLayout.spacing);
  expect(frameLayout.documentHeight).toBeLessThanOrEqual(frameLayout.viewportHeight);
  expect(frameLayout.documentWidth).toBeLessThanOrEqual(frameLayout.viewportWidth);
  expect(frameLayout.htmlHeight).toBe(frameLayout.viewportHeight);
  expect(frameLayout.bodyHeight).toBe(frameLayout.viewportHeight);
  expect(frameLayout.chatHeight).toBe(frameLayout.viewportHeight);
});
