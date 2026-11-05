import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publicOriginFor, renderHeaders } from "../../../scripts/lib/headers.mjs";
import { ALLOWED_CONNECT_ORIGINS, ALLOWED_IMAGE_HOSTS } from "../../../src/shared/hosts";

const source = readFileSync(path.join(process.cwd(), "public/_headers"), "utf8");
const wrangler = JSON.parse(readFileSync(path.join(process.cwd(), "wrangler.jsonc"), "utf8")) as {
  assets: { run_worker_first: string[] };
};

const parseRules = (contents: string): Map<string, string[]> => {
  const rules = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of contents.split(/\r?\n/u)) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    if (!/^\s/u.test(line)) {
      current = [];
      rules.set(line.trim(), current);
    } else current?.push(line.trim());
  }
  return rules;
};

const rules = parseRules(source);

const rulesMatchingPath = (requestPath: string): string[] => [...rules.keys()].filter((pattern) => {
  const expression = new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/gu, "\\$&").replaceAll("*", ".*")}$`, "u");
  return expression.test(requestPath);
});

const headersForPath = (requestPath: string): string[] =>
  rulesMatchingPath(requestPath).flatMap((pattern) => rules.get(pattern) ?? []);

const headerValues = (headers: string[], name: string): string[] => headers.flatMap((line) => {
  const separator = line.indexOf(":");
  return separator >= 0 && line.slice(0, separator).toLowerCase() === name.toLowerCase()
    ? [line.slice(separator + 1).trim()]
    : [];
});

const effectiveHeadersForPath = (requestPath: string): string[] => {
  const headers: string[] = [];
  for (const rule of rulesMatchingPath(requestPath)) {
    for (const line of rules.get(rule) ?? []) {
      if (line.startsWith("! ")) {
        const detachedName = line.slice(2).toLowerCase();
        for (let index = headers.length - 1; index >= 0; index -= 1) {
          if (headers[index]!.slice(0, headers[index]!.indexOf(":")).toLowerCase() === detachedName) headers.splice(index, 1);
        }
      } else headers.push(line);
    }
  }
  return headers;
};

describe("deployment headers", () => {
  it("unions every matching rule like Cloudflare and keeps overlay headers unique", () => {
    expect(rulesMatchingPath("/overlay")).toEqual(["/overlay"]);
    expect(rulesMatchingPath("/overlay.html")).toEqual(["/overlay.html"]);
    expect(rulesMatchingPath("/overlay/x")).toEqual(["/overlay/*"]);
    expect(rulesMatchingPath("/studio")).toEqual(["/studio*"]);
    expect(rulesMatchingPath("/login")).toEqual(["/login*"]);
    expect(rulesMatchingPath("/assets/a.js")).toEqual(["/assets/*"]);

    for (const path of ["/overlay", "/overlay.html", "/overlay/x"]) {
      const headers = headersForPath(path);
      const policies = headerValues(headers, "Content-Security-Policy");
      expect(policies).toHaveLength(1);
      expect(policies[0]).toContain("wss://irc-ws.chat.twitch.tv");
      expect(policies[0]).toContain("media-src __PUBLIC_ORIGIN__ blob:");
      expect(policies[0]).not.toContain("frame-ancestors");
      expect(headerValues(headers, "X-Frame-Options")).toHaveLength(0);
      expect(headerValues(headers, "Cache-Control")).toEqual(["no-cache"]);
      expect(headerValues(headers, "Referrer-Policy")).toHaveLength(1);
      expect(headerValues(headers, "X-Content-Type-Options")).toHaveLength(1);
    }
    expect([...rules.keys()]).not.toContain("/overlay*");
  });

  it("keeps framing protection on protected HTML routes after matching-rule union", () => {
    for (const path of ["/login", "/login.html", "/studio", "/studio.html"]) {
      const headers = headersForPath(path);
      expect(headerValues(headers, "X-Frame-Options")).toEqual(["SAMEORIGIN"]);
      expect(headerValues(headers, "Content-Security-Policy").join("\n")).toContain("frame-ancestors __PUBLIC_ORIGIN__");
    }
    expect(headerValues(headersForPath("/studio/export"), "X-Frame-Options")).toEqual(["SAMEORIGIN"]);
    for (const path of ["/studio/export", "/studio/export.html", "/export.html"]) {
      const headers = headersForPath(path);
      expect(headerValues(headers, "X-Frame-Options"), path).toEqual(["SAMEORIGIN"]);
      expect(headerValues(headers, "Content-Security-Policy").join("\n"), path)
        .toContain("frame-ancestors __PUBLIC_ORIGIN__");
      expect(headerValues(headers, "Cache-Control"), path).toEqual(["no-cache"]);
    }
    expect(wrangler.assets.run_worker_first).toContain("/export*");
    expect(headerValues(headersForPath("/studio"), "Content-Security-Policy").join("\n"))
      .toContain("frame-src __PUBLIC_ORIGIN__");
    for (const path of ["/login", "/login.html", "/studio", "/studio.html"]) {
      expect(headerValues(headersForPath(path), "Content-Security-Policy")).toHaveLength(1);
    }
    const assetHeaders = headersForPath("/assets/a.js");
    expect(headerValues(assetHeaders, "Cache-Control")).toEqual(["public, max-age=31536000, immutable"]);
    expect(headerValues(assetHeaders, "X-Content-Type-Options")).toEqual(["nosniff"]);
    expect(headerValues(assetHeaders, "Access-Control-Allow-Origin")).toEqual(["*"]);
    expect(headerValues(assetHeaders, "Content-Security-Policy")).toHaveLength(0);
  });

  it("keeps framing protection on the gallery and public look shells", () => {
    for (const path of ["/themes", "/gallery.html", "/t/night-ledger-abc123", "/theme.html"]) {
      const headers = headersForPath(path);
      expect(headerValues(headers, "X-Frame-Options"), path).toEqual(["SAMEORIGIN"]);
      expect(headerValues(headers, "Content-Security-Policy").join("\n"), path).toContain("frame-ancestors __PUBLIC_ORIGIN__");
      expect(headerValues(headers, "Content-Security-Policy").join("\n"), path).toContain("frame-src __PUBLIC_ORIGIN__");
      expect(headerValues(headers, "Cache-Control"), path).toEqual(["no-cache"]);
    }
    for (const route of ["/themes*", "/t/*"]) expect(wrangler.assets.run_worker_first).toContain(route);
  });

  it("uses explicit origins and Twitch IRC without self in every CSP", () => {
    for (const [rule, headers] of rules) {
      const policies = headers.filter((line) => line.toLowerCase().startsWith("content-security-policy:"));
      for (const csp of policies) {
        expect(csp, `rule ${rule}`).not.toContain("'self'");
        expect(csp, `rule ${rule}`).toContain("__PUBLIC_ORIGIN__");
      }
    }
    for (const rule of ["/overlay", "/overlay.html", "/overlay/*"]) {
      expect(rules.get(rule)?.join("\n")).toContain("wss://irc-ws.chat.twitch.tv");
      expect(rules.get(rule)?.join("\n")).toContain("__PUBLIC_WSS__");
    }
  });

  it("allows badge, backlog, emote, and pronoun providers on overlays and Studio live preview", () => {
    const builtRules = parseRules(renderHeaders(source, publicOriginFor("local", undefined), {
      connectOrigins: ALLOWED_CONNECT_ORIGINS,
      imageHosts: ALLOWED_IMAGE_HOSTS,
    }));
    for (const rule of ["/overlay", "/overlay.html", "/overlay/*"]) {
      const policy = builtRules.get(rule)?.find((line) => line.startsWith("Content-Security-Policy:")) ?? "";
      const connect = policy.split("connect-src ")[1]?.split(";")[0] ?? "";
      const images = policy.split("img-src ")[1]?.split(";")[0] ?? "";
      for (const origin of ALLOWED_CONNECT_ORIGINS) expect(connect).toContain(origin);
      for (const host of ALLOWED_IMAGE_HOSTS) expect(images).toContain(`https://${host}`);
    }
    const studioPolicy = builtRules.get("/studio*")?.find((line) => line.startsWith("Content-Security-Policy:")) ?? "";
    const studioConnect = studioPolicy.split("connect-src ")[1]?.split(";")[0] ?? "";
    const studioImages = studioPolicy.split("img-src ")[1]?.split(";")[0] ?? "";
    for (const origin of ALLOWED_CONNECT_ORIGINS) expect(studioConnect).toContain(origin);
    for (const host of ALLOWED_IMAGE_HOSTS) expect(studioImages).toContain(`https://${host}`);
    expect(ALLOWED_CONNECT_ORIGINS).toContain("https://api.chatterino.com");
    expect(ALLOWED_CONNECT_ORIGINS).toContain("https://chatterinohomies.com");
    expect(ALLOWED_CONNECT_ORIGINS).toContain("https://recent-messages.robotty.de");
    expect(ALLOWED_IMAGE_HOSTS).toContain("fourtf.com");
    expect(ALLOWED_IMAGE_HOSTS).toContain("cdn.chatterinohomies.com");
    for (const path of ["/", "/login", "/export.html"]) {
      const policy = headersForPath(path).filter((line) => line.startsWith("Content-Security-Policy:")).join(" ");
      for (const origin of ALLOWED_CONNECT_ORIGINS) expect(policy).not.toContain(origin);
      for (const host of ALLOWED_IMAGE_HOSTS) expect(policy).not.toContain(`https://${host}`);
    }
  });

  it("allows CORS on built assets, fonts, and opaque-frame effects, never HTML", () => {
    for (const rule of ["/assets/*", "/fonts/*", "/effects/*"]) {
      expect(rules.get(rule)).toContain("Access-Control-Allow-Origin: *");
    }
    for (const path of ["/", "/login", "/studio", "/export.html", "/overlay", "/overlay/x"]) {
      expect(headersForPath(path).join("\n")).not.toContain("Access-Control-Allow-Origin");
    }
  });

  it("keeps the Hype manifest uncached while allowing cross-origin reads of both Hype assets", () => {
    const manifestHeaders = effectiveHeadersForPath("/effects/manifest.json");
    const soundHeaders = effectiveHeadersForPath("/effects/hype.mp3");

    expect(headerValues(manifestHeaders, "Cache-Control")).toEqual(["no-cache"]);
    expect(headerValues(manifestHeaders, "Access-Control-Allow-Origin")).toEqual(["*"]);
    expect(headerValues(soundHeaders, "Access-Control-Allow-Origin")).toEqual(["*"]);
  });


  it("allows direct overlay service worker registration without caching the script", () => {
    const headers = headersForPath("/overlay-sw.js");
    expect(headers).toContain("Service-Worker-Allowed: /");
    expect(headers).toContain("Cache-Control: no-cache");
    expect(headers.join("\n")).not.toContain("frame-ancestors");
  });

  it("requires a bare HTTPS origin for non-local builds", () => {
    expect(() => publicOriginFor("production", undefined)).toThrow(/PUBLIC_ORIGIN/);
    expect(() => publicOriginFor("production", "http://chat.example.com")).toThrow(/HTTPS/);
    expect(() => publicOriginFor("production", "https://chat.example.com/path")).toThrow(/bare|path/i);
    expect(publicOriginFor("production", "https://chat.example.com/")).toEqual({
      origin: "https://chat.example.com", wssOrigin: "wss://chat.example.com", socketOrigin: "wss://chat.example.com",
    });
    expect(publicOriginFor("local", undefined).origin).toContain("localhost");
  });

  it("renders origin placeholders in the built header source", () => {
    const rendered = renderHeaders(source, publicOriginFor("production", "https://chat.example.com"));
    expect(rendered).toContain("https://chat.example.com");
    expect(rendered).toContain("wss://chat.example.com");
    expect(rendered).not.toContain("__PUBLIC_");
  });

  it("allows the local overlay socket from an opaque-origin iframe", () => {
    const rendered = renderHeaders(source, publicOriginFor("local", undefined));
    const overlayRules = rendered.split("/overlay\n")[1]?.split("\n/overlay/*")[0] ?? "";
    const builtRules = parseRules(rendered);
    const studioPolicy = builtRules.get("/studio*")?.find((line) => line.startsWith("Content-Security-Policy:")) ?? "";

    expect(overlayRules).toContain("ws://localhost:*");
    expect(overlayRules).toContain("ws://127.0.0.1:*");
    expect(overlayRules).not.toContain("frame-ancestors");
    expect(studioPolicy).toContain("frame-src http://localhost:* http://127.0.0.1:*");
    expect([...builtRules.keys()]).not.toContain("/*");
  });

  it("uses the configured production origin in Studio's local overlay frame policy", () => {
    const rendered = renderHeaders(source, publicOriginFor("production", "https://chat.example.com"));
    const studioPolicy = parseRules(rendered).get("/studio*")?.find((line) => line.startsWith("Content-Security-Policy:")) ?? "";

    expect(studioPolicy).toContain("frame-src https://chat.example.com;");
    expect(studioPolicy).not.toContain("127.0.0.1");
  });
});
