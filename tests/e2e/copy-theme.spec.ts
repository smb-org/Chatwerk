import { mkdir } from "node:fs/promises";
import { expect, test } from "@playwright/test";
import { DEFAULTS } from "../../src/shared/theme";
import { addStudioLook, addStudioSharedOverlay, clearStudioLooks, e2eOrigin, expectActiveOverlay, seedStudioLooks, seedStudioSession, setRange } from "./studio-session";

test.beforeEach(() => clearStudioLooks());

async function screenshot(page: import("@playwright/test").Page, name: string): Promise<void> {
  await mkdir(".tmp/shots", { recursive: true });
  await page.screenshot({ path: `.tmp/shots/${name}.png`, fullPage: true });
}

async function setConfig(
  page: import("@playwright/test").Page,
  overlayId: string,
  baseRevision: number,
  patch: Record<string, unknown>,
): Promise<void> {
  const response = await page.request.put(`${e2eOrigin}/api/overlays/${overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision, patch },
  });
  expect(response.status()).toBe(200);
}

async function getConfig(page: import("@playwright/test").Page, token: string) {
  const response = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.ok()).toBe(true);
  return await response.json() as { revision: number; channel: string; themeFrom: string | null; config: Record<string, unknown> };
}

test("shows a logged-out public look and links to the matching Twitch login destination", async ({ page }) => {
  const owner = await seedStudioSession(page);
  const look = addStudioLook(owner.ownerId, "Night Ledger", { ...DEFAULTS, fontSize: 31 });
  await page.context().clearCookies();
  await page.goto(`/t/${look.slug}`);

  await expect(page.locator("#look-name")).toHaveText("Night Ledger");
  await expect(page.locator("#public-login")).toBeVisible();
  await expect(page.locator("#public-login")).toHaveAttribute("href", `/auth/login?next=${encodeURIComponent(`/t/${look.slug}`)}`);
  await screenshot(page, "public-look-logged-out");
});

test("labels a shared overlay with its owner before copying a public look", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const shared = addStudioSharedOverlay(identity.ownerId, "Main");
  const look = addStudioLook(identity.ownerId, "Shared Destination", DEFAULTS);
  await page.goto(`/t/${look.slug}`);

  const selector = page.locator("#active-overlay-select");
  await expect(selector.locator("option")).toHaveText(["Main", `Main by ${shared.ownerLogin}`]);
  await selector.selectOption(shared.overlayId);
  await expect(selector.locator("option:checked")).toHaveText(`Main by ${shared.ownerLogin}`);
  const copyRequestPromise = page.waitForRequest((request) => request.method() === "POST" && request.url().includes(`/api/looks/${look.slug}/copy`));
  await page.getByRole("button", { name: "Use on Main overlay" }).click();
  const copyRequest = await copyRequestPromise;
  expect(JSON.parse(copyRequest.postData() ?? "{}")).toMatchObject({ overlayId: shared.overlayId });

  await expect(page).toHaveURL(`${e2eOrigin}/studio`);
  await expect(page.locator("#active-overlay-select option:checked")).toHaveText(`Main by ${shared.ownerLogin}`);
});

test("publishes from the Studio dialog, copies its public link, and reports a duplicate name", async ({ page }) => {
  const identity = await seedStudioSession(page);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await page.locator("#share-look").click();
  const dialog = page.getByRole("dialog", { name: "Share this look" });
  await expect(dialog).toBeVisible();
  await screenshot(page, "publish-dialog");

  await page.locator("#publish-name").fill("Night Circuit");
  await page.locator("#publish-submit").click();
  await expect(page.locator("#publish-status")).toHaveText("Published. Link copied.");
  const link = await page.locator("#publish-open").getAttribute("href");
  expect(link).toMatch(new RegExp(`^${e2eOrigin.replaceAll(".", "\\.")}\\/t\\/night-circuit-[a-f0-9-]+$`, "u"));
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(link);

  await page.locator("#publish-name").fill("Night Circuit");
  await page.locator("#publish-submit").click();
  await expect(page.locator("#publish-status")).toHaveText("You already published a look with this name.");
  const ownerLooks = await page.request.get(`${e2eOrigin}/api/looks/mine`);
  expect((await ownerLooks.json() as { looks: { ownerId?: string }[] }).looks).toHaveLength(1);
  expect(identity.overlayId).toMatch(/[0-9a-f-]{36}/u);
});

test("creates, renames, selects, and deletes overlays in the account dialog", async ({ page }) => {
  const identity = await seedStudioSession(page);
  await page.goto("/studio");
  await page.locator("#account-menu summary").click();
  await page.getByRole("button", { name: "Overlays" }).click();
  let dialog = page.getByRole("dialog", { name: "Overlays" });
  await screenshot(page, "overlays-dialog");
  await dialog.locator("#new-overlay-name").fill("Vertical");
  await dialog.getByRole("button", { name: "Create overlay" }).click();
  await expect(dialog).toBeHidden();
  await expectActiveOverlay(page, "Vertical");

  if (!await page.getByRole("button", { name: "Overlays" }).isVisible()) {
    await page.locator("#account-menu summary").click();
  }
  await page.getByRole("button", { name: "Overlays" }).click();
  dialog = page.getByRole("dialog", { name: "Overlays" });
  const vertical = dialog.locator(".manage-row").filter({ hasText: "Vertical" });
  await vertical.getByRole("button", { name: "Rename" }).click();
  await dialog.locator(".manage-row .dialog-input").fill("Portrait");
  await dialog.locator(".manage-row.manage-form").getByRole("button", { name: "Rename" }).click();
  await expect(dialog).toContainText("Overlay renamed.");
  await expect(dialog.locator(".manage-row").filter({ hasText: "Portrait" })).toBeVisible();

  const target = await page.request.get(`${e2eOrigin}/api/overlays`);
  const overlays = (await target.json() as { overlays: { id: string; name: string; linkToken: string }[] }).overlays;
  const portrait = overlays.find((item) => item.name === "Portrait")!;
  await page.evaluate(async (token) => {
    const socket = new WebSocket(`wss://${location.host}/api/overlay/live`, ["chatwerk-live", token]);
    socket.addEventListener("close", (event) => {
      (window as Window & { deletedSocketCloseCode?: number }).deletedSocketCloseCode = event.code;
    });
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener("open", () => resolve(), { once: true });
      socket.addEventListener("error", () => reject(new Error("socket did not open")), { once: true });
    });
  }, portrait.linkToken);
  const deleted = await dialog.locator(".manage-row").filter({ hasText: "Portrait" })
    .getByRole("button", { name: "Delete Portrait" }).click();
  void deleted;
  await expect(dialog).toBeHidden();
  await expectActiveOverlay(page, "Main");
  const cleared = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${portrait.linkToken}` },
  });
  expect(cleared.status()).toBe(404);
  await expect.poll(() => page.evaluate(() => (window as Window & { deletedSocketCloseCode?: number }).deletedSocketCloseCode)).toBe(4001);
  expect(identity.overlayId).toBeTruthy();
});

test("shows published looks in a keyboard-operable listbox with one sandboxed preview", async ({ page }) => {
  const identity = await seedStudioSession(page);
  addStudioLook(identity.ownerId, "First Theme", DEFAULTS);
  addStudioLook(identity.ownerId, "Second Theme", { ...DEFAULTS, fontSize: 27 });
  await page.goto("/themes");

  const list = page.getByRole("listbox", { name: "Themes" });
  await expect(list.getByRole("option")).toHaveCount(2);
  await expect(page.locator("#look-preview")).toHaveCount(1);
  await expect(page.locator("#look-preview")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(page.frameLocator("#look-preview").locator("#chat > *")).toHaveCount(3, { timeout: 1000 });
  await screenshot(page, "themes-data");
  await list.focus();
  await expect(list).toBeFocused();
  const selectedBefore = await list.locator('[aria-selected="true"]').getAttribute("data-look-id");
  await list.press("ArrowDown");
  await expect.poll(() => list.locator('[aria-selected="true"]').getAttribute("data-look-id")).not.toBe(selectedBefore);
  await expect(page.getByRole("button", { name: "Use on Main overlay" })).toBeVisible();
});

test("previews shareable ticker and power-up values without joining IRC or expanding the page", async ({ page }) => {
  const owner = await seedStudioSession(page);
  const look = addStudioLook(owner.ownerId, "Ticker Power", {
    ...DEFAULTS,
    layout: "ticker",
    tickerSpeed: 160,
    gigantifiedScale: 3,
    showPronouns: true,
    channels: ["private_one", "private_two", "private_three"],
    hideNumbers: true,
    filterWords: ["spoiler"],
    filterPrefixes: ["!private"],
    hideBots: true,
    botNames: ["privatebot"],
    sharedChatLabel: "avatar-pill",
    sharedChatPrefix: "from",
  });
  const sockets: string[] = [];
  page.on("websocket", (socket) => sockets.push(socket.url()));
  await page.addInitScript(() => {
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data === "object" && event.data !== null) {
        const payload = event.data as { type?: unknown; theme?: unknown };
        if (payload.type === "chatwerk:studio-theme") Object.assign(window, { galleryPreviewTheme: payload.theme });
      }
    });
  });

  await page.goto("/themes");
  const frame = page.frameLocator("#look-preview");
  await expect(frame.locator("#chat")).toHaveAttribute("data-layout", "ticker");
  const tickerLine = frame.locator("#chat .chat-line").first();
  await expect(tickerLine).toHaveClass(/ticker-line/u);
  await expect(tickerLine).toHaveCSS("position", "absolute");
  await expect(frame.locator("#chat .chat-line")).toHaveCount(1);
  const tickerOffset = await tickerLine.evaluate((line) => {
    const chat = line.parentElement!.getBoundingClientRect();
    return line.getBoundingClientRect().top - chat.top;
  });
  expect(tickerOffset).toBeLessThan(4);
  await expect(page.locator('[data-value="layout"]')).toHaveText("Ticker");
  await expect(page.locator('[data-value="tickerSpeed"]')).toHaveText("160 px/s");
  await expect(page.locator('[data-value="gigantifiedScale"]')).toHaveText("3 em");
  await expect(page.locator('[data-value="showPronouns"]')).toHaveText("On");
  for (const key of ["channels", "hideNumbers", "filterWords", "filterPrefixes", "hideBots", "showSharedChat", "botNames"]) {
    await expect(page.locator(`[data-value="${key}"]`)).toHaveCount(0);
  }
  const previewFrame = page.frames().find((item) => item.url().includes("/overlay#client=studio"));
  const previewTheme = await previewFrame?.evaluate(() =>
    (window as Window & { galleryPreviewTheme?: Record<string, unknown> }).galleryPreviewTheme);
  expect(previewTheme).toBeTruthy();
  for (const key of ["channels", "hideNumbers", "filterWords", "filterPrefixes", "hideBots", "showSharedChat", "botNames"]) {
    expect(previewTheme).not.toHaveProperty(key);
  }
  expect(previewTheme).toMatchObject({ sharedChatLabel: "avatar-pill", sharedChatPrefix: "from" });
  const pageWidth = await page.evaluate(() => ({ width: document.documentElement.clientWidth, scrollWidth: document.documentElement.scrollWidth }));
  expect(pageWidth.scrollWidth).toBe(pageWidth.width);
  await page.locator('[data-value="layout"]').scrollIntoViewIfNeeded();
  await screenshot(page, "themes-ticker-preview");

  await page.goto(`/t/${look.slug}`);
  await expect(page.frameLocator("#look-preview").locator("#chat")).toHaveAttribute("data-layout", "ticker");
  expect(sockets.filter((url) => /irc-ws\.chat\.twitch\.tv|\/api\/overlay\/live/iu.test(url))).toEqual([]);
});

test("shows the specified empty gallery state and its publish action", async ({ page }) => {
  await seedStudioSession(page);
  await page.goto("/themes");
  await expect(page.locator("#gallery-message")).toContainText("Nobody has published a look yet. Yours could be first.");
  await expect(page.getByRole("link", { name: "Publish my look" })).toHaveAttribute("href", "/studio?publish=1");
  await screenshot(page, "themes-empty");
});

test("copies a public look to a second account and updates an already connected overlay socket", async ({ page }) => {
  const owner = await seedStudioSession(page);
  const look = addStudioLook(owner.ownerId, "Bright Stage", {
    ...DEFAULTS,
    fontSize: 32,
    channels: ["source_one", "source_two", "source_three"],
    filterWords: ["source-spoiler"],
    filterPrefixes: ["!source"],
    hideBots: true,
    botNames: ["sourcebot"],
  });
  await page.context().clearCookies();
  await page.goto(`/t/${look.slug}`);
  await expect(page.locator("#public-login")).toHaveAttribute("href", `/auth/login?next=${encodeURIComponent(`/t/${look.slug}`)}`);

  const target = await seedStudioSession(page);
  await setConfig(page, target.overlayId, 0, {
    channels: ["target_one", "target_two", "target_three"],
    filterWords: ["target-spoiler"],
    filterPrefixes: ["!target"],
    hideNumbers: true,
    hideBots: true,
    botNames: ["targetbot"],
  });
  const liveOverlay = await page.context().newPage();
  const ircFrames: string[] = [];
  await page.context().routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((frame) => ircFrames.push(String(frame)));
  });
  await liveOverlay.goto(`/overlay#token=${target.token}&client=browser`);
  await expect(liveOverlay.locator("#chat")).toBeVisible();
  await expect.poll(() => ircFrames.some((frame) => frame.includes("JOIN #target_one")), { timeout: 10_000 }).toBe(true);
  await page.goto(`/t/${look.slug}`);
  await expect(page.getByRole("button", { name: "Use on Main overlay" })).toBeVisible();
  const beforeCopy = ircFrames.length;
  await page.getByRole("button", { name: "Use on Main overlay" }).click();
  await expect(page).toHaveURL(/\/studio$/u);
  await expect(page.locator("#undo-look")).toBeVisible();
  await expect.poll(() => liveOverlay.locator("#chat").evaluate((element) =>
    getComputedStyle(element).getPropertyValue("--t-font-size").trim())).toBe("32px");
  await expect(liveOverlay.locator("#chat")).toBeVisible();
  const copied = await getConfig(page, target.token);
  expect(copied.config).toMatchObject({
    channels: ["target_one", "target_two", "target_three"],
    filterWords: ["target-spoiler"],
    filterPrefixes: ["!target"],
    hideNumbers: true,
    hideBots: true,
    botNames: ["targetbot"],
  });
  expect(ircFrames.slice(beforeCopy).some((frame) => frame.includes("PART #target_one"))).toBe(false);
  expect(ircFrames.slice(beforeCopy).some((frame) => frame.includes("JOIN #source_one"))).toBe(false);
});

test("undo restores the saved theme, custom CSS enabled state, and previous lineage", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const look = addStudioLook(identity.ownerId, "Sunset", { ...DEFAULTS, fontSize: 34 });
  const privateConfig = {
    channels: ["undo_one", "undo_two", "undo_three"],
    filterWords: ["undo-spoiler"],
    filterPrefixes: ["!undo"],
    hideNumbers: true,
    hideBots: true,
    botNames: ["undobot"],
  };
  await setConfig(page, identity.overlayId, 0, {
    fontSize: 22,
    ...privateConfig,
    customCss: ".chat { color: red; }",
    customCssEnabled: true,
  });
  await page.goto(`/t/${look.slug}`);
  await page.getByRole("button", { name: "Use on Main overlay" }).click();
  await expect(page).toHaveURL(/\/studio$/u);
  const copied = await getConfig(page, identity.token);
  expect(copied.config).toMatchObject({
    fontSize: 34,
    ...privateConfig,
    customCss: ".chat { color: red; }",
    customCssEnabled: false,
  });
  expect(copied.themeFrom).toBe(look.id);

  await page.locator("#undo-look").click();
  await expect(page.locator("#undo-look")).toBeHidden();
  await expect(page.locator("#status-visible")).toHaveText("Previous look restored.");
  const restored = await getConfig(page, identity.token);
  expect(restored.config).toMatchObject({
    fontSize: 22,
    ...privateConfig,
    customCss: ".chat { color: red; }",
    customCssEnabled: true,
  });
  expect(restored.themeFrom).toBeNull();
  await page.locator("#channel-field-button").click();
  expect(await page.locator("[data-channel-value]").evaluateAll((inputs) =>
    inputs.map((input) => (input as HTMLInputElement).value))).toEqual(privateConfig.channels);
  await expect(page.locator('textarea[data-list-field="filterWords"]')).toHaveValue("undo-spoiler");
  await expect(page.locator('textarea[data-list-field="filterPrefixes"]')).toHaveValue("!undo");
});

test("ends the undo offer after an edit and refuses a stale undo revision", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const look = addStudioLook(identity.ownerId, "Studio Green", { ...DEFAULTS, fontSize: 33 });
  await page.goto(`/t/${look.slug}`);
  const copyResponse = await page.request.post(`${e2eOrigin}/api/looks/${look.slug}/copy`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { overlayId: identity.overlayId },
  });
  expect(copyResponse.status()).toBe(200);
  const copyResult = await copyResponse.json() as { snapshotId: string; revision: number; undoExpiresAt: number };
  const destination = new URL("/studio", e2eOrigin);
  destination.searchParams.set("overlay", identity.overlayId);
  destination.searchParams.set("undo", copyResult.snapshotId);
  destination.searchParams.set("rev", String(copyResult.revision));
  destination.searchParams.set("until", String(copyResult.undoExpiresAt));
  destination.searchParams.set("look", look.slug);
  destination.searchParams.set("lookName", "Studio Green");
  await page.goto(destination.toString());
  await expect(page.locator("#undo-look")).toBeVisible();
  await setRange(page, "fontSize", 29);
  await expect(page.locator("#undo-look")).toBeHidden();
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2");

  const stale = await page.request.post(`${e2eOrigin}/api/overlays/${identity.overlayId}/undo`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { snapshotId: copyResult!.snapshotId, expectedRevision: copyResult!.revision },
  });
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "revision-conflict" });
  expect((await getConfig(page, identity.token)).config.fontSize).toBe(29);
});

test("a stale undo leaves a newer copy snapshot available", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const look = addStudioLook(identity.ownerId, "Two Copies", { ...DEFAULTS, fontSize: 30 });
  const copy = async () => {
    const response = await page.request.post(`${e2eOrigin}/api/looks/${look.slug}/copy`, {
      headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
      data: { overlayId: identity.overlayId },
    });
    expect(response.status()).toBe(200);
    return await response.json() as { snapshotId: string; revision: number };
  };
  const first = await copy();
  const second = await copy();
  const undo = (snapshot: { snapshotId: string; revision: number }) => page.request.post(
    `${e2eOrigin}/api/overlays/${identity.overlayId}/undo`, {
      headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
      data: { snapshotId: snapshot.snapshotId, expectedRevision: snapshot.revision },
    },
  );
  const stale = await undo(first);
  expect(stale.status()).toBe(409);
  expect(await stale.json()).toMatchObject({ error: "revision-conflict" });
  expect((await undo(second)).status()).toBe(200);
});

test("renders removed looks as a safe 404 state and treats look names as text", async ({ page }) => {
  const identity = await seedStudioSession(page);
  const dangerous = addStudioLook(identity.ownerId, '<img src=x onerror="alert(1)">', DEFAULTS);
  await page.goto("/themes");
  await expect(page.locator(".look-option-name").first()).toHaveText('<img src=x onerror="alert(1)">');
  await expect(page.locator(".look-option img")).toHaveCount(0);

  await page.context().clearCookies();
  await page.goto("/t/not-a-real-look");
  await expect(page.locator("#public-look-state")).toContainText("This look is gone. The owner removed it.");
  await expect(page.getByRole("link", { name: "Browse themes" })).toHaveAttribute("href", "/themes");
  expect(dangerous.slug).toMatch(/^[a-z0-9-]+$/u);
});

test("routes the ten-look limit message to My looks", async ({ page }) => {
  const identity = await seedStudioSession(page);
  seedStudioLooks(identity.ownerId, 10, DEFAULTS);
  await page.goto("/studio");
  await page.locator("#first-run-done").click();
  await page.locator("#share-look").click();
  await expect(page.locator("#publish-limit")).toBeVisible();
  await expect(page.locator("#publish-limit")).toContainText("10 of 10 looks.");
  await page.locator("#publish-manage-looks").click();
  await expect(page.getByRole("dialog", { name: "My looks" })).toBeVisible();
  await expect(page.locator("#dialog-body .manage-row")).toHaveCount(10);
});

test("keeps the 100-look list internal at 1024px and leaves the main action in view", async ({ page }) => {
  const identity = await seedStudioSession(page);
  seedStudioLooks(identity.ownerId, 100, DEFAULTS);
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/themes");
  const list = page.locator("#look-list");
  await expect(list.getByRole("option")).toHaveCount(100);
  await expect(page.getByRole("button", { name: "Use on Main overlay" })).toBeInViewport();
  const dimensions = await page.evaluate(() => ({
    scrollHeight: document.documentElement.scrollHeight,
    innerHeight: window.innerHeight,
    listHeight: document.querySelector("#look-list")!.clientHeight,
    listScrollHeight: document.querySelector("#look-list")!.scrollHeight,
  }));
  expect(dimensions.scrollHeight).toBeLessThanOrEqual(dimensions.innerHeight);
  expect(dimensions.listScrollHeight).toBeGreaterThan(dimensions.listHeight);
  await screenshot(page, "themes-100-at-1024");
});

test("fits long German look names at mobile width and a 200-percent viewport", async ({ page }) => {
  const identity = await seedStudioSession(page);
  for (let index = 0; index < 16; index += 1) {
    const suffix = String(index + 1).padStart(2, "0");
    addStudioLook(identity.ownerId, `ÄußerstLangerDeutscherStilEntwurfNummer${suffix}`, DEFAULTS);
  }
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/themes");
  await expect(page.getByRole("button", { name: /Use on Main overlay/u })).toBeInViewport();
  await expect(page.locator("#look-list").getByRole("option")).toHaveCount(16);
  let size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportWidth: innerWidth, viewportHeight: innerHeight }));
  expect(size.width).toBeLessThanOrEqual(size.viewportWidth);
  expect(size.height).toBeLessThanOrEqual(size.viewportHeight);

  await page.setViewportSize({ width: 195, height: 422 });
  await expect(page.getByRole("button", { name: /Use on Main overlay/u })).toBeInViewport();
  size = await page.evaluate(() => ({ width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight, viewportWidth: innerWidth, viewportHeight: innerHeight }));
  expect(size.width).toBeLessThanOrEqual(size.viewportWidth);
  expect(size.height).toBeLessThanOrEqual(size.viewportHeight);
});

test("sets up widget blocks and runs the sandboxed overlay against the local API and socket", async ({ page }) => {
  const identity = await seedStudioSession(page, { channel: "" });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/studio/export?platform=streamelements");
  await expect(page.locator("#code-html-streamelements")).toContainText("chatwerkFrame");
  await expect(page.locator("#code-js-streamelements")).toContainText("indexOf('https://') !== 0");
  await expect(page.locator("#code-fields-streamelements")).toContainText(`${e2eOrigin}/overlay#token=${identity.token}&client=widget&placement=origin`);
  await expect(page.locator("#setup-panel-streamelements")).toContainText("The CSS tab stays empty.");
  await expect(page.locator("#setup-no-channel-streamelements")).toBeVisible();
  await screenshot(page, "setup-streamelements");
  await page.locator("#setup-tab-soundalerts").click();
  await expect(page.locator("#soundalerts-note")).toHaveText("Not measured yet. Test it once.");
  await expect(page.locator("#setup-panel-soundalerts .export-note-permanent")).toHaveText("Without Cloudflare a widget keeps running, but cannot reload.");
  await screenshot(page, "setup-soundalerts");

  for (const block of ["html", "js", "fields"] as const) {
    const pre = page.locator(`#setup-panel-soundalerts [data-block-content="${block}"]`);
    const expected = await pre.textContent() ?? "";
    await page.locator(`#setup-panel-soundalerts [data-copy-block="${block}"]`).click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expected);
  }

  const html = await page.locator("#code-html-soundalerts").textContent() ?? "";
  const js = await page.locator("#code-js-soundalerts").textContent() ?? "";
  const overlayUrl = `${e2eOrigin}/overlay#token=${identity.token}&client=widget&placement=origin`;
  const host = await page.context().newPage();
  await host.goto("about:blank");
  const liveSockets: string[] = [];
  host.on("websocket", (webSocket) => liveSockets.push(new URL(webSocket.url()).pathname));
  await host.setContent(`<!doctype html><html><body>${html}<script>${js}\nwindow.dispatchEvent(new CustomEvent('onWidgetLoad', { detail: { fieldData: { overlayUrl: ${JSON.stringify(overlayUrl)} } } }));</script></body></html>`);
  await expect(host.locator("#chatwerkFrame")).toHaveAttribute("sandbox", "allow-scripts");
  await expect(host.locator("#chatwerkFrame")).toHaveAttribute("src", overlayUrl);
  await expect(host.frameLocator("#chatwerkFrame").locator("#chat")).toBeVisible();
  await expect.poll(() => liveSockets).toContain("/api/overlay/live");
});

test("loads local source dimensions and the saved height limit into copyable OBS values", async ({ page }) => {
  const identity = await seedStudioSession(page, { channel: "" });
  await setConfig(page, identity.overlayId, 0, { maxChatHeight: 260 });
  await page.addInitScript((overlayId) => {
    localStorage.setItem("chatwerk-overlay-id", overlayId);
    localStorage.setItem(`chatwerk-source-size:${overlayId}`, JSON.stringify({ width: 800, height: 260 }));
  }, identity.overlayId);
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/studio/export?platform=obs");

  await expect(page.locator("#setup-url-obs")).toHaveValue(`${e2eOrigin}/overlay#token=${identity.token}`);
  await expect(page.locator("#setup-width-obs")).toHaveValue("800");
  await expect(page.locator("#setup-height-obs")).toHaveValue("260");
  await expect(page.locator("#setup-panel-obs")).toContainText("The top handle changes the height.");
  await expect(page.locator("#setup-panel-obs")).toContainText("Right-click the source, choose Transform, then Reset Transform.");
  await screenshot(page, "setup-obs");

  const copyFields = page.locator("#setup-values-obs .setup-copy-field");
  const expectedValues = [`${e2eOrigin}/overlay#token=${identity.token}`, "800", "260"];
  for (let index = 0; index < expectedValues.length; index += 1) {
    await copyFields.nth(index).getByRole("button").click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(expectedValues[index]);
  }
});

test("falls back to the default source size when Studio has no saved size or height limit", async ({ page }) => {
  await seedStudioSession(page, { channel: "" });
  await page.goto("/studio/export?platform=obs");
  await expect(page.locator("#setup-width-obs")).toHaveValue("400");
  await expect(page.locator("#setup-height-obs")).toHaveValue("600");
});

test("uses the local source height when the saved height limit is below 100", async ({ page }) => {
  const identity = await seedStudioSession(page, { channel: "" });
  await page.addInitScript((overlayId) => {
    localStorage.setItem("chatwerk-overlay-id", overlayId);
    localStorage.setItem(`chatwerk-source-size:${overlayId}`, JSON.stringify({ width: 720, height: 340 }));
  }, identity.overlayId);
  await page.goto("/studio/export?platform=obs");
  await expect(page.locator("#setup-width-obs")).toHaveValue("720");
  await expect(page.locator("#setup-height-obs")).toHaveValue("340");
});

test("selects setup platforms by keyboard, remembers the tab, and honors a platform query", async ({ page }) => {
  await seedStudioSession(page, { channel: "" });
  await page.goto("/studio/export");
  const tabs = page.locator("#setup-tabs");
  await expect(tabs.locator('[aria-selected="true"]')).toHaveAttribute("id", "setup-tab-obs");

  await page.locator("#setup-tab-obs").focus();
  await page.keyboard.press("ArrowRight");
  await expect(page.locator("#setup-tab-streamelements")).toHaveAttribute("aria-selected", "true");
  await page.keyboard.press("End");
  await expect(page.locator("#setup-tab-soundalerts")).toHaveAttribute("aria-selected", "true");
  await page.reload();
  await expect(page.locator("#setup-tab-soundalerts")).toHaveAttribute("aria-selected", "true");

  await page.goto("/studio/export?platform=obs");
  await expect(page.locator("#setup-tab-obs")).toHaveAttribute("aria-selected", "true");
  await expect(page).toHaveURL(`${e2eOrigin}/studio/export?platform=obs`);
});

test("opens the setup page from Studio navigation and the selected first-run output", async ({ page }) => {
  await seedStudioSession(page, { channel: "" });
  await page.goto("/studio");
  await expect(page.locator(".studio-header .top-nav a[href='/studio/export']")).toHaveText("Setup");
  await page.locator('[data-platform="soundalerts"]').click();
  await expect(page.locator("#first-run-setup")).toHaveAttribute("href", "/studio/export?platform=soundalerts");
  await page.locator("#first-run-setup").click();
  await expect(page).toHaveURL(`${e2eOrigin}/studio/export?platform=soundalerts`);
  await expect(page.locator("#setup-tab-soundalerts")).toHaveAttribute("aria-selected", "true");
  await page.goto("/themes");
  await expect(page.locator(".gallery-header .top-nav a[href='/studio/export']")).toHaveText("Setup");
});

test("keeps page chrome fixed across platform switches and fits at 1024 pixels", async ({ page }) => {
  await seedStudioSession(page, { channel: "" });
  await page.setViewportSize({ width: 1024, height: 768 });
  await page.goto("/studio/export?platform=streamelements");
  const outsideContent = async () => page.evaluate(() => [".export-header", ".export-title-row", "#setup-tabs", ".export-actions"]
    .map((selector) => {
      const rect = document.querySelector(selector)!.getBoundingClientRect();
      return [rect.x, rect.y, rect.width, rect.height];
    }));
  const before = await outsideContent();
  const documentWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  expect(documentWidth).toBeLessThanOrEqual(1024);
  await page.locator("#setup-tab-soundalerts").click();
  expect(await outsideContent()).toEqual(before);
});

test("renders the setup instructions in German", async ({ page }) => {
  await seedStudioSession(page, { channel: "" });
  await page.addInitScript(() => localStorage.setItem("chatwerk-language", "de"));
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/studio/export?platform=obs");
  await expect(page.locator("h1")).toHaveText("Einrichten");
  await expect(page.locator("#setup-panel-obs .setup-values-hint")).toHaveText("Diese Werte kommen aus dem Studio. Der obere Griff ändert die Höhe.");
  await expect(page.locator("#setup-panel-obs .setup-steps > li:first-child")).toHaveText("Füge eine Browserquelle hinzu.");
  await expect(page.locator("#setup-panel-obs .setup-steps > li:nth-child(4)")).toHaveText("Klicke mit rechts auf die Quelle, wähle Transformieren und dann Transformation zurücksetzen. Tastenkürzel: Cmd+R auf dem Mac oder Ctrl+R unter Windows.");
  const visibleSteps = await page.locator("#setup-panel-obs .setup-steps > li").evaluateAll((steps) =>
    steps.map((step) => step.getBoundingClientRect().bottom <= window.innerHeight),
  );
  expect(visibleSteps).toEqual([true, true, true, true, true]);
  await screenshot(page, "setup-obs-de");
});

test("keeps the OBS URL full width and places width and height side by side", async ({ page }) => {
  await seedStudioSession(page, { channel: "" });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto("/studio/export?platform=obs");

  const fields = page.locator("#setup-values-obs .setup-copy-field");
  const boxes = await fields.evaluateAll((elements) => elements.map((element) => {
    const { x, y, width } = element.getBoundingClientRect();
    return { x, y, width };
  }));
  expect(boxes).toHaveLength(3);
  expect(boxes[0].width).toBeGreaterThan(boxes[1].width * 1.9);
  expect(boxes[1].y).toBe(boxes[2].y);
  expect(boxes[1].x).toBeLessThan(boxes[2].x);
  expect(boxes[1].width).toBeCloseTo(boxes[2].width, 0);
  for (let index = 0; index < 3; index += 1) {
    await expect(fields.nth(index).getByRole("button")).toHaveCount(1);
  }

  await page.setViewportSize({ width: 1024, height: 768 });
  const widthsAt1024 = await fields.evaluateAll((elements) => elements.map((element) => element.getBoundingClientRect().width));
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(1024);
  expect(widthsAt1024[1]).toBeGreaterThanOrEqual(200);
  expect(widthsAt1024[2]).toBeGreaterThanOrEqual(200);
});

test("shows loading, export failure, and no-overlay states in place", async ({ page }) => {
  await seedStudioSession(page, { channel: "" });
  let releaseFirstResponse: (() => void) | undefined;
  const firstResponse = new Promise<void>((resolve) => { releaseFirstResponse = resolve; });
  let requestCount = 0;
  await page.route("**/api/overlays", async (route) => {
    requestCount += 1;
    if (requestCount === 1) {
      await firstResponse;
      await route.fulfill({ status: 503, json: { error: "offline" } });
      return;
    }
    await route.fulfill({ json: { overlays: [] } });
  });
  await page.goto("/studio/export");
  await expect(page.locator("#setup-loading")).toBeVisible();
  releaseFirstResponse?.();
  await expect(page.locator("#export-error")).toContainText("Export could not load. Try again.");
  await page.locator("#export-error button").click();
  await expect(page.locator("#export-error")).toHaveText("No overlays are available for this account.");
  await expect(page.locator("#setup-panels")).toBeHidden();
});
