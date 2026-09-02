/**
 * A8 (STA-38) — the launcher itself: where it goes, what it contains, and the
 * one duplication in it that has to be kept honest.
 *
 * The launcher cannot import `src/config/home.ts`, because it runs before any
 * staple code is loaded and its whole job is to find the code to load. So it
 * re-implements the home-resolution ORDER from plan §2. That duplication is
 * bounded and deliberate, but duplication that nothing checks is duplication
 * that drifts — these tests execute the emitted launcher against each rung of
 * the ladder and compare it to what `src/config/home.ts` answers.
 *
 * Windows is covered structurally, the way A3 covered the locator table:
 * `platform` is injectable, so all three rows are provable on one OS.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  LAUNCHER_MARKER,
  defaultBinDir,
  installLauncher,
  installRuntime,
  isManagedLauncher,
  launcherPath,
  resolveLauncherHome,
  verifyLauncherTarget,
} from "../src/install/index.js";
import { resolveHome, writeBootstrapLocator } from "../src/config/index.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";
import { writeFakePayload } from "./fixtures/install-support.js";

let scratch: string;
let home: string;
let binDir: string;

beforeEach(() => {
  scratch = tempDir("install-launcher");
  home = join(scratch, "home");
  binDir = join(scratch, "bin");
});

afterEach(() => {
  removeDir(scratch);
});

describe("launcher location per platform (plan §2)", () => {
  it("POSIX: ~/.local/bin/staple", () => {
    const dir = defaultBinDir({ platform: "linux", home: "/home/dev", env: {} });
    expect(dir).toBe("/home/dev/.local/bin");
    expect(launcherPath(dir, { platform: "linux" })).toBe("/home/dev/.local/bin/staple");
  });

  it("macOS: ~/.local/bin/staple", () => {
    expect(defaultBinDir({ platform: "darwin", home: "/Users/dev", env: {} })).toBe(
      "/Users/dev/.local/bin",
    );
  });

  it("Windows: %LOCALAPPDATA%\\Staple\\bin\\staple.cmd", () => {
    const dir = defaultBinDir({
      platform: "win32",
      home: "C:\\Users\\dev",
      env: { LOCALAPPDATA: "C:\\Users\\dev\\AppData\\Local" },
    });
    expect(dir).toBe("C:\\Users\\dev\\AppData\\Local\\Staple\\bin");
    expect(launcherPath(dir, { platform: "win32" })).toContain("staple.cmd");
  });

  it("Windows: falls back to AppData\\Local when LOCALAPPDATA is unset or empty", () => {
    for (const env of [{}, { LOCALAPPDATA: "" }]) {
      expect(defaultBinDir({ platform: "win32", home: "C:\\Users\\dev", env })).toBe(
        "C:\\Users\\dev\\AppData\\Local\\Staple\\bin",
      );
    }
  });

  it("Windows writes a .cmd shim beside the ESM resolver it runs", () => {
    const result = installLauncher({ binDir, platform: "win32" });

    expect(result.path).toBe(join(binDir, "staple.cmd"));
    expect(result.modulePath).toBe(join(binDir, "staple-launcher.mjs"));
    // `.cmd` cannot host ESM, so the pair is the only workable shape.
    const cmd = readFileSync(result.path, "utf8");
    expect(cmd).toContain('node "%~dp0staple-launcher.mjs" %*');
    expect(cmd).toContain(LAUNCHER_MARKER);
    expect(readFileSync(result.modulePath!, "utf8")).toContain("#!/usr/bin/env node");
  });

  it("POSIX writes one executable file and no sidecar", () => {
    const result = installLauncher({ binDir, platform: "linux" });

    expect(result.path).toBe(join(binDir, "staple"));
    expect(result.modulePath).toBeNull();
    expect(statSync(result.path).mode & 0o777).toBe(0o755);
  });
});

describe("the launcher contains no absolute path into the home", () => {
  it("is byte-identical regardless of which home it was installed for", () => {
    const a = join(scratch, "home-a");
    const b = join(scratch, "home-b");
    const payload = writeFakePayload(join(scratch, "p"), "1.0.0");
    installRuntime({ home: a, binDir: join(scratch, "bin-a"), from: payload });
    installRuntime({ home: b, binDir: join(scratch, "bin-b"), from: payload });

    // Plan §2: "The launcher path itself does not move." It can only stay put
    // across a home move because it names no home.
    expect(readFileSync(join(scratch, "bin-a", "staple"), "utf8")).toBe(
      readFileSync(join(scratch, "bin-b", "staple"), "utf8"),
    );
  });

  it("mentions neither a home nor a version anywhere in its body", () => {
    installRuntime({ home, binDir, from: writeFakePayload(join(scratch, "p"), "1.2.3") });
    const body = readFileSync(join(binDir, "staple"), "utf8");

    expect(body).not.toContain(home);
    expect(body).not.toContain("1.2.3");
    expect(body).not.toContain("versions/");
  });
});

describe("the launcher's home resolution matches src/config/home.ts", () => {
  it("STAPLE_HOME > locator > ~/.staple, proven by executing the launcher", () => {
    // A runtime in each candidate home, each reporting a distinguishable
    // version, so the version the launcher prints names the home it chose.
    const envHome = join(scratch, "env-home");
    const locatorHome = join(scratch, "locator-home");
    const userHome = join(scratch, "user");
    const defaultHome = join(userHome, ".staple");

    installRuntime({ home: envHome, binDir, from: writeFakePayload(join(scratch, "p-env"), "1.0.0") });
    installRuntime({ home: locatorHome, binDir, from: writeFakePayload(join(scratch, "p-loc"), "2.0.0") });
    installRuntime({ home: defaultHome, binDir, from: writeFakePayload(join(scratch, "p-def"), "3.0.0") });

    const macLocator = join(userHome, "Library", "Application Support", "Staple", "bootstrap.json");
    const linuxLocator = join(userHome, ".config", "staple", "bootstrap.json");

    const run = (env: NodeJS.ProcessEnv) =>
      spawnSync(join(binDir, "staple"), ["--version"], {
        encoding: "utf8",
        env: { ...process.env, HOME: userHome, XDG_CONFIG_HOME: "", ...env },
      }).stdout.trim();

    // Rung 3: nothing set, no locator on disk.
    expect(run({ STAPLE_HOME: "" })).toBe("3.0.0");

    // Rung 2: a locator appears.
    writeBootstrapLocator(macLocator, locatorHome);
    writeBootstrapLocator(linuxLocator, locatorHome);
    expect(run({ STAPLE_HOME: "" })).toBe("2.0.0");

    // Rung 1: STAPLE_HOME outranks the locator.
    expect(run({ STAPLE_HOME: envHome })).toBe("1.0.0");
  });

  it("resolveLauncherHome agrees with resolveHome() on the same inputs", () => {
    const locatorPath = join(scratch, "locator", "bootstrap.json");
    writeBootstrapLocator(locatorPath, home);

    // env rung
    expect(resolveLauncherHome({ env: { STAPLE_HOME: home }, locatorPath })).toEqual({
      home,
      source: "env",
    });
    // locator rung
    expect(resolveLauncherHome({ env: {}, locatorPath })).toEqual({ home, source: "locator" });

    // And the config module, driven through its own env, lands on the same path.
    const saved = process.env.STAPLE_HOME;
    try {
      process.env.STAPLE_HOME = home;
      expect(resolveHome()).toEqual({ path: home, source: "env" });
    } finally {
      if (saved === undefined) delete process.env.STAPLE_HOME;
      else process.env.STAPLE_HOME = saved;
    }
  });

  it("treats an empty STAPLE_HOME as unset, exactly as the config resolver does", () => {
    const locatorPath = join(scratch, "locator", "bootstrap.json");
    writeBootstrapLocator(locatorPath, home);
    expect(resolveLauncherHome({ env: { STAPLE_HOME: "" }, locatorPath }).source).toBe("locator");
  });
});

describe("ownership and verification", () => {
  it("recognises only launchers it wrote", () => {
    installLauncher({ binDir, platform: "linux" });
    expect(isManagedLauncher(join(binDir, "staple"))).toBe(true);
    expect(isManagedLauncher(join(binDir, "nothing-here"))).toBe(false);
  });

  it("refreshing an existing managed launcher is idempotent", () => {
    const first = installLauncher({ binDir, platform: "linux" });
    expect(first.created).toBe(true);
    const bytes = readFileSync(first.path, "utf8");

    const second = installLauncher({ binDir, platform: "linux" });
    expect(second.created).toBe(false);
    expect(second.refreshed).toBe(true);
    expect(readFileSync(second.path, "utf8")).toBe(bytes);
  });

  it("reports a launcher that resolves a different home than the one installed into", () => {
    installRuntime({ home, binDir, from: writeFakePayload(join(scratch, "p"), "1.0.0") });

    const elsewhere = join(scratch, "elsewhere");
    const verification = verifyLauncherTarget({
      binDir,
      expectHome: home,
      env: { STAPLE_HOME: elsewhere },
    });

    expect(verification.ok).toBe(false);
    expect(verification.home).toBe(elsewhere);
    expect(verification.problems.join("\n")).toMatch(/resolves the home to .*elsewhere/);
  });

  it("reports a missing launcher without throwing", () => {
    mkdirSync(binDir, { recursive: true });
    const verification = verifyLauncherTarget({ binDir, expectHome: home });

    expect(verification.present).toBe(false);
    expect(verification.ok).toBe(false);
    expect(verification.target).toBeNull();
  });

  it("never emits a privilege escalator into the launcher", () => {
    // The launcher runs on every single `staple` invocation. A sudo in here
    // would be the single worst line in the product.
    installLauncher({ binDir, platform: "linux" });
    installLauncher({ binDir: join(scratch, "win"), platform: "win32" });

    for (const path of [
      join(binDir, "staple"),
      join(scratch, "win", "staple.cmd"),
      join(scratch, "win", "staple-launcher.mjs"),
    ]) {
      expect(existsSync(path)).toBe(true);
      expect(readFileSync(path, "utf8")).not.toMatch(/\bsudo\b|\bdoas\b|\bpkexec\b|runas/i);
    }
  });
});
