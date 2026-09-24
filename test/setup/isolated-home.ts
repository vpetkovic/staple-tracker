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
 *   1. The real home is recorded, and the hub it resolves to is SNAPSHOTTED: whether it
 *      exists, its schema version, its tables, and its registered workspace paths.
 *   2. `HOME`, `STAPLE_HOME` and the locator variables are pointed at a directory private
 *      to this run, and handed to every worker (`isolatedHome`, applied again per file by
 *      `test/setup/isolate-env.ts`, so a worker that did not inherit the environment
 *      still cannot reach the real home).
 *   3. At teardown the snapshot is taken again, and the run FAILS if the real hub was
 *      created, migrated, or gained a workspace registered under the temp directory.
 *
 * Why not compare mtimes: on the machines this suite runs on, live agents write the real
 * hub while the suite runs (a `done` notifies it), so an mtime check would fail runs that
 * did nothing wrong. What a test run can do to a hub, and what the guard looks for, is
 * create it, migrate it, or register a scratch workspace in it.
 */
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
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
}

/** Read-only: SQLite's own read-only mode, so taking the snapshot cannot write the file. */
export function snapshotHub(path: string, scratchRoot: string): HubSnapshot {
  if (!existsSync(path)) return { exists: false, schemaVersion: null, tables: [], scratchWorkspaces: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
    const version = tables.includes("meta")
      ? ((db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string } | undefined)?.value ?? null)
      : null;
    const scratchWorkspaces = tables.includes("workspaces")
      ? (db.prepare("SELECT path FROM workspaces").all() as Array<{ path: string }>)
          .map((r) => r.path)
          .filter((p) => p.startsWith(scratchRoot) || p.startsWith(tmpdir()))
          .sort()
      : [];
    return { exists: true, schemaVersion: version, tables, scratchWorkspaces };
  } finally {
    db.close();
  }
}

/** Every hub the operator's environment can resolve to: `STAPLE_HOME`, else `~/.staple`. */
export function realHubPaths(env: NodeJS.ProcessEnv, home: string): string[] {
  const paths = new Set<string>([join(home, ".staple", "hub.db")]);
  if (env.STAPLE_HOME) paths.add(join(env.STAPLE_HOME, "hub.db"));
  return [...paths];
}

export function describeChange(path: string, before: HubSnapshot, after: HubSnapshot): string | null {
  if (!before.exists && after.exists) return `${path} was CREATED by the test run`;
  if (before.schemaVersion !== after.schemaVersion) return `${path} was MIGRATED from schema ${before.schemaVersion} to ${after.schemaVersion} by the test run`;
  if (before.tables.join(",") !== after.tables.join(",")) return `${path} gained or lost tables during the test run: ${after.tables.join(", ")}`;
  const added = after.scratchWorkspaces.filter((p) => !before.scratchWorkspaces.includes(p));
  if (added.length > 0) return `${path} registered scratch workspaces during the test run: ${added.join(", ")}`;
  return null;
}

export default function setup(project: TestProject): () => void {
  const realHome = homedir();
  const watched = realHubPaths(process.env, realHome);

  const root = realpathSync(mkdtempSync(join(tmpdir(), `staple-test-home-${process.pid}-`)));
  const home = join(root, "home");
  const stapleHome = join(home, ".staple");
  mkdirSync(stapleHome, { recursive: true });
  const before = watched.map((path) => snapshotHub(path, root));

  process.env.HOME = home;
  process.env.STAPLE_HOME = stapleHome;
  process.env.XDG_CONFIG_HOME = join(home, ".config");
  process.env.APPDATA = join(home, "AppData", "Roaming");
  project.provide("isolatedHome", { home, stapleHome });

  return () => {
    const changes = watched
      .map((path, i) => describeChange(path, before[i]!, snapshotHub(path, root)))
      .filter((c): c is string => c !== null);
    rmSync(root, { recursive: true, force: true });
    if (changes.length > 0) {
      throw new Error(
        `The test run wrote to the operator's real staple home:\n  ${changes.join("\n  ")}\n` +
          "A test resolved the hub through the default home. Give it an explicit STAPLE_HOME.",
      );
    }
  };
}
