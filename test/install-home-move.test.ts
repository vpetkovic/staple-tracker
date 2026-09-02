/**
 * A8 (STA-38) — the installer's half of `staple config home <path> --move`.
 *
 * A3 (STA-33) built `moveHome()` and stopped at the runtime boundary: "the
 * current.json switch and launcher-target verification from plan §2 are yours."
 * So these tests drive the real composition — A3's `moveHome()` followed by
 * A8's `verifyRuntimeAfterHomeMove()` — rather than testing the installer half
 * against a mock of the config half.
 *
 * The property that matters most is the negative one. Plan §2: "If verification
 * fails, restore the old locator and `current.json`." A home move that half
 * succeeds must leave the machine running the runtime it was running before,
 * because the alternative is a user with no working `staple` and no obvious way
 * to get one back.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { moveHome, readBootstrapLocator, writeBootstrapLocator } from "../src/config/index.js";
import {
  installRuntime,
  readCurrent,
  rollbackRuntime,
  verifyRuntimeAfterHomeMove,
} from "../src/install/index.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";
import { writeFakePayload } from "./fixtures/install-support.js";

let scratch: string;
let oldHome: string;
let newHome: string;
let binDir: string;
let payloads: string;
let locatorPath: string;

beforeEach(() => {
  scratch = tempDir("install-move");
  oldHome = join(scratch, "old-home");
  newHome = join(scratch, "new-home");
  binDir = join(scratch, "bin");
  payloads = join(scratch, "payloads");
  locatorPath = join(scratch, "locator", "bootstrap.json");
  mkdirSync(payloads, { recursive: true });
});

afterEach(() => {
  removeDir(scratch);
});

function install(version: string, home = oldHome) {
  return installRuntime({
    home,
    binDir,
    from: writeFakePayload(join(payloads, version), version),
    locatorPath,
    env: { ...process.env, STAPLE_HOME: home },
  });
}

/** `moveHome()` then the installer's verification — the real composed flow. */
function move(options: { restoreOnFailure?: boolean; throwOnFailure?: boolean } = {}) {
  const result = moveHome({ from: oldHome, to: newHome, locatorPath });
  const runtime = verifyRuntimeAfterHomeMove({
    from: result.from,
    to: result.to,
    locatorPath,
    binDir,
    // With the locator now naming the new home, the launcher must resolve
    // through it — so STAPLE_HOME must not shadow it in this environment.
    env: { ...process.env, STAPLE_HOME: "" },
    ...options,
  });
  return { result, runtime };
}

function runLauncher(env: NodeJS.ProcessEnv = {}) {
  return spawnSync(join(binDir, "staple"), ["--version"], {
    encoding: "utf8",
    env: { ...process.env, STAPLE_HOME: "", XDG_CONFIG_HOME: "", ...env },
  });
}

describe("a home with a runtime moves and stays runnable", () => {
  it("carries the runtime across and keeps current.json valid at the new home", () => {
    install("1.0.0");

    const { result, runtime } = move();

    expect(result.copied).toContain("runtime");
    expect(runtime.ok).toBe(true);
    expect(runtime.runtimePresent).toBe(true);
    expect(runtime.version).toBe("1.0.0");
    expect(readCurrent(newHome)!.version).toBe("1.0.0");
    expect(existsSync(join(newHome, "runtime", "versions", "1.0.0", "staple.mjs"))).toBe(true);
  });

  it("needs NO rewrite of current.json — the entrypoint was already relative", () => {
    install("1.0.0");
    const before = readCurrent(oldHome)!;

    move();

    // Byte-identical pointer, resolving somewhere new. This is the whole reason
    // the entrypoint is stored relative to <home>/runtime.
    expect(readCurrent(newHome)).toEqual(before);
  });

  it("the launcher does not move and now resolves the NEW home", () => {
    install("1.0.0");
    const launcher = join(binDir, "staple");

    const { runtime } = move();

    expect(runtime.launcher?.path).toBe(launcher);
    expect(runtime.launcher?.home).toBe(newHome);
    expect(runtime.launcher?.target).toBe(join(newHome, "runtime", "versions", "1.0.0", "staple.mjs"));
    expect(readBootstrapLocator(locatorPath)!.home).toBe(newHome);
  });

  it("the moved runtime actually runs, resolved through the relocated locator", () => {
    install("1.0.0");
    move();

    // Prove it end to end: delete the old home entirely, then run the launcher
    // with nothing but the locator to go on.
    rmSync(oldHome, { recursive: true, force: true });
    const fakeHome = join(scratch, "userhome");
    writeBootstrapLocator(join(fakeHome, "Library", "Application Support", "Staple", "bootstrap.json"), newHome);
    writeBootstrapLocator(join(fakeHome, ".config", "staple", "bootstrap.json"), newHome);

    const run = runLauncher({ HOME: fakeHome });
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("1.0.0");
  });

  it("verifies the ROLLBACK target too, not just the active version", () => {
    install("1.0.0");
    install("2.0.0");

    const { runtime } = move();

    expect(runtime.version).toBe("2.0.0");
    expect(runtime.previousVersion).toBe("1.0.0");
    // Both, sorted by the order they are checked: active first, then rollback.
    expect(runtime.verifiedVersions.sort()).toEqual(["1.0.0", "2.0.0"]);
  });

  it("rollback still works at the new home after the move", () => {
    install("1.0.0");
    install("2.0.0");
    move();

    const rolled = rollbackRuntime({
      home: newHome,
      binDir,
      locatorPath,
      env: { ...process.env, STAPLE_HOME: "" },
    });
    expect(rolled.to).toBe("1.0.0");
    expect(readCurrent(newHome)!.version).toBe("1.0.0");
  });
});

describe("a home with no runtime is a clean pass, not a failure", () => {
  it("moves a home that was never installed into without complaining", () => {
    mkdirSync(oldHome, { recursive: true });
    writeFileSync(join(oldHome, "config.json"), `{"schemaVersion":1}\n`);

    const { runtime } = move();

    expect(runtime.ok).toBe(true);
    expect(runtime.runtimePresent).toBe(false);
    expect(runtime.launcher).toBeNull();
    expect(readBootstrapLocator(locatorPath)!.home).toBe(newHome);
  });

  it("does not fail a move just because the launcher was never installed", () => {
    install("1.0.0");
    rmSync(join(binDir, "staple"));

    const { runtime } = move();

    // A missing launcher is a supported state — the runtime is still reachable
    // by absolute path — so it must not veto an otherwise sound move.
    expect(runtime.ok).toBe(true);
    expect(runtime.launcher?.present).toBe(false);
  });
});

describe("failed verification restores the old locator (plan §2)", () => {
  it("restores when the active runtime did not arrive intact", () => {
    install("1.0.0");
    moveHome({ from: oldHome, to: newHome, locatorPath });
    expect(readBootstrapLocator(locatorPath)!.home).toBe(newHome);

    // Simulate a copy that lost bytes on the way over.
    writeFileSync(join(newHome, "runtime", "versions", "1.0.0", "assets", "index.html"), "truncated");

    expect(() =>
      verifyRuntimeAfterHomeMove({
        from: oldHome,
        to: newHome,
        locatorPath,
        binDir,
        env: { ...process.env, STAPLE_HOME: "" },
      }),
    ).toThrow(/did not survive the move/);

    // The locator points back at the old home, which was never modified, so the
    // machine is running exactly the runtime it ran before the move.
    expect(readBootstrapLocator(locatorPath)!.home).toBe(oldHome);
    expect(readCurrent(oldHome)!.version).toBe("1.0.0");
  });

  it("restores when the runtime tree did not arrive at all", () => {
    install("1.0.0");
    moveHome({ from: oldHome, to: newHome, locatorPath });
    rmSync(join(newHome, "runtime"), { recursive: true, force: true });

    expect(() =>
      verifyRuntimeAfterHomeMove({
        from: oldHome,
        to: newHome,
        locatorPath,
        binDir,
        env: { ...process.env, STAPLE_HOME: "" },
      }),
    ).toThrow(/did not survive the move/);

    expect(readBootstrapLocator(locatorPath)!.home).toBe(oldHome);
  });

  it("restores when the ROLLBACK target was lost, even though the active one is fine", () => {
    install("1.0.0");
    install("2.0.0");
    moveHome({ from: oldHome, to: newHome, locatorPath });
    rmSync(join(newHome, "runtime", "versions", "1.0.0"), { recursive: true, force: true });

    const error = (() => {
      try {
        verifyRuntimeAfterHomeMove({
          from: oldHome,
          to: newHome,
          locatorPath,
          binDir,
          env: { ...process.env, STAPLE_HOME: "" },
        });
        return null;
      } catch (caught) {
        return caught as Error;
      }
    })();

    // Losing only the rollback target is the quiet failure: everything works
    // until the day the user needs `install --rollback`, by which time the old
    // home may be gone.
    expect(error?.message).toMatch(/the rollback runtime 1\.0\.0 did not arrive/);
    expect(readBootstrapLocator(locatorPath)!.home).toBe(oldHome);
  });

  it("can audit without restoring or throwing, for a doctor-style report", () => {
    install("1.0.0");
    moveHome({ from: oldHome, to: newHome, locatorPath });
    rmSync(join(newHome, "runtime", "versions", "1.0.0"), { recursive: true, force: true });

    const runtime = verifyRuntimeAfterHomeMove({
      from: oldHome,
      to: newHome,
      locatorPath,
      binDir,
      env: { ...process.env, STAPLE_HOME: "" },
      restoreOnFailure: false,
      throwOnFailure: false,
    });

    expect(runtime.ok).toBe(false);
    expect(runtime.restored).toBe(false);
    expect(runtime.problems.length).toBeGreaterThan(0);
    expect(readBootstrapLocator(locatorPath)!.home).toBe(newHome);
  });
});
