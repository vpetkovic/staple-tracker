/**
 * Vitest globalSetup: the suite never runs against the operator's own staple home.
 *
 * A test that forgets to set `STAPLE_HOME` resolves the hub through the default home,
 * `~/.staple/hub.db`. On a developer machine that is the LIVE hub, and a branch that
 * carries a new hub migration upgrades it the moment such a test opens it: the installed
 * runtime then refuses every hub command until someone rolls the file back. That is not
 * hypothetical; an in-process path migration test did exactly that.
 *
 * So, before anything else runs:
 *
 *   1. The real staple home is recorded and SNAPSHOTTED: whether its hub exists, the
 *      hub's schema version, tables, scratch registrations and budget-table rowids, the
 *      global workspace databases, and the content hash of `config.json`.
 *   2. `HOME`, `STAPLE_HOME` and the locator variables are pointed at a directory private
 *      to this run, and handed to every worker (`isolatedHome`, applied again per file by
 *      `test/setup/isolate-env.ts`, so a worker that did not inherit the environment
 *      still cannot reach the real home).
 *   3. At teardown the snapshot is taken again, and the run FAILS if, in the real staple
 *      home, the hub was created or migrated, registered a workspace under the temp
 *      directory (either spelling of it), or gained budget rows a test wrote; a global
 *      workspace database appeared; or `config.json` was created or changed.
 *
 * Why not compare the hub's mtime: on the machines this suite runs on, live agents write
 * the real hub while the suite runs (a `done` notifies it), so an mtime check would fail
 * runs that did nothing wrong. The guard looks only for what a TEST could have written:
 *
 *   - Budget rows. With capture on, every open Claude Code session writes a heartbeat
 *     row every 300 s, so a row count would fail nearly every run. A new sample counts
 *     only when a live status line could not have written it: its source is not
 *     `claude_code_statusline`, its account is not one the real `config.json` binds, its
 *     `recorded_at` lies outside this run's wall-clock window (tests inject fixed
 *     clocks), or its `session_ref` is the hash of a fixture session. A new window counts
 *     when its account is unbound or its `created_at` is outside the run.
 *   - Global workspace databases. Live connections create and delete `-wal`/`-shm`
 *     files, and `snapshots/` and each workspace's own directory are written by normal
 *     operation, so only a new top-level `*.db` counts. A registration leak is G2's.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestProject } from "vitest/node";
import { sessionRefOf } from "../../src/core/telemetry/formats.js";
import { STATUSLINE_SESSION_ID } from "../fixtures/budget-support.js";

declare module "vitest" {
  export interface ProvidedContext {
    isolatedHome: { home: string; stapleHome: string };
  }
}

interface HubSnapshot {
  readonly exists: boolean;
  readonly schemaVersion: string | null;
  readonly tables: string[];
  readonly scratchWorkspaces: string[];
  /** The highest rowid of each budget table at snapshot time, when the hub has it. */
  readonly budgetHighWater: Record<string, number>;
}

/** What a live status line on this machine can write, taken when the run starts. */
export interface LiveBudgetContext {
  /** Accounts the real `config.json` binds. */
  readonly boundAccounts: readonly string[];
  /** This run's wall-clock window, ISO. */
  readonly startedAt: string;
  endedAt?: string;
  /** sessionRef hashes of the fixture sessions a test ingests. */
  readonly fixtureSessionRefs: readonly string[];
}

const BUDGET_TABLES = ["budget_samples", "limit_windows"] as const;

/**
 * The spellings a scratch path can take. On macOS `tmpdir()` is `/var/folders/…` and its
 * realpath `/private/var/folders/…`; a workspace registered through a realpath'd sandbox
 * carries the second, so both are checked.
 */
export function scratchPrefixes(scratchRoot: string): string[] {
  const prefixes = new Set([scratchRoot, tmpdir()]);
  try {
    prefixes.add(realpathSync(tmpdir()));
  } catch {
    // an unreadable tmpdir has no second spelling
  }
  return [...prefixes];
}

/** Read-only: SQLite's own read-only mode, so taking the snapshot cannot write the file. */
export function snapshotHub(path: string, scratchRoot: string): HubSnapshot {
  if (!existsSync(path)) return { exists: false, schemaVersion: null, tables: [], scratchWorkspaces: [], budgetHighWater: {} };
  const prefixes = scratchPrefixes(scratchRoot);
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const version = tables.includes("meta")
      ? ((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value ?? null)
      : null;
    const scratchWorkspaces = tables.includes("workspaces")
      ? (db.prepare("SELECT path FROM workspaces").all() as Array<{ path: string }>)
          .map((r) => r.path)
          .filter((p) => prefixes.some((prefix) => p.startsWith(prefix)))
          .sort()
      : [];
    const budgetHighWater: Record<string, number> = {};
    for (const table of BUDGET_TABLES) {
      if (!tables.includes(table)) continue;
      budgetHighWater[table] = (db.prepare(`SELECT coalesce(max(rowid), 0) AS n FROM ${table}`).get() as { n: number }).n;
    }
    return { exists: true, schemaVersion: version, tables, scratchWorkspaces, budgetHighWater };
  } finally {
    db.close();
  }
}

/**
 * The global workspace databases: top-level `*.db` files only. Sidecars (`-wal`, `-shm`,
 * `-journal`) come and go with every live connection, and `snapshots/` and each
 * workspace's own directory are written by normal operation.
 */
function workspaceDatabases(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".db"))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Budget rows added after the snapshot that a live status line could not have written.
 * Read-only, like the snapshot.
 */
export function testWrittenBudgetRows(path: string, before: HubSnapshot, live: LiveBudgetContext): string[] {
  if (!before.exists || !existsSync(path)) return [];
  const db = new DatabaseSync(path, { readOnly: true });
  const found: string[] = [];
  try {
    const bound = new Set(live.boundAccounts);
    const endedAt = live.endedAt ?? new Date().toISOString();
    const outside = (at: string) => at < live.startedAt || at > endedAt;
    if (before.budgetHighWater.budget_samples !== undefined) {
      const rows = db
        .prepare("SELECT source_kind, account_ref, recorded_at, session_ref FROM budget_samples WHERE rowid > ?")
        .all(before.budgetHighWater.budget_samples) as Array<{ source_kind: string; account_ref: string; recorded_at: string; session_ref: string | null }>;
      for (const row of rows) {
        const why =
          row.source_kind !== "claude_code_statusline"
            ? `source ${row.source_kind}`
            : !bound.has(row.account_ref)
              ? `unbound account ${row.account_ref}`
              : outside(row.recorded_at)
                ? `recorded_at ${row.recorded_at} outside the run`
                : row.session_ref !== null && live.fixtureSessionRefs.includes(row.session_ref)
                  ? "a fixture session"
                  : null;
        if (why !== null) found.push(`budget_samples row (${why})`);
      }
    }
    if (before.budgetHighWater.limit_windows !== undefined) {
      const rows = db
        .prepare("SELECT account_ref, created_at FROM limit_windows WHERE rowid > ?")
        .all(before.budgetHighWater.limit_windows) as Array<{ account_ref: string; created_at: string }>;
      for (const row of rows) {
        const why = !bound.has(row.account_ref)
          ? `unbound account ${row.account_ref}`
          : outside(row.created_at)
            ? `created_at ${row.created_at} outside the run`
            : null;
        if (why !== null) found.push(`limit_windows row (${why})`);
      }
    }
  } finally {
    db.close();
  }
  return found;
}

/** The accounts a real `config.json` binds, read without the config module's validation. */
export function boundAccountsIn(stapleHome: string): string[] {
  try {
    const parsed = JSON.parse(readFileSync(join(stapleHome, "config.json"), "utf8")) as { telemetry?: { bindings?: unknown[] } };
    return (parsed.telemetry?.bindings ?? []).flatMap((b) =>
      b !== null && typeof b === "object" && typeof (b as { accountRef?: unknown }).accountRef === "string" ? [(b as { accountRef: string }).accountRef] : [],
    );
  } catch {
    return [];
  }
}

/** Existence and content hash, never mtime. */
function fileDigest(path: string): string | null {
  try {
    return createHash("sha256").update(readFileSync(path)).digest("hex");
  } catch {
    return null;
  }
}

export interface HomeSnapshot {
  readonly hub: HubSnapshot;
  readonly workspaceFiles: string[];
  readonly configDigest: string | null;
}

export function snapshotHome(stapleHome: string, scratchRoot: string): HomeSnapshot {
  return {
    hub: snapshotHub(join(stapleHome, "hub.db"), scratchRoot),
    workspaceFiles: workspaceDatabases(join(stapleHome, "workspaces")),
    configDigest: fileDigest(join(stapleHome, "config.json")),
  };
}

/** Every staple home the operator's environment can resolve to: `STAPLE_HOME`, and `~/.staple`. */
export function realStapleHomes(env: NodeJS.ProcessEnv, home: string): string[] {
  const homes = new Set<string>([join(home, ".staple")]);
  if (env.STAPLE_HOME) homes.add(env.STAPLE_HOME);
  return [...homes];
}

export function describeChanges(stapleHome: string, before: HomeSnapshot, after: HomeSnapshot, live: LiveBudgetContext): string[] {
  const hub = join(stapleHome, "hub.db");
  const changes: string[] = [];
  const b = before.hub;
  const a = after.hub;
  if (!b.exists && a.exists) changes.push(`${hub} was CREATED by the test run`);
  else if (b.schemaVersion !== a.schemaVersion) changes.push(`${hub} was MIGRATED from schema ${b.schemaVersion} to ${a.schemaVersion} by the test run`);
  else if (b.tables.join(",") !== a.tables.join(",")) changes.push(`${hub} gained or lost tables during the test run: ${a.tables.join(", ")}`);
  const added = a.scratchWorkspaces.filter((p) => !b.scratchWorkspaces.includes(p));
  if (added.length > 0) changes.push(`${hub} registered scratch workspaces during the test run: ${added.join(", ")}`);
  const budget = testWrittenBudgetRows(hub, b, live);
  if (budget.length > 0) changes.push(`${hub} gained budget rows a test wrote: ${budget.slice(0, 5).join("; ")}`);
  const newFiles = after.workspaceFiles.filter((f) => !before.workspaceFiles.includes(f));
  if (newFiles.length > 0) changes.push(`${join(stapleHome, "workspaces")} gained workspace databases during the test run: ${newFiles.slice(0, 5).join(", ")}`);
  if (before.configDigest !== after.configDigest) {
    const what = before.configDigest === null ? "CREATED" : after.configDigest === null ? "DELETED" : "CHANGED";
    changes.push(`${join(stapleHome, "config.json")} was ${what} by the test run`);
  }
  return changes;
}

export default function setup(project: TestProject): () => void {
  const realHome = homedir();
  const watched = realStapleHomes(process.env, realHome);

  const root = realpathSync(mkdtempSync(join(tmpdir(), `staple-test-home-${process.pid}-`)));
  const home = join(root, "home");
  const stapleHome = join(home, ".staple");
  mkdirSync(stapleHome, { recursive: true });
  const before = watched.map((path) => snapshotHome(path, root));
  const live: LiveBudgetContext = {
    boundAccounts: watched.flatMap((path) => boundAccountsIn(path)),
    startedAt: new Date().toISOString(),
    fixtureSessionRefs: [sessionRefOf("claude_code", STATUSLINE_SESSION_ID)],
  };

  process.env.HOME = home;
  process.env.STAPLE_HOME = stapleHome;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.APPDATA = join(home, "AppData", "Roaming");
  project.provide("isolatedHome", { home, stapleHome });

  return () => {
    live.endedAt = new Date().toISOString();
    const changes = watched.flatMap((path, i) => describeChanges(path, before[i]!, snapshotHome(path, root), live));
    rmSync(root, { recursive: true, force: true });
    if (changes.length > 0) {
      throw new Error(
        `The test run wrote to the operator's real staple home:\n  ${changes.join("\n  ")}\n` +
          "A test resolved the staple home through the default. Give it an explicit STAPLE_HOME.",
      );
    }
  };
}
