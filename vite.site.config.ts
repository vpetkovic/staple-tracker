import { resolve } from "node:path";
import { defineConfig } from "vite";

const siteRoot = resolve(import.meta.dirname, "site");

export default defineConfig({
  root: siteRoot,
  build: {
    outDir: resolve(import.meta.dirname, "dist-site"),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        home: resolve(siteRoot, "index.html"),
        docs: resolve(siteRoot, "docs.html"),
        roadmap: resolve(siteRoot, "roadmap.html"),
      },
    },
  },
});
