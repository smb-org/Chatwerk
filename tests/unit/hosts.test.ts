import { describe, expect, it } from "vitest";
import { isAllowedImageUrl } from "../../src/shared/hosts";

describe("allowed image URLs", () => {
  it("accepts nested bundled SVG assets", () => {
    expect(isAllowedImageUrl("/assets/samples/name-paint.svg")).toBe(true);
  });

  it.each([
    "/assets/unused\"),url(\"/health?x",
    "/assets/../x.svg",
    "/assets/%2e%2e/x.svg",
    "/assets/a%2Fb.svg",
    "//evil/x.svg",
  ])("rejects unsafe bundled asset path %s", (value) => {
    expect(isAllowedImageUrl(value)).toBe(false);
  });
});
