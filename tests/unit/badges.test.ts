import { describe, expect, it } from "vitest";
import { createBadgeLookup } from "../../src/renderer/badges";

describe("Twitch badge lookup", () => {
  it("resolves bundled sample badges only for marked sample messages", () => {
    const badges = createBadgeLookup({
      source: {
        type: "embedded",
        data: {
          global: [{
            set_id: "moderator",
            versions: [{ id: "1", image_url_2x: "https://static-cdn.jtvnw.net/badges/moderator.svg" }],
          }],
          broadcasters: {},
        },
      },
      sampleData: {
        global: [{
          set_id: "moderator",
          versions: [{ id: "1", image_url_2x: "/assets/samples/moderator-badge.svg" }],
        }],
        broadcasters: {
          "7100001": [{
            set_id: "broadcaster",
            versions: [{ id: "1", image_url_2x: "/assets/samples/broadcaster-badge.svg" }],
          }],
        },
      },
    });

    expect(badges.resolve([
      { name: "moderator", version: "1" },
      { name: "broadcaster", version: "1" },
    ], "7100001", true)).toEqual([
      { name: "moderator", version: "1", url: "/assets/samples/moderator-badge.svg" },
      { name: "broadcaster", version: "1", url: "/assets/samples/broadcaster-badge.svg" },
    ]);
    expect(badges.resolve([
      { name: "moderator", version: "1" },
      { name: "broadcaster", version: "1" },
    ], "7100001")).toEqual([
      { name: "moderator", version: "1", url: "https://static-cdn.jtvnw.net/badges/moderator.svg" },
    ]);
    badges.dispose();
  });
});
