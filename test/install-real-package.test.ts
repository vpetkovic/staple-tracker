/**
 * A8 (STA-38) — installing the REAL artifact, not a fixture.
 *
 * STA-24 plan §9 is explicit about the dependency: "Installer A8 must depend on
 * A2's packed-tarball acceptance, not merely a source-tree build." A fake
 * payload proves the lifecycle logic; only the real one proves the installer
 * and the builder agree about what a payload IS — the flat layout, the exec
 * bit, the single shebang, the assets beside the bundle.
 *
 * Both A2 sources are exercised: the `dist-package/` directory a developer
 * builds, and the `.tgz` a user installs from. They must produce the same
 * installed tree, because plan §6 promises `npx -y staple-cli install` and a
 * local build are the same operation.
 *
 * The suite SKIPS rather than fails when `dist-package/` is absent: it is a
 * build output, not a source file, and a checkout that has not run
 * `npm run build:package` should not report a red test it cannot fix by
 * changing code. The tarball case additionally builds its own `.tgz` via
 * `npm pack`, which is skipped under the same condition.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installRuntime,
  installStatus,
  listInstalledVersions,
  readCurrent,
  rollbackRuntime,
  verifyRuntimeTree,
} from "../src/install/index.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distPackage = join(repoRoot, "dist-package");
const built = existsSync(join(distPackage, "staple.mjs")) && existsSync(join(distPackage, "assets", "index.html"));
const packageVersion = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")).version as string;

let scratch: string;
let home: string;
let binDir: string;

beforeEach(() => {
  scratch = tempDir("install-real");
  home = join(scratch, "home");
  binDir = join(scratch, "bin");
});

afterEach(() => {
  removeDir(scratch);
});

function install(from: string) {
  return installRuntime({ home, binDir, from, env: { ...process.env, STAPLE_HOME: home } });
}

function runLauncher(args: string[]) {
  return spawnSync(join(binDir, "staple"), args, {
    encoding: "utf8",
    env: { ...process.env, STAPLE_HOME: home },
  });
}

describe.skipIf(!built)("installing the built dist-package/", () => {
  it("installs at the version A2 stamped into the artifact", () => {
    const result = install(distPackage);

    expect(result.version).toBe(packageVersion);
    expect(result.versionPath).toBe(join(home, "runtime", "versions", packageVersion));
    expect(readCurrent(home)!.entrypoint).toBe(`versions/${packageVersion}/staple.mjs`);
  });

  it("copies the payload VERBATIM — flat, staple.mjs beside assets/ (A2's contract)", () => {
    const result = install(distPackage);

    const installed = readdirSync(result.versionPath).sort();
    const source = readdirSync(distPackage)
      .filter((name) => !name.endsWith(".tgz"))
      .sort();
    // manifest.json is the one thing the installer adds.
    expect(installed).toEqual([...source, "manifest.json"].sort());
    expect(existsSync(join(result.versionPath, "assets", "index.html"))).toBe(true);
  });

  it("keeps the 0755 exec bit and the single shebang across the copy", () => {
    const result = install(distPackage);
    const entry = join(result.versionPath, "staple.mjs");

    expect(statSync(entry).mode & 0o100).not.toBe(0);
    const text = readFileSync(entry, "utf8");
    expect(text.startsWith("#!/usr/bin/env node\n")).toBe(true);
    expect(text.slice(20).includes("\n#!")).toBe(false);
  });

  it("the launcher runs the REAL staple and it reports its own version", () => {
    install(distPackage);

    const run = runLauncher(["--version"]);
    expect(run.status).toBe(0);
    expect(run.stdout.trim()).toBe(packageVersion);
  });

  it("the installed runtime serves real CLI help, with no node_modules present", () => {
    const result = install(distPackage);
    // A2 ships zero dependencies; nothing may be resolved from a sibling tree.
    expect(existsSync(join(result.versionPath, "node_modules"))).toBe(false);

    const run = runLauncher(["help"]);
    expect(run.status).toBe(0);
    expect(run.stdout).toContain("local-first task tracker for coding agents");
  });

  it("the installed runtime finds its packaged UI assets from the version directory", () => {
    // A2's warning: assets must stay at assets/ beside staple.mjs or the UI
    // silently degrades to a placeholder. Proving the file landed where
    // resolveUiDistDir() probes is the check that catches a layout regression.
    const result = install(distPackage);
    const html = readFileSync(join(result.versionPath, "assets", "index.html"), "utf8");
    expect(html).not.toContain("npm run build:ui");
    expect(html.length).toBeGreaterThan(200);
  });

  it("verifies clean immediately after install, by its own manifest", () => {
    const result = install(distPackage);

    const verified = verifyRuntimeTree(result.versionPath, { expectVersion: packageVersion });
    expect(verified.problems).toEqual([]);
    expect(verified.ok).toBe(true);
    // The real payload is more than a couple of files; a manifest that listed
    // only one would pass every check above and describe nothing.
    expect(verified.files).toBeGreaterThan(3);

    const status = installStatus({ home, binDir, env: { ...process.env, STAPLE_HOME: home } });
    expect(status.ok).toBe(true);
  });
});

describe.skipIf(!built)("installing the packed tarball (plan §9 acceptance)", () => {
  let tarball: string;

  beforeAll(() => {
    const packDir = tempDir("install-pack");
    const packed = spawnSync("npm", ["pack", distPackage, "--pack-destination", packDir], {
      encoding: "utf8",
      cwd: repoRoot,
    });
    if (packed.status !== 0) throw new Error(`npm pack failed: ${packed.stderr}`);
    const name = readdirSync(packDir).find((entry) => entry.endsWith(".tgz"));
    if (!name) throw new Error(`npm pack produced no tarball in ${packDir}`);
    tarball = join(packDir, name);
  }, 120_000);

  afterAll(() => {
    if (tarball) removeDir(dirname(tarball));
  });

  it("unpacks the npm `package/` wrapper into the same flat version directory", () => {
    const result = install(tarball);

    expect(result.source.kind).toBe("tarball");
    expect(result.version).toBe(packageVersion);
    expect(existsSync(join(result.versionPath, "staple.mjs"))).toBe(true);
    expect(existsSync(join(result.versionPath, "assets", "index.html"))).toBe(true);
    // The wrapper directory must not survive into the installed tree.
    expect(existsSync(join(result.versionPath, "package"))).toBe(false);
  });

  it("preserves the exec bit through pack and unpack", () => {
    const result = install(tarball);
    expect(statSync(join(result.versionPath, "staple.mjs")).mode & 0o100).not.toBe(0);
  });

  it("the tarball-installed launcher runs staple outside the source tree", () => {
    install(tarball);

    const version = runLauncher(["--version"]);
    expect(version.status).toBe(0);
    expect(version.stdout.trim()).toBe(packageVersion);

    const help = runLauncher(["help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Exit codes:");
  });

  it("produces the same installed bytes as the directory install", () => {
    const fromTarball = install(tarball);
    const tarballEntry = readFileSync(join(fromTarball.versionPath, "staple.mjs"));

    removeDir(home);
    const fromDirectory = install(distPackage);
    const directoryEntry = readFileSync(join(fromDirectory.versionPath, "staple.mjs"));

    expect(tarballEntry.equals(directoryEntry)).toBe(true);
  });

  it("rejects a path that is neither a payload directory nor a .tgz", () => {
    const notAPayload = join(scratch, "random");
    mkdirSync(notAPayload, { recursive: true });
    expect(() => install(notAPayload)).toThrow(/not a staple payload/);
    expect(() => install(join(repoRoot, "package.json"))).toThrow(/neither a directory nor a \.tgz/);
  });
});

describe.skipIf(!built)("upgrade and rollback with the real artifact", () => {
  it("reinstalling the same real version is idempotent and keeps the launcher working", () => {
    const first = install(distPackage);
    const second = install(distPackage);

    expect(second.reinstalled).toBe(true);
    expect(second.version).toBe(first.version);
    expect(listInstalledVersions(home)).toEqual([packageVersion]);
    expect(runLauncher(["--version"]).stdout.trim()).toBe(packageVersion);
    // No earlier version exists, so there is honestly nothing to roll back to.
    expect(() => rollbackRuntime({ home, binDir })).toThrow(/no previous version/);
  });
});
