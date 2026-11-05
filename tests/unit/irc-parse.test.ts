import { describe, expect, it } from "vitest";
import { parseIrcLine, parseReactionEvent } from "../../src/renderer/irc-parse";

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

  it("classifies Twitch raid, sub, resub, gift-sub, and bits tag shapes", () => {
    const fixtures = [
      ["@badge-info=;badges=;color=;display-name=Raider;emotes=;id=raid-1;login=raider;mod=0;msg-id=raid;msg-param-displayName=Big\\sStreamer;msg-param-login=bigstreamer;msg-param-viewerCount=57;room-id=10;subscriber=0;system-msg=Big\\sStreamer\\sis\\sraiding\\swith\\s57\\sviewers;user-id=1;user-type= :tmi.twitch.tv USERNOTICE #home", "raid"],
      ["@badge-info=;badges=subscriber/0;color=;display-name=NewSub;emotes=;id=sub-1;login=newsub;mod=0;msg-id=sub;msg-param-sub-plan=1000;msg-param-sub-plan-name=Channel\\sSubscription\\s(1\\sMonth);room-id=10;subscriber=1;system-msg=NewSub\\ssubscribed\\sat\\sTier\\s1;user-id=2;user-type= :tmi.twitch.tv USERNOTICE #home", "sub"],
      ["@badge-info=;badges=subscriber/1;color=;display-name=ReturningSub;emotes=;id=resub-1;login=returningsub;mod=0;msg-id=resub;msg-param-cumulative-months=12;msg-param-streak-months=3;msg-param-sub-plan=1000;msg-param-sub-plan-name=Channel\\sSubscription\\s(1\\sMonth);room-id=10;subscriber=1;system-msg=ReturningSub\\sresubscribed\\sfor\\s12\\smonths;user-id=3;user-type= :tmi.twitch.tv USERNOTICE #home", "resub"],
      ["@badge-info=;badges=subscriber/0;color=;display-name=Gifter;emotes=;id=gift-1;login=gifter;mod=0;msg-id=subgift;msg-param-gift-months=1;msg-param-months=1;msg-param-recipient-display-name=Gifted;msg-param-recipient-id=4;msg-param-sub-plan=1000;msg-param-sub-plan-name=Channel\\sSubscription\\s(1\\sMonth);room-id=10;subscriber=0;system-msg=Gifter\\sgifted\\sa\\sTier\\s1\\ssub\\sto\\sGifted;user-id=5;user-type= :tmi.twitch.tv USERNOTICE #home", "subgift"],
      ["@badge-info=;badges=bits/100;color=;display-name=Cheerer;emotes=;id=bits-1;login=cheerer;mod=0;room-id=10;user-id=6;bits=100 :cheerer!cheerer@host PRIVMSG #home :Cheer100", "bits"],
    ] as const;

    for (const [line, type] of fixtures) {
      const event = parseIrcLine(line);
      expect(event && parseReactionEvent(event)).toMatchObject({ type });
      expect(event).toMatchObject({ roomId: "10" });
    }
    const bits = parseReactionEvent(parseIrcLine(fixtures[4][0])!);
    expect(bits).toEqual({ type: "bits", amount: 100 });
  });

  it("ignores absent or hostile reaction tags and bounds numeric values", () => {
    const plain = parseIrcLine(":viewer!viewer@host PRIVMSG #home :hello");
    const hostileType = parseIrcLine("@msg-id=<script> :tmi.twitch.tv USERNOTICE #home");
    const hostileBits = parseIrcLine("@bits=999999999999999999999;room-id=10 :viewer!viewer@host PRIVMSG #home :cheer");
    const maximumBits = parseIrcLine("@bits=1000000;room-id=10 :viewer!viewer@host PRIVMSG #home :cheer");

    expect(parseReactionEvent(plain!)).toBeNull();
    expect(parseReactionEvent(hostileType!)).toBeNull();
    expect(parseReactionEvent(hostileBits!)).toBeNull();
    expect(parseReactionEvent(maximumBits!)).toEqual({ type: "bits", amount: 1_000_000 });
  });

  it("keeps shared-chat dedupe and room identifiers from the event tags", () => {
    const event = parseIrcLine("@id=relay-1;msg-id=raid;msg-param-viewerCount=4;room-id=10;source-id=source-1;source-room-id=20 :tmi.twitch.tv USERNOTICE #home");
    expect(event).toMatchObject({ type: "USERNOTICE", channel: "#home", roomId: "10", sourceRoomId: "20", sourceId: "source-1" });
  });

  it("classifies Shared Chat notices using source-msg-id", () => {
    const event = parseIrcLine("@id=relay-1;msg-id=sharedchatnotice;source-msg-id=raid;msg-param-viewerCount=4;room-id=10;source-id=source-1;source-room-id=20 :tmi.twitch.tv USERNOTICE #home");
    expect(event && parseReactionEvent(event)).toEqual({ type: "raid", amount: 4 });
  });
});
