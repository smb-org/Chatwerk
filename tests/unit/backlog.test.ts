import { describe, expect, it, vi } from "vitest";
import { DEFAULTS } from "../../src/shared/theme";
import { fetchRecentBacklog } from "../../src/renderer/backlog";

const now = 1_800_000_000_000;
const line = (id: string, sentAt: number, text = id, extra = ""): string =>
  `@id=${id};tmi-sent-ts=${sentAt};historical=1;display-name=Viewer;user-id=42${extra} :viewer!viewer@host PRIVMSG #room :${text}`;
const response = (messages: string[]): Response => Response.json({ messages, error: null, error_code: null });

describe("recent message backlog", () => {
  it("keeps only fresh messages, sorts by sent time, and returns their original timestamps", async () => {
    const fetcher = vi.fn(async () => response([
      line("fresh-new", now - 2_000),
      line("expired", now - 10_001),
      line("fresh-old", now - 8_000),
    ]));
    const result = await fetchRecentBacklog(["room"], { ...DEFAULTS, lifetime: 10_000 }, { fetcher, now });
    expect(result.map(({ event, receivedAt }) => [event.tags.id, receivedAt])).toEqual([
      ["fresh-old", now - 8_000],
      ["fresh-new", now - 2_000],
    ]);
    expect(result.every(({ event }) => event.historical)).toBe(true);
  });

  it("keeps the latest maxLines after merging channels and removes duplicate ids", async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => String(input).includes("/one?")
      ? response([line("old", now - 5_000).replace("#room", "#one"), line("shared", now - 3_000, "from one").replace("#room", "#one")])
      : response([line("shared", now - 3_000, "from two").replace("#room", "#two"), line("new", now - 1_000).replace("#room", "#two")]));
    const result = await fetchRecentBacklog(["one", "two"], {
      ...DEFAULTS, lifetime: 10_000, maxLines: 2,
    }, { fetcher, now });
    expect(result.map(({ event }) => event.tags.id)).toEqual(["shared", "new"]);
    expect(result.map(({ event }) => event.text)).toEqual(["from one", "new"]);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher.mock.calls.map(([url]) => String(url))).toEqual([
      "https://recent-messages.robotty.de/api/v2/recent-messages/one?limit=2",
      "https://recent-messages.robotty.de/api/v2/recent-messages/two?limit=2",
    ]);
  });

  it("uses normal message filters and drops moderated records", async () => {
    const fetcher = vi.fn(async () => response([
      line("kept", now - 1_000, "hello"),
      line("word", now - 2_000, "blocked"),
      line("deleted", now - 3_000, "old text", ";rm-deleted=1"),
    ]));
    const result = await fetchRecentBacklog(["room"], {
      ...DEFAULTS, lifetime: 10_000, filterWords: ["blocked"],
    }, { fetcher, now });
    expect(result.map(({ event }) => event.tags.id)).toEqual(["kept"]);
  });

  it("accepts only the requested channel and strips Shared Chat source tags while retaining normal badges", async () => {
    const fetcher = vi.fn(async () => response([
      line("wrong-room", now - 1_000, "wrong", ";badges=vip/1" ).replace("#room", "#elsewhere"),
      line("shared", now - 2_000, "shared", ";source-room-id=22;source-id=shared-1;source-badges=moderator/1;source-only=1;badges=vip/1"),
    ]));
    const result = await fetchRecentBacklog(["room"], { ...DEFAULTS, lifetime: 10_000 }, { fetcher, now });

    expect(result).toHaveLength(1);
    expect(result[0]?.event.channel).toBe("#room");
    expect(result[0]?.event.sourceRoomId).toBeNull();
    expect(result[0]?.event.sourceId).toBeNull();
    expect(result[0]?.event.badges).toEqual([{ name: "vip", version: "1" }]);
    expect(Object.keys(result[0]!.event.tags).some((tag) => tag.startsWith("source-"))).toBe(false);
  });

  it("drops a channel response whose streamed body exceeds 2 MB", async () => {
    const oversized = "x".repeat(2 * 1024 * 1024);
    const fetcher = vi.fn(async () => response([line("bounded", now - 1_000), oversized]));

    await expect(fetchRecentBacklog(["room"], DEFAULTS, { fetcher, now })).resolves.toEqual([]);
  });

  it("drops messages longer than 8 KB before IRC parsing", async () => {
    const fetcher = vi.fn(async () => response([
      line("kept", now - 1_000),
      line("long", now - 2_000, "x".repeat(8 * 1024 + 1)),
    ]));

    const result = await fetchRecentBacklog(["room"], DEFAULTS, { fetcher, now });

    expect(result.map(({ event }) => event.tags.id)).toEqual(["kept"]);
  });

  it("parses at most 500 messages from one channel response", async () => {
    const fetcher = vi.fn(async () => response(Array.from({ length: 501 }, (_, index) =>
      line(`count-${index}`, now - 1_000 + index))));

    const result = await fetchRecentBacklog(["room"], { ...DEFAULTS, maxLines: 100 }, { fetcher, now });

    expect(result.map(({ event }) => event.tags.id)).toEqual(Array.from({ length: 100 }, (_, index) => `count-${400 + index}`));
  });

  it("does not request for disabled, ticker, or sample modes and treats neverFade as age unlimited", async () => {
    const fetcher = vi.fn(async () => response([line("ancient", now - 2_000_000)]));
    expect(await fetchRecentBacklog(["room"], { ...DEFAULTS, backlog: false }, { fetcher, now })).toEqual([]);
    expect(await fetchRecentBacklog(["room"], { ...DEFAULTS, layout: "ticker" }, { fetcher, now })).toEqual([]);
    expect(await fetchRecentBacklog(["room"], DEFAULTS, { fetcher, now, live: false })).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const result = await fetchRecentBacklog(["room"], { ...DEFAULTS, neverFade: true }, { fetcher, now });
    expect(result.map(({ event }) => event.tags.id)).toEqual(["ancient"]);
  });

  it("skips a failed channel quietly and stops slow requests on its short timeout", async () => {
    const failer = vi.fn(async () => { throw new TypeError("offline"); });
    await expect(fetchRecentBacklog(["room"], DEFAULTS, { fetcher: failer, now })).resolves.toEqual([]);

    vi.useFakeTimers();
    const slow = vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")), { once: true });
    }));
    const pending = fetchRecentBacklog(["room"], DEFAULTS, { fetcher: slow, now, timeoutMs: 25 });
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toEqual([]);
    vi.useRealTimers();
  });
});
