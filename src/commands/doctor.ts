/**
 * `staple doctor` — STA-24 plan §7.
 *
 * > "`staple doctor` is READ-ONLY. … Human output groups pass, warning, and
 * > failure results and ends with exact repair commands. `--json` returns a
 * > stable array of checks and a nonzero status when any required check fails.
 * > `doctor --fix` first runs diagnostics, previews each proposed repair, and
 * > applies only approved, idempotent fixes. It never merges databases, deletes
 * > rollback copies, edits harness configuration without naming the harness, or
 * > requests broader filesystem access."
 *
 * ## The read-only property, structurally
 *
 * Every check below is a function from the machine's state to a `CheckResult`.
 * None of them opens a database for writing, takes a lock, creates a probe file,
 * or repairs anything it finds. The repairs live in a separate map at the bottom
 * of this file and are reachable only through `--fix --only <id> --yes`, so
 * "doctor is read-only without --fix" is a property of the call graph rather
 * than a rule somebody has to remember.
 *
 * The one place that needed care is the UI bind check: there is no synchronous
 * way to ask "could I listen on this port", and this CLI is synchronous end to
 * end. It runs a throwaway `node -e` child that binds and immediately closes,
 * which touches no staple state and leaves nothing behind.
 *
 * ## The consent shape for --fix
 *
 * Plan's TTY matrix row: "Requires `--only <check-id>` and `--yes`; bare
 * `--fix --yes` is rejected." Both, and in that order — naming the check is how
 * the user says WHAT, and `--yes` is how they say YES. Neither implies the
 * other, and `--fix` alone previews.
 */
import { parseArgs } from "node:util";
import { spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, statSync, statfsSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { effectiveConfig, readConfig, resolveHome, setHomeOverride, stapleHome } from "../config/index.js";
import { Hub } from "../core/hub.js";
import { findRepointableRows } from "../core/hub-repair.js";
import {
  describeLayout,
  findMigrationRoot,
  journalPathFor,
  normalizePath,
  readJournal,
  resolveRollbackRequired,
  legacyDbPathFor,
  currentDbPathFor,
} from "../core/path-migration.js";
import { hubSchemaState, workspaceSchemaState } from "../core/schema.js";
import { findWorkspace } from "../core/workspace.js";
import { readMeta, snapshotPathFor } from "../core/open.js";
import { WorkspaceStore } from "../core/store.js";
import { StapleError } from "../core/types.js";
import {
  defaultBinDir,
  inspectSchemaFacts,
  installStatus,
  planSchemaRepair,
  verifyRuntimeAfterHomeMove,
} from "../install/index.js";
import { uiBundleExists, UI_DIST_DIR } from "../ui/server.js";

export type CheckStatus = "pass" | "warn" | "fail" | "skip";

export interface DoctorFixHandle {
  /** The `--only` token. Always equal to the check's own id. */
  id: string;
  description: string;
  /** The exact command, copy-pasteable, that applies it. */
  command: string;
}

/**
 * The stable shape. STA-37's acceptance criterion "Doctor JSON uses a stable
 * check result shape" is about this interface, and `doctor.test.ts` pins the key
 * set of every result so a field cannot quietly appear or vanish.
 */
export interface CheckResult {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  data: Record<string, unknown>;
  fix: DoctorFixHandle | null;
}

export interface DoctorReport {
  schemaVersion: 1;
  ok: boolean;
  summary: Record<CheckStatus, number>;
  checks: CheckResult[];
}

function result(
  id: string,
  title: string,
  status: CheckStatus,
  detail: string,
  data: Record<string, unknown> = {},
  fix: DoctorFixHandle | null = null,
): CheckResult {
  return { id, title, status, detail, data, fix };
}

/** Every check runs; one throwing must not hide the twelve after it. */
function guard(id: string, title: string, run: () => CheckResult): CheckResult {
  try {
    return run();
  } catch (error) {
    return result(id, title, "fail", `The check itself failed: ${message(error)}`, {
      unexpected: true,
    });
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Every database this file opens for a CHECK goes through one of these two.
 *
 * `openDb()` is the normal opener and it is not usable here: it issues
 * `PRAGMA journal_mode=WAL`, which writes to the file header, and `Hub.open()`
 * additionally runs `migrateHub()` — so a doctor built on either would stamp an
 * unstamped hub, silently repairing the very thing A4 asked it to WARN about.
 *
 * SQLite's read-only mode is what makes "doctor is read-only" a guarantee rather
 * than a claim: a write attempted through these handles fails.
 */
function readOnlyDb(path: string): DatabaseSync {
  return new DatabaseSync(path, { readOnly: true });
}

function hubPresent(): string | null {
  const path = join(stapleHome(), "hub.db");
  return existsSync(path) ? path : null;
}

// ---------------------------------------------------------------- the checks

function checkNodeRuntime(): CheckResult {
  const major = Number(process.versions.node.split(".")[0]);
  // node:sqlite is the hard floor: it is where staple stores everything, and it
  // is only present from 22.5 onward. If this module loaded at all it is there,
  // which is why the check reports rather than probes.
  const status = major >= 22 ? "pass" : "fail";
  return result(
    "node-runtime",
    "Node runtime",
    status,
    `Node ${process.versions.node} on ${process.platform}/${process.arch}; node:sqlite available.`,
    { node: process.versions.node, major, platform: process.platform },
  );
}

function checkHome(): CheckResult {
  const home = resolveHome();
  const exists = existsSync(home.path);
  // Probe the deepest existing ancestor: a home that has not been created yet is
  // normal, and asking whether it is writable means asking about its parent.
  let probe = home.path;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  let writable = true;
  let problem = "";
  try {
    accessSync(probe, constants.W_OK);
  } catch (error) {
    writable = false;
    problem = message(error);
  }
  return result(
    "home",
    "Machine home",
    writable ? "pass" : "fail",
    writable
      ? `${home.path} (${home.source})${exists ? "" : " — not created yet, which is fine"}`
      : `${home.path} (${home.source}) is not writable: ${problem}`,
    { path: home.path, source: home.source, exists, writable },
  );
}

/** Free space, without creating anything anywhere — `statfs` only reads. */
function checkHomeSpace(): CheckResult {
  const home = resolveHome().path;
  let probe = home;
  while (!existsSync(probe) && dirname(probe) !== probe) probe = dirname(probe);
  const stats = statfsSync(probe);
  const availableBytes = Number(stats.bavail) * Number(stats.bsize);
  const mb = Math.floor(availableBytes / 1_000_000);
  // 64 MB is not a requirement, it is a smell: staple's own files are tiny, so a
  // machine this full is about to fail at something else.
  const status = mb < 64 ? "warn" : "pass";
  return result(
    "home-space",
    "Disk space",
    status,
    `${mb} MB available on the filesystem holding ${probe}.`,
    { availableBytes, availableMb: mb, probed: probe },
  );
}

function checkConfig(): CheckResult {
  const home = resolveHome().path;
  try {
    const loaded = readConfig(home);
    if (loaded.unknownKeys.length > 0) {
      return result(
        "config",
        "Machine configuration",
        "warn",
        `${loaded.path} carries ${loaded.unknownKeys.join(", ")} — written by a newer staple and ` +
          "preserved unread. Upgrade staple before changing settings in this home.",
        { path: loaded.path, present: loaded.present, unknownKeys: loaded.unknownKeys },
      );
    }
    return result(
      "config",
      "Machine configuration",
      "pass",
      loaded.present ? `${loaded.path} parses and every key is known.` : `No ${loaded.path}; using defaults.`,
      { path: loaded.path, present: loaded.present, unknownKeys: [] },
    );
  } catch (error) {
    return result(
      "config",
      "Machine configuration",
      "fail",
      `The configuration in ${home} could not be read: ${message(error)}`,
      { path: home },
    );
  }
}

function checkLocator(): CheckResult {
  const config = effectiveConfig();
  const { locator, home } = config;
  if (!locator.present) {
    return result("locator", "Bootstrap locator", "pass", `No locator at ${locator.path}; home defaults apply.`, {
      path: locator.path,
      present: false,
    });
  }
  // The plan's edge case: "the locator is only consulted when STAPLE_HOME is
  // unset", so a locator that disagrees with an env-var home is a live trap —
  // the launcher and the shell will resolve two different homes.
  const disagrees = locator.home !== null && normalizePath(locator.home) !== normalizePath(home.value);
  return result(
    "locator",
    "Bootstrap locator",
    disagrees ? "warn" : "pass",
    disagrees
      ? `${locator.path} points at ${locator.home}, but the effective home is ${home.value} (${home.source}). ` +
        "An installed launcher resolves the locator, so it will use a different home than this shell."
      : `${locator.path} -> ${locator.home}`,
    { path: locator.path, present: true, locatorHome: locator.home, effectiveHome: home.value },
  );
}

function integrityOf(dbPath: string): string {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    return rows.map((r) => r.integrity_check).join("; ");
  } finally {
    db.close();
  }
}

function checkHubDatabase(): CheckResult {
  const path = join(stapleHome(), "hub.db");
  if (!existsSync(path)) {
    return result("hub-database", "Hub database", "pass", `No hub yet at ${path}; it is created on first init.`, {
      path,
      present: false,
    });
  }
  const verdict = integrityOf(path);
  if (verdict !== "ok") {
    return result("hub-database", "Hub database", "fail", `${path} failed integrity_check: ${verdict}`, {
      path,
      present: true,
      integrity: verdict,
    });
  }
  const db = readOnlyDb(path);
  try {
    const state = hubSchemaState(db);
    const data = { path, present: true, integrity: verdict, ...state };
    if (state.current > state.latest) {
      return result(
        "hub-database",
        "Hub database",
        "fail",
        `${path} is at schema version ${state.current}; this build understands ${state.latest}. Upgrade staple.`,
        data,
      );
    }
    /**
     * A4's handoff: `workspaceSchemaState`/`hubSchemaState` "return {current,
     * latest, pending, detection} read-only; surface `detection: 'unstamped'` as
     * a doctor warning."
     *
     * Unstamped means tables exist with no version row, so the runner is
     * ASSUMING version 1. That assumption is right for every database staple
     * ever wrote, and wrong the moment somebody restores a hand-built one — the
     * warning is what makes the assumption visible before a migration acts on it.
     */
    if (state.detection === "unstamped") {
      return result(
        "hub-database",
        "Hub database",
        "warn",
        `${path} has tables but no recorded schema version, so it is being treated as version 1. ` +
          `The next open stamps it. Pending migrations: ${state.pending.join(", ") || "none"}.`,
        data,
      );
    }
    return result(
      "hub-database",
      "Hub database",
      state.pending.length > 0 ? "warn" : "pass",
      state.pending.length > 0
        ? `${path} is at version ${state.current}; ${state.pending.join(", ")} will apply on the next open.`
        : `${path} is at version ${state.current} (${state.detection}), integrity ok.`,
      data,
    );
  } finally {
    db.close();
  }
}

function checkHubRegistrations(): CheckResult {
  const hubPath = join(stapleHome(), "hub.db");
  if (!existsSync(hubPath)) {
    return result("hub-registrations", "Hub registrations", "skip", `No hub yet at ${hubPath}.`, { path: hubPath });
  }
  let hub: Hub | null = null;
  try {
    hub = Hub.openReadOnly();
    const entries = hub.list();
    const missing = entries.filter((e) => !e.available).map((e) => ({ slug: e.slug, path: e.path }));
    const repointable = findRepointableRows(hub);

    // Two slugs, one file. The hub can hold one path per logical workspace, so
    // this is either two clones (the plan allows it, last opened wins) or a
    // genuine duplicate registration.
    const byPath = new Map<string, string[]>();
    for (const entry of entries) {
      const key = normalizePath(entry.path);
      byPath.set(key, [...(byPath.get(key) ?? []), entry.slug]);
    }
    const duplicates = [...byPath.entries()]
      .filter(([, slugs]) => slugs.length > 1)
      .map(([path, slugs]) => ({ path, slugs }));

    const data = {
      total: entries.length,
      missing,
      duplicates,
      repointable: repointable.map((r) => ({ slug: r.slug, stored: r.stored, normalized: r.normalized })),
    };

    if (duplicates.length > 0) {
      return result(
        "hub-registrations",
        "Hub registrations",
        "fail",
        `${duplicates.length} database path(s) are registered under more than one slug: ` +
          duplicates.map((d) => `${d.slugs.join(" + ")} -> ${d.path}`).join("; ") +
          ". Staple will not choose; unregister one with a fresh init in the directory you mean to keep.",
        data,
      );
    }
    if (repointable.length > 0) {
      return result(
        "hub-registrations",
        "Hub registrations",
        "warn",
        `${repointable.length} registration(s) store a non-canonical spelling of their path ` +
          `(${repointable.map((r) => r.slug).join(", ")}). Everything works, but path comparisons ` +
          "against them can fail — A1 recorded the /var vs /private/var double spelling this comes from.",
        data,
        {
          id: "hub-registrations",
          description: "Rewrite each stored path as its realpath. Nothing else changes.",
          command: "staple doctor --fix --only hub-registrations --yes",
        },
      );
    }
    if (missing.length > 0) {
      return result(
        "hub-registrations",
        "Hub registrations",
        "warn",
        `${missing.length} registered workspace(s) are not on this machine right now: ` +
          missing.map((m) => `${m.slug} (${m.path})`).join(", ") +
          ". That is normal for another machine's clone; it is a problem if the repository moved — " +
          "run `staple ls` inside it once and resolution will repair the row.",
        data,
      );
    }
    return result(
      "hub-registrations",
      "Hub registrations",
      "pass",
      `${entries.length} workspace(s) registered, all present and canonically spelled.`,
      data,
    );
  } finally {
    try {
      hub?.close();
    } catch {
      /* unwinding */
    }
  }
}

/** The current directory's workspace: layout, ambiguity, schema, identity. */
function checkWorkspace(dir: string): CheckResult {
  const found = (() => {
    try {
      return { workspace: findWorkspace(dir), error: null as StapleError | null };
    } catch (error) {
      return { workspace: null, error: error as StapleError };
    }
  })();

  if (found.error) {
    // A5's ambiguity refusal, surfaced rather than thrown. `doctor` exists to
    // explain this state, so it must not be stopped by it.
    return result(
      "workspace",
      "Current workspace",
      "fail",
      found.error.message,
      { dir, code: found.error.code, ambiguous: true },
    );
  }
  if (!found.workspace) {
    return result("workspace", "Current workspace", "skip", `No staple workspace at or above ${dir}.`, { dir });
  }

  const { dbPath, layout, root } = found.workspace;
  const db = readOnlyDb(dbPath);
  try {
    const state = workspaceSchemaState(db);
    const probe = new WorkspaceStore(db, "", "");
    const slug = readMeta(probe, "slug");
    const prefix = readMeta(probe, "prefix");
    const data = { dir, root, dbPath, layout, slug, prefix, ...state };

    if (!slug || !prefix) {
      return result(
        "workspace",
        "Current workspace",
        "fail",
        `${dbPath} has no slug/prefix metadata, so nothing can identify it. It is not a staple workspace ` +
          "this build wrote.",
        data,
      );
    }
    if (state.current > state.latest) {
      return result(
        "workspace",
        "Current workspace",
        "fail",
        `${dbPath} is at schema version ${state.current}; this build understands ${state.latest}. Upgrade staple.`,
        data,
      );
    }
    if (state.detection === "unstamped") {
      return result(
        "workspace",
        "Current workspace",
        "warn",
        `${dbPath} has tables but no recorded schema version, so it is being treated as version 1. ` +
          "The next open stamps it.",
        data,
      );
    }
    if (layout === "legacy") {
      return result(
        "workspace",
        "Current workspace",
        "warn",
        `"${slug}" (${prefix}) still stores its state in the legacy layout at ${dbPath}. ` +
          "It works; the compatibility window will not last forever.",
        data,
        {
          id: "workspace",
          description: "Not a doctor fix — path migration is its own journalled command.",
          command: "staple migrate --yes",
        },
      );
    }
    return result(
      "workspace",
      "Current workspace",
      "pass",
      `"${slug}" (${prefix}) at ${dbPath}, schema ${state.current}.`,
      data,
    );
  } finally {
    db.close();
  }
}

/**
 * Database schema vs runtime schema vs config schema, and the one command that
 * reconciles them (STA-164).
 *
 * The `workspace` check above says a newer file cannot be opened; this one says
 * BY WHICH runtime, names the other runtimes on the machine, and previews what
 * the next open would do to the file. The verdict and the command come from
 * `planSchemaRepair`, the same function the open refusal appends, so doctor
 * and the error a user just hit agree. `data.code` is the stable, machine-
 * readable reason; `data.repair` is the preview.
 */
function checkSchema(dir: string): CheckResult {
  let found;
  try {
    found = findWorkspace(dir);
  } catch {
    return result("schema", "Schema compatibility", "skip", "The current workspace does not resolve.", { dir });
  }
  if (!found) {
    return result("schema", "Schema compatibility", "skip", `No staple workspace at or above ${dir}.`, { dir });
  }

  const { dbPath } = found;
  const home = resolveHome().path;
  const facts = inspectSchemaFacts({ dbPath, home, binDir: defaultBinDir() });
  const plan = planSchemaRepair(facts);
  const { database, running, selected, config } = facts;
  // The real path carries the open's own timestamp and pid; this one shows the
  // directory and the naming, from the same function, so nothing is duplicated.
  const snapshotPath = plan.migration ? snapshotPathFor(dbPath, plan.migration.from, new Date()) : null;

  const data = {
    dbPath,
    database: { schema: database.current, detection: database.detection },
    running,
    selected,
    config,
    code: plan.code,
    repair: {
      command: plan.command,
      changesDatabase: plan.changesDatabase,
      migration: plan.migration,
      snapshotPath,
      rollback: plan.rollback,
    },
  };

  const lines = [
    `database  ${dbPath} is at schema ${database.current}`,
    `running   ${running.source} at ${running.path}${running.version ? ` (staple ${running.version})` : ""} ` +
      `understands ${running.workspaceSchema}`,
    selected
      ? `selected  staple ${selected.version} at ${selected.path} understands ` +
        `${selected.workspaceSchema ?? "(undeclared)"}; launcher ${selected.launcher}`
      : "selected  no installed runtime; the launcher selects nothing",
    `config    ${config.present ? `${config.path} is at schema ${config.schema ?? "(unstamped)"}` : `no ${config.path}`}` +
      `; this build understands ${config.understands}`,
    plan.migration
      ? `next open by the running build migrates ${plan.migration.from} -> ${plan.migration.to} after a ` +
        `verified snapshot to ${snapshotPath}`
      : "next open by the running build changes nothing in the database",
    plan.rollback
      ? `${plan.rollback} restores staple ${selected!.previousVersion} at ${selected!.previousVersionPath} ` +
        "without touching any database"
      : "no previous runtime is retained, so there is nothing to roll back to",
  ];
  const verdict = {
    database_newer_than_runtime: "This build cannot open the database.",
    config_newer_than_runtime: "This build cannot read the configuration without rewriting it.",
    selected_runtime_older_than_database: "The launcher's runtime cannot open the database this build can.",
    migration_pending: "A migration is pending.",
  };
  const status = plan.code === null ? "pass" : plan.code.endsWith("_newer_than_runtime") ? "fail" : "warn";
  const detail = [plan.code ? verdict[plan.code] : "Every schema agrees.", ...lines.map((l) => `    ${l}`)].join(
    "\n",
  );

  return result(
    "schema",
    "Schema compatibility",
    status,
    detail,
    data,
    plan.command
      ? {
          id: "schema",
          description: `Not a doctor fix — ${plan.description}`,
          command: plan.command,
        }
      : null,
  );
}

/** Does the hub agree with the workspace the current directory actually resolves to? */
function checkWorkspaceHubLink(dir: string): CheckResult {
  let found;
  try {
    found = findWorkspace(dir);
  } catch {
    return result("workspace-hub-link", "Hub link", "skip", "The current workspace does not resolve.", { dir });
  }
  if (!found) {
    return result("workspace-hub-link", "Hub link", "skip", `No staple workspace at or above ${dir}.`, { dir });
  }

  const db = readOnlyDb(found.dbPath);
  let slug: string | null;
  let prefix: string | null;
  try {
    const probe = new WorkspaceStore(db, "", "");
    slug = readMeta(probe, "slug");
    prefix = readMeta(probe, "prefix");
  } finally {
    db.close();
  }
  if (!slug || !prefix) {
    return result("workspace-hub-link", "Hub link", "skip", "The workspace has no identity to look up.", { dir });
  }

  if (!hubPresent()) {
    return result("workspace-hub-link", "Hub link", "skip", "No hub database yet.", { dir });
  }
  let hub: Hub | null = null;
  try {
    hub = Hub.openReadOnly();
    const entry = hub.findBySlug(slug);
    const here = normalizePath(found.dbPath);
    const data = { slug, prefix, dbPath: here, registeredPath: entry?.path ?? null };

    if (!entry) {
      return result(
        "workspace-hub-link",
        "Hub link",
        "warn",
        `"${slug}" is not registered in the hub. Local commands work; --ws and hub views cannot find it. ` +
          "Any command that resolves by walking up repairs this automatically.",
        data,
      );
    }
    if (entry.prefix !== prefix) {
      return result(
        "workspace-hub-link",
        "Hub link",
        "fail",
        `The hub registers "${slug}" with prefix ${entry.prefix}, but ${found.dbPath} is stamped ${prefix}. ` +
          "Staple will not renumber either one — two workspaces have collided on a slug. " +
          "Re-init one of them under a different --slug.",
        data,
      );
    }
    if (normalizePath(entry.path) !== here) {
      return result(
        "workspace-hub-link",
        "Hub link",
        "warn",
        `The hub points "${slug}" at ${entry.path}, but it resolves here to ${found.dbPath}. ` +
          "Normal resolution repairs this; if you are seeing it, the repair could not write to the hub.",
        data,
      );
    }
    return result("workspace-hub-link", "Hub link", "pass", `"${slug}" (${prefix}) -> ${entry.path}`, data);
  } finally {
    try {
      hub?.close();
    } catch {
      /* unwinding */
    }
  }
}

/**
 * Migration journals. Plan §3: "On startup, `init`, bare `staple`, and `doctor`
 * inspect the journal before normal resolution."
 */
function checkMigrationJournal(dir: string): CheckResult {
  const root = findMigrationRoot(dir);
  if (!root) {
    return result("migration-journal", "Migration journal", "skip", `No staple workspace at or above ${dir}.`, {
      dir,
    });
  }
  let journal;
  try {
    journal = readJournal(root);
  } catch (error) {
    // parseJournal refuses an unreadable journal rather than treating it as
    // absent, which is exactly right and exactly what doctor should report.
    return result(
      "migration-journal",
      "Migration journal",
      "fail",
      `${journalPathFor(root)} could not be read: ${message(error)}`,
      { root, path: journalPathFor(root) },
    );
  }
  if (!journal) {
    return result("migration-journal", "Migration journal", "pass", `No migration in flight at ${root}.`, { root });
  }

  const data = {
    root,
    path: journalPathFor(root),
    migrationId: journal.migrationId,
    state: journal.state,
    sourcePath: journal.sourcePath,
    targetPath: journal.targetPath,
    backupPath: journal.backupPath,
    hub: journal.hub,
  };

  if (journal.state === "complete") {
    const hubProblem = journal.hub.error;
    return result(
      "migration-journal",
      "Migration journal",
      hubProblem ? "warn" : "pass",
      hubProblem
        ? `Migration ${journal.migrationId} completed, but its hub repair did not: ${hubProblem}`
        : `Migration ${journal.migrationId} completed. The rollback copy at ${journal.backupPath} is ` +
          "retained until you delete it.",
      data,
    );
  }

  if (journal.state === "rollback_required") {
    /**
     * A5's handoff: "`rollback_required` is YOURS to clear via `doctor --fix` —
     * only an operator chooses between divergent histories."
     *
     * So the fix names both sides and demands one. `--keep legacy` is listed
     * first in the description because it is the conservative side: in every
     * state that records `rollback_required`, the legacy database is still
     * untouched and still canonical.
     */
    return result(
      "migration-journal",
      "Migration journal",
      "fail",
      `Migration ${journal.migrationId} failed after installing ${journal.targetPath} and needs a decision.\n` +
        `    new     ${journal.targetPath}${existsSync(journal.targetPath) ? "" : "  (MISSING)"}\n` +
        `    legacy  ${journal.sourcePath}${existsSync(journal.sourcePath) ? "  (untouched)" : "  (MISSING)"}\n` +
        `    journal ${journalPathFor(root)}\n` +
        "    Staple will not choose between them. Inspect both, then name the one you keep.",
      data,
      {
        id: "migration-journal",
        description:
          "Keep one side and move the other aside. Neither database is ever deleted. " +
          "--keep legacy is the conservative choice: the legacy database is untouched in this state.",
        command: "staple doctor --fix --only migration-journal --yes --keep legacy|new",
      },
    );
  }

  return result(
    "migration-journal",
    "Migration journal",
    "fail",
    `Migration ${journal.migrationId} was interrupted at "${journal.state}" and has not finished. ` +
      "Nothing will open this workspace until it does.",
    data,
    {
      id: "migration-journal",
      description: "Not a doctor fix — resuming is the migration runner's own job, and it is idempotent.",
      command: "staple migrate --yes",
    },
  );
}

/**
 * Databases sitting in the resolved repository that the hub does not know about.
 *
 * Bounded to ONE directory on purpose. A1's quirk #7 describes how these appear:
 * "`staple init` in a second directory whose basename slugifies to an
 * already-registered slug FAILS with exit 4 conflict — but only AFTER it has
 * created and stamped the second database on disk", leaving a real unregistered
 * workspace behind. Finding those in general is a SCAN, which is `staple
 * discover`'s job and needs an explicit root; doctor looks only where it already
 * is, and never asks for broader filesystem access (plan §7).
 */
function checkOrphanWorkspaces(dir: string): CheckResult {
  const layout = describeLayout(dir);
  const candidates = [
    { path: currentDbPathFor(dir), layout: "current" as const, present: layout.currentPresent },
    { path: legacyDbPathFor(dir), layout: "legacy" as const, present: layout.legacyPresent },
  ].filter((c) => c.present);

  if (candidates.length === 0) {
    return result("orphan-workspaces", "Unregistered databases", "skip", `No database in ${dir} itself.`, { dir });
  }

  let hub: Hub | null = null;
  try {
    const registered = new Set<string>();
    if (hubPresent()) {
      hub = Hub.openReadOnly();
      for (const entry of hub.list()) registered.add(normalizePath(entry.path));
    }
    const orphans: Array<{ path: string; slug: string | null; prefix: string | null }> = [];
    for (const candidate of candidates) {
      if (registered.has(normalizePath(candidate.path))) continue;
      const db = readOnlyDb(candidate.path);
      try {
        const probe = new WorkspaceStore(db, "", "");
        orphans.push({
          path: candidate.path,
          slug: readMeta(probe, "slug"),
          prefix: readMeta(probe, "prefix"),
        });
      } finally {
        db.close();
      }
    }
    if (orphans.length === 0) {
      return result("orphan-workspaces", "Unregistered databases", "pass", `Every database in ${dir} is registered.`, {
        dir,
        checked: candidates.map((c) => c.path),
      });
    }
    return result(
      "orphan-workspaces",
      "Unregistered databases",
      "warn",
      `${orphans.length} database(s) here are not in the hub: ` +
        orphans.map((o) => `${o.path} (${o.slug ?? "no slug"}/${o.prefix ?? "no prefix"})`).join(", ") +
        ". A failed init leaves these behind. Run `staple init` here to register it, or delete it.",
      { dir, orphans },
    );
  } finally {
    try {
      hub?.close();
    } catch {
      /* unwinding */
    }
  }
}

/**
 * Can the UI bind its configured port?
 *
 * A child process, because there is no synchronous bind API and this CLI's
 * synchronous top-level error contract is load-bearing. The child creates a
 * server on loopback, closes it immediately, and touches no staple state — so
 * this stays inside plan §7's "without creating test files".
 */
function checkUiPort(): CheckResult {
  const port = effectiveConfig().settings.port.value;
  const probe = `const s=require("net").createServer();s.on("error",e=>{console.log(e.code);process.exit(0)});s.listen(${port},"127.0.0.1",()=>{s.close(()=>{console.log("ok");process.exit(0)})});`;
  const child = spawnSync(process.execPath, ["-e", probe], { encoding: "utf8", timeout: 5_000 });
  const verdict = (child.stdout ?? "").trim();
  if (verdict === "ok") {
    return result("ui-port", "UI port", "pass", `127.0.0.1:${port} is free.`, { port, code: null });
  }
  if (verdict === "EADDRINUSE") {
    return result(
      "ui-port",
      "UI port",
      "warn",
      `127.0.0.1:${port} is in use. An implicit \`staple open\` will take a free port instead; an ` +
        "explicit `--port` on this number will fail.",
      { port, code: verdict },
    );
  }
  return result(
    "ui-port",
    "UI port",
    verdict === "" ? "warn" : "fail",
    verdict === ""
      ? `Could not probe 127.0.0.1:${port}.`
      : `127.0.0.1:${port} cannot be bound: ${verdict}.`,
    { port, code: verdict || null },
  );
}

/**
 * The installed runtime and launcher.
 *
 * A8's handoff: "Pass `restoreOnFailure:false` + `throwOnFailure:false` for a
 * doctor-style read-only audit." Both, so this check cannot write the bootstrap
 * locator and cannot abort the run. `from` and `to` are the same home because
 * nothing is moving — this is an audit of where the runtime already is.
 */
function checkRuntime(): CheckResult {
  const home = resolveHome().path;
  const status = installStatus({ home, binDir: defaultBinDir() });
  if (!status.installed) {
    return result(
      "runtime",
      "Installed runtime",
      "skip",
      `No staple runtime installed under ${home}. Running from a source checkout or via npx is fine.`,
      { home, installed: false },
    );
  }
  const audit = verifyRuntimeAfterHomeMove({
    from: home,
    to: home,
    restoreOnFailure: false,
    throwOnFailure: false,
  });
  const data = {
    home,
    installed: true,
    version: status.version,
    // What the selected runtime can open, from its payload's declaration. This
    // build's own `WORKSPACE_SCHEMA_VERSION` is a different number whenever
    // doctor runs from a checkout, which is why it is reported and not assumed.
    workspaceSchema: status.workspaceSchema,
    previousVersion: status.previousVersion,
    previousVersionPath: status.previousVersionPath,
    entrypoint: status.entrypoint,
    launcher: status.launcher.path,
    verifiedVersions: audit.verifiedVersions,
    problems: audit.problems,
  };
  if (!audit.ok) {
    return result(
      "runtime",
      "Installed runtime",
      "fail",
      `staple ${status.version} at ${status.runtimeDir} does not verify: ${audit.problems.join("; ")}`,
      data,
    );
  }
  return result(
    "runtime",
    "Installed runtime",
    "pass",
    `staple ${status.version} verifies; launcher ${status.launcher.path} resolves this home. ` +
      `It understands workspace schema ${status.workspaceSchema ?? "(undeclared)"}. ` +
      `Rollback target: ${status.previousVersion ?? "(none)"}` +
      `${status.previousVersionPath ? ` at ${status.previousVersionPath}` : ""}.`,
    data,
  );
}

function checkUiAssets(): CheckResult {
  const built = uiBundleExists();
  return result(
    "ui-assets",
    "UI bundle",
    built ? "pass" : "warn",
    built
      ? `Built, at ${UI_DIST_DIR}.`
      : `Not built. \`staple open\` serves a placeholder page until \`npm run build:ui\` runs. Expected ${UI_DIST_DIR}.`,
    { path: UI_DIST_DIR, built },
  );
}

function checkHarnesses(): CheckResult {
  // Plan §7 lists "Harness entries against the connector's expected command",
  // and plan §5 gives connectors their own modules — which STA-25 / B1-B4 owns
  // and has not built. Reported as `skip` with the reason rather than omitted,
  // so the check list is stable across the epic and B1 has a slot to fill.
  const connectors = effectiveConfig().connectors;
  return result(
    "harnesses",
    "Harness connectors",
    "skip",
    "No connectors are implemented yet (STA-25 / B1-B4). Any receipts already in config are listed, unverified.",
    { receipts: Object.keys(connectors) },
  );
}

// ------------------------------------------------------------------ the run

export function runDiagnostics(options: { dir?: string } = {}): DoctorReport {
  const dir = options.dir ?? process.cwd();
  const checks: CheckResult[] = [
    guard("node-runtime", "Node runtime", checkNodeRuntime),
    guard("home", "Machine home", checkHome),
    guard("home-space", "Disk space", checkHomeSpace),
    guard("config", "Machine configuration", checkConfig),
    guard("locator", "Bootstrap locator", checkLocator),
    guard("hub-database", "Hub database", checkHubDatabase),
    guard("hub-registrations", "Hub registrations", checkHubRegistrations),
    guard("workspace", "Current workspace", () => checkWorkspace(dir)),
    guard("schema", "Schema compatibility", () => checkSchema(dir)),
    guard("workspace-hub-link", "Hub link", () => checkWorkspaceHubLink(dir)),
    guard("migration-journal", "Migration journal", () => checkMigrationJournal(dir)),
    guard("orphan-workspaces", "Unregistered databases", () => checkOrphanWorkspaces(dir)),
    guard("ui-port", "UI port", checkUiPort),
    guard("runtime", "Installed runtime", checkRuntime),
    guard("ui-assets", "UI bundle", checkUiAssets),
    guard("harnesses", "Harness connectors", checkHarnesses),
  ];

  const summary: Record<CheckStatus, number> = { pass: 0, warn: 0, fail: 0, skip: 0 };
  for (const check of checks) summary[check.status] += 1;

  return { schemaVersion: 1, ok: summary.fail === 0, summary, checks };
}

// --------------------------------------------------------------- the repairs

export interface FixOutcome {
  id: string;
  changed: boolean;
  detail: string;
  data: Record<string, unknown>;
}

/**
 * The complete set of things `--fix` can do. Anything not in this map is not
 * repairable by doctor, by construction.
 *
 * Each one is idempotent: running it twice is running it once, and running it
 * when the check already passes is a no-op that says so. Plan §7: doctor "never
 * merges databases, deletes rollback copies, edits harness configuration
 * without naming the harness, or requests broader filesystem access" — none of
 * the two below does any of those, and there is no third.
 */
const FIXES: Record<
  string,
  (context: { dir: string; keep?: "new" | "legacy" }) => FixOutcome
> = {
  /**
   * Rewrite every stored hub path as its realpath.
   *
   * A5's handoff: "A5 repaired exactly one hub row … the general repair is
   * yours." This is it. Narrow by design — it repoints rows whose spelling is
   * non-canonical, and it does NOT go looking for a repository that moved.
   * Guessing where a workspace went is how a hub row ends up pointing at
   * somebody else's database.
   */
  "hub-registrations": () => {
    let hub: Hub | null = null;
    try {
      hub = Hub.open();
      const rows = findRepointableRows(hub);
      const repointed: Array<{ slug: string; from: string; to: string }> = [];
      const skipped: Array<{ slug: string; path: string; reason: string }> = [];
      for (const row of rows) {
        if (!row.resolvable) {
          skipped.push({
            slug: row.slug,
            path: row.stored,
            reason: "neither the stored path nor its realpath exists on this machine",
          });
          continue;
        }
        const entry = hub.findBySlug(row.slug);
        if (!entry) continue;
        hub.repointPath({
          slug: row.slug,
          prefix: row.prefix,
          path: row.normalized,
          kind: entry.kind,
        });
        repointed.push({ slug: row.slug, from: row.stored, to: row.normalized });
      }
      return {
        id: "hub-registrations",
        changed: repointed.length > 0,
        detail:
          repointed.length === 0
            ? "Every registration already stores a canonical path; nothing to do."
            : `Repointed ${repointed.length} registration(s): ` +
              repointed.map((r) => `${r.slug} ${r.from} -> ${r.to}`).join("; "),
        data: { repointed, skipped },
      };
    } finally {
      try {
        hub?.close();
      } catch {
        /* unwinding */
      }
    }
  },

  /** Clear `rollback_required` by carrying out the side the operator named. */
  "migration-journal": ({ dir, keep }) => {
    const root = findMigrationRoot(dir);
    if (!root) {
      throw new StapleError("not_found", `No staple workspace at or above ${dir}.`);
    }
    if (keep !== "new" && keep !== "legacy") {
      throw new StapleError(
        "validation",
        "Resolving a failed migration means choosing which database is the real one, and staple will " +
          "not choose for you. Re-run with --keep legacy (the untouched database, the conservative " +
          "choice) or --keep new (the migration's output). Neither is deleted; the other is moved aside.",
      );
    }
    const resolution = resolveRollbackRequired(root, keep);
    return {
      id: "migration-journal",
      changed: true,
      detail:
        `Kept the ${keep} database at ${resolution.canonicalPath}` +
        (resolution.movedAside ? `; the other was moved to ${resolution.movedAside}` : "") +
        `. Journal ${resolution.journalPath} is now complete.`,
      data: { ...resolution },
    };
  },
};

export const FIXABLE_CHECKS = Object.keys(FIXES);

// ---------------------------------------------------------------- rendering

const GLYPH: Record<CheckStatus, string> = { pass: "✓", warn: "!", fail: "✗", skip: "–" };

function printReport(report: DoctorReport): void {
  // Grouped, per plan §7: "Human output groups pass, warning, and failure
  // results and ends with exact repair commands."
  for (const status of ["fail", "warn", "pass", "skip"] as const) {
    const group = report.checks.filter((c) => c.status === status);
    if (group.length === 0) continue;
    console.log(`\n${status.toUpperCase()}`);
    for (const check of group) {
      console.log(`  ${GLYPH[status]} ${check.id.padEnd(20)} ${check.detail}`);
    }
  }

  const repairs = report.checks.filter((c) => c.fix !== null);
  if (repairs.length > 0) {
    console.log("\nREPAIRS");
    for (const check of repairs) {
      console.log(`  ${check.fix!.description}`);
      console.log(`    ${check.fix!.command}`);
    }
  }

  console.log(
    `\n${report.summary.pass} passed, ${report.summary.warn} warning(s), ` +
      `${report.summary.fail} failure(s), ${report.summary.skip} skipped.`,
  );
}

// ----------------------------------------------------------------- the command

export function runDoctorCommand(argv: string[]): void {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean" },
      fix: { type: "boolean" },
      only: { type: "string" },
      yes: { type: "boolean" },
      keep: { type: "string" },
      dir: { type: "string" },
      // The plan gives --home to the configuration and diagnostic commands, and
      // doctor is the diagnostic one.
      home: { type: "string" },
    },
  });

  // Same seam `config` and `install` use.
  if (values.home !== undefined) setHomeOverride(values.home);

  const dir = values.dir ?? process.cwd();
  const report = runDiagnostics({ dir });

  // Diagnostics ALWAYS run first, including under --fix. Plan §7: "`doctor
  // --fix` FIRST RUNS DIAGNOSTICS, previews each proposed repair, and applies
  // only approved, idempotent fixes."
  if (!values.fix) {
    if (values.json) {
      console.log(JSON.stringify(report));
    } else {
      printReport(report);
    }
    // "a nonzero status when any required check fails"
    if (!report.ok) process.exitCode = 1;
    return;
  }

  /**
   * The consent gate, in the plan's exact shape: "Requires `--only <check-id>`
   * and `--yes`; bare `--fix --yes` is rejected."
   *
   * `--only` without `--yes` is a PREVIEW, not an error: showing someone what a
   * repair would do is the step that makes their `--yes` meaningful.
   */
  if (values.only === undefined) {
    throw new StapleError(
      "validation",
      "`--fix` repairs one named check at a time. Bare `--fix` is refused, with or without `--yes`.\n" +
        `  Repairable checks: ${FIXABLE_CHECKS.join(", ")}\n` +
        "  staple doctor --fix --only <check-id> --yes",
    );
  }
  const fix = FIXES[values.only];
  if (!fix) {
    throw new StapleError(
      "validation",
      `"${values.only}" is not a repairable check. Repairable: ${FIXABLE_CHECKS.join(", ")}.`,
    );
  }

  const check = report.checks.find((c) => c.id === values.only);
  if (check && check.status === "pass") {
    const detail = `${values.only} already passes; there is nothing to repair.`;
    if (values.json) console.log(JSON.stringify({ id: values.only, changed: false, detail, data: {} }));
    else console.log(detail);
    return;
  }

  if (!values.yes) {
    const preview = {
      id: values.only,
      wouldFix: check?.detail ?? "(check did not run for this directory)",
      repair: check?.fix?.description ?? "See `staple doctor` for what this repairs.",
      command: check?.fix?.command ?? `staple doctor --fix --only ${values.only} --yes`,
      changed: false,
    };
    // The preview IS the payload of the refusal, the same shape `install` uses,
    // so a --json caller reads the plan off the error path rather than needing a
    // second differently-shaped command.
    throw new StapleError(
      "validation",
      `Refusing to repair without --yes.\n` +
        `  check   ${values.only}\n` +
        `  found   ${preview.wouldFix.split("\n")[0]}\n` +
        `  repair  ${preview.repair}\n` +
        `Re-run with --yes.`,
      preview,
    );
  }

  const keep = values.keep;
  if (keep !== undefined && keep !== "new" && keep !== "legacy") {
    throw new StapleError("validation", `--keep must be "new" or "legacy", got "${keep}".`);
  }
  const outcome = fix({ dir, keep });

  if (values.json) {
    console.log(JSON.stringify(outcome));
    return;
  }
  console.log(outcome.detail);
}
