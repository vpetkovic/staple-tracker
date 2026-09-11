/**
 * A8 (STA-38) — installing the REAL artifact, not a fixture.
 *
 * STA-24 plan §9 is explicit about the dependency: "Installer A8 must depend on
 * A2's packed-tarball acceptance, not merely a source-tree build." A fake
 * payload proves the lifecycle logic; only the real one proves the installer
 * and the builder agree about what a payload IS — the flat layout, the exec
 * bit, the single shebang, the assets beside the bundle.
 *
 * Both A2 sources are exercised: the payload directory `scripts/build-package.ts`
 * produces, and the `.tgz` a user installs from. They must produce the same
 * installed tree, because plan §6 promises `npx -y staple-cli install` and a
 * local build are the same operation.
 *
 * The payload is the one this run's globalSetup built from the current source
 * (`testPackageDir()`, STA-250), so this suite always runs. It used to read the
 * repository's `dist-package/` and skip when that was absent, which a parallel
 * rebuild made happen at random: a run that exited 0 having tested nothing.
 * The tarball case packs its own `.tgz` from the same payload via `npm pack`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  installRuntime,
  installStatus,
  listInstalledVersions,
  payloadWorkspaceSchema,
  readCurrent,
  rollbackRuntime,
  verifyRuntimeTree,
} from "../src/install/index.js";
import { WORKSPACE_LATEST_VERSION } from "../src/core/migrations/workspace/index.js";
import { removeDir, tempDir } from "./fixtures/characterize-support.js";
import { testPackageDir } from "./fixtures/package-payload.js";
import { writeCurrentWorkspace } from "./fixtures/schema/generate.js";
import { FIXTURES, fixturePath } from "./fixtures/schema/support.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const distPackage = testPackageDir();
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

describe("installing the built payload directory", () => {
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

  it("the installed launcher selects a runtime that understands the current workspace schema (STA-163)", () => {
    const result = install(distPackage);

    // Declared by the artifact, from the migration list compiled into it…
    expect(payloadWorkspaceSchema(distPackage)).toBe(WORKSPACE_LATEST_VERSION);
    expect(result.workspaceSchema).toBe(WORKSPACE_LATEST_VERSION);
    expect(WORKSPACE_LATEST_VERSION).toBeGreaterThanOrEqual(6);
    // …reported for what the launcher would exec…
    const status = installStatus({ home, binDir, env: { ...process.env, STAPLE_HOME: home } });
    expect(status.workspaceSchema).toBe(WORKSPACE_LATEST_VERSION);
    expect(status.launcher.workspaceSchema).toBe(WORKSPACE_LATEST_VERSION);

    // …and true in practice: through the launcher, the real runtime opens a
    // current-schema workspace with nothing pending and no snapshot taken.
    const repo = join(scratch, "repo-current");
    mkdirSync(join(repo, ".staple"), { recursive: true });
    writeCurrentWorkspace(join(repo, ".staple", "staple.db"));
    const run = spawnSync(join(binDir, "staple"), ["ls", "--all", "--json"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, STAPLE_HOME: home, NODE_NO_WARNINGS: "1" },
    });
    expect(run.stderr).toBe("");
    expect(run.status).toBe(0);
    expect((JSON.parse(run.stdout) as Array<{ identifier: string }>).map((i) => i.identifier).sort()).toEqual([
      "LEG-1",
      "LEG-2",
    ]);
    expect(existsSync(join(repo, ".staple", "snapshots"))).toBe(false);
  });

  it("the installed runtime refuses a workspace newer than it, before any write", () => {
    install(distPackage);
    const repo = join(scratch, "repo-v99");
    mkdirSync(join(repo, ".staple"), { recursive: true });
    const db = join(repo, ".staple", "staple.db");
    copyFileSync(fixturePath(FIXTURES.workspaceV99), db);
    const before = readFileSync(db);

    const run = spawnSync(join(binDir, "staple"), ["ls"], {
      cwd: repo,
      encoding: "utf8",
      env: { ...process.env, STAPLE_HOME: home, NODE_NO_WARNINGS: "1" },
    });

    expect(run.status).toBe(4);
    expect(run.stderr).toContain("error(conflict)");
    expect(run.stderr).toContain("schema version 99");
    expect(run.stderr).toContain(`this build understands ${WORKSPACE_LATEST_VERSION}`);
    expect(readFileSync(db).equals(before)).toBe(true);
    expect(existsSync(`${db}-wal`)).toBe(false);
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

describe("installing the packed tarball (plan §9 acceptance)", () => {
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

describe("upgrade and rollback with the real artifact", () => {
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

describe("the installed launcher passes signals on to the runtime it started", () => {
  /**
   * The launcher is a Node process that starts the runtime as its child. A
   * terminal's Ctrl-C and launchd both signal the whole process group, so the
   * runtime hears those directly. `kill <pid>` from another terminal signals the
   * launcher alone. When the launcher did not forward it, the launcher died and
   * the runtime carried on as an orphan, still holding its port.
   *
   * Once the runtime has exited, the launcher dies BY the signal it received
   * rather than exiting 128 + n. A shell can tell the two apart and acts on it:
   * see the bash loop case at the end.
   */
  const LISTENING = /staple ui — .* at http:\/\/localhost:(\d+)\//;

  /** Every runtime this home's launcher could have started, for cleanup. */
  function runtimesOf(stapleHome: string): number[] {
    const listed = spawnSync("pgrep", ["-f", join(stapleHome, "runtime")], { encoding: "utf8" });
    return listed.stdout.split("\n").filter(Boolean).map(Number);
  }

  function childrenOf(pid: number): number[] {
    const listed = spawnSync("pgrep", ["-P", String(pid)], { encoding: "utf8" });
    return listed.stdout.split("\n").filter(Boolean).map(Number);
  }

  function running(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  async function portIsFree(port: number): Promise<boolean> {
    const probe = createNetServer();
    return new Promise((resolveFree) => {
      probe.once("error", () => resolveFree(false));
      probe.listen(port, "127.0.0.1", () => probe.close(() => resolveFree(true)));
    });
  }

  it.each([
    ["SIGTERM", "the launcher's pid alone"],
    ["SIGINT", "the launcher's pid alone"],
    ["SIGHUP", "the launcher's pid alone"],
    // A terminal's Ctrl-C: both processes hear it, and the runtime then gets
    // the forwarded copy as well. It must still be one clean shutdown.
    ["SIGINT", "the whole process group"],
  ] as const)(
    "%s sent to %s stops the runtime, frees its port, and the launcher dies by it",
    async (signal, target) => {
      install(distPackage);
      const repo = join(scratch, "repo-signal");
      mkdirSync(repo, { recursive: true });
      const env = { ...process.env, STAPLE_HOME: home, NODE_NO_WARNINGS: "1" };
      expect(spawnSync(join(binDir, "staple"), ["init"], { cwd: repo, env, encoding: "utf8" }).status).toBe(0);

      const group = target === "the whole process group";
      const launcher = spawn(join(binDir, "staple"), ["open", "--port", "0", "--no-browser"], {
        cwd: repo,
        env,
        detached: group,
      });
      let stdout = "";
      let stderr = "";
      launcher.stdout.on("data", (chunk) => (stdout += String(chunk)));
      launcher.stderr.on("data", (chunk) => (stderr += String(chunk)));
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) =>
        launcher.on("exit", (code, exitSignal) => resolveExit({ code, signal: exitSignal })),
      );
      let runtimePids: number[] = [];
      try {
        const deadline = Date.now() + 25_000;
        while (!LISTENING.test(stdout) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
        const port = Number(LISTENING.exec(stdout)?.[1]);
        expect(port).toBeGreaterThan(0);
        runtimePids = childrenOf(launcher.pid!);
        expect(runtimePids).toHaveLength(1);

        if (group) process.kill(-launcher.pid!, signal);
        else launcher.kill(signal); // the launcher's pid only

        // Bounded here, inside the test's own timeout, so the cleanup below
        // always runs even if the launcher never exits.
        const outcome = await Promise.race([
          exited,
          new Promise<"still running">((r) => setTimeout(() => r("still running"), 15_000)),
        ]);
        expect(outcome).toEqual({ code: null, signal });
        const gone = Date.now() + 10_000;
        while (running(runtimePids[0]!) && Date.now() < gone) await new Promise((r) => setTimeout(r, 25));
        expect(running(runtimePids[0]!)).toBe(false);
        expect(await portIsFree(port)).toBe(true);
        // SIGHUP has no handler in `staple open` and ends it by default; the
        // other two go through its shutdown exactly once.
        if (signal !== "SIGHUP") expect(stderr.match(/shutting down/g)).toHaveLength(1);
      } finally {
        // Never leak an orphan into the rest of the suite, whatever failed above.
        for (const pid of runtimePids) if (running(pid)) process.kill(pid, "SIGKILL");
        if (launcher.exitCode === null && launcher.signalCode === null) launcher.kill("SIGKILL");
      }
    },
    60_000,
  );

  /**
   * The case that decides between "exit 130" and "die by SIGINT". bash runs the
   * installed launcher in a loop and gets one Ctrl-C. bash waits for its child,
   * and if the child exited normally it concludes the child handled the Ctrl-C
   * and runs the next command. The runtime run directly stops the loop, and so
   * did the launcher before it forwarded signals, so the launcher must too.
   *
   * A terminal's Ctrl-C is the tty driver sending SIGINT to the foreground
   * process group: bash, the launcher and the runtime at once. That is what
   * this sends, to a bash that leads its own group. (`script` would give a real
   * pty, but BSD `script` on macOS refuses a stdin that is not itself a tty,
   * which a spawned child's never is.)
   */
  it("one Ctrl-C to the foreground group stops a bash loop that runs the launcher", async () => {
    install(distPackage);
    const repo = join(scratch, "repo-loop");
    mkdirSync(repo, { recursive: true });
    const env = { ...process.env, STAPLE_HOME: home, NODE_NO_WARNINGS: "1" };
    expect(spawnSync(join(binDir, "staple"), ["init"], { cwd: repo, env, encoding: "utf8" }).status).toBe(0);

    const loop = `for i in 1 2 3; do "${join(binDir, "staple")}" open --port 0 --no-browser; echo "after $i rc=$?"; done; echo END`;
    const term = spawn("bash", ["-c", loop], { cwd: repo, env, detached: true });
    let output = "";
    term.stdout.on("data", (chunk) => (output += String(chunk)));
    term.stderr.on("data", (chunk) => (output += String(chunk)));
    const exited = new Promise<void>((resolveExit) => term.on("exit", () => resolveExit()));
    try {
      const deadline = Date.now() + 25_000;
      while (!LISTENING.test(output) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 25));
      expect(output, "the first pass never started listening").toMatch(LISTENING);

      process.kill(-term.pid!, "SIGINT"); // Ctrl-C: the whole foreground group

      // Give a wrongly continuing loop time to print and start its next pass.
      await Promise.race([exited, new Promise((r) => setTimeout(r, 5_000))]);
      expect(output).toContain("shutting down (SIGINT)");
      expect(output).not.toContain("after 1");
      expect(output).not.toContain("END");
    } finally {
      try {
        process.kill(-term.pid!, "SIGKILL");
      } catch {
        // already gone
      }
      for (const pid of runtimesOf(home)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          // already gone
        }
      }
    }
  }, 60_000);
});
