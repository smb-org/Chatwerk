import { randomUUID } from "node:crypto";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULTS, SCHEMA_VERSION } from "../../src/shared/theme";
import {
  applyConfigRevision,
  nextReconnectDelayMs,
  parseLiveLocation,
  readLiveCache,
  showTestLine,
  startLiveUpdates,
  type LiveStorage,
} from "../../src/renderer/live";

class FakeSocket {
  readyState = 0;
  readonly sent: string[] = [];
  readonly listeners = new Map<string, Array<(event: { data?: string; code?: number }) => void>>();
  addEventListener(type: string, listener: (event: { data?: string; code?: number }) => void): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }
  send(value: string): void { this.sent.push(value); }
  close(): void { this.readyState = 3; }
  open(): void {
    this.readyState = 1;
    for (const listener of this.listeners.get("open") ?? []) listener({});
  }
  receive(value: unknown): void {
    for (const listener of this.listeners.get("message") ?? []) listener({ data: JSON.stringify(value) });
  }
  serverClose(code: number): void {
    this.readyState = 3;
    for (const listener of this.listeners.get("close") ?? []) listener({ code });
  }
}

const token = "A".repeat(43);
const storageStub = (): LiveStorage & { values: Map<string, string> } => {
  const values = new Map<string, string>();
  return {
    values,
    getItem(key) { return values.get(key) ?? null; },
    setItem(key, value) { values.set(key, value); },
    removeItem(key) { values.delete(key); },
  };
};

afterEach(() => vi.useRealTimers());

describe("live overlay client", () => {
  it("reads token, client and placement from the hash and preserves keyless channel previews", () => {
    expect(parseLiveLocation(`#token=${token}&client=widget&placement=origin`, "Chrome")).toEqual({
      token, client: "widget", placement: "origin", channel: null,
    });
    expect(parseLiveLocation("#channel=Foo_Bar", "OBS/31.0 Chrome")).toMatchObject({
      token: null, client: "obs", placement: "viewport", channel: "foo_bar",
    });
    expect(parseLiveLocation(`#token=bad&client=bogus`, "Chrome")).toMatchObject({
      token: null, client: "browser", placement: "viewport", channel: null,
    });
  });

  it("applies only a higher valid revision and keeps current state for a future schema", () => {
    const current = { revision: 3, config: DEFAULTS };
    expect(applyConfigRevision(current, { schemaVersion: SCHEMA_VERSION, revision: 3, config: { fontSize: 24 } }))
      .toMatchObject({ status: "unchanged", state: current });
    expect(applyConfigRevision(current, { schemaVersion: SCHEMA_VERSION + 1, revision: 4, config: { fontSize: 24 } }))
      .toMatchObject({ status: "update-required", state: current });
    expect(applyConfigRevision(current, { schemaVersion: SCHEMA_VERSION, revision: 4, config: { fontSize: 24 } }))
      .toMatchObject({ status: "applied", state: { revision: 4, config: { fontSize: 24 } } });
  });

  it("backs off from one second to thirty seconds with bounded jitter", () => {
    expect(nextReconnectDelayMs(0, () => 0)).toBe(1_000);
    expect(nextReconnectDelayMs(1, () => 0.5)).toBe(2_250);
    expect(nextReconnectDelayMs(20, () => 1)).toBe(30_000);
  });

  it("keeps increasing the retry delay when short-lived sockets keep opening", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const live = startLiveUpdates({
      hash: `#token=${token}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher: vi.fn<typeof fetch>(async () => { throw new TypeError("offline"); }),
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
      applyTheme: vi.fn(),
      registerServiceWorker: false,
      random: () => 0,
    });

    sockets[0]!.open();
    sockets[0]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    sockets[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(3);
    live.stop();
  });

  it("applies channel and config delivered by the socket after the config fetch fails", async () => {
    const socket = new FakeSocket();
    const applyTheme = vi.fn();
    const onChannel = vi.fn();
    const live = startLiveUpdates({
      hash: `#token=${token}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher: vi.fn<typeof fetch>(async () => { throw new TypeError("offline"); }),
      socketFactory: () => socket as unknown as WebSocket,
      applyTheme,
      onChannel,
      registerServiceWorker: false,
    });

    socket.open();
    socket.receive({
      type: "config", schemaVersion: SCHEMA_VERSION, revision: 1,
      config: { ...DEFAULTS, fontSize: 24 }, channel: "socket_room",
    });

    expect(live.getState()).toMatchObject({ revision: 1, config: { fontSize: 24 } });
    expect(applyTheme).toHaveBeenLastCalledWith(expect.objectContaining({ fontSize: 24 }));
    expect(onChannel).toHaveBeenCalledWith("socket_room");
    live.stop();
  });

  it("retries a failed config fetch with backoff until the channel is known", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const applyTheme = vi.fn();
    const onChannel = vi.fn();
    const fetcher = vi.fn<typeof fetch>()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(Response.json({
        revision: 2,
        schemaVersion: SCHEMA_VERSION,
        config: { ...DEFAULTS, fontSize: 25 },
        channel: "recovered_room",
      }));
    const live = startLiveUpdates({
      hash: `#token=${token}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher,
      socketFactory: () => socket as unknown as WebSocket,
      applyTheme,
      onChannel,
      registerServiceWorker: false,
      random: () => 0,
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetcher).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(live.getState()).toMatchObject({ revision: 2, config: { fontSize: 25 } });
    expect(onChannel).toHaveBeenCalledWith("recovered_room");
    await vi.advanceTimersByTimeAsync(300_000);
    expect(fetcher).toHaveBeenCalledTimes(3);
    live.stop();
  });

  it("does not let another token's higher cached revision suppress this overlay's config", async () => {
    const tokenA = "A".repeat(43);
    const tokenB = "B".repeat(43);
    const storage = storageStub();
    storage.setItem(`chatwerk-theme:${tokenA}`, JSON.stringify({
      revision: 50, config: { ...DEFAULTS, fontSize: 50 }, channel: "first_room",
    }));
    const applyTheme = vi.fn();
    const onChannel = vi.fn();
    const live = startLiveUpdates({
      hash: `#token=${tokenB}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher: vi.fn<typeof fetch>(async () => Response.json({
        revision: 3,
        schemaVersion: SCHEMA_VERSION,
        config: { ...DEFAULTS, fontSize: 24 },
        channel: "second_room",
      })),
      socketFactory: () => new FakeSocket() as unknown as WebSocket,
      storage,
      applyTheme,
      onChannel,
      registerServiceWorker: false,
    });

    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 24 })));

    expect(onChannel).toHaveBeenCalledWith("second_room");
    expect(live.getState()).toMatchObject({ revision: 3, config: { fontSize: 24 } });
    live.stop();
  });

  it("backs off for a rate limited live endpoint without probing config on each retry", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => new Response(null, { status: 429 }));
    const live = startLiveUpdates({
      hash: `#token=${token}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher,
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
      applyTheme: vi.fn(),
      registerServiceWorker: false,
      random: () => 0,
    });

    sockets[0]!.serverClose(1006);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(sockets).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(nextReconnectDelayMs(20, () => 0, 300_000)).toBe(300_000);
    live.stop();
  });

  it("treats two refused upgrades as a limit without another config probe", async () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      revision: 0, schemaVersion: SCHEMA_VERSION, config: DEFAULTS, channel: "room",
    }));
    const live = startLiveUpdates({
      hash: `#token=${token}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher,
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
      applyTheme: vi.fn(),
      registerServiceWorker: false,
      random: () => 0,
    });

    sockets[0]!.serverClose(1006);
    await vi.waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);

    expect(sockets).toHaveLength(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
    live.stop();
  });

  it("forgets a test-line cleanup after its five-second display timer", async () => {
    vi.useFakeTimers();
    const dom = new JSDOM("<!doctype html><main id='chat'></main>");
    const root = dom.window.document.querySelector("main") as HTMLElement;
    const socket = new FakeSocket();
    const cleanup = vi.fn();
    const live = startLiveUpdates({
      hash: `#token=${token}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher: vi.fn<typeof fetch>(async () => new Response(null, { status: 404 })),
      socketFactory: () => socket as unknown as WebSocket,
      applyTheme: vi.fn(),
      onTestLine: (id, onExpire) => {
        showTestLine(root, id, onExpire);
        return cleanup;
      },
      registerServiceWorker: false,
    });
    socket.receive({ type: "test-line", id: "temporary" });

    await vi.advanceTimersByTimeAsync(5_000);
    live.stop();

    expect(root.querySelector(".chat-system")).toBeNull();
    expect(cleanup).not.toHaveBeenCalled();
    dom.window.close();
  });

  it("treats blocked local storage as an optional cache", () => {
    const unavailable: LiveStorage = {
      getItem() { throw new DOMException("blocked", "SecurityError"); },
      setItem() { throw new DOMException("blocked", "SecurityError"); },
      removeItem() { throw new DOMException("blocked", "SecurityError"); },
    };
    expect(readLiveCache(unavailable)).toMatchObject({ state: { revision: -1, config: DEFAULTS }, channel: null });
  });

  it("fetches with the bearer header, connects without a token query, and acknowledges config and test ids", async () => {
    vi.useFakeTimers();
    const storage = storageStub();
    const sockets: FakeSocket[] = [];
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({
      revision: 1,
      schemaVersion: SCHEMA_VERSION,
      config: { ...DEFAULTS, fontSize: 24 },
      channel: "test_room",
    }));
    const applyTheme = vi.fn();
    const onChannel = vi.fn();
    const onTestLine = vi.fn();
    const live = startLiveUpdates({
      hash: `#token=${token}&client=widget&placement=origin`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher,
      socketFactory: (url, protocols) => {
        expect(url).toBe("wss://chatwerk.test/api/overlay/live");
        expect(protocols).toEqual(["chatwerk-live", token]);
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      storage,
      applyTheme,
      onChannel,
      onTestLine,
      getChatStatus: () => "connected",
      registerServiceWorker: false,
      random: () => 0,
    });

    await vi.waitFor(() => expect(applyTheme).toHaveBeenCalledWith(expect.objectContaining({ fontSize: 24 })));
    expect(fetcher).toHaveBeenCalledWith("https://chatwerk.test/api/overlay/config", expect.objectContaining({
      headers: { Authorization: `Bearer ${token}` },
    }));
    expect(new URL(String(fetcher.mock.calls[0]?.[0])).search).toBe("");
    expect(onChannel).toHaveBeenCalledWith("test_room");
    expect(JSON.parse([...storage.values.values()][0]!)).toMatchObject({ revision: 1, channel: "test_room" });

    const socket = sockets[0]!;
    socket.open();
    expect(JSON.parse(socket.sent[0]!)).toMatchObject({ type: "hello", client: "widget" });
    socket.receive({ type: "config", schemaVersion: SCHEMA_VERSION, revision: 1, config: { ...DEFAULTS, fontSize: 24 } });
    socket.receive({ type: "test-line", id: "test-id-1" });
    expect(onTestLine).toHaveBeenCalledWith("test-id-1", expect.any(Function));
    expect(socket.sent.map((line) => JSON.parse(line))).toContainEqual({
      type: "ack", revision: 1, chatStatus: "connected", testId: "test-id-1",
    });
    live.stop();
  });

  it("pings every twenty seconds and immediately when a hidden tab becomes visible", async () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const listeners = new Map<string, () => void>();
    const visibilityTarget = {
      visibilityState: "hidden" as DocumentVisibilityState,
      addEventListener(type: string, listener: EventListenerOrEventListenerObject) {
        listeners.set(type, listener as () => void);
      },
      removeEventListener(type: string) { listeners.delete(type); },
    };
    const live = startLiveUpdates({
      hash: `#token=${token}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher: vi.fn<typeof fetch>(async () => { throw new TypeError("offline"); }),
      socketFactory: () => socket as unknown as WebSocket,
      applyTheme: vi.fn(),
      visibilityTarget,
      registerServiceWorker: false,
      random: () => 0,
    });
    socket.open();
    expect(socket.sent.filter((message) => message === "ping")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(socket.sent.filter((message) => message === "ping")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(socket.sent.filter((message) => message === "ping")).toHaveLength(1);
    visibilityTarget.visibilityState = "visible";
    listeners.get("visibilitychange")?.();
    expect(socket.sent.filter((message) => message === "ping")).toHaveLength(2);
    live.stop();
  });

  it("clears cache and output only after a confirmed 4001 revocation", async () => {
    vi.useFakeTimers();
    const storage = storageStub();
    storage.setItem(`chatwerk-theme:${token}`, JSON.stringify({ revision: 0, config: DEFAULTS, channel: "test_room" }));
    const sockets: FakeSocket[] = [];
    const onRevoked = vi.fn();
    const fetcher = vi.fn<typeof fetch>(async () => { throw new TypeError("offline"); });
    const live = startLiveUpdates({
      hash: `#token=${token}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher,
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
      storage,
      applyTheme: vi.fn(),
      onRevoked,
      registerServiceWorker: false,
      random: () => 0,
    });
    sockets[0]!.serverClose(1006);
    expect(storage.values.has(`chatwerk-theme:${token}`)).toBe(true);
    expect(onRevoked).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(sockets).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(sockets).toHaveLength(2);
    sockets[1]!.serverClose(4001);
    expect(storage.values.has(`chatwerk-theme:${token}`)).toBe(false);
    expect(onRevoked).toHaveBeenCalledTimes(1);
    live.stop();
  });

  it("ignores a config response that finishes after confirmed revocation", async () => {
    vi.useFakeTimers();
    const storage = storageStub();
    const sockets: FakeSocket[] = [];
    let resolveFetch!: (response: Response) => void;
    const fetcher = vi.fn<typeof fetch>(() => new Promise((resolve) => { resolveFetch = resolve; }));
    const applyTheme = vi.fn();
    const onChannel = vi.fn();
    const onRevoked = vi.fn();
    const live = startLiveUpdates({
      hash: `#token=${token}`,
      origin: "https://chatwerk.test",
      userAgent: "Chrome",
      fetcher,
      socketFactory: () => { const socket = new FakeSocket(); sockets.push(socket); return socket as unknown as WebSocket; },
      storage,
      applyTheme,
      onChannel,
      onRevoked,
      registerServiceWorker: false,
    });

    sockets[0]!.serverClose(4001);
    resolveFetch(Response.json({
      revision: 1, schemaVersion: SCHEMA_VERSION,
      config: { ...DEFAULTS, fontSize: 24 }, channel: "revoked_room",
    }));
    await vi.advanceTimersByTimeAsync(0);

    expect(onRevoked).toHaveBeenCalledTimes(1);
    expect(onChannel).not.toHaveBeenCalled();
    expect(applyTheme).toHaveBeenCalledTimes(1);
    expect(storage.values.has(`chatwerk-theme:${token}`)).toBe(false);
    expect(sockets).toHaveLength(1);
    live.stop();
  });

  it("shows the exact local test line for five seconds", () => {
    vi.useFakeTimers();
    const dom = new JSDOM("<!doctype html><main id='chat'></main>");
    const root = dom.window.document.querySelector("main") as HTMLElement;
    const cleanup = showTestLine(root, randomUUID());

    expect(root.querySelector(".chat-system")?.textContent).toBe("Test line. Your chat appears here.");
    vi.advanceTimersByTime(4_999);
    expect(root.querySelector(".chat-system")).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(root.querySelector(".chat-system")).toBeNull();
    cleanup();
    dom.window.close();
  });
});
