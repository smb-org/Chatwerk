import { describe, expect, it, vi } from "vitest";
import { createEmoteLookup } from "../../src/renderer/emotes";
import { parseIrcLine } from "../../src/renderer/irc-parse";
import { createRoomScopeCoordinator } from "../../src/renderer/room-scopes";

describe("room scope coordinator", () => {
  it("keeps provider scopes stable across Shared Chat source rooms and subscribes paints for the first room", async () => {
    const requests: string[] = [];
    const emotes = createEmoteLookup({ providers: [{
      name: "test",
      loadGlobal: async () => [],
      loadChannel: async (channelId) => { requests.push(channelId); return []; },
    }] });
    const paints = { setChannelId: vi.fn() };
    const scopes = createRoomScopeCoordinator({ emotes, paints });
    scopes.setChannels(["main", "second"]);
    scopes.handle(parseIrcLine("@room-id=10 :tmi.twitch.tv ROOMSTATE #main")!);
    scopes.handle(parseIrcLine("@room-id=20 :tmi.twitch.tv ROOMSTATE #second")!);
    await vi.waitFor(() => expect(requests).toEqual(["10", "20"]));

    const initialRequests = [...requests];
    for (const [index, sourceRoomId] of ["30", "40", "30", "40", "30", "40"].entries()) {
      const channel = index % 2 === 0 ? "main" : "second";
      const roomId = index % 2 === 0 ? "10" : "20";
      scopes.handle(parseIrcLine(`@id=${index};room-id=${roomId};source-room-id=${sourceRoomId} :viewer!viewer@host PRIVMSG #${channel} :hello`)!);
    }

    expect(requests).toEqual(initialRequests);
    expect(paints.setChannelId).toHaveBeenCalledWith("10");
    scopes.reset();
    expect(paints.setChannelId).toHaveBeenLastCalledWith("");
    emotes.dispose();
  });
});
