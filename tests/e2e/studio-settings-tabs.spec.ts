import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { THEME_FIELDS } from "../../src/shared/theme";
import { seedStudioSession, selectSettingsTabForField } from "./studio-session";

const shots = ".tmp/shots";
const tabIds = ["appearance", "layout", "messages", "emotes-effects", "reactions", "filters"];
const tabLabels = ["Appearance", "Layout", "Messages", "Emotes & Effects", "Reactions", "Filters"];

async function openStudio(page: Page, viewport = { width: 1440, height: 900 }): Promise<void> {
  const identity = await seedStudioSession(page);
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({
    json: { role: "owner", connected: false, ownerLogin: identity.login },
  }));
  await page.addInitScript(() => {
    if (sessionStorage.getItem("chatwerk-e2e-storage-reset") === "1") return;
    localStorage.clear();
    sessionStorage.setItem("chatwerk-e2e-storage-reset", "1");
  });
  await page.setViewportSize(viewport);
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
}

async function selectTab(page: Page, name: string): Promise<void> {
  await page.getByRole("tab", { name, exact: true }).click();
}

test("settings tabs own every non-channel theme field and translate Appearance", async ({ page }) => {
  await openStudio(page);
  const tabs = page.getByRole("tab");
  await expect(tabs).toHaveText(tabLabels);
  await expect.poll(() => tabs.evaluateAll((items) => items.map((tab) => tab.id)))
    .toEqual(tabIds.map((id) => `settings-tab-${id}`));
  for (let index = 0; index < tabLabels.length; index += 1) {
    await expect(tabs.nth(index)).toHaveAttribute("aria-selected", index === 0 ? "true" : "false");
  }

  const renderedFields = await page.locator(".theme-control[data-theme-field]").evaluateAll((controls) =>
    controls.map((control) => {
      const panel = control.closest<HTMLElement>("[role='tabpanel']");
      const group = control.closest<HTMLElement>("[data-group]")?.dataset.group;
      return { name: control.getAttribute("data-theme-field"), group, panelGroups: panel?.dataset.groups };
    }));
  const expectedFields = Object.entries(THEME_FIELDS)
    .filter(([, definition]) => definition.ui.group !== "Channels")
    .map(([name, definition]) => ({ name, group: definition.ui.group }));
  expect(renderedFields).toHaveLength(expectedFields.length);
  for (const field of expectedFields) {
    const matches = renderedFields.filter((rendered) => rendered.name === field.name);
    expect(matches).toHaveLength(1);
    expect(matches[0]?.group).toBe(field.group);
    expect(matches[0]?.panelGroups?.split(",")).toContain(field.group);
  }

  for (const group of ["Text", "Colors", "Panel", "Layout", "Messages", "Emotes & Effects", "Reactions", "Filters"]) {
    const actual = renderedFields.filter((field) => field.group === group).map((field) => field.name);
    const expected = Object.entries(THEME_FIELDS)
      .filter(([, definition]) => definition.ui.group === group)
      .sort((left, right) => left[1].ui.order - right[1].ui.order)
      .map(([name]) => name);
    expect(actual).toEqual(expected);
  }

  await page.locator("#account-menu > summary").click();
  await page.locator("#language-de").click();
  await expect(page.getByRole("tab").first()).toHaveText("Aussehen");
});

test("settings tabs support roving keyboard navigation", async ({ page }) => {
  await openStudio(page);
  const tabs = page.getByRole("tab");
  await tabs.first().focus();
  await page.keyboard.press("ArrowRight");
  await expect(tabs.nth(1)).toBeFocused();
  await expect(tabs.nth(1)).toHaveAttribute("aria-selected", "true");
  await expect(tabs.nth(0)).toHaveAttribute("tabindex", "-1");
  await page.keyboard.press("End");
  await expect(tabs.nth(5)).toBeFocused();
  await page.keyboard.press("ArrowLeft");
  await expect(tabs.nth(4)).toBeFocused();
  await page.keyboard.press("Home");
  await expect(tabs.nth(0)).toBeFocused();
  await expect(tabs.nth(0)).toHaveAttribute("aria-selected", "true");
});

test("mouse selection focuses the selected settings tab", async ({ page }) => {
  await openStudio(page);
  const reactionsTab = page.getByRole("tab", { name: "Reactions" });
  await reactionsTab.click();
  await expect(reactionsTab).toBeFocused();
  await expect(reactionsTab).toHaveAttribute("aria-selected", "true");
});

test("keyboard focus reaches settings before preview and skips the panel itself", async ({ page }) => {
  await openStudio(page);
  await page.locator("#account-menu > summary").focus();
  await page.keyboard.press("Tab");
  await expect(page.getByRole("tab", { name: "Appearance" })).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(page.locator("#theme-fontFamily")).toBeFocused();
});

test("remembers the selected settings tab after reload", async ({ page }) => {
  await openStudio(page);
  await page.locator("#first-run-done").click();
  await selectTab(page, "Filters");
  await page.reload();
  await expect(page.getByRole("tab", { name: "Filters" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#settings-tabpanel-filters")).toBeVisible();
});

test("settings tabs fall back safely when localStorage throws", async ({ page }) => {
  const identity = await seedStudioSession(page);
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({
    json: { role: "owner", connected: false, ownerLogin: identity.login },
  }));
  await page.addInitScript(() => {
    Object.defineProperty(Storage.prototype, "getItem", { value: () => { throw new Error("blocked storage"); } });
    Object.defineProperty(Storage.prototype, "setItem", { value: () => { throw new Error("blocked storage"); } });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/studio");
  await expect(page.getByRole("tab").first()).toHaveAttribute("aria-selected", "true");
  await selectTab(page, "Messages");
  await expect(page.locator("#settings-tabpanel-messages")).toBeVisible();
  expect(errors).toEqual([]);
});

test("tab switching leaves the status, tab strip, warning slot, and preview stage fixed", async ({ page }) => {
  await openStudio(page);
  const geometry = async () => page.evaluate(() => ["#status-row", "#settings-tabs", "#warning-row", "#settings-scroll", "#preview-window"].map((selector) => {
    const { x, y, width, height } = document.querySelector(selector)!.getBoundingClientRect();
    return [x, y, width, height];
  }));
  const initial = await geometry();
  expect(initial[1]![1]).toBe(initial[0]![1] + initial[0]![3]);
  expect(initial[2]![1]).toBe(initial[1]![1] + initial[1]![3]);
  expect(initial[3]![1]).toBe(initial[2]![1] + initial[2]![3]);
  for (const name of ["Messages", "Reactions", "Appearance", "Filters"]) {
    await selectTab(page, name);
    expect(await geometry()).toEqual(initial);
  }
});

test("settings stay left of the preview and preview controls stay anchored to it", async ({ page }) => {
  await openStudio(page, { width: 1440, height: 900 });
  const layout = await page.evaluate(() => {
    const box = (selector: string) => {
      const { left, right, top, bottom } = document.querySelector(selector)!.getBoundingClientRect();
      return { left, right, top, bottom };
    };
    const settings = document.querySelector<HTMLElement>(".settings-panel")!;
    const workspace = document.querySelector<HTMLElement>(".workspace")!;
    const toolbar = document.querySelector<HTMLElement>(".preview-toolbar")!;
    return {
      childOrder: [...workspace.children].map((child) => child.className),
      settings: box(".settings-panel"),
      preview: box(".preview-column"),
      toolbar: box(".preview-toolbar"),
      mode: box(".preview-mode-chip"),
      meta: box(".preview-meta"),
      divider: {
        left: getComputedStyle(settings).borderLeftWidth,
        right: getComputedStyle(settings).borderRightWidth,
      },
      toolbarWidth: toolbar.clientWidth,
    };
  });
  expect(layout.childOrder).toEqual(["settings-panel", "preview-column"]);
  expect(layout.settings.left).toBeLessThan(layout.preview.left);
  expect(layout.settings.right).toBeLessThanOrEqual(layout.preview.left + 1);
  expect(layout.divider).toEqual({ left: "0px", right: "1px" });
  expect(layout.toolbar.left).toBeGreaterThanOrEqual(layout.preview.left);
  expect(layout.toolbar.right).toBeLessThanOrEqual(layout.preview.right);
  expect(layout.mode.left).toBeGreaterThanOrEqual(layout.preview.left);
  expect(layout.meta.right).toBeLessThanOrEqual(layout.preview.right);

  await page.locator("#preview-size-preset").selectOption("custom");
  await expect(page.locator("#preview-custom-size")).toBeVisible();
  const customSizeBounds = await page.locator("#preview-custom-size").evaluate((element) => {
    const { left, right } = element.getBoundingClientRect();
    return { left, right };
  });
  expect(customSizeBounds.left).toBeGreaterThanOrEqual(layout.toolbar.left);
  expect(customSizeBounds.right).toBeLessThanOrEqual(layout.preview.right);
});

test("keeps the preview toolbar within its column in English and German", async ({ page }) => {
  await openStudio(page, { width: 1024, height: 900 });
  for (const language of ["en", "de"] as const) {
    if (language === "de") {
      await page.locator("#account-menu > summary").click();
      await page.locator("#language-de").click();
    }
    for (const width of [1024, 1441, 1601]) {
      await page.setViewportSize({ width, height: 900 });
      const geometry = await page.evaluate(() => {
        const toolbar = document.querySelector<HTMLElement>(".preview-toolbar")!;
        const label = toolbar.querySelector<HTMLElement>(":scope > .toolbar-label")!;
        const settings = document.querySelector<HTMLElement>(".settings-panel")!;
        const preview = document.querySelector<HTMLElement>(".preview-column")!;
        return {
          labelDisplay: getComputedStyle(label).display,
          toolbarClientWidth: toolbar.clientWidth,
          toolbarScrollWidth: toolbar.scrollWidth,
          settingsWidth: settings.getBoundingClientRect().width,
          previewWidth: preview.getBoundingClientRect().width,
        };
      });
      console.log(`${language} ${width}px toolbar ${geometry.toolbarScrollWidth}/${geometry.toolbarClientWidth}px; preview ${geometry.previewWidth}px; settings ${geometry.settingsWidth}px`);
      expect(geometry.toolbarScrollWidth, `${language} at ${width}px`).toBeLessThanOrEqual(geometry.toolbarClientWidth);
      expect(geometry.settingsWidth).toBeLessThanOrEqual(720);
      expect(geometry.previewWidth).toBeGreaterThanOrEqual(400);
      if (width === 1024) expect(Math.round(geometry.previewWidth), `${language} at minimum width`).toBe(512);
      if (width === 1601) expect(geometry.labelDisplay).not.toBe("none");
    }
  }
});

test("range readouts stay on one line in both languages and panel layouts", async ({ page }) => {
  await openStudio(page, { width: 1280, height: 900 });
  for (const language of ["en", "de"] as const) {
    if (language === "de") {
      await page.locator("#account-menu > summary").click();
      await page.locator("#language-de").click();
    }
    for (const width of [1280, 1024]) {
      await page.setViewportSize({ width, height: 900 });
      await selectTab(page, language === "en" ? "Messages" : "Nachrichten");
      const linesReadout = page.locator("#theme-maxLines-readout");
      await expect(linesReadout).toHaveText(language === "en" ? "100 lines" : "100 Zeilen");
      const lines = await linesReadout.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return range.getClientRects().length;
      });
      expect(lines, `${language} max lines at ${width}px`).toBe(1);

      await selectSettingsTabForField(page, "maxChatHeight");
      const heightReadout = page.locator("#theme-maxChatHeight-readout");
      await expect(heightReadout).toHaveText(language === "en" ? "Full height" : "Volle Höhe");
      const heightMetrics = await heightReadout.evaluate((element) => {
        const range = document.createRange();
        range.selectNodeContents(element);
        return {
          lines: range.getClientRects().length,
          sliderWidth: element.closest(".range-line")?.querySelector("input[type=range]")?.getBoundingClientRect().width ?? 0,
        };
      });
      expect(heightMetrics.lines, `${language} max height at ${width}px`).toBe(1);
      expect(heightMetrics.sliderWidth, `${language} slider at ${width}px`).toBeGreaterThanOrEqual(100);
    }
  }
});

test("hidden controls still save and Messages stays within one and a half panel heights", async ({ page }) => {
  const { token } = await seedStudioSession(page);
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({
    json: { role: "owner", connected: false, ownerLogin: "test" },
  }));
  await page.addInitScript(() => localStorage.clear());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/studio");
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 0");
  await selectTab(page, "Messages");
  await page.locator("#theme-fontSize").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "22";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 1", { timeout: 5_000 });
  const saved = await page.request.get("/api/overlay/config", { headers: { Authorization: `Bearer ${token}` } });
  expect((await saved.json() as { config: { fontSize: number } }).config.fontSize).toBe(22);
  await page.locator("#theme-fontSize").evaluate((element) => {
    const input = element as HTMLInputElement;
    input.value = "18";
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect(page.locator("#status-visible")).toHaveText("Saved, rev 2", { timeout: 5_000 });

  mkdirSync(shots, { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await selectTab(page, "Appearance");
  await page.screenshot({ path: `${shots}/tabs-1440-appearance.png`, fullPage: true });
  await selectTab(page, "Messages");
  const measurements: string[] = [];
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1280, height: 720 }]) {
    await page.setViewportSize(viewport);
    const metric = await page.locator("#settings-scroll").evaluate((element) => ({
      scrollHeight: element.scrollHeight,
      clientHeight: element.clientHeight,
      ratio: Number((element.scrollHeight / element.clientHeight).toFixed(2)),
    }));
    measurements.push(`${viewport.width}x${viewport.height}: ${metric.scrollHeight}/${metric.clientHeight}px (${metric.ratio}x)`);
    expect(metric.ratio).toBeLessThanOrEqual(1.5);
    await page.locator("#settings-scroll").evaluate((element) => { element.scrollTop = 0; });
    await page.screenshot({ path: `${shots}/tabs-${viewport.width}-messages.png`, fullPage: true });
  }
  console.log(`Messages tab content / viewport height: ${measurements.join("; ")}`);

  await page.locator("#account-menu > summary").click();
  await page.locator("#language-de").click();
  if (await page.locator("#account-menu").evaluate((element) => (element as HTMLDetailsElement).open)) {
    await page.locator("#account-menu > summary").click();
  }
  await expect.poll(() => page.locator("#account-menu").evaluate((element) => (element as HTMLDetailsElement).open)).toBe(false);
  await page.setViewportSize({ width: 1440, height: 900 });
  await selectTab(page, "Nachrichten");
  await page.locator("#settings-scroll").evaluate((element) => { element.scrollTop = 0; });
  await page.screenshot({ path: `${shots}/tabs-1440-de-messages.png`, fullPage: true });
  if (await page.locator("#language-en").isHidden()) await page.locator("#account-menu > summary").click();
  await page.locator("#language-en").click();
  if (await page.locator("#account-menu").evaluate((element) => (element as HTMLDetailsElement).open)) {
    await page.locator("#account-menu > summary").click();
  }

  await page.setViewportSize({ width: 1024, height: 768 });
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth,
    workspace: document.querySelector<HTMLElement>(".workspace")!.scrollWidth,
    panel: document.querySelector<HTMLElement>(".settings-panel")!.scrollWidth,
    panelClient: document.querySelector<HTMLElement>(".settings-panel")!.clientWidth,
    tabs: document.querySelector<HTMLElement>("#settings-tabs")!.scrollWidth,
    tabsClient: document.querySelector<HTMLElement>("#settings-tabs")!.clientWidth,
  }));
  expect(overflow.document).toBeLessThanOrEqual(1024);
  expect(overflow.workspace).toBeLessThanOrEqual(1024);
  expect(overflow.panel).toBeLessThanOrEqual(overflow.panelClient);
  expect(overflow.tabs).toBeLessThanOrEqual(overflow.tabsClient);
  await page.locator("#preview-fit").click();
  const fit = await page.evaluate(() => {
    const stage = document.querySelector<HTMLElement>("#preview-window")!;
    const frame = document.querySelector<HTMLIFrameElement>("#studio-preview")!;
    const style = getComputedStyle(stage);
    const bounds = frame.getBoundingClientRect();
    const horizontalPadding = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight);
    const verticalPadding = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom);
    return {
      width: bounds.width,
      height: bounds.height,
      availableWidth: stage.clientWidth - horizontalPadding,
      availableHeight: stage.clientHeight - verticalPadding,
    };
  });
  expect(fit.width).toBeLessThanOrEqual(fit.availableWidth);
  expect(fit.height).toBeLessThanOrEqual(fit.availableHeight);
  await page.screenshot({ path: `${shots}/tabs-1024-messages.png`, fullPage: true });
});

test("first run starts in Appearance and Hype Train callbacks open Reactions", async ({ page }) => {
  const identity = await seedStudioSession(page);
  await page.route(/\/api\/hype-train(?:\?.*)?$/u, (route) => route.fulfill({
    json: { role: "owner", connected: false, ownerLogin: identity.login },
  }));
  await page.addInitScript(() => localStorage.clear());
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/studio");
  await expect(page.locator("#first-run")).toHaveClass(/is-visible/u);
  await expect(page.getByRole("tab", { name: "Appearance" })).toHaveAttribute("aria-selected", "true");
  await page.locator("#first-run-done").click();
  await page.goto("/studio?hypeTrain=denied");
  await expect(page.getByRole("tab", { name: "Reactions" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator("#settings-tabpanel-reactions").getByRole("button", { name: "Connect Hype Train" })).toBeVisible();
});
