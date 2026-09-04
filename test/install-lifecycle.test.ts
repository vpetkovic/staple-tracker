/**
 * A8 (STA-38) — the full install lifecycle against a throwaway home.
 *
 * The ticket names the run this file has to perform end to end:
 *
 *   install v1 -> verify the launcher EXECS it
 *   stage a corrupt payload -> refused, `current.json` untouched
 *   install v2 -> switch
 *   rollback -> v1
 *   no step requires elevated permissions
 *   every write inside the home or the launcher dir
 *
 * The launcher is executed for real, as a child process, with an environment
 * that points it at the temporary home. Asserting on `current.json` alone would
 * prove the installer wrote what it meant to write; running the launcher proves
 * the user gets the runtime that file names.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import {
  installRuntime,
  installStatus,
  listInstalledVersions,
  payloadWorkspaceSchema,
  readCurrent,
  rollbackRuntime,
  stagePayload,
  verifyLauncherTarget,
  verifyRuntimeTree,
} from "../src/install/index.js";
import { writeBootstrapLocator } from "../src/config/index.js";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { StapleError } from "../src/core/types.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";
import { writeFakePayload } from "./fixtures/install-support.js";

let scratch: string;
let home: string;
let binDir: string;
let payloads: string;
let locatorPath: string;

beforeEach(() => {
  scratch = tempDir("install-lifecycle");
  home = join(scratch, "home");
  binDir = join(scratch, "bin");
  payloads = join(scratch, "payloads");
  locatorPath = join(scratch, "locator", "bootstrap.json");
  mkdirSync(payloads, { recursive: true });
});

afterEach(() => {
  removeDir(scratch);
});

function payload(version: string, options?: Parameters<typeof writeFakePayload>[2]): string {
  return writeFakePayload(join(payloads, version), version, options);
}

/**
 * The environment the launcher will actually run in. Launcher verification is
 * environment-dependent by design — the launcher resolves the home at run time
 * — so the tests state the environment rather than letting the developer's real
 * machine decide the answer.
 */
function launcherEnv(): NodeJS.ProcessEnv {
  return { ...process.env, STAPLE_HOME: home };
}

function install(version: string, options: Parameters<typeof writeFakePayload>[2] = {}) {
  return installRuntime({
    home,
    binDir,
    from: payload(version, options),
    locatorPath,
    env: launcherEnv(),
  });
}

function status() {
  return installStatus({ home, binDir, locatorPath, env: launcherEnv() });
}

/**
 * Run the installed launcher the way a shell would, with an environment that
 * resolves to the temporary home. STAPLE_HOME is the launcher's first
 * resolution step, so this exercises the real script, not a stub.
 */
function runLauncher(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(join(binDir, "staple"), args, {
    encoding: "utf8",
    env: { ...process.env, STAPLE_HOME: home, ...env },
  });
}

/** Every file under `root`, relative and sorted. */
function tree(root: string): string[] {
  if (!existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(relative(root, abs).split(sep).join("/"));
    }
  };
  walk(root);
  return out.sort();
}

describe("install v1", () => {
  it("lays out runtime/versions/<version>/ exactly as plan §2 specifies", () => {
    const result = install("1.0.0");

    expect(result.version).toBe("1.0.0");
    expect(result.versionPath).toBe(join(home, "runtime", "versions", "1.0.0"));
    expect(existsSync(join(result.versionPath, "staple.mjs"))).toBe(true);
    expect(existsSync(join(result.versionPath, "assets", "index.html"))).toBe(true);
    expect(existsSync(join(result.versionPath, "manifest.json"))).toBe(true);
    expect(existsSync(join(home, "runtime", "current.json"))).toBe(true);
  });

  it("records schema version, active version, RELATIVE entrypoint, manifest hash and previous", () => {
    const result = install("1.0.0");
    const current = readCurrent(home);

    expect(current).toEqual({
      schemaVersion: 1,
      version: "1.0.0",
      entrypoint: "versions/1.0.0/staple.mjs",
      manifestHash: result.manifestHash,
      previousVersion: null,
      installedAt: expect.any(String),
    });
    // Relative, so a home move relocates the tree without rewriting the pointer.
    expect(current!.entrypoint.startsWith("/")).toBe(false);
  });

  it("writes a launcher that EXECS the installed runtime", () => {
    install("1.0.0");

    const run = runLauncher(["--version"]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe("1.0.0");
  });

  it("passes arguments through to the runtime unchanged", () => {
    install("1.0.0");

    const run = runLauncher(["ls", "--status", "todo", "--json"]);
    expect(run.status).toBe(0);
    const parsed = JSON.parse(run.stdout);
    expect(parsed.args).toEqual(["ls", "--status", "todo", "--json"]);
    expect(parsed.entry).toBe(join(home, "runtime", "versions", "1.0.0", "staple.mjs"));
  });

  it("propagates the runtime's exit code instead of swallowing it", () => {
    install("1.0.0");
    expect(runLauncher(["boom"]).status).toBe(9);
  });

  it("resolves the home through the bootstrap locator when STAPLE_HOME is unset", () => {
    install("1.0.0");
    writeBootstrapLocator(locatorPath, home);

    // The launcher derives the locator path from HOME, so point HOME at the
    // scratch tree and lay the locator where macOS/Linux expect it.
    const fakeHome = join(scratch, "userhome");
    const macLocator = join(fakeHome, "Library", "Application Support", "Staple", "bootstrap.json");
    const linuxLocator = join(fakeHome, ".config", "staple", "bootstrap.json");
    writeBootstrapLocator(macLocator, home);
    writeBootstrapLocator(linuxLocator, home);

    const run = spawnSync(join(binDir, "staple"), ["--version"], {
      encoding: "utf8",
      env: { ...process.env, HOME: fakeHome, STAPLE_HOME: "", XDG_CONFIG_HOME: "" },
    });
    expect(run.stderr).toBe("");
    expect(run.stdout.trim()).toBe("1.0.0");
  });

  it("reports an actionable error when nothing is installed for the home", () => {
    install("1.0.0");
    const empty = join(scratch, "empty-home");
    mkdirSync(empty, { recursive: true });

    const run = runLauncher(["--version"], { STAPLE_HOME: empty });
    expect(run.status).toBe(70);
    expect(run.stderr).toContain("no runtime is installed");
    expect(run.stderr).toContain("staple install --yes");
  });
});

describe("a corrupt payload is refused and current.json is untouched", () => {
  /** The pointer bytes before and after must be identical, byte for byte. */
  function pointerBytes(): string {
    return readFileSync(join(home, "runtime", "current.json"), "utf8");
  }

  it("refuses a payload with no assets/index.html (A2's silent-UI hazard)", () => {
    install("1.0.0");
    const before = pointerBytes();

    expect(() => install("2.0.0", { withoutAssets: true })).toThrow(/assets\/index\.html/);

    expect(pointerBytes()).toBe(before);
    expect(readCurrent(home)!.version).toBe("1.0.0");
    expect(runLauncher(["--version"]).stdout.trim()).toBe("1.0.0");
  });

  it("refuses a payload whose entrypoint lost its exec bit", () => {
    install("1.0.0");
    const before = pointerBytes();

    expect(() => install("2.0.0", { notExecutable: true })).toThrow(/executable/);

    expect(pointerBytes()).toBe(before);
    expect(listInstalledVersions(home)).toEqual(["1.0.0"]);
  });

  it("refuses a payload with two shebangs (A2's SyntaxError-at-first-run bug)", () => {
    install("1.0.0");
    const before = pointerBytes();

    expect(() => install("2.0.0", { doubleShebang: true })).toThrow(/second shebang/);

    expect(pointerBytes()).toBe(before);
  });

  it("refuses a payload with no package.json to name its version", () => {
    install("1.0.0");
    const before = pointerBytes();

    expect(() => install("2.0.0", { withoutPackageJson: true })).toThrow(/package\.json/);

    expect(pointerBytes()).toBe(before);
  });

  it("refuses a payload whose manifest version disagrees with its package.json", () => {
    const dir = payload("2.0.0");
    // Stage it, then rewrite the manifest to claim a different version — the
    // "version matches its manifest" acceptance criterion.
    const staged = stagePayload({ home, from: dir });
    const manifest = JSON.parse(readFileSync(join(staged.path, "manifest.json"), "utf8"));
    manifest.version = "9.9.9";
    writeFileSync(join(staged.path, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

    const verified = verifyRuntimeTree(staged.path, { expectVersion: "2.0.0" });
    expect(verified.ok).toBe(false);
    expect(verified.problems.join("\n")).toMatch(/manifest says version "9\.9\.9"/);
  });

  it("refuses a version directory whose bytes were edited after install", () => {
    const result = install("1.0.0");
    writeFileSync(join(result.versionPath, "assets", "index.html"), "<!doctype html>tampered\n");

    const verified = verifyRuntimeTree(result.versionPath, { expectVersion: "1.0.0" });
    expect(verified.ok).toBe(false);
    expect(verified.problems.join("\n")).toMatch(/assets\/index\.html: (size|sha256)/);
    expect(status().ok).toBe(false);
  });

  it("leaves no staging directory behind after a refusal", () => {
    install("1.0.0");
    expect(() => install("2.0.0", { withoutAssets: true })).toThrow();

    const staging = join(home, "runtime", "staging");
    expect(existsSync(staging) ? readdirSync(staging) : []).toEqual([]);
  });
});

describe("install v2 switches, rollback returns to v1", () => {
  it("switches the active version and records the previous one", () => {
    install("1.0.0");
    const second = install("2.0.0");

    expect(second.version).toBe("2.0.0");
    expect(second.previousVersion).toBe("1.0.0");
    expect(readCurrent(home)!.version).toBe("2.0.0");
    // Both trees survive — the old one is the rollback target, not garbage.
    expect(listInstalledVersions(home)).toEqual(["1.0.0", "2.0.0"]);
  });

  it("the launcher immediately execs v2 with no launcher rewrite needed", () => {
    install("1.0.0");
    const launcherBefore = readFileSync(join(binDir, "staple"), "utf8");
    install("2.0.0");

    expect(runLauncher(["--version"]).stdout.trim()).toBe("2.0.0");
    // The launcher is version-agnostic: same bytes, different runtime.
    expect(readFileSync(join(binDir, "staple"), "utf8")).toBe(launcherBefore);
  });

  it("rollback returns to v1 after verifying its manifest", () => {
    install("1.0.0");
    install("2.0.0");

    const result = rollbackRuntime({ home, binDir, locatorPath });

    expect(result.from).toBe("2.0.0");
    expect(result.to).toBe("1.0.0");
    expect(readCurrent(home)!.version).toBe("1.0.0");
    expect(runLauncher(["--version"]).stdout.trim()).toBe("1.0.0");
  });

  it("rollback is reversible — rolling back again returns to v2", () => {
    install("1.0.0");
    install("2.0.0");
    rollbackRuntime({ home, binDir, locatorPath });

    expect(rollbackRuntime({ home, binDir, locatorPath }).to).toBe("2.0.0");
    expect(runLauncher(["--version"]).stdout.trim()).toBe("2.0.0");
  });

  it("REFUSES to roll back to a corrupted previous version and stays put", () => {
    const first = install("1.0.0");
    install("2.0.0");
    // The rollback target rots on disk between install and rollback.
    writeFileSync(join(first.versionPath, "staple.mjs"), "#!/usr/bin/env node\nprocess.exit(0)\n");

    expect(() => rollbackRuntime({ home, binDir, locatorPath })).toThrow(/Refusing to roll back/);
    expect(readCurrent(home)!.version).toBe("2.0.0");
    expect(runLauncher(["--version"]).stdout.trim()).toBe("2.0.0");
  });

  it("refuses to roll back when there is no previous version", () => {
    install("1.0.0");
    expect(() => rollbackRuntime({ home, binDir, locatorPath })).toThrow(/no previous version/);
  });

  it("refuses to roll back when the recorded previous version is gone from disk", () => {
    const first = install("1.0.0");
    install("2.0.0");
    rmSync(first.versionPath, { recursive: true, force: true });

    expect(() => rollbackRuntime({ home, binDir, locatorPath })).toThrow(/is not on disk/);
    expect(readCurrent(home)!.version).toBe("2.0.0");
  });

  it("reinstalling the SAME version keeps the older rollback target", () => {
    install("1.0.0");
    install("2.0.0");
    const again = install("2.0.0");

    // Not "2.0.0": that would make --rollback a no-op and destroy the only
    // escape route from a bad upgrade.
    expect(again.reinstalled).toBe(true);
    expect(again.previousVersion).toBe("1.0.0");
    expect(rollbackRuntime({ home, binDir, locatorPath }).to).toBe("1.0.0");
  });
});

describe("no step requires elevated permissions", () => {
  it("writes only inside the home and the launcher directory", () => {
    const before = { home: tree(home), bin: tree(binDir) };
    expect(before.home).toEqual([]);
    expect(before.bin).toEqual([]);

    const first = install("1.0.0");
    const second = install("2.0.0");
    rollbackRuntime({ home, binDir, locatorPath });

    for (const written of [...first.wrote, ...second.wrote]) {
      const inHome = resolve(written).startsWith(`${resolve(home)}${sep}`);
      const inBin = resolve(written).startsWith(`${resolve(binDir)}${sep}`);
      expect(inHome || inBin, `${written} is outside the home and the bin dir`).toBe(true);
    }

    // And nothing appeared anywhere else under the scratch root.
    const strays = tree(scratch).filter(
      (p) => !p.startsWith("home/") && !p.startsWith("bin/") && !p.startsWith("payloads/"),
    );
    expect(strays).toEqual([]);
  });

  it("creates the home and bin directories itself, with owner-only home bits", () => {
    install("1.0.0");

    expect(existsSync(home)).toBe(true);
    expect(existsSync(binDir)).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(join(home, "runtime")).mode & 0o077).toBe(0);
    }
  });

  it("does not run as root and never shells out to a privilege escalator", () => {
    install("1.0.0");
    // The launcher is what a user runs every day; it must not contain one either.
    const launcher = readFileSync(join(binDir, "staple"), "utf8");
    expect(launcher).not.toMatch(/\bsudo\b|\bdoas\b|\bpkexec\b|osascript/);
    expect(typeof process.getuid === "function" ? process.getuid() : 1).not.toBe(0);
  });

  it("refuses to clobber a launcher path staple did not write", () => {
    mkdirSync(binDir, { recursive: true });
    const foreign = join(binDir, "staple");
    writeFileSync(foreign, "#!/bin/sh\necho someone elses script\n");
    chmodSync(foreign, 0o755);

    expect(() => install("1.0.0")).toThrow(/was not written by staple/);
    expect(readFileSync(foreign, "utf8")).toContain("someone elses script");
  });
});

describe("status", () => {
  it("reports nothing installed for a fresh home", () => {
    const fresh = status();
    expect(fresh.installed).toBe(false);
    expect(fresh.ok).toBe(false);
    expect(fresh.versions).toEqual([]);
  });

  it("reports the active version, the rollback target and a healthy launcher", () => {
    install("1.0.0");
    install("2.0.0");

    const healthy = status();
    expect(healthy.installed).toBe(true);
    expect(healthy.version).toBe("2.0.0");
    expect(healthy.previousVersion).toBe("1.0.0");
    expect(healthy.versions).toEqual(["1.0.0", "2.0.0"]);
    expect(healthy.verification?.ok).toBe(true);
    expect(healthy.launcher.ok).toBe(true);
    expect(healthy.launcher.target).toBe(join(home, "runtime", "versions", "2.0.0", "staple.mjs"));
    expect(healthy.ok).toBe(true);
  });

  it("goes not-ok when the launcher is deleted from under it", () => {
    install("1.0.0");
    rmSync(join(binDir, "staple"));

    const broken = status();
    expect(broken.launcher.ok).toBe(false);
    expect(broken.ok).toBe(false);
    expect(broken.launcher.problems.join("\n")).toMatch(/no launcher installed/);
  });
});

describe("the selected runtime says which workspace schema it understands (STA-163)", () => {
  it("reports the payload's declared workspace schema through install, status and the launcher", () => {
    const result = install("1.0.0");

    expect(result.workspaceSchema).toBe(WORKSPACE_LATEST_VERSION);
    expect(status().workspaceSchema).toBe(WORKSPACE_LATEST_VERSION);
    // The launcher's verification answers for the entrypoint it would exec —
    // the same bytes `staple` on PATH runs — not for the build running the check.
    const launcher = verifyLauncherTarget({ binDir, expectHome: home, locatorPath, env: launcherEnv() });
    expect(launcher.target).toBe(join(home, "runtime", "versions", "1.0.0", "staple.mjs"));
    expect(launcher.workspaceSchema).toBe(WORKSPACE_LATEST_VERSION);
  });

  it("follows the pointer: after an upgrade the launcher reports the NEW runtime's schema", () => {
    install("1.0.0", { workspaceSchema: 5 });
    expect(status().workspaceSchema).toBe(5);

    install("2.0.0", { workspaceSchema: 6 });

    expect(status().workspaceSchema).toBe(6);
    expect(verifyLauncherTarget({ binDir, expectHome: home, locatorPath, env: launcherEnv() }).workspaceSchema).toBe(6);
    expect(payloadWorkspaceSchema(join(home, "runtime", "versions", "1.0.0"))).toBe(5);
  });

  it("installs a payload built before the schema was recorded, and says it does not know", () => {
    const result = install("0.9.0", { workspaceSchema: null });

    expect(result.workspaceSchema).toBeNull();
    expect(status().workspaceSchema).toBeNull();
    expect(runLauncher(["--version"]).stdout.trim()).toBe("0.9.0");
  });
});

describe("the prior runtime is retained at an explicit path (STA-163)", () => {
  it("names where the rollback target lives, and it is still there", () => {
    const first = install("1.0.0");
    expect(first.previousVersionPath).toBeNull();

    const second = install("2.0.0");

    expect(second.previousVersion).toBe("1.0.0");
    expect(second.previousVersionPath).toBe(first.versionPath);
    expect(existsSync(join(second.previousVersionPath!, "staple.mjs"))).toBe(true);
    expect(status().previousVersionPath).toBe(first.versionPath);
  });

  it("rollback names where the runtime it left is retained, so it is reversible", () => {
    install("1.0.0");
    const second = install("2.0.0");

    const rolled = rollbackRuntime({ home, binDir, locatorPath });

    expect(rolled.previousVersion).toBe("2.0.0");
    expect(rolled.previousVersionPath).toBe(second.versionPath);
    expect(existsSync(join(rolled.previousVersionPath!, "staple.mjs"))).toBe(true);
    expect(rolled.workspaceSchema).toBe(WORKSPACE_LATEST_VERSION);
  });
});

describe("current.json is validated, not trusted", () => {
  it("rejects an absolute entrypoint — it would survive a home move pointing at the old home", () => {
    install("1.0.0");
    writeFileSync(
      join(home, "runtime", "current.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        version: "1.0.0",
        entrypoint: join(home, "runtime", "versions", "1.0.0", "staple.mjs"),
        manifestHash: "x",
        previousVersion: null,
        installedAt: "",
      })}\n`,
    );

    expect(() => readCurrent(home)).toThrow(StapleError);
    expect(() => readCurrent(home)).toThrow(/must be relative/);
  });

  it("rejects a schemaVersion written by a newer staple", () => {
    install("1.0.0");
    const current = JSON.parse(readFileSync(join(home, "runtime", "current.json"), "utf8"));
    writeFileSync(
      join(home, "runtime", "current.json"),
      `${JSON.stringify({ ...current, schemaVersion: 2 })}\n`,
    );

    expect(() => readCurrent(home)).toThrow(/unsupported "schemaVersion" 2/);
  });

  it("treats an absent pointer as 'nothing installed', not as an error", () => {
    expect(readCurrent(home)).toBeNull();
  });
});
