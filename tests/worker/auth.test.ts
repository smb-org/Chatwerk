import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { handleAuthRequest, verifySessionCookie, type AuthEnvironment } from "../../src/worker/auth";
import { cookieValue, mintSessionCookie, seedOverlay } from "./worker-test-helpers";

const sessionKey = "test-session-key-with-enough-entropy";
const clientId = "test-client-id";
const clientSecret = "test-client-secret";
const authEnv = (overrides: Partial<AuthEnvironment> = {}): AuthEnvironment => ({
  DB: env.DB,
  SESSION_KEY: sessionKey,
  TWITCH_CLIENT_ID: clientId,
  TWITCH_CLIENT_SECRET: clientSecret,
  ...overrides,
});

const getCookie = (response: Response, name: string): string => {
  const value = cookieValue(response, name);
  if (!value) throw new Error(`Missing ${name} cookie`);
  return value;
};

const completeLogin = async (userId: string, login: string, loginUrl = "https://chatwerk.test/auth/login?next=%2Fstudio%3Ftab%3Dlook") => {
  const loginResponse = await handleAuthRequest(
    new Request(loginUrl),
    authEnv(),
  );
  const authorizeUrl = new URL(loginResponse!.headers.get("location")!);
  const state = authorizeUrl.searchParams.get("state")!;
  const nonce = getCookie(loginResponse!, "oauth_nonce");
  const fetcher: typeof fetch = async (input) => {
    const url = String(input);
    if (url === "https://id.twitch.tv/oauth2/token") {
      return Response.json({ access_token: "access-token", token_type: "bearer" });
    }
    if (url === "https://api.twitch.tv/helix/users") {
      return Response.json({ data: [{ id: userId, login, display_name: login }] });
    }
    throw new Error(`Unexpected OAuth request: ${url}`);
  };
  const callback = new Request(`https://chatwerk.test/auth/callback?code=auth-code&state=${encodeURIComponent(state)}`, {
    headers: { cookie: `oauth_nonce=${nonce}` },
  });
  return { response: await handleAuthRequest(callback, authEnv(), fetcher), state };
};

describe("Twitch login and session cookie", () => {
  it("returns a clear 503 JSON response when required secrets are missing", async () => {
    const response = await handleAuthRequest(
      new Request("https://chatwerk.test/auth/login"),
      authEnv({ SESSION_KEY: "" }),
    );

    expect(response?.status).toBe(503);
    expect(await response?.json()).toEqual({ error: "Authentication is not configured" });
  });

  it("starts OAuth with signed state, a nonce cookie, and an empty scope parameter", async () => {
    const response = await handleAuthRequest(
      new Request("https://chatwerk.test/auth/login?next=%2Fstudio%3Ftab%3Dlook"),
      authEnv(),
    );
    const authorizeUrl = new URL(response!.headers.get("location")!);
    const state = authorizeUrl.searchParams.get("state")!;
    const [payload, signature] = state.split(".");

    expect(response?.status).toBe(302);
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe("https://id.twitch.tv/oauth2/authorize");
    expect(authorizeUrl.searchParams.get("scope")).toBe("");
    expect(authorizeUrl.searchParams.get("client_id")).toBe(clientId);
    expect(signature).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(JSON.parse(atob(payload!.replace(/-/gu, "+").replace(/_/gu, "/")))).toMatchObject({
      next: "/studio?tab=look",
    });
    expect(getCookie(response!, "oauth_nonce")).toMatch(/^[A-Za-z0-9_-]{40,}$/u);
    expect(response?.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response?.headers.get("set-cookie")).toContain("SameSite=Lax");
  });

  it("sends hostile next values back to the local studio", async () => {
    const response = await handleAuthRequest(
      new Request("http://localhost:17173/auth/login?next=%2F%2Fevil.example%2Fsteal"),
      authEnv(),
    );

    const authorizeUrl = new URL(response!.headers.get("location")!);
    const [payload] = authorizeUrl.searchParams.get("state")!.split(".");
    const stateData = JSON.parse(atob(payload!.replace(/-/gu, "+").replace(/_/gu, "/"))) as { next: string };
    expect(stateData.next).toBe("/studio");
    expect(response?.headers.get("set-cookie")).not.toContain("Secure");
  });

  it("returns to login with the fixed error state when the callback nonce is invalid", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const response = await handleAuthRequest(
      new Request("https://chatwerk.test/auth/callback?code=auth-code&state=invalid.invalid"),
      authEnv(),
      fetcher,
    );

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://chatwerk.test/login?error=1");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("exchanges identity and issues a signed stateless session cookie", async () => {
    const userId = `auth-${crypto.randomUUID()}`;
    const { response } = await completeLogin(userId, `viewer_${crypto.randomUUID().slice(0, 8)}`);
    const session = getCookie(response!, "session");

    expect(response?.status).toBe(302);
    expect(response?.headers.get("location")).toBe("https://chatwerk.test/studio?tab=look");
    expect(response?.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response?.headers.get("set-cookie")).toContain("Secure");
    expect(response?.headers.get("set-cookie")).toContain("SameSite=Lax");
    expect(await verifySessionCookie(session, sessionKey)).toMatchObject({ userId });
  });

  it("logs out only after a same-origin mutation and clears the session cookie", async () => {
    const foreign = await handleAuthRequest(
      new Request("https://chatwerk.test/auth/logout", { method: "POST", headers: { origin: "https://evil.test" } }),
      authEnv(),
    );
    const local = await handleAuthRequest(
      new Request("https://chatwerk.test/auth/logout", { method: "POST", headers: { origin: "https://chatwerk.test" } }),
      authEnv(),
    );

    expect(foreign?.status).toBe(403);
    expect(local?.status).toBe(204);
    expect(local?.headers.get("set-cookie")).toContain("Max-Age=0");
  });

  it("creates exactly one Main overlay with the user's channel across repeated callbacks", async () => {
    const userId = `auth-repeat-${crypto.randomUUID()}`;
    const login = `viewer_${crypto.randomUUID().slice(0, 8)}`;
    const first = await completeLogin(userId, login);
    const firstOverlay = await env.DB.prepare(
      "SELECT id, owner_id, link_token, name, channel FROM overlays WHERE owner_id = ? AND name = 'Main'",
    ).bind(userId).first<{ id: string; owner_id: string; link_token: string; name: string; channel: string }>();
    const updatedLogin = `${login}_new`;
    const second = await completeLogin(userId, updatedLogin);
    const all = await env.DB.prepare(
      "SELECT id, link_token, channel FROM overlays WHERE owner_id = ? AND name = 'Main'",
    ).bind(userId).all<{ id: string; link_token: string; channel: string }>();

    expect(first.response?.status).toBe(302);
    expect(second.response?.status).toBe(302);
    expect(all.results).toHaveLength(1);
    expect(all.results[0]).toEqual({ id: firstOverlay?.id, link_token: firstOverlay?.link_token, channel: login });
    expect(firstOverlay?.owner_id).toBe(userId);
    expect(firstOverlay?.link_token).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(firstOverlay?.name).toBe("Main");
    expect(firstOverlay?.channel).toBe(login);
    await env.DB.prepare("UPDATE overlays SET channel = 'custom_room' WHERE id = ?").bind(firstOverlay?.id).run();
    const third = await completeLogin(userId, `${updatedLogin}_again`);
    const retainedChannel = await env.DB.prepare("SELECT channel FROM overlays WHERE id = ?")
      .bind(firstOverlay?.id).first<string>("channel");

    expect(third.response?.status).toBe(302);
    expect(retainedChannel).toBe("custom_room");
    expect(await env.DB.prepare("SELECT login FROM users WHERE id = ?").bind(userId).first("login")).toBe(`${updatedLogin}_again`);
  });

  it("allows two Twitch ids to use the same recycled login", async () => {
    const login = `recycled_${crypto.randomUUID().slice(0, 8)}`;
    const firstId = `twitch-${crypto.randomUUID()}`;
    const secondId = `twitch-${crypto.randomUUID()}`;

    const first = await completeLogin(firstId, login);
    const second = await completeLogin(secondId, login);
    const users = await env.DB.prepare("SELECT id, login FROM users WHERE id IN (?, ?) ORDER BY id")
      .bind(firstId, secondId).all<{ id: string; login: string }>();
    const overlays = await env.DB.prepare("SELECT owner_id FROM overlays WHERE owner_id IN (?, ?)")
      .bind(firstId, secondId).all<{ owner_id: string }>();
    const foreignKeyErrors = await env.DB.prepare("PRAGMA foreign_key_check").all();

    expect(first.response?.status).toBe(302);
    expect(second.response?.status).toBe(302);
    expect(users.results).toEqual([
      { id: firstId, login },
      { id: secondId, login },
    ].sort((left, right) => left.id.localeCompare(right.id)));
    expect(overlays.results).toHaveLength(2);
    expect(foreignKeyErrors.results).toEqual([]);
  });

  it("does not add another Main at login when three overlays exist and Main was renamed", async () => {
    const userId = `auth-renamed-${crypto.randomUUID()}`;
    const login = `viewer_${crypto.randomUUID().slice(0, 8)}`;
    await completeLogin(userId, login);
    await env.DB.prepare("UPDATE overlays SET name = 'Renamed' WHERE owner_id = ? AND name = 'Main'").bind(userId).run();
    await seedOverlay(env.DB, { ownerId: userId, name: "Stream" });
    await seedOverlay(env.DB, { ownerId: userId, name: "Vertical" });
    const before = await env.DB.prepare("SELECT id, name FROM overlays WHERE owner_id = ? ORDER BY id").bind(userId).all();

    const { response } = await completeLogin(userId, login);
    const after = await env.DB.prepare("SELECT id, name FROM overlays WHERE owner_id = ? ORDER BY id").bind(userId).all();

    expect(response?.status).toBe(302);
    expect(after.results).toHaveLength(3);
    expect(after.results).toEqual(before.results);
  });

  it("accepts a session minted with the shared worker test helper", async () => {
    const cookie = await mintSessionCookie(sessionKey, "test-owner", 2_000_000_000);
    expect(await verifySessionCookie(cookie.slice("session=".length), sessionKey, 1_900_000_000)).toEqual({
      userId: "test-owner",
      expiresAt: 2_000_000_000,
    });
  });
});
