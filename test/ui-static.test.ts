/**
 * U1 — how the UI server hands out the built app.
 *
 * `staple ui` used to serve one hand-written index.html that lived next to the server.
 * It now serves a Vite bundle from src/ui/app/dist/, which introduces three things the
 * old arrangement could not get wrong and this suite therefore pins:
 *
 *  1. the bundle is *generated*, so it can be absent — and an absent bundle has to read
 *     as an instruction, never as a blank page or a stack trace;
 *  2. serving files by URL path means path traversal is now possible in principle, so
 *     the containment check is a security property, not a nicety;
 *  3. the page is still served WITHOUT a token (it has to load in order to read the
 *     token out of its own URL) while every /api/* route stays gated — the two rules
 *     look contradictory and are easy to "fix" in the wrong direction.
 *
 * These tests run against whatever state the working tree is in: if the bundle has been
 * built they assert the built page, otherwise they assert the placeholder. Both are
 * legitimate states of a checkout, and a test that only passes after a build would just
 * be a slower way of asserting that someone ran the build.
 */
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { initWorkspace } from "../src/core/workspace.js";
import { startUiServer, uiBundleExists, UI_BUILD_HINT, UI_DIST_DIR, type UiHandle } from "../src/ui/server.js";

let home: string;
let ui: UiHandle;
let origin: string;
let token: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "staple-uistatic-"));
  process.env.STAPLE_HOME = home;
  process.env.NODE_NO_WARNINGS = "1";
  const ws = initWorkspace({ global: true, slug: "uistatic" });
  ws.store.createIssue({ title: "Static task" });
  ws.store.db.close();

  ui = startUiServer({ port: 0, hub: false, db: ws.dbPath });
  await once(ui.server, "listening");
  token = ui.token;
  origin = `http://127.0.0.1:${(ui.server.address() as AddressInfo).port}`;
});

afterAll(() => {
  ui?.close();
  rmSync(home, { recursive: true, force: true });
});

describe("serving the app", () => {
  it("answers / with HTML and no token, because the page bootstraps from its own URL", async () => {
    const res = await fetch(`${origin}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("never caches the page, which carries the token in its URL until the app scrubs it", async () => {
    const res = await fetch(`${origin}/`);
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("says what to do when the bundle has not been built, rather than serving nothing", async () => {
    const body = await (await fetch(`${origin}/`)).text();
    if (uiBundleExists()) {
      // Vite's index.html loads the app as a module. If this ever stops being true the
      // page is not the built app, whatever else it is.
      expect(body).toContain('type="module"');
    } else {
      expect(body).toContain("npm run build:ui");
    }
  });

  it("points the CLI hint at the directory the server actually reads", () => {
    expect(UI_BUILD_HINT).toContain("npm run build:ui");
    expect(UI_BUILD_HINT).toContain(UI_DIST_DIR);
  });

  it("serves a built asset with its real content type", async () => {
    if (!uiBundleExists()) return; // nothing to serve; covered by the placeholder case
    const html = await (await fetch(`${origin}/`)).text();
    const asset = /(?:src|href)="\.?\/?(assets\/[^"]+\.js)"/.exec(html)?.[1];
    expect(asset, "built index.html should reference a hashed js asset").toBeTruthy();
    const res = await fetch(`${origin}/${asset}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    // Hashed filenames are safe to cache forever; that is the point of hashing them.
    expect(res.headers.get("cache-control")).toContain("immutable");
  });

  it("404s an asset that does not exist instead of throwing", async () => {
    const res = await fetch(`${origin}/assets/nope-does-not-exist.js`);
    expect(res.status).toBe(404);
  });
});

describe("the static handler cannot be walked out of", () => {
  // `fetch` normalizes `..` in a URL before it ever reaches the wire, so these have to
  // be encoded to reach the server as literal traversal attempts.
  const escapes = [
    "/%2e%2e/%2e%2e/package.json",
    "/assets/%2e%2e%2f%2e%2e%2f%2e%2e%2fpackage.json",
    "/%2e%2e%2f%2e%2e%2f%2e%2e%2f%2e%2e%2fetc%2fpasswd",
    "/..%2f..%2fpackage.json",
  ];

  for (const path of escapes) {
    it(`refuses ${path}`, async () => {
      const res = await fetch(`${origin}${path}`);
      expect(res.status, path).toBe(404);
      // A 404 that still leaked the file would be the actual bug.
      expect(await res.text()).not.toContain("@modelcontextprotocol/sdk");
    });
  }

  it("refuses a null byte in the path", async () => {
    const res = await fetch(`${origin}/index.html%00.png`);
    expect(res.status).toBe(404);
  });
});

describe("static serving did not widen the auth surface", () => {
  it("still gates /api/* even though sibling paths are now served freely", async () => {
    for (const path of ["/api/bootstrap", "/api/poll", "/api/issues", "/api/graph"]) {
      expect((await fetch(`${origin}${path}`)).status, path).toBe(401);
    }
  });

  it("does not serve an /api path as a static file even if one existed on disk", async () => {
    // /api/index.html is not a route and must not become one by falling through to the
    // static handler — the gate runs first, so this is 401, not 404 and not a file.
    const res = await fetch(`${origin}/api/index.html`);
    expect(res.status).toBe(401);
  });

  it("still answers the API for an authenticated caller", async () => {
    const res = await fetch(`${origin}/api/issues`, { headers: { "x-staple-token": token } });
    expect(res.status).toBe(200);
    expect((await res.json()) as unknown[]).toHaveLength(1);
  });
});
