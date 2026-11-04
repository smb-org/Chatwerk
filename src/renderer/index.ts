import "./overlay.css";
import { DEFAULTS, migrate, type ThemeConfig } from "../shared/theme";
import { IrcClient, isValidChannel } from "./irc";
import { createChatRenderer } from "./render";

const chat = document.querySelector<HTMLElement>("#chat");
if (chat) {
  const params = new URLSearchParams(window.location.hash.slice(1));
  // T6 supplies the token flow; the renderer currently reads channel and client from the hash.
  const channel = params.get("channel") ?? "";
  const client = params.get("client") ?? "browser";
  void client;

  let config: ThemeConfig = DEFAULTS;
  try {
    const cached = window.localStorage.getItem("chatwerk-theme");
    if (cached) config = migrate(JSON.parse(cached) as unknown);
  } catch {
    config = DEFAULTS;
  }

  const renderer = createChatRenderer({ root: chat, theme: config });
  if (!isValidChannel(channel)) {
    const empty = document.createElement("div");
    empty.setAttribute("class", "chat-empty");
    empty.textContent = "No channel set. Open Studio to add one.";
    chat.appendChild(empty);
  } else {
    const irc = new IrcClient({ channel, onEvent: (event) => renderer.handle(event) });
    irc.start();
    window.addEventListener("pagehide", () => {
      irc.stop();
      renderer.dispose();
    }, { once: true });
  }
}
