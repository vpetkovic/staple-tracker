/**
 * A1 characterization harness (test-only; nothing here is imported by src/).
 *
 * `fixtures/contract-support.ts` pins the machine-facing PAYLOAD contracts —
 * error envelopes, MCP tool results, HTTP bodies — and always runs the CLI from
 * the repository root. A1 pins a different layer: the PRODUCT contracts that the
 * onboarding-and-distribution epic (STA-24) is about to rewrite — where staple
 * looks for a workspace, what it writes to disk, what it prints when it starts,
 * and which command and flag tokens exist at all.
 *
 * That layer needs three things the existing harness deliberately does not give:
 *
 *  1. an arbitrary cwd, because walk-up resolution IS the behaviour under test;
 *  2. a real temporary HOME per suite, because init and the hub write there;
 *  3. an on-disk snapshot, because A5's path migration needs a proven "before".
 *
 * Everything here pins CURRENT behaviour verbatim. Where that behaviour is
 * strange it is pinned as-is under a `QUIRK` comment naming the ticket that
 * should decide about it. A1 changes no src/** behaviour; a fix that lands in
 * A2..A9 is expected to update these goldens deliberately, which is the entire
 * point of writing them down.
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import {
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TSX_CLI = join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
export const CLI_ENTRY = join(REPO_ROOT, "src/cli.ts");
export const MCP_ENTRY = join(REPO_ROOT, "src/mcp.ts");

/**
 * Every inherited variable that can move the bootstrap locator off `$HOME`.
 *
 * `bootstrapLocatorPath()` derives the locator from the home on macOS, but from
 * `$XDG_CONFIG_HOME` on Linux and `%APPDATA%` on Windows when those are set. A
 * suite that hands a child its own `HOME` and assumes the locator followed is
 * therefore correct on macOS and wrong everywhere else: GitHub's ubuntu runner
 * exports `XDG_CONFIG_HOME=/home/runner/.config`, so every child in a suite
 * shared ONE locator there and the tests contaminated each other in file order.
 * Strip them, so on every platform the locator is a function of `HOME` alone —
 * which is what the suites that set `HOME` already believe. A case that wants
 * one of these set can still pass it in `extra`.
 */
const LOCATOR_ENV_KEYS = ["XDG_CONFIG_HOME", "APPDATA"];

/**
 * A child environment with EVERY staple variable stripped, not just the three
 * contract-support.ts drops. A suite about environment precedence must start
 * from a known-empty environment or the developer's own STAPLE_HOME leaks in
 * and the assertions become machine-dependent.
 */
export function bareEnv(extra: Record<string, string> = {}): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key.startsWith("STAPLE_")) continue;
    if (LOCATOR_ENV_KEYS.includes(key)) continue;
    base[key] = value;
  }
  base.NODE_NO_WARNINGS = "1"; // node:sqlite's ExperimentalWarning is runtime noise
  return { ...base, ...extra };
}

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
  /** True when spawnSync had to kill the child on its timeout. */
  timedOut: boolean;
}

/**
 * Run the real CLI in a child process from an arbitrary directory. `cwd` is the
 * behaviour under test for walk-up resolution, so unlike contract-support.ts's
 * runCli it is a required argument rather than always the repository root.
 */
export function runCliAt(
  cwd: string,
  args: string[],
  env: Record<string, string> = {},
  timeoutMs = 30_000,
): CliResult {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd,
    env: bareEnv(env),
    encoding: "utf8",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  return {
    status: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    timedOut: result.error !== undefined && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT",
  };
}

/**
 * A temporary directory whose path is fully resolved. macOS hands out
 * `/var/folders/...` from mkdtemp while `process.cwd()` inside the child reports
 * the `/private/var/folders/...` realpath, so a golden built from one and
 * compared against the other fails for a reason that has nothing to do with
 * staple. Resolving once, here, removes the whole class.
 *
 * NOTE for A5: staple itself does NOT do this. `initWorkspace` stores
 * `resolve(process.cwd())` in the hub while a `--global` path is built from
 * `STAPLE_HOME` verbatim, so the same machine can hold hub rows in both spellings.
 * See characterize-hub-contract.test.ts.
 */
export function tempDir(prefix: string): string {
  return realpathSync(mkdtempSync(join(tmpdir(), `staple-${prefix}-`)));
}

export function removeDir(path: string | undefined): void {
  if (path) rmSync(path, { recursive: true, force: true });
}

/**
 * Every path under `root`, relative and sorted, with directories suffixed `/`
 * and files carrying their POSIX permission bits. This is the shape A5's path
 * migration has to reproduce or deliberately change, so it is pinned as a whole
 * tree rather than as a handful of existsSync assertions.
 */
export function diskTree(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const full = join(dir, entry.name);
      const rel = relative(root, full);
      if (entry.isDirectory()) {
        out.push(`${rel}/`);
        walk(full);
      } else {
        out.push(`${rel} ${(statSync(full).mode & 0o777).toString(8)}`);
      }
    }
  };
  walk(root);
  return out;
}

/** A loopback port that was free a moment ago — the usual best-effort dance. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.on("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export interface SpawnedProcess {
  stdout(): string;
  stderr(): string;
  /** Resolves once `predicate` sees the accumulated stream, or on timeout. */
  waitFor(predicate: (stdout: string, stderr: string) => boolean, timeoutMs?: number): Promise<boolean>;
  /** Resolves with the exit code, or null if it is still running at timeout. */
  waitForExit(timeoutMs?: number): Promise<number | null>;
  /** Signal the whole process group; defaults to SIGTERM. */
  kill(signal?: NodeJS.Signals): void;
}

/**
 * Start a long-lived staple process (`ui`, `mcp`) and accumulate both streams.
 * Startup logging is a contract here: a wrapper script greps stdout for the
 * bound URL, so the exact lines are pinned rather than the fact that "something
 * was printed".
 */
export function spawnStaple(
  entry: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string> },
): SpawnedProcess {
  // `detached` puts the child in its own process GROUP. tsx's launcher forks a
  // real grandchild to run the loader, so signalling only the direct child
  // orphans whatever is holding the listening socket — which is a property of
  // the test runner, not of staple, and would otherwise leak a bound port into
  // the next test. Signalling the group kills the launcher and the server both.
  const child = spawn(process.execPath, [TSX_CLI, entry, ...args], {
    cwd: options.cwd,
    env: bareEnv(options.env ?? {}),
    detached: true,
  });
  let out = "";
  let err = "";
  let exitCode: number | null = null;
  let exited = false;
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.stderr.on("data", (chunk) => (err += String(chunk)));
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
  });
  const poll = async (done: () => boolean, timeoutMs: number): Promise<boolean> => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (done()) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return done();
  };
  return {
    stdout: () => out,
    stderr: () => err,
    waitFor: (predicate, timeoutMs = 20_000) => poll(() => predicate(out, err), timeoutMs),
    async waitForExit(timeoutMs = 20_000) {
      await poll(() => exited, timeoutMs);
      return exited ? exitCode : null;
    },
    kill(signal: NodeJS.Signals = "SIGTERM") {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // already gone
      }
    },
  };
}
