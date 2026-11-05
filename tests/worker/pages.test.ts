import { describe, expect, it } from "vitest";
import { handlePageRequest, type PageEnvironment } from "../../src/worker/pages";
import { mintSessionCookie } from "./worker-test-helpers";

const sessionKey = "test-session-key-with-enough-entropy";

function pageEnv(): PageEnvironment {
  return {
    SESSION_KEY: sessionKey,
    ASSETS: {
      fetch: async (request: Request) => new Response(new URL(request.url).pathname),
    } as Fetcher,
  };
}

describe("Studio page routing", () => {
  it("redirects logged-out Studio visitors through login with the requested destination", async () => {
    const response = await handlePageRequest(new Request("https://chatwerk.test/studio"), pageEnv());

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://chatwerk.test/login?next=%2Fstudio");
  });

  it("sends the root to login when signed out and Studio when signed in", async () => {
    const signedOut = await handlePageRequest(new Request("https://chatwerk.test/"), pageEnv());
    const cookie = await mintSessionCookie(sessionKey, "owner-1");
    const signedIn = await handlePageRequest(new Request("https://chatwerk.test/", { headers: { cookie } }), pageEnv());

    expect(signedOut?.headers.get("location")).toBe("https://chatwerk.test/login");
    expect(signedIn?.headers.get("location")).toBe("https://chatwerk.test/studio");
  });

  it("serves the login and Studio HTML entries and protects the export placeholder", async () => {
    const cookie = await mintSessionCookie(sessionKey, "owner-2");
    const headers = { cookie };
    const login = await handlePageRequest(new Request("https://chatwerk.test/login"), pageEnv());
    const studio = await handlePageRequest(new Request("https://chatwerk.test/studio" , { headers }), pageEnv());
    const exportPage = await handlePageRequest(new Request("https://chatwerk.test/studio/export", { headers }), pageEnv());

    expect(await login?.text()).toBe("/login.html");
    expect(await studio?.text()).toBe("/studio.html");
    expect(await exportPage?.text()).toBe("/export.html");
  });

  it("protects direct export asset access and checks direct HTML entry routing", async () => {
    const cookie = await mintSessionCookie(sessionKey, "owner-assets");
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

    const signedOut = await handlePageRequest(new Request("https://chatwerk.test/export.html"), env);
    expect(signedOut?.status).toBe(302);
    expect(signedOut?.headers.get("location")).toBe("https://chatwerk.test/login?next=%2Fstudio%2Fexport");

    const directStudioSignedOut = await handlePageRequest(new Request("https://chatwerk.test/studio.html"), pageEnv());
    expect(directStudioSignedOut?.status).toBe(302);
    expect(directStudioSignedOut?.headers.get("location")).toBe("https://chatwerk.test/login?next=%2Fstudio");
    const directLogin = await handlePageRequest(new Request("https://chatwerk.test/login.html"), pageEnv());
    const directOverlay = await handlePageRequest(new Request("https://chatwerk.test/overlay.html"), pageEnv());
    expect(await directLogin?.text()).toBe("/login.html");
    expect(await directOverlay?.text()).toBe("/overlay.html");

    for (const pathname of ["/login.html", "/studio.html", "/studio/export", "/studio/export.html", "/export.html", "/overlay.html"]) {
      const headers = pathname === "/studio/export" || pathname === "/studio/export.html" ||
        pathname === "/export.html" || pathname === "/studio.html"
        ? { cookie }
        : undefined;
      await handlePageRequest(new Request(`https://chatwerk.test${pathname}`, { headers }), env);
    }

    expect(requestedAssets).toEqual([
      "/login.html", "/studio.html", "/export.html", "/export.html", "/export.html", "/overlay.html",
    ]);
  });

  it("serves the embeddable overlay shell", async () => {
    const response = await handlePageRequest(new Request("https://chatwerk.test/overlay"), pageEnv());
    expect(response?.status).toBe(200);
    expect(await response?.text()).toBe("/overlay.html");
  });

  it("requires login for the themes gallery and serves its shell to a session", async () => {
    const signedOut = await handlePageRequest(new Request("https://chatwerk.test/themes"), pageEnv());
    const cookie = await mintSessionCookie(sessionKey, "owner-themes");
    const signedIn = await handlePageRequest(new Request("https://chatwerk.test/themes", { headers: { cookie } }), pageEnv());

    expect(signedOut?.status).toBe(302);
    expect(signedOut?.headers.get("location")).toBe("https://chatwerk.test/login?next=%2Fthemes");
    expect(await signedIn?.text()).toBe("/gallery.html");
  });

  it("serves public look pages without login and keeps gallery assets private", async () => {
    const publicLook = await handlePageRequest(new Request("https://chatwerk.test/t/night-ledger-abc123"), pageEnv());
    const privateAsset = await handlePageRequest(new Request("https://chatwerk.test/gallery.html"), pageEnv());

    expect(await publicLook?.text()).toBe("/theme.html");
    expect(privateAsset?.status).toBe(302);
    expect(privateAsset?.headers.get("location")).toBe("https://chatwerk.test/login?next=%2Fthemes");
  });
});
