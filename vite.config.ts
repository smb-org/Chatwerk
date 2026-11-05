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
        login: resolve(import.meta.dirname, "src/studio/login.html"),
        studio: resolve(import.meta.dirname, "src/studio/studio.html"),
        export: resolve(import.meta.dirname, "src/studio/export.html"),
        overlay: resolve(import.meta.dirname, "src/studio/overlay.html"),
      },
    },
  },
});
