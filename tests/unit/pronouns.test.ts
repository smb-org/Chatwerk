import { describe, expect, it, vi } from "vitest";
import { createPronounLookup } from "../../src/renderer/pronouns";

const createStorage = () => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
  };
};

const response = (data: unknown): Response => new Response(JSON.stringify(data), { status: 200 });

describe("pronoun lookup", () => {
  it("maps a user's pronoun id and caches the result for the page", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/users/")
      ? response([{ login: "alice", pronoun_id: "theythem" }])
      : response([{ name: "theythem", display: "They/Them" }]));
    const lookup = createPronounLookup({ fetcher, storage: null });
    const first = lookup.lookup("Alice");
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toBe("They/Them");
    await expect(lookup.lookup("alice")).resolves.toBe("They/Them");
    expect(fetcher).toHaveBeenCalledTimes(2);
    lookup.dispose();
    vi.useRealTimers();
  });

  it("persists only a 24-hour cache when storage is available", async () => {
    vi.useFakeTimers();
    const storage = createStorage();
    let now = 10_000;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/users/")
      ? response([{ login: "viewer", pronoun_id: "sheher" }])
      : response([{ name: "sheher", display: "She/Her" }]));
    const first = createPronounLookup({ fetcher, storage, now: () => now });
    const lookup = first.lookup("viewer");
    await vi.advanceTimersByTimeAsync(0);
    await expect(lookup).resolves.toBe("She/Her");
    first.dispose();

    now += 24 * 60 * 60 * 1_000 - 1;
    const cached = createPronounLookup({ fetcher, storage, now: () => now });
    await expect(cached.lookup("viewer")).resolves.toBe("She/Her");
    expect(fetcher).toHaveBeenCalledTimes(2);
    cached.dispose();

    now += 2;
    const refreshed = createPronounLookup({ fetcher, storage, now: () => now });
    const refreshedLookup = refreshed.lookup("viewer");
    await vi.advanceTimersByTimeAsync(0);
    await expect(refreshedLookup).resolves.toBe("She/Her");
    expect(fetcher).toHaveBeenCalledTimes(4);
    refreshed.dispose();
    vi.useRealTimers();
  });

  it("turns provider failures and unavailable storage into an empty result", async () => {
    vi.useFakeTimers();
    const storage = {
      getItem: () => { throw new Error("storage disabled"); },
      setItem: () => { throw new Error("storage disabled"); },
    };
    const lookup = createPronounLookup({ fetcher: vi.fn().mockRejectedValue(new Error("offline")), storage });
    const result = lookup.lookup("viewer");
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBeNull();
    lookup.dispose();
    vi.useRealTimers();
  });

  it("retries a failed labels load on the next lookup instead of caching failure", async () => {
    vi.useFakeTimers();
    let labelsAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/users/")) return response([{ login: "viewer", pronoun_id: "theythem" }]);
      labelsAttempts += 1;
      if (labelsAttempts === 1) throw new Error("temporary failure");
      return response([{ name: "theythem", display: "They/Them" }]);
    });
    const lookup = createPronounLookup({ fetcher, storage: null });

    const failed = lookup.lookup("viewer");
    await vi.advanceTimersByTimeAsync(0);
    await expect(failed).resolves.toBeNull();
    const recovered = lookup.lookup("viewer");
    await vi.advanceTimersByTimeAsync(200);
    await expect(recovered).resolves.toBe("They/Them");
    expect(labelsAttempts).toBe(2);
    lookup.dispose();
    vi.useRealTimers();
  });
});
