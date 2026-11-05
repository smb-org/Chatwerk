import "./studio.css";
import { currentLanguage, translate, type Language } from "../shared/i18n";
import { applyTranslations } from "./i18n-dom";
import { buildWidgetExport, type WidgetExportBlocks } from "./widget-export";

interface OwnedOverlay {
  id: string;
  name: string;
  channel: string;
  linkToken: string;
  generation: number;
}

interface Counts {
  obs: number;
  browser: number;
  widget: number;
  studio: number;
}

const $ = <T = HTMLElement>(selector: string): T => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing export page element: ${selector}`);
  return element as unknown as T;
};

const language: Language = currentLanguage();
const errorArea = $("#export-error");
const testButton = $("#export-test-in-obs") as HTMLButtonElement;
const testHint = $("#export-test-hint");
const actionStatus = $("#export-action-status");
const connection = $("#export-connection");
let overlay: OwnedOverlay | undefined;
let blocks: WidgetExportBlocks | undefined;
let socket: WebSocket | undefined;
let socketAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let testTimer: ReturnType<typeof setTimeout> | undefined;
let pendingTestId: string | undefined;
let earlyProgress: { id: string; shown: number; total: number } | undefined;
let counts: Counts = { obs: 0, browser: 0, widget: 0, studio: 0 };
const copyTimers = new Map<string, ReturnType<typeof setTimeout>>();

applyTranslations(document, language);
document.documentElement.lang = language;
document.title = `${translate(language, "brand")} · ${translate(language, "widgetExport")}`;
wireControls();
void initialize();

async function initialize(): Promise<void> {
  errorArea.replaceChildren();
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
    if (!overlay) {
      errorArea.textContent = translate(language, "noOverlays");
      return;
    }
    try { localStorage.setItem("chatwerk-overlay-id", overlay.id); } catch { /* This export remains bound to the loaded overlay. */ }
    renderBlocks();
    connectSocket();
  } catch {
    errorArea.replaceChildren(document.createTextNode(translate(language, "exportFailed")));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "small-button";
    retry.textContent = translate(language, "tryAgain");
    retry.addEventListener("click", () => void initialize());
    errorArea.appendChild(document.createTextNode(" "));
    errorArea.appendChild(retry);
  }
}

function renderBlocks(): void {
  if (!overlay) return;
  blocks = buildWidgetExport(window.location.origin, overlay.linkToken, language);
  $("#code-html").textContent = blocks.html;
  $("#code-js").textContent = blocks.js;
  $("#code-fields").textContent = blocks.fields;
  const field = $("#export-url") as HTMLInputElement;
  field.value = `${window.location.origin}/overlay#token=${overlay.linkToken}&client=widget&placement=origin`;
  field.setAttribute("aria-label", translate(language, "exportUrlLabel"));
  updatePlatformNotice();
}

function wireControls(): void {
  $("#export-platform").addEventListener("change", updatePlatformNotice);
  document.querySelectorAll<HTMLButtonElement>("[data-block]").forEach((button) => {
    button.addEventListener("click", () => activateTab(button.dataset.block ?? "html"));
    button.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const tabs = [...document.querySelectorAll<HTMLButtonElement>("[data-block]")];
      const index = tabs.indexOf(button);
      const delta = event.key === "ArrowRight" ? 1 : -1;
      const next = tabs[(index + delta + tabs.length) % tabs.length];
      if (next) {
        activateTab(next.dataset.block ?? "html");
        next.focus();
      }
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-copy]").forEach((button) => {
    button.addEventListener("click", () => void copyBlock(button.dataset.copy ?? "html", button));
  });
  testButton.addEventListener("click", () => void runTestLine());
}

function activateTab(name: string): void {
  for (const block of ["html", "js", "fields"]) {
    const selected = block === name;
    const tab = $(`#tab-${block}`) as HTMLButtonElement;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    $(`#panel-${block}`).toggleAttribute("hidden", !selected);
  }
}

async function copyBlock(name: string, button: HTMLButtonElement): Promise<void> {
  if (!blocks || !(name in blocks)) return;
  const text = blocks[name as keyof WidgetExportBlocks];
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
  if (copyTimers.has(name)) clearTimeout(copyTimers.get(name));
  button.textContent = translate(language, "exportCopied");
  copyTimers.set(name, setTimeout(() => { button.textContent = translate(language, "exportCopy"); }, 2_000));
}

function updatePlatformNotice(): void {
  const platform = $("#export-platform") as HTMLSelectElement;
  $("#soundalerts-note").toggleAttribute("hidden", platform.value !== "soundalerts");
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

function readStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
