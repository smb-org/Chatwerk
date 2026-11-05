import "./studio.css";
import { THEME_FIELDS, getShareableThemeKeys, validateShareableTheme, validateTheme, isValidColor, type ThemeConfig, type ThemeFieldName } from "../shared/theme";
import { currentLanguage, translate, type Language, type TranslationKey } from "../shared/i18n";
import { applyTranslations } from "./i18n-dom";

interface ParentLook {
  removed: boolean;
  name?: string;
  author?: string;
  slug?: string;
}

interface LookItem {
  id: string;
  slug: string;
  name: string;
  author: string;
  values: unknown;
  parent: ParentLook | null;
  withdrawn?: boolean;
  createdAt?: string;
}

interface OwnedOverlay {
  id: string;
  name: string;
  channel: string;
  linkToken: string;
  generation: number;
}

interface CopyAttempt {
  lookId: string;
  overlayId: string;
  key: string;
  expiresAt: number;
}

const $ = <T = HTMLElement>(selector: string): T => {
  const element = document.querySelector(selector);
  if (!element) throw new Error(`Missing look page element: ${selector}`);
  return element as unknown as T;
};

const language: Language = currentLanguage();
const isGallery = Boolean(document.querySelector("#gallery-page"));
const pathname = window.location.pathname;
const slug = pathname.startsWith("/t/") ? pathname.slice(3) : "";
const lookList = document.querySelector<HTMLElement>("#look-list");
const lookName = $("#look-name");
const lookAuthor = $("#look-author");
const lookLineage = $("#look-lineage");
const preview = $("#look-preview") as HTMLIFrameElement;
const stage = $("#look-stage");
const previewWrap = $("#gallery-frame-wrap");
const previewStatus = $("#look-preview-status");
const useButtons = [...document.querySelectorAll<HTMLButtonElement>("#use-look, #use-look-mobile")];
const publicCopyLogins = [...document.querySelectorAll<HTMLAnchorElement>("#public-copy-login, #public-copy-login-mobile")];
const toast = $("#gallery-toast");

let looks: LookItem[] = [];
let selected: LookItem | undefined;
let overlays: OwnedOverlay[] = [];
let activeOverlay: OwnedOverlay | undefined;
let activeIndex = -1;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let previewFailed = false;
let currentScenario = "quiet";
let pendingCopy: CopyAttempt | undefined;

applyTranslations(document, language);
document.documentElement.lang = language;
document.title = `${translate(language, "brand")} · ${translate(language, isGallery ? "themes" : "lookPageTitle")}`;
wirePreview();
wireScenarios();
wireActions();
if (isGallery) void initializeGallery();
else void initializePublicLook();

async function initializeGallery(): Promise<void> {
  if (!lookList) return;
  renderSkeletons();
  try {
    const [overlayResponse, lookResponse] = await Promise.all([
      fetch("/api/overlays", { credentials: "same-origin", cache: "no-store" }),
      fetch("/api/looks", { credentials: "same-origin", cache: "no-store" }),
    ]);
    if (overlayResponse.status === 401 || lookResponse.status === 401) {
      window.location.assign("/auth/login?next=%2Fthemes");
      return;
    }
    if (!overlayResponse.ok || !lookResponse.ok) throw new Error("gallery-load");
    const [overlayData, lookData] = await Promise.all([
      overlayResponse.json() as Promise<{ overlays?: OwnedOverlay[] }>,
      lookResponse.json() as Promise<{ looks?: LookItem[] }>,
    ]);
    overlays = overlayData.overlays ?? [];
    activeOverlay = selectOverlay(overlays);
    updateActiveOverlayName();
    looks = (lookData.looks ?? []).flatMap((look) => {
      try { return [validateLook(look)]; } catch { return []; }
    });
    renderList();
    if (looks.length === 0) {
      setGalleryMessage("galleryEmpty");
      $(".gallery-main").classList.add("is-empty");
      $(".gallery-shell").classList.add("is-empty");
      $("#gallery-empty-action").removeAttribute("hidden");
      $("#look-name").textContent = translate(language, "galleryEmptyTitle");
      $("#look-primary-action").setAttribute("hidden", "true");
      $("#look-stage").setAttribute("hidden", "true");
      $(".look-rehearse").setAttribute("hidden", "true");
      $("#look-values").setAttribute("hidden", "true");
      useButtons.forEach((button) => { button.disabled = true; });
      return;
    }
    chooseLook(0);
  } catch {
    renderList();
    setGalleryMessage("galleryLoadFailed", true);
  }
}

async function initializePublicLook(): Promise<void> {
  const login = document.querySelector<HTMLAnchorElement>("#public-login");
  if (login) {
    const next = `/t/${encodeURIComponent(slug)}`;
    const href = `/auth/login?next=${encodeURIComponent(next)}`;
    login.href = href;
    publicCopyLogins.forEach((link) => { link.href = href; });
    login.hidden = false;
  }
  try {
    const response = await fetch(`/api/looks/${encodeURIComponent(slug)}`, { cache: "no-store" });
    if (response.status === 404) {
      renderPublicState("lookGone", true);
      return;
    }
    if (!response.ok) throw new Error("look-load");
    selected = validateLook(await response.json() as LookItem);
    renderSelectedLook();
    const overlayResponse = await fetch("/api/overlays", { credentials: "same-origin", cache: "no-store" });
    if (overlayResponse.status === 401) {
      publicCopyLogins.forEach((link) => { link.hidden = false; });
      return;
    }
    if (!overlayResponse.ok) return;
    overlays = (await overlayResponse.json() as { overlays?: OwnedOverlay[] }).overlays ?? [];
    activeOverlay = selectOverlay(overlays);
    updateActiveOverlayName();
    if (login) login.hidden = true;
    $("#account-menu").removeAttribute("hidden");
    useButtons.forEach((button) => { button.hidden = false; });
    $("#look-copy-hint").removeAttribute("hidden");
    useButtons.forEach((button) => { button.disabled = !activeOverlay; });
    updateCopyButtonLabel();
  } catch {
    renderPublicState("lookLoadFailed", false);
  }
}

function validateLook(value: LookItem): LookItem {
  if (!value || typeof value !== "object" || typeof value.id !== "string" || typeof value.slug !== "string" ||
    typeof value.name !== "string" || typeof value.author !== "string") throw new TypeError("Invalid look");
  return { ...value, values: validateShareableTheme(value.values) };
}

function selectOverlay(items: OwnedOverlay[]): OwnedOverlay | undefined {
  const storedId = readLocalStorage("chatwerk-overlay-id");
  return items.find((item) => item.id === storedId) ?? items.find((item) => item.name === "Main") ?? items[0];
}

function updateActiveOverlayName(): void {
  const name = document.querySelector<HTMLElement>("#active-overlay-name");
  if (name) {
    name.textContent = activeOverlay ? translate(language, "activeOverlayName", { name: activeOverlay.name }) : "";
    name.hidden = !activeOverlay;
  }
  updateCopyButtonLabel();
}

function updateCopyButtonLabel(): void {
  if (!activeOverlay) return;
  useButtons.forEach((button) => { button.textContent = translate(language, "useOnOverlay", { name: activeOverlay!.name }); });
}

function renderSkeletons(): void {
  if (!lookList) return;
  lookList.replaceChildren();
  for (let index = 0; index < 5; index += 1) {
    const row = document.createElement("div");
    row.className = "look-skeleton";
    row.setAttribute("aria-hidden", "true");
    lookList.appendChild(row);
  }
}

function renderList(): void {
  if (!lookList) return;
  lookList.replaceChildren();
  const sorted = sortedLooks();
  sorted.forEach((look, index) => {
    const option = document.createElement("div");
    option.id = `look-option-${look.id}`;
    option.className = "look-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(look.id === selected?.id));
    option.dataset.lookId = look.id;
    const title = document.createElement("span");
    title.className = "look-option-name";
    title.textContent = look.name;
    const author = document.createElement("span");
    author.className = "look-option-author";
    author.textContent = translate(language, "lookByAuthor", { author: look.author });
    const lineage = document.createElement("span");
    lineage.className = "look-option-lineage";
    lineage.textContent = lineageText(look.parent);
    option.appendChild(title);
    option.appendChild(author);
    option.appendChild(lineage);
    option.addEventListener("click", () => chooseLook(index));
    lookList.appendChild(option);
  });
  if (selected) setActiveDescendant(selected.id);
}

function sortedLooks(): LookItem[] {
  const sort = (document.querySelector("#look-sort") as HTMLSelectElement | null)?.value ?? "newest";
  const values = [...looks];
  if (sort === "name") return values.sort((a, b) => a.name.localeCompare(b.name, language));
  return values.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

function chooseLook(index: number): void {
  const sorted = sortedLooks();
  const look = sorted[index];
  if (!look) return;
  activeIndex = index;
  selected = look;
  renderList();
  renderSelectedLook();
}

function setActiveDescendant(id: string): void {
  const option = document.querySelector<HTMLElement>(`#look-option-${CSS.escape(id)}`);
  if (!option || !lookList) return;
  lookList.setAttribute("aria-activedescendant", option.id);
}

function renderSelectedLook(): void {
  if (!selected) return;
  const theme = validateTheme(selected.values);
  lookName.textContent = selected.name;
  lookAuthor.textContent = translate(language, "lookByAuthor", { author: selected.author });
  lookLineage.textContent = lineageText(selected.parent);
  preview.title = translate(language, "lookPreviewTitle", { name: selected.name });
  renderValues(theme);
  useButtons.forEach((button) => { button.disabled = !activeOverlay; });
  updateCopyButtonLabel();
  postPreviewTheme(selected.values);
  postScenario(currentScenario);
}

function renderValues(theme: ThemeConfig): void {
  const strip = $("#look-values");
  strip.replaceChildren();
  for (const key of getShareableThemeKeys()) {
    const row = document.createElement("div");
    const label = document.createElement("dt");
    label.textContent = translate(language, fieldTranslationKey(key));
    const value = document.createElement("dd");
    value.dataset.value = key;
    const rawValue = theme[key];
    const formatted = formatThemeValue(key, rawValue);
    if (isValidColor(rawValue)) {
      const chip = document.createElement("span");
      chip.className = "look-color-chip";
      chip.style.backgroundColor = rawValue;
      chip.setAttribute("aria-hidden", "true");
      value.appendChild(chip);
    }
    value.appendChild(document.createTextNode(formatted));
    row.appendChild(label);
    row.appendChild(value);
    strip.appendChild(row);
  }
}

function fieldTranslationKey(name: ThemeFieldName): TranslationKey {
  return `field${name[0]!.toUpperCase()}${name.slice(1)}` as TranslationKey;
}

function formatThemeValue(name: ThemeFieldName, rawValue: unknown): string {
  if (name === "layout") return translate(language, rawValue === "ticker" ? "valueTicker" : "valueStack");
  if (name === "nameColorMode") return translate(language, rawValue === "text" ? "valueNameText" : "valueNameTag");
  if (name === "lineOrder") return translate(language, rawValue === "message-first" ? "valueMessageFirst" : "valueNameFirst");
  if (name === "motion") return translate(language, rawValue === "none" ? "valueNone" : "valueFade");
  if (typeof rawValue === "boolean") return translate(language, rawValue ? "valueOn" : "valueOff");
  if (typeof rawValue === "number") {
    const unit = THEME_FIELDS[name].range?.unit;
    if (unit === "ratio") return `${Math.round(rawValue * 100)}%`;
    if (unit === "ms") return `${Math.round(rawValue / 1_000)} ${translate(language, "secondsUnit")}`;
    if (unit && unit !== "unitless") return `${rawValue} ${unit}`;
    return String(rawValue);
  }
  return typeof rawValue === "string" && isValidColor(rawValue) ? rawValue.toUpperCase() : String(rawValue ?? "");
}

function lineageText(parent: ParentLook | null): string {
  if (!parent) return translate(language, "originalLook");
  if (parent.removed || !parent.name || !parent.author) return translate(language, "basedOnRemoved");
  return translate(language, "basedOn", { name: parent.name, author: parent.author });
}

function wirePreview(): void {
  preview.addEventListener("load", () => {
    previewFailed = false;
    if (selected) {
      postPreviewTheme(selected.values);
      postScenario(currentScenario);
    }
    if (previewFailed) updatePreviewStatus();
    else updatePreviewScale();
  });
  preview.addEventListener("error", () => {
    previewFailed = true;
    updatePreviewStatus();
  });
  if (typeof ResizeObserver !== "undefined") new ResizeObserver(updatePreviewScale).observe(stage);
  window.addEventListener("resize", updatePreviewScale);
}

function updatePreviewScale(): void {
  const availableWidth = Math.max(0, stage.clientWidth - 32);
  const availableHeight = Math.max(0, stage.clientHeight - 32);
  const scale = Math.max(0, Math.min(availableWidth / 1920, availableHeight / 1080));
  (previewWrap as HTMLElement).style.width = `${1920 * scale}px`;
  (previewWrap as HTMLElement).style.height = `${1080 * scale}px`;
  preview.style.transform = `scale(${scale})`;
  previewStatus.textContent = translate(language, "previewScale", { percent: Math.round(scale * 100) });
}

function updatePreviewStatus(): void {
  previewStatus.textContent = previewFailed ? translate(language, "previewUnavailable")
    : translate(language, "previewScale", { percent: Math.round((preview.clientWidth / 1920) * 100) });
}

function postPreviewTheme(theme: unknown): void {
  preview.contentWindow?.postMessage({ type: "chatwerk:studio-theme", theme: validateShareableTheme(theme) }, "*");
}

function postScenario(scenario: string): void {
  preview.contentWindow?.postMessage({ type: "chatwerk:studio-scenario", scenario }, "*");
}

function wireScenarios(): void {
  document.querySelectorAll<HTMLButtonElement>("[data-scenario]").forEach((button) => {
    button.addEventListener("click", () => {
      currentScenario = button.dataset.scenario ?? "quiet";
      document.querySelectorAll<HTMLButtonElement>("[data-scenario]").forEach((item) => {
        item.setAttribute("aria-pressed", String(item === button));
      });
      postScenario(currentScenario);
    });
  });
  lookList?.addEventListener("keydown", (event) => {
    if (!looks.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const sorted = sortedLooks();
    const last = sorted.length - 1;
    const selectedIndex = sorted.findIndex((look) => look.id === selected?.id);
    const currentIndex = selectedIndex >= 0 ? selectedIndex : activeIndex;
    const next = event.key === "Home" ? 0 : event.key === "End" ? last
      : Math.max(0, Math.min(last, currentIndex + (event.key === "ArrowDown" ? 1 : -1)));
    chooseLook(next);
  });
}

function wireActions(): void {
  useButtons.forEach((button) => button.addEventListener("click", () => void copyLook()));
  (document.querySelector("#look-sort") as HTMLSelectElement | null)?.addEventListener("change", () => {
    if (!selected) return;
    const index = sortedLooks().findIndex((look) => look.id === selected?.id);
    activeIndex = index;
    renderList();
  });
}

async function copyLook(): Promise<void> {
  if (!selected || !activeOverlay) return;
  useButtons.forEach((button) => {
    button.disabled = true;
    button.textContent = translate(language, "copying");
  });
  try {
    const response = await fetch(`/api/looks/${encodeURIComponent(selected.slug)}/copy`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json", "Idempotency-Key": copyKey(selected.id, activeOverlay.id) },
      body: JSON.stringify({ overlayId: activeOverlay.id }),
    });
    if (response.status === 401) {
      const next = isGallery ? "/themes" : `/t/${selected.slug}`;
      window.location.assign(`/auth/login?next=${encodeURIComponent(next)}`);
      return;
    }
    if (!response.ok) throw new Error("copy-look");
    const result = await response.json() as { revision: number; snapshotId: string; undoExpiresAt: number };
    clearCopyKey();
    try { localStorage.setItem("chatwerk-overlay-id", activeOverlay.id); } catch { /* The backend still targets this overlay. */ }
    const next = new URL("/studio", window.location.origin);
    next.searchParams.set("overlay", activeOverlay.id);
    next.searchParams.set("undo", result.snapshotId);
    next.searchParams.set("rev", String(result.revision));
    next.searchParams.set("until", String(result.undoExpiresAt));
    next.searchParams.set("look", selected.slug);
    next.searchParams.set("lookName", selected.name);
    window.location.assign(next.toString());
  } catch {
    showToast("copyFailed", true);
    useButtons.forEach((button) => {
      button.disabled = false;
      button.textContent = translate(language, "useOnOverlay", { name: activeOverlay!.name });
    });
  }
}

function copyKey(lookId: string, overlayId: string): string {
  if (!pendingCopy) {
    try {
      const stored: unknown = JSON.parse(sessionStorage.getItem("chatwerk-copy-attempt") ?? "null");
      if (isCopyAttempt(stored)) pendingCopy = stored;
    } catch { /* Storage is optional; the current page can still retry. */ }
  }
  if (!pendingCopy || pendingCopy.lookId !== lookId || pendingCopy.overlayId !== overlayId ||
    typeof pendingCopy.key !== "string" || !/^[0-9a-f-]{36}$/iu.test(pendingCopy.key) ||
    typeof pendingCopy.expiresAt !== "number" || pendingCopy.expiresAt <= Date.now()) {
    pendingCopy = { lookId, overlayId, key: crypto.randomUUID(), expiresAt: Date.now() + 10_000 };
    try { sessionStorage.setItem("chatwerk-copy-attempt", JSON.stringify(pendingCopy)); } catch { /* Retain the in-memory key. */ }
  }
  return pendingCopy.key;
}

function isCopyAttempt(value: unknown): value is CopyAttempt {
  return typeof value === "object" && value !== null &&
    "lookId" in value && typeof value.lookId === "string" &&
    "overlayId" in value && typeof value.overlayId === "string" &&
    "key" in value && typeof value.key === "string" &&
    "expiresAt" in value && typeof value.expiresAt === "number";
}

function clearCopyKey(): void {
  pendingCopy = undefined;
  try { sessionStorage.removeItem("chatwerk-copy-attempt"); } catch { /* Storage is optional. */ }
}

function renderPublicState(messageKey: "lookGone" | "lookLoadFailed", gone: boolean): void {
  const state = $("#public-look-state");
  state.replaceChildren();
  const text = document.createElement("span");
  text.textContent = translate(language, messageKey);
  state.appendChild(text);
  if (gone) {
    $("#look-detail").classList.add("is-empty");
    const browse = document.createElement("a");
    browse.href = "/themes";
    browse.textContent = translate(language, "browseThemes");
    state.appendChild(document.createTextNode(" "));
    state.appendChild(browse);
  } else {
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "small-button";
    retry.textContent = translate(language, "tryAgain");
    retry.addEventListener("click", () => void initializePublicLook());
    state.appendChild(document.createTextNode(" "));
    state.appendChild(retry);
  }
  if (gone) {
    $("#look-stage").setAttribute("hidden", "true");
    $(".look-rehearse").setAttribute("hidden", "true");
    $("#look-values").setAttribute("hidden", "true");
    lookName.textContent = translate(language, "lookGoneTitle");
    lookAuthor.textContent = "";
    lookLineage.textContent = "";
  }
}

function setGalleryMessage(key: "galleryEmpty" | "galleryLoadFailed", retry = false): void {
  const message = $("#gallery-message");
  message.replaceChildren(document.createTextNode(translate(language, key)));
  if (retry) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "small-button";
    button.textContent = translate(language, "tryAgain");
    button.addEventListener("click", () => void initializeGallery());
    message.appendChild(document.createTextNode(" "));
    message.appendChild(button);
  }
}

function showToast(key: "copyFailed", error = false): void {
  if (toastTimer !== undefined) clearTimeout(toastTimer);
  toast.textContent = translate(language, key);
  toast.dataset.kind = error ? "error" : "ok";
  toast.classList.add("is-visible");
  toastTimer = setTimeout(() => toast.classList.remove("is-visible"), 4_000);
}

function readLocalStorage(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
