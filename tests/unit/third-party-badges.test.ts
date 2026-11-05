import { afterEach, describe, expect, it, vi } from "vitest";
import { createThirdPartyBadgeLookup, type ThirdPartyBadgeProvider } from "../../src/renderer/third-party-badges";

const providerUrls: Record<ThirdPartyBadgeProvider, string> = {
  badgesBttv: "https://api.betterttv.net/3/cached/badges/twitch",
  badgesFfz: "https://api.frankerfacez.com/v1/badges/ids",
  badgesChatterino: "https://api.chatterino.com/badges",
  badgesHomies: "https://chatterinohomies.com/api/badges/list",
};

const fixtures: Record<ThirdPartyBadgeProvider, unknown> = {
  badgesBttv: [{
    id: "bttv-1", name: "night", displayName: "Night", providerId: "42",
    badge: { description: "NightDev Developer", svg: "https://cdn.betterttv.net/badges/developer.svg" },
  }],
  badgesFfz: {
    badges: [{ id: 7, name: "vip", title: "FFZ VIP", urls: { "2": "https://cdn.frankerfacez.com/badge/7/2" } }],
    users: { "7": [42] },
  },
  badgesChatterino: {
    badges: [{ tooltip: "Chatterino donor", users: ["42"], image3: "https://fourtf.com/chatterino/badges/topd3x.png" }],
  },
  badgesHomies: {
    badges: [{
      userId: "42",
      username: "viewer",
      tooltip: "Homies member",
      image1: "https://cdn.chatterinohomies.com/badges/42/18.webp",
      image2: "https://cdn.chatterinohomies.com/badges/42/36.webp",
      image3: "https://cdn.chatterinohomies.com/badges/42/72.webp",
    }],
  },
};

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function enabledLookup(fetcher: typeof fetch) {
  const lookup = createThirdPartyBadgeLookup({ fetcher });
  for (const provider of Object.keys(providerUrls) as ThirdPartyBadgeProvider[]) lookup.setEnabled(provider, true);
  return lookup;
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("third-party badge lookup", () => {
  it("loads each enabled source once and resolves one ordered list per Twitch user id", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const provider = (Object.keys(providerUrls) as ThirdPartyBadgeProvider[])
        .find((key) => providerUrls[key] === String(input));
      return response(provider ? fixtures[provider] : {});
    });
    const lookup = enabledLookup(fetcher);
    await Promise.all([lookup.load("42"), lookup.load("42")]);

    expect(fetcher).toHaveBeenCalledTimes(4);
    expect(new Set(fetcher.mock.calls.map(([url]) => String(url)))).toEqual(new Set(Object.values(providerUrls)));
    expect(lookup.resolve("42")).toEqual([
      expect.objectContaining({ provider: "badgesBttv", name: "Night" }),
      expect.objectContaining({ provider: "badgesFfz", name: "vip" }),
      expect.objectContaining({ provider: "badgesChatterino", name: "Chatterino donor" }),
      expect.objectContaining({ provider: "badgesHomies", name: "Homies member", url: "https://cdn.chatterinohomies.com/badges/42/72.webp" }),
    ]);
    lookup.dispose();
  });

  it("does not request a disabled source", async () => {
    const fetcher = vi.fn(async () => response([]));
    const lookup = createThirdPartyBadgeLookup({ fetcher });
    lookup.setEnabled("badgesBttv", true);
    await lookup.load("42");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(providerUrls.badgesBttv, expect.any(Object));
    lookup.dispose();
  });

  it("fetches the Homies list only while enabled and only once", async () => {
    const fetcher = vi.fn(async () => response(fixtures.badgesHomies));
    const lookup = createThirdPartyBadgeLookup({ fetcher });
    await lookup.load("42");
    expect(fetcher).not.toHaveBeenCalled();
    lookup.setEnabled("badgesHomies", true);
    await lookup.load("42");
    await lookup.load("43");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith(providerUrls.badgesHomies, expect.objectContaining({ mode: "cors" }));
    lookup.dispose();
  });

  it("drops images outside each provider's expected HTTPS host", async () => {
    const hostile: Record<ThirdPartyBadgeProvider, unknown> = {
      badgesBttv: [{ providerId: "42", name: "bad", badge: { description: "Bad", svg: "https://cdn.7tv.app/badge.png" } }],
      badgesFfz: { badges: [{ id: 1, name: "bad", title: "Bad", urls: { "2": "https://evil.example/badge.png" } }], users: { "42": [1] } },
      badgesChatterino: { badges: [{ tooltip: "Bad", users: ["42"], image3: "http://fourtf.com/badge.png" }] },
      badgesHomies: { badges: [{ userId: "42", tooltip: "Bad", image3: "https://evil.example/badge.webp" }] },
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const provider = (Object.keys(providerUrls) as ThirdPartyBadgeProvider[])
        .find((key) => providerUrls[key] === String(input));
      return response(provider ? hostile[provider] : {});
    });
    const lookup = enabledLookup(fetcher);
    await lookup.load("42");
    expect(lookup.resolve("42")).toEqual([]);
    lookup.dispose();
  });

  it("keeps working when one source fails and does not log source failures", async () => {
    const errors = vi.spyOn(console, "error");
    const warnings = vi.spyOn(console, "warn");
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === providerUrls.badgesFfz) return response({}, 503);
      const provider = (Object.keys(providerUrls) as ThirdPartyBadgeProvider[])
        .find((key) => providerUrls[key] === String(input));
      return response(provider ? fixtures[provider] : {});
    });
    const lookup = enabledLookup(fetcher);
    await expect(lookup.load("42")).resolves.toBeUndefined();
    expect(lookup.resolve("42").map((badge) => badge.provider)).toEqual(["badgesBttv", "badgesChatterino", "badgesHomies"]);
    expect(errors).not.toHaveBeenCalled();
    expect(warnings).not.toHaveBeenCalled();
    lookup.dispose();
  });

  it("retries a failed source after one minute but does not retry more often", async () => {
    vi.useFakeTimers();
    let calls = 0;
    const fetcher = vi.fn(async () => {
      calls += 1;
      return calls === 1 ? response({}, 503) : response([]);
    });
    const lookup = createThirdPartyBadgeLookup({ fetcher });
    lookup.setEnabled("badgesBttv", true);

    await lookup.load("42");
    await lookup.load("42");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(59_999);
    await lookup.load("42");
    expect(fetcher).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await lookup.load("42");

    expect(fetcher).toHaveBeenCalledTimes(2);
    lookup.dispose();
  });

  it("allows 30 seconds for Homies, keeps four seconds for other sources, and honors a custom timeout", async () => {
    vi.useFakeTimers();
    const signals = new Map<string, AbortSignal>();
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const url = String(input);
      if (init?.signal) signals.set(url, init.signal);
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const lookup = createThirdPartyBadgeLookup({ fetcher });
    lookup.setEnabled("badgesBttv", true);
    lookup.setEnabled("badgesHomies", true);
    const pending = lookup.load("42");

    await vi.advanceTimersByTimeAsync(4_000);
    expect(signals.get(providerUrls.badgesBttv)?.aborted).toBe(true);
    expect(signals.get(providerUrls.badgesHomies)?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(26_000);
    await pending;
    expect(signals.get(providerUrls.badgesHomies)?.aborted).toBe(true);
    lookup.dispose();

    const customSignal = vi.fn();
    const customFetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        customSignal();
        reject(new DOMException("aborted", "AbortError"));
      }, { once: true });
    }));
    const customLookup = createThirdPartyBadgeLookup({ fetcher: customFetcher, timeoutMs: 250 });
    customLookup.setEnabled("badgesHomies", true);
    const customPending = customLookup.load("42");
    await vi.advanceTimersByTimeAsync(249);
    expect(customSignal).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await customPending;
    expect(customSignal).toHaveBeenCalledOnce();
    customLookup.dispose();
  });

  it("reloads an aborted source when the user turns it off and back on", async () => {
    let calls = 0;
    const fetcher = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
      calls += 1;
      if (calls > 1) return Promise.resolve(response([]));
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
      });
    });
    const lookup = createThirdPartyBadgeLookup({ fetcher });
    lookup.setEnabled("badgesBttv", true);
    const firstLoad = lookup.load("42");
    lookup.setEnabled("badgesBttv", false);
    lookup.setEnabled("badgesBttv", true);
    const secondLoad = lookup.load("42");
    await Promise.all([firstLoad, secondLoad]);

    expect(fetcher).toHaveBeenCalledTimes(2);
    lookup.dispose();
  });
});
