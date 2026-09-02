import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

/**
 * The app builds to `src/ui/app/dist/`, which `src/ui/server.ts` serves off disk.
 * Nothing here runs at `staple ui` time — the bundle is a static artifact, which is
 * why every package this config touches is a devDependency.
 *
 * `base: "./"` keeps asset URLs relative so the page does not care what path it is
 * mounted at, and the dev server proxies /api to a `staple ui` you started yourself
 * (the token still comes from that process's printed URL).
 */
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // One page, one bundle: this is a local tool on loopback, not a CDN.
    chunkSizeWarningLimit: 1500,
  },
  server: {
    port: 4401,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:4400",
        // The staple server Origin-checks writes against its own bound port; the
        // browser sends Origin: :4401, so the proxy must present the target's.
        configure: (proxy) =>
          proxy.on("proxyReq", (proxyReq) => proxyReq.setHeader("origin", "http://127.0.0.1:4400")),
      },
    },
  },
});
