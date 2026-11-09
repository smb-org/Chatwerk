import "./studio.css";
import { currentLanguage, translate } from "../shared/i18n";
import { applyTranslations } from "./i18n-dom";

interface AdminOverview {
  totals: { users: number; overlays: number; connectedOutputs: number | null };
  users: Array<{
    twitchId: string;
    login: string;
    createdAt: string;
    lastLoginAt: string | null;
    overlays: Array<{ name: string; channels: string[]; createdAt: string; connectedOutputs: number | null }>;
    editorLogins: string[];
    pendingInvite: boolean;
    activeGalleryLooks: number;
  }>;
}

const language = currentLanguage();
applyTranslations(document, language);
document.title = translate(language, "adminTitle");

const $ = <T extends HTMLElement>(selector: string): T => {
  const element = document.querySelector<T>(selector);
  if (!element) throw new Error(`Missing admin element ${selector}`);
  return element;
};

const state = $("#admin-state");
const tableBody = $("#admin-table-body");

void loadOverview();

async function loadOverview(): Promise<void> {
  try {
    const response = await fetch("/api/admin/overview", { credentials: "same-origin", cache: "no-store" });
    if (!response.ok) throw new Error("overview-unavailable");
    const overview = await response.json() as AdminOverview;
    renderOverview(overview);
  } catch {
    state.textContent = translate(language, "adminLoadFailed");
  }
}

function renderOverview(overview: AdminOverview): void {
  $("#admin-total-users").textContent = String(overview.totals.users);
  $("#admin-total-overlays").textContent = String(overview.totals.overlays);
  $("#admin-total-connected").textContent = formatCount(overview.totals.connectedOutputs);
  tableBody.replaceChildren(...overview.users.map(renderUserRow));
  state.textContent = translate(language, "adminLoaded", { count: overview.users.length });
}

function renderUserRow(user: AdminOverview["users"][number]): HTMLTableRowElement {
  const row = document.createElement("tr");
  const identity = document.createElement("td");
  identity.className = "admin-identity";
  const login = document.createElement("strong");
  login.textContent = user.login;
  const twitchId = document.createElement("span");
  twitchId.className = "admin-twitch-id";
  twitchId.textContent = user.twitchId;
  identity.appendChild(login);
  identity.appendChild(twitchId);
  row.appendChild(identity);
  row.appendChild(dateCell(user.createdAt));
  row.appendChild(dateCell(user.lastLoginAt));

  const overlays = document.createElement("td");
  overlays.className = "admin-overlays-cell";
  if (user.overlays.length === 0) {
    overlays.textContent = translate(language, "adminNoOverlays");
  } else {
    const list = document.createElement("ul");
    list.className = "admin-overlay-list";
    for (const overlay of user.overlays) list.appendChild(renderOverlay(overlay));
    overlays.appendChild(list);
  }
  row.appendChild(overlays);

  const editors = document.createElement("td");
  editors.className = "admin-editors";
  editors.textContent = user.editorLogins.length ? user.editorLogins.join(", ") : translate(language, "adminNoEditors");
  row.appendChild(editors);

  const invite = document.createElement("td");
  invite.textContent = translate(language, user.pendingInvite ? "adminInviteYes" : "adminInviteNo");
  row.appendChild(invite);

  const looks = document.createElement("td");
  looks.className = "admin-number";
  looks.textContent = String(user.activeGalleryLooks);
  row.appendChild(looks);
  return row;
}

function renderOverlay(overlay: AdminOverview["users"][number]["overlays"][number]): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "admin-overlay-item";
  const heading = document.createElement("div");
  heading.className = "admin-overlay-heading";
  const name = document.createElement("strong");
  name.textContent = overlay.name;
  const count = document.createElement("span");
  count.textContent = translate(language, "adminOutputCount", { count: formatCount(overlay.connectedOutputs) });
  heading.appendChild(name);
  heading.appendChild(count);
  const channels = document.createElement("span");
  channels.className = "admin-overlay-channels";
  channels.textContent = overlay.channels.length ? overlay.channels.join(", ") : translate(language, "adminNoChannels");
  const created = document.createElement("span");
  created.className = "admin-overlay-created";
  created.textContent = formatDate(overlay.createdAt);
  item.appendChild(heading);
  item.appendChild(channels);
  item.appendChild(created);
  return item;
}

function dateCell(value: string | null): HTMLTableCellElement {
  const cell = document.createElement("td");
  const display = value ? formatDate(value) : translate(language, "adminNever");
  if (value) {
    const time = document.createElement("time");
    time.dateTime = value.includes("T") ? value : `${value.replace(" ", "T")}Z`;
    time.textContent = display;
    cell.appendChild(time);
  } else {
    cell.textContent = display;
  }
  return cell;
}

function formatDate(value: string): string {
  const date = new Date(value.includes("T") ? value : `${value.replace(" ", "T")}Z`);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat(language === "de" ? "de-DE" : "en-US", {
    dateStyle: "medium", timeStyle: "short",
  }).format(date);
}

function formatCount(count: number | null): string {
  return count === null ? translate(language, "adminUnknown") : String(count);
}
