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
import { createThirdPartyBadgeLookup } from "./third-party-badges";
import { fetchRecentBacklog } from "./backlog";
import {
  QUIET_SAMPLE_EMOTES,
  QUIET_SAMPLE_PAINTS,
  QUIET_SAMPLE_SEVENTV_BADGE,
  QUIET_SAMPLE_TWITCH_BADGES,
  runHypeTrainScenario,
  runScenario,
  type ScenarioName,
} from "./scenarios";

const chat = document.querySelector<HTMLElement>("#chat");
if (chat) {
  const liveLocation = parseLiveLocation(window.location.hash, navigator.userAgent);
  chat.dataset.placement = liveLocation.placement;
  const sevenTvEvents = createSevenTvEventApi();
  const emotes = createEmoteLookup({ eventApi: sevenTvEvents, enabledProviders: [] });
  const sampleEmotes = createEmoteLookup({ eventApi: sevenTvEvents, providers: [], enabledProviders: [] });
  sampleEmotes.add(QUIET_SAMPLE_EMOTES);
  const badges = createBadgeLookup({ source: { type: "route" }, sampleData: QUIET_SAMPLE_TWITCH_BADGES });
  const paints = createPaintLookup({ eventApi: sevenTvEvents, enabled: false });
  for (const [userId, paint] of Object.entries(QUIET_SAMPLE_PAINTS)) paints.set(userId, paint, true);
  paints.setBadge("7100005", QUIET_SAMPLE_SEVENTV_BADGE, true);
  const thirdPartyBadges = createThirdPartyBadgeLookup();
  const pronouns = createPronounLookup();
  const renderer = createChatRenderer({ root: chat, theme: DEFAULTS, emotes, sampleEmotes, badges, paints, pronouns, thirdPartyBadges, deferProviderSettings: true });
  let currentTheme = DEFAULTS;
  let irc: IrcClient | undefined;
  let legacyChannel = "";
  let previewChannels: string[] | undefined;
  let previewLiveEnabled = false;
  let studioThemeReceived = false;
  const roomScopes = createRoomScopeCoordinator({ emotes, paints });
  let chatStatus: ChatStatus = "idle";
  const live: { handle?: LiveHandle } = {};
  let stopScenario: (() => void) | undefined;
  let backlogController: AbortController | undefined;
  let backlogChannelsKey = "";

  const activeChannels = (): string[] => {
    if (liveLocation.client === "studio" && !liveLocation.token && !previewLiveEnabled) return [];
    const selected = previewChannels ?? currentTheme.channels;
    if (selected.length > 0) return normalizeChannels(selected);
    const fallback = liveLocation.channel ?? legacyChannel;
    return fallback ? normalizeChannels([fallback]) : [];
  };

  const usesLiveChat = (): boolean => {
    const path = window.location.pathname;
    if (path === "/themes" || path.startsWith("/t/")) return false;
    if (liveLocation.client === "studio" && !liveLocation.token) return previewLiveEnabled;
    return true;
  };

  const syncBacklog = (channels: string[]): void => {
    const shouldLoad = currentTheme.backlog && currentTheme.layout !== "ticker" && usesLiveChat() && channels.length > 0;
    const nextKey = JSON.stringify({ channels, shouldLoad });
    if (nextKey === backlogChannelsKey) return;
    backlogController?.abort();
    backlogController = undefined;
    backlogChannelsKey = nextKey;
    if (!shouldLoad) return;
    const controller = new AbortController();
    backlogController = controller;
    const finishBacklogFetch = renderer.beginBacklogFetch();
    void fetchRecentBacklog(channels, currentTheme, { signal: controller.signal }).then((messages) => {
      if (controller.signal.aborted) return;
      for (const message of messages) renderer.handle(message.event, message.receivedAt);
    }).finally(() => {
      finishBacklogFetch();
      if (backlogController === controller) backlogController = undefined;
    });
  };

  const reconcileIrc = (): void => {
    const channels = activeChannels();
    renderer.setChannels(channels);
    roomScopes.setChannels(channels);
    syncBacklog(channels);
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
          if (liveLocation.client === "studio" && previewLiveEnabled && event.type === "PRIVMSG") {
            postStudioChatState("message", activeChannels().join(", "));
          }
        },
        onStatus: (status) => {
          chatStatus = status;
          if (liveLocation.client === "studio" && previewLiveEnabled) {
            postStudioChatState(status === "connected" ? "waiting" : "connecting", activeChannels().join(", "));
          }
          live.handle?.acknowledge();
        },
      });
      irc.start();
      live.handle?.acknowledge();
      return;
    }
    const previousChannels = irc.getChannels();
    const changed = previousChannels.length !== channels.length || previousChannels.some((item, index) => item !== channels[index]);
    irc.setChannels(channels);
    if (changed && liveLocation.client === "studio" && previewLiveEnabled) {
      postStudioChatState("waiting", channels.join(", "));
    }
  };

  const postStudioChatState = (state: "connecting" | "waiting" | "message", channel: string): void => {
    if (window.parent === window) return;
    window.parent.postMessage({ type: "chatwerk:studio-chat-state", state, channel }, window.location.origin);
  };

  const startIrc = (channel: string): void => {
    if (!isValidChannel(channel)) return;
    legacyChannel = channel.toLowerCase().replace(/^#/u, "");
    reconcileIrc();
  };

  const stopIrc = (): void => {
    irc?.stop();
    irc = undefined;
    backlogController?.abort();
    backlogController = undefined;
    backlogChannelsKey = "";
    roomScopes.reset();
    chatStatus = "idle";
  };

  const showScenario = (scenario: ScenarioName, includeSharedChat = false): void => {
    stopScenario?.();
    renderer.clear();
    renderer.setTheme(currentTheme);
    stopScenario = runScenario(scenario, (message) => renderer.handle(message), liveLocation.channel ?? "sample", includeSharedChat);
  };

  if (liveLocation.client === "studio" && !liveLocation.token) {
    window.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (window.parent === window || event.source !== window.parent || !isRecord(event.data)) return;
      if (event.data.type === "chatwerk:studio-theme") {
        try {
          currentTheme = validateTheme(event.data.theme);
          studioThemeReceived = true;
          renderer.setTheme(currentTheme);
          roomScopes.setPaintsEnabled(currentTheme.showPaints || (currentTheme.showBadges && currentTheme.badges7tv));
          reconcileIrc();
        } catch {
          // The parent controls a local preview; malformed data leaves the current valid theme in place.
        }
        return;
      }
      if (event.data.type === "chatwerk:studio-scenario" && isScenarioName(event.data.scenario)) {
        showScenario(event.data.scenario, event.data.includeSharedChat === true);
        return;
      }
      if (event.data.type === "chatwerk:studio-hype-train-scenario") {
        stopScenario?.();
        renderer.clear();
        renderer.setTheme(currentTheme);
        runScenario("quiet", (message) => renderer.handle(message), liveLocation.channel ?? "sample");
        stopScenario = runHypeTrainScenario((message) => renderer.handleHypeTrain(message));
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
          showScenario("quiet", true);
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
      if (liveLocation.client === "studio" && !liveLocation.token && !studioThemeReceived) return;
      renderer.setTheme(theme);
      roomScopes.setPaintsEnabled(theme.showPaints || (theme.showBadges && theme.badges7tv));
      reconcileIrc();
    },
    onChannel: (channel) => {
      if (!liveLocation.channel) startIrc(channel);
    },
    onTestLine: (id, onExpire) => showTestLine(chat, id, onExpire),
    onMessage: (message) => {
      if (isHypeTrainMessage(message)) renderer.handleHypeTrain(message);
    },
    onRevoked: () => {
      stopIrc();
      renderer.dispose();
      sevenTvEvents.dispose();
    },
    getChatStatus: () => chatStatus,
    deferUncachedTheme: true,
  });
  live.handle.acknowledge();

  window.addEventListener("pagehide", () => {
    live.handle?.stop();
    stopScenario?.();
    irc?.stop();
    backlogController?.abort();
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

function isHypeTrainMessage(value: Record<string, unknown>): value is Record<string, unknown> & {
  type: "hype-train"; id: string; trainId: string; channel: string; phase: "begin" | "progress" | "end"; level: number; expiresAt: string | null;
} {
  return value.type === "hype-train" && typeof value.id === "string" && typeof value.trainId === "string" &&
    value.trainId.length > 0 && value.trainId.length <= 256 && typeof value.channel === "string" &&
    (value.phase === "begin" || value.phase === "progress" || value.phase === "end") &&
    typeof value.level === "number" && Number.isSafeInteger(value.level) && value.level > 0 &&
    (value.expiresAt === null || typeof value.expiresAt === "string");
}

function normalizeChannels(channels: string[]): string[] {
  return [...new Set(channels.map((channel) => channel.toLowerCase().replace(/^#/u, "")))]
    .filter(isValidChannel).slice(0, 5);
}
