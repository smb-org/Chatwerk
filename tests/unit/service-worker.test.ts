import { readFileSync } from "node:fs";
import { Script } from "node:vm";
import { describe, expect, it, vi } from "vitest";

const source = readFileSync(new URL("../../public/overlay-sw.js", import.meta.url), "utf8");

type ExtendEventLike = { waitUntil(value: Promise<unknown>): void };
type FetchEventLike = { request: Request; respondWith(value: Promise<Response> | Response): void };
type MessageEventLike = { data: unknown; waitUntil(value: Promise<unknown>): void };
type WorkerEventLike = ExtendEventLike | FetchEventLike | MessageEventLike;

function serviceWorkerHarness(fetcher: (request: Request) => Promise<Response>) {
  const handlers = new Map<string, (event: WorkerEventLike) => void>();
  const stores = new Map<string, Map<string, Response>>();
  const cacheStorage = {
    open: vi.fn(async (name: string) => {
      let entries = stores.get(name);
      if (!entries) {
        entries = new Map();
        stores.set(name, entries);
      }
      return {
        match: vi.fn(async (request: Request) => entries?.get(request.url)?.clone()),
        put: vi.fn(async (request: Request, response: Response) => { entries?.set(request.url, response.clone()); }),
        keys: vi.fn(async () => [...(entries?.keys() ?? [])].map((url) => new Request(url))),
        delete: vi.fn(async (request: Request) => entries?.delete(request.url) ?? false),
      };
    }),
    keys: vi.fn(async () => [...stores.keys()]),
    delete: vi.fn(async (name: string) => stores.delete(name)),
    match: vi.fn(async (request: Request) => {
      for (const entries of stores.values()) {
        const response = entries.get(request.url);
        if (response) return response.clone();
      }
      return undefined;
    }),
  };
  const workerSelf = {
    location: { origin: "https://chatwerk.test" },
    addEventListener: (name: string, callback: (event: WorkerEventLike) => void) => handlers.set(name, callback),
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
  };
  const workerFetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = input instanceof Request ? input : new Request(input, init);
    return fetcher(request);
  };
  new Script(source).runInNewContext({ self: workerSelf, caches: cacheStorage, fetch: workerFetch, URL, Request, Response, Date, Math });
  return {
    cacheStorage,
    async fetch(request: Request): Promise<Response | undefined> {
      let response: Promise<Response> | Response | undefined;
      (handlers.get("fetch") as ((event: FetchEventLike) => void) | undefined)?.({ request, respondWith: (value) => { response = value; } });
      return response ? await response : undefined;
    },
    async message(data: unknown): Promise<void> {
      let work: Promise<unknown> = Promise.resolve();
      (handlers.get("message") as ((event: MessageEventLike) => void) | undefined)?.({ data, waitUntil: (value) => { work = value; } });
      await work;
    },
    async lifecycle(name: "install" | "activate"): Promise<void> {
      let work: Promise<unknown> = Promise.resolve();
      (handlers.get(name) as ((event: ExtendEventLike) => void) | undefined)?.({ waitUntil: (value) => { work = value; } });
      await work;
    },
    async cached(path: string): Promise<Response | undefined> {
      return cacheStorage.match(new Request(`https://chatwerk.test${path}`));
    },
  };
}

describe("overlay service worker cache", () => {
  it("fetches every referenced asset before caching an overlay page pair", async () => {
    const html = '<script src="/assets/app.js"></script><link rel="stylesheet" href="/assets/app.css">';
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/overlay") return new Response(html, { status: 200 });
      return new Response(`${url.pathname} bundle`, { status: 200 });
    });
    const harness = serviceWorkerHarness(fetcher);

    const response = await harness.fetch(new Request("https://chatwerk.test/overlay"));

    expect(await response?.text()).toBe(html);
    expect(fetcher.mock.calls.map(([request]) => new URL(request.url).pathname))
      .toEqual(["/overlay", "/assets/app.js", "/assets/app.css"]);
    expect(await (await harness.cached("/overlay"))?.text()).toBe(html);
    expect(await (await harness.cached("/assets/app.js"))?.text()).toBe("/assets/app.js bundle");
    expect(await (await harness.cached("/assets/app.css"))?.text()).toBe("/assets/app.css bundle");
  });

  it("keeps the old working pair when a new HTML asset cannot be fetched", async () => {
    let deploy: "old" | "new" = "old";
    const oldHtml = '<script src="/assets/old.js"></script>';
    const newHtml = '<script src="/assets/unavailable.js"></script>';
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/overlay") return new Response(deploy === "old" ? oldHtml : newHtml, { status: 200 });
      if (url.pathname === "/assets/unavailable.js") return new Response("missing", { status: 404 });
      return new Response("old bundle", { status: 200 });
    });
    const harness = serviceWorkerHarness(fetcher);
    await harness.fetch(new Request("https://chatwerk.test/overlay"));
    deploy = "new";

    const response = await harness.fetch(new Request("https://chatwerk.test/overlay"));

    expect(await response?.text()).toBe(oldHtml);
    expect(await (await harness.cached("/overlay"))?.text()).toBe(oldHtml);
    expect(await (await harness.cached("/assets/old.js"))?.text()).toBe("old bundle");
    expect(await harness.cached("/assets/unavailable.js")).toBeUndefined();
  });

  it("uses the active HTML pair when the overlay page is offline", async () => {
    let offline = false;
    const html = '<script src="/assets/app.js"></script>';
    const fetcher = vi.fn(async (request: Request) => {
      if (offline) throw new TypeError("offline");
      return new Response(new URL(request.url).pathname === "/overlay" ? html : "cached bundle", { status: 200 });
    });
    const harness = serviceWorkerHarness(fetcher);
    await harness.fetch(new Request("https://chatwerk.test/overlay"));
    offline = true;

    const response = await harness.fetch(new Request("https://chatwerk.test/overlay"));

    expect(await response?.text()).toBe(html);
  });

  it("uses the active HTML pair when the overlay page returns a server error", async () => {
    let status = 200;
    const html = '<script src="/assets/app.js"></script>';
    const fetcher = vi.fn(async (request: Request) => new Response(
      new URL(request.url).pathname === "/overlay" ? (status === 200 ? html : "origin unavailable") : "cached bundle",
      { status: new URL(request.url).pathname === "/overlay" ? status : 200 },
    ));
    const harness = serviceWorkerHarness(fetcher);
    await harness.fetch(new Request("https://chatwerk.test/overlay"));
    status = 502;

    const response = await harness.fetch(new Request("https://chatwerk.test/overlay"));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe(html);
  });

  it.each([404, 503])("serves a cached asset when its network response is %i", async (status) => {
    let deploy: "old" | "new" = "old";
    let oldAssetStatus = 200;
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      if (url.pathname === "/overlay") {
        const script = deploy === "old" ? "old.js" : "new.js";
        return new Response(`<script src="/assets/${script}"></script>`, { status: 200 });
      }
      if (url.pathname === "/assets/old.js" && oldAssetStatus !== 200) {
        return new Response("not available", { status: oldAssetStatus });
      }
      return new Response(`${url.pathname} bundle`, { status: 200 });
    });
    const harness = serviceWorkerHarness(fetcher);
    await harness.fetch(new Request("https://chatwerk.test/overlay"));
    deploy = "new";
    await harness.fetch(new Request("https://chatwerk.test/overlay"));
    oldAssetStatus = status;

    const response = await harness.fetch(new Request("https://chatwerk.test/assets/old.js"));

    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("/assets/old.js bundle");
  });

  it("prunes older asset pairs only after a newer pair commits", async () => {
    let deploy = 0;
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      return new Response(url.pathname === "/overlay"
        ? `<script src="/assets/deploy-${deploy}.js"></script>`
        : `bundle ${url.pathname}`, { status: 200 });
    });
    const harness = serviceWorkerHarness(fetcher);
    for (deploy = 0; deploy < 3; deploy += 1) {
      await harness.fetch(new Request("https://chatwerk.test/overlay"));
    }

    expect(await harness.cached("/assets/deploy-0.js")).toBeUndefined();
    expect(await harness.cached("/assets/deploy-1.js")).toBeDefined();
    expect(await harness.cached("/assets/deploy-2.js")).toBeDefined();
  });

  it("populates the current HTML and assets when the loaded page asks the worker to cache them", async () => {
    const fetcher = vi.fn(async (request: Request) => {
      const url = new URL(request.url);
      return new Response(url.pathname === "/overlay"
        ? '<script src="/assets/current.js"></script>'
        : "current bundle", { status: 200 });
    });
    const harness = serviceWorkerHarness(fetcher);

    await harness.message({ type: "populate-overlay" });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(await (await harness.cached("/overlay"))?.text()).toContain("current.js");
    expect(await (await harness.cached("/assets/current.js"))?.text()).toBe("current bundle");
  });

  it("does not remove a working cache during install or activate", async () => {
    const harness = serviceWorkerHarness(async () => new Response("unused"));

    await harness.lifecycle("install");
    await harness.lifecycle("activate");

    expect(harness.cacheStorage.keys).not.toHaveBeenCalled();
    expect(harness.cacheStorage.delete).not.toHaveBeenCalled();
  });

  it("does not intercept or cache API responses", async () => {
    const fetcher = vi.fn<typeof fetch>(async () => Response.json({ ok: true }));
    const harness = serviceWorkerHarness(fetcher);

    const response = await harness.fetch(new Request("https://chatwerk.test/api/overlay/config"));

    expect(response).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
    expect(harness.cacheStorage.open).not.toHaveBeenCalled();
  });
});
