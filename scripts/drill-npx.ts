/**
 * Clean-machine npx drill (epic D, ticket D2).
 *
 * Proves the published artifact works on a machine that has Node >= 22.5 and
 * NOTHING else — no tsx, no vite, no repository checkout. The DRIVER (this
 * file) is allowed dev tooling; the ARTIFACT UNDER TEST is not.
 *
 *   1. `npm run build:package` builds dist-package/ in the checkout.
 *   2. `npm pack ./dist-package` writes a tarball into a temp dir OUTSIDE the repo.
 *   3. The tarball is installed into an empty temp prefix; from then on every
 *      invocation is the installed bin (<prefix>/node_modules/.bin/staple),
 *      never the checkout.
 *
 * Assert-time isolation, so the drill FAILS if the artifact reaches back:
 *   - cwd of every child is a temp dir, never the repo;
 *   - PATH contains only Node's own bin dir plus /usr/bin:/bin (for the
 *     `#!/usr/bin/env node` shebang) — tsx, vite, npm-installed dev tools and
 *     the repo's node_modules/.bin are unreachable;
 *   - the environment is built from scratch (temp HOME, temp STAPLE_HOME); no
 *     NODE_PATH, no NODE_OPTIONS, no npm_config_* leak through;
 *   - the installed bundle is scanned for the checkout's absolute path — an
 *     esbuild output that embeds it would be reaching back at runtime;
 *   - <prefix>/node_modules must contain staple-cli and nothing else: the
 *     artifact declares zero runtime dependencies and must install that way.
 *
 * Assertions (spec: STA-91 plan, section D2):
 *   - `staple --version` prints exactly the package version, bare, no banner;
 *   - `staple --help` exits 0 and prints usage;
 *   - `staple mcp` completes an MCP initialize handshake over stdio;
 *   - in a fresh repo dir with a temp STAPLE_HOME, `staple init --yes` works
 *     and `staple inbox --json` returns valid JSON;
 *   - the installed package.json exposes exactly ONE bin, named `staple`
 *     (this is what lets bare `npx staple-cli` resolve with no flags);
 *   - bare `staple` with non-TTY stdio exits 2 and names explicit commands.
 *
 * Not part of `npm test`: the drill rebuilds the UI and the bundle and runs a
 * real `npm install`, which is minutes, not milliseconds. CI and humans call
 * `npm run drill:npx`.
 */
import { spawn, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------------------
// Tiny harness: named steps with timings, first failure aborts with exit 1.
// ---------------------------------------------------------------------------

let stepCount = 0;
function step<T>(name: string, fn: () => T): T {
  const started = Date.now();
  try {
    const value = fn();
    console.log(`  ok ${String(++stepCount).padStart(2)}  ${name}  (${Date.now() - started}ms)`);
    return value;
  } catch (error) {
    console.error(`FAIL     ${name}  (${Date.now() - started}ms)`);
    throw error;
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`drill assertion failed: ${message}`);
}

function preview(text: string, max = 400): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}

// ---------------------------------------------------------------------------
// Temp layout — everything OUTSIDE the repository (its .gitignore has a bare
// `dist` entry; nothing the drill produces may land in the checkout anyway).
// ---------------------------------------------------------------------------

const workRoot = mkdtempSync(join(tmpdir(), "staple-drill-"));
const packDir = join(workRoot, "pack"); // tarball lands here
const prefix = join(workRoot, "prefix"); // empty install prefix
const cleanHome = join(workRoot, "home"); // HOME for assert-time children
const stapleHome = join(workRoot, "staple-home"); // temp STAPLE_HOME
const projectDir = join(workRoot, "project"); // fresh repo dir for init/inbox
for (const dir of [packDir, prefix, cleanHome, stapleHome, projectDir]) {
  mkdirSync(dir, { recursive: true });
}

/**
 * The clean-machine environment. Built from scratch, not filtered: only Node's
 * own directory (plus /usr/bin:/bin for the shebang's `env`) is on PATH, so a
 * child that tries to exec tsx, vite, or anything from the checkout's
 * node_modules/.bin gets ENOENT instead of silently working.
 */
const cleanEnv: NodeJS.ProcessEnv = {
  PATH: [dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
  HOME: cleanHome,
  TMPDIR: join(workRoot, "tmp"),
  STAPLE_HOME: stapleHome,
  STAPLE_AGENT: "drill",
};
mkdirSync(cleanEnv.TMPDIR!, { recursive: true });

/** Driver-side npm calls (build, pack, install) may use the full dev environment. */
function npm(args: string[], cwd: string): SpawnSyncReturns<string> {
  const result = spawnSync("npm", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
  });
  assert(
    result.status === 0,
    `npm ${args.join(" ")} exited ${result.status}\n${preview(result.stderr ?? "", 2000)}`,
  );
  return result;
}

/** Assert-time invocation of the INSTALLED bin, under the clean environment. */
function staple(
  args: string[],
  options: { cwd?: string; input?: string } = {},
): SpawnSyncReturns<string> {
  const result = spawnSync(installedBin, args, {
    cwd: options.cwd ?? workRoot,
    env: cleanEnv,
    encoding: "utf8",
    input: options.input ?? "",
    timeout: 60_000,
    stdio: ["pipe", "pipe", "pipe"], // pipes, therefore non-TTY
  });
  assert(!result.error, `spawn failed for staple ${args.join(" ")}: ${result.error}`);
  return result;
}

// ---------------------------------------------------------------------------
// The drill.
// ---------------------------------------------------------------------------

const drillStarted = Date.now();
console.log("staple clean-machine drill");
console.log(`  node ${process.version} · temp ${workRoot}`);

let installedBin = ""; // set after install
let exitCode = 0;

try {
  step("build the package (npm run build:package)", () => {
    npm(["run", "build:package"], repoRoot);
  });

  const tarball = step("npm pack ./dist-package into a temp dir outside the repo", () => {
    npm(["pack", join(repoRoot, "dist-package"), "--pack-destination", packDir], packDir);
    const [only, ...extra] = readdirSync(packDir).filter((f) => f.endsWith(".tgz"));
    assert(
      only !== undefined && extra.length === 0,
      `expected exactly one tarball, got ${JSON.stringify([only, ...extra])}`,
    );
    return join(packDir, only);
  });

  step("install the tarball into an empty temp prefix", () => {
    npm(
      ["install", "--prefix", prefix, "--no-audit", "--no-fund", "--loglevel=error", tarball],
      workRoot,
    );
    installedBin = join(prefix, "node_modules", ".bin", "staple");
  });

  const manifest = step("installed package.json exposes exactly ONE bin, named `staple`", () => {
    const pkg = JSON.parse(
      readFileSync(join(prefix, "node_modules", "staple-cli", "package.json"), "utf8"),
    ) as { name: string; version: string; bin: Record<string, string> };
    assert(pkg.name === "staple-cli", `package name is ${pkg.name}, expected staple-cli`);
    const bins = Object.keys(pkg.bin ?? {});
    assert(
      bins.length === 1 && bins[0] === "staple",
      `bin map must be exactly {staple}, got ${JSON.stringify(pkg.bin)} — a second entry ` +
        "breaks bare `npx staple-cli` resolution",
    );
    return pkg;
  });

  step("install pulled zero runtime dependencies", () => {
    const entries = readdirSync(join(prefix, "node_modules")).filter((e) => !e.startsWith("."));
    assert(
      entries.length === 1 && entries[0] === "staple-cli",
      `prefix node_modules must contain only staple-cli, got ${JSON.stringify(entries)}`,
    );
  });

  step("installed bundle does not reference the repository checkout", () => {
    const bundle = readFileSync(join(prefix, "node_modules", "staple-cli", "staple.mjs"), "utf8");
    assert(
      !bundle.includes(repoRoot),
      `staple.mjs embeds the checkout path ${repoRoot} — the artifact would reach back at runtime`,
    );
  });

  step("`staple --version` prints exactly the package version, bare", () => {
    const result = staple(["--version"]);
    assert(result.status === 0, `--version exited ${result.status}: ${preview(result.stderr)}`);
    assert(
      result.stdout.trim() === manifest.version,
      `--version printed ${JSON.stringify(result.stdout)}, expected exactly ${manifest.version}`,
    );
  });

  step("`staple --help` exits 0 and prints usage", () => {
    const result = staple(["--help"]);
    assert(result.status === 0, `--help exited ${result.status}: ${preview(result.stderr)}`);
    for (const needle of ["staple", "init", "inbox"]) {
      assert(result.stdout.includes(needle), `--help output does not mention "${needle}"`);
    }
  });

  step("bare `staple` with non-TTY stdio exits 2 and names explicit commands", () => {
    const result = staple([]);
    assert(result.status === 2, `bare non-TTY staple exited ${result.status}, expected 2`);
    const output = result.stdout + result.stderr;
    for (const needle of ["staple init --yes", "staple open", "staple help"]) {
      assert(output.includes(needle), `non-TTY refusal does not name "${needle}"`);
    }
  });

  step("`staple init --yes` succeeds in a fresh repo dir with a temp STAPLE_HOME", () => {
    const result = staple(["init", "--yes"], { cwd: projectDir });
    assert(
      result.status === 0,
      `init --yes exited ${result.status}\nstdout: ${preview(result.stdout)}\nstderr: ${preview(result.stderr)}`,
    );
  });

  step("`staple inbox --json` returns valid JSON", () => {
    const result = staple(["inbox", "--json"], { cwd: projectDir });
    assert(
      result.status === 0,
      `inbox --json exited ${result.status}\nstderr: ${preview(result.stderr)}`,
    );
    JSON.parse(result.stdout); // throws on anything that is not valid JSON
  });

  await (async () => {
    const started = Date.now();
    const name = "`staple mcp` completes an MCP initialize handshake over stdio";
    try {
      await mcpHandshake();
      console.log(`  ok ${String(++stepCount).padStart(2)}  ${name}  (${Date.now() - started}ms)`);
    } catch (error) {
      console.error(`FAIL     ${name}  (${Date.now() - started}ms)`);
      throw error;
    }
  })();

  console.log(`PASS  all ${stepCount} steps  (${Date.now() - drillStarted}ms total)`);
} catch (error) {
  exitCode = 1;
  console.error(String(error instanceof Error ? (error.stack ?? error.message) : error));
  console.error(`DRILL FAILED after ${Date.now() - drillStarted}ms`);
} finally {
  rmSync(workRoot, { recursive: true, force: true });
}
process.exit(exitCode);

/**
 * Speaks just enough MCP to prove the installed bin is a live stdio server:
 * send `initialize`, require a JSON-RPC result carrying serverInfo, close.
 */
async function mcpHandshake(): Promise<void> {
  const child = spawn(installedBin, ["mcp"], {
    cwd: projectDir,
    env: cleanEnv,
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));

  const response = await new Promise<any>((resolvePromise, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`no initialize response within 20s\nserver stderr: ${preview(stderr)}`));
    }, 20_000);

    let buffer = "";
    child.stdout.on("data", (chunk: Buffer) => {
      buffer += chunk.toString("utf8");
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        try {
          const message = JSON.parse(line);
          if (message.id === 1) {
            clearTimeout(timer);
            resolvePromise(message);
            return;
          }
        } catch {
          clearTimeout(timer);
          reject(new Error(`non-JSON line on MCP stdout: ${preview(line)}`));
          return;
        }
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`staple mcp exited early (code ${code})\nstderr: ${preview(stderr)}`));
    });

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "staple-drill", version: "0.0.0" },
        },
      })}\n`,
    );
  });

  child.removeAllListeners("exit");
  child.kill();

  assert(response.result, `initialize returned no result: ${preview(JSON.stringify(response))}`);
  assert(
    response.result.serverInfo?.name,
    `initialize result has no serverInfo: ${preview(JSON.stringify(response.result))}`,
  );
}
