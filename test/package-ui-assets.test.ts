/**
 * UI asset resolution across the two layouts staple actually ships in.
 *
 * In the repository the server module sits at src/ui/server.ts and the Vite bundle
 * lands beside it at src/ui/app/dist/. In the published package there is no src tree
 * at all: one bundled staple.mjs sits at the package root with the same bundle copied
 * next to it as assets/ — the layout STA-24's plan pins for installed runtimes
 * (`<version>/staple.mjs` + `<version>/assets/index.html`).
 *
 * resolveUiDistDir is the whole seam: given the directory the running module lives in,
 * it answers where the bundle is. It probes the packaged layout first and falls back to
 * the repository layout, so a source checkout keeps its exact current behaviour —
 * src/ui/assets/ never exists, so the fallback is the only reachable answer there.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveUiDistDir, UI_DIST_DIR, UI_BUILD_HINT } from "../src/ui/server.js";

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "staple-assets-"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveUiDistDir", () => {
  it("prefers a packaged assets/ directory beside the running module", () => {
    const runtime = join(root, "packaged");
    mkdirSync(join(runtime, "assets"), { recursive: true });
    writeFileSync(join(runtime, "assets", "index.html"), "<!doctype html>");

    expect(resolveUiDistDir(runtime)).toBe(join(runtime, "assets"));
  });

  it("falls back to the repository app/dist layout when there is no assets/", () => {
    const runtime = join(root, "repo-like");
    mkdirSync(join(runtime, "app", "dist"), { recursive: true });
    writeFileSync(join(runtime, "app", "dist", "index.html"), "<!doctype html>");

    expect(resolveUiDistDir(runtime)).toBe(join(runtime, "app", "dist"));
  });

  it("falls back to app/dist when nothing is built at all, so the hint stays buildable", () => {
    const runtime = join(root, "empty");
    mkdirSync(runtime, { recursive: true });

    expect(resolveUiDistDir(runtime)).toBe(join(runtime, "app", "dist"));
  });

  it("ignores an assets/ directory that carries no index.html", () => {
    const runtime = join(root, "decoy");
    mkdirSync(join(runtime, "assets"), { recursive: true });
    writeFileSync(join(runtime, "assets", "stray.css"), "body{}");

    expect(resolveUiDistDir(runtime)).toBe(join(runtime, "app", "dist"));
  });
});

describe("the repository keeps its existing layout", () => {
  it("UI_DIST_DIR still points at src/ui/app/dist", () => {
    const serverDir = dirname(fileURLToPath(new URL("../src/ui/server.ts", import.meta.url)));
    expect(UI_DIST_DIR).toBe(resolve(serverDir, "app", "dist"));
  });

  it("the build hint still names that directory and the repo build command", () => {
    expect(UI_BUILD_HINT).toContain("npm run build:ui");
    expect(UI_BUILD_HINT).toContain(join(UI_DIST_DIR, "index.html"));
  });
});
