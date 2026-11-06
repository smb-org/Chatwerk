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
import { featureEnabled } from "../shared/features";
import { currentLanguage, saveLanguage, translate, type Language, type TranslationKey } from "../shared/i18n";
import { applyTranslations } from "./i18n-dom";
import { initialLoadRetryDelayMs } from "./retry";
import { isSettingsFieldEnabled, isSettingsRehearsalEnabled, SETTINGS_TABS, type SettingsTabId } from "./settings-tabs";
import {
  calculatePreviewCanvasGeometry,
  clampPreviewPosition,
  DEFAULT_PREVIEW_SOURCE_SIZE,
  defaultPreviewPosition,
  isValidPreviewPosition,
  isValidPreviewSourceSize,
  movePreviewPositionBy,
  movePreviewPositionFromDrag,
  PREVIEW_CANVAS_HEIGHT,
  PREVIEW_CANVAS_WIDTH,
  resizePreviewSourceSizeFromDrag,
  type PreviewCanvasPosition,
  type PreviewResizeAxis,
  type PreviewSourceSize,
} from "./preview-sizing";

interface StudioOverlay {
  id: string;
  name: string;
  channel: string;
  linkToken: string;
  generation: number;
  role: "owner" | "editor";
  ownerLogin?: string;
  editors?: Array<{ userId: string; login: string; since: string }>;
  invite?: { expiresAt: string } | null;
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

const SETTINGS_TAB_STORAGE_KEY = "chatwerk-studio-settings-tab";
const DEFAULT_SETTINGS_TAB = SETTINGS_TABS[0].id;

function readSettingsTab(): SettingsTabId {
  try {
    const saved = localStorage.getItem(SETTINGS_TAB_STORAGE_KEY);
    return SETTINGS_TABS.some((tab) => tab.id === saved) ? saved as SettingsTabId : DEFAULT_SETTINGS_TAB;
  } catch {
    return DEFAULT_SETTINGS_TAB;
  }
}

const $ = <T = HTMLElement>(selector: string): T => {
  const element = document.querySelector(selector) as unknown as T | null;
  if (!element) throw new Error(`Missing Studio element ${selector}`);
  return element;
};

const preview = $("#studio-preview") as HTMLIFrameElement;
const previewWindow = $("#preview-window") as HTMLElement;
const previewCanvas = $("#preview-canvas") as HTMLElement;
const previewFrameWrap = $("#preview-frame-wrap") as HTMLElement;
const previewScale = $("#preview-scale") as HTMLElement;
const previewPositionMeta = $("#preview-position-meta") as HTMLElement;
const previewMoveControl = $("#preview-move-control") as HTMLButtonElement;
const previewSizeDragLabel = $("#preview-size-drag-label") as HTMLOutputElement;
const previewResizeHandles = [...document.querySelectorAll<HTMLButtonElement>("[data-preview-resize-axis]")];
const previewSizePreset = $("#preview-size-preset") as HTMLSelectElement;
const previewCustomSize = $("#preview-custom-size") as HTMLElement;
const previewCustomWidth = $("#preview-custom-width") as HTMLInputElement;
const previewCustomHeight = $("#preview-custom-height") as HTMLInputElement;
const previewSizeError = $("#preview-size-error") as HTMLElement;
const obsSizeHint = $("#obs-size-hint") as HTMLElement;
const controlsRoot = $("#theme-controls") as HTMLElement;
const settingsTabsRoot = $("#settings-tabs") as HTMLElement;
const settingsScroll = $("#settings-scroll") as HTMLElement;
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
const activeOverlayText = $("#active-overlay-text") as HTMLElement;
const activeOverlaySelect = $("#active-overlay-select") as HTMLSelectElement;
const channelHeaderField = $("#channel-header-field") as HTMLElement;
const channelFieldButton = $("#channel-field-button") as HTMLButtonElement;
const channelFieldText = $("#channel-field-text") as HTMLElement;
const channelFieldCount = $("#channel-field-count") as HTMLElement;
const channelPopover = $("#channel-popover") as HTMLElement;
const liveNoChannelMessage = $("#live-no-channel-message") as HTMLElement;
const liveChatStatus = $("#live-chat-status") as HTMLElement;
const previewModeSample = $("#preview-mode-sample") as HTMLButtonElement;
const previewModeLive = $("#preview-mode-live") as HTMLButtonElement;

let language: Language = currentLanguage();
let selectedSettingsTab: SettingsTabId = readSettingsTab();
let overlay: StudioOverlay | undefined;
let overlays: StudioOverlay[] = [];
let livePreviewEnabled = false;
let liveChatState: "connecting" | "waiting" | "message" | undefined;
let liveChatChannel = "";
let theme: ThemeConfig = DEFAULTS;
let previewSourceSize: PreviewSourceSize = DEFAULT_PREVIEW_SOURCE_SIZE;
let previewPosition: PreviewCanvasPosition = defaultPreviewPosition(DEFAULT_PREVIEW_SOURCE_SIZE);
let lastAppliedPreviewMaxChatHeight: number | undefined;
type ActivePreviewDrag = {
  kind: "resize";
  pointerId: number;
  capture: HTMLElement;
  axis: PreviewResizeAxis;
  startX: number;
  startY: number;
  startSize: PreviewSourceSize;
  startPosition: PreviewCanvasPosition;
  scale: number;
  canvasMode: boolean;
  fixedBottom: number;
  visibleWidth: number;
  visibleHeight: number;
} | {
  kind: "move";
  pointerId: number;
  capture: HTMLElement;
  startX: number;
  startY: number;
  startSize: PreviewSourceSize;
  startPosition: PreviewCanvasPosition;
  scale: number;
};
let activePreviewDrag: ActivePreviewDrag | undefined;
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
let saveSequence = 0;
let activeSave: { id: number; overlayId: string; selectionVersion: number } | undefined;
let activeDeleteInFlight = false;
let undoInFlight = false;
let pendingPatch: Partial<ThemeValues> = {};
let lastEditAt = 0;
let retryStartedAt = 0;
let conflictNotice = false;
let hypeTrainOwnerLogin: string | undefined;
let hypeTrainDisconnecting = false;
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
let expandedHelpersFor: string | undefined;
let accessLossInProgress = false;
let deferredConfigBroadcast: { revision: number; config: unknown } | undefined;
let undoOffer: { snapshotId: string; expectedRevision: number; expiresAt: number; lookName: string } | undefined;
let undoTimer: ReturnType<typeof setTimeout> | undefined;
let linkRevokedRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let linkRevokedRefreshAttempt = 0;
let publishLimitReached = false;
let currentPlatform = "obs";
let lastAnnouncedCount: number | undefined;
let overlaySelectionVersion = 0;
let hypeConsentRequest = 0;

applyFeatureGates();
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
      redirectToLogin();
      return;
    }
    if (!response.ok) throw new Error("overlay-list");
    const result = await response.json() as { overlays?: StudioOverlay[] };
    overlays = result.overlays ?? [];
    const requestedOverlayId = new URLSearchParams(window.location.search).get("overlay");
    const storedOverlayId = localStorageValue("chatwerk-overlay-id");
    overlay = overlays.find((item) => item.id === requestedOverlayId) ??
      overlays.find((item) => item.id === storedOverlayId) ??
      overlays.find((item) => item.name === "Main") ?? overlays[0];
    if (!overlay) {
      if (new URLSearchParams(window.location.search).has("invite")) {
        updateActiveOverlayLabel();
        initializationRetrying = false;
        initializationRetryAttempt = 0;
        setupFirstRun();
        processStudioQuery();
        updateHeaderResponsive();
        return;
      }
      throw new Error("overlay-missing");
    }
    loadPreviewSourceSize(overlay.id);
    try { localStorage.setItem("chatwerk-overlay-id", overlay.id); } catch { /* The server's first overlay remains selected for this page. */ }
    channel = overlay.channel;
    loadPreviewMode(overlay.id);
    updateActiveOverlayLabel();
    updateChannelHeader();
    const link = `${window.location.origin}/overlay#token=${overlay.linkToken}`;
    $("#overlay-url").setAttribute("value", link);
    $("#overlay-url").setAttribute("aria-label", translate(language, "overlayLink"));
    const selectedOverlayId = overlay.id;
    const selectionVersion = overlaySelectionVersion;
    await loadConfig(selectedOverlayId, selectionVersion);
    if (overlay?.id !== selectedOverlayId || overlaySelectionVersion !== selectionVersion) return;
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
    if (featureEnabled("hypeTrain")) void refreshHypeTrainConsent();
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

async function loadConfig(expectedOverlayId?: string, expectedSelectionVersion = overlaySelectionVersion): Promise<void> {
  if (!overlay) return;
  const requestedOverlay = overlay;
  if (expectedOverlayId && requestedOverlay.id !== expectedOverlayId) return;
  const isCurrentRequest = (): boolean => overlay?.id === requestedOverlay.id && overlaySelectionVersion === expectedSelectionVersion;
  const response = await fetch("/api/overlay/config", {
    headers: { Authorization: `Bearer ${requestedOverlay.linkToken}` },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!isCurrentRequest()) return;
  if (response.status === 401) {
    signedOut = true;
    updateWarning();
    return;
  }
  if (!response.ok) throw new Error("config-read");
  const snapshot = await response.json() as ConfigResponse;
  if (!isCurrentRequest()) return;
  theme = hydrateConfig(snapshot.config, snapshot.channel ?? channel);
  revision = snapshot.revision;
  renderThemeControls();
  applyPreviewTheme();
  updateChannelHeader();
  updateWarning();
}

function connectStudioSocket(): void {
  if (!overlay) return;
  const connectedOverlayId = overlay.id;
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
      const incoming = { revision: Number(message.revision), config: message.config };
      if (inFlight) {
        if (saveTimer === undefined && Object.keys(pendingPatch).length === 0 &&
          (!deferredConfigBroadcast || incoming.revision > deferredConfigBroadcast.revision)) {
          deferredConfigBroadcast = incoming;
        }
        return;
      }
      if (saveTimer !== undefined || Object.keys(pendingPatch).length > 0) return;
      applyIncomingConfig(incoming);
    }
    if (message.type === "test-progress" && typeof message.id === "string" &&
      Number.isSafeInteger(message.shown) && Number.isSafeInteger(message.total)) {
      const progress = { id: message.id, shown: Number(message.shown), total: Number(message.total) };
      if (pendingTestId === progress.id && progress.total > 0 && progress.shown >= progress.total) finishTest(progress);
      else earlyTestProgress = progress;
    }
  });
  nextSocket.addEventListener("close", (event) => {
    if (socket !== nextSocket) return;
    socket = undefined;
    if (event.code === 4001 && event.reason === "overlay_deleted") {
      void handleOverlayAccessLost();
      return;
    }
    if (event.code === 4001 && event.reason === "link_revoked") {
      void handleOverlayLinkRevoked(connectedOverlayId);
      return;
    }
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

function applyIncomingConfig(message: { revision: number; config: unknown }): void {
  if (message.revision <= revision) return;
  revision = message.revision;
  const previousChannels = [...theme.channels];
  theme = hydrateConfig(message.config, channel);
  syncControls(previousChannels);
  applyPreviewTheme();
  clearUndoOffer();
  setStatus("savedRevision", { revision });
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
  settingsTabsRoot.replaceChildren();

  for (const tab of SETTINGS_TABS) {
    const tabButton = document.createElement("button");
    tabButton.type = "button";
    tabButton.id = `settings-tab-${tab.id}`;
    tabButton.setAttribute("role", "tab");
    tabButton.setAttribute("aria-controls", `settings-tabpanel-${tab.id}`);
    tabButton.textContent = settingsTabLabel(tab.id);
    tabButton.addEventListener("click", () => selectSettingsTab(tab.id, true));
    tabButton.addEventListener("keydown", (event) => {
      const currentIndex = SETTINGS_TABS.findIndex((item) => item.id === tab.id);
      let nextIndex: number | undefined;
      if (event.key === "ArrowRight") nextIndex = (currentIndex + 1) % SETTINGS_TABS.length;
      else if (event.key === "ArrowLeft") nextIndex = (currentIndex - 1 + SETTINGS_TABS.length) % SETTINGS_TABS.length;
      else if (event.key === "Home") nextIndex = 0;
      else if (event.key === "End") nextIndex = SETTINGS_TABS.length - 1;
      if (nextIndex === undefined) return;
      event.preventDefault();
      selectSettingsTab(SETTINGS_TABS[nextIndex]!.id, true);
    });
    settingsTabsRoot.appendChild(tabButton);

    const panel = document.createElement("section");
    panel.id = `settings-tabpanel-${tab.id}`;
    panel.setAttribute("role", "tabpanel");
    panel.setAttribute("aria-labelledby", tabButton.id);
    panel.dataset.groups = tab.groups.join(",");
    panel.hidden = tab.id !== selectedSettingsTab;

    for (const group of THEME_UI_GROUPS) {
      if (!(tab.groups as readonly ThemeUiGroup[]).includes(group)) continue;
      const fields = Object.entries(THEME_FIELDS).filter(([name, definition]) =>
        definition.ui.group === group && isSettingsFieldEnabled(name))
        .sort((left, right) => left[1].ui.order - right[1].ui.order);
      if (fields.length === 0) continue;

      const groupRoot = document.createElement("fieldset");
      groupRoot.className = "settings-group";
      groupRoot.dataset.group = group;
      if (tab.id === "appearance") {
        const legend = document.createElement("legend");
        legend.textContent = translate(language, groupKey(group));
        groupRoot.appendChild(legend);
      }
      for (const [rawName, rawDefinition] of fields) {
        const name = rawName as ThemeFieldName;
        const definition = rawDefinition as ThemeFieldDefinition;
        const control = makeThemeControl(name, definition);
        if (definition.ui.control === "list" || name === "reactionHypeTrain") control.dataset.span = "full";
        groupRoot.appendChild(control);
      }
      panel.appendChild(groupRoot);
    }
    controlsRoot.appendChild(panel);
  }
  updateSettingsTabState();
  syncControlAvailability();
  if (featureEnabled("hypeTrain")) void refreshHypeTrainConsent();
}

function applyFeatureGates(): void {
  for (const button of document.querySelectorAll<HTMLButtonElement>(".scenario-button")) {
    const scenario = button.id === "rehearse-hype-train" ? "hype-train" : button.dataset.scenario;
    if (scenario && !isSettingsRehearsalEnabled(scenario)) button.remove();
  }
}

function settingsTabLabel(id: SettingsTabId): string {
  if (id === "appearance") return translate(language, "settingsAppearance");
  const tab = SETTINGS_TABS.find((item) => item.id === id)!;
  return translate(language, groupKey(tab.groups[0]!));
}

function selectSettingsTab(id: SettingsTabId, focusTab = false): void {
  selectedSettingsTab = id;
  updateSettingsTabState();
  settingsScroll.scrollTop = 0;
  try { localStorage.setItem(SETTINGS_TAB_STORAGE_KEY, id); } catch { /* Tab choice is still kept in memory. */ }
  if (focusTab) settingsTabsRoot.querySelector<HTMLButtonElement>(`#settings-tab-${id}`)?.focus();
}

function updateSettingsTabState(): void {
  for (const tab of SETTINGS_TABS) {
    const selected = tab.id === selectedSettingsTab;
    const button = settingsTabsRoot.querySelector<HTMLButtonElement>(`#settings-tab-${tab.id}`);
    if (button) {
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    }
    const panel = controlsRoot.querySelector<HTMLElement>(`#settings-tabpanel-${tab.id}`);
    if (panel) panel.hidden = !selected;
  }
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
    if (name === "backlog") {
      const hint = document.createElement("p");
      hint.className = "control-hint";
      hint.textContent = translate(language, "backlogStackOnlyHint");
      control.appendChild(hint);
    }
    if (name === "reactionHypeTrain") appendHypeTrainConsent(control);
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

function appendHypeTrainConsent(control: HTMLElement): void {
  const box = document.createElement("div");
  box.className = "hype-consent";
  box.id = "hype-train-consent";
  box.dataset.state = "loading";
  const status = document.createElement("p");
  status.className = "hype-consent-status";
  status.setAttribute("role", "status");
  status.textContent = translate(language, "hypeTrainLoading");
  const copy = document.createElement("p");
  copy.className = "hype-consent-copy";
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-button hype-consent-action";
  button.hidden = true;
  box.appendChild(status);
  box.appendChild(copy);
  box.appendChild(button);
  control.appendChild(box);
}

function translateHypeTrainConsent(): void {
  const box = document.querySelector<HTMLElement>("#hype-train-consent");
  const status = box?.querySelector<HTMLElement>(".hype-consent-status");
  const copy = box?.querySelector<HTMLElement>(".hype-consent-copy");
  const button = box?.querySelector<HTMLButtonElement>(".hype-consent-action");
  if (!box || !status || !copy || !button) return;
  copy.textContent = "";
  button.hidden = true;
  const state = box.dataset.state;
  const foreignChannel = Boolean(hypeTrainOwnerLogin) && state !== "loading" && state !== "unavailable" &&
    !currentChannels().some((value) => value.trim().toLowerCase() === hypeTrainOwnerLogin);
  if (foreignChannel) {
    status.textContent = translate(language, box.dataset.role === "editor" ? "hypeTrainForeignHelper" : "hypeTrainForeignOwner");
  } else if (state === "connected") {
    status.textContent = translate(language, "hypeTrainConnected");
  } else if (state === "disconnected") {
    status.textContent = translate(language, "hypeTrainNotConnected");
  } else if (state === "helper") {
    status.textContent = translate(language, "hypeTrainHelper");
  } else if (state === "loading") {
    status.textContent = translate(language, "hypeTrainLoading");
  } else {
    status.textContent = translate(language, "hypeTrainStatusUnavailable");
  }
  if (state === "connected") {
    button.hidden = false;
    button.textContent = translate(language, "hypeTrainDisconnect");
    button.disabled = hypeTrainDisconnecting;
    if (overlay) button.onclick = () => void disconnectHypeTrain(overlay!.id, button);
  } else if (state === "disconnected") {
    copy.textContent = translate(language, "hypeTrainPermissionExplanation");
    button.hidden = false;
    button.textContent = translate(language, "hypeTrainConnect");
    button.disabled = hypeTrainDisconnecting || foreignChannel;
    if (overlay) button.onclick = () => window.location.assign(`/auth/hype-train?overlayId=${encodeURIComponent(overlay!.id)}`);
  }
}

async function refreshHypeTrainConsent(): Promise<void> {
  if (!featureEnabled("hypeTrain")) return;
  const box = document.querySelector<HTMLElement>("#hype-train-consent");
  if (!box) return;
  const status = box.querySelector<HTMLElement>(".hype-consent-status");
  const copy = box.querySelector<HTMLElement>(".hype-consent-copy");
  const button = box.querySelector<HTMLButtonElement>(".hype-consent-action");
  if (!status || !copy || !button) return;
  const requestId = ++hypeConsentRequest;
  const selectedOverlay = overlay;
  const selectionVersion = overlaySelectionVersion;
  hypeTrainOwnerLogin = undefined;
  box.dataset.role = "";
  box.dataset.state = "loading";
  if (!selectedOverlay) {
    box.dataset.state = "unavailable";
    syncControlAvailability();
    return;
  }
  copy.textContent = "";
  button.hidden = true;
  button.disabled = false;
  syncControlAvailability();
  try {
    const response = await fetch(`/api/hype-train?overlayId=${encodeURIComponent(selectedOverlay.id)}`, {
      credentials: "same-origin", cache: "no-store",
    });
    if (requestId !== hypeConsentRequest || overlay?.id !== selectedOverlay.id || selectionVersion !== overlaySelectionVersion) return;
    if (!response.ok) throw new Error("hype-status");
    const result = await response.json() as { role?: unknown; connected?: unknown; ownerLogin?: unknown };
    if ((result.role !== "owner" && result.role !== "editor") || typeof result.connected !== "boolean" ||
      typeof result.ownerLogin !== "string" || !/^[a-z0-9_]{1,25}$/iu.test(result.ownerLogin)) throw new Error("hype-status");
    hypeTrainOwnerLogin = result.ownerLogin.toLowerCase();
    box.dataset.role = result.role;
    if (result.role === "editor") {
      box.dataset.state = "helper";
    } else if (result.connected) {
      box.dataset.state = "connected";
    } else {
      box.dataset.state = "disconnected";
    }
    syncControlAvailability();
  } catch {
    if (requestId !== hypeConsentRequest || overlay?.id !== selectedOverlay.id) return;
    hypeTrainOwnerLogin = undefined;
    box.dataset.role = "";
    box.dataset.state = "unavailable";
    copy.textContent = "";
    button.hidden = true;
    syncControlAvailability();
  }
}

async function disconnectHypeTrain(overlayId: string, button: HTMLButtonElement): Promise<void> {
  if (hypeTrainDisconnecting) return;
  hypeTrainDisconnecting = true;
  button.disabled = true;
  try {
    const response = await fetch("/api/hype-train/disconnect", {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overlayId }),
    });
    if (!response.ok) throw new Error("hype-disconnect");
    await refreshHypeTrainConsent();
    showToast("hypeTrainDisconnected", false);
  } catch {
    showToast("hypeTrainDisconnectFailed", true);
  } finally {
    hypeTrainDisconnecting = false;
    updateHypeTrainAvailability();
  }
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
  updateChannelHeader();
  return true;
}

function updateChannelHeader(): void {
  const channels = currentChannels();
  const first = channels[0];
  channelFieldButton.dataset.empty = String(!first);
  channelFieldText.textContent = first
    ? translate(language, "headerChannel", { channel: first })
    : translate(language, "noChannelSet");
  const remaining = Math.max(0, channels.length - 1);
  channelFieldCount.hidden = remaining === 0;
  channelFieldCount.textContent = remaining > 0 ? translate(language, "moreChannels", { count: remaining }) : "";
  const accessibleValue = first ? translate(language, "headerChannel", { channel: first }) : translate(language, "noChannelSet");
  const accessibleCount = remaining > 0 ? `, ${translate(language, "moreChannels", { count: remaining })}` : "";
  channelFieldButton.setAttribute("aria-label", `${accessibleValue}${accessibleCount}. ${translate(language, "channelFieldLabel")}`);
  liveNoChannelMessage.hidden = !livePreviewEnabled || channels.length > 0;
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
  if (group === "Emotes & Effects") return "groupEmotesEffects";
  return `group${group}` as TranslationKey;
}

function fieldKey(name: ThemeFieldName): TranslationKey {
  return `field${name[0]!.toUpperCase()}${name.slice(1)}` as TranslationKey;
}

function formattedRange(name: ThemeFieldName, value: number, unit: string): string {
  if (name === "maxChatHeight" && value === 0) return translate(language, "fullHeight");
  if (unit === "ratio") return translate(language, "rangeValue", { value: Math.round(value * 100), unit: translate(language, "percentUnit") });
  if (unit === "ms") return translate(language, "rangeValue", { value: Math.round(value / 1_000), unit: translate(language, "secondsUnit") });
  if (unit === "lines") return translate(language, "rangeValue", { value, unit: translate(language, "linesUnit") });
  if (unit === "px") return translate(language, "rangeValue", { value, unit: translate(language, "pixelsUnit") });
  if (unit === "px/s") return translate(language, "rangeValue", { value, unit: translate(language, "pixelsPerSecondUnit") });
  if (name === "fontWeight") return String(value);
  return String(value);
}

function setThemeField<K extends ThemeFieldName>(name: K, value: ThemeValues[K]): boolean {
  if (activeDeleteInFlight) return false;
  if (name === "reactionHypeTrain" && !isHypeTrainOwnChannel()) return false;
  try {
    theme = validateTheme({ ...theme, [name]: value });
  } catch {
    return false;
  }
  syncControlAvailability();
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
  const savedOverlay = overlay;
  const selectionVersion = overlaySelectionVersion;
  const save = { id: ++saveSequence, overlayId: savedOverlay.id, selectionVersion };
  activeSave = save;
  const isCurrentSave = (): boolean => activeSave?.id === save.id && overlay?.id === save.overlayId &&
    overlaySelectionVersion === save.selectionVersion;
  inFlight = true;
  try {
    const response = await fetch(`/api/overlays/${savedOverlay.id}/config`, {
      method: "PUT",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ baseRevision, patch }),
    });
    if (!isCurrentSave()) return;
    if (response.status === 401) {
      pendingPatch = {};
      signedOut = true;
      errorArea.textContent = translate(language, "warningSignedOut");
      updateWarning();
      return;
    }
    if (response.status === 404) {
      pendingPatch = {};
      await handleOverlayAccessLost();
      return;
    }
    if (response.status === 409) {
      await recoverConflict(patch, savedOverlay, isCurrentSave);
      return;
    }
    if (!response.ok) throw new Error(`save-${response.status}`);
    const saved = await response.json() as { revision: number; config: unknown };
    if (!isCurrentSave()) return;
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
    if (!isCurrentSave()) return;
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
    if (isCurrentSave()) {
      activeSave = undefined;
      inFlight = false;
      const deferred = deferredConfigBroadcast;
      deferredConfigBroadcast = undefined;
      if (deferred && saveTimer === undefined && Object.keys(pendingPatch).length === 0) applyIncomingConfig(deferred);
      if (Object.keys(pendingPatch).length > 0 && retryTimer === undefined && saveTimer === undefined) {
        scheduleSave(Math.max(0, 200 - (Date.now() - lastEditAt)));
      }
    }
  }
}

async function recoverConflict(
  sentPatch: Partial<ThemeValues>,
  savedOverlay: StudioOverlay,
  isCurrentSave: () => boolean,
): Promise<void> {
  if (!isCurrentSave()) return;
  pendingPatch = { ...sentPatch, ...pendingPatch };
  const response = await fetch("/api/overlay/config", {
    headers: { Authorization: `Bearer ${savedOverlay.linkToken}` },
    credentials: "same-origin",
    cache: "no-store",
  });
  if (!isCurrentSave()) return;
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
    if (hex && typeof value === "string" && document.activeElement !== hex) hex.value = value.toUpperCase();
    const select = document.querySelector(`select#theme-${name}`) as HTMLSelectElement | null;
    if (select) select.value = String(value);
    document.querySelectorAll<HTMLInputElement>(`input[name="theme-${name}"]`).forEach((radio) => {
      radio.checked = radio.value === String(value);
      radio.tabIndex = radio.checked ? 0 : -1;
    });
    const list = document.querySelector<HTMLTextAreaElement>(`textarea[data-list-field="${name}"]`);
    if (list && Array.isArray(value) && document.activeElement !== list) list.value = value.join("\n");
  }
  if (!sameChannels(previousChannels, theme.channels)) refreshChannelsEditor();
  updateChannelHeader();
  syncControlAvailability();
}

function syncControlAvailability(): void {
  const disabledFields: Array<[ThemeFieldName, boolean]> = [
    ["lifetime", theme.neverFade && theme.layout !== "ticker"],
    ["neverFade", theme.layout === "ticker"],
    ["maxLines", theme.layout === "ticker"],
    ["maxChatHeight", theme.layout === "ticker"],
    ["nameOnOwnLine", theme.layout === "ticker"],
    ["panelBackgroundColor", !theme.panelEnabled],
    ["panelBackgroundOpacity", !theme.panelEnabled],
    ["panelBorderWidth", !theme.panelEnabled],
    ["panelBorderColor", !theme.panelEnabled],
    ["panelRadius", !theme.panelEnabled],
    ["panelPadding", !theme.panelEnabled],
  ];
  for (const [name, disabled] of disabledFields) {
    const control = controlsRoot.querySelector<HTMLElement>(`[data-theme-field="${name}"]`);
    control?.querySelectorAll("input, select, textarea").forEach((element) => {
      (element as HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement).disabled = disabled;
    });
    if (control) control.dataset.disabled = String(disabled);
  }
  updateHypeTrainAvailability();
}

function isHypeTrainOwnChannel(): boolean {
  return !hypeTrainOwnerLogin || currentChannels().some((value) => value.trim().toLowerCase() === hypeTrainOwnerLogin);
}

function updateHypeTrainAvailability(): void {
  if (!featureEnabled("hypeTrain")) return;
  const ownChannel = isHypeTrainOwnChannel();
  const control = controlsRoot.querySelector<HTMLElement>('[data-theme-field="reactionHypeTrain"]');
  const checkbox = control?.querySelector<HTMLInputElement>("#theme-reactionHypeTrain");
  if (checkbox) checkbox.disabled = !ownChannel;
  if (control) control.dataset.disabled = String(!ownChannel);
  const rehearsal = document.querySelector<HTMLButtonElement>("#rehearse-hype-train");
  if (rehearsal) rehearsal.disabled = livePreviewEnabled || !ownChannel;
  translateHypeTrainConsent();
}

function refreshChannelsEditor(): void {
  const current = document.querySelector<HTMLElement>('[data-theme-field="channels"]');
  if (!current) return;
  const active = document.activeElement;
  const focusKey = active instanceof HTMLElement && current.contains(active) ? active.dataset.channelFocus : undefined;
  const focusedValue = active instanceof HTMLInputElement && focusKey?.startsWith("channel-") ? active.value : undefined;
  const focusedChannelIndex = focusKey?.startsWith("channel-") ? Number(focusKey.slice("channel-".length)) : -1;
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
    if (focusedValue !== undefined && nextFocus instanceof HTMLInputElement) {
      nextFocus.value = focusedValue;
      if (focusedValue.trim() !== theme.channels[focusedChannelIndex]) {
        nextFocus.addEventListener("blur", () => nextFocus?.dispatchEvent(new Event("change", { bubbles: true })), { once: true });
      }
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
  if (!activePreviewDrag) {
    if (theme.layout === "stack" && theme.maxChatHeight >= 100) {
      if (theme.maxChatHeight !== lastAppliedPreviewMaxChatHeight) {
        lastAppliedPreviewMaxChatHeight = theme.maxChatHeight;
        if (previewSourceSize.height !== theme.maxChatHeight) {
          if (isPreviewCanvasMode()) {
            previewPosition = clampPreviewPosition({
              x: previewPosition.x,
              y: previewPosition.y + previewSourceSize.height - theme.maxChatHeight,
            }, { ...previewSourceSize, height: theme.maxChatHeight });
          }
          applyPreviewSourceSize({ ...previewSourceSize, height: theme.maxChatHeight }, true);
        }
      }
    } else {
      lastAppliedPreviewMaxChatHeight = undefined;
    }
  }
  preview.contentWindow?.postMessage({ type: "chatwerk:studio-theme", theme }, "*");
  if (livePreviewEnabled) {
    postPreviewMessage({ type: "chatwerk:studio-live", enabled: true, channels: currentChannels() });
  }
  updateChannelHeader();
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
  updateActiveOverlayLabel();
  updateChannelHeader();
  updatePreviewModeUi();
  translateHypeTrainConsent();
  if (initializationRetrying) {
    setStatus("couldNotLoadRetrying");
    errorArea.textContent = translate(language, "couldNotLoadRetrying");
  } else if (overlay) {
    setStatus(conflictNotice ? "saveConflict" : inFlight || Object.keys(pendingPatch).length ? "saving" : "savedRevision", { revision });
  }
  updateWarning();
  updateTestButton();
  updateSourceSizeHint();
  renderThemeControls();
  if (channelPopover.querySelector('[data-theme-field="channels"]')) refreshChannelsEditor();
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
  if (overlay && overlays.length > 1) activeOverlayText.textContent = `${activeOverlayPrefixText()} `;
  updateSourceSizeHint();
}

function activeOverlayPrefixText(): string {
  const narrowDesktop = window.innerWidth >= 1024 && window.innerWidth <= 1279;
  return translate(language, narrowDesktop ? "activeOverlayCompactPrefix" : "activeOverlayPrefix");
}

function openChannelPopover(): void {
  if (!channelPopover.querySelector('[data-theme-field="channels"]')) {
    channelPopover.replaceChildren(makeChannelsEditor("channels", translate(language, "fieldChannels")));
  }
  channelPopover.hidden = false;
  channelFieldButton.setAttribute("aria-expanded", "true");
  positionChannelPopover();
  channelPopover.querySelector<HTMLInputElement>("[data-channel-new]")?.focus();
}

function positionChannelPopover(): void {
  if (window.innerWidth > 1023) {
    channelPopover.style.removeProperty("position");
    channelPopover.style.removeProperty("top");
    channelPopover.style.removeProperty("left");
    channelPopover.style.removeProperty("right");
    channelPopover.style.removeProperty("width");
    return;
  }
  const field = channelFieldButton.getBoundingClientRect();
  const width = Math.min(320, window.innerWidth - 24);
  const left = Math.max(12, Math.min(field.left, window.innerWidth - width - 12));
  channelPopover.style.position = "fixed";
  channelPopover.style.top = `${field.bottom + 8}px`;
  channelPopover.style.left = `${left}px`;
  channelPopover.style.right = "auto";
  channelPopover.style.width = `${width}px`;
}

function closeChannelPopover(returnFocus: boolean): void {
  channelPopover.hidden = true;
  channelFieldButton.setAttribute("aria-expanded", "false");
  if (returnFocus) channelFieldButton.focus();
}

function loadPreviewMode(overlayId: string): void {
  livePreviewEnabled = localStorageValue(`chatwerk-live-mode:${overlayId}`) === "1";
  updatePreviewModeUi();
}

function setPreviewMode(enabled: boolean): void {
  if (livePreviewEnabled === enabled) return;
  livePreviewEnabled = enabled;
  updatePreviewModeUi();
  if (overlay) {
    try { localStorage.setItem(`chatwerk-live-mode:${overlay.id}`, enabled ? "1" : "0"); }
    catch { /* Live mode remains selected for this page. */ }
  }
  liveChatState = enabled ? "connecting" : undefined;
  liveChatChannel = channel;
  updateLiveChatStatus();
  postPreviewMessage({ type: "chatwerk:studio-live", enabled, channels: currentChannels(), channel });
  if (!enabled) $("#rehearse-quiet").setAttribute("aria-pressed", "true");
}

function updatePreviewModeUi(): void {
  previewModeSample.setAttribute("aria-pressed", String(!livePreviewEnabled));
  previewModeLive.setAttribute("aria-pressed", String(livePreviewEnabled));
  document.querySelectorAll<HTMLButtonElement>(".scenario-button").forEach((button) => {
    button.disabled = livePreviewEnabled;
  });
  updateHypeTrainAvailability();
  liveNoChannelMessage.hidden = !livePreviewEnabled || currentChannels().length > 0;
  updateLiveChatStatus();
}

function updateLiveChatStatus(): void {
  if (!livePreviewEnabled || currentChannels().length === 0 || !liveChatState || liveChatState === "message") {
    liveChatStatus.hidden = true;
    liveChatStatus.textContent = "";
    return;
  }
  liveChatStatus.hidden = false;
  liveChatStatus.textContent = liveChatState === "connecting"
    ? translate(language, "livePreviewConnecting")
    : translate(language, "livePreviewWaiting", { channel: liveChatChannel || channel });
}

function wireStaticControls(): void {
  window.addEventListener("message", (event: MessageEvent<unknown>) => {
    if (event.source !== preview.contentWindow || !isRecord(event.data) || event.data.type !== "chatwerk:studio-chat-state") return;
    if (event.data.state !== "connecting" && event.data.state !== "waiting" && event.data.state !== "message") return;
    liveChatState = event.data.state;
    liveChatChannel = typeof event.data.channel === "string" ? event.data.channel : channel;
    updateLiveChatStatus();
  });
  preview.addEventListener("load", () => {
    applyPreviewTheme();
    if (!livePreviewEnabled) postPreviewMessage({ type: "chatwerk:studio-scenario", scenario: "quiet" });
    updatePreviewScale();
  });
  const resizeObserver = new ResizeObserver(updatePreviewScale);
  resizeObserver.observe(previewWindow);
  previewResizeHandles.forEach(wirePreviewResizeHandle);
  previewFrameWrap.addEventListener("pointerdown", (event) => {
    const target = event.target;
    if (target instanceof Element) {
      const handle = target.closest<HTMLButtonElement>("[data-preview-resize-axis]");
      const axis = handle?.dataset.previewResizeAxis;
      if (handle && (axis === "width" || axis === "height" || axis === "both")) {
        beginPreviewResize(event, handle, axis);
        return;
      }
    }
    beginPreviewMove(event);
  });
  previewFrameWrap.addEventListener("pointermove", updatePreviewDrag);
  previewFrameWrap.addEventListener("pointerup", finishPreviewDrag);
  previewFrameWrap.addEventListener("pointercancel", cancelPreviewDrag);
  previewMoveControl.addEventListener("keydown", movePreviewFromKeyboard);
  previewMoveControl.addEventListener("click", (event) => event.preventDefault());
  window.addEventListener("resize", () => {
    updateHeaderResponsive();
    if (!channelPopover.hidden) positionChannelPopover();
  });

  channelFieldButton.addEventListener("click", () => {
    if (channelPopover.hidden) openChannelPopover();
    else closeChannelPopover(true);
  });
  document.addEventListener("pointerdown", (event) => {
    if (channelPopover.hidden || !(event.target instanceof Node) || channelHeaderField.contains(event.target)) return;
    closeChannelPopover(false);
    window.setTimeout(() => {
      if (channelPopover.hidden) channelFieldButton.focus();
    }, 0);
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || channelPopover.hidden) return;
    event.preventDefault();
    closeChannelPopover(true);
  });
  activeOverlaySelect.addEventListener("change", () => {
    const next = overlays.find((item) => item.id === activeOverlaySelect.value);
    if (next) void selectOverlay(next).finally(updateActiveOverlayLabel);
  });

  previewSizePreset.addEventListener("change", () => {
    previewSizeError.hidden = true;
    if (previewSizePreset.value === "custom") {
      previewCustomWidth.value = String(previewSourceSize.width);
      previewCustomHeight.value = String(previewSourceSize.height);
      previewCustomSize.hidden = false;
      previewCustomWidth.focus();
      return;
    }
    previewCustomSize.hidden = true;
    const [width, height] = previewSizePreset.value.split("x").map(Number);
    applyPreviewSourceSize({ width: width!, height: height! }, true);
  });
  $("#preview-custom-apply").addEventListener("click", () => {
    const candidate = { width: previewCustomWidth.valueAsNumber, height: previewCustomHeight.valueAsNumber };
    if (!previewCustomWidth.checkValidity() || !previewCustomHeight.checkValidity() || !isValidPreviewSourceSize(candidate)) {
      previewSizeError.hidden = false;
      return;
    }
    applyPreviewSourceSize(candidate, true);
    previewSizeError.hidden = true;
  });

  $("#copy-link").addEventListener("click", () => void copyOverlayLink());
  $("#language-en").addEventListener("click", () => setLanguage("en"));
  $("#language-de").addEventListener("click", () => setLanguage("de"));
  $("#open-looks").addEventListener("click", () => void openMyLooksDialog($("#open-looks")));
  $("#share-look").addEventListener("click", () => void openPublishDialog($("#share-look")));
  $("#open-overlays").addEventListener("click", () => void openOverlaysDialog($("#open-overlays")));
  $("#logout").addEventListener("click", () => void logout());
  $("#first-run-done").addEventListener("click", finishFirstRun);
  document.querySelectorAll<HTMLButtonElement>("[data-platform]").forEach((button) => {
    button.addEventListener("click", () => {
      currentPlatform = button.dataset.platform ?? "obs";
      document.querySelectorAll<HTMLButtonElement>("[data-platform]").forEach((item) => {
        item.setAttribute("aria-pressed", String(item === button));
      });
      try { localStorage.setItem("chatwerk-output-platform", currentPlatform); } catch { /* Selection stays in memory. */ }
      updateFirstRunSetupLink();
    });
  });
  document.querySelectorAll<HTMLButtonElement>(".scenario-button").forEach((button) => {
    button.addEventListener("click", () => {
      if (livePreviewEnabled || document.querySelector<HTMLInputElement>("#live-chat")?.checked) return;
      if (button.id === "rehearse-hype-train") {
        document.querySelectorAll<HTMLButtonElement>(".scenario-button").forEach((item) => {
          item.setAttribute("aria-pressed", String(item === button));
        });
        try { postPreviewMessage({ type: "chatwerk:studio-hype-train-scenario" }); }
        catch { showToast("scenarioFailed", true); }
        return;
      }
      const scenario = button.dataset.scenario ?? (button.id === "rehearse-flood" ? "flood"
        : button.id === "rehearse-raid" ? "raid" : "quiet");
      document.querySelectorAll<HTMLButtonElement>(".scenario-button").forEach((item) => {
        item.setAttribute("aria-pressed", String(item === button));
      });
      try { postPreviewMessage({ type: "chatwerk:studio-scenario", scenario }); }
      catch { showToast("scenarioFailed", true); }
    });
  });
  previewModeSample.addEventListener("click", () => setPreviewMode(false));
  previewModeLive.addEventListener("click", () => setPreviewMode(true));
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
  let firstRunDone = false;
  try {
    currentPlatform = localStorage.getItem("chatwerk-output-platform") ?? "obs";
    firstRunDone = localStorage.getItem("chatwerk-first-run-done") === "1";
  } catch {
    currentPlatform = "obs";
  }
  updateFirstRunSetupLink();
  if (firstRunDone) return;
  const button = document.querySelector<HTMLButtonElement>(`[data-platform="${currentPlatform}"]`);
  document.querySelectorAll<HTMLButtonElement>("[data-platform]").forEach((item) => {
    item.setAttribute("aria-pressed", String(item === button));
  });
  selectSettingsTab("appearance");
  $("#first-run").classList.add("is-visible");
  $("#rehearse-tools").setAttribute("hidden", "true");
}

function updateFirstRunSetupLink(): void {
  const link = document.querySelector<HTMLAnchorElement>("#first-run-setup");
  if (link) link.href = `/studio/export?platform=${currentPlatform}`;
}

function finishFirstRun(): void {
  try { localStorage.setItem("chatwerk-first-run-done", "1"); } catch { /* The footer still changes for this page. */ }
  $("#first-run").classList.remove("is-visible");
  $("#rehearse-tools").removeAttribute("hidden");
}

function updateActiveOverlayLabel(): void {
  activeOverlaySelect.replaceChildren();
  activeOverlayName.hidden = !overlay;
  if (!overlay) {
    activeOverlayText.textContent = "";
    activeOverlaySelect.hidden = true;
    return;
  }
  if (overlays.length > 1) {
    activeOverlayText.textContent = `${activeOverlayPrefixText()} `;
    for (const item of overlays) {
      const option = document.createElement("option");
      option.value = item.id;
      option.textContent = item.role === "editor"
        ? translate(language, "sharedOverlayOption", { name: item.name, owner: item.ownerLogin ?? "" })
        : item.name;
      option.selected = item.id === overlay.id;
      activeOverlaySelect.appendChild(option);
    }
    activeOverlaySelect.hidden = false;
  } else {
    activeOverlayText.textContent = overlay.role === "editor"
      ? translate(language, "activeSharedOverlayName", { name: overlay.name, owner: overlay.ownerLogin ?? "" })
      : translate(language, "activeOverlayName", { name: overlay.name });
    activeOverlaySelect.hidden = true;
  }
  updateChannelHeader();
}

function processStudioQuery(): void {
  const params = new URLSearchParams(window.location.search);
  const inviteToken = params.get("invite");
  const snapshotId = params.get("undo");
  const expectedRevision = Number(params.get("rev"));
  const expiresAt = Number(params.get("until"));
  const lookName = params.get("lookName") ?? "";
  const shouldPublish = params.get("publish") === "1";
  const handlesHypeTrain = featureEnabled("reactions") && featureEnabled("hypeTrain");
  const hypeTrainStatus = handlesHypeTrain ? params.get("hypeTrain") : null;
  if (snapshotId && /^[0-9a-f-]{36}$/iu.test(snapshotId) && Number.isSafeInteger(expectedRevision) &&
    expectedRevision === revision && Number.isSafeInteger(expiresAt) && expiresAt > Date.now()) {
    showUndoOffer(snapshotId, expectedRevision, expiresAt, lookName);
  }
  const handledQueryKeys = ["undo", "rev", "until", "look", "lookName", "overlay", "publish", "invite"];
  if (handlesHypeTrain) handledQueryKeys.push("hypeTrain");
  if (handledQueryKeys.some((key) => params.has(key))) {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  }
  const statusKeys: Partial<Record<string, TranslationKey>> = {
    connected: "hypeTrainConnectSuccess", denied: "hypeTrainDenied", "scope-missing": "hypeTrainScopeMissing",
    "user-mismatch": "hypeTrainUserMismatch", failed: "hypeTrainConnectFailed", error: "hypeTrainConnectFailed",
    "session-expired": "hypeTrainSessionExpired",
  };
  const statusKey = hypeTrainStatus ? statusKeys[hypeTrainStatus] : undefined;
  if (statusKey) {
    selectSettingsTab("reactions");
    showToast(statusKey, hypeTrainStatus !== "connected");
  }
  if (shouldPublish) void openPublishDialog($("#share-look"));
  if (inviteToken !== null) openInviteDialog(inviteToken);
}

function redirectToLogin(nextPath?: string): void {
  const next = nextPath ?? `${window.location.pathname}${window.location.search}${window.location.hash}`;
  window.location.assign(`/login?next=${encodeURIComponent(next)}`);
}

function openInviteDialog(token: string): void {
  dialogTitle.textContent = translate(language, "acceptInviteTitle");
  dialogBody.replaceChildren();
  const status = document.createElement("p");
  status.className = "manage-status";
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  status.textContent = /^[A-Za-z0-9_-]{43}$/u.test(token)
    ? translate(language, "acceptInvitePrompt")
    : translate(language, "inviteInvalid");
  dialogBody.appendChild(status);
  const actions = document.createElement("div");
  actions.className = "invite-actions";
  const accept = document.createElement("button");
  accept.type = "button";
  accept.className = "button button-primary";
  accept.textContent = translate(language, "acceptInvite");
  accept.disabled = !/^[A-Za-z0-9_-]{43}$/u.test(token);
  accept.addEventListener("click", () => void acceptOverlayInvite(token, status, accept));
  const decline = document.createElement("button");
  decline.type = "button";
  decline.className = "button button-quiet";
  decline.textContent = translate(language, "declineInvite");
  decline.addEventListener("click", closeDialog);
  actions.appendChild(accept);
  actions.appendChild(decline);
  dialogBody.appendChild(actions);
  showDialogElement($("#open-overlays"), true);
  accept.focus();
}

async function acceptOverlayInvite(token: string, status: HTMLElement, button: HTMLButtonElement): Promise<void> {
  button.disabled = true;
  try {
    const response = await fetch(`/api/invites/${token}/accept`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (response.status === 410) {
      status.textContent = translate(language, "inviteInvalid");
      return;
    }
    if (response.status === 409) {
      status.textContent = translate(language, "inviteHelperLimit");
      return;
    }
    if (response.status === 400) {
      status.textContent = translate(language, "inviteOwnOverlay");
      return;
    }
    if (response.status === 401) {
      redirectToLogin(`/studio?invite=${encodeURIComponent(token)}`);
      return;
    }
    if (!response.ok) throw new Error("invite-accept");
    const result = await response.json() as { overlay: StudioOverlay };
    const listResponse = await fetch("/api/overlays", { credentials: "same-origin", cache: "no-store" });
    if (!listResponse.ok) throw new Error("overlay-list");
    const list = await listResponse.json() as { overlays?: StudioOverlay[] };
    overlays = list.overlays ?? [];
    const accepted = overlays.find((item) => item.id === result.overlay.id);
    if (!accepted) throw new Error("accepted-overlay-missing");
    await selectOverlay(accepted);
    setStatus("inviteAccepted", { name: accepted.name, owner: accepted.ownerLogin ?? "" }, true);
  } catch {
    status.textContent = translate(language, "inviteActionFailed");
    button.disabled = false;
  }
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
    if (response.status === 404) {
      await handleOverlayAccessLost();
      return;
    }
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
    if (response.status === 404 && overlay) {
      await handleOverlayAccessLost();
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

async function openOverlaysDialog(opener: HTMLElement): Promise<void> {
  dialogTitle.textContent = translate(language, "overlays");
  dialogBody.replaceChildren();
  const loading = document.createElement("p");
  loading.className = "manage-status";
  loading.textContent = translate(language, "loading");
  dialogBody.appendChild(loading);
  showDialogElement(opener);
  try {
    await reloadAccessibleOverlays();
    if (!dialog.open) showDialogElement(opener);
    renderOverlayManager();
  } catch {
    if (!dialog.open) showDialogElement(opener);
    renderOverlayManager("inviteActionFailed");
  }
}

function renderOverlayManager(noticeKey?: TranslationKey, removedOverlayId?: string): void {
  const focusedKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset.managerFocus : undefined;
  dialogBody.replaceChildren();
  const statusLine = document.createElement("div");
  statusLine.className = "manage-status-line";
  statusLine.tabIndex = -1;
  const status = document.createElement("p");
  status.className = "manage-status";
  if (noticeKey) status.textContent = translate(language, noticeKey);
  statusLine.appendChild(status);
  if (noticeKey === "helperRemoved" && removedOverlayId) {
    const item = overlays.find((entry) => entry.id === removedOverlayId);
    if (item?.role === "owner") {
      const newLink = document.createElement("button");
      newLink.type = "button";
      newLink.className = "small-button";
      newLink.textContent = translate(language, "newLink");
      newLink.dataset.managerFocus = `new-link:${item.id}`;
      newLink.addEventListener("click", () => void regenerateManagedLink(item));
      statusLine.appendChild(newLink);
    }
  }
  dialogBody.appendChild(statusLine);

  const own = overlays.filter((item) => item.role === "owner");
  const shared = overlays.filter((item) => item.role === "editor");
  dialogBody.appendChild(makeOverlaySection("yourOverlays", own));
  dialogBody.appendChild(makeOverlaySection("sharedWithYou", shared));

  const atLimit = own.length >= 3;
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
  const restoreFocus = focusedKey
    ? [...dialogBody.querySelectorAll<HTMLElement>("[data-manager-focus]")].find((element) => element.dataset.managerFocus === focusedKey)
    : undefined;
  (restoreFocus ?? statusLine).focus();
}

function makeOverlaySection(titleKey: TranslationKey, items: StudioOverlay[]): HTMLElement {
  const section = document.createElement("section");
  section.className = "overlay-manager-section";
  const title = document.createElement("h3");
  title.className = "overlay-manager-title";
  title.textContent = translate(language, titleKey);
  section.appendChild(title);
  const list = document.createElement("div");
  list.className = "manage-list";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", title.textContent);
  if (items.length === 0) {
    const empty = document.createElement("p");
    empty.className = "manage-empty";
    empty.textContent = translate(language, titleKey === "sharedWithYou" ? "noSharedOverlays" : "noOverlays");
    list.appendChild(empty);
  }
  for (const item of items) list.appendChild(makeOverlayRow(item));
  section.appendChild(list);
  return section;
}

function makeOverlayRow(item: StudioOverlay): HTMLElement {
  const itemRoot = document.createElement("div");
  itemRoot.className = "overlay-manager-item";
  const row = document.createElement("div");
  row.className = "manage-row";
  const select = document.createElement("button");
  select.type = "button";
  select.className = "manage-row-select";
  select.setAttribute("aria-pressed", String(item.id === overlay?.id));
  const name = document.createElement("span");
  name.className = "manage-row-name";
  name.textContent = item.name;
  const meta = document.createElement("span");
  meta.className = "manage-row-meta";
  meta.textContent = item.role === "editor"
    ? translate(language, "sharedBy", { owner: item.ownerLogin ?? "" })
    : item.channel ? `#${item.channel}` : "—";
  select.appendChild(name);
  select.appendChild(meta);
  select.addEventListener("click", () => void selectOverlay(item));
  const actions = document.createElement("span");
  actions.className = "manage-row-actions";
  if (item.role === "owner") {
    const rename = makeManageButton("renameOverlay", () => beginOverlayRename(item, row), `rename:${item.id}`);
    const remove = makeManageButton("deleteOverlay", () => void deleteManagedOverlay(item), `delete:${item.id}`);
    remove.disabled = overlays.filter((entry) => entry.role === "owner").length <= 1;
    remove.setAttribute("aria-label", `${translate(language, "deleteOverlay")} ${item.name}`);
    const helpers = makeManageButton("helpers", () => {
      expandedHelpersFor = expandedHelpersFor === item.id ? undefined : item.id;
      renderOverlayManager();
    }, `helpers:${item.id}`);
    helpers.setAttribute("aria-expanded", String(expandedHelpersFor === item.id));
    const newLink = makeManageButton("newLink", () => void regenerateManagedLink(item), `new-link:${item.id}`);
    actions.appendChild(rename);
    actions.appendChild(remove);
    actions.appendChild(helpers);
    actions.appendChild(newLink);
  } else {
    const leave = makeManageButton("leaveOverlay", () => void leaveSharedOverlay(item), `leave:${item.id}`);
    actions.appendChild(leave);
  }
  row.appendChild(select);
  row.appendChild(actions);
  itemRoot.appendChild(row);
  if (item.role === "owner" && expandedHelpersFor === item.id) itemRoot.appendChild(makeHelpersPanel(item));
  return itemRoot;
}

function makeManageButton(key: TranslationKey, action: () => void, focusKey?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "small-button";
  button.textContent = translate(language, key);
  if (focusKey) button.dataset.managerFocus = focusKey;
  button.addEventListener("click", action);
  return button;
}

function makeHelpersPanel(item: StudioOverlay): HTMLElement {
  const panel = document.createElement("div");
  panel.className = "helper-panel";
  const helpers = item.editors ?? [];
  if (helpers.length === 0) {
    const empty = document.createElement("p");
    empty.className = "manage-empty";
    empty.textContent = translate(language, "noHelpers");
    panel.appendChild(empty);
  }
  for (const helper of helpers) {
    const row = document.createElement("div");
    row.className = "helper-list-row";
    const identity = document.createElement("span");
    identity.className = "helper-identity";
    const login = document.createElement("strong");
    login.textContent = helper.login;
    const hint = document.createElement("small");
    hint.textContent = translate(language, "lastLoginNameHint");
    identity.appendChild(login);
    identity.appendChild(hint);
    const remove = makeManageButton("removeHelper", () => void removeOverlayHelper(item, helper.userId), `remove-helper:${item.id}:${helper.userId}`);
    remove.setAttribute("aria-label", `${translate(language, "removeHelper")} ${helper.login}`);
    row.appendChild(identity);
    row.appendChild(remove);
    panel.appendChild(row);
  }

  const invite = document.createElement("div");
  invite.className = "helper-invite-row";
  const inviteUrl = item.invite ? storedInviteUrl(item.id) : undefined;
  if (item.invite && inviteUrl) {
    const input = document.createElement("input");
    input.className = "dialog-input invite-link-input";
    input.type = "text";
    input.readOnly = true;
    input.value = inviteUrl;
    input.setAttribute("aria-label", translate(language, "inviteLinkLabel"));
    const copy = makeManageButton("copyInviteLink", () => {
      void copyText(inviteUrl).then(() => renderOverlayManager("inviteCopied"));
    }, `copy-invite:${item.id}`);
    copy.classList.add("button", "invite-copy");
    const revoke = makeManageButton("revokeInviteLink", () => void revokeManagedInvite(item), `revoke-invite:${item.id}`);
    revoke.classList.add("invite-revoke");
    const expiry = makeExpiryText(item.invite.expiresAt);
    invite.appendChild(input);
    invite.appendChild(copy);
    invite.appendChild(expiry);
    invite.appendChild(revoke);
  } else {
    const create = makeManageButton(item.invite ? "replaceInviteLink" : "createInviteLink", () => void createManagedInvite(item), `create-invite:${item.id}`);
    create.classList.add("button", "button-primary", "invite-create");
    invite.appendChild(create);
    if (item.invite) invite.appendChild(makeExpiryText(item.invite.expiresAt));
    if (item.invite) {
      const revoke = makeManageButton("revokeInviteLink", () => void revokeManagedInvite(item), `revoke-invite:${item.id}`);
      revoke.classList.add("invite-revoke");
      invite.appendChild(revoke);
    }
  }
  panel.appendChild(invite);
  return panel;
}

function makeExpiryText(value: string): HTMLElement {
  const text = document.createElement("p");
  text.className = "invite-expiry";
  const locale = language === "de" ? "de-DE" : "en-US";
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
  text.textContent = translate(language, "inviteValidUntil", { date });
  return text;
}

function storedInviteUrl(overlayId: string): string | undefined {
  const value = localStorageValue(`chatwerk-invite-url:${overlayId}`);
  if (!value) return undefined;
  try { return new URL(value).origin === window.location.origin ? value : undefined; }
  catch { return undefined; }
}

async function reloadAccessibleOverlays(): Promise<void> {
  const response = await fetch("/api/overlays", { credentials: "same-origin", cache: "no-store" });
  if (response.status === 401) {
    redirectToLogin();
    throw new Error("session-expired");
  }
  if (!response.ok) throw new Error("overlay-list");
  const result = await response.json() as { overlays?: StudioOverlay[] };
  overlays = result.overlays ?? [];
  if (overlay) {
    const current = overlays.find((item) => item.id === overlay?.id);
    if (!current) {
      await handleOverlayAccessLost();
      return;
    }
    overlay = current;
  }
  updateActiveOverlayLabel();
}

async function handleOverlayAccessLost(): Promise<void> {
  if (accessLossInProgress) return;
  cancelPreviewDrag();
  accessLossInProgress = true;
  overlaySelectionVersion += 1;
  activeSave = undefined;
  if (linkRevokedRefreshTimer !== undefined) clearTimeout(linkRevokedRefreshTimer);
  linkRevokedRefreshTimer = undefined;
  linkRevokedRefreshAttempt = 0;
  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  if (saveTimer !== undefined) clearTimeout(saveTimer);
  saveTimer = undefined;
  if (retryTimer !== undefined) clearTimeout(retryTimer);
  retryTimer = undefined;
  if (testTimeout !== undefined) clearTimeout(testTimeout);
  testTimeout = undefined;
  pendingPatch = {};
  deferredConfigBroadcast = undefined;
  inFlight = false;
  undoInFlight = false;
  pendingTestId = undefined;
  earlyTestProgress = undefined;
  const staleSocket = socket;
  socket = undefined;
  staleSocket?.close();
  try {
    const response = await fetch("/api/overlays", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    if (!response.ok) throw new Error("overlay-list");
    const result = await response.json() as { overlays?: StudioOverlay[] };
    overlays = result.overlays ?? [];
    const next = overlays[0];
    if (!next) {
      overlay = undefined;
      updateActiveOverlayLabel();
      setStatus("overlayAccessLostNoAvailable", {}, true);
      return;
    }
    await selectOverlay(next);
    setStatus("overlayAccessLost", { name: next.name }, true);
  } catch {
    setStatus("overlayAccessLostNoAvailable", {}, true);
  } finally {
    accessLossInProgress = false;
  }
}

async function handleOverlayLinkRevoked(overlayId: string): Promise<void> {
  if (!overlay || overlay.id !== overlayId) return;
  try {
    const response = await fetch("/api/overlays", { credentials: "same-origin", cache: "no-store" });
    if (response.status === 401) {
      redirectToLogin();
      return;
    }
    if (!response.ok) throw new Error("overlay-list");
    const result = await response.json() as { overlays?: StudioOverlay[] };
    overlays = result.overlays ?? [];
    linkRevokedRefreshAttempt = 0;
    const refreshed = overlays.find((item) => item.id === overlayId);
    if (!refreshed) {
      await handleOverlayAccessLost();
      return;
    }
    if (overlay?.id !== overlayId) return;
    overlay = refreshed;
    channel = refreshed.channel;
    updateActiveOverlayLabel();
    $("#overlay-url").setAttribute("value", `${window.location.origin}/overlay#token=${refreshed.linkToken}`);
    connectStudioSocket();
    setStatus("savedRevision", { revision }, true);
  } catch {
    setStatus("connectionLost", {}, true);
    if (overlay?.id === overlayId && linkRevokedRefreshAttempt < 5) {
      const delay = Math.min(30_000, 1_000 * 2 ** linkRevokedRefreshAttempt);
      linkRevokedRefreshAttempt += 1;
      linkRevokedRefreshTimer = setTimeout(() => {
        linkRevokedRefreshTimer = undefined;
        void handleOverlayLinkRevoked(overlayId);
      }, delay);
    }
  }
}

async function createManagedInvite(item: StudioOverlay): Promise<void> {
  try {
    const response = await fetch(`/api/overlays/${item.id}/invite`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (response.status === 401) { redirectToLogin(); return; }
    if (response.status === 404) { await handleOverlayAccessLost(); return; }
    if (!response.ok) throw new Error("invite-create");
    const result = await response.json() as { inviteUrl: string; expiresAt: string };
    const inviteUrl = new URL(result.inviteUrl, window.location.origin);
    inviteUrl.protocol = window.location.protocol;
    inviteUrl.host = window.location.host;
    const shareableUrl = inviteUrl.toString();
    try { localStorage.setItem(`chatwerk-invite-url:${item.id}`, shareableUrl); }
    catch { /* The link remains visible in this manager render. */ }
    overlays = overlays.map((entry) => entry.id === item.id ? { ...entry, invite: { expiresAt: result.expiresAt } } : entry);
    expandedHelpersFor = item.id;
    renderOverlayManager("inviteCreated");
  } catch {
    renderOverlayManager("inviteActionFailed");
  }
}

async function revokeManagedInvite(item: StudioOverlay): Promise<void> {
  try {
    const response = await fetch(`/api/overlays/${item.id}/invite`, {
      method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (response.status === 401) { redirectToLogin(); return; }
    if (response.status === 404) { await handleOverlayAccessLost(); return; }
    if (!response.ok) throw new Error("invite-revoke");
    try { localStorage.removeItem(`chatwerk-invite-url:${item.id}`); } catch { /* The server has revoked the link. */ }
    overlays = overlays.map((entry) => entry.id === item.id ? { ...entry, invite: null } : entry);
    expandedHelpersFor = item.id;
    renderOverlayManager("inviteRevoked");
  } catch {
    renderOverlayManager("inviteActionFailed");
  }
}

async function removeOverlayHelper(item: StudioOverlay, userId: string): Promise<void> {
  try {
    const response = await fetch(`/api/overlays/${item.id}/editors/${encodeURIComponent(userId)}`, {
      method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (response.status === 401) { redirectToLogin(); return; }
    if (response.status === 404) { await handleOverlayAccessLost(); return; }
    if (!response.ok) throw new Error("helper-remove");
    await reloadAccessibleOverlays();
    expandedHelpersFor = item.id;
    renderOverlayManager("helperRemoved", item.id);
  } catch {
    renderOverlayManager("inviteActionFailed");
  }
}

async function leaveSharedOverlay(item: StudioOverlay): Promise<void> {
  try {
    const response = await fetch(`/api/overlays/${item.id}/editors/me`, {
      method: "DELETE", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (response.status === 401) { redirectToLogin(); return; }
    if (response.status === 404) { await handleOverlayAccessLost(); return; }
    if (!response.ok) throw new Error("overlay-leave");
    overlays = overlays.filter((entry) => entry.id !== item.id);
    if (overlay?.id === item.id) {
      const next = overlays[0];
      if (next) {
        await selectOverlay(next);
        setStatus("overlayLeft", {}, true);
      }
      return;
    }
    renderOverlayManager("overlayLeft");
  } catch {
    renderOverlayManager("inviteActionFailed");
  }
}

async function regenerateManagedLink(item: StudioOverlay): Promise<void> {
  if (!window.confirm(translate(language, "newLinkConfirm"))) return;
  try {
    const response = await fetch(`/api/overlays/${item.id}/rotate-link`, {
      method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: "{}",
    });
    if (response.status === 401) { redirectToLogin(); return; }
    if (response.status === 404) { await handleOverlayAccessLost(); return; }
    if (!response.ok) throw new Error("overlay-link-rotate");
    const result = await response.json() as { linkToken: string; generation: number };
    const updated = { ...item, linkToken: result.linkToken, generation: result.generation };
    overlays = overlays.map((entry) => entry.id === item.id ? updated : entry);
    if (overlay?.id === item.id) {
      overlay = updated;
      $("#overlay-url").setAttribute("value", `${window.location.origin}/overlay#token=${updated.linkToken}`);
    }
    renderOverlayManager("linkRegenerated");
  } catch {
    renderOverlayManager("linkRegenerateFailed");
  }
}

function beginOverlayRename(item: StudioOverlay, row: HTMLElement): void {
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
  const created = await response.json() as StudioOverlay;
  overlays = [...overlays, created];
  await selectOverlay(created);
}

async function renameManagedOverlay(item: StudioOverlay, rawName: string): Promise<void> {
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
  const updated = await response.json() as StudioOverlay;
  overlays = overlays.map((entry) => entry.id === updated.id ? updated : entry);
  if (overlay?.id === updated.id) {
    overlay = updated;
  }
  updateActiveOverlayLabel();
  renderOverlayManager("overlayRenamed");
}

async function deleteManagedOverlay(item: StudioOverlay): Promise<void> {
  if (activeDeleteInFlight) return;
  if (overlays.filter((entry) => entry.role === "owner").length <= 1) {
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
    overlays = overlays.filter((entry) => entry.id !== item.id);
    updateActiveOverlayLabel();
    if (overlay?.id === item.id) {
      const next = overlays[0];
      if (next) await selectOverlay(next);
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

async function selectOverlay(next: StudioOverlay): Promise<void> {
  if (next.id === overlay?.id) {
    closeDialog();
    return;
  }
  if (hasPendingSave()) {
    showToast("finishSavingBeforeSwitch", true);
    updateActiveOverlayLabel();
    return;
  }

  const selectionVersion = ++overlaySelectionVersion;
  deferredConfigBroadcast = undefined;
  if (linkRevokedRefreshTimer !== undefined) clearTimeout(linkRevokedRefreshTimer);
  linkRevokedRefreshTimer = undefined;
  linkRevokedRefreshAttempt = 0;

  if (!channelPopover.hidden) closeChannelPopover(false);
  channelPopover.replaceChildren();

  if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
  reconnectTimer = undefined;
  const previousSocket = socket;
  socket = undefined;
  previousSocket?.close();
  counts = { obs: 0, browser: 0, widget: 0, studio: 0 };
  connectedOutputs = 0;
  lastAnnouncedCount = undefined;
  updateClientCount();
  const wasLive = livePreviewEnabled;
  overlay = next;
  loadPreviewSourceSize(next.id);
  channel = next.channel;
  clearUndoOffer();
  revision = 0;
  theme = DEFAULTS;
  lastAppliedPreviewMaxChatHeight = undefined;
  loadPreviewMode(next.id);
  if (wasLive) {
    postPreviewMessage({ type: "chatwerk:studio-live", enabled: false, channels: [], channel: "" });
  }
  updateActiveOverlayLabel();
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
    await loadConfig(next.id, selectionVersion);
    if (selectionVersion !== overlaySelectionVersion || overlay?.id !== next.id) return;
    if (signedOut) {
      window.location.assign("/login?next=%2Fstudio");
      return;
    }
    connectStudioSocket();
    setStatus("savedRevision", { revision });
    updateTestButton();
    closeDialog();
  } catch {
    if (selectionVersion !== overlaySelectionVersion || overlay?.id !== next.id) return;
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

function showDialogElement(opener: HTMLElement, hideFooter = false): void {
  activeDialogOpener = opener;
  preview.inert = true;
  closeAccountMenu();
  const footer = $("#dialog-close").parentElement as HTMLElement;
  footer.hidden = hideFooter;
  $("#dialog-x").toggleAttribute("hidden", hideFooter);
  dialog.showModal();
  if (hideFooter) dialogBody.querySelector<HTMLButtonElement>("button")?.focus();
  else $("#dialog-close").focus();
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
    if (response.status === 404) {
      await handleOverlayAccessLost();
      return;
    }
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
  cancelPreviewDrag();
  previewWindow.dataset.background = value;
  if (value !== "mine") previewWindow.style.backgroundImage = "";
  if (value === "dark") previewWindow.style.backgroundColor = "#17181B";
  else if (value === "light") previewWindow.style.backgroundColor = "#ECE9E2";
  else if (value === "checker") previewWindow.style.backgroundColor = "#222428";
  else if (objectUrl) previewWindow.style.backgroundImage = `url("${objectUrl}")`;
  updatePreviewScale();
}

function setScaleMode(enabled: boolean): void {
  cancelPreviewDrag();
  oneToOne = enabled;
  $("#preview-one-to-one").setAttribute("aria-pressed", String(enabled));
  $("#preview-fit").setAttribute("aria-pressed", String(!enabled));
  updatePreviewScale();
}

function isPreviewCanvasMode(): boolean {
  return previewWindow.dataset.background === "mine" && Boolean(objectUrl) && !oneToOne;
}

function getPreviewCanvasGeometry(): ReturnType<typeof calculatePreviewCanvasGeometry> {
  const style = getComputedStyle(previewWindow);
  return calculatePreviewCanvasGeometry(previewWindow.clientWidth, previewWindow.clientHeight, {
    top: Number.parseFloat(style.paddingTop) || 0,
    right: Number.parseFloat(style.paddingRight) || 0,
    bottom: Number.parseFloat(style.paddingBottom) || 0,
    left: Number.parseFloat(style.paddingLeft) || 0,
  });
}

function updatePreviewScale(): void {
  if (!previewWindow || !previewFrameWrap || !previewScale || activePreviewDrag) return;
  const canvasMode = isPreviewCanvasMode();
  const stageStyle = getComputedStyle(previewWindow);
  const horizontalPadding = (Number.parseFloat(stageStyle.paddingLeft) || 0) + (Number.parseFloat(stageStyle.paddingRight) || 0);
  const verticalPadding = (Number.parseFloat(stageStyle.paddingTop) || 0) + (Number.parseFloat(stageStyle.paddingBottom) || 0);
  const availableWidth = Math.max(0, previewWindow.clientWidth - horizontalPadding);
  const availableHeight = Math.max(0, previewWindow.clientHeight - verticalPadding);
  const scale = canvasMode
    ? getPreviewCanvasGeometry().scale
    : oneToOne ? 1 : Math.max(0.05, Math.min(
      1,
      availableWidth / previewSourceSize.width,
      availableHeight / previewSourceSize.height,
    ));
  setPreviewFrameGeometry(scale);
  previewScale.textContent = translate(language, "previewScale", { percent: Math.round(scale * 100) });
  updatePreviewPositionReadout();
}

function setPreviewFrameGeometry(scale: number): void {
  const canvasMode = isPreviewCanvasMode();
  const image = objectUrl ? `url("${objectUrl}")` : "";
  previewWindow.dataset.canvasMode = String(canvasMode);
  previewCanvas.hidden = !canvasMode;
  previewMoveControl.hidden = !canvasMode;
  previewFrameWrap.dataset.movable = String(canvasMode);
  previewFrameWrap.dataset.moving = String(activePreviewDrag?.kind === "move");
  previewCanvas.style.backgroundImage = image;
  previewWindow.style.backgroundImage = canvasMode ? "" : previewWindow.dataset.background === "mine" ? image : "";
  preview.width = String(previewSourceSize.width);
  preview.height = String(previewSourceSize.height);
  preview.style.width = `${previewSourceSize.width}px`;
  preview.style.height = `${previewSourceSize.height}px`;
  previewFrameWrap.style.width = `${previewSourceSize.width * scale}px`;
  previewFrameWrap.style.height = `${previewSourceSize.height * scale}px`;
  preview.style.transform = `scale(${scale})`;
  if (canvasMode) {
    const geometry = getPreviewCanvasGeometry();
    let canvasLeft = geometry.left;
    let canvasTop = geometry.top;
    if (!activePreviewDrag) {
      previewCanvas.style.left = `${geometry.left}px`;
      previewCanvas.style.top = `${geometry.top}px`;
      previewCanvas.style.width = `${geometry.width}px`;
      previewCanvas.style.height = `${geometry.height}px`;
    } else {
      const frozenLeft = Number.parseFloat(previewCanvas.style.left);
      const frozenTop = Number.parseFloat(previewCanvas.style.top);
      if (Number.isFinite(frozenLeft)) canvasLeft = frozenLeft;
      if (Number.isFinite(frozenTop)) canvasTop = frozenTop;
    }
    previewFrameWrap.style.position = "absolute";
    previewFrameWrap.style.left = `${canvasLeft + previewPosition.x * scale}px`;
    previewFrameWrap.style.top = `${canvasTop + previewPosition.y * scale}px`;
  } else if (!activePreviewDrag) {
    const stageStyle = getComputedStyle(previewWindow);
    const paddingLeft = Number.parseFloat(stageStyle.paddingLeft) || 0;
    const paddingRight = Number.parseFloat(stageStyle.paddingRight) || 0;
    const paddingTop = Number.parseFloat(stageStyle.paddingTop) || 0;
    const paddingBottom = Number.parseFloat(stageStyle.paddingBottom) || 0;
    const availableWidth = Math.max(0, previewWindow.clientWidth - paddingLeft - paddingRight);
    const availableHeight = Math.max(0, previewWindow.clientHeight - paddingTop - paddingBottom);
    const frameWidth = previewSourceSize.width * scale;
    const frameHeight = previewSourceSize.height * scale;
    previewFrameWrap.style.position = "";
    previewFrameWrap.style.left = availableWidth < frameWidth ? `${(availableWidth - frameWidth) / 2}px` : "";
    previewFrameWrap.style.top = availableHeight < frameHeight ? `${(availableHeight - frameHeight) / 2}px` : "";
  }
}

function updatePreviewPositionReadout(): void {
  previewPositionMeta.hidden = !isPreviewCanvasMode();
  previewPositionMeta.textContent = `X ${previewPosition.x}  Y ${previewPosition.y}  ${previewSourceSize.width} x ${previewSourceSize.height}`;
}

function wirePreviewResizeHandle(handle: HTMLButtonElement): void {
  const axis = handle.dataset.previewResizeAxis;
  if (axis === "width" || axis === "height" || axis === "both") {
    handle.addEventListener("keydown", (event) => resizePreviewFromKeyboard(event, axis));
  }
}

function currentPreviewScale(): number {
  return Number.parseFloat(preview.style.transform.match(/scale\(([\d.]+)\)/u)?.[1] ?? "1");
}

function beginPreviewResize(event: PointerEvent, handle: HTMLButtonElement, axis: PreviewResizeAxis): void {
  if (activePreviewDrag || (event.pointerType === "mouse" && event.button !== 0)) return;
  event.preventDefault();
  previewPositionMeta.setAttribute("aria-live", "off");
  const frame = previewFrameWrap.getBoundingClientRect();
  const stage = previewWindow.getBoundingClientRect();
  const stageStyle = getComputedStyle(previewWindow);
  const borderLeft = Number.parseFloat(stageStyle.borderLeftWidth) || 0;
  const borderRight = Number.parseFloat(stageStyle.borderRightWidth) || 0;
  const borderTop = Number.parseFloat(stageStyle.borderTopWidth) || 0;
  const paddingTop = Number.parseFloat(stageStyle.paddingTop) || 0;
  const paddingRight = Number.parseFloat(stageStyle.paddingRight) || 0;
  const scale = currentPreviewScale();
  const canvasMode = isPreviewCanvasMode();
  const fixedBottom = canvasMode
    ? Math.min(previewPosition.y + previewSourceSize.height, PREVIEW_CANVAS_HEIGHT)
    : frame.bottom - stage.top - borderTop;
  activePreviewDrag = {
    kind: "resize",
    pointerId: event.pointerId,
    capture: handle,
    axis,
    startX: event.clientX,
    startY: event.clientY,
    startSize: { ...previewSourceSize },
    startPosition: { ...previewPosition },
    scale,
    canvasMode,
    fixedBottom,
    visibleWidth: canvasMode
      ? Math.max(previewSourceSize.width, Math.max(100, PREVIEW_CANVAS_WIDTH - previewPosition.x))
      : Math.max(100, (stage.right - borderRight - paddingRight - frame.left - 7) / scale),
    visibleHeight: canvasMode
      ? Math.max(100, Math.min(fixedBottom, PREVIEW_CANVAS_HEIGHT))
      : Math.max(100, (frame.bottom - stage.top - borderTop - paddingTop - 7) / scale),
  };
  previewFrameWrap.style.position = "absolute";
  previewFrameWrap.style.left = `${frame.left - stage.left - borderLeft}px`;
  previewFrameWrap.style.top = `${frame.top - stage.top - borderTop}px`;
  previewSizeDragLabel.hidden = false;
  previewSizeDragLabel.value = `${previewSourceSize.width} × ${previewSourceSize.height}`;
  handle.setPointerCapture(event.pointerId);
}

function beginPreviewMove(event: PointerEvent): void {
  if (!isPreviewCanvasMode() || activePreviewDrag || (event.pointerType === "mouse" && event.button !== 0)) return;
  if (event.target === previewMoveControl) previewMoveControl.focus();
  event.preventDefault();
  previewPositionMeta.setAttribute("aria-live", "off");
  activePreviewDrag = {
    kind: "move",
    pointerId: event.pointerId,
    capture: previewFrameWrap,
    startX: event.clientX,
    startY: event.clientY,
    startSize: { ...previewSourceSize },
    startPosition: { ...previewPosition },
    scale: currentPreviewScale(),
  };
  previewFrameWrap.dataset.moving = "true";
  previewFrameWrap.setPointerCapture(event.pointerId);
}

function updatePreviewDrag(event: PointerEvent): void {
  const drag = activePreviewDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  if (drag.kind === "move") {
    previewPosition = movePreviewPositionFromDrag(
      drag.startPosition,
      drag.startSize,
      event.clientX - drag.startX,
      event.clientY - drag.startY,
      drag.scale,
    );
    setPreviewFrameGeometry(drag.scale);
    updatePreviewPositionReadout();
    return;
  }
  const size = resizePreviewSourceSizeFromDrag(
    drag.startSize,
    event.clientX - drag.startX,
    event.clientY - drag.startY,
    drag.scale,
    drag.visibleWidth,
    drag.visibleHeight,
    drag.axis,
  );
  applyPreviewSourceSize(size, false, false);
  if (drag.canvasMode) {
    previewPosition = clampPreviewPosition({
      x: drag.startPosition.x,
      y: drag.axis === "height" || drag.axis === "both" ? drag.fixedBottom - size.height : drag.startPosition.y,
    }, size);
  }
  setPreviewFrameGeometry(drag.scale);
  if (!drag.canvasMode && (drag.axis === "height" || drag.axis === "both")) {
    previewFrameWrap.style.top = `${drag.fixedBottom - size.height * drag.scale}px`;
  }
  previewSizeDragLabel.value = `${size.width} × ${size.height}`;
  updatePreviewPositionReadout();
}

function finishPreviewDrag(event: PointerEvent): void {
  const drag = activePreviewDrag;
  if (!drag || drag.pointerId !== event.pointerId) return;
  activePreviewDrag = undefined;
  if (drag.capture.hasPointerCapture(drag.pointerId)) drag.capture.releasePointerCapture(drag.pointerId);
  previewFrameWrap.dataset.moving = "false";
  previewPositionMeta.setAttribute("aria-live", "polite");
  if (drag.kind === "move") {
    savePreviewPosition();
    updatePreviewScale();
    return;
  }
  previewFrameWrap.style.position = "";
  previewFrameWrap.style.left = "";
  previewFrameWrap.style.top = "";
  previewSizeDragLabel.hidden = true;
  applyPreviewSourceSize(previewSourceSize, true);
  if (previewSourceSize.height !== drag.startSize.height) savePreviewHeightToTheme(previewSourceSize.height);
}

function resizePreviewFromKeyboard(event: KeyboardEvent, axis: PreviewResizeAxis): void {
  if (activePreviewDrag) return;
  const step = event.shiftKey ? 50 : 10;
  const previousHeight = previewSourceSize.height;
  const next = { ...previewSourceSize };
  const canvasMode = isPreviewCanvasMode();
  const canvasWidthLimit = Math.max(100, Math.floor((PREVIEW_CANVAS_WIDTH - previewPosition.x) / 10) * 10);
  const maxWidth = canvasMode ? Math.max(previewSourceSize.width, canvasWidthLimit) : 3840;
  const fixedBottom = Math.min(previewPosition.y + previewSourceSize.height, PREVIEW_CANVAS_HEIGHT);
  const maxHeight = canvasMode ? Math.max(100, Math.floor(fixedBottom / 10) * 10) : 2160;
  if ((axis === "width" || axis === "both") && event.key === "ArrowRight") next.width = Math.min(maxWidth, next.width + step);
  else if ((axis === "width" || axis === "both") && event.key === "ArrowLeft") next.width = Math.max(100, next.width - step);
  else if ((axis === "height" || axis === "both") && event.key === "ArrowUp") next.height += step;
  else if ((axis === "height" || axis === "both") && event.key === "ArrowDown") next.height -= step;
  else return;
  event.preventDefault();
  if ((axis === "height" || axis === "both") && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
    next.height = Math.min(maxHeight, Math.max(100, Math.round(next.height / 10) * 10));
    if (canvasMode) previewPosition = clampPreviewPosition({ x: previewPosition.x, y: fixedBottom - next.height }, next);
  }
  applyPreviewSourceSize(next, true);
  if (next.height !== previousHeight) savePreviewHeightToTheme(next.height);
}

function movePreviewFromKeyboard(event: KeyboardEvent): void {
  if (!isPreviewCanvasMode() || activePreviewDrag) return;
  const step = event.shiftKey ? 50 : 10;
  const movement = event.key === "ArrowLeft" ? { x: -step, y: 0 }
    : event.key === "ArrowRight" ? { x: step, y: 0 }
      : event.key === "ArrowUp" ? { x: 0, y: -step }
        : event.key === "ArrowDown" ? { x: 0, y: step }
          : undefined;
  if (!movement) return;
  event.preventDefault();
  previewPosition = movePreviewPositionBy(previewPosition, previewSourceSize, movement.x, movement.y);
  updatePreviewScale();
  savePreviewPosition();
}

function loadPreviewSourceSize(overlayId: string): void {
  cancelPreviewDrag();
  try {
    const stored = localStorage.getItem(`chatwerk-source-size:${overlayId}`);
    const parsed: unknown = stored ? JSON.parse(stored) as unknown : DEFAULT_PREVIEW_SOURCE_SIZE;
    previewSourceSize = isValidPreviewSourceSize(parsed) ? parsed : DEFAULT_PREVIEW_SOURCE_SIZE;
  } catch {
    previewSourceSize = DEFAULT_PREVIEW_SOURCE_SIZE;
  }
  previewPosition = loadPreviewPosition(overlayId, previewSourceSize);
  previewSizeError.hidden = true;
  updatePreviewSizeControl();
  updateSourceSizeHint();
  updatePreviewScale();
}

function loadPreviewPosition(overlayId: string, size: PreviewSourceSize): PreviewCanvasPosition {
  try {
    const stored = localStorage.getItem(`chatwerk-preview-position:${overlayId}`);
    const parsed: unknown = stored ? JSON.parse(stored) as unknown : undefined;
    return isValidPreviewPosition(parsed) ? clampPreviewPosition(parsed, size) : defaultPreviewPosition(size);
  } catch {
    return defaultPreviewPosition(size);
  }
}

function savePreviewPosition(): void {
  if (!overlay) return;
  try { localStorage.setItem(`chatwerk-preview-position:${overlay.id}`, JSON.stringify(previewPosition)); }
  catch { /* Canvas placement is a local Studio convenience. */ }
}

function cancelPreviewDrag(event?: PointerEvent): void {
  const drag = activePreviewDrag;
  if (!drag || (event && drag.pointerId !== event.pointerId)) return;
  activePreviewDrag = undefined;
  if (drag.capture.hasPointerCapture(drag.pointerId)) drag.capture.releasePointerCapture(drag.pointerId);
  previewFrameWrap.dataset.moving = "false";
  previewPositionMeta.setAttribute("aria-live", "polite");
  previewSizeDragLabel.hidden = true;
  previewPosition = drag.startPosition;
  previewFrameWrap.style.position = "";
  previewFrameWrap.style.left = "";
  previewFrameWrap.style.top = "";
  if (drag.kind === "resize") applyPreviewSourceSize(drag.startSize, false);
  else updatePreviewScale();
}

function savePreviewHeightToTheme(height: number): void {
  const control = document.querySelector<HTMLInputElement>("#theme-maxChatHeight");
  if (!control || control.disabled || controlsRoot.inert) return;
  control.value = String(height);
  control.dispatchEvent(new Event("input", { bubbles: true }));
}

function applyPreviewSourceSize(size: PreviewSourceSize, persist: boolean, updateScale = true): void {
  previewSourceSize = size;
  previewPosition = clampPreviewPosition(previewPosition, size);
  previewSizeError.hidden = true;
  updatePreviewSizeControl();
  updateSourceSizeHint();
  if (updateScale) updatePreviewScale();
  else updatePreviewPositionReadout();
  if (persist && overlay) {
    try { localStorage.setItem(`chatwerk-source-size:${overlay.id}`, JSON.stringify(size)); } catch { /* This setting is a local Studio convenience. */ }
    savePreviewPosition();
  }
}

function updatePreviewSizeControl(): void {
  const preset = `${previewSourceSize.width}x${previewSourceSize.height}`;
  const isPreset = ["400x600", "300x900", "1920x1080"].includes(preset);
  previewSizePreset.value = isPreset ? preset : "custom";
  previewCustomWidth.value = String(previewSourceSize.width);
  previewCustomHeight.value = String(previewSourceSize.height);
  previewCustomSize.hidden = previewSizePreset.value !== "custom";
}

function updateSourceSizeHint(): void {
  const key = window.innerWidth >= 1024 && window.innerWidth <= 1279 ? "obsSourceSizeCompactHint" : "obsSourceSizeHint";
  obsSizeHint.textContent = translate(language, key, {
    width: previewSourceSize.width,
    height: previewSourceSize.height,
  });
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
