import { defineConfig } from "vite";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const projectRoot = import.meta.dirname;

function overlayBuildId(mode: string): string {
  const files = [
    ...listFiles(resolve(projectRoot, "src/renderer")),
    ...listFiles(resolve(projectRoot, "src/shared")),
    ...listFiles(resolve(projectRoot, "public")),
    resolve(projectRoot, "src/studio/overlay.html"),
    resolve(projectRoot, "package.json"),
    resolve(projectRoot, "pnpm-lock.yaml"),
    resolve(projectRoot, "vite.config.ts"),
  ].sort();
  const hash = createHash("sha256");
  hash.update(JSON.stringify({ mode, testFeaturesEnabled: mode === "test" && process.env.CHATWERK_TEST_FEATURES === "1" }));
  hash.update("\0");
  for (const file of files) {
    hash.update(relative(projectRoot, file).replaceAll("\\", "/"));
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex").slice(0, 16);
}

function listFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? listFiles(path) : [path];
  });
}

export default defineConfig(({ mode }) => ({
  root: "src/studio",
  publicDir: "../../public",
  define: {
    __CHATWERK_BUILD_ID__: JSON.stringify(overlayBuildId(mode)),
    __CHATWERK_TEST_FEATURES__: mode === "test" && process.env.CHATWERK_TEST_FEATURES === "1"
      ? JSON.stringify({ reactions: true, hypeTrain: true })
      : "undefined",
  },
  build: {
    target: "chrome95",
    outDir: "../../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        login: resolve(import.meta.dirname, "src/studio/login.html"),
        studio: resolve(import.meta.dirname, "src/studio/studio.html"),
        export: resolve(import.meta.dirname, "src/studio/export.html"),
        gallery: resolve(import.meta.dirname, "src/studio/gallery.html"),
        theme: resolve(import.meta.dirname, "src/studio/theme.html"),
        overlay: resolve(import.meta.dirname, "src/studio/overlay.html"),
      },
    },
  },
}));
