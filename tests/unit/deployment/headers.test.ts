import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { publicOriginFor, renderHeaders } from "../../../scripts/lib/headers.mjs";

const source = readFileSync(path.join(process.cwd(), "public/_headers"), "utf8");

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

describe("deployment headers", () => {
  it("unions every matching rule like Cloudflare and keeps overlay headers unique", () => {
    expect(rulesMatchingPath("/overlay")).toEqual(["/overlay"]);
    expect(rulesMatchingPath("/overlay/x")).toEqual(["/overlay/*"]);
    expect(rulesMatchingPath("/studio")).toEqual(["/studio*"]);
    expect(rulesMatchingPath("/login")).toEqual(["/login*"]);
    expect(rulesMatchingPath("/assets/a.js")).toEqual(["/assets/*"]);

    for (const path of ["/overlay", "/overlay/x"]) {
      const headers = headersForPath(path);
      const policies = headerValues(headers, "Content-Security-Policy");
      expect(policies).toHaveLength(1);
      expect(policies[0]).toContain("wss://irc-ws.chat.twitch.tv");
      expect(policies[0]).not.toContain("frame-ancestors");
      expect(headerValues(headers, "X-Frame-Options")).toHaveLength(0);
      expect(headerValues(headers, "Cache-Control")).toEqual(["no-cache"]);
      expect(headerValues(headers, "Referrer-Policy")).toHaveLength(1);
      expect(headerValues(headers, "X-Content-Type-Options")).toHaveLength(1);
    }
    expect([...rules.keys()]).not.toContain("/overlay*");
  });

  it("keeps framing protection on protected HTML routes after matching-rule union", () => {
    for (const path of ["/login", "/studio"]) {
      const headers = headersForPath(path);
      expect(headerValues(headers, "X-Frame-Options")).toEqual(["SAMEORIGIN"]);
      expect(headerValues(headers, "Content-Security-Policy").join("\n")).toContain("frame-ancestors __PUBLIC_ORIGIN__");
    }
    for (const path of ["/login", "/studio"]) {
      expect(headerValues(headersForPath(path), "Content-Security-Policy")).toHaveLength(1);
    }
    const assetHeaders = headersForPath("/assets/a.js");
    expect(headerValues(assetHeaders, "Cache-Control")).toEqual(["public, max-age=31536000, immutable"]);
    expect(headerValues(assetHeaders, "X-Content-Type-Options")).toEqual(["nosniff"]);
    expect(headerValues(assetHeaders, "Access-Control-Allow-Origin")).toEqual(["*"]);
    expect(headerValues(assetHeaders, "Content-Security-Policy")).toHaveLength(0);
  });

  it("uses explicit origins and Twitch IRC without self in every CSP", () => {
    for (const [rule, headers] of rules) {
      const policies = headers.filter((line) => line.toLowerCase().startsWith("content-security-policy:"));
      for (const csp of policies) {
        expect(csp, `rule ${rule}`).not.toContain("'self'");
        expect(csp, `rule ${rule}`).toContain("__PUBLIC_ORIGIN__");
      }
    }
    for (const rule of ["/overlay", "/overlay/*"]) {
      expect(rules.get(rule)?.join("\n")).toContain("wss://irc-ws.chat.twitch.tv");
      expect(rules.get(rule)?.join("\n")).toContain("__PUBLIC_WSS__");
    }
  });

  it("allows CORS only on built assets and fonts, never HTML", () => {
    for (const rule of ["/assets/*", "/fonts/*"]) {
      expect(rules.get(rule)).toContain("Access-Control-Allow-Origin: *");
    }
    for (const path of ["/", "/login", "/studio", "/overlay", "/overlay/x"]) {
      expect(headersForPath(path).join("\n")).not.toContain("Access-Control-Allow-Origin");
    }
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

    expect(overlayRules).toContain("ws://localhost:*");
    expect(overlayRules).toContain("ws://127.0.0.1:*");
    expect(overlayRules).not.toContain("frame-ancestors");
  });
});
