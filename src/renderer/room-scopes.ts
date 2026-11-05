import type { IrcEvent } from "./irc-parse";

export interface RoomScopeEmotes {
  setChannelIds(channelIds: string[]): void;
}

export interface RoomScopePaints {
  setChannelId(channelId: string): void;
}

/** Tracks only rooms Twitch joined directly; Shared Chat source rooms do not own provider scopes. */
export function createRoomScopeCoordinator(options: {
  emotes: RoomScopeEmotes;
  paints: RoomScopePaints;
}): {
  setChannels(channels: string[]): void;
  setPaintsEnabled(enabled: boolean): void;
  handle(event: IrcEvent): void;
  reset(): void;
} {
  const roomIds = new Map<string, string>();
  let channels: string[] = [];
  let paintsEnabled = true;

  const updateScopes = (): void => {
    options.emotes.setChannelIds([...roomIds.values()]);
    options.paints.setChannelId(paintsEnabled && channels[0] ? roomIds.get(channels[0]) ?? "" : "");
  };

  return {
    setChannels(nextChannels) {
      channels = [...new Set(nextChannels.map(normalizeChannel).filter(Boolean))].slice(0, 5);
      const selected = new Set(channels);
      for (const login of roomIds.keys()) {
        if (!selected.has(login)) roomIds.delete(login);
      }
      updateScopes();
    },
    setPaintsEnabled(enabled) {
      if (paintsEnabled === enabled) return;
      paintsEnabled = enabled;
      updateScopes();
    },
    handle(event) {
      if (event.type !== "ROOMSTATE") return;
      const login = normalizeChannel(event.channel);
      const roomId = event.tags["room-id"];
      if (!login || !roomId || !channels.includes(login)) return;
      roomIds.set(login, roomId);
      updateScopes();
    },
    reset() {
      roomIds.clear();
      channels = [];
      updateScopes();
    },
  };
}

function normalizeChannel(channel: string): string {
  return channel.toLowerCase().replace(/^#/u, "");
}
