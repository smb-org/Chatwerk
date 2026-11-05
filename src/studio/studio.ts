import "./studio.css";
import {
  DEFAULTS,
  FONT_FAMILIES,
  LEGIBILITY_MINIMUM_RATIO,
  SCHEMA_VERSION,
  THEME_FIELDS,
  THEME_UI_GROUPS,
  estimateTextLegibility,
  isValidColor,
  validateTheme,
  type ThemeConfig,
  type ThemeFieldName,
  type ThemeUiGroup,
  type ThemeValues,
} from "../shared/theme";
import { currentLanguage, saveLanguage, translate, type Language, type TranslationKey } from "../shared/i18n";
import { applyTranslations } from "./i18n-dom";
import { initialLoadRetryDelayMs } from "./retry";

interface OwnedOverlay {
  id: string;
  name: string;
  channel: string;
  linkToken: string;
  generation: number;
}

interface ConfigResponse {
  revision: number;
  config: unknown;
  channel?: string;
  themeFrom?: string | null;
}

interface OwnedLook {
  id: string;
  slug: string;
  name: string;
  author: string;
  parent: { removed: boolean; name?: string; author?: string; slug?: string } | null;
  withdrawn: boolean;
}

interface ClientCounts {
  obs: number;
  browser: number;
  widget: number;
  studio: number;
}

interface ThemeFieldDefinition {
  defaultValue: unknown;
  ui: { group: ThemeUiGroup; order: number; label: string; control: string };
  range?: { min: number; max: number; step: number; unit: string };
}

const $ = <T = HTMLElement>(selector: string): T => {
  const element = document.querySelector(selector) as unknown as T | null;
  if (!element) throw new Error(`Missing Studio element ${selector}`);
  return element;
};

const preview = $("#studio-preview") as HTMLIFrameElement;
const previewWindow = $("#preview-window") as HTMLElement;
const previewFrameWrap = $("#preview-frame-wrap") as HTMLElement;
const previewScale = $("#preview-scale") as HTMLElement;
const controlsRoot = $("#theme-controls") as HTMLElement;
const statusVisible = $("#status-visible") as HTMLElement;
const statusAnnouncer = $("#status-announcer") as HTMLElement;
const warningRow = $("#warning-row") as HTMLElement;
const errorArea = $("#save-error") as HTMLElement;
const connectionChip = $("#connection-chip") as HTMLElement;
const testButton = $("#test-in-obs") as HTMLButtonElement;
const testHint = $("#test-output-hint") as HTMLElement;
const toast = $("#toast") as HTMLElement;
const toastText = $("#toast-text") as HTMLElement;
const dialog = $("#account-dialog") as HTMLDialogElement;
const dialogTitle = $("#dialog-title") as HTMLElement;
const dialogBody = $("#dialog-body") as HTMLElement;
const publishDialog = $("#publish-dialog") as HTMLDialogElement;
const publishForm = $("#publish-form") as HTMLFormElement;
const publishInput = $("#publish-name") as HTMLInputElement;
const publishStatus = $("#publish-status") as HTMLElement;
const publishSubmit = $("#publish-submit") as HTMLButtonElement;
const publishOpen = $("#publish-open") as HTMLAnchorElement;
const publishLimit = $("#publish-limit") as HTMLElement;
const undoButton = $("#undo-look") as HTMLButtonElement;
const activeOverlayName = $("#active-overlay-name") as HTMLElement;

let language: Language = currentLanguage();
let overlay: OwnedOverlay | undefined;
let ownedOverlays: OwnedOverlay[] = [];
let theme: ThemeConfig = DEFAULTS;
let revision = 0;
let channel = "";
let connectedOutputs = 0;
let counts: ClientCounts = { obs: 0, browser: 0, widget: 0, studio: 0 };
let socket: WebSocket | undefined;
let socketAttempt = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let initializationRetryAttempt = 0;
let inFlight = false;
let activeDeleteInFlight = false;
let undoInFlight = false;
let pendingPatch: Partial<ThemeValues> = {};
let lastEditAt = 0;
let retryStartedAt = 0;
let conflictNotice = false;
let signedOut = false;
let initializationRetrying = false;
const updateRequired = false;
let fontFallback = false;
let connectionLost = false;
let oneToOne = false;
let objectUrl: string | undefined;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let pendingTestId: string | undefined;
let testTimeout: ReturnType<typeof setTimeout> | undefined;
let earlyTestProgress: { id: string; shown: number; total: number } | undefined;
let activeDialogOpener: HTMLElement | undefined;
let publishDialogOpener: HTMLElement | undefined;
let undoOffer: { snapshotId: string; expectedRevision: number; expiresAt: number; lookName: string } | undefined;
let undoTimer: ReturnType<typeof setTimeout> | undefined;
let publishLimitReached = false;
let currentPlatform = "obs";
let lastAnnouncedCount: number | undefined;

applyPageLanguage();
renderThemeControls();
wireStaticControls();
setStatus("loading");
void initialize();

async function initialize(): Promise<void> {
  try {
    const response = await fetch("/api/overlays", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      signedOut = true;
      updateWarning();
      window.location.assign("/login?next=%2Fstudio");
      return;
    }
    if (!response.ok) throw new Error("overlay-list");
    const result = await response.json() as { overlays?: OwnedOverlay[] };
    ownedOverlays = result.overlays ?? [];
    const requestedOverlayId = new URLSearchParams(window.location.search).get("overlay");
    const storedOverlayId = localStorageValue("chatwerk-overlay-id");
    overlay = ownedOverlays.find((item) => item.id === requestedOverlayId) ??
      ownedOverlays.find((item) => item.id === storedOverlayId) ??
      ownedOverlays.find((item) => item.name === "Main") ?? ownedOverlays[0];
    if (!overlay) throw new Error("overlay-missing");
    try { localStorage.setItem("chatwerk-overlay-id", overlay.id); } catch { /* The server's first overlay remains selected for this page. */ }
    channel = overlay.channel;
    updateActiveOverlayLabel();
    const link = `${window.location.origin}/overlay#token=${overlay.linkToken}`;
    $("#overlay-url").setAttribute("value", link);
    $("#overlay-url").setAttribute("aria-label", translate(language, "overlayLink"));
    await loadConfig();
    if (signedOut) {
      window.location.assign("/login?next=%2Fstudio");
      return;
    }
    connectStudioSocket();
    startFontCheck();
    updateWarning();
    initializationRetrying = false;
    initializationRetryAttempt = 0;
    errorArea.textContent = "";
    setStatus("savedRevision", { revision });
    setupFirstRun();
    processStudioQuery();
    updateTestButton();
    updateHeaderResponsive();
  } catch {
    initializationRetrying = true;
    connectionLost = false;
    const retryMessage = translate(language, "couldNotLoadRetrying");
    setStatus("couldNotLoadRetrying");
    errorArea.textContent = retryMessage;
    updateWarning();
    const delay = initialLoadRetryDelayMs(initializationRetryAttempt);
    initializationRetryAttempt += 1;
    setTimeout(() => void initialize(), delay);
  }
}

async function loadConfig(): Promise<void> {
  if (!overlay) return;
  const response = await fetch("/api/overlay/config", {
    headers: { Authorization: `Bearer ${overlay.linkToken}` },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (response.status === 401) {
    signedOut = true;
    updateWarning();
    return;
  }
  if (!response.ok) throw new Error("config-read");
  const snapshot = await response.json() as ConfigResponse;
  theme = hydrateConfig(snapshot.config, snapshot.channel ?? channel);
  revision = snapshot.revision;
  renderThemeControls();
  applyPreviewTheme();
  updateWarning();
}

function connectStudioSocket(): void {
  if (!overlay) return;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  const url = new URL("/api/overlay/live", window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const nextSocket = new WebSocket(url, ["chatwerk-live", overlay.linkToken]);
  socket = nextSocket;
  nextSocket.addEventListener("open", () => {
    socketAttempt = 0;
    connectionLost = false;
    nextSocket.send(JSON.stringify({ type: "hello", schemaVersion: SCHEMA_VERSION, client: "studio" }));
    updateWarning();
  });
  nextSocket.addEventListener("message", (event) => {
    let message: unknown;
    try { message = JSON.parse(String(event.data)) as unknown; } catch { return; }
    if (!isRecord(message) || typeof message.type !== "string") return;
    if (message.type === "clients" && isRecord(message.counts)) {
      const next: ClientCounts = {
        obs: safeCount(message.counts.obs),
        browser: safeCount(message.counts.browser),
        widget: safeCount(message.counts.widget),
        studio: safeCount(message.counts.studio),
      };
      counts = next;
      updateClientCount();
      updateTestButton();
      if (connectedOutputs > 0) finishFirstRun();
      return;
    }
    if (message.type === "config" && Number.isSafeInteger(message.revision) && Number(message.revision) > revision) {
      clearUndoOffer();
    }
    if (message.type === "test-progress" && typeof message.id === "string" &&
      Number.isSafeInteger(message.shown) && Number.isSafeInteger(message.total)) {
      const progress = { id: message.id, shown: Number(message.shown), total: Number(message.total) };
      if (pendingTestId === progress.id && progress.total > 0 && progress.shown >= progress.total) finishTest(progress);
      else earlyTestProgress = progress;
    }
  });
  nextSocket.addEventListener("close", () => {
    if (socket !== nextSocket) return;
    socket = undefined;
    connectionLost = true;
    updateConnectionChipUnknown();
    updateWarning();
    const delay = Math.min(30_000, 1_000 * 2 ** Math.min(socketAttempt, 5));
    socketAttempt += 1;
    reconnectTimer = setTimeout(connectStudioSocket, delay);
  });
  nextSocket.addEventListener("error", () => nextSocket.close());
}

function updateClientCount(): void {
  const total = counts.obs + counts.browser + counts.widget;
  connectedOutputs = total;
  connectionChip.dataset.count = String(total);
  if (lastAnnouncedCount !== total) {
    lastAnnouncedCount = total;
    connectionChip.textContent = translate(language, "connectionCount", { count: total });
  }
}

function updateConnectionChipUnknown(): void {
  lastAnnouncedCount = undefined;
  connectionChip.removeAttribute("data-count");
  connectionChip.textContent = translate(language, "connectionUnknown");
}

function updateTestButton(): void {
  testButton.disabled = connectedOutputs === 0 || !overlay || testButton.dataset.pending === "true";
  testHint.textContent = connectedOutputs === 0 ? translate(language, "testConnectFirst") : "";
}

function renderThemeControls(): void {
  controlsRoot.replaceChildren();
  for (const group of THEME_UI_GROUPS) {
    const fields = Object.entries(THEME_FIELDS).filter(([, definition]) => definition.ui.group === group)
      .sort((left, right) => left[1].ui.order - right[1].ui.order);
    if (fields.length === 0 && group !== "Channels") continue;

    const groupRoot = document.createElement("fieldset");
    groupRoot.className = "settings-group";
    groupRoot.dataset.group = group;
    const legend = document.createElement("legend");
    legend.textContent = translate(language, groupKey(group));
    groupRoot.appendChild(legend);
    for (const [rawName, rawDefinition] of fields) {
      const name = rawName as ThemeFieldName;
      const definition = rawDefinition as ThemeFieldDefinition;
      groupRoot.appendChild(makeThemeControl(name, definition));
    }
    if (fields.length === 0 && group === "Channels") groupRoot.appendChild(makeChannelReadout());
    controlsRoot.appendChild(groupRoot);
  }
}

function makeChannelReadout(): HTMLElement {
  const readout = document.createElement("p");
  readout.className = "group-readout";
  const value = channel ? `#${channel.replace(/^#/u, "")}` : "—";
  readout.textContent = translate(language, "channelValue", { channel: value });
  return readout;
}

function makeThemeControl(name: ThemeFieldName, definition: ThemeFieldDefinition): HTMLElement {
  const control = document.createElement("div");
  control.className = "theme-control";
  control.dataset.themeField = name;
  const labelText = translate(language, fieldKey(name));
  if (definition.ui.control === "range") {
    const head = document.createElement("div");
    head.className = "control-head";
    const label = document.createElement("label");
    label.className = "control-label";
    label.htmlFor = `theme-${name}`;
    label.textContent = labelText;
    const output = document.createElement("output");
    output.id = `theme-${name}-readout`;
    output.htmlFor = `theme-${name}`;
    output.className = "value-readout";
    output.textContent = formattedRange(name, Number(theme[name]), definition.range?.unit ?? "");
    output.setAttribute("aria-hidden", "true");
    head.appendChild(label);
    const line = document.createElement("div");
    line.className = "range-line";
    const input = document.createElement("input");
    input.type = "range";
    input.id = `theme-${name}`;
    input.dataset.field = name;
    input.min = String(definition.range?.min ?? 0);
    input.max = String(definition.range?.max ?? 100);
    input.step = String(definition.range?.step ?? 1);
    input.value = String(theme[name]);
    input.setAttribute("aria-label", labelText);
    input.addEventListener("input", () => {
      output.textContent = formattedRange(name, Number(input.value), definition.range?.unit ?? "");
      setThemeField(name, Number(input.value));
    });
    input.addEventListener("keydown", (event) => {
      if (!event.shiftKey || (event.key !== "ArrowRight" && event.key !== "ArrowLeft")) return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = Number(input.value) + direction * Number(input.step) * 10;
      input.value = String(Math.min(Number(input.max), Math.max(Number(input.min), next)));
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    line.appendChild(input);
    line.appendChild(output);
    input.addEventListener("input", () => {
      output.textContent = formattedRange(name, Number(input.value), definition.range?.unit ?? "");
    });
    control.appendChild(head);
    control.appendChild(line);
    return control;
  }

  if (definition.ui.control === "list") return makeListEditor(name, labelText);
  if (definition.ui.control === "channels") return makeChannelsEditor(name, labelText);

  if (definition.ui.control === "color") {
    const head = document.createElement("div");
    head.className = "control-head";
    const label = document.createElement("label");
    label.className = "control-label";
    label.htmlFor = `theme-${name}-color`;
    label.textContent = labelText;
    const line = document.createElement("div");
    line.className = "color-line";
    const picker = document.createElement("input");
    picker.type = "color";
    picker.id = `theme-${name}-color`;
    picker.value = String(theme[name]).slice(0, 7);
    picker.setAttribute("aria-label", labelText);
    const hex = document.createElement("input");
    hex.type = "text";
    hex.className = "hex-control";
    hex.id = `theme-${name}-hex`;
    hex.value = String(theme[name]).toUpperCase();
    hex.maxLength = 9;
    hex.pattern = "#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?";
    hex.setAttribute("aria-label", `${labelText} ${translate(language, "colorHex")}`);
    picker.addEventListener("input", () => {
      hex.value = picker.value.toUpperCase();
      hex.removeAttribute("aria-invalid");
      setThemeField(name, picker.value);
    });
    hex.addEventListener("input", () => {
      const value = hex.value.trim();
      if (!isValidColor(value)) {
        hex.setAttribute("aria-invalid", "true");
        errorArea.textContent = translate(language, "invalidColor");
        return;
      }
      hex.removeAttribute("aria-invalid");
      errorArea.textContent = "";
      picker.value = value.slice(0, 7);
      setThemeField(name, value.toLowerCase());
    });
    head.appendChild(label);
    line.appendChild(picker);
    line.appendChild(hex);
    control.appendChild(head);
    control.appendChild(line);
    return control;
  }

  if (definition.ui.control === "select") {
    const label = document.createElement("label");
    label.className = "control-label";
    label.htmlFor = `theme-${name}`;
    label.textContent = labelText;
    const select = document.createElement("select");
    select.id = `theme-${name}`;
    select.className = "select-control";
    select.dataset.field = name;
    select.setAttribute("aria-label", labelText);
    for (const value of fieldOptions(name)) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = name === "fontFamily" ? value : valueLabel(name, value);
      option.selected = value === String(theme[name]);
      select.appendChild(option);
    }
    select.addEventListener("change", () => setThemeField(name, select.value));
    control.appendChild(label);
    control.appendChild(select);
    return control;
  }

  if (definition.ui.control === "toggle") {
    const label = document.createElement("label");
    label.className = "control-label toggle-control";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `theme-${name}`;
    input.dataset.field = name;
    input.checked = Boolean(theme[name]);
    input.setAttribute("aria-label", labelText);
    input.addEventListener("change", () => setThemeField(name, input.checked));
    label.appendChild(input);
    label.appendChild(document.createTextNode(labelText));
    control.appendChild(label);
    return control;
  }

  const radios = document.createElement("fieldset");
  radios.className = "theme-control";
  radios.dataset.control = name;
  radios.setAttribute("role", "radiogroup");
  radios.setAttribute("aria-label", labelText);
  const legend = document.createElement("legend");
  legend.className = "control-label";
  legend.textContent = labelText;
  const row = document.createElement("div");
  row.className = "segmented-group";
  for (const value of fieldOptions(name)) {
    const label = document.createElement("label");
    const radio = document.createElement("input");
    radio.type = "radio";
    radio.name = `theme-${name}`;
    radio.value = value;
    radio.checked = value === String(theme[name]);
    radio.tabIndex = radio.checked ? 0 : -1;
    radio.addEventListener("change", () => {
      if (!radio.checked) return;
      row.querySelectorAll<HTMLInputElement>("input[type=radio]").forEach((item) => { item.tabIndex = item.checked ? 0 : -1; });
      setThemeField(name, value);
    });
    label.appendChild(radio);
    label.appendChild(document.createTextNode(valueLabel(name, value)));
    row.appendChild(label);
  }
  radios.appendChild(legend);
  radios.appendChild(row);
  control.appendChild(radios);
  return control;
}

function makeListEditor(name: ThemeFieldName, labelText: string): HTMLElement {
  const control = document.createElement("div");
  control.className = "theme-control";
  control.dataset.themeField = name;
  const label = document.createElement("label");
  label.className = "control-label";
  label.htmlFor = `theme-${name}`;
  label.textContent = labelText;
  const input = document.createElement("textarea");
  input.id = `theme-${name}`;
  input.className = "list-control";
  input.dataset.listField = name;
  input.rows = 3;
  input.value = (theme[name] as string[]).join("\n");
  input.setAttribute("aria-label", labelText);
  input.setAttribute("placeholder", translate(language, "oneEntryPerLine"));
  input.addEventListener("change", () => {
    const values = input.value.split(/\r?\n/u).map((value) => value.trim()).filter(Boolean);
    if (!setThemeField(name, values as ThemeValues[typeof name])) {
      input.setAttribute("aria-invalid", "true");
      errorArea.textContent = translate(language, "invalidList");
      return;
    }
    input.removeAttribute("aria-invalid");
  });
  control.appendChild(label);
  control.appendChild(input);
  return control;
}

function makeChannelsEditor(name: ThemeFieldName, labelText: string): HTMLElement {
  const control = document.createElement("div");
  control.className = "theme-control channel-editor";
  control.dataset.themeField = name;
  const label = document.createElement("span");
  label.className = "control-label";
  label.textContent = labelText;
  const list = document.createElement("ol");
  list.className = "channel-list";
  list.setAttribute("aria-label", labelText);
  const values = currentChannels();
  values.forEach((value, index) => {
    const row = document.createElement("li");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "channel-input";
    input.dataset.channelValue = "true";
    input.dataset.channelFocus = `channel-${index}`;
    input.value = value;
    input.maxLength = 25;
    input.pattern = "[A-Za-z0-9_]{1,25}";
    input.autocomplete = "off";
    input.required = true;
    input.setAttribute("aria-label", translate(language, "channelNumber", { number: index + 1 }));
    input.addEventListener("change", () => { setTimeout(saveChannelInputs, 0); });
    row.appendChild(input);

    const moveUp = document.createElement("button");
    moveUp.type = "button";
    moveUp.className = "channel-order-button";
    moveUp.dataset.channelFocus = `up-${index}`;
    moveUp.textContent = "↑";
    moveUp.setAttribute("aria-label", translate(language, "moveChannelUp", { channel: value }));
    moveUp.disabled = index === 0;
    moveUp.addEventListener("click", () => reorderChannel(index, index - 1));
    row.appendChild(moveUp);

    const moveDown = document.createElement("button");
    moveDown.type = "button";
    moveDown.className = "channel-order-button";
    moveDown.dataset.channelFocus = `down-${index}`;
    moveDown.textContent = "↓";
    moveDown.setAttribute("aria-label", translate(language, "moveChannelDown", { channel: value }));
    moveDown.disabled = index === values.length - 1;
    moveDown.addEventListener("click", () => reorderChannel(index, index + 1));
    row.appendChild(moveDown);

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "channel-remove-button";
    remove.dataset.channelFocus = `remove-${index}`;
    remove.textContent = "×";
    remove.setAttribute("aria-label", translate(language, "removeChannel", { channel: value }));
    remove.disabled = values.length <= 1;
    remove.addEventListener("click", () => {
      if (values.length <= 1) return;
      const previous = [...theme.channels];
      if (saveChannels(values.filter((_item, itemIndex) => itemIndex !== index)) && !sameChannels(previous, theme.channels)) {
        refreshChannelsEditor();
      }
    });
    row.appendChild(remove);
    list.appendChild(row);
  });

  const addRow = document.createElement("div");
  addRow.className = "channel-add-row";
  const addInput = document.createElement("input");
  addInput.type = "text";
  addInput.maxLength = 25;
  addInput.autocomplete = "off";
  addInput.dataset.channelNew = "true";
  addInput.dataset.channelFocus = "new";
  addInput.setAttribute("aria-label", translate(language, "addChannel"));
  addInput.setAttribute("placeholder", translate(language, "channelLoginPlaceholder"));
  const add = document.createElement("button");
  add.type = "button";
  add.className = "channel-add-button";
  add.dataset.channelAdd = "true";
  add.dataset.channelFocus = "add";
  add.textContent = translate(language, "addChannel");
  add.disabled = values.length >= 5;
  add.addEventListener("click", () => {
    const value = addInput.value.trim();
    const next = [...currentChannels(), value];
    if (!value || !saveChannels(next)) {
      addInput.setAttribute("aria-invalid", "true");
      errorArea.textContent = translate(language, "invalidChannel");
      return;
    }
    refreshChannelsEditor();
  });
  addInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      add.click();
    }
  });
  addRow.appendChild(addInput);
  addRow.appendChild(add);
  control.appendChild(label);
  control.appendChild(list);
  control.appendChild(addRow);
  return control;

  function saveChannelInputs(): void {
    const inputs = [...list.querySelectorAll<HTMLInputElement>("[data-channel-value]")];
    const next = inputs.map((input) => input.value.trim());
    const seen = new Set<string>();
    for (const input of inputs) {
      const normalized = input.value.trim().toLowerCase();
      const duplicate = seen.has(normalized);
      if (!input.checkValidity() || duplicate) input.setAttribute("aria-invalid", "true");
      else input.removeAttribute("aria-invalid");
      seen.add(normalized);
    }
    const previous = [...theme.channels];
    if (!saveChannels(next)) {
      list.querySelector<HTMLInputElement>("[data-channel-value][aria-invalid='true']")?.focus();
      errorArea.textContent = translate(language, "invalidChannel");
      return;
    }
    if (!sameChannels(previous, theme.channels)) refreshChannelsEditor();
  }

  function reorderChannel(from: number, to: number): void {
    if (to < 0 || to >= values.length) return;
    const next = [...values];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved!);
    const previous = [...theme.channels];
    if (saveChannels(next) && !sameChannels(previous, theme.channels)) refreshChannelsEditor();
  }
}

function currentChannels(): string[] {
  return theme.channels.length > 0 ? [...theme.channels] : channel ? [channel] : [];
}

function saveChannels(channels: string[]): boolean {
  if (sameChannels(theme.channels, channels)) return true;
  const valid = setThemeField("channels", channels);
  if (!valid) return false;
  errorArea.textContent = "";
  return true;
}

function fieldOptions(name: ThemeFieldName): string[] {
  if (name === "fontFamily") return [...FONT_FAMILIES];
  if (name === "nameColorMode") return ["tag", "text"];
  if (name === "lineOrder") return ["name-first", "message-first"];
  if (name === "motion") return ["fade", "none"];
  if (name === "layout") return ["stack", "ticker"];
  return [];
}

function valueLabel(name: ThemeFieldName, value: string): string {
  const key = name === "layout" ? (value === "ticker" ? "valueTicker" : "valueStack")
    : name === "nameColorMode" ? (value === "tag" ? "valueNameTag" : "valueNameText")
    : name === "lineOrder" ? (value === "name-first" ? "valueNameFirst" : "valueMessageFirst")
      : value === "fade" ? "valueFade" : "valueNone";
  return translate(language, key);
}

function groupKey(group: ThemeUiGroup): TranslationKey {
  return `group${group}` as TranslationKey;
}

function fieldKey(name: ThemeFieldName): TranslationKey {
  return `field${name[0]!.toUpperCase()}${name.slice(1)}` as TranslationKey;
}

function formattedRange(name: ThemeFieldName, value: number, unit: string): string {
  if (unit === "ratio") return translate(language, "rangeValue", { value: Math.round(value * 100), unit: translate(language, "percentUnit") });
  if (unit === "ms") return translate(language, "rangeValue", { value: Math.round(value / 1_000), unit: translate(language, "secondsUnit") });
  if (unit === "px") return translate(language, "rangeValue", { value, unit: translate(language, "pixelsUnit") });
  if (unit === "px/s") return translate(language, "rangeValue", { value, unit: translate(language, "pixelsPerSecondUnit") });
  if (name === "fontWeight") return String(value);
  return String(value);
}

function setThemeField<K extends ThemeFieldName>(name: K, value: ThemeValues[K]): boolean {
  if (activeDeleteInFlight) return false;
  try {
    theme = validateTheme({ ...theme, [name]: value });
  } catch {
    return false;
  }
  pendingPatch = { ...pendingPatch, [name]: value };
  clearUndoOffer();
  lastEditAt = Date.now();
  conflictNotice = false;
  errorArea.textContent = "";
  setStatus("saving");
  applyPreviewTheme();
  updateWarning();
  scheduleSave(200);
  return true;
}

function scheduleSave(delay: number): void {
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = undefined;
    void sendQueuedChanges();
  }, delay);
}

async function sendQueuedChanges(): Promise<void> {
  if (inFlight || !overlay || Object.keys(pendingPatch).length === 0) return;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  const patch = pendingPatch;
  pendingPatch = {};
  const baseRevision = revision;
  inFlight = true;
  try {
    const response = await fetch(`/api/overlays/${overlay.id}/config`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision, patch }),
    });
    if (response.status === 401) {
      pendingPatch = {};
      signedOut = true;
      errorArea.textContent = translate(language, "warningSignedOut");
      updateWarning();
      return;
    }
    if (response.status === 409) {
      await recoverConflict(patch);
      return;
    }
    if (!response.ok) throw new Error(`save-${response.status}`);
    const saved = await response.json() as { revision: number; config: unknown };
    revision = saved.revision;
    if (Object.keys(pendingPatch).length > 0) {
      const previousChannels = [...theme.channels];
      theme = hydrateConfig({ ...saved.config as object, ...pendingPatch }, channel);
      syncControls(previousChannels);
      applyPreviewTheme();
      scheduleSave(Math.max(0, 200 - (Date.now() - lastEditAt)));
    } else {
      const previousChannels = [...theme.channels];
      theme = hydrateConfig(saved.config, channel);
      syncControls(previousChannels);
      applyPreviewTheme();
      setStatus(conflictNotice ? "saveConflict" : "savedRevision", { revision }, true);
      conflictNotice = false;
      retryStartedAt = 0;
      errorArea.textContent = "";
    }
  } catch {
    pendingPatch = { ...patch, ...pendingPatch };
    if (retryStartedAt === 0) retryStartedAt = Date.now();
    setStatus("saveRetrying");
    if (Date.now() - retryStartedAt >= 10_000) {
      statusVisible.textContent = translate(language, "saveFailed");
      errorArea.textContent = translate(language, "saveFailed");
    }
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void sendQueuedChanges();
    }, Date.now() - retryStartedAt >= 10_000 ? 10_000 : 1_000);
  } finally {
    inFlight = false;
    if (Object.keys(pendingPatch).length > 0 && retryTimer === undefined && saveTimer === undefined) {
      scheduleSave(Math.max(0, 200 - (Date.now() - lastEditAt)));
    }
  }
}

async function recoverConflict(sentPatch: Partial<ThemeValues>): Promise<void> {
  if (!overlay) return;
  pendingPatch = { ...sentPatch, ...pendingPatch };
  const response = await fetch("/api/overlay/config", {
    headers: { Authorization: `Bearer ${overlay.linkToken}` },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!response.ok) throw new Error("conflict-reread");
  const fresh = await response.json() as ConfigResponse;
  revision = fresh.revision;
  const previousChannels = [...theme.channels];
  theme = hydrateConfig({ ...fresh.config as object, ...pendingPatch }, fresh.channel ?? channel);
  syncControls(previousChannels);
  applyPreviewTheme();
  conflictNotice = true;
  setStatus("saveConflict", {}, true);
  scheduleSave(0);
}

function syncControls(previousChannels: string[]): void {
  for (const name of Object.keys(THEME_FIELDS) as ThemeFieldName[]) {
    const value = theme[name];
    const range = document.querySelector<HTMLInputElement>(`#theme-${name}[type=range]`);
    if (range) {
      range.value = String(value);
      const readout = $(`#theme-${name}-readout`) as HTMLOutputElement;
      const unit = (THEME_FIELDS[name] as ThemeFieldDefinition).range?.unit ?? "";
      readout.textContent = formattedRange(name, Number(value), unit);
    }
    const color = document.querySelector<HTMLInputElement>(`#theme-${name}-color`);
    const hex = document.querySelector<HTMLInputElement>(`#theme-${name}-hex`);
    if (color && typeof value === "string") color.value = value.slice(0, 7);
    if (hex && typeof value === "string") hex.value = value.toUpperCase();
    const select = document.querySelector(`select#theme-${name}`) as HTMLSelectElement | null;
    if (select) select.value = String(value);
    document.querySelectorAll<HTMLInputElement>(`input[name="theme-${name}"]`).forEach((radio) => {
      radio.checked = radio.value === String(value);
      radio.tabIndex = radio.checked ? 0 : -1;
    });
    const list = document.querySelector<HTMLTextAreaElement>(`textarea[data-list-field="${name}"]`);
    if (list && Array.isArray(value)) list.value = value.join("\n");
  }
  if (!sameChannels(previousChannels, theme.channels)) refreshChannelsEditor();
}

function refreshChannelsEditor(): void {
  const current = document.querySelector<HTMLElement>('[data-theme-field="channels"]');
  if (!current) return;
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && current.contains(active) ? active.dataset.channelFocus : undefined;
  const addInput = current.querySelector<HTMLInputElement>("[data-channel-new]");
  const addValue = addInput?.value ?? "";
  const selection = active instanceof HTMLInputElement && focusKey ? [active.selectionStart, active.selectionEnd] as const : undefined;
  const replacement = makeChannelsEditor("channels", translate(language, "fieldChannels"));
  const nextAddInput = replacement.querySelector<HTMLInputElement>("[data-channel-new]");
  if (nextAddInput) nextAddInput.value = addValue;
  current.replaceWith(replacement);
  if (focusKey) {
    let nextFocus = replacement.querySelector<HTMLElement>(`[data-channel-focus="${focusKey}"]`);
    if (!nextFocus && focusKey.startsWith("remove-")) {
      const lastIndex = replacement.querySelectorAll("[data-channel-value]").length - 1;
      const removedIndex = Number(focusKey.slice("remove-".length));
      const neighborIndex = Math.min(removedIndex, lastIndex);
      nextFocus = replacement.querySelector<HTMLElement>(`[data-channel-focus="remove-${neighborIndex}"]`);
    }
    nextFocus ??= nextAddInput;
    nextFocus?.focus();
    if (selection && nextFocus instanceof HTMLInputElement) nextFocus.setSelectionRange(selection[0], selection[1]);
  }
}

function sameChannels(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((channel, index) => channel === right[index]);
}

function applyPreviewTheme(): void {
  preview.contentWindow?.postMessage({ type: "chatwerk:studio-theme", theme }, "*");
  if (document.querySelector<HTMLInputElement>("#live-chat")?.checked) {
    postPreviewMessage({ type: "chatwerk:studio-live", enabled: true, channels: currentChannels() });
  }
}

function postPreviewMessage(message: Record<string, unknown>): void {
  preview.contentWindow?.postMessage(message, "*");
}

function updateWarning(): void {
  let key: TranslationKey | undefined;
  let kind: string | undefined;
  if (signedOut) { key = "warningSignedOut"; kind = "error"; }
  else if (updateRequired) key = "warningUpdateRequired";
  else {
    try {
      const estimate = estimateTextLegibility(theme.textColor, theme.backgroundColor, theme.backgroundOpacity, LEGIBILITY_MINIMUM_RATIO);
      if (!estimate.meetsOnBoth) key = "warningUnreadable";
      else if (fontFallback) key = "warningFontFallback";
      else if (connectionLost) key = "connectionLost";
    } catch {
      key = "warningUnreadable";
    }
  }
  warningRow.textContent = key ? translate(language, key) : "";
  warningRow.classList.toggle("is-visible", Boolean(key));
  if (kind) warningRow.dataset.kind = kind;
  else warningRow.removeAttribute("data-kind");
}

function startFontCheck(): void {
  void document.fonts.ready.then(() => {
    fontFallback = !document.fonts.check('14px "Schibsted Grotesk"') || !document.fonts.check('12px "Commit Mono"');
    updateWarning();
  }).catch(() => {
    fontFallback = true;
    updateWarning();
  });
}

function setStatus(key: TranslationKey, values: Record<string, string | number> = {}, announce = false): void {
  const value = translate(language, key, values);
  statusVisible.textContent = value;
  if (announce) statusAnnouncer.textContent = value;
}

function applyPageLanguage(): void {
  applyTranslations(document, language);
  document.title = `${translate(language, "brand")} · ${translate(language, "studioTitle")}`;
  const urlField = document.querySelector<HTMLInputElement>("#overlay-url");
  if (urlField) urlField.setAttribute("aria-label", translate(language, "overlayLink"));
  const chipCount = connectionChip.dataset.count;
  if (chipCount !== undefined) connectionChip.textContent = translate(language, "connectionCount", { count: chipCount });
  else connectionChip.textContent = translate(language, "connectionUnknown");
  updateHeaderResponsive();
  if (initializationRetrying) {
    setStatus("couldNotLoadRetrying");
    errorArea.textContent = translate(language, "couldNotLoadRetrying");
  } else if (overlay) {
    setStatus(conflictNotice ? "saveConflict" : inFlight || Object.keys(pendingPatch).length ? "saving" : "savedRevision", { revision });
  }
  updateWarning();
  updateTestButton();
  renderThemeControls();
  updatePreviewScale();
}

function setLanguage(next: Language): void {
  language = next;
  saveLanguage(next);
  applyPageLanguage();
}

function updateHeaderResponsive(): void {
  const button = document.querySelector<HTMLButtonElement>("#copy-link");
  if (button) button.textContent = translate(language, "copy");
}

function wireStaticControls(): void {
  preview.addEventListener("load", () => {
    applyPreviewTheme();
    postPreviewMessage({ type: "chatwerk:studio-scenario", scenario: "quiet" });
    updatePreviewScale();
  });
  const resizeObserver = new ResizeObserver(updatePreviewScale);
  resizeObserver.observe(previewWindow);
  window.addEventListener("resize", updateHeaderResponsive);

  $("#copy-link").addEventListener("click", () => void copyOverlayLink());
  $("#language-en").addEventListener("click", () => setLanguage("en"));
  $("#language-de").addEventListener("click", () => setLanguage("de"));
  $("#open-looks").addEventListener("click", () => void openMyLooksDialog($("#open-looks")));
  $("#share-look").addEventListener("click", () => void openPublishDialog($("#share-look")));
  $("#open-overlays").addEventListener("click", () => openOverlaysDialog($("#open-overlays")));
  $("#logout").addEventListener("click", () => void logout());
  $("#first-run-done").addEventListener("click", finishFirstRun);
  document.querySelectorAll<HTMLButtonElement>("[data-platform]").forEach((button) => {
    button.addEventListener("click", () => {
      currentPlatform = button.dataset.platform ?? "obs";
      document.querySelectorAll<HTMLButtonElement>("[data-platform]").forEach((item) => {
        item.setAttribute("aria-pressed", String(item === button));
      });
      try { localStorage.setItem("chatwerk-output-platform", currentPlatform); } catch { /* Selection stays in memory. */ }
    });
  });
  document.querySelectorAll<HTMLButtonElement>(".scenario-button").forEach((button) => {
    button.addEventListener("click", () => {
      if ((document.querySelector<HTMLInputElement>("#live-chat"))?.checked) return;
      const scenario = button.id === "rehearse-flood" ? "flood" : button.id === "rehearse-raid" ? "raid" : "quiet";
      document.querySelectorAll<HTMLButtonElement>(".scenario-button").forEach((item) => {
        item.setAttribute("aria-pressed", String(item === button));
      });
      try { postPreviewMessage({ type: "chatwerk:studio-scenario", scenario }); }
      catch { showToast("scenarioFailed", true); }
    });
  });
  $("#live-chat").addEventListener("change", (event) => {
    const enabled = (event.currentTarget as HTMLInputElement).checked;
    postPreviewMessage({ type: "chatwerk:studio-live", enabled, channels: currentChannels(), channel });
    document.querySelectorAll<HTMLButtonElement>(".scenario-button").forEach((button) => { button.disabled = enabled; });
    $(".sample-label").textContent = translate(language, enabled ? "liveChat" : "sampleChat");
    if (!enabled) $("#rehearse-quiet").setAttribute("aria-pressed", "true");
  });
  $("#test-in-obs").addEventListener("click", () => void runTestLine());
  $("#toast-close").addEventListener("click", closeToast);
  $("#preview-background-group").addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== "preview-background") return;
    setBackground(input.value);
    if (input.value === "mine" && !objectUrl) $("#preview-background-file").click();
  });
  $("#choose-background").addEventListener("click", () => $("#preview-background-file").click());
  $("#preview-background-file").addEventListener("change", (event) => {
    const input = event.currentTarget as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = URL.createObjectURL(file);
    const radio = document.querySelector<HTMLInputElement>('input[name="preview-background"][value="mine"]');
    if (radio) radio.checked = true;
    setBackground("mine");
    previewWindow.style.backgroundImage = `url("${objectUrl}")`;
  });
  $("#preview-fit").addEventListener("click", () => setScaleMode(false));
  $("#preview-one-to-one").addEventListener("click", () => setScaleMode(true));

  for (const selector of ["#dialog-close", "#dialog-x"]) {
    $(selector).addEventListener("click", closeDialog);
  }
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeDialog();
  });
  dialog.addEventListener("close", () => {
    preview.inert = false;
    activeDialogOpener?.focus();
    activeDialogOpener = undefined;
  });
  publishDialog.addEventListener("close", () => {
    preview.inert = false;
    publishDialogOpener?.focus();
    publishDialogOpener = undefined;
  });
  for (const selector of ["#publish-cancel", "#publish-x"]) {
    $(selector).addEventListener("click", closePublishDialog);
  }
  publishInput.addEventListener("input", updatePublishSubmit);
  publishForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void publishLook();
  });
  $("#publish-manage-looks").addEventListener("click", () => {
    closePublishDialog();
    void openMyLooksDialog($("#open-looks"));
  });
  undoButton.addEventListener("click", () => void undoCopiedLook());
}

async function copyOverlayLink(): Promise<void> {
  const link = document.querySelector<HTMLInputElement>("#overlay-url")?.value;
  if (!link) return;
  try {
    await navigator.clipboard.writeText(link);
  } catch {
    const input = $("#overlay-url") as HTMLInputElement;
    input.select();
    document.execCommand("copy");
    input.setSelectionRange(0, 0);
  }
  const button = $("#copy-link") as HTMLButtonElement;
  button.textContent = translate(language, "copied");
  setTimeout(() => updateHeaderResponsive(), 2_000);
}

function setupFirstRun(): void {
  try {
    currentPlatform = localStorage.getItem("chatwerk-output-platform") ?? "obs";
    if (localStorage.getItem("chatwerk-first-run-done") === "1") return;
  } catch {
    currentPlatform = "obs";
  }
  const button = document.querySelector<HTMLButtonElement>(`[data-platform="${currentPlatform}"]`);
  document.querySelectorAll<HTMLButtonElement>("[data-platform]").forEach((item) => {
    item.setAttribute("aria-pressed", String(item === button));
  });
  $("#first-run").classList.add("is-visible");
  $("#rehearse-tools").setAttribute("hidden", "true");
}

function finishFirstRun(): void {
  try { localStorage.setItem("chatwerk-first-run-done", "1"); } catch { /* The footer still changes for this page. */ }
  $("#first-run").classList.remove("is-visible");
  $("#rehearse-tools").removeAttribute("hidden");
}

function updateActiveOverlayLabel(): void {
  activeOverlayName.textContent = overlay ? translate(language, "activeOverlayName", { name: overlay.name }) : "";
}

function processStudioQuery(): void {
  const params = new URLSearchParams(window.location.search);
  const snapshotId = params.get("undo");
  const expectedRevision = Number(params.get("rev"));
  const expiresAt = Number(params.get("until"));
  const lookName = params.get("lookName") ?? "";
  const shouldPublish = params.get("publish") === "1";
  if (snapshotId && /^[0-9a-f-]{36}$/iu.test(snapshotId) && Number.isSafeInteger(expectedRevision) &&
    expectedRevision === revision && Number.isSafeInteger(expiresAt) && expiresAt > Date.now()) {
    showUndoOffer(snapshotId, expectedRevision, expiresAt, lookName);
  }
  if (["undo", "rev", "until", "look", "lookName", "overlay", "publish"].some((key) => params.has(key))) {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }
  if (shouldPublish) void openPublishDialog($("#share-look"));
}

function showUndoOffer(snapshotId: string, expectedRevision: number, expiresAt: number, lookName: string): void {
  undoOffer = { snapshotId, expectedRevision, expiresAt, lookName };
  statusVisible.textContent = translate(language, "undoLookNotice", { name: lookName });
  statusAnnouncer.textContent = statusVisible.textContent;
  undoButton.hidden = false;
  updateUndoButtonDisabled();
  if (undoTimer !== undefined) clearTimeout(undoTimer);
  undoTimer = setTimeout(() => clearUndoOffer(), Math.max(0, expiresAt - Date.now()));
}

function clearUndoOffer(): void {
  if (undoTimer !== undefined) clearTimeout(undoTimer);
  undoTimer = undefined;
  undoOffer = undefined;
  undoButton.hidden = true;
  updateUndoButtonDisabled();
  if (overlay) setStatus("savedRevision", { revision });
}

async function undoCopiedLook(): Promise<void> {
  if (activeDeleteInFlight || undoInFlight) return;
  if (!overlay || !undoOffer || undoOffer.expectedRevision !== revision) {
    clearUndoOffer();
    return;
  }
  const offer = undoOffer;
  const undoOverlayId = overlay.id;
  undoInFlight = true;
  updateUndoButtonDisabled();
  try {
    const response = await fetch(`/api/overlays/${undoOverlayId}/undo`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ snapshotId: offer.snapshotId, expectedRevision: offer.expectedRevision }),
    });
    if (!response.ok) throw new Error("undo-expired");
    const restored = await response.json() as ConfigResponse;
    if (activeDeleteInFlight || overlay?.id !== undoOverlayId) return;
    revision = restored.revision;
    const previousChannels = [...theme.channels];
    theme = validateTheme(restored.config);
    syncControls(previousChannels);
    applyPreviewTheme();
    updateWarning();
    clearUndoOffer();
    setStatus("lookUndoDone", {}, true);
  } catch {
    if (activeDeleteInFlight || overlay?.id !== undoOverlayId) return;
    clearUndoOffer();
    setStatus("undoExpired", {}, true);
  } finally {
    undoInFlight = false;
    updateUndoButtonDisabled();
  }
}

function updateUndoButtonDisabled(): void {
  undoButton.disabled = activeDeleteInFlight || undoInFlight;
}

async function openPublishDialog(opener: HTMLElement): Promise<void> {
  publishDialogOpener = opener;
  preview.inert = true;
  publishInput.value = "";
  publishStatus.textContent = "";
  publishStatus.removeAttribute("data-kind");
  publishOpen.hidden = true;
  publishLimit.hidden = true;
  publishLimitReached = false;
  closeAccountMenu();
  publishDialog.showModal();
  publishInput.focus();
  updatePublishSubmit();
  try {
    const response = await fetch("/api/looks/mine", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/auth/login?next=%2Fstudio");
      return;
    }
    if (!response.ok) throw new Error("my-looks");
    const result = await response.json() as { looks?: OwnedLook[] };
    publishLimitReached = (result.looks ?? []).filter((look) => !look.withdrawn).length >= 10;
    publishLimit.hidden = !publishLimitReached;
    updatePublishSubmit();
  } catch {
    setPublishMessage("publishError");
  }
}

function closePublishDialog(): void {
  if (publishDialog.open) publishDialog.close();
}

function updatePublishSubmit(): void {
  publishSubmit.disabled = publishLimitReached || publishInput.value.trim().length === 0;
}

function setPublishMessage(key: TranslationKey, values: Record<string, string | number> = {}, success = false): void {
  publishStatus.textContent = translate(language, key, values);
  publishStatus.dataset.kind = success ? "success" : "error";
}

async function publishLook(): Promise<void> {
  if (!overlay || !publishInput.value.trim() || publishLimitReached) return;
  publishSubmit.disabled = true;
  publishSubmit.textContent = translate(language, "publishing");
  publishStatus.textContent = "";
  publishOpen.hidden = true;
  try {
    const response = await fetch("/api/looks", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overlayId: overlay.id, name: publishInput.value.trim() }),
    });
    if (response.status === 401) {
      window.location.assign("/auth/login?next=%2Fstudio");
      return;
    }
    if (response.status === 409) {
      const result = await response.json() as { error?: string };
      if (result.error === "duplicate-name") setPublishMessage("publishDuplicate");
      else if (result.error === "look-limit") {
        publishLimitReached = true;
        publishLimit.hidden = false;
        setPublishMessage("lookLimitStatus");
      } else setPublishMessage("publishError");
      updatePublishSubmit();
      return;
    }
    if (!response.ok) throw new Error("publish-look");
    const look = await response.json() as { slug: string };
    const link = `${window.location.origin}/t/${encodeURIComponent(look.slug)}`;
    publishOpen.href = link;
    publishOpen.textContent = translate(language, "open");
    publishOpen.hidden = false;
    try {
      await copyText(link);
      setPublishMessage("published", {}, true);
    } catch {
      setPublishMessage("publishedLinkNotCopied", {}, true);
    }
  } catch {
    setPublishMessage("publishError");
    updatePublishSubmit();
  } finally {
    publishSubmit.textContent = translate(language, "publishSubmit");
    if (!publishLimitReached && publishStatus.dataset.kind !== "success") updatePublishSubmit();
  }
}

async function copyText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const temporary = document.createElement("textarea");
    temporary.value = value;
    temporary.setAttribute("readonly", "true");
    temporary.style.position = "fixed";
    temporary.style.opacity = "0";
    document.body.appendChild(temporary);
    temporary.select();
    try {
      if (!document.execCommand("copy")) throw new Error("clipboard-unavailable");
    } finally {
      temporary.remove();
    }
  }
}

function openOverlaysDialog(opener: HTMLElement): void {
  dialogTitle.textContent = translate(language, "overlays");
  renderOverlayManager();
  showDialogElement(opener);
}

function renderOverlayManager(noticeKey?: TranslationKey): void {
  dialogBody.replaceChildren();
  const status = document.createElement("p");
  status.className = "manage-status";
  if (noticeKey) status.textContent = translate(language, noticeKey);
  dialogBody.appendChild(status);

  const atLimit = ownedOverlays.length >= 3;
  const form = document.createElement("form");
  form.className = "manage-form";
  const label = document.createElement("label");
  label.className = "control-label";
  label.htmlFor = "new-overlay-name";
  label.textContent = translate(language, "overlayName");
  const name = document.createElement("input");
  name.className = "dialog-input";
  name.id = "new-overlay-name";
  name.maxLength = 40;
  name.autocomplete = "off";
  name.setAttribute("aria-label", translate(language, "overlayName"));
  const create = document.createElement("button");
  create.className = "button button-primary";
  create.type = "submit";
  create.textContent = translate(language, "createOverlay");
  create.disabled = atLimit;
  form.appendChild(label);
  form.appendChild(name);
  form.appendChild(create);
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void createManagedOverlay(name.value, status);
  });
  dialogBody.appendChild(form);
  if (atLimit) {
    const limit = document.createElement("p");
    limit.className = "limit-copy";
    limit.textContent = translate(language, "overlayLimitStatus");
    dialogBody.appendChild(limit);
  }

  const list = document.createElement("div");
  list.className = "manage-list";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", translate(language, "overlays"));
  if (ownedOverlays.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = translate(language, "noOverlays");
    list.appendChild(empty);
  }
  for (const item of ownedOverlays) list.appendChild(makeOverlayRow(item));
  dialogBody.appendChild(list);
}

function makeOverlayRow(item: OwnedOverlay): HTMLElement {
  const row = document.createElement("div");
  row.className = "manage-row";
  const description = document.createElement("span");
  description.className = "manage-row-name";
  description.textContent = item.name;
  const meta = document.createElement("span");
  meta.className = "manage-row-meta";
  meta.textContent = item.channel ? `#${item.channel}` : "—";
  description.appendChild(meta);
  const actions = document.createElement("span");
  actions.className = "manage-row-actions";
  const select = document.createElement("button");
  select.type = "button";
  select.className = "small-button";
  select.textContent = translate(language, "select");
  select.setAttribute("aria-pressed", String(item.id === overlay?.id));
  select.addEventListener("click", () => void selectOverlay(item));
  const rename = document.createElement("button");
  rename.type = "button";
  rename.className = "small-button";
  rename.textContent = translate(language, "renameOverlay");
  rename.addEventListener("click", () => beginOverlayRename(item, row));
  const remove = document.createElement("button");
  remove.type = "button";
  remove.className = "small-button";
  remove.textContent = translate(language, "deleteOverlay");
  remove.disabled = ownedOverlays.length <= 1;
  remove.setAttribute("aria-label", `${translate(language, "deleteOverlay")} ${item.name}`);
  remove.addEventListener("click", () => void deleteManagedOverlay(item));
  actions.appendChild(select);
  actions.appendChild(rename);
  actions.appendChild(remove);
  row.appendChild(description);
  row.appendChild(actions);
  return row;
}

function beginOverlayRename(item: OwnedOverlay, row: HTMLElement): void {
  row.replaceChildren();
  row.classList.add("manage-form");
  const input = document.createElement("input");
  input.className = "dialog-input";
  input.maxLength = 40;
  input.value = item.name;
  input.setAttribute("aria-label", translate(language, "overlayName"));
  const save = document.createElement("button");
  save.type = "button";
  save.className = "button";
  save.textContent = translate(language, "renameOverlay");
  save.addEventListener("click", () => void renameManagedOverlay(item, input.value));
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "small-button";
  cancel.textContent = translate(language, "dialogClose");
  cancel.addEventListener("click", () => renderOverlayManager());
  row.appendChild(input);
  row.appendChild(save);
  row.appendChild(cancel);
  input.focus();
  input.select();
}

async function createManagedOverlay(rawName: string, status: HTMLElement): Promise<void> {
  const name = rawName.trim();
  if (!name) {
    status.textContent = translate(language, "lookNameInvalid");
    return;
  }
  const response = await fetch("/api/overlays", {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (response.status === 401) {
    window.location.assign("/auth/login?next=%2Fstudio");
    return;
  }
  if (response.status === 409) {
    const result = await response.json() as { error?: string };
    renderOverlayManager(result.error === "overlay-name" ? "overlayNameTaken" : "overlayLimitStatus");
    return;
  }
  if (!response.ok) {
    renderOverlayManager("overlayCreateFailed");
    return;
  }
  const created = await response.json() as OwnedOverlay;
  ownedOverlays = [...ownedOverlays, created];
  await selectOverlay(created);
}

async function renameManagedOverlay(item: OwnedOverlay, rawName: string): Promise<void> {
  const name = rawName.trim();
  if (!name) {
    renderOverlayManager("lookNameInvalid");
    return;
  }
  const response = await fetch(`/api/overlays/${item.id}`, {
    method: "PATCH", credentials: "same-origin", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  if (response.status === 401) {
    window.location.assign("/auth/login?next=%2Fstudio");
    return;
  }
  if (response.status === 409) {
    renderOverlayManager("overlayNameTaken");
    return;
  }
  if (!response.ok) {
    renderOverlayManager("overlayRenameFailed");
    return;
  }
  const updated = await response.json() as OwnedOverlay;
  ownedOverlays = ownedOverlays.map((entry) => entry.id === updated.id ? updated : entry);
  if (overlay?.id === updated.id) {
    overlay = updated;
    updateActiveOverlayLabel();
  }
  renderOverlayManager("overlayRenamed");
}

async function deleteManagedOverlay(item: OwnedOverlay): Promise<void> {
  if (activeDeleteInFlight) return;
  if (ownedOverlays.length <= 1) {
    renderOverlayManager("lastOverlay");
    return;
  }
  if (item.id === overlay?.id && undoInFlight) {
    renderOverlayManager("finishUndoBeforeDelete");
    return;
  }
  if (item.id === overlay?.id && hasPendingSave()) {
    renderOverlayManager("finishSavingBeforeSwitch");
    return;
  }
  const deletingActive = item.id === overlay?.id;
  if (deletingActive) {
    activeDeleteInFlight = true;
    controlsRoot.inert = true;
    updateUndoButtonDisabled();
  }
  try {
    const response = await fetch(`/api/overlays/${item.id}`, {
      method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (response.status === 401) {
      window.location.assign("/auth/login?next=%2Fstudio");
      return;
    }
    if (response.status === 409) {
      renderOverlayManager("lastOverlay");
      return;
    }
    if (!response.ok) {
      renderOverlayManager("overlayDeleteFailed");
      return;
    }
    ownedOverlays = ownedOverlays.filter((entry) => entry.id !== item.id);
    if (overlay?.id === item.id) {
      await selectOverlay(ownedOverlays[0]!);
      return;
    }
    renderOverlayManager("overlayDeleted");
  } catch {
    if (dialog.open) renderOverlayManager("overlayDeleteFailed");
    else showToast("overlayDeleteFailed", true);
  } finally {
    if (deletingActive) {
      activeDeleteInFlight = false;
      controlsRoot.inert = false;
      updateUndoButtonDisabled();
    }
  }
}

async function openMyLooksDialog(opener: HTMLElement): Promise<void> {
  dialogTitle.textContent = translate(language, "myLooks");
  dialogBody.replaceChildren();
  const loading = document.createElement("p");
  loading.textContent = translate(language, "loading");
  dialogBody.appendChild(loading);
  showDialogElement(opener);
  try {
    const response = await fetch("/api/looks/mine", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      window.location.assign("/auth/login?next=%2Fstudio");
      return;
    }
    if (!response.ok) throw new Error("my-looks");
    const result = await response.json() as { looks?: OwnedLook[] };
    renderMyLooks(result.looks ?? []);
  } catch {
    dialogBody.replaceChildren();
    const error = document.createElement("p");
    error.className = "manage-status";
    error.textContent = translate(language, "lookWithdrawFailed");
    dialogBody.appendChild(error);
  }
}

function renderMyLooks(looks: OwnedLook[], noticeKey?: TranslationKey): void {
  dialogBody.replaceChildren();
  const notice = document.createElement("p");
  notice.className = "manage-status";
  if (noticeKey) notice.textContent = translate(language, noticeKey);
  dialogBody.appendChild(notice);
  if (looks.length === 0) {
    const empty = document.createElement("p");
    empty.textContent = translate(language, "noMyLooks");
    dialogBody.appendChild(empty);
    return;
  }
  const list = document.createElement("div");
  list.className = "manage-list";
  list.setAttribute("role", "list");
  for (const look of looks) {
    const row = document.createElement("div");
    row.className = "manage-row";
    row.setAttribute("role", "listitem");
    const description = document.createElement("span");
    description.className = "manage-row-name";
    description.textContent = look.name;
    const meta = document.createElement("span");
    meta.className = "manage-row-meta";
    meta.textContent = look.parent?.removed ? translate(language, "basedOnRemoved")
      : look.parent?.name ? translate(language, "basedOn", { name: look.parent.name, author: look.parent.author ?? "" }) :
        translate(language, "lookByAuthor", { author: look.author });
    description.appendChild(meta);
    const view = document.createElement("a");
    view.className = "small-button";
    view.href = `/t/${encodeURIComponent(look.slug)}`;
    view.textContent = translate(language, look.withdrawn ? "lookWithdrawnTag" : "viewLook");
    if (look.withdrawn) view.removeAttribute("href");
    const actions = document.createElement("span");
    actions.className = "manage-row-actions";
    actions.appendChild(view);
    if (!look.withdrawn) {
      const withdraw = document.createElement("button");
      withdraw.type = "button";
      withdraw.className = "small-button";
      withdraw.textContent = translate(language, "withdrawLook");
      withdraw.addEventListener("click", () => void withdrawOwnedLook(look, looks));
      actions.appendChild(withdraw);
    }
    row.appendChild(description);
    row.appendChild(actions);
    list.appendChild(row);
  }
  dialogBody.appendChild(list);
}

async function withdrawOwnedLook(look: OwnedLook, looks: OwnedLook[]): Promise<void> {
  const response = await fetch(`/api/looks/${encodeURIComponent(look.slug)}/withdraw`, {
    method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
  });
  if (response.status === 401) {
    window.location.assign("/auth/login?next=%2Fstudio");
    return;
  }
  if (!response.ok) {
    renderMyLooks(looks, "lookWithdrawFailed");
    return;
  }
  renderMyLooks(looks.map((item) => item.id === look.id ? { ...item, withdrawn: true } : item), "lookWithdrawn");
}

async function selectOverlay(next: OwnedOverlay): Promise<void> {
  if (next.id === overlay?.id) {
    closeDialog();
    return;
  }
  if (hasPendingSave()) {
    showToast("finishSavingBeforeSwitch", true);
    return;
  }

  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
  counts = { obs: 0, browser: 0, widget: 0, studio: 0 };
  connectedOutputs = 0;
  lastAnnouncedCount = undefined;
  updateClientCount();
  overlay = next;
  channel = next.channel;
  clearUndoOffer();
  updateActiveOverlayLabel();
  revision = 0;
  theme = DEFAULTS;
  if (testTimeout !== undefined) clearTimeout(testTimeout);
  testTimeout = undefined;
  pendingTestId = undefined;
  earlyTestProgress = undefined;
  restoreTestButton();
  try { localStorage.setItem("chatwerk-overlay-id", next.id); } catch { /* Keep this selection for the current page. */ }
  $("#overlay-url").setAttribute("value", `${window.location.origin}/overlay#token=${next.linkToken}`);
  renderThemeControls();
  setStatus("loading");
  errorArea.textContent = "";
  updateTestButton();
  try {
    await loadConfig();
    if (signedOut) {
      window.location.assign("/login?next=%2Fstudio");
      return;
    }
    connectStudioSocket();
    setStatus("savedRevision", { revision });
    updateTestButton();
    closeDialog();
  } catch {
    setStatus("saveFailed");
    errorArea.textContent = translate(language, "overlayLoadFailed");
  }
}

function hasPendingSave(): boolean {
  return inFlight || saveTimer !== undefined || Object.keys(pendingPatch).length > 0;
}

function closeAccountMenu(): void {
  const menu = document.querySelector<HTMLDetailsElement>("#account-menu");
  if (menu) menu.open = false;
}

function showDialogElement(opener: HTMLElement): void {
  activeDialogOpener = opener;
  preview.inert = true;
  closeAccountMenu();
  dialog.showModal();
  $("#dialog-close").focus();
}

function closeDialog(): void {
  if (dialog.open) dialog.close();
}

async function logout(): Promise<void> {
  try {
    const response = await fetch("/auth/logout", { method: "POST", credentials: "same-origin" });
    if (!response.ok) throw new Error("logout");
    window.location.assign("/login");
  } catch {
    showToast("connectionLost", true);
  }
}

async function runTestLine(): Promise<void> {
  if (!overlay || connectedOutputs === 0 || testButton.dataset.pending === "true") return;
  testButton.dataset.pending = "true";
  testButton.disabled = true;
  testButton.textContent = translate(language, "testSending");
  try {
    const response = await fetch(`/api/overlays/${overlay.id}/test-line`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    if (!response.ok) throw new Error("test-line");
    const payload = await response.json() as { id: string };
    pendingTestId = payload.id;
    if (earlyTestProgress?.id === payload.id && earlyTestProgress.total > 0 && earlyTestProgress.shown >= earlyTestProgress.total) {
      finishTest(earlyTestProgress);
    }
    else {
      testTimeout = setTimeout(() => {
        pendingTestId = undefined;
        showToast("testNoAck", true);
        restoreTestButton();
      }, 3_000);
    }
  } catch {
    showToast("testNoAck", true);
    restoreTestButton();
  }
}

function finishTest(progress: { id: string; shown: number; total: number }): void {
  if (pendingTestId !== progress.id) return;
  if (testTimeout !== undefined) clearTimeout(testTimeout);
  pendingTestId = undefined;
  earlyTestProgress = undefined;
  const key = progress.total === 1 ? "testShownOne" : "testShownMany";
  showToast(key, false, { shown: progress.shown, total: progress.total });
  restoreTestButton();
}

function restoreTestButton(): void {
  testButton.dataset.pending = "false";
  testButton.textContent = translate(language, "testInObs");
  updateTestButton();
}

function showToast(key: TranslationKey, error: boolean, values: Record<string, string | number> = {}): void {
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastText.textContent = translate(language, key, values);
  toast.dataset.kind = error ? "error" : "success";
  toast.setAttribute("role", error ? "alert" : "status");
  toast.classList.add("is-visible");
  if (!error) toastTimer = setTimeout(closeToast, 4_000);
}

function closeToast(): void {
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toastTimer = undefined;
  toast.classList.remove("is-visible");
}

function setBackground(value: string): void {
  previewWindow.dataset.background = value;
  if (value !== "mine") previewWindow.style.backgroundImage = "";
  if (value === "dark") previewWindow.style.backgroundColor = "#17181B";
  else if (value === "light") previewWindow.style.backgroundColor = "#ECE9E2";
  else if (value === "checker") previewWindow.style.backgroundColor = "#222428";
  else if (objectUrl) previewWindow.style.backgroundImage = `url("${objectUrl}")`;
}

function setScaleMode(enabled: boolean): void {
  oneToOne = enabled;
  $("#preview-one-to-one").setAttribute("aria-pressed", String(enabled));
  $("#preview-fit").setAttribute("aria-pressed", String(!enabled));
  updatePreviewScale();
}

function updatePreviewScale(): void {
  if (!previewWindow || !previewFrameWrap || !previewScale) return;
  const availableWidth = Math.max(0, previewWindow.clientWidth - 40);
  const availableHeight = Math.max(0, previewWindow.clientHeight - 40);
  const scale = oneToOne ? 1 : Math.max(0.05, Math.min(availableWidth / 1920, availableHeight / 1080));
  previewFrameWrap.style.width = `${1920 * scale}px`;
  previewFrameWrap.style.height = `${1080 * scale}px`;
  preview.style.transform = `scale(${scale})`;
  previewScale.textContent = translate(language, "previewScale", { percent: Math.round(scale * 100) });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hydrateConfig(value: unknown, legacyChannel: string): ThemeConfig {
  const config = isRecord(value) ? value : {};
  const configuredChannels = Array.isArray(config.channels) ? config.channels : [];
  const channels = configuredChannels.length > 0
    ? configuredChannels
    : legacyChannel ? [legacyChannel] : [];
  return validateTheme({ ...config, channels });
}

function safeCount(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : 0;
}

function localStorageValue(key: string): string | undefined {
  try { return localStorage.getItem(key) ?? undefined; } catch { return undefined; }
}
