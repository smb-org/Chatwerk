import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { DEFAULTS } from "../../src/shared/theme";
import { seedStudioSession, setRange } from "./studio-session";

const makeShotsDirectory = (): void => { mkdirSync(".tmp/shots", { recursive: true }); };

test("raid, sub, and bits rehearse bounded reactions at 1920x1080 and 400x600", async ({ page }) => {
  test.setTimeout(90_000);
  makeShotsDirectory();
  await seedStudioSession(page);
  await page.setViewportSize({ width: 1920, height: 1080 });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await setRange(page, "reactionIntensity", 0.8);

  const preview = page.frameLocator("#studio-preview");
  const chat = preview.locator("#chat");
  await expect.poll(() => chat.evaluate((root) => root.style.getPropertyValue("--t-reaction-intensity")))
    .toBe("0.8");
  const cases = [
    { scenario: "raid", effect: "raid", shot: "raid-reaction-400x600.png" },
    { scenario: "sub", effect: "sub", shot: "sub-reaction-400x600.png" },
    { scenario: "bits", effect: "bits", shot: "rain-reaction-400x600.png" },
  ] as const;

  for (const size of ["1920x1080", "400x600", "300x900"] as const) {
    await page.locator("#preview-size-preset").selectOption(size);
    const [width, height] = size.split("x").map(Number);
    await expect.poll(() => chat.evaluate((root) => [root.ownerDocument.defaultView!.innerWidth, root.ownerDocument.defaultView!.innerHeight]))
      .toEqual([width, height]);
    for (const scenario of cases) {
      await page.locator(`#rehearse-${scenario.scenario}`).click();
      const burst = preview.locator(`.reaction-burst[data-effect="${scenario.effect}"]`);
      await expect(burst).toHaveCount(1);
      await expect(burst).toHaveAttribute("data-event-type", scenario.scenario);
      await expect(preview.locator(".reaction-rain")).toHaveCount(5);
      await expect(chat.locator(".chat-reaction-highlight")).toHaveCount(1);
      await expect(chat.locator(".chat-reaction-highlight")).toHaveCSS("background-color", "rgb(255, 230, 128)");
      await expect(chat.locator(".chat-reaction-highlight .chat-name").first()).toHaveCSS("color", "rgb(23, 24, 27)");
      const rainSources = await preview.locator(".reaction-rain").evaluateAll((items) =>
        items.map((item) => item.getAttribute("src")));
      expect(rainSources).toHaveLength(5);
      expect(rainSources.every((source) => source?.startsWith("/effects/rain-") && source.endsWith(".svg"))).toBe(true);
      await page.waitForTimeout(650);
      const rainVisible = await preview.locator(".reaction-rain").evaluateAll((items) => {
        const frame = items[0]!.ownerDocument.querySelector("#chat")!.getBoundingClientRect();
        return items.some((item) => {
          const bounds = item.getBoundingClientRect();
          return bounds.bottom > frame.top && bounds.top < frame.bottom &&
            bounds.right > frame.left && bounds.left < frame.right && Number(getComputedStyle(item).opacity) > 0;
        });
      });
      expect(rainVisible).toBe(true);
      const geometry = await burst.evaluate((element) => {
        const root = element.ownerDocument.querySelector("#chat")!;
        const layer = element.parentElement!;
        const frame = root.getBoundingClientRect();
        const bounds = layer.getBoundingClientRect();
        return {
          frame: [frame.left, frame.top, frame.width, frame.height],
          layer: [bounds.left, bounds.top, bounds.width, bounds.height],
          overflow: getComputedStyle(layer).overflow,
        };
      });
      expect(geometry.layer).toEqual(geometry.frame);
      expect(geometry.overflow).toBe("hidden");

      if (size === "400x600") {
        await page.locator("#preview-one-to-one").click();
        await expect(page.locator("#preview-one-to-one")).toHaveAttribute("aria-pressed", "true");
        await expect.poll(() => page.locator("#studio-preview").evaluate((frame) => {
          const rect = frame.getBoundingClientRect();
          return [rect.width, rect.height];
        })).toEqual([400, 600]);
        await page.waitForTimeout(450);
        await chat.screenshot({ path: `.tmp/shots/${scenario.shot}` });
        await page.locator("#preview-fit").click();
      }
      const highlightedLine = await chat.locator(".chat-reaction-highlight").first().elementHandle();
      expect(highlightedLine).not.toBeNull();
      const activeStyle = await highlightedLine!.evaluate((line) => ({
        background: getComputedStyle(line).backgroundColor,
        name: getComputedStyle(line.querySelector(".chat-name")!).color,
      }));
      await expect(burst).toHaveCount(0, { timeout: 5_000 });
      await expect(chat.locator(".chat-reaction-highlight")).toHaveCount(0);
      await expect(chat.locator(".reaction-burst, .reaction-rain, .reaction-effect, .chat-reaction-highlight")).toHaveCount(0);
      const returnedStyle = await highlightedLine!.evaluate((line) => ({
        background: getComputedStyle(line).backgroundColor,
        name: getComputedStyle(line.querySelector(".chat-name")!).color,
      }));
      expect(returnedStyle.background).not.toBe(activeStyle.background);
      expect(returnedStyle.name).not.toBe(activeStyle.name);
    }
  }

  await page.locator("#preview-size-preset").selectOption("400x600");
  await page.locator("#preview-one-to-one").click();
  await expect.poll(() => page.locator("#studio-preview").evaluate((frame) => {
    const rect = frame.getBoundingClientRect();
    return [rect.width, rect.height];
  })).toEqual([400, 600]);
  const visualChecks = [
    { intensity: 0.35, background: "dark", shot: "reaction-35-dark.png" },
    { intensity: 0.35, background: "light", shot: "reaction-35-light.png" },
    { intensity: 0.8, background: "dark", shot: "reaction-80-dark.png" },
    { intensity: 0.8, background: "light", shot: "reaction-80-light.png" },
  ] as const;
  for (const look of visualChecks) {
    await setRange(page, "reactionIntensity", look.intensity);
    await page.locator(`input[name="preview-background"][value="${look.background}"]`).check();
    await page.locator("#rehearse-raid").click();
    const burst = preview.locator('.reaction-burst[data-effect="raid"]');
    await expect(burst).toHaveCount(1);
    await expect.poll(() => chat.evaluate((root) => root.style.getPropertyValue("--t-reaction-intensity")))
      .toBe(String(look.intensity));
    await page.waitForTimeout(1_150);
    await chat.screenshot({ path: `.tmp/shots/${look.shot}` });
    await expect(burst).toHaveCount(0, { timeout: 5_000 });
  }
  await page.locator('.settings-group[data-group="Reactions"]').scrollIntoViewIfNeeded();
  await page.screenshot({ path: ".tmp/shots/reactions-studio.png" });
});

test("Live disables all rehearsal buttons while public previews remain sample-only", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await page.locator("#preview-mode-live").click();
  for (const scenario of ["quiet", "flood", "raid", "sub", "bits", "hype-train"]) {
    await expect(page.locator(`#rehearse-${scenario}`)).toBeDisabled();
  }
  await page.locator("#preview-mode-sample").click();
  for (const scenario of ["quiet", "flood", "raid", "sub", "bits", "hype-train"]) {
    await expect(page.locator(`#rehearse-${scenario}`)).toBeEnabled();
  }

  const look = {
    id: "11111111-1111-4111-8111-111111111111",
    slug: "sample",
    name: "Sample",
    author: "Alice",
    values: DEFAULTS,
    parent: null,
    withdrawn: false,
  };
  await page.route("**/api/looks/sample", (route) => route.fulfill({ json: look }));
  await page.goto("/themes");
  await expect(page.locator("#look-preview")).toHaveAttribute("src", "/overlay#client=studio");
  await expect(page.locator("#preview-mode-live, #live-chat")).toHaveCount(0);
  await page.goto("/t/sample");
  await expect(page.locator("#look-preview")).toHaveAttribute("src", "/overlay#client=studio");
  await expect(page.locator("#preview-mode-live, #live-chat")).toHaveCount(0);
});

test("Studio footer fits at desktop widths with all rehearsal and share actions visible", async ({ page }) => {
  test.setTimeout(30_000);
  await seedStudioSession(page);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  for (const size of [{ width: 1024, height: 768 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    const footer = page.locator(".rehearse-footer");
    await expect(footer).toBeVisible();
    await expect(page.locator("#test-in-obs")).toBeInViewport();
    await expect(page.locator("#share-look")).toBeInViewport();
    for (const scenario of ["quiet", "flood", "raid", "sub", "bits", "hype-train"]) {
      await expect(page.locator(`#rehearse-${scenario}`)).toBeInViewport();
    }
    const geometry = await page.evaluate(() => {
      const footerElement = document.querySelector<HTMLElement>(".rehearse-footer")!;
      const scenarioGroup = document.querySelector<HTMLElement>(".scenario-buttons")!;
      const actions = document.querySelector<HTMLElement>(".footer-actions")!;
      const scenarioButtons = [...document.querySelectorAll<HTMLButtonElement>(".scenario-button")];
      const box = (element: Element) => {
        const rect = element.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, height: rect.height };
      };
      return {
        footer: box(footerElement),
        scenarios: box(scenarioGroup),
        actions: box(actions),
        buttons: scenarioButtons.map(box),
        textFits: scenarioButtons.every((button) => button.scrollHeight <= button.clientHeight),
      };
    });
    expect(geometry.scenarios.right).toBeLessThanOrEqual(geometry.actions.left);
    expect(geometry.scenarios.top).toBeGreaterThanOrEqual(geometry.footer.top);
    expect(geometry.scenarios.bottom).toBeLessThanOrEqual(geometry.footer.bottom);
    expect(geometry.buttons.every((button) => button.height >= 36)).toBe(true);
    expect(geometry.buttons.every((button) => button.top === geometry.buttons[0]!.top)).toBe(true);
    expect(geometry.textFits).toBe(true);
    await page.screenshot({ path: `.tmp/shots/studio-footer-${size.width}x${size.height}.png` });
  }
});

test("motion none keeps a static line highlight and creates no animation or rain", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  const preview = page.frameLocator("#studio-preview");
  await page.locator('input[name="theme-motion"][value="none"]').check();
  await expect(preview.locator('#chat[data-motion="none"]')).toHaveCount(1);
  await page.locator("#rehearse-raid").click();

  await expect(preview.locator(".chat-reaction-highlight")).toHaveCount(1);
  await expect(preview.locator(".chat-reaction-highlight")).toHaveCSS("background-color", "rgb(255, 230, 128)");
  await expect(preview.locator(".reaction-layer *")).toHaveCount(0);
  await expect(preview.locator(".chat-reaction-highlight")).toHaveCount(0, { timeout: 5_000 });
});

test("ticker reactions leave the ticker queue and active line intact", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  const preview = page.frameLocator("#studio-preview");
  const chat = preview.locator("#chat");
  await page.locator('input[name="theme-layout"][value="ticker"]').check();
  await expect(chat).toHaveAttribute("data-layout", "ticker");
  await page.locator("#rehearse-bits").click();
  await expect(preview.locator('.reaction-burst[data-event-type="bits"]')).toHaveCount(1);
  await expect(chat.locator(".chat-line")).toHaveCount(1);
  await expect(chat.locator(".chat-line")).toContainText("Cheer250");
  await expect(chat.locator(".chat-reaction-highlight")).toHaveCount(1);
  await expect(chat.locator(".chat-line")).toHaveCount(1);
  await expect(chat.locator(".chat-line")).toContainText("Cheer250");
});

test("200 gift subs stay below the reaction element cap", async ({ page }) => {
  await seedStudioSession(page);
  let giftsSent = 0;
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (!command.startsWith("JOIN #")) return;
      const channel = command.slice("JOIN #".length);
      socket.send(`@room-id=10 :tmi.twitch.tv ROOMSTATE #${channel}`);
      for (let index = 0; index < 200; index += 1) {
        socket.send(`@id=gift-${index};room-id=10;msg-id=subgift;msg-param-months=1;display-name=gifter;login=gifter;user-id=9 :tmi.twitch.tv USERNOTICE #${channel} :Gift subscription`);
        giftsSent += 1;
      }
    });
  });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await page.locator("#preview-mode-live").click();
  const preview = page.frameLocator("#studio-preview");
  await expect.poll(() => giftsSent).toBe(200);
  await expect(preview.locator(".reaction-burst")).toHaveCount(1);
  await expect.poll(() => preview.locator(".reaction-layer").evaluate((layer) => layer.querySelectorAll("*").length))
    .toBeLessThanOrEqual(24);
  await expect.poll(() => preview.locator(".chat-line").count()).toBeLessThanOrEqual(100);
});

test("an old schema-v1 config loads with its saved values and reaction defaults", async ({ page }) => {
  const { login } = await seedStudioSession(page);
  await page.route("**/api/overlay/config", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    await route.fulfill({ json: {
      revision: 2,
      channel: login,
      config: { schemaVersion: 1, fontSize: 20, textColor: "#abcdef", layout: "ticker", tickerSpeed: 88 },
    } });
  });
  await page.goto("/studio");
  await expect(page.locator("#theme-fontSize")).toHaveValue("20");
  await expect(page.locator('input[name="theme-layout"][value="ticker"]')).toBeChecked();
  await expect(page.locator("#theme-reactionRaid")).toBeChecked();
  await expect(page.locator("#theme-reactionSoundEnabled")).not.toBeChecked();
  const preview = page.frameLocator("#studio-preview");
  await expect.poll(() => preview.locator("#chat").evaluate((root) => root.style.getPropertyValue("--t-font-size")))
    .toBe("20px");
  await expect.poll(() => preview.locator("#chat").evaluate((root) => root.style.getPropertyValue("--t-reaction-intensity")))
    .toBe("0.35");
});

test("a Studio reaction control reaches a second overlay through the live socket", async ({ page }) => {
  const { token } = await seedStudioSession(page);
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (command.startsWith("JOIN #")) socket.send(`:tmi.twitch.tv ROOMSTATE ${command.slice(5)}`);
    });
  });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  const overlay = await page.context().newPage();
  await overlay.goto(`/overlay#token=${token}&client=browser`);
  await expect.poll(() => overlay.locator("#chat").evaluate((root) => root.style.getPropertyValue("--t-reaction-intensity")))
    .toBe("0.35");

  await setRange(page, "reactionIntensity", 0.8);
  await expect.poll(() => overlay.locator("#chat").evaluate((root) => root.style.getPropertyValue("--t-reaction-intensity")), {
    timeout: 8_000,
  }).toBe("0.8");
  await overlay.close();
});

test("hostile IRC display names remain text in the live overlay", async ({ page }) => {
  await seedStudioSession(page);
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      const command = String(message).trim();
      if (!command.startsWith("JOIN #")) return;
      const channel = command.slice("JOIN #".length);
      socket.send(`:tmi.twitch.tv ROOMSTATE #${channel}`);
      socket.send(`@id=hostile;room-id=10;bits=100;display-name=<img\\ssrc=x\\sonerror=alert(1)>;login=viewer PRIVMSG #${channel} :Cheer100`);
    });
  });
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await page.locator("#preview-mode-live").click();
  const preview = page.frameLocator("#studio-preview");
  const name = preview.locator(".chat-name").filter({ hasText: "<img src=x onerror=alert(1)>" });
  await expect(name).toHaveCount(1);
  await expect(name).toContainText("<img src=x onerror=alert(1)>");
  await expect(name.locator("img, svg, [onerror], [onload]")).toHaveCount(0);
});
