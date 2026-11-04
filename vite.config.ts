import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig({
  root: "src/studio",
  publicDir: "../../public",
  build: {
    target: "chrome95",
    outDir: "../../dist/client",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, "src/studio/index.html"),
        overlay: resolve(import.meta.dirname, "src/studio/overlay.html"),
      },
    },
  },
});
