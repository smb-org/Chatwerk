import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const design = readFileSync(path.join(root, "DESIGN.md"), "utf8");

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/.{2}/gu)!.map((part) => Number.parseInt(part, 16) / 255);
  const linear = channels.map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return linear[0]! * 0.2126 + linear[1]! * 0.7152 + linear[2]! * 0.0722;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)].sort((left, right) => right - left);
  return (values[0]! + 0.05) / (values[1]! + 0.05);
}

describe("Studio design assets", () => {
  it("documents the exact dark UI tokens and their recomputed contrast ratios", () => {
    const rows = [...design.matchAll(/^\| `(--ui-[\w-]+)` \| (#[0-9A-Fa-f]{6}) \| ([^|]+) \|$/gmu)];
    expect(rows.length).toBeGreaterThanOrEqual(10);
    const colors = new Map(rows.map(([, token, color]) => [token!, color!]));
    const ratios = new Map(rows.map(([, token, , ratio]) => [token!, ratio!.trim()]));
    const background = colors.get("--ui-bg")!;
    const expected = new Map([
      ["--ui-fg", 14.6], ["--ui-muted", 7.0], ["--ui-accent", 8.2],
      ["--ui-ok", 9.3], ["--ui-danger", 7.4],
    ]);
    for (const [token, ratio] of expected) {
      expect(ratios.get(token), token).toContain(`${ratio.toFixed(1)}:1`);
      expect(contrast(colors.get(token)!, background), token).toBeCloseTo(ratio, 1);
    }
    expect(contrast(colors.get("--ui-accent-ink")!, colors.get("--ui-accent")!)).toBeCloseTo(8.2, 1);
  });

  it("ships both OFL notices and compact self-hosted WOFF2 subsets", () => {
    for (const file of ["public/fonts/schibsted-grotesk-latin.woff2", "public/fonts/commit-mono-latin.woff2"]) {
      expect(statSync(path.join(root, file)).size, file).toBeLessThan(40 * 1024);
    }
    for (const file of ["public/fonts/OFL-Schibsted-Grotesk.txt", "public/fonts/OFL-Commit-Mono.txt"]) {
      expect(readFileSync(path.join(root, file), "utf8")).toContain("SIL OPEN FONT LICENSE");
    }
  });

  it("keeps Studio and renderer theme variables in separate stylesheets", () => {
    const studioCss = readFileSync(path.join(root, "src/studio/studio.css"), "utf8");
    const rendererFiles = ["overlay.css", "render.ts", "index.ts", "live.ts"];
    expect(studioCss).not.toMatch(/--t-[\w-]+/u);
    const documented = new Map(rowsFromDesign(design).map(([token, color]) => [token, color]));
    const declared = new Map([...studioCss.matchAll(/(--ui-[\w-]+):\s*(#[0-9A-Fa-f]{6})/gu)]
      .map(([, token, color]) => [token!, color!.toUpperCase()]));
    for (const [token, color] of documented) expect(declared.get(token), token).toBe(color.toUpperCase());
    for (const file of rendererFiles) {
      const source = readFileSync(path.join(root, "src/renderer", file), "utf8");
      expect(source, file).not.toMatch(/--ui-[\w-]+/u);
    }
  });
});

function rowsFromDesign(contents: string): Array<[string, string]> {
  return [...contents.matchAll(/^\| `(--ui-[\w-]+)` \| (#[0-9A-Fa-f]{6}) \|/gmu)]
    .map(([, token, color]) => [token!, color!]);
}
