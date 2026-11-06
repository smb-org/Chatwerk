import { defineConfig } from "vite";
import { resolve } from "node:path";

export default defineConfig(({ mode }) => ({
  root: "src/studio",
  publicDir: "../../public",
  define: {
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
