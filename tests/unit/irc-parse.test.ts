import { describe, expect, it } from "vitest";
import { parseIrcLine } from "../../src/renderer/irc-parse";

describe("Twitch IRC parser", () => {
  it("unescapes tags and parses message identifiers, source tags, colors and ranges", () => {
    const event = parseIrcLine(
      "@id=m1;room-id=10;source-room-id=20;source-id=s1;display-name=Test\\sUser;color=#aBc123;badges=moderator/1,subscriber/12;emotes=25:0-4,6-10 :login!login@host PRIVMSG #room :hello world",
    );
    expect(event).toMatchObject({
      type: "PRIVMSG",
      id: "m1",
      roomId: "10",
      sourceRoomId: "20",
      sourceId: "s1",
      displayName: "Test User",
      color: "#aBc123",
      badges: [{ name: "moderator", version: "1" }, { name: "subscriber", version: "12" }],
      emotes: [{ id: "25", ranges: [{ start: 0, end: 4 }, { start: 6, end: 10 }] }],
      text: "hello world",
    });
    const notice = parseIrcLine("@x=a\\:b\\sc\\\\d\\re\\nf NOTICE #room :ok");
    expect(notice?.type).toBe("NOTICE");
    if (notice?.type === "NOTICE") expect(notice.tags.x).toBe("a;b c\\d\re\nf");
    const invalidColor = parseIrcLine("@color=red :a!a@b PRIVMSG #room :bad");
    expect(invalidColor?.type).toBe("PRIVMSG");
    if (invalidColor?.type === "PRIVMSG") expect(invalidColor.color).toBeNull();
  });

  it("parses USERNOTICE, moderation with and without a target, CLEARMSG and ROOMSTATE", () => {
    expect(parseIrcLine("@id=u;display-name=Host;system-msg=New\\ssubscriber USERNOTICE #room :Thanks") )
      .toMatchObject({ type: "USERNOTICE", id: "u", displayName: "Host", text: "Thanks" });
    expect(parseIrcLine("@login=alice;user-id=42 :tmi.twitch.tv USERNOTICE #room :Thanks"))
      .toMatchObject({ type: "USERNOTICE", userLogin: "alice", tags: { "user-id": "42" } });
    expect(parseIrcLine(":tmi.twitch.tv CLEARCHAT #room :baduser"))
      .toMatchObject({ type: "CLEARCHAT", channel: "#room", target: "baduser" });
    expect(parseIrcLine("@target-user-id=42 :tmi.twitch.tv CLEARCHAT #room :alice"))
      .toMatchObject({ type: "CLEARCHAT", target: "alice", targetUserId: "42" });
    expect(parseIrcLine(":tmi.twitch.tv CLEARCHAT #room"))
      .toMatchObject({ type: "CLEARCHAT", channel: "#room", target: null });
    expect(parseIrcLine("@target-msg-id=m1 :tmi.twitch.tv CLEARMSG #room :removed"))
      .toMatchObject({ type: "CLEARMSG", messageId: "m1", text: "removed" });
    expect(parseIrcLine("@slow=10;emote-only=0 :tmi.twitch.tv ROOMSTATE #room"))
      .toMatchObject({ type: "ROOMSTATE", channel: "#room", tags: { slow: "10", "emote-only": "0" } });
  });

  it("parses PING, RECONNECT, NOTICE and ignores malformed or unrelated lines", () => {
    expect(parseIrcLine("PING :token")).toMatchObject({ type: "PING", payload: "token" });
    expect(parseIrcLine(":tmi.twitch.tv RECONNECT")).toMatchObject({ type: "RECONNECT" });
    expect(parseIrcLine("@msg-id=login_authentication_failed :tmi.twitch.tv NOTICE * :Login unsuccessful"))
      .toMatchObject({ type: "NOTICE", messageId: "login_authentication_failed", text: "Login unsuccessful" });
    expect(parseIrcLine("not an IRC line")).toBeNull();
  });
});
