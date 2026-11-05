import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { handlePageRequest, type PageEnvironment } from "../../src/worker/pages";
import { mintSessionCookie } from "../worker/worker-test-helpers";

const sessionKey = "test-session-key-with-enough-entropy";

describe("worker page asset paths", () => {
  it("fetches only files present under the built client directory", async () => {
    const cookie = await mintSessionCookie(sessionKey, "owner-built-assets");
    const requestedAssets: string[] = [];
    const env: PageEnvironment = {
      SESSION_KEY: sessionKey,
      ASSETS: {
        fetch: async (request: Request) => {
          const assetPath = new URL(request.url).pathname;
          requestedAssets.push(assetPath);
          return new Response(assetPath);
        },
      } as Fetcher,
    };
    const routes = [
      { path: "/login", signedIn: false },
      { path: "/login.html", signedIn: false },
      { path: "/studio", signedIn: true },
      { path: "/studio.html", signedIn: true },
      { path: "/studio/export", signedIn: true },
      { path: "/studio/export.html", signedIn: true },
      { path: "/overlay", signedIn: false },
      { path: "/overlay.html", signedIn: false },
    ];

    for (const route of routes) {
      const request = new Request(`https://chatwerk.test${route.path}`, {
        headers: route.signedIn ? { cookie } : undefined,
      });
      await handlePageRequest(request, env);
    }

    expect(requestedAssets).toHaveLength(routes.length);
    for (const assetPath of requestedAssets) {
      const builtAsset = path.resolve(import.meta.dirname, "../../dist/client", assetPath.slice(1));
      expect(existsSync(builtAsset), assetPath).toBe(true);
    }
  });
});
