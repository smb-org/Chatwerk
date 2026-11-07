import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoomNameLookup } from "../../src/renderer/room-names";

afterEach(() => vi.useRealTimers());

describe("Twitch room name lookup", () => {
  it("resolves a validated Twitch display name from the IVR user array", async () => {
    const fetcher = vi.fn(async () => Response.json([{ id: "20", login: "partner", displayName: "Partner_7", logo: "https://static-cdn.jtvnw.net/user.png" }]));
    const names = createRoomNameLookup({ fetcher });

    await expect(names.lookup("20")).resolves.toEqual({ displayName: "Partner_7", logo: "https://static-cdn.jtvnw.net/user.png" });
    expect(fetcher).toHaveBeenCalledWith("https://api.ivr.fi/v2/twitch/user?id=20", {
      mode: "cors",
      signal: expect.any(AbortSignal),
    });
  });

  it("temporarily caches a network failure and retries after its TTL", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockResolvedValueOnce(Response.json([{ id: "20", login: "partner", displayName: "Partner" }]));
    const names = createRoomNameLookup({ fetcher, failureTtlMs: 1_000 });

    await expect(names.lookup("20")).resolves.toBeNull();
    await expect(names.lookup("20")).resolves.toBeNull();
    await vi.advanceTimersByTimeAsync(999);
    await expect(names.lookup("20")).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(names.lookup("20")).resolves.toMatchObject({ displayName: "Partner" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("temporarily caches server failures and retries after their TTL", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response("unavailable", { status: 503 }))
      .mockResolvedValueOnce(Response.json([{ id: "20", login: "partner", displayName: "Partner" }]));
    const names = createRoomNameLookup({ fetcher, failureTtlMs: 1_000 });

    await expect(names.lookup("20")).resolves.toBeNull();
    await expect(names.lookup("20")).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(names.lookup("20")).resolves.toMatchObject({ displayName: "Partner" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("keeps 404 and invalid successful responses as definitive cached misses", async () => {
    vi.useFakeTimers();
    for (const firstResponse of [new Response(null, { status: 404 }), Response.json({ invalid: true })]) {
      const fetcher = vi.fn()
        .mockResolvedValueOnce(firstResponse)
        .mockResolvedValueOnce(Response.json([{ id: "20", login: "partner", displayName: "Partner" }]));
      const names = createRoomNameLookup({ fetcher, failureTtlMs: 10 });

      await expect(names.lookup("20")).resolves.toBeNull();
      await vi.advanceTimersByTimeAsync(100);
      await expect(names.lookup("20")).resolves.toBeNull();
      expect(fetcher).toHaveBeenCalledTimes(1);
    }
  });

  it("deduplicates concurrent lookups for the same room", async () => {
    let resolveResponse!: (response: Response) => void;
    const fetcher = vi.fn(() => new Promise<Response>((resolve) => { resolveResponse = resolve; }));
    const names = createRoomNameLookup({ fetcher });
    const first = names.lookup("20");
    const second = names.lookup("20");

    expect(fetcher).toHaveBeenCalledTimes(1);
    resolveResponse(Response.json([{ id: "20", login: "partner", displayName: "伙伴", logo: null }]));
    await expect(Promise.all([first, second])).resolves.toEqual([
      { displayName: "伙伴", logo: null }, { displayName: "伙伴", logo: null },
    ]);
  });

  it("rejects malformed payloads and unsafe or overlong display names", async () => {
    const payloads: unknown[] = [
      { login: "partner", displayName: "Partner" },
      [],
      [{ displayName: "Partner" }],
      [{ login: "not a login", displayName: "Partner" }],
      [{ login: "partner", displayName: "<img>" }],
      [{ login: "partner", displayName: "x".repeat(26) }],
    ];

    for (const payload of payloads) {
      const names = createRoomNameLookup({ fetcher: async () => Response.json(payload) });
      await expect(names.lookup("20")).resolves.toBeNull();
    }
  });

  it("stops a slow request at its timeout and does not request fake room IDs", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })).mockImplementationOnce((_input, init) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    })).mockResolvedValueOnce(Response.json([{ id: "20", login: "partner", displayName: "Partner" }]));
    const names = createRoomNameLookup({ fetcher, timeoutMs: 40, failureTtlMs: 60 });
    const pending = names.lookup("20");

    await vi.advanceTimersByTimeAsync(40);
    await expect(pending).resolves.toBeNull();
    await expect(names.lookup("studio-fake-room")).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60);
    await expect(names.lookup("20")).resolves.toMatchObject({ displayName: "Partner" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
