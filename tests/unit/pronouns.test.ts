import { afterEach, describe, expect, it, vi } from "vitest";
import { createPronounLookup } from "../../src/renderer/pronouns";

const createStorage = () => {
  const entries = new Map<string, string>();
  return {
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
  };
};

const response = (data: unknown, status = 200): Response =>
  new Response(JSON.stringify(data), { status });

const pronounList = {
  aeaer: { name: "aeaer", subject: "Ae", object: "Aer", singular: false },
  any: { name: "any", subject: "Any", object: "Any", singular: true },
  eem: { name: "eem", subject: "E", object: "Em", singular: false },
  faefaer: { name: "faefaer", subject: "Fae", object: "Faer", singular: false },
  hehim: { name: "hehim", subject: "He", object: "Him", singular: false },
  itits: { name: "itits", subject: "It", object: "Its", singular: false },
  other: { name: "other", subject: "Other", object: "Other", singular: true },
  perper: { name: "perper", subject: "Per", object: "Per", singular: false },
  sheher: { name: "sheher", subject: "She", object: "Her", singular: false },
  theythem: { name: "theythem", subject: "They", object: "Them", singular: false },
  vever: { name: "vever", subject: "Ve", object: "Ver", singular: false },
  xexem: { name: "xexem", subject: "Xe", object: "Xem", singular: false },
  ziehir: { name: "ziehir", subject: "Zie", object: "Hir", singular: false },
};

const userResponse = (login: string, pronounId: string) => ({
  channel_id: "64697598",
  channel_login: login,
  pronoun_id: pronounId,
  alt_pronoun_id: null,
});

afterEach(() => {
  vi.useRealTimers();
});

describe("pronoun lookup", () => {
  it("uses the v1 response shapes and caches the result for the page", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://api.pronouns.alejo.io/v1/users/alejo_47") {
        return response({
          channel_id: "64697598",
          channel_login: "alejo_47",
          pronoun_id: "hehim",
          alt_pronoun_id: null,
        });
      }
      if (url === "https://api.pronouns.alejo.io/v1/pronouns") {
        return response({ hehim: pronounList.hehim });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const lookup = createPronounLookup({ fetcher, storage: null });
    const first = lookup.lookup("Alejo_47");
    await vi.advanceTimersByTimeAsync(0);
    await expect(first).resolves.toBe("He/Him");
    await expect(lookup.lookup("alejo_47")).resolves.toBe("He/Him");
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://api.pronouns.alejo.io/v1/users/alejo_47",
      "https://api.pronouns.alejo.io/v1/pronouns",
    ]);
    lookup.dispose();
  });

  it.each([
    ["hehim", "He/Him"],
    ["sheher", "She/Her"],
    ["theythem", "They/Them"],
    ["any", "Any/Any"],
    ["other", "Other/Other"],
    ["xexem", "Xe/Xem"],
    ["faefaer", "Fae/Faer"],
    ["vever", "Ve/Ver"],
    ["aeaer", "Ae/Aer"],
    ["ziehir", "Zie/Hir"],
    ["perper", "Per/Per"],
    ["eem", "E/Em"],
    ["itits", "It/Its"],
  ])("keeps the legacy label for %s", async (pronounId, expected) => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/v1/users/")) return response(userResponse("viewer", pronounId));
      return response(pronounList);
    });
    const lookup = createPronounLookup({ fetcher, storage: null, requestIntervalMs: 100 });
    const result = lookup.lookup("viewer");
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBe(expected);
    lookup.dispose();
  });

  it("treats a user 404 as cached absence without requesting labels", async () => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async () => new Response("not_found", { status: 404 }));
    const lookup = createPronounLookup({ fetcher, storage: null });
    const result = lookup.lookup("nopronouns");
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBeNull();
    await expect(lookup.lookup("nopronouns")).resolves.toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.pronouns.alejo.io/v1/users/nopronouns",
      expect.objectContaining({ mode: "cors" }),
    );
    lookup.dispose();
  });

  it.each([
    ["malformed user body", response({ channel_login: "viewer", pronoun_id: 3 }), response(pronounList)],
    ["malformed pronoun entry", response(userResponse("viewer", "hehim")), response({ hehim: { name: "hehim", subject: 4, object: "Him", singular: false } })],
    ["invalid JSON", response(userResponse("viewer", "hehim")), new Response("{", { status: 200 })],
  ])("returns no pronouns for a %s", async (_description, userBody, labelsBody) => {
    vi.useFakeTimers();
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/v1/users/") ? userBody : labelsBody);
    const lookup = createPronounLookup({ fetcher, storage: null });
    const result = lookup.lookup("viewer");
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toBeNull();
    lookup.dispose();
  });

  it("persists only a 24-hour cache when storage is available", async () => {
    vi.useFakeTimers();
    const storage = createStorage();
    let now = 10_000;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/v1/users/")
      ? response(userResponse("viewer", "sheher"))
      : response(pronounList));
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
  });

  it("retries a failed labels load on the next lookup instead of caching failure", async () => {
    vi.useFakeTimers();
    let labelsAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).includes("/v1/users/")) return response(userResponse("viewer", "theythem"));
      labelsAttempts += 1;
      if (labelsAttempts === 1) throw new Error("temporary failure");
      return response(pronounList);
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
  });
});
