import "./overlay.css";
import { DEFAULTS } from "../shared/theme";
import type { ChatStatus } from "../shared/protocol";
import { IrcClient, isValidChannel } from "./irc";
import { createChatRenderer } from "./render";
import { parseLiveLocation, showTestLine, startLiveUpdates, type LiveHandle } from "./live";

const chat = document.querySelector<HTMLElement>("#chat");
if (chat) {
  const liveLocation = parseLiveLocation(window.location.hash, navigator.userAgent);
  chat.dataset.placement = liveLocation.placement;
  const renderer = createChatRenderer({ root: chat, theme: DEFAULTS });
  let irc: IrcClient | undefined;
  let ircChannel = "";
  let chatStatus: ChatStatus = "idle";
  const live: { handle?: LiveHandle } = {};

  const startIrc = (channel: string): void => {
    if (!isValidChannel(channel)) return;
    const normalized = channel.toLowerCase().replace(/^#/u, "");
    if (ircChannel === normalized) return;
    irc?.stop();
    ircChannel = normalized;
    chat.querySelector(".chat-empty")?.remove();
    chatStatus = "reconnecting";
    irc = new IrcClient({
      channel: normalized,
      onEvent: (event) => renderer.handle(event),
      onStatus: (status) => {
        chatStatus = status;
        live.handle?.acknowledge();
      },
    });
    irc.start();
    live.handle?.acknowledge();
  };

  if (liveLocation.channel) startIrc(liveLocation.channel);
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
    applyTheme: (theme) => renderer.setTheme(theme),
    onChannel: (channel) => {
      if (!liveLocation.channel) startIrc(channel);
    },
    onTestLine: (id, onExpire) => showTestLine(chat, id, onExpire),
    onRevoked: () => {
      irc?.stop();
      irc = undefined;
      renderer.dispose();
    },
    getChatStatus: () => chatStatus,
  });
  live.handle.acknowledge();

  window.addEventListener("pagehide", () => {
    live.handle?.stop();
    irc?.stop();
    renderer.dispose();
  }, { once: true });
}
