/**
 * A3 (STA-33) — the single home resolver.
 *
 * STA-24 plan §2 fixes the order: `--home`, then `STAPLE_HOME`, then the
 * platform bootstrap locator, then `~/.staple`. Before A3 the home was computed
 * in three places with two different fallbacks, one of which produced a literal
 * `~` directory beside the cwd when `HOME` was unset (A1 pinned that in
 * characterize-env-contract.test.ts). These tests are the "after".
 *
 * `os.homedir()` honours `$HOME` on POSIX and re-reads it per call, so a test
 * can move the whole notion of "home" by assigning `process.env.HOME`. Vitest
 * isolates each file in its own process, so that is contained here.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  clearHomeOverride,
  defaultHome,
  resolveHome,
  setHomeOverride,
  stapleHome,
} from "../src/config/index.js";
import { bootstrapLocatorPath } from "../src/config/locator.js";
import { StapleError } from "../src/core/types.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";
import { readCode, sourceFiles } from "./fixtures/source-scan.js";

const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_XDG = process.env.XDG_CONFIG_HOME;
const ORIGINAL_APPDATA = process.env.APPDATA;

let fakeHome: string;

/** Point every home primitive at a scratch directory with no locator in it. */
function useFakeHome(): void {
  process.env.HOME = fakeHome;
  delete process.env.XDG_CONFIG_HOME;
  process.env.APPDATA = join(fakeHome, "AppData", "Roaming");
}

/** Plant a bootstrap locator where the current platform will look for it. */
function plantLocator(home: string): string {
  const path = bootstrapLocatorPath();
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, JSON.stringify({ schemaVersion: 1, home }));
  return path;
}

beforeEach(() => {
  fakeHome = tempDir("cfg-home");
  useFakeHome();
  delete process.env.STAPLE_HOME;
  clearHomeOverride();
});

afterEach(() => {
  clearHomeOverride();
  delete process.env.STAPLE_HOME;
  removeDir(fakeHome);
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_XDG === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = ORIGINAL_XDG;
  if (ORIGINAL_APPDATA === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = ORIGINAL_APPDATA;
});

describe("home resolution order", () => {
  it("falls back to <home>/.staple when nothing else is set", () => {
    expect(resolveHome()).toEqual({ path: join(fakeHome, ".staple"), source: "default" });
  });

  it("prefers the bootstrap locator over the default", () => {
    const relocated = join(fakeHome, "relocated");
    plantLocator(relocated);
    expect(resolveHome()).toEqual({ path: relocated, source: "locator" });
  });

  it("prefers STAPLE_HOME over the locator", () => {
    plantLocator(join(fakeHome, "relocated"));
    const env = join(fakeHome, "from-env");
    process.env.STAPLE_HOME = env;
    expect(resolveHome()).toEqual({ path: env, source: "env" });
  });

  it("prefers an explicit --home override over STAPLE_HOME", () => {
    plantLocator(join(fakeHome, "relocated"));
    process.env.STAPLE_HOME = join(fakeHome, "from-env");
    const flag = join(fakeHome, "from-flag");
    setHomeOverride(flag);
    expect(resolveHome()).toEqual({ path: flag, source: "flag" });
  });

  it("clears the override again", () => {
    setHomeOverride(join(fakeHome, "from-flag"));
    clearHomeOverride();
    expect(resolveHome().source).toBe("default");
  });

  it("stapleHome() is resolveHome().path", () => {
    process.env.STAPLE_HOME = join(fakeHome, "from-env");
    expect(stapleHome()).toBe(resolveHome().path);
  });
});

describe("home resolution hygiene", () => {
  /**
   * The bug this ticket exists to kill. `process.env.HOME ?? "~"` produced a
   * LITERAL relative directory named `~` beside the cwd; `os.homedir()` falls
   * back to the passwd entry, which is a real absolute path.
   *
   * Deleting HOME also deletes this suite's only handle on the locator: with no
   * HOME there is no scratch directory to point it at, and on macOS the locator
   * path takes no environment input at all, so `resolveHome()` here reads
   * whatever locator the real machine happens to have. Pin the DEFAULT branch —
   * the one the tilde bug lived in — by name, and ask of the full resolver only
   * the machine-independent thing: no branch of it ever invents a literal `~`.
   */
  it("never yields a literal ~ path when HOME is unset", () => {
    delete process.env.HOME;
    expect(defaultHome()).toBe(join(homedir(), ".staple"));
    expect(defaultHome()).not.toContain("~");
    expect(resolveHome().path).not.toContain("~");
  });

  it("returns an absolute path for every source", () => {
    const relative = "relative/home";
    process.env.STAPLE_HOME = relative;
    expect(resolveHome().path.startsWith("/") || /^[A-Za-z]:/.test(resolveHome().path)).toBe(true);
  });

  /**
   * Existing suites assign `process.env.STAPLE_HOME` in a `beforeEach` AFTER the
   * module graph has loaded (see hub.test.ts, ui-token-inject.test.ts). Any
   * memoization of the resolved home would silently break all of them.
   */
  it("re-reads the environment on every call rather than memoizing", () => {
    const first = join(fakeHome, "one");
    const second = join(fakeHome, "two");
    process.env.STAPLE_HOME = first;
    expect(stapleHome()).toBe(first);
    process.env.STAPLE_HOME = second;
    expect(stapleHome()).toBe(second);
    delete process.env.STAPLE_HOME;
    expect(stapleHome()).toBe(join(fakeHome, ".staple"));
  });

  it("rejects an override that is not absolute", () => {
    expect(() => setHomeOverride("./relative")).toThrow(StapleError);
  });
});

describe("the resolver is the only home primitive left in src/", () => {
  /**
   * A1 pinned the divergence as a source-text assertion so A3 would have a
   * written "before". This is the mirror image: the literal-`~` expression is
   * gone from every source file, and the three former call sites now import one
   * resolver instead of each rolling their own.
   */
  it("no source file computes a home from `process.env.HOME ?? \"~\"`", () => {
    const root = join(import.meta.dirname, "..", "src");
    const offenders = sourceFiles(root).filter((file) =>
      readCode(file).includes('process.env.HOME ?? "~"'),
    );
    expect(offenders).toEqual([]);
  });

  /** `os.homedir()` is the one home primitive; only the resolver may call it. */
  it("only src/config/home.ts calls os.homedir() for the staple home", () => {
    const root = join(import.meta.dirname, "..", "src");
    const callers = sourceFiles(root).filter((file) => /\bhomedir\(\)/.test(readCode(file)));
    expect(callers.map((f) => f.slice(root.length + 1)).sort()).toEqual([
      "config/home.ts",
      "config/locator.ts",
    ]);
  });

  it("hub, cli, and workspace all route through src/config", async () => {
    const { readFileSync } = await import("node:fs");
    const src = join(import.meta.dirname, "..", "src");
    for (const file of ["core/hub.ts", "cli.ts", "core/workspace.ts"]) {
      expect(readFileSync(join(src, file), "utf8"), file).toMatch(/from "\.*[./]*config\//);
    }
  });

  /** `core/workspace.ts` keeps exporting stapleHome so existing importers work. */
  it("core/workspace.ts still exports the same stapleHome symbol", async () => {
    const workspace = await import("../src/core/workspace.js");
    process.env.STAPLE_HOME = join(fakeHome, "shared");
    expect(workspace.stapleHome()).toBe(stapleHome());
  });
});
