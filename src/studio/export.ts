import "./studio.css";
import { DEFAULT_PREVIEW_SOURCE_SIZE, isValidPreviewSourceSize } from "./preview-sizing";
import { currentLanguage, translate, type Language, type TranslationKey } from "../shared/i18n";
import { applyTranslations } from "./i18n-dom";
import { buildWidgetExport, buildWidgetOverlayUrl, type WidgetExportBlocks } from "./widget-export";

type SetupPlatform = "obs" | "streamelements" | "soundalerts";
type WidgetBlockName = "html" | "js" | "fields";

interface OwnedOverlay {
  id: string;
  name: string;
  channel: string | null;
  linkToken: string;
  generation: number;
}

interface SetupValues {
  width: number;
  height: number;
}

interface Counts {
  obs: number;
  browser: number;
  widget: number;
  studio: number;
}

const SETUP_PLATFORMS: readonly SetupPlatform[] = ["obs", "streamelements", "soundalerts"];
const SETUP_TAB_STORAGE_KEY = "chatwerk-setup-platform";
const $ = <T = HTMLElement>(selector: string): T => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing setup page element: ${selector}`);
  return element as unknown as T;
};

const language: Language = currentLanguage();
const setupLoading = $("#setup-loading") as HTMLElement;
const errorArea = $("#export-error");
const setupPanels = $("#setup-panels") as HTMLElement;
const testButton = $("#export-test-in-obs") as HTMLButtonElement;
const testHint = $("#export-test-hint");
const actionStatus = $("#export-action-status");
const connection = $("#export-connection");
const copyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
let overlay: OwnedOverlay | undefined;
let blocks: WidgetExportBlocks | undefined;
let setupValues: SetupValues | undefined;
let socket: WebSocket | undefined;
let socketAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let testTimer: ReturnType<typeof setTimeout> | undefined;
let pendingTestId: string | undefined;
let earlyProgress: { id: string; shown: number; total: number } | undefined;
let counts: Counts = { obs: 0, browser: 0, widget: 0, studio: 0 };

applyTranslations(document, language);
document.documentElement.lang = language;
document.title = `${translate(language, "brand")} · ${translate(language, "setup")}`;
wireControls();
activatePlatform(initialPlatform());
void initialize();

async function initialize(): Promise<void> {
  setupLoading.hidden = false;
  errorArea.replaceChildren();
  setupPanels.hidden = true;
  try {
    const response = await fetch("/api/overlays", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/auth/login?next=%2Fstudio%2Fexport");
      return;
    }
    if (!response.ok) throw new Error("overlay-list");
    const result = await response.json() as { overlays?: OwnedOverlay[] };
    const overlays = result.overlays ?? [];
    const savedId = readStorage("chatwerk-overlay-id");
    overlay = overlays.find((item) => item.id === savedId) ?? overlays.find((item) => item.name === "Main") ?? overlays[0];
    setupLoading.hidden = true;
    if (!overlay) {
      errorArea.textContent = translate(language, "noOverlays");
      return;
    }

    try { localStorage.setItem("chatwerk-overlay-id", overlay.id); } catch { /* This setup page stays bound to the loaded overlay. */ }
    const configResponse = await fetch("/api/overlay/config", {
      credentials: "same-origin",
      cache: "no-store",
      headers: { Authorization: `Bearer ${overlay.linkToken}` },
    });
    if (!configResponse.ok) throw new Error("overlay-config");
    const snapshot = await configResponse.json() as { config?: unknown };
    const config = isRecord(snapshot.config) ? snapshot.config : {};
    const maxChatHeight = config.maxChatHeight;
    const sourceSize = readSourceSize(overlay.id);
    setupValues = {
      width: sourceSize?.width ?? DEFAULT_PREVIEW_SOURCE_SIZE.width,
      height: typeof maxChatHeight === "number" && Number.isFinite(maxChatHeight) && maxChatHeight >= 100
        ? maxChatHeight
        : sourceSize?.height ?? DEFAULT_PREVIEW_SOURCE_SIZE.height,
    };
    blocks = buildWidgetExport(window.location.origin, overlay.linkToken, language);
    renderSetupContent();
    setupPanels.hidden = false;
    connectSocket();
  } catch {
    setupLoading.hidden = true;
    showExportFailure();
  }
}

function initialPlatform(): SetupPlatform {
  const queryPlatform = new URLSearchParams(window.location.search).get("platform");
  if (isSetupPlatform(queryPlatform)) return queryPlatform;
  const savedPlatform = readStorage(SETUP_TAB_STORAGE_KEY);
  return isSetupPlatform(savedPlatform) ? savedPlatform : "obs";
}

function wireControls(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-platform-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      const platform = button.dataset.platformTab;
      if (isSetupPlatform(platform)) activatePlatform(platform);
    });
    button.addEventListener("keydown", (event) => {
      if (!isTabNavigationKey(event.key)) return;
      event.preventDefault();
      const platform = button.dataset.platformTab;
      if (!isSetupPlatform(platform)) return;
      const index = SETUP_PLATFORMS.indexOf(platform);
      const nextIndex = event.key === "Home" ? 0
        : event.key === "End" ? SETUP_PLATFORMS.length - 1
          : (index + (event.key === "ArrowRight" ? 1 : -1) + SETUP_PLATFORMS.length) % SETUP_PLATFORMS.length;
      const next = SETUP_PLATFORMS[nextIndex];
      if (next) activatePlatform(next, true);
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-copy-value]").forEach((button) => {
    button.addEventListener("click", () => void copyValue(button));
  });
  document.querySelectorAll<HTMLButtonElement>("[data-copy-block]").forEach((button) => {
    button.addEventListener("click", () => void copyBlock(button));
  });
  testButton.addEventListener("click", () => void runTestLine());
}

function isTabNavigationKey(key: string): boolean {
  return key === "ArrowRight" || key === "ArrowLeft" || key === "Home" || key === "End";
}

function activatePlatform(platform: SetupPlatform, focusTab = false): void {
  for (const item of SETUP_PLATFORMS) {
    const selected = item === platform;
    const tab = $(`#setup-tab-${item}`) as HTMLButtonElement;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#setup-panel-${item}`).toggleAttribute("hidden", !selected);
  }
  try { localStorage.setItem(SETUP_TAB_STORAGE_KEY, platform); } catch { /* The tab selection stays active for this page. */ }
  if (focusTab) $(`#setup-tab-${platform}`)?.focus();
}

function renderSetupContent(): void {
  if (!overlay || !setupValues || !blocks) return;
  const widgetUrl = buildWidgetOverlayUrl(window.location.origin, overlay.linkToken);
  for (const platform of SETUP_PLATFORMS) {
    const panel = $(`#setup-panel-${platform}`) as HTMLElement;
    const overlayUrl = platform === "obs" ? `${window.location.origin}/overlay#token=${overlay.linkToken}` : widgetUrl;
    const valuesRoot = $(`#setup-values-${platform}`) as HTMLElement;
    valuesRoot.replaceChildren(
      createCopyField(platform, "url", "exportUrlLabel", overlayUrl),
      createCopyField(platform, "width", "setupWidth", String(setupValues.width)),
      createCopyField(platform, "height", "setupHeight", String(setupValues.height)),
    );
    panel.querySelector<HTMLElement>(`#setup-no-channel-${platform}`)!.hidden = Boolean(overlay.channel?.trim());
    panel.querySelectorAll<HTMLElement>("[data-block-content]").forEach((pre) => {
      const name = pre.dataset.blockContent;
      if (isWidgetBlockName(name)) pre.textContent = blocks![name];
    });
  }
}

function createCopyField(platform: SetupPlatform, key: "url" | "width" | "height", labelKey: TranslationKey, value: string): HTMLElement {
  const labelText = translate(language, labelKey);
  const wrapper = document.createElement("div");
  wrapper.className = `setup-copy-field setup-copy-field-${key}`;

  const label = document.createElement("label");
  label.className = "control-label";
  label.htmlFor = `setup-${key}-${platform}`;
  label.textContent = labelText;

  const row = document.createElement("div");
  row.className = "setup-copy-row";
  const input = document.createElement("input");
  input.id = `setup-${key}-${platform}`;
  input.className = "setup-value-input";
  input.type = "text";
  input.readOnly = true;
  input.value = value;
  input.dataset.setupValue = key;
  input.setAttribute("aria-label", labelText);

  const button = document.createElement("button");
  button.className = "small-button setup-copy-button";
  button.type = "button";
  button.dataset.copyValue = key;
  button.textContent = translate(language, "copy");
  button.setAttribute("aria-label", translate(language, "copySetupValue", { label: labelText }));
  row.appendChild(input);
  row.appendChild(button);

  const feedback = document.createElement("span");
  feedback.className = "copy-feedback";
  feedback.setAttribute("role", "status");
  feedback.setAttribute("aria-live", "polite");
  wrapper.appendChild(label);
  wrapper.appendChild(row);
  wrapper.appendChild(feedback);
  button.addEventListener("click", () => void copyValue(button));
  return wrapper;
}

async function copyValue(button: HTMLButtonElement): Promise<void> {
  const field = button.closest(".setup-copy-field")?.querySelector<HTMLInputElement>("[data-setup-value]");
  const feedback = button.closest(".setup-copy-field")?.querySelector<HTMLElement>(".copy-feedback");
  if (!field || !feedback) return;
  await copyText(field.value, feedback, button);
}

async function copyBlock(button: HTMLButtonElement): Promise<void> {
  const name = button.dataset.copyBlock;
  if (!blocks || !isWidgetBlockName(name)) return;
  const feedback = button.closest(".setup-code-actions")?.querySelector<HTMLElement>(".copy-feedback");
  if (!feedback) return;
  await copyText(blocks[name], feedback, button);
}

async function copyText(text: string, feedback: HTMLElement, owner: HTMLElement): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const temporary = document.createElement("textarea");
    temporary.value = text;
    temporary.setAttribute("readonly", "true");
    temporary.style.position = "fixed";
    temporary.style.opacity = "0";
    document.body.appendChild(temporary);
    temporary.select();
    document.execCommand("copy");
    temporary.remove();
  }
  const prior = copyTimers.get(owner);
  if (prior !== undefined) clearTimeout(prior);
  feedback.textContent = translate(language, "copied");
  copyTimers.set(owner, setTimeout(() => { feedback.textContent = ""; }, 2_000));
}

function readSourceSize(overlayId: string): SetupValues | undefined {
  const stored = readStorage(`chatwerk-source-size:${overlayId}`);
  if (!stored) return undefined;
  try {
    const parsed: unknown = JSON.parse(stored) as unknown;
    return isValidPreviewSourceSize(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function showExportFailure(): void {
  errorArea.replaceChildren(document.createTextNode(translate(language, "exportFailed")));
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "small-button";
  retry.textContent = translate(language, "tryAgain");
  retry.addEventListener("click", () => void initialize());
  errorArea.appendChild(document.createTextNode(" "));
  errorArea.appendChild(retry);
}

function connectSocket(): void {
  if (!overlay) return;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  const url = new URL("/api/overlay/live", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const nextSocket = new WebSocket(url, ["chatwerk-live", overlay.linkToken]);
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    socketAttempt = 0;
    connection.removeAttribute("data-count");
    nextSocket.send(JSON.stringify({ type: "hello", schemaVersion: 1, client: "studio" }));
  });
  nextSocket.addEventListener("message", (event) => {
    let message: unknown;
    try { message = JSON.parse(String(event.data)) as unknown; } catch { return; }
    if (!isRecord(message) || typeof message.type !== "string") return;
    if (message.type === "clients" && isRecord(message.counts)) {
      counts = {
        obs: safeCount(message.counts.obs),
        browser: safeCount(message.counts.browser),
        widget: safeCount(message.counts.widget),
        studio: safeCount(message.counts.studio),
      };
      updateConnectionCount();
      return;
    }
    if (message.type === "test-progress" && typeof message.id === "string" &&
      Number.isSafeInteger(message.shown) && Number.isSafeInteger(message.total)) {
      const progress = { id: message.id, shown: Number(message.shown), total: Number(message.total) };
      if (pendingTestId === progress.id && progress.total > 0 && progress.shown >= progress.total) finishTest(progress);
      else earlyProgress = progress;
    }
  });
  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    socket = undefined;
    connection.textContent = translate(language, "connectionUnknown");
    connection.removeAttribute("data-count");
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(socketAttempt, 5));
    socketAttempt += 1;
    reconnectTimer = setTimeout(connectSocket, delay);
  });
  nextSocket.addEventListener("error", () => nextSocket.close());
}

function updateConnectionCount(): void {
  const total = counts.obs + counts.browser + counts.widget;
  connection.dataset.count = String(total);
  connection.textContent = translate(language, "connectionCount", { count: total });
  testButton.disabled = total === 0 || testButton.dataset.pending === "true";
  testHint.textContent = total === 0 ? translate(language, "testConnectFirst") : translate(language, "exportTestHint");
}

async function runTestLine(): Promise<void> {
  if (!overlay || testButton.disabled) return;
  testButton.dataset.pending = "true";
  testButton.disabled = true;
  testButton.textContent = translate(language, "testSending");
  actionStatus.textContent = "";
  try {
    const response = await fetch(`/api/overlays/${overlay.id}/test-line`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (response.status === 401) {
      window.location.assign("/auth/login?next=%2Fstudio%2Fexport");
      return;
    }
    if (!response.ok) throw new Error("test-line");
    const result = await response.json() as { id: string };
    pendingTestId = result.id;
    if (earlyProgress?.id === result.id && earlyProgress.total > 0 && earlyProgress.shown >= earlyProgress.total) {
      finishTest(earlyProgress);
      return;
    }
    testTimer = setTimeout(() => {
      actionStatus.textContent = translate(language, "testNoAck");
      restoreTestButton();
    }, 3_000);
  } catch {
    actionStatus.textContent = translate(language, "testNoAck");
    restoreTestButton();
  }
}

function finishTest(progress: { shown: number; total: number }): void {
  if (testTimer !== undefined) clearTimeout(testTimer);
  testTimer = undefined;
  pendingTestId = undefined;
  actionStatus.textContent = progress.total === 1
    ? translate(language, "testShownOne", { shown: progress.shown })
    : translate(language, "testShownMany", { shown: progress.shown, total: progress.total });
  restoreTestButton();
}

function restoreTestButton(): void {
  delete testButton.dataset.pending;
  testButton.textContent = translate(language, "testInObs");
  const total = counts.obs + counts.browser + counts.widget;
  testButton.disabled = total === 0;
}

function isWidgetBlockName(name: string | undefined): name is WidgetBlockName {
  return name === "html" || name === "js" || name === "fields";
}

function isSetupPlatform(platform: string | null | undefined): platform is SetupPlatform {
  return platform === "obs" || platform === "streamelements" || platform === "soundalerts";
}

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
