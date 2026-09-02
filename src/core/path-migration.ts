/**
 * Repository path migration: `.tasks/tasks.db` -> `.staple/staple.db`.
 *
 * STA-24 plan §3. The risk this module exists to prevent is named in the plan's
 * risk register: "An unsafe `.tasks` migration could fork one workspace into two
 * writable databases." Every design choice below serves that one sentence —
 * a write barrier so nothing commits into the source after the snapshot, a
 * persistent journal so a crash is resumable rather than ambiguous, an atomic
 * cutover so no reader ever sees a half-installed target, and retirement of the
 * legacy file so two canonical paths cannot coexist afterwards.
 *
 * This is NOT a schema migration. Numbered schema migrations live in
 * `./migrations/` and are consumed here (the snapshot is upgraded through the
 * same tested runner every other open uses); they answer "what shape is this
 * database", while this module answers "which file is this workspace".
 *
 * ## Why `VACUUM INTO` and not checkpoint-then-copy
 *
 * The plan says "checkpoint committed WAL frames and create a SQLite-consistent
 * snapshot ... Never copy a live `.db` file and guess about `-wal` or `-shm`
 * sidecars." Measured against `node:sqlite` while a barrier connection holds
 * `BEGIN IMMEDIATE` on the source:
 *
 *   - `VACUUM INTO` on the barrier connection      -> "cannot VACUUM from within a transaction"
 *   - `PRAGMA wal_checkpoint(TRUNCATE)` on it      -> "database table is locked"
 *   - `VACUUM INTO` from a SECOND connection       -> OK, and the snapshot contains
 *                                                    rows a third connection committed
 *                                                    to the WAL and never checkpointed
 *   - any write from a third connection            -> refused, SQLITE_BUSY
 *
 * So the snapshot is taken by a second connection reading *through* the WAL.
 * That removes the sidecar question entirely rather than answering it, which is
 * what the plan actually wanted.
 *
 * One consequence drives the validation strategy: `VACUUM INTO` defragments, so
 * the snapshot is not byte-identical to the source. Validation compares row
 * counts and `PRAGMA table_info` sets — never file bytes, and never
 * `sqlite_master` text, because A4 recorded that schema version 2 shipped as two
 * physical layouts (`comments.idempotency_key` declared inline by the old
 * fresh-create path, appended by `ALTER TABLE` on an upgraded database). The
 * journalled SHA-256 is of the snapshot, and is only ever compared against that
 * same file later.
 */
import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, parse as parsePath, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { writeFileAtomic } from "../config/atomic.js";
import { openDb } from "./db.js";
import { migrateWorkspace, workspaceSchemaState } from "./schema.js";
import { WorkspaceStore } from "./store.js";
import { openWorkspace, readMeta } from "./open.js";
import { Hub } from "./hub.js";
import { StapleError, nowIso } from "./types.js";

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/** Current repository layout (plan: "Repository database | `.staple/staple.db`"). */
export const WORKSPACE_DIRNAME = ".staple";
export const WORKSPACE_DBNAME = "staple.db";

/** Pre-migration layout. Still discovered during the compatibility window. */
export const LEGACY_WORKSPACE_DIRNAME = ".tasks";
export const LEGACY_WORKSPACE_DBNAME = "tasks.db";

export const MIGRATION_JOURNAL_FILENAME = "migration.json";

/** Which of the two canonical paths a resolved workspace came from. */
export type WorkspaceLayout = "current" | "legacy";

export function currentDbPathFor(root: string): string {
  return join(root, WORKSPACE_DIRNAME, WORKSPACE_DBNAME);
}

export function legacyDbPathFor(root: string): string {
  return join(root, LEGACY_WORKSPACE_DIRNAME, LEGACY_WORKSPACE_DBNAME);
}

export function journalPathFor(root: string): string {
  return join(root, WORKSPACE_DIRNAME, MIGRATION_JOURNAL_FILENAME);
}

// ---------------------------------------------------------------------------
// Path normalisation
// ---------------------------------------------------------------------------

/**
 * Realpath-normalise, tolerating a path that does not exist.
 *
 * A1 recorded (quirk #6) that the hub stores macOS paths in two spellings: a
 * repo path arrives through `resolve(process.cwd())` and is realpath-resolved to
 * `/private/var/...`, while a `--global` path is built from `STAPLE_HOME`
 * verbatim and stays `/var/...`. Those are the same file. Any comparison
 * between a hub row and a path we computed ourselves has to normalise, or the
 * migration silently fails to find the row it is meant to repair and leaves the
 * hub pointing at a file that no longer exists.
 *
 * `realpathSync` throws for a path that is not there — and a stale hub row
 * pointing at a moved repository is exactly the case we must still be able to
 * compare. So resolve the deepest ancestor that does exist and re-join the rest.
 */
export function normalizePath(path: string): string {
  const absolute = resolve(path);
  let probe = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      return tail.length === 0 ? realpathSync.native(probe) : join(realpathSync.native(probe), ...tail);
    } catch {
      const parent = dirname(probe);
      if (parent === probe) return absolute; // reached the root without an existing ancestor
      tail.unshift(parsePath(probe).base);
      probe = parent;
    }
  }
}

/** True when two paths name the same file on disk (device + inode), not merely equal strings. */
function sameFile(a: string, b: string): boolean {
  try {
    const sa = statSync(a);
    const sb = statSync(b);
    return sa.dev === sb.dev && sa.ino === sb.ino;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Journal
// ---------------------------------------------------------------------------

/**
 * Journal states, in order. Plan §3: "Persist and fsync each transition before
 * the next external change." The whole point is that recovery reads a fact
 * somebody wrote down, never an inference — the plan is explicit that recovery
 * must "never infer recovery from modification times".
 */
export const JOURNAL_STATES = [
  "planned",
  "locked",
  "snapshotted",
  "target_installed",
  "hub_repaired",
  "complete",
  "rollback_required",
] as const;
export type JournalState = (typeof JOURNAL_STATES)[number];

export interface MigrationJournal {
  schemaVersion: 1;
  migrationId: string;
  state: JournalState;
  sourcePath: string;
  targetPath: string;
  snapshotPath: string;
  backupPath: string;
  source: {
    slug: string;
    prefix: string;
    schemaVersion: number;
    /** Stable file identity, so a resume can prove it is looking at the same file. */
    identity: { dev: number; ino: number };
    rowCounts: Record<string, number>;
  };
  snapshotSha256: string | null;
  hub: { pathBefore: string | null; pathAfter: string | null; error: string | null };
  createdAt: string;
  updatedAt: string;
  history: Array<{ state: JournalState; at: string }>;
}

function isJournalState(value: unknown): value is JournalState {
  return typeof value === "string" && (JOURNAL_STATES as readonly string[]).includes(value);
}

/**
 * Parse a journal. A journal we cannot read is not "no journal" — it is a
 * blocked state, because the only thing that writes one is an in-flight or
 * crashed migration and guessing past it is exactly the fork we are preventing.
 */
export function parseJournal(text: string): MigrationJournal {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new StapleError(
      "conflict",
      `The migration journal is not valid JSON (${error instanceof Error ? error.message : String(error)}). ` +
        "Staple will not guess which database is canonical — run `staple migrate` for the recovery report.",
    );
  }
  const journal = raw as Partial<MigrationJournal>;
  if (journal?.schemaVersion !== 1) {
    throw new StapleError(
      "conflict",
      `Unsupported migration journal version ${String(journal?.schemaVersion)}; this build understands version 1.`,
    );
  }
  if (!isJournalState(journal.state)) {
    throw new StapleError("conflict", `Unknown migration journal state ${JSON.stringify(journal.state)}.`);
  }
  return journal as MigrationJournal;
}

export function readJournal(root: string): MigrationJournal | null {
  const path = journalPathFor(root);
  if (!existsSync(path)) return null;
  return parseJournal(readFileSync(path, "utf8"));
}

/**
 * Test-only crash injection.
 *
 * `STAPLE_MIGRATE_CRASH_AT=<state>` SIGKILLs the process the instant that
 * transition is durable. It has to be a real signal, not a thrown error: a
 * throw unwinds through `finally`, releases the SQLite barrier and closes
 * handles, which is the opposite of the crash we need to prove recoverable.
 * SIGKILL leaves the journal, the temporary snapshot and the operating system's
 * own lock release exactly as a killed harness or an OOM would.
 */
function maybeCrash(state: JournalState): void {
  if (process.env.STAPLE_MIGRATE_CRASH_AT === state) {
    process.kill(process.pid, "SIGKILL");
  }
}

function writeJournal(root: string, journal: MigrationJournal): MigrationJournal {
  const next: MigrationJournal = { ...journal, updatedAt: nowIso() };
  // 0644, not writeFileAtomic's 0600 default: this is repository state that sits
  // beside a 0644 database, not a machine secret, and a journal a second user
  // cannot read is a journal that cannot be diagnosed.
  writeFileAtomic(journalPathFor(root), `${JSON.stringify(next, null, 2)}\n`, { mode: 0o644 });
  return next;
}

function transition(root: string, journal: MigrationJournal, state: JournalState): MigrationJournal {
  const next = writeJournal(root, {
    ...journal,
    state,
    history: [...journal.history, { state, at: nowIso() }],
  });
  maybeCrash(state);
  return next;
}

// ---------------------------------------------------------------------------
// Layout report
// ---------------------------------------------------------------------------

export interface LayoutReport {
  root: string;
  currentPath: string;
  legacyPath: string;
  currentPresent: boolean;
  legacyPresent: boolean;
  /** True when the two paths resolve to one file (a symlinked or hardlinked `.staple`). */
  aliased: boolean;
  journal: MigrationJournal | null;
  /** Resolved layout, or null when neither path exists or the state is ambiguous. */
  layout: WorkspaceLayout | null;
  ambiguous: boolean;
}

/**
 * Describe one directory's staple layout. Reads only; never opens a database.
 *
 * The journal is consulted only when both canonical paths are present, which is
 * the sole state where it changes the answer: a duality a journal explains is a
 * resumable migration, and a duality nothing explains is a forked workspace.
 */
export function describeLayout(root: string): LayoutReport {
  const currentPath = currentDbPathFor(root);
  const legacyPath = legacyDbPathFor(root);
  const currentPresent = existsSync(currentPath);
  const legacyPresent = existsSync(legacyPath);
  const aliased = currentPresent && legacyPresent && sameFile(currentPath, legacyPath);
  const journal = currentPresent && legacyPresent ? readJournal(root) : null;

  let layout: WorkspaceLayout | null = null;
  if (currentPresent && (!legacyPresent || aliased)) layout = "current";
  else if (legacyPresent && !currentPresent) layout = "legacy";

  return {
    root,
    currentPath,
    legacyPath,
    currentPresent,
    legacyPresent,
    aliased,
    journal,
    layout,
    ambiguous: currentPresent && legacyPresent && !aliased,
  };
}

/**
 * Walk up for the directory a migration would act on.
 *
 * Unlike {@link describeLayout} this also stops at a directory that has only a
 * journal — a migration crashed after installing the target and before anything
 * else would be the one case where recovery matters most, and refusing to find
 * it because the layout looks tidy would strand the operator.
 */
export function findMigrationRoot(startDir: string): string | null {
  let dir = resolve(startDir);
  for (let hops = 0; hops < 64; hops += 1) {
    if (
      existsSync(currentDbPathFor(dir)) ||
      existsSync(legacyDbPathFor(dir)) ||
      existsSync(journalPathFor(dir))
    ) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/**
 * Refuse a workspace that has two canonical databases.
 *
 * Plan §3: "If both canonical paths exist, never pick one by modification time.
 * ... Otherwise stop with an ambiguity error and list both files." The error
 * lists both absolute paths deliberately — the operator is the only party who
 * knows which history is the real one, and they cannot decide without the paths.
 */
export function assertResolvable(report: LayoutReport): void {
  if (!report.ambiguous) return;

  const journal = report.journal;
  if (journal && journal.state !== "complete" && journal.state !== "rollback_required") {
    throw new StapleError(
      "conflict",
      `A path migration of this workspace was interrupted at "${journal.state}" and both databases are still present:\n` +
        `  new    ${report.currentPath}\n` +
        `  legacy ${report.legacyPath}\n` +
        `Run \`staple migrate --yes\` to resume it. Nothing will open this workspace until it finishes.`,
      { migrationId: journal.migrationId, state: journal.state },
    );
  }
  if (journal?.state === "rollback_required") {
    throw new StapleError(
      "conflict",
      `A path migration of this workspace failed after installing the new database and needs manual recovery:\n` +
        `  new    ${report.currentPath}\n` +
        `  legacy ${report.legacyPath}\n` +
        `  journal ${journalPathFor(report.root)}\n` +
        "Staple will not choose between them. Inspect both, then run `staple doctor --fix`.",
      { migrationId: journal.migrationId, state: journal.state },
    );
  }
  throw new StapleError(
    "conflict",
    `Ambiguous workspace: two canonical databases exist and their histories may have diverged.\n` +
      `  new    ${report.currentPath}\n` +
      `  legacy ${report.legacyPath}\n` +
      "Staple refuses to pick one — nothing here proves either is a copy of the other, and choosing by\n" +
      "modification time would silently discard whichever history lost. Inspect both, keep one, and move\n" +
      "the other aside.",
  );
}

// ---------------------------------------------------------------------------
// Migration planning
// ---------------------------------------------------------------------------

export type MigrationAction =
  | "migrate" // legacy present, new absent: the normal case
  | "resume" // a journal from an interrupted run
  | "already_current" // nothing to do
  | "blocked"; // ambiguous or rollback_required

export interface MigrationPlan {
  action: MigrationAction;
  root: string;
  sourcePath: string;
  targetPath: string;
  backupPath: string;
  layout: LayoutReport;
  /** Human-readable reason, always populated. */
  reason: string;
  /** Set for `blocked`; the error a run would throw. */
  blocker: StapleError | null;
  /** Workspace identity, when a source database is readable. */
  identity: { slug: string; prefix: string; schemaVersion: number } | null;
}

function backupDirFor(root: string, migrationId: string): string {
  return join(root, WORKSPACE_DIRNAME, `rollback-${migrationId}`);
}

function readIdentity(dbPath: string): { slug: string; prefix: string; schemaVersion: number } | null {
  if (!existsSync(dbPath)) return null;
  const db = openDb(dbPath);
  try {
    const state = workspaceSchemaState(db);
    if (state.current > state.latest) {
      throw new StapleError(
        "conflict",
        `${dbPath} was created by a newer version of staple (schema version ${state.current}; ` +
          `this build understands ${state.latest}). Upgrade staple before migrating it.`,
      );
    }
    const probe = new WorkspaceStore(db, "", "");
    const slug = readMeta(probe, "slug");
    const prefix = readMeta(probe, "prefix");
    if (!slug || !prefix) return null;
    return { slug, prefix, schemaVersion: state.current };
  } finally {
    db.close();
  }
}

/** Read-only preview. Opens the source database but never writes to it. */
export function planMigration(root: string): MigrationPlan {
  const layout = describeLayout(root);
  const journal = layout.journal ?? readJournal(root);

  const base = {
    root,
    layout,
    sourcePath: layout.legacyPath,
    targetPath: layout.currentPath,
    backupPath: journal?.backupPath ?? "",
  };

  if (journal && journal.state !== "complete") {
    if (journal.state === "rollback_required") {
      return {
        ...base,
        action: "blocked",
        backupPath: journal.backupPath,
        reason: `A previous migration failed after installing ${layout.currentPath} and recorded rollback_required.`,
        blocker: new StapleError(
          "conflict",
          `Migration ${journal.migrationId} needs manual recovery. The journal is at ${journalPathFor(root)}; ` +
            `the retained legacy copy is at ${journal.backupPath}. Staple will not choose between databases.`,
        ),
        identity: null,
      };
    }
    return {
      ...base,
      action: "resume",
      backupPath: journal.backupPath,
      reason: `A previous migration was interrupted at "${journal.state}" and can be resumed.`,
      blocker: null,
      identity: {
        slug: journal.source.slug,
        prefix: journal.source.prefix,
        schemaVersion: journal.source.schemaVersion,
      },
    };
  }

  if (layout.ambiguous) {
    let blocker: StapleError | null = null;
    try {
      assertResolvable(layout);
    } catch (error) {
      blocker = error as StapleError;
    }
    return {
      ...base,
      action: "blocked",
      reason: "Two canonical databases exist and nothing proves one is a copy of the other.",
      blocker,
      identity: null,
    };
  }

  if (!layout.legacyPresent) {
    return {
      ...base,
      action: "already_current",
      reason: layout.currentPresent
        ? `This workspace already stores its state at ${layout.currentPath}.`
        : `No staple workspace at ${root}.`,
      blocker: null,
      identity: layout.currentPresent ? readIdentity(layout.currentPath) : null,
    };
  }

  return {
    ...base,
    action: "migrate",
    reason: `Legacy workspace at ${layout.legacyPath} will move to ${layout.currentPath}.`,
    blocker: null,
    identity: readIdentity(layout.legacyPath),
  };
}

// ---------------------------------------------------------------------------
// Snapshot + validation helpers
// ---------------------------------------------------------------------------

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function userTables(db: DatabaseSync): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

function rowCounts(db: DatabaseSync): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of userTables(db)) {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get() as { n: number };
    counts[table] = Number(row.n);
  }
  return counts;
}

/**
 * Column-name sets per table.
 *
 * A4's handoff: "do not assume two v2 files are byte-identical when you diff a
 * migration source against its copy — compare table_info sets, not sqlite_master
 * text", because schema version 2 shipped with `comments.idempotency_key`
 * declared inline in one physical layout and appended by `ALTER TABLE` in the
 * other. Both are correct; their DDL text differs. Sets, sorted, no text.
 */
function columnSets(db: DatabaseSync): Record<string, string[]> {
  const sets: Record<string, string[]> = {};
  for (const table of userTables(db)) {
    const rows = db.prepare(`PRAGMA table_info("${table}")`).all() as Array<{ name: string }>;
    sets[table] = rows.map((r) => r.name).sort();
  }
  return sets;
}

function assertIntegrity(dbPath: string, label: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const verdict = rows.map((r) => r.integrity_check).join("; ");
    if (verdict !== "ok") {
      throw new StapleError("conflict", `${label} failed integrity_check: ${verdict}`);
    }
  } finally {
    db.close();
  }
}

function fsyncDir(dir: string): void {
  let fd: number | undefined;
  try {
    fd = openSync(dir, "r");
    fsyncSync(fd);
  } catch {
    // Directory fsync is unsupported on some platforms and filesystems. The
    // rename is still atomic; only the durability guarantee softens.
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        /* unwinding */
      }
    }
  }
}

const SIDECAR_SUFFIXES = ["-wal", "-shm"] as const;

function moveWithSidecars(from: string, toDir: string): string[] {
  mkdirSync(toDir, { recursive: true });
  const moved: string[] = [];
  const base = parsePath(from).base;
  for (const suffix of ["", ...SIDECAR_SUFFIXES]) {
    const source = `${from}${suffix}`;
    if (!existsSync(source)) continue;
    const target = join(toDir, `${base}${suffix}`);
    renameSync(source, target);
    moved.push(target);
  }
  fsyncDir(toDir);
  fsyncDir(dirname(from));
  return moved;
}

// ---------------------------------------------------------------------------
// The write barrier
// ---------------------------------------------------------------------------

interface Barrier {
  db: DatabaseSync;
  release(): void;
}

/**
 * Exclusive writer barrier on the source database.
 *
 * `BEGIN IMMEDIATE` takes SQLite's write lock up front. Under `openDb`'s
 * `busy_timeout` it waits a bounded 5s for a competing writer and then throws
 * `SQLITE_BUSY`, which is the plan's "If it cannot obtain exclusive ownership
 * within a bounded timeout, it exits without copying". Readers are unaffected
 * (WAL), which is what lets the snapshot connection work at all.
 */
function acquireBarrier(sourcePath: string): Barrier {
  const db = openDb(sourcePath);
  try {
    db.exec("BEGIN IMMEDIATE");
  } catch (error) {
    db.close();
    const code = (error as { errcode?: number }).errcode;
    if (code === 5 || code === 6) {
      throw new StapleError(
        "conflict",
        `Another process is writing ${sourcePath}, so it cannot be migrated safely right now. ` +
          "Stop anything using this workspace (a `staple ui` server, an MCP server, another agent) and retry. " +
          "Nothing was copied and nothing was changed.",
      );
    }
    throw error;
  }
  return {
    db,
    release() {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Already rolled back, or the connection is gone. Either way the lock
        // goes with the handle we are about to close.
      }
      try {
        db.close();
      } catch {
        /* nothing useful to do while unwinding */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface MigrationResult {
  action: MigrationAction;
  migrationId: string | null;
  sourcePath: string;
  targetPath: string;
  /** Where the legacy database was retained, or null when nothing was moved. */
  backupPath: string | null;
  journalPath: string;
  slug: string | null;
  prefix: string | null;
  rowCounts: Record<string, number>;
  hub: { pathBefore: string | null; pathAfter: string | null };
  /** Non-fatal problems (today: hub registry conflicts). */
  warnings: string[];
  /** True when this call resumed a journal left by an earlier crash. */
  resumed: boolean;
}

/**
 * Migrate (or resume migrating) the workspace rooted at `root`.
 *
 * The step numbers below are the plan's, verbatim. Every state transition is
 * fsynced before the external change it describes, so a crash at any instant
 * leaves a journal that names exactly one recovery path.
 */
export function runMigration(root: string): MigrationResult {
  const plan = planMigration(root);

  if (plan.action === "blocked") {
    throw plan.blocker ?? new StapleError("conflict", plan.reason);
  }
  if (plan.action === "already_current") {
    const journal = readJournal(root);
    return {
      action: "already_current",
      migrationId: journal?.migrationId ?? null,
      sourcePath: plan.sourcePath,
      targetPath: plan.targetPath,
      backupPath: journal?.backupPath ?? null,
      journalPath: journalPathFor(root),
      slug: plan.identity?.slug ?? null,
      prefix: plan.identity?.prefix ?? null,
      rowCounts: journal?.source.rowCounts ?? {},
      hub: { pathBefore: journal?.hub.pathBefore ?? null, pathAfter: journal?.hub.pathAfter ?? null },
      warnings: [],
      resumed: false,
    };
  }

  const resumed = plan.action === "resume";
  const existing = readJournal(root);

  return existing ? resume(root, existing, resumed) : start(root, plan);
}

/** Steps 1-2: plan the migration, journal it, then take the write barrier. */
function start(root: string, plan: MigrationPlan): MigrationResult {
  const stapleDir = join(root, WORKSPACE_DIRNAME);
  mkdirSync(stapleDir, { recursive: true });

  const migrationId = randomUUID().replace(/-/g, "").slice(0, 12);
  const journalPath = journalPathFor(root);

  // Exclusive creation, per the plan. If two processes race a first migration,
  // exactly one creates this file; the loser lands in `resume`, where it will
  // contend for the SQLite barrier and refuse cleanly. The barrier is the real
  // mutual exclusion — this is the marker that says a run was attempted at all,
  // which is what makes a crash before the lock recoverable rather than silent.
  try {
    closeSync(openSync(journalPath, "wx", 0o644));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      const journal = readJournal(root);
      if (journal) return resume(root, journal, true);
    }
    throw error;
  }

  const source = plan.sourcePath;
  const stat = statSync(source);
  let journal: MigrationJournal = {
    schemaVersion: 1,
    migrationId,
    state: "planned",
    sourcePath: normalizePath(source),
    targetPath: normalizePath(plan.targetPath),
    snapshotPath: join(stapleDir, `${WORKSPACE_DBNAME}.migrate-${migrationId}.tmp`),
    backupPath: backupDirFor(root, migrationId),
    source: {
      slug: plan.identity?.slug ?? "",
      prefix: plan.identity?.prefix ?? "",
      // Journalled BEFORE anything migrates: A4's runner throws
      // StapleError("conflict") rather than reporting a status, so the version
      // has to be captured while it is still merely a fact about the file.
      schemaVersion: plan.identity?.schemaVersion ?? 0,
      identity: { dev: stat.dev, ino: stat.ino },
      rowCounts: {},
    },
    snapshotSha256: null,
    hub: { pathBefore: null, pathAfter: null, error: null },
    createdAt: nowIso(),
    updatedAt: nowIso(),
    history: [],
  };

  if (!journal.source.slug || !journal.source.prefix) {
    rmSync(journalPath, { force: true });
    throw new StapleError(
      "validation",
      `${source} has no slug/prefix metadata, so it is not a staple workspace this build can migrate.`,
    );
  }

  journal = transition(root, journal, "planned");
  return resume(root, journal, false);
}

/**
 * Steps 2-7, driven entirely by the journal state.
 *
 * A fresh run and a crash recovery take the same code path on purpose: if the
 * only way to reach `complete` is through these branches, then every state a
 * crash can leave behind is a state the happy path already exercises. A separate
 * "recovery" implementation would be the one code path never run in anger.
 */
function resume(root: string, initial: MigrationJournal, resumed: boolean): MigrationResult {
  let journal = initial;
  const warnings: string[] = [];
  let barrier: Barrier | null = null;

  try {
    // ---- step 2: exclusive write barrier ---------------------------------
    if (journal.state === "planned" || journal.state === "locked") {
      // A crash before the snapshot leaves temporary files and nothing else.
      // Discard them and start the copy again; the legacy database has not been
      // touched, so there is nothing to undo.
      rmSync(journal.snapshotPath, { force: true });
      if (!existsSync(journal.sourcePath)) {
        throw new StapleError(
          "not_found",
          `The migration journal names a source database at ${journal.sourcePath}, which is not there. ` +
            "Staple will not continue a migration whose source has moved.",
        );
      }
      barrier = acquireBarrier(journal.sourcePath);
      assertSameSource(journal, journal.sourcePath);
      journal = writeJournal(root, {
        ...journal,
        source: { ...journal.source, rowCounts: rowCounts(barrier.db) },
      });
      journal = transition(root, journal, "locked");
    }

    // ---- step 3: WAL-safe snapshot ---------------------------------------
    if (journal.state === "locked") {
      if (!barrier) barrier = acquireBarrier(journal.sourcePath);
      rmSync(journal.snapshotPath, { force: true });
      snapshot(journal.sourcePath, journal.snapshotPath);
      journal = writeJournal(root, { ...journal, snapshotSha256: sha256File(journal.snapshotPath) });
      journal = transition(root, journal, "snapshotted");
    }

    // ---- steps 4-5: validate, then install atomically --------------------
    if (journal.state === "snapshotted") {
      if (!barrier) barrier = acquireBarrier(journal.sourcePath);

      const snapshotUsable =
        existsSync(journal.snapshotPath) && sha256File(journal.snapshotPath) === journal.snapshotSha256;
      if (!snapshotUsable) {
        // Nothing outside `.staple/` has changed yet, so the safe move is to
        // throw the snapshot away and take a fresh one rather than to trust a
        // file whose recorded hash does not match.
        rmSync(journal.snapshotPath, { force: true });
        snapshot(journal.sourcePath, journal.snapshotPath);
        journal = writeJournal(root, { ...journal, snapshotSha256: sha256File(journal.snapshotPath) });
      }

      validateSnapshot(journal, barrier.db);

      if (existsSync(journal.targetPath)) {
        throw new StapleError(
          "conflict",
          `${journal.targetPath} appeared while this migration was running. Staple will not overwrite it.`,
        );
      }
      renameSync(journal.snapshotPath, journal.targetPath);
      fsyncDir(dirname(journal.targetPath));
      // Re-hash after the rename so the recorded hash describes the file at the
      // path a resume will look at. (Same bytes; the rename does not touch them.)
      journal = writeJournal(root, { ...journal, snapshotSha256: sha256File(journal.targetPath) });
      journal = transition(root, journal, "target_installed");
    }

    // ---- step 6: retire the legacy file, repair this workspace's hub row --
    if (journal.state === "target_installed") {
      if (!existsSync(journal.targetPath)) {
        journal = transition(root, journal, "rollback_required");
        throw new StapleError(
          "conflict",
          `The migrated database at ${journal.targetPath} is gone. The legacy workspace at ` +
            `${journal.sourcePath} is untouched and remains authoritative; recover manually.`,
        );
      }
      if (sha256File(journal.targetPath) !== journal.snapshotSha256) {
        journal = transition(root, journal, "rollback_required");
        throw new StapleError(
          "conflict",
          `The migrated database at ${journal.targetPath} does not match the hash this migration recorded. ` +
            `Something wrote to it. The legacy workspace at ${journal.sourcePath} is untouched; ` +
            "inspect both before continuing.",
        );
      }

      // A resume enters here with no barrier (the crash released it). Retake it:
      // the plan requires the barrier to be held "through target installation
      // and hub cutover", and a writer sneaking into the legacy database
      // between here and the move would write into the rollback copy silently.
      if (!barrier && existsSync(journal.sourcePath)) {
        barrier = acquireBarrier(journal.sourcePath);
      }

      // Move the legacy database out of the way WHILE the barrier is still held.
      // This is the step that makes the whole exercise safe: after it, exactly
      // one canonical path exists, so no later reader can pick the wrong one.
      // Renaming a file SQLite has open is fine on POSIX; a process that grabs
      // the write lock the moment we release it writes into the retained
      // rollback copy, never into the migrated database.
      if (existsSync(journal.sourcePath)) {
        moveWithSidecars(journal.sourcePath, journal.backupPath);
      }
      barrier?.release();
      barrier = null;
      // SQLite can recreate a sidecar at the old name as the handle closes.
      for (const suffix of SIDECAR_SUFFIXES) {
        rmSync(`${journal.sourcePath}${suffix}`, { force: true });
      }

      copyLegacyGuide(journal.sourcePath, journal.targetPath);

      const hub = repairOwnHubRow(journal);
      if (hub.error) warnings.push(hub.error);
      journal = writeJournal(root, { ...journal, hub });
      journal = transition(root, journal, "hub_repaired");
    }

    // ---- step 7: reopen through normal resolution, then complete ---------
    if (journal.state === "hub_repaired") {
      const opened = openWorkspace(journal.targetPath);
      try {
        if (opened.store.slug !== journal.source.slug || opened.store.prefix !== journal.source.prefix) {
          throw new StapleError(
            "conflict",
            `The migrated database identifies as ${opened.store.slug}/${opened.store.prefix}, ` +
              `not ${journal.source.slug}/${journal.source.prefix} as journalled.`,
          );
        }
      } finally {
        opened.store.db.close();
      }
      journal = transition(root, journal, "complete");
    }

    if (journal.hub.error && !warnings.includes(journal.hub.error)) warnings.push(journal.hub.error);

    return {
      action: resumed ? "resume" : "migrate",
      migrationId: journal.migrationId,
      sourcePath: journal.sourcePath,
      targetPath: journal.targetPath,
      backupPath: journal.backupPath,
      journalPath: journalPathFor(root),
      slug: journal.source.slug,
      prefix: journal.source.prefix,
      rowCounts: journal.source.rowCounts,
      hub: { pathBefore: journal.hub.pathBefore, pathAfter: journal.hub.pathAfter },
      warnings,
      resumed,
    };
  } finally {
    barrier?.release();
  }
}

/** Prove the file under the journalled source path is still the file we journalled. */
function assertSameSource(journal: MigrationJournal, path: string): void {
  const stat = statSync(path);
  if (stat.dev === journal.source.identity.dev && stat.ino === journal.source.identity.ino) return;
  throw new StapleError(
    "conflict",
    `${path} is not the file this migration started from (it was replaced or restored from elsewhere). ` +
      "Staple will not migrate a source it cannot identify.",
  );
}

/**
 * Take the snapshot from a SECOND connection while the barrier is held on the
 * first. See the module header for why this, and not checkpoint-then-copy.
 */
function snapshot(sourcePath: string, snapshotPath: string): void {
  const reader = openDb(sourcePath);
  try {
    reader.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
  } finally {
    reader.close();
  }
}

/**
 * Step 4: `integrity_check`, ordered schema migrations, metadata checks, and a
 * row-count spot check against the still-locked source.
 */
function validateSnapshot(journal: MigrationJournal, source: DatabaseSync): void {
  assertIntegrity(journal.snapshotPath, "The migration snapshot");

  const snap = openDb(journal.snapshotPath);
  try {
    // Compare BEFORE upgrading the snapshot: after migrations the snapshot may
    // legitimately have columns the source lacks, and this check is about the
    // copy being faithful, not about the schema being current.
    const sourceCounts = rowCounts(source);
    const snapshotCounts = rowCounts(snap);
    for (const [table, count] of Object.entries(sourceCounts)) {
      if (snapshotCounts[table] !== count) {
        throw new StapleError(
          "conflict",
          `Snapshot row count mismatch on "${table}": source has ${count}, snapshot has ` +
            `${snapshotCounts[table] ?? "no such table"}. The copy is not faithful; nothing was installed.`,
        );
      }
    }

    const sourceColumns = columnSets(source);
    const snapshotColumns = columnSets(snap);
    for (const [table, columns] of Object.entries(sourceColumns)) {
      const copied = snapshotColumns[table];
      if (!copied || copied.join(",") !== columns.join(",")) {
        throw new StapleError(
          "conflict",
          `Snapshot schema mismatch on "${table}": expected columns [${columns.join(", ")}], ` +
            `found [${copied?.join(", ") ?? "no such table"}].`,
        );
      }
    }

    // Now bring the copy up to date through the same ordered runner every other
    // open uses, so the installed target is never a shape only migration
    // produces. Throws StapleError("conflict") on a newer database — which is
    // why the source version was journalled before we got here.
    migrateWorkspace(snap);

    const probe = new WorkspaceStore(snap, "", "");
    const slug = readMeta(probe, "slug");
    const prefix = readMeta(probe, "prefix");
    if (slug !== journal.source.slug || prefix !== journal.source.prefix) {
      throw new StapleError(
        "conflict",
        `Snapshot identity mismatch: expected ${journal.source.slug}/${journal.source.prefix}, ` +
          `found ${slug ?? "none"}/${prefix ?? "none"}.`,
      );
    }
  } finally {
    snap.close();
  }
}

/**
 * Carry the working-protocol guide across, without ever clobbering.
 *
 * `.tasks/AGENTS.md` is frequently edited by hand — it is the file that tells
 * the next agent how this repository works. Copy it only when the destination is
 * empty, and never delete the original: it sits beside the retained legacy
 * directory where an operator can still find it.
 */
function copyLegacyGuide(sourceDbPath: string, targetDbPath: string): void {
  const from = join(dirname(sourceDbPath), "AGENTS.md");
  const to = join(dirname(targetDbPath), "AGENTS.md");
  if (!existsSync(from) || existsSync(to)) return;
  copyFileSync(from, to);
}

/**
 * Repair THIS workspace's hub row, and only this one.
 *
 * A3's handoff is explicit: `moveHome()` deliberately does not rewrite hub rows
 * and returns `staleHubPaths` instead, because sweeping the registry belongs to
 * A7. The single row for the workspace we just moved is the exception — leaving
 * it pointing at a path this migration deleted would be a bug we introduced.
 *
 * Failure here is a warning, not a failure of the migration. Plan §4: a hub
 * conflict "leaves local task operations usable where possible, warns human
 * callers, and appears as a failed `doctor` check". The data is already safely
 * migrated at this point; wedging it on a registry disagreement would be worse
 * than the disagreement.
 */
function repairOwnHubRow(journal: MigrationJournal): MigrationJournal["hub"] {
  let hub: Hub | null = null;
  try {
    hub = Hub.open();
    const normalizedSource = normalizePath(journal.sourcePath);
    const before =
      hub.list().find((entry) => {
        return entry.slug === journal.source.slug || normalizePath(entry.path) === normalizedSource;
      })?.path ?? null;
    hub.register({
      slug: journal.source.slug,
      prefix: journal.source.prefix,
      path: normalizePath(journal.targetPath),
      kind: "repo",
    });
    return { pathBefore: before, pathAfter: normalizePath(journal.targetPath), error: null };
  } catch (error) {
    return {
      pathBefore: null,
      pathAfter: null,
      error:
        `The workspace moved to ${journal.targetPath}, but its hub registration could not be updated: ` +
        `${error instanceof Error ? error.message : String(error)}. Local commands still work; ` +
        "`--ws` and hub views will follow the old path until `staple doctor` repairs it.",
    };
  } finally {
    hub?.close();
  }
}

// ---------------------------------------------------------------------------
// Operator recovery from `rollback_required`  (A7 / STA-37)
// ---------------------------------------------------------------------------

export interface RollbackResolution {
  migrationId: string;
  keep: "new" | "legacy";
  /** Where the side that lost was moved to, or null when there was nothing there. */
  movedAside: string | null;
  /** The database that is canonical afterwards. */
  canonicalPath: string;
  journalPath: string;
  hubRepaired: boolean;
  warnings: string[];
}

/**
 * Clear a `rollback_required` journal by carrying out the choice an operator
 * made.
 *
 * A5 recorded `rollback_required` and then deliberately built nothing that could
 * clear it: "only an operator can choose between two divergent histories." That
 * is still true here. This function does not choose — it is handed a side and
 * executes it, and it is reachable only through
 * `staple doctor --fix --only migration-journal --yes --keep <new|legacy>`,
 * which is three explicit consents deep.
 *
 * It lives in this module because the journal format lives here. Everything it
 * uses — the state machine, `moveWithSidecars`, `writeJournal`, `transition` —
 * is already private to this file; exporting a second copy of any of it to A7
 * is how the two would drift apart.
 *
 * What it will not do, in any mode:
 *
 *   - delete a database, ever. Both sides survive; the one the operator declined
 *     is moved aside into a named directory, exactly as a normal migration
 *     retires the legacy file.
 *   - merge two histories. Plan §3: "`doctor` must not merge divergent issue
 *     histories."
 *   - decide anything by modification time.
 *
 * `keep: "new"` is the operator saying they have inspected `.staple/staple.db`
 * and it is the history they want. Since `rollback_required` is recorded exactly
 * when the target is missing or its hash does not match, this is an override —
 * which is why it cannot happen without them saying so, and why the mismatch is
 * still reported as a warning when they do.
 *
 * `keep: "legacy"` is the operator saying the migration's output is not
 * trustworthy. In every state that can record `rollback_required` the legacy
 * database is still canonical at its own path (the failure is detected before
 * the legacy file is retired), so this mode moves the new file aside and stops.
 * There is nothing to restore, which is what makes it the safe default to
 * recommend.
 */
export function resolveRollbackRequired(root: string, keep: "new" | "legacy"): RollbackResolution {
  const journal = readJournal(root);
  if (!journal) {
    throw new StapleError("not_found", `No migration journal at ${journalPathFor(root)}.`);
  }
  if (journal.state !== "rollback_required") {
    throw new StapleError(
      "validation",
      `The migration journal at ${journalPathFor(root)} is in state "${journal.state}", not ` +
        `"rollback_required". Nothing to resolve; run \`staple migrate --yes\` if it needs resuming.`,
    );
  }

  const warnings: string[] = [];
  let movedAside: string | null = null;
  let hubRepaired = false;
  let current = journal;

  if (keep === "legacy") {
    if (!existsSync(journal.sourcePath)) {
      throw new StapleError(
        "conflict",
        `--keep legacy was requested, but the legacy database at ${journal.sourcePath} is not there. ` +
          `Staple will not synthesise one. Inspect ${journal.backupPath} and ${journal.targetPath} by hand.`,
      );
    }
    if (existsSync(journal.targetPath)) {
      // Aside, never away: the file the operator declined is still a file
      // somebody may need tomorrow.
      const aside = join(root, WORKSPACE_DIRNAME, `superseded-${journal.migrationId}`);
      moveWithSidecars(journal.targetPath, aside);
      movedAside = aside;
    }
    // The hub row was never repointed — that happens only after
    // `target_installed` succeeds — so the registry already names the legacy
    // path and there is nothing to repair.
  } else {
    if (!existsSync(journal.targetPath)) {
      throw new StapleError(
        "conflict",
        `--keep new was requested, but the migrated database at ${journal.targetPath} is not there. ` +
          `Re-run with --keep legacy to keep ${journal.sourcePath}, which is untouched.`,
      );
    }
    assertIntegrity(journal.targetPath, "The migrated database");
    if (sha256File(journal.targetPath) !== journal.snapshotSha256) {
      warnings.push(
        `${journal.targetPath} does not match the hash migration ${journal.migrationId} recorded. ` +
          "Keeping it is your decision, recorded here; the legacy database is retained, not deleted.",
      );
    }
    if (existsSync(journal.sourcePath)) {
      moveWithSidecars(journal.sourcePath, journal.backupPath);
      movedAside = journal.backupPath;
      for (const suffix of SIDECAR_SUFFIXES) {
        rmSync(`${journal.sourcePath}${suffix}`, { force: true });
      }
    }
    const hub = repairOwnHubRow(journal);
    if (hub.error) warnings.push(hub.error);
    else hubRepaired = true;
    current = writeJournal(root, { ...current, hub });
  }

  transition(root, current, "complete");

  return {
    migrationId: journal.migrationId,
    keep,
    movedAside,
    canonicalPath: keep === "new" ? journal.targetPath : journal.sourcePath,
    journalPath: journalPathFor(root),
    hubRepaired,
    warnings,
  };
}
