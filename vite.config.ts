import { defineConfig } from "vite";

export default defineConfig({
  root: "src/studio",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
  },
});
