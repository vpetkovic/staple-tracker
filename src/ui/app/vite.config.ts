import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { resolveHome } from "../../config/home.js";

/**
 * Dev-only mirror of the loopback courtesy `src/ui/server.ts` extends to its own
 * page: a tokenless visit to the dev server redirects to `/?token=…` using the
 * CLI's persistent `<staple home>/ui-token`, so plain http://localhost:4401 just
 * works. The home comes from `resolveHome()` — the one sanctioned resolver — so a
 * relocated or STAPLE_HOME-overridden home is honoured. The token is read per
 * request (rotation needs no vite restart) and the plugin never runs at build
 * time, so nothing token-shaped can reach the bundle.
 */
function seedUiToken(): Plugin {
  return {
    name: "staple-seed-ui-token",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/" || url.searchParams.has("token")) return next();
        let token: string;
        try {
          token = readFileSync(join(resolveHome().path, "ui-token"), "utf8").trim();
        } catch {
          return next(); // no token file: fall through to the app's token screen
        }
        url.searchParams.set("token", token);
        res.writeHead(302, { Location: url.pathname + url.search });
        res.end();
      });
    },
  };
}

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
  plugins: [react(), tailwindcss(), seedUiToken()],
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
