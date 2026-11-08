import { describe, expect, it } from "vitest";
import { isTransientCloudflareFailure } from "../../../scripts/deploy.mjs";

describe("isTransientCloudflareFailure", () => {
  it.each([
    ["D1 API error: request failed", true],
    ["✘ [ERROR] A request to the Cloudflare API (/accounts/123/d1/database/456/query) failed.", true],
    ["Request failed with status code: 503", true],
    ["Cloudflare API returned error 522", true],
    ["no healthy upstream", true],
    ["Malformed API response from Cloudflare", true],
    ["Invalid API response from Cloudflare", true],
    ["D1_ERROR: no such table: missing_table", false],
    ["Authentication error: invalid token", false],
    ["HTTP 400 Bad Request", false],
  ])("classifies %j as transient=%s", (output, expected) => {
    expect(isTransientCloudflareFailure(output)).toBe(expected);
  });
});
