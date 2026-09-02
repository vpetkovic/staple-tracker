/**
 * A1 — the ENVIRONMENT and RESOLUTION contract, frozen before A3 and A5.
 *
 * Nothing in the existing 562 tests pins how staple decides WHICH workspace a
 * command talks to. Every suite either passes `--db` explicitly or sets
 * `STAPLE_HOME` and uses `--ws`, so the precedence order, the walk-up, and the
 * three environment variables are entirely uncovered — and they are exactly what
 * A3 (versioned machine config, bootstrap locator, home resolution) and A5
 * (`.tasks` -> `.staple` path migration) rewrite.
 *
 * The resolution order in src/core/workspace.ts `resolveWorkspace` is:
 *
 *   1. `--db <path>`
 *   2. `STAPLE_DB`
 *   3. `--ws <slug|prefix>`  (hub lookup)
 *   4. walk up from cwd for `.staple/staple.db`, then legacy `.tasks/tasks.db`
 *
 * …and note what is NOT in that list: `STAPLE_WS`. It is documented in
 * src/mcp.ts's header and honoured by the MCP server, and the CLI ignores it.
 * Pinned below as a KNOWN divergence.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  bareEnv,
  CLI_ENTRY,
  removeDir,
  runCliAt,
  tempDir,
  TSX_CLI,
} from "./fixtures/characterize-support.js";

let home: string;
let root: string;
/** A repo workspace at <root>/outer, prefix OUT, holding exactly "repo task". */
let repo: string;
let repoDb: string;
/** A deeply nested directory inside that repo, for the walk-up cases. */
let nested: string;
/** A global workspace `gws`, prefix GWS, holding exactly "global task". */
let globalDb: string;
/** A directory with no workspace at or above it that staple can reach. */
let orphan: string;

const REPO_ROW = "◌  OUT-1     backlog     repo task\n";
const GLOBAL_ROW = "◌  GWS-1     backlog     global task\n";

beforeAll(() => {
  home = tempDir("char-env-home");
  root = tempDir("char-env-root");
  orphan = tempDir("char-env-orphan");
  repo = join(root, "outer");
  nested = join(repo, "a", "b", "c");
  mkdirSync(nested, { recursive: true });
  repoDb = join(repo, ".staple", "staple.db");
  globalDb = join(home, "workspaces", "gws.db");

  const cli = (cwd: string, args: string[], env: Record<string, string> = {}) =>
    runCliAt(cwd, args, { STAPLE_HOME: home, STAPLE_AGENT: "char-env", ...env });

  expect(cli(repo, ["init"]).status).toBe(0);
  expect(cli(repo, ["init", "--global", "gws"]).status).toBe(0);
  expect(cli(repo, ["new", "repo task"]).status).toBe(0);
  expect(cli(repo, ["new", "global task", "--db", globalDb]).status).toBe(0);
}, 120_000);

afterAll(() => {
  removeDir(home);
  removeDir(root);
  removeDir(orphan);
});

function ls(cwd: string, args: string[] = [], env: Record<string, string> = {}) {
  return runCliAt(cwd, ["ls", ...args], { STAPLE_HOME: home, ...env });
}

// ------------------------------------------------------------------- walk-up

describe("workspace walk-up from cwd", () => {
  it("finds the workspace database from the repo root and from a nested directory alike", () => {
    expect(ls(repo).stdout).toBe(REPO_ROW);
    expect(ls(nested).stdout).toBe(REPO_ROW);
  }, 30_000);

  // MOVED BY A5 (deliberate): the message names both layouts now, because both
  // are searched. Exit 3 and the sentence structure are unchanged.
  it("pins the not_found message and exit 3 when nothing is found at or above cwd", () => {
    const result = ls(orphan);
    expect(result.status).toBe(3);
    expect(result.stderr).toBe(
      "error(not_found): No .staple/staple.db (or legacy .tasks/tasks.db) found here or above. " +
        "Run `staple init` to create one, or pass --ws <slug> / --db <path>.\n",
    );
  });

  /**
   * MOVED BY A5 (deliberate) — this pin INVERTS, which is the whole point of
   * the ticket. A1 froze the "before": the walk-up looked only for the literal
   * `.tasks/tasks.db` and a `.staple/staple.db` beside it was invisible. Both
   * are now discovered, with the current layout preferred.
   */
  it("discovers `.staple/staple.db`, and still discovers legacy `.tasks/tasks.db`", () => {
    const decoy = tempDir("char-env-decoy");
    mkdirSync(join(decoy, ".staple"), { recursive: true });
    expect(runCliAt(decoy, ["init", "--global", "decoyws"], { STAPLE_HOME: home }).status).toBe(0);
    spawnSync("cp", [join(home, "workspaces", "decoyws.db"), join(decoy, ".staple", "staple.db")]);
    expect(ls(decoy).status).toBe(0);

    // …and the legacy layout still resolves during the compatibility window.
    const legacy = tempDir("char-env-legacy");
    mkdirSync(join(legacy, ".tasks"), { recursive: true });
    spawnSync("cp", [join(home, "workspaces", "decoyws.db"), join(legacy, ".tasks", "tasks.db")]);
    expect(ls(legacy).status).toBe(0);

    removeDir(decoy);
    removeDir(legacy);
  }, 30_000);
});

// ---------------------------------------------------------------- precedence

describe("workspace selector precedence", () => {
  it("STAPLE_DB beats the cwd walk-up", () => {
    expect(ls(nested, [], { STAPLE_DB: globalDb }).stdout).toBe(GLOBAL_ROW);
  });

  it("--db beats STAPLE_DB", () => {
    expect(ls(nested, ["--db", repoDb], { STAPLE_DB: globalDb }).stdout).toBe(REPO_ROW);
  });

  /**
   * QUIRK (A3): an ENVIRONMENT variable outranks an EXPLICIT flag here.
   * `resolveWorkspace` tests `options.db ?? STAPLE_DB` before it ever looks at
   * `options.ws`, so `--ws outer` is silently ignored while STAPLE_DB is set —
   * with no warning that the flag the user typed did nothing.
   */
  it("KNOWN: STAPLE_DB silently beats an explicit --ws", () => {
    const result = ls(nested, ["--ws", "outer"], { STAPLE_DB: globalDb });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe(GLOBAL_ROW);
    expect(result.stderr).toBe("");
  });

  it("--ws resolves through the hub by slug and by prefix, case-insensitively", () => {
    for (const selector of ["gws", "GWS", "gWs"]) {
      expect(ls(orphan, ["--ws", selector]).stdout, selector).toBe(GLOBAL_ROW);
    }
  }, 40_000);

  it("pins the two distinct not_found messages for a bad --ws and a bad --db", () => {
    const badWs = ls(orphan, ["--ws", "nope"]);
    expect(badWs.status).toBe(3);
    expect(badWs.stderr).toBe(
      'error(not_found): No workspace "nope" in the hub. Run staple hub ls.\n',
    );

    const missing = join(home, "definitely-absent.db");
    const badDb = ls(orphan, ["--db", missing]);
    expect(badDb.status).toBe(3);
    expect(badDb.stderr).toBe(
      `error(not_found): No workspace at ${missing}. ` +
        "Run `staple init` in the repo (or `staple init --global <slug>`).\n",
    );
  }, 30_000);

  /**
   * KNOWN divergence between surfaces. src/mcp.ts resolves with
   * `{ db: STAPLE_DB, ws: STAPLE_WS }`; src/cli.ts passes only the parsed flags,
   * so STAPLE_WS does nothing on the CLI. A harness that configures one agent's
   * environment for both surfaces gets two different workspaces.
   */
  it("KNOWN: STAPLE_WS is honoured by MCP and ignored by the CLI", () => {
    const result = ls(orphan, [], { STAPLE_WS: "gws" });
    expect(result.status).toBe(3);
    expect(result.stderr).toContain("No .staple/staple.db (or legacy .tasks/tasks.db) found here or above");
  });
});

// ------------------------------------------------------------------ identity

describe("agent identity resolution", () => {
  /**
   * `agentName()` is `explicit ?? STAPLE_AGENT ?? USER ?? "user"`. All four rungs
   * are exercised in one workspace so the ladder is visible as a single golden.
   * contract-cli.test.ts pins the $USER rung; the literal `"user"` floor — what
   * a container with no USER set produces — is pinned only here.
   */
  it("pins the whole --agent/--author > STAPLE_AGENT > USER > \"user\" ladder", () => {
    const target = ["--db", globalDb];
    const withEnv = { STAPLE_HOME: home, STAPLE_AGENT: "env-agent", USER: "shell-user" };
    expect(runCliAt(repo, ["comment", "GWS-1", "from env", ...target], withEnv).status).toBe(0);
    expect(
      runCliAt(repo, ["comment", "GWS-1", "from user", ...target], { STAPLE_HOME: home, USER: "shell-user" }).status,
    ).toBe(0);
    expect(
      runCliAt(repo, ["comment", "GWS-1", "from flag", "--author", "flag-agent", ...target], withEnv).status,
    ).toBe(0);

    // The floor: no --author, no STAPLE_AGENT, and USER deleted outright.
    const noUser = bareEnv({ STAPLE_HOME: home });
    delete noUser.USER;
    const floor = spawnSync(
      process.execPath,
      [TSX_CLI, CLI_ENTRY, "comment", "GWS-1", "from nothing", ...target],
      { cwd: repo, env: noUser, encoding: "utf8" },
    );
    expect(floor.status).toBe(0);

    const context = JSON.parse(
      runCliAt(repo, ["show", "GWS-1", "--json", ...target], { STAPLE_HOME: home }).stdout,
    ) as { comments: Array<{ author: string; authorType: string; body: string }> };
    const authorOf = (body: string) => context.comments.find((c) => c.body === body)?.author;
    expect(authorOf("from env")).toBe("env-agent");
    expect(authorOf("from user")).toBe("shell-user");
    expect(authorOf("from flag")).toBe("flag-agent");
    // QUIRK (A6): the floor is a real, silently-accepted identity. A write from
    // an environment with nothing set is attributed to the literal string
    // "user", which is indistinguishable from a person actually named that.
    expect(authorOf("from nothing")).toBe("user");
  }, 90_000);

  it("`checkout --agent` overrides STAPLE_AGENT for the claim itself", () => {
    const result = runCliAt(repo, ["checkout", "OUT-1", "--agent", "flag-claimer", "--json"], {
      STAPLE_HOME: home,
      STAPLE_AGENT: "env-claimer",
    });
    expect(result.status).toBe(0);
    expect((JSON.parse(result.stdout) as { checkoutAgent: string }).checkoutAgent).toBe("flag-claimer");
    expect(runCliAt(repo, ["release", "OUT-1"], { STAPLE_HOME: home, STAPLE_AGENT: "flag-claimer" }).status).toBe(0);
  }, 60_000);
});

// ---------------------------------------------------------------- STAPLE_HOME

describe("STAPLE_HOME", () => {
  it("relocates the hub, the global workspaces directory, and the ui token together", () => {
    const other = tempDir("char-env-otherhome");
    // A workspace registered under `home` is invisible from a different home:
    // the hub is per-home state, with no cross-home discovery of any kind.
    expect(runCliAt(orphan, ["ls", "--ws", "gws"], { STAPLE_HOME: other }).status).toBe(3);
    expect(runCliAt(orphan, ["hub", "ls"], { STAPLE_HOME: other }).stdout).toBe("");
    expect(runCliAt(orphan, ["hub", "ls"], { STAPLE_HOME: home }).stdout).not.toBe("");
    removeDir(other);
  }, 40_000);

  /**
   * FIXED by A3 (STA-33) — this pin is the mirror of the one it replaces.
   *
   * BEFORE: staple resolved "the home" in THREE places with TWO different
   * fallbacks. `core/workspace.ts stapleHome()` used `os.homedir()`, while
   * `core/hub.ts Hub.hubPath()` and `cli.ts persistentUiToken()` used
   * `process.env.HOME ?? "~"` — which on a machine with HOME unset produced a
   * LITERAL relative directory named `~`, next to the cwd. The original
   * assertion pinned those three source expressions verbatim precisely so A3
   * would have a written "before" to replace, which is what happened.
   *
   * AFTER: STA-24 plan §2 mandates one resolver with the order
   * `--home` > `STAPLE_HOME` > bootstrap locator > `~/.staple`. All three call
   * sites now import it from `src/config/`, and the literal-`~` expression is
   * gone from the whole source tree. The behavioural coverage lives in
   * test/config-home.test.ts; this stays as the source-level guard against the
   * divergence creeping back in.
   */
  it("all three former call sites resolve the home through src/config", async () => {
    const { readCode } = await import("./fixtures/source-scan.js");
    // Read as CODE: each site now carries a comment explaining what used to be
    // there, and those comments quote the very expression under test.
    const workspaceSrc = readCode(join(CLI_ENTRY, "..", "core", "workspace.ts"));
    const hubSrc = readCode(join(CLI_ENTRY, "..", "core", "hub.ts"));
    const cliSrc = readCode(CLI_ENTRY);
    for (const [name, src] of [
      ["workspace.ts", workspaceSrc],
      ["hub.ts", hubSrc],
      ["cli.ts", cliSrc],
    ] as const) {
      expect(src, name).toMatch(/from "\.\.?\/config\//);
      expect(src, name).not.toContain('process.env.HOME ?? "~"');
    }
    // And none of them re-derives a home of its own any more.
    expect(hubSrc).toContain("join(stapleHome(), \"hub.db\")");
    expect(cliSrc).toContain("const home = stapleHome();");
  });
});
