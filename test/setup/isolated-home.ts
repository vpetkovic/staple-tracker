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
 *      hub's schema version, tables, scratch registrations and budget rows, the files
 *      under `workspaces/`, and the content hash of `config.json`.
 *   2. `HOME`, `STAPLE_HOME` and the locator variables are pointed at a directory private
 *      to this run, and handed to every worker (`isolatedHome`, applied again per file by
 *      `test/setup/isolate-env.ts`, so a worker that did not inherit the environment
 *      still cannot reach the real home).
 *   3. At teardown the snapshot is taken again, and the run FAILS if, in the real staple
 *      home, the hub was created or migrated, registered a workspace under the temp
 *      directory (either spelling of it), or gained or changed budget rows; a file
 *      appeared under `workspaces/`; or `config.json` was created or changed.
 *
 * Why not compare the hub's mtime: on the machines this suite runs on, live agents write
 * the real hub while the suite runs (a `done` notifies it), so an mtime check would fail
 * runs that did nothing wrong. The guard looks for what a test run can do and a live
 * agent does not. The one overlap is budget capture: once the operator enables it on this
 * machine, a status line rendering during the run adds budget rows, and the run fails
 * with a sentence naming the table. Re-run it; a leak fails every time, a render does not.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { TestProject } from "vitest/node";

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
  /** Row count and newest write of each budget table, when the hub has it. */
  readonly budgetRows: Record<string, string>;
}

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
  if (!existsSync(path)) return { exists: false, schemaVersion: null, tables: [], scratchWorkspaces: [], budgetRows: {} };
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
    const budgetRows: Record<string, string> = {};
    for (const [table, column] of [
      ["budget_samples", "recorded_at"],
      ["limit_windows", "created_at"],
    ] as const) {
      if (!tables.includes(table)) continue;
      const row = db.prepare(`SELECT count(*) AS n, max(${column}) AS newest FROM ${table}`).get() as { n: number; newest: string | null };
      budgetRows[table] = `${row.n} rows, newest ${row.newest ?? "none"}`;
    }
    return { exists: true, schemaVersion: version, tables, scratchWorkspaces, budgetRows };
  } finally {
    db.close();
  }
}

/** Every file under a directory, relative and sorted; empty when it does not exist. */
function filesUnder(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, rel: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const relative = rel === "" ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(join(dir, entry.name), relative);
      else out.push(relative);
    }
  };
  walk(root, "");
  return out.sort();
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
    workspaceFiles: filesUnder(join(stapleHome, "workspaces")),
    configDigest: fileDigest(join(stapleHome, "config.json")),
  };
}

/** Every staple home the operator's environment can resolve to: `STAPLE_HOME`, and `~/.staple`. */
export function realStapleHomes(env: NodeJS.ProcessEnv, home: string): string[] {
  const homes = new Set<string>([join(home, ".staple")]);
  if (env.STAPLE_HOME) homes.add(env.STAPLE_HOME);
  return [...homes];
}

export function describeChanges(stapleHome: string, before: HomeSnapshot, after: HomeSnapshot): string[] {
  const hub = join(stapleHome, "hub.db");
  const changes: string[] = [];
  const b = before.hub;
  const a = after.hub;
  if (!b.exists && a.exists) changes.push(`${hub} was CREATED by the test run`);
  else if (b.schemaVersion !== a.schemaVersion) changes.push(`${hub} was MIGRATED from schema ${b.schemaVersion} to ${a.schemaVersion} by the test run`);
  else if (b.tables.join(",") !== a.tables.join(",")) changes.push(`${hub} gained or lost tables during the test run: ${a.tables.join(", ")}`);
  const added = a.scratchWorkspaces.filter((p) => !b.scratchWorkspaces.includes(p));
  if (added.length > 0) changes.push(`${hub} registered scratch workspaces during the test run: ${added.join(", ")}`);
  for (const table of Object.keys(a.budgetRows)) {
    if (b.budgetRows[table] !== undefined && b.budgetRows[table] !== a.budgetRows[table]) {
      changes.push(`${hub} ${table} changed during the test run: ${b.budgetRows[table]} -> ${a.budgetRows[table]}`);
    }
  }
  const newFiles = after.workspaceFiles.filter((f) => !before.workspaceFiles.includes(f));
  if (newFiles.length > 0) changes.push(`${join(stapleHome, "workspaces")} gained files during the test run: ${newFiles.slice(0, 5).join(", ")}`);
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

  process.env.HOME = home;
  process.env.STAPLE_HOME = stapleHome;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.APPDATA = join(home, "AppData", "Roaming");
  project.provide("isolatedHome", { home, stapleHome });

  return () => {
    const changes = watched.flatMap((path, i) => describeChanges(path, before[i]!, snapshotHome(path, root)));
    rmSync(root, { recursive: true, force: true });
    if (changes.length > 0) {
      throw new Error(
        `The test run wrote to the operator's real staple home:\n  ${changes.join("\n  ")}\n` +
          "A test resolved the staple home through the default. Give it an explicit STAPLE_HOME.",
      );
    }
  };
}
