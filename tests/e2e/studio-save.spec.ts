import { expect, test } from "@playwright/test";
import { e2eOrigin, fillThemeControl, seedStudioSession, selectSettingsTabForField, setRange } from "./studio-session";

async function writeFromAnotherEditor(
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

async function readLinkedConfig(page: import("@playwright/test").Page, token: string): Promise<Record<string, unknown>> {
  const response = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  return (await response.json() as { config: Record<string, unknown> }).config;
}

function waitForStudioLiveConnection(page: import("@playwright/test").Page): Promise<void> {
  return new Promise((resolve) => {
    page.on("websocket", (socket) => {
      if (!new URL(socket.url()).pathname.endsWith("/api/overlay/live")) return;
      socket.on("framereceived", (frame) => {
        try {
          if ((JSON.parse(String(frame.payload)) as { type?: string }).type === "clients") resolve();
        } catch { /* Ignore unrelated live frames. */ }
      });
    });
  });
}

test("saves the Studio lifetime slider at 300 seconds", async ({ page }) => {
  const { token } = await seedStudioSession(page);
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => socket.close());
  await page.goto("/studio");

  const slider = page.locator("#theme-lifetime");
  await expect(slider).toHaveAttribute("max", "300000");
  await setRange(page, "lifetime", 300_000);
  await expect(slider).toHaveValue("300000");
  await expect(page.locator("#theme-lifetime-readout")).toHaveText("300s");
  await expect(page.locator("#status-visible")).toHaveText(/Saved, rev [1-9]\d*/u, { timeout: 5_000 });

  const response = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  expect(response.status()).toBe(200);
  await expect(response.json()).resolves.toMatchObject({ config: { lifetime: 300_000 } });
});

test("coalesces slider changes while one delayed save is in flight", async ({ page }) => {
  const { overlayId, token } = await seedStudioSession(page);
  await page.goto("/studio");
  const bodies: Array<{ baseRevision: number; patch: Record<string, unknown> }> = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  await page.route(`**/api/overlays/${overlayId}/config`, async (route) => {
    if (route.request().method() !== "PUT") return route.continue();
    concurrent += 1;
    maxConcurrent = Math.max(maxConcurrent, concurrent);
    bodies.push(route.request().postDataJSON() as { baseRevision: number; patch: Record<string, unknown> });
    await new Promise((resolve) => setTimeout(resolve, 350));
    await route.continue();
    concurrent -= 1;
  });

  await setRange(page, "fontSize", 20);
  await page.waitForTimeout(240);
  await setRange(page, "fontSize", 24);
  await page.waitForTimeout(60);
  await setRange(page, "fontSize", 28);
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2", { timeout: 5_000 });
  expect(bodies.length).toBe(2);
  expect(maxConcurrent).toBe(1);
  expect(bodies[1]).toEqual({ baseRevision: 1, patch: { fontSize: 28 } });

  const response = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expect(response.json()).resolves.toMatchObject({ revision: 2, config: { fontSize: 28 } });
});

test("reloads after a 409 and reapplies the pending slider change", async ({ page }) => {
  const { overlayId, token } = await seedStudioSession(page);
  await page.goto("/studio");
  await page.waitForTimeout(150);
  const external = await page.request.put(`${e2eOrigin}/api/overlays/${overlayId}/config`, {
    headers: { Origin: e2eOrigin, "Content-Type": "application/json" },
    data: { baseRevision: 0, patch: { fontWeight: 700 } },
  });
  expect(external.status()).toBe(200);

  let rejectedFirstSave = false;
  await page.route(`**/api/overlays/${overlayId}/config`, async (route) => {
    if (!rejectedFirstSave && route.request().method() === "PUT") {
      rejectedFirstSave = true;
      await route.fulfill({ status: 409, json: { error: "revision-conflict" } });
      return;
    }
    await route.continue();
  });

  await setRange(page, "fontSize", 30);
  await expect(page.locator("#status-visible")).toHaveText("Changed in another tab. Reloaded and applied your last change.", { timeout: 5_000 });
  const response = await page.request.get(`${e2eOrigin}/api/overlay/config`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await expect(response.json()).resolves.toMatchObject({
    revision: 2,
    config: { fontSize: 30, fontWeight: 700 },
  });
  await expect(page.locator("#studio-preview").contentFrame().locator("#chat"))
    .toHaveCSS("--t-font-size", "30px");
});

test("uses a local object URL for Mine without sending a network request", async ({ page }) => {
  await seedStudioSession(page);
  await page.route("**/api/overlay/config", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await route.fetch();
    const snapshot = await response.json() as { config: Record<string, unknown> };
    await route.fulfill({
      response,
      body: JSON.stringify({
        ...snapshot,
        config: { ...snapshot.config, emotes7tv: false, emotesBttv: false, emotesFfz: false, showPaints: false },
      }),
    });
  });
  const requests: string[] = [];
  page.on("request", (request) => requests.push(request.url()));
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toContainText("Saved");
  await selectSettingsTabForField(page, "emotes7tv");
  const effects = page.locator('.settings-group[data-group="Emotes & Effects"]');
  await expect(effects.getByRole("checkbox", { name: "7TV emotes" })).not.toBeChecked();
  await expect(effects.getByRole("checkbox", { name: "BTTV emotes" })).not.toBeChecked();
  await expect(effects.getByRole("checkbox", { name: "FFZ emotes" })).not.toBeChecked();
  await expect(effects.getByRole("checkbox", { name: "7TV paints" })).not.toBeChecked();
  const requestCountBeforeFile = requests.length;
  await page.locator("#preview-background-file").setInputFiles({
    name: "local.png", mimeType: "image/png", buffer: Buffer.from("local-test-image"),
  });
  await expect(page.getByRole("radio", { name: "Mine" })).toBeChecked();
  expect(requests.slice(requestCountBeforeFile).filter((url) => new URL(url).origin !== e2eOrigin)).toEqual([]);
  expect(requests.filter((url) => url.includes("local.png"))).toEqual([]);
});

test("keeps an uncommitted filter list through an incoming config and saves it on blur", async ({ page }) => {
  const { overlayId, token } = await seedStudioSession(page);
  const liveReady = waitForStudioLiveConnection(page);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await liveReady;
  const field = page.locator('textarea[data-list-field="filterWords"]');
  await fillThemeControl(page, "filterWords", "spoiler\nscam");

  await writeFromAnotherEditor(page, overlayId, 0, { tickerSpeed: 145 });
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  await expect(field).toHaveValue("spoiler\nscam");
  await expect(field).toBeFocused();

  await field.press("Tab");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2", { timeout: 5_000 });
  await expect.poll(() => readLinkedConfig(page, token)).toMatchObject({ filterWords: ["spoiler", "scam"] });
});

test("keeps a half-typed hex value through an incoming config and saves the completed value", async ({ page }) => {
  const { overlayId, token } = await seedStudioSession(page);
  const liveReady = waitForStudioLiveConnection(page);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await liveReady;
  const field = page.locator("#theme-highlightBackgroundColor-hex");
  await fillThemeControl(page, "highlightBackgroundColor", "#ABC", ".hex-control");

  await writeFromAnotherEditor(page, overlayId, 0, { tickerSpeed: 145 });
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  await expect(field).toHaveValue("#ABC");
  await expect(field).toBeFocused();

  await fillThemeControl(page, "highlightBackgroundColor", "#123456", ".hex-control");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2", { timeout: 5_000 });
  await expect.poll(() => readLinkedConfig(page, token)).toMatchObject({ highlightBackgroundColor: "#123456" });
});

test("keeps a typed existing channel through an incoming channel refresh and saves it on blur", async ({ page }) => {
  const { overlayId, token, login } = await seedStudioSession(page);
  await writeFromAnotherEditor(page, overlayId, 0, { channels: [login, "secondroom"] });
  const liveReady = waitForStudioLiveConnection(page);
  await page.goto("/studio");
  await liveReady;
  await page.locator("#channel-field-button").click();
  const field = page.locator("[data-channel-value]").nth(1);
  await field.evaluate((element) => {
    const input = element as HTMLInputElement;
    input.focus();
    input.value = "typedroom";
    input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "typedroom" }));
  });

  await writeFromAnotherEditor(page, overlayId, 1, { channels: [login, "remoteroom"] });
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2");
  const refreshedField = page.locator("[data-channel-value]").nth(1);
  await expect(refreshedField).toHaveValue("typedroom");
  await expect(refreshedField).toBeFocused();

  await refreshedField.press("Tab");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 3", { timeout: 5_000 });
  await expect.poll(() => readLinkedConfig(page, token)).toMatchObject({ channels: [login, "typedroom"] });
});

test("updates the visible save status without announcing another editor's broadcast", async ({ page }) => {
  const { overlayId } = await seedStudioSession(page);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  const announcer = page.locator("#status-announcer");
  const previousAnnouncement = await announcer.textContent();

  await writeFromAnotherEditor(page, overlayId, 0, { tickerSpeed: 145 });

  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1");
  await expect(announcer).toHaveText(previousAnnouncement ?? "");
});
