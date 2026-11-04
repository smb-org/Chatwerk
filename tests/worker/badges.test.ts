import { describe, expect, it, vi } from "vitest";
import { handleBadgeRequest, type BadgeEnvironment } from "../../src/worker/badges";

const envFor = (suffix = crypto.randomUUID()): BadgeEnvironment => ({
  TWITCH_CLIENT_ID: `client-${suffix}`,
  TWITCH_CLIENT_SECRET: `secret-${suffix}`,
});

function installCache() {
  const values = new Map<string, Response>();
  const requestUrl = (request: RequestInfo | URL): string =>
    request instanceof Request ? request.url : String(request);
  const cache = {
    async match(request: RequestInfo | URL) { return values.get(requestUrl(request))?.clone(); },
    async put(request: RequestInfo | URL, response: Response) { values.set(requestUrl(request), response.clone()); },
    async delete(request: RequestInfo | URL) { return values.delete(requestUrl(request)); },
  } as unknown as Cache;
  Object.defineProperty(globalThis, "caches", { configurable: true, value: { default: cache } });
  return values;
}

function twitchFetcher(data: unknown[], token = "app-token") {
  const seen: Request[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    seen.push(request);
    if (request.url.includes("oauth2/token")) {
      return Response.json({ access_token: token, expires_in: 3600, token_type: "bearer" });
    }
    return Response.json({ data, pagination: {} });
  };
  return { fetcher, seen };
}

describe("Twitch badge proxy", () => {
  it("fetches global chat badges with app credentials and returns the Twitch payload", async () => {
    installCache();
    const env = envFor();
    const badgeSet = { set_id: "moderator", versions: [{ id: "1" }] };
    const { fetcher, seen } = twitchFetcher([badgeSet]);
    const response = await handleBadgeRequest(new Request("https://chatwerk.test/api/twitch/badges/global"), env, fetcher);

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ data: [badgeSet], pagination: {} });
    expect(seen.map(({ url }) => new URL(url).pathname)).toEqual([
      "/oauth2/token", "/helix/chat/badges/global",
    ]);
    expect(seen[1]?.headers.get("client-id")).toBe(env.TWITCH_CLIENT_ID);
    expect(seen[1]?.headers.get("authorization")).toBe("Bearer app-token");
  });

  it("fetches broadcaster badges with the numeric broadcaster id", async () => {
    installCache();
    const { fetcher, seen } = twitchFetcher([]);
    const response = await handleBadgeRequest(new Request("https://chatwerk.test/api/twitch/badges/123456"), envFor(), fetcher);

    expect(response?.status).toBe(200);
    expect(new URL(seen[1]!.url).searchParams.get("broadcaster_id")).toBe("123456");
  });

  it("rejects non-numeric broadcaster ids before requesting Twitch", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await handleBadgeRequest(new Request("https://chatwerk.test/api/twitch/badges/abc"), envFor(), fetcher);

    expect(response?.status).toBe(400);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns null for routes outside the badge API", async () => {
    const fetcher = vi.fn<typeof fetch>();
    expect(await handleBadgeRequest(new Request("https://chatwerk.test/api/other"), envFor(), fetcher)).toBeNull();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("caches an app token and successful badge response", async () => {
    installCache();
    const env = envFor();
    const { fetcher, seen } = twitchFetcher([{ set_id: "subscriber" }]);
    const request = () => new Request("https://chatwerk.test/api/twitch/badges/global");

    await handleBadgeRequest(request(), env, fetcher);
    const second = await handleBadgeRequest(request(), env, fetcher);

    expect(seen.filter(({ url }) => new URL(url).pathname === "/oauth2/token")).toHaveLength(1);
    expect(seen.filter(({ url }) => new URL(url).pathname === "/helix/chat/badges/global")).toHaveLength(1);
    expect(await second?.json()).toEqual({ data: [{ set_id: "subscriber" }], pagination: {} });
    expect(second?.headers.get("cache-control")).toBe("public, max-age=3600, stale-while-revalidate=86400");
  });

  it("caches an empty negative result for a broadcaster Twitch does not recognize", async () => {
    installCache();
    const env = envFor();
    const seen: Request[] = [];
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      seen.push(request);
      if (request.url.includes("oauth2/token")) return Response.json({ access_token: "app-token", expires_in: 3600 });
      return Response.json({ error: "not found" }, { status: 404 });
    };
    const request = () => new Request("https://chatwerk.test/api/twitch/badges/999999999999");

    const first = await handleBadgeRequest(request(), env, fetcher);
    const second = await handleBadgeRequest(request(), env, fetcher);

    expect(first?.status).toBe(200);
    expect(await first?.json()).toEqual({ data: [], pagination: {} });
    expect(await second?.json()).toEqual({ data: [], pagination: {} });
    expect(seen.filter(({ url }) => new URL(url).pathname === "/helix/chat/badges")).toHaveLength(1);
  });

  it("caps upstream misses at thirty per minute and serves empty data above the ceiling", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 120_000);
    installCache();
    const env = envFor();
    const { fetcher, seen } = twitchFetcher([]);
    try {
      for (let index = 0; index < 30; index += 1) {
        await handleBadgeRequest(new Request(`https://chatwerk.test/api/twitch/badges/${100_000 + index}`), env, fetcher);
      }
      const limited = await handleBadgeRequest(new Request("https://chatwerk.test/api/twitch/badges/200000"), env, fetcher);

      expect(limited?.status).toBe(200);
      expect(await limited?.json()).toEqual({ data: [], pagination: {} });
      expect(seen.filter(({ url }) => new URL(url).pathname === "/helix/chat/badges")).toHaveLength(30);

      await vi.advanceTimersByTimeAsync(60_001);
      const recovered = await handleBadgeRequest(new Request("https://chatwerk.test/api/twitch/badges/200001"), env, fetcher);
      expect(recovered?.status).toBe(200);
      expect(seen.filter(({ url }) => new URL(url).pathname === "/helix/chat/badges")).toHaveLength(31);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-mints the app token once after Twitch returns 401", async () => {
    installCache();
    const env = envFor();
    let apiAttempts = 0;
    let tokenMints = 0;
    const fetcher: typeof fetch = async (input, init) => {
      const request = new Request(input, init);
      if (request.url.includes("oauth2/token")) {
        tokenMints += 1;
        return Response.json({ access_token: `app-token-${tokenMints}`, expires_in: 3600 });
      }
      apiAttempts += 1;
      if (apiAttempts === 1) return new Response(null, { status: 401 });
      expect(request.headers.get("authorization")).toBe("Bearer app-token-2");
      return Response.json({ data: [], pagination: {} });
    };

    const response = await handleBadgeRequest(new Request("https://chatwerk.test/api/twitch/badges/global"), env, fetcher);

    expect(response?.status).toBe(200);
    expect(tokenMints).toBe(2);
    expect(apiAttempts).toBe(2);
  });

  it("revalidates stale entries in the background and serves stale data if upstream fails", async () => {
    const values = installCache();
    const env = envFor();
    const url = "https://chatwerk.test/api/twitch/badges/global";
    values.set(url, Response.json({ data: [{ set_id: "cached" }], pagination: {} }, {
      headers: {
        "Cache-Control": "public, max-age=3600, stale-while-revalidate=86400",
        "X-Chatwerk-Cached-At": String(Date.now() - 3_600_001),
      },
    }));
    const fetcher: typeof fetch = async () => { throw new Error("upstream unavailable"); };
    const pending: Promise<unknown>[] = [];
    const response = await handleBadgeRequest(new Request(url), env, fetcher, (promise) => pending.push(promise));
    await Promise.all(pending.map((promise) => promise.catch(() => undefined)));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({ data: [{ set_id: "cached" }], pagination: {} });
  });

  it("supports wildcard CORS for reads and preflight", async () => {
    installCache();
    const { fetcher } = twitchFetcher([]);
    const response = await handleBadgeRequest(new Request("https://chatwerk.test/api/twitch/badges/global", {
      headers: { Origin: "null" },
    }), envFor(), fetcher);
    const preflight = await handleBadgeRequest(new Request("https://chatwerk.test/api/twitch/badges/global", {
      method: "OPTIONS", headers: { Origin: "null", "Access-Control-Request-Headers": "authorization" },
    }), envFor(), fetcher);

    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight?.status).toBe(204);
    expect(preflight?.headers.get("access-control-allow-origin")).toBe("*");
    expect(preflight?.headers.get("access-control-allow-methods")).toContain("GET");
  });

  it("returns 503 when app credentials are missing", async () => {
    const response = await handleBadgeRequest(
      new Request("https://chatwerk.test/api/twitch/badges/global"), {}, vi.fn<typeof fetch>(),
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toMatchObject({ error: "Badge proxy is not configured" });
  });

  it("never exposes the app token or secret when token minting fails", async () => {
    installCache();
    const env = envFor();
    const fetcher: typeof fetch = async () => Response.json({ error: `${env.TWITCH_CLIENT_SECRET}-sensitive` }, { status: 401 });
    const response = await handleBadgeRequest(new Request("https://chatwerk.test/api/twitch/badges/global"), env, fetcher);
    const body = await response?.text() ?? "";

    expect(response?.status).toBe(502);
    expect(body).not.toContain(env.TWITCH_CLIENT_SECRET!);
    expect(body).not.toContain("access_token");
    expect(response?.headers.get("access-control-allow-origin")).toBe("*");
  });
});
