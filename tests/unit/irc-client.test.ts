import { afterEach, describe, expect, it, vi } from "vitest";
import { IrcClient, isValidChannel, type IrcTransport } from "../../src/renderer/irc";

class FakeTransport implements IrcTransport {
  openHandler: (() => void) | undefined;
  messageHandler: ((data: string) => void) | undefined;
  closeHandler: (() => void) | undefined;
  readonly sent: string[] = [];
  closed = false;
  onOpen(handler: () => void): void { this.openHandler = handler; }
  onMessage(handler: (data: string) => void): void { this.messageHandler = handler; }
  onClose(handler: () => void): void { this.closeHandler = handler; }
  send(line: string): void { this.sent.push(line); }
  close(): void { this.closed = true; }
  open(): void { this.openHandler?.(); }
  receive(line: string): void { this.messageHandler?.(line); }
  disconnect(): void { this.closeHandler?.(); }
}

afterEach(() => vi.useRealTimers());

describe("IRC client", () => {
  it("requests both capabilities, uses an anonymous nickname and answers PING", () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = new IrcClient({ channel: "room", transportFactory: () => transport });
    client.start();
    transport.open();
    expect(transport.sent).toContain("CAP REQ :twitch.tv/tags twitch.tv/commands");
    expect(transport.sent.some((line) => /^NICK justinfan\d+$/.test(line))).toBe(true);
    transport.receive("PING :keepalive");
    expect(transport.sent).toContain("PONG :keepalive");
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports chat status independently as it connects, reconnects, and stops", () => {
    const transport = new FakeTransport();
    const statuses: string[] = [];
    const client = new IrcClient({
      channel: "room",
      transportFactory: () => transport,
      onStatus: (status) => statuses.push(status),
    });

    client.start();
    transport.open();
    transport.receive(":tmi.twitch.tv ROOMSTATE #room");
    transport.disconnect();
    client.stop();

    expect(statuses).toEqual(["reconnecting", "connected", "reconnecting", "idle"]);
  });

  it("reconnects immediately on RECONNECT", () => {
    vi.useFakeTimers();
    const transports: FakeTransport[] = [];
    const client = new IrcClient({
      channel: "room",
      random: () => 0.5,
      transportFactory: () => { const value = new FakeTransport(); transports.push(value); return value; },
      randomValues: () => 100,
    });
    client.start();
    transports[0]!.open();
    transports[0]!.receive(":tmi.twitch.tv RECONNECT");
    expect(transports).toHaveLength(2);
    client.stop();
  });

  it("backs off repeated login collisions and resets after the first ROOMSTATE", () => {
    vi.useFakeTimers();
    const transports: FakeTransport[] = [];
    const client = new IrcClient({
      channel: "room",
      random: () => 0.5,
      transportFactory: () => { const value = new FakeTransport(); transports.push(value); return value; },
      randomValues: () => 100,
    });
    client.start();
    transports[0]!.open();
    const firstNick = transports[0]!.sent.find((line) => line.startsWith("NICK "));
    transports[0]!.receive("@msg-id=login_authentication_failed :tmi.twitch.tv NOTICE * :Login unsuccessful");
    expect(transports).toHaveLength(1);
    vi.advanceTimersByTime(999);
    expect(transports).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(transports).toHaveLength(2);
    transports[1]!.open();
    const secondNick = transports[1]!.sent.find((line) => line.startsWith("NICK "));
    expect(secondNick).not.toBe(firstNick);
    transports[1]!.receive("@msg-id=login_authentication_failed :tmi.twitch.tv NOTICE * :Login unsuccessful");
    vi.advanceTimersByTime(1_999);
    expect(transports).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(transports).toHaveLength(3);
    transports[2]!.open();
    const thirdNick = transports[2]!.sent.find((line) => line.startsWith("NICK "));
    expect(thirdNick).not.toBe(secondNick);
    transports[2]!.receive(":tmi.twitch.tv ROOMSTATE #room");
    transports[2]!.disconnect();
    vi.advanceTimersByTime(999);
    expect(transports).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(transports).toHaveLength(4);
    client.stop();
  });

  it("validates channels before opening a transport", () => {
    expect(isValidChannel("room")).toBe(true);
    expect(isValidChannel("Foo Bar")).toBe(false);
    const client = new IrcClient({ channel: "Foo Bar", transportFactory: () => { throw new Error("must not connect"); } });
    expect(() => client.start()).not.toThrow();
    client.stop();
  });

  it("joins several channels on one socket and parts/joins only the changed channels", () => {
    const transport = new FakeTransport();
    const client = new IrcClient({ channels: ["Main", "Second"], transportFactory: () => transport });
    client.start();
    transport.open();
    expect(transport.sent.filter((line) => line.startsWith("JOIN "))).toEqual(["JOIN #main", "JOIN #second"]);

    client.setChannels(["main", "third"]);
    expect(transport.sent.slice(-2)).toEqual(["PART #second", "JOIN #third"]);
    expect(client.getChannels()).toEqual(["main", "third"]);
    client.stop();
  });

  it("rejoins every configured channel after reconnect", () => {
    vi.useFakeTimers();
    const transports: FakeTransport[] = [];
    const client = new IrcClient({
      channels: ["main", "second", "third"],
      random: () => 0.5,
      transportFactory: () => { const transport = new FakeTransport(); transports.push(transport); return transport; },
    });
    client.start();
    transports[0]!.open();
    expect(transports[0]!.sent.filter((line) => line.startsWith("JOIN "))).toEqual([
      "JOIN #main", "JOIN #second", "JOIN #third",
    ]);

    transports[0]!.disconnect();
    vi.advanceTimersByTime(1_000);
    transports[1]!.open();
    expect(transports[1]!.sent.filter((line) => line.startsWith("JOIN "))).toEqual([
      "JOIN #main", "JOIN #second", "JOIN #third",
    ]);
    client.stop();
  });

  it("joins a channel change made while disconnected when the next socket opens", () => {
    vi.useFakeTimers();
    const transports: FakeTransport[] = [];
    const client = new IrcClient({
      channels: ["main", "second"],
      random: () => 0.5,
      transportFactory: () => { const transport = new FakeTransport(); transports.push(transport); return transport; },
    });
    client.start();
    transports[0]!.open();
    transports[0]!.disconnect();
    client.setChannels(["main", "third"]);
    expect(transports[0]!.sent).not.toContain("JOIN #third");

    vi.advanceTimersByTime(1_000);
    transports[1]!.open();
    expect(transports[1]!.sent.filter((line) => line.startsWith("JOIN "))).toEqual(["JOIN #main", "JOIN #third"]);
    client.stop();
  });

  it("keeps the legacy single-channel option and avoids reconnecting on an empty diff", () => {
    const transport = new FakeTransport();
    const client = new IrcClient({ channel: "Legacy", transportFactory: () => transport });
    client.start();
    transport.open();
    const commands = [...transport.sent];
    client.setChannels(["legacy"]);
    expect(transport.sent).toEqual(commands);
    expect(transport.closed).toBe(false);
    client.stop();
  });

  it("backs off with jitter, caps the delay at 30 seconds, and stops cleanly", () => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    let attempts = 0;
    const initial = new FakeTransport();
    const client = new IrcClient({
      channel: "room",
      transportFactory: () => {
        attempts += 1;
        if (attempts === 1) return initial;
        throw new Error("simulated transport creation failure");
      },
    });
    client.start();
    for (let attempt = 0; attempt < 6; attempt += 1) {
      if (attempt === 0) initial.disconnect();
      const delay = Math.min(30_000, 1_000 * 2 ** attempt * 1.5);
      vi.advanceTimersByTime(delay - 1);
      expect(attempts).toBe(attempt + 1);
      vi.advanceTimersByTime(1);
      expect(attempts).toBe(attempt + 2);
    }
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
    vi.restoreAllMocks();
  });

  it("reconnects after liveness and connect timeouts", () => {
    vi.useFakeTimers();
    const transports: FakeTransport[] = [];
    const client = new IrcClient({
      channel: "room",
      random: () => 0.5,
      transportFactory: () => { const value = new FakeTransport(); transports.push(value); return value; },
    });
    client.start();
    transports[0]!.open();
    vi.advanceTimersByTime(6 * 60_000);
    expect(transports[0]!.closed).toBe(true);
    vi.advanceTimersByTime(1_000);
    expect(transports).toHaveLength(2);
    vi.advanceTimersByTime(15_000);
    expect(transports[1]!.closed).toBe(true);
    client.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
