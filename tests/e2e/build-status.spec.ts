import { mkdirSync } from "node:fs";
import { expect, test } from "@playwright/test";
import type { Page, WebSocketRoute } from "@playwright/test";
import { seedStudioSession } from "./studio-session";

async function connectStudioWithClientStatus(page: Page) {
  let liveSocket: WebSocketRoute | undefined;
  await page.routeWebSocket(/\/api\/overlay\/live$/u, (socket: WebSocketRoute) => {
    liveSocket = socket;
  });
  await seedStudioSession(page);
  await page.goto("/studio");
  const chip = page.locator("#connection-chip");
  const buildId = await chip.getAttribute("data-build-id");
  expect(buildId).toMatch(/^[a-f0-9]{16}$/u);
  await expect.poll(() => liveSocket !== undefined).toBe(true);
  if (!liveSocket) throw new Error("Studio live socket did not connect");
  return { chip, buildId: buildId!, liveSocket };
}

function clientStatus(buildId: string) {
  return JSON.stringify({
    type: "clients",
    counts: { obs: 1, browser: 0, widget: 0, studio: 1 },
    clients: [{ client: "obs", revision: 0, chatStatus: "connected", buildId }],
  });
}

async function headerLayout(page: Page) {
  return page.locator(".studio-header").evaluate((header) => {
    const bounds = (element: Element) => {
      const { x, y, width, height } = element.getBoundingClientRect();
      return { x, y, width, height };
    };
    return {
      header: bounds(header),
      chip: bounds(header.querySelector("#connection-chip")!),
      children: [...header.children].map((element) => ({ id: element.id || element.className, ...bounds(element) })),
    };
  });
}

test("marks old outputs in the header chip without covering or moving the preview", async ({ page }) => {
  const { chip, buildId, liveSocket } = await connectStudioWithClientStatus(page);
  liveSocket.send(clientStatus(buildId));
  await expect(chip).toHaveText("OBS: 1 connected");
  await expect(page.locator("#preview-resize-top")).toBeVisible();
  const before = await headerLayout(page);

  const otherBuildId = buildId[0] === "f" ? `e${buildId.slice(1)}` : `f${buildId.slice(1)}`;
  liveSocket.send(clientStatus(otherBuildId));
  const description = "1 output is running an older version. In OBS, open its browser source properties and choose Refresh, or right-click the source and choose Refresh.";
  await expect(chip).toHaveText("OBS: 1 old version");
  await expect(chip).toHaveAttribute("title", description);
  await expect(chip).toHaveAttribute("aria-description", description);
  await expect(page.locator("#old-output-notice")).toHaveCount(0);
  const colors = await chip.evaluate((element) => {
    const tokenProbe = document.createElement("span");
    tokenProbe.style.color = "var(--ui-accent)";
    document.body.appendChild(tokenProbe);
    const warningColor = getComputedStyle(tokenProbe).color;
    tokenProbe.remove();
    return { chipColor: getComputedStyle(element).color, warningColor };
  });
  expect(colors.chipColor).toBe(colors.warningColor);

  const after = await headerLayout(page);
  expect(after).toEqual(before);
  expect(await page.evaluate(() => {
    const handle = document.querySelector<HTMLElement>("#preview-resize-top")!;
    const bounds = handle.getBoundingClientRect();
    return document.elementFromPoint(bounds.left + bounds.width / 2, bounds.top + bounds.height / 2)?.id;
  })).toBe("preview-resize-top");

  mkdirSync(".tmp/shots", { recursive: true });
  await page.screenshot({ path: ".tmp/shots/old-output.png", fullPage: true });

  await page.locator("#account-menu > summary").click();
  await page.locator("#language-de").click();
  await expect(chip).toHaveText("OBS: 1 alter Stand");
  await expect(chip).toHaveAttribute("title", "1 Ausgabe läuft mit einer älteren Version. Öffne in OBS die Eigenschaften der Browserquelle und wähle Aktualisieren, oder klicke mit rechts auf die Quelle und wähle Aktualisieren.");
  await expect(chip).toHaveAttribute("aria-description", "1 Ausgabe läuft mit einer älteren Version. Öffne in OBS die Eigenschaften der Browserquelle und wähle Aktualisieren, oder klicke mit rechts auf die Quelle und wähle Aktualisieren.");
});

test("does not show an old-output notice when an output reports the Studio build", async ({ page }) => {
  const { chip, buildId, liveSocket } = await connectStudioWithClientStatus(page);
  liveSocket.send(clientStatus(buildId));

  await expect(chip).toHaveText("OBS: 1 connected");
  await expect(chip).not.toHaveAttribute("title", /.+/u);
  await expect(chip).not.toHaveAttribute("aria-description", /.+/u);

  await page.goto("/studio/export");
  const setupRefresh = page.locator('#setup-panel-obs [data-i18n="setupRefreshOldOutput"]');
  await expect(setupRefresh).toBeVisible();
  await expect(setupRefresh).toHaveText("In OBS, open the browser source properties and choose Refresh, or right-click the source and choose Refresh.");
});
