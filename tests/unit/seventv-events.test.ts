import { afterEach, describe, expect, it, vi } from "vitest";
import { createSevenTvEventApi } from "../../src/renderer/seventv-events";

class FakeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event: Event | MessageEvent) => void>>();

  send(data: string): void { this.sent.push(data); }
  close(): void {
    this.readyState = 3;
    this.emit("close", new Event("close"));
  }
  addEventListener(type: "open" | "message" | "close" | "error", listener: (event: Event | MessageEvent) => void): void {
    const current = this.listeners.get(type) ?? [];
    current.push(listener);
    this.listeners.set(type, current);
  }
  emit(type: "open" | "message" | "close" | "error", event: Event | MessageEvent): void {
    for (const listener of this.listeners.get(type) ?? []) listener(event);
  }
  message(data: unknown): void {
    this.emit("message", { data: JSON.stringify(data) } as MessageEvent);
  }
}

afterEach(() => vi.useRealTimers());

describe("7TV EventAPI", () => {
  it("sends only subscribe commands after hello, even across heartbeat intervals", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const api = createSevenTvEventApi({ socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    } });
    api.subscribe("emote_set.update", "set-1", () => undefined);
    const socket = sockets[0]!;
    socket.readyState = 1;
    socket.emit("open", new Event("open"));
    socket.message({ op: 1, d: { heartbeat_interval: 1_000, session_id: "session-1" } });

    for (let i = 0; i < 4; i += 1) {
      vi.advanceTimersByTime(1_000);
      socket.message({ op: 2, d: { count: i + 1 } });
    }
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { op: 35, d: { type: "emote_set.update", condition: { object_id: "set-1" } } },
    ]);
    api.dispose();
  });

  it("closes after three missed server heartbeat intervals", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const api = createSevenTvEventApi({ socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    } });
    api.subscribe("emote_set.update", "set-1", () => undefined);
    sockets[0]!.readyState = 1;
    sockets[0]!.message({ op: 1, d: { heartbeat_interval: 1_000, session_id: "session-1" } });
    vi.advanceTimersByTime(2_999);
    expect(sockets[0]!.readyState).toBe(1);
    vi.advanceTimersByTime(1);
    expect(sockets[0]!.readyState).toBe(3);
    api.dispose();
  });

  it("unsubscribes the last listener for a condition with opcode 36", () => {
    const sockets: FakeSocket[] = [];
    const api = createSevenTvEventApi({ socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    } });
    const stop = api.subscribe("emote_set.update", "set-1", () => undefined);
    const socket = sockets[0]!;
    socket.readyState = 1;
    socket.message({ op: 1, d: { heartbeat_interval: 60_000, session_id: "session-1" } });
    stop();
    expect(socket.sent.map((message) => JSON.parse(message))).toEqual([
      { op: 35, d: { type: "emote_set.update", condition: { object_id: "set-1" } } },
      { op: 36, d: { type: "emote_set.update", condition: { object_id: "set-1" } } },
    ]);
    api.dispose();
  });

  it("resumes a session and notifies reconnect listeners without resubscribing restored conditions", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const api = createSevenTvEventApi({ random: () => 0, socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    } });
    const onReconnect = vi.fn();
    api.subscribe("emote_set.update", "set-1", () => undefined);
    api.onReconnect(onReconnect);
    const first = sockets[0]!;
    first.readyState = 1;
    first.message({ op: 1, d: { heartbeat_interval: 60_000, session_id: "session-1" } });
    first.message({ op: 5, d: { command: "SUBSCRIBE" } });
    first.close();
    vi.advanceTimersByTime(750);
    const second = sockets[1]!;
    second.readyState = 1;
    second.message({ op: 1, d: { heartbeat_interval: 60_000, session_id: "session-2" } });
    expect(second.sent.map((message) => JSON.parse(message))).toEqual([
      { op: 34, d: { session_id: "session-1" } },
    ]);
    second.message({ op: 5, d: { command: "RESUME", data: { session_id: "session-1" } } });
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(second.sent.map((message) => JSON.parse(message))).toHaveLength(1);
    api.dispose();
  });

  it("waits for hello before sending a new subscription on a reconnecting socket", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const api = createSevenTvEventApi({ random: () => 0, socketFactory: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    } });
    api.subscribe("emote_set.update", "set-1", () => undefined);
    const first = sockets[0]!;
    first.readyState = 1;
    first.message({ op: 1, d: { heartbeat_interval: 60_000, session_id: "session-1" } });
    first.message({ op: 5, d: { command: "SUBSCRIBE" } });
    first.close();
    vi.advanceTimersByTime(750);
    const second = sockets[1]!;
    second.readyState = 1;
    api.subscribe("entitlement.create", { ctx: "channel", platform: "TWITCH", id: "123" }, () => undefined);
    expect(second.sent).toEqual([]);
    second.message({ op: 1, d: { heartbeat_interval: 60_000, session_id: "session-2" } });
    expect(second.sent.map((message) => JSON.parse(message))).toEqual([
      { op: 34, d: { session_id: "session-1" } },
    ]);
    second.message({ op: 5, d: { command: "RESUME" } });
    expect(second.sent.map((message) => JSON.parse(message).op)).toEqual([34, 35]);
    api.dispose();
  });
});
