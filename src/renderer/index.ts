import "./overlay.css";
import { DEFAULTS, validateTheme } from "../shared/theme";
import type { ChatStatus } from "../shared/protocol";
import { IrcClient, isValidChannel } from "./irc";
import { createChatRenderer } from "./render";
import { parseLiveLocation, showTestLine, startLiveUpdates, type LiveHandle } from "./live";
import { createEmoteLookup } from "./emotes";
import { createBadgeLookup } from "./badges";
import { createPaintLookup } from "./paints";
import { createPronounLookup } from "./pronouns";
import { createRoomScopeCoordinator } from "./room-scopes";
import { createSevenTvEventApi } from "./seventv-events";
import { runScenario, type ScenarioName } from "./scenarios";

const chat = document.querySelector<HTMLElement>("#chat");
if (chat) {
  const liveLocation = parseLiveLocation(window.location.hash, navigator.userAgent);
  chat.dataset.placement = liveLocation.placement;
  const sevenTvEvents = createSevenTvEventApi();
  const emotes = createEmoteLookup({ eventApi: sevenTvEvents });
  const badges = createBadgeLookup({ source: { type: "route" } });
  const paints = createPaintLookup({ eventApi: sevenTvEvents });
  const pronouns = createPronounLookup();
  const renderer = createChatRenderer({ root: chat, theme: DEFAULTS, emotes, badges, paints, pronouns });
  let currentTheme = DEFAULTS;
  let irc: IrcClient | undefined;
  let legacyChannel = "";
  let previewChannels: string[] | undefined;
  let previewLiveEnabled = false;
  const roomScopes = createRoomScopeCoordinator({ emotes, paints });
  let chatStatus: ChatStatus = "idle";
  const live: { handle?: LiveHandle } = {};
  let stopScenario: (() => void) | undefined;

  const activeChannels = (): string[] => {
    if (liveLocation.client === "studio" && !liveLocation.token && !previewLiveEnabled) return [];
    const selected = previewChannels ?? currentTheme.channels;
    if (selected.length > 0) return normalizeChannels(selected);
    const fallback = liveLocation.channel ?? legacyChannel;
    return fallback ? normalizeChannels([fallback]) : [];
  };

  const reconcileIrc = (): void => {
    const channels = activeChannels();
    renderer.setChannels(channels);
    roomScopes.setChannels(channels);
    if (channels.length > 0) {
      chat.querySelector(".chat-empty")?.remove();
    } else if (liveLocation.client !== "studio" && !chat.querySelector(".chat-empty")) {
      const empty = document.createElement("div");
      empty.setAttribute("class", "chat-empty");
      empty.textContent = "No channel set. Open Studio to add one.";
      chat.appendChild(empty);
    }
    if (!irc) {
      if (channels.length === 0) return;
      chatStatus = "reconnecting";
      irc = new IrcClient({
        channels,
        onEvent: (event) => {
          roomScopes.handle(event);
          renderer.handle(event);
        },
        onStatus: (status) => {
          chatStatus = status;
          live.handle?.acknowledge();
        },
      });
      irc.start();
      live.handle?.acknowledge();
      return;
    }
    irc.setChannels(channels);
  };

  const startIrc = (channel: string): void => {
    if (!isValidChannel(channel)) return;
    legacyChannel = channel.toLowerCase().replace(/^#/u, "");
    reconcileIrc();
  };

  const stopIrc = (): void => {
    irc?.stop();
    irc = undefined;
    roomScopes.reset();
    chatStatus = "idle";
  };

  const showScenario = (scenario: ScenarioName): void => {
    stopScenario?.();
    renderer.clear();
    renderer.setTheme(currentTheme);
    stopScenario = runScenario(scenario, (message) => renderer.handle(message), liveLocation.channel ?? "sample");
  };

  if (liveLocation.client === "studio" && !liveLocation.token) {
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (window.parent === window || event.source !== window.parent || !isRecord(event.data)) return;
      if (event.data.type === "chatwerk:studio-theme") {
        try {
          currentTheme = validateTheme(event.data.theme);
          renderer.setTheme(currentTheme);
          reconcileIrc();
        } catch {
          // The parent controls a local preview; malformed data leaves the current valid theme in place.
        }
        return;
      }
      if (event.data.type === "chatwerk:studio-scenario" && isScenarioName(event.data.scenario)) {
        showScenario(event.data.scenario);
        return;
      }
      if (event.data.type === "chatwerk:studio-live" && typeof event.data.enabled === "boolean") {
        stopScenario?.();
        stopScenario = undefined;
        if (event.data.enabled) {
          if (!previewLiveEnabled) renderer.clear();
          previewLiveEnabled = true;
          const rawChannels = Array.isArray(event.data.channels)
            ? event.data.channels.filter((value): value is string => typeof value === "string")
            : typeof event.data.channel === "string" ? [event.data.channel] : currentTheme.channels;
          previewChannels = normalizeChannels(rawChannels.filter(isValidChannel));
          if (previewChannels.length === 0 && typeof event.data.channel === "string" && isValidChannel(event.data.channel)) {
            previewChannels = normalizeChannels([event.data.channel]);
          }
          reconcileIrc();
        } else {
          previewLiveEnabled = false;
          previewChannels = undefined;
          stopIrc();
          renderer.clear();
          renderer.setTheme(currentTheme);
          showScenario("quiet");
        }
      }
    });
  }

  if (liveLocation.channel && !(liveLocation.client === "studio" && !liveLocation.token)) startIrc(liveLocation.channel);
  else if (!liveLocation.token) {
    const empty = document.createElement("div");
    empty.setAttribute("class", "chat-empty");
    empty.textContent = "No channel set. Open Studio to add one.";
    chat.appendChild(empty);
  }

  live.handle = startLiveUpdates({
    hash: window.location.hash,
    origin: new URL(window.location.href).origin,
    userAgent: navigator.userAgent,
    applyTheme: (theme) => {
      currentTheme = theme;
      renderer.setTheme(theme);
      reconcileIrc();
    },
    onChannel: (channel) => {
      if (!liveLocation.channel) startIrc(channel);
    },
    onTestLine: (id, onExpire) => showTestLine(chat, id, onExpire),
    onRevoked: () => {
      stopIrc();
      renderer.dispose();
      sevenTvEvents.dispose();
    },
    getChatStatus: () => chatStatus,
  });
  live.handle.acknowledge();

  window.addEventListener("pagehide", () => {
    live.handle?.stop();
    stopScenario?.();
    irc?.stop();
    renderer.dispose();
    sevenTvEvents.dispose();
  }, { once: true });
}

function isScenarioName(value: unknown): value is ScenarioName {
  return value === "quiet" || value === "flood" || value === "raid" || value === "sub" || value === "bits";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeChannels(channels: string[]): string[] {
  return [...new Set(channels.map((channel) => channel.toLowerCase().replace(/^#/u, "")))]
    .filter(isValidChannel).slice(0, 5);
}
