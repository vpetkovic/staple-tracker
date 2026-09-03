import { existsSync, mkdirSync, rmSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "./db.js";
import { assertNotNewer, describeSchema } from "./migrations/runner.js";
import type { SchemaState } from "./migrations/types.js";
import { WORKSPACE_TARGET, inspectWorkspaceSchema, migrateWorkspace } from "./schema.js";
import { WorkspaceStore } from "./store.js";
import { StapleError } from "./types.js";

/** Where pre-upgrade snapshots land, beside the database they were taken from. */
export const SNAPSHOT_DIRNAME = "snapshots";

/** What an open did when it found a schema upgrade pending. */
export interface WorkspaceUpgrade {
  /** The stamped version the file was at before this open. */
  from: number;
  /** The version this build brings it to. */
  to: number;
  /** A verified, WAL-inclusive copy of the file at `from`, retained for rollback. */
  snapshotPath: string;
}

export interface OpenedWorkspace {
  store: WorkspaceStore;
  dbPath: string;
  /** Set when this open snapshotted the file before migrating it; absent otherwise. */
  upgrade?: WorkspaceUpgrade;
}

export function readMeta(store: WorkspaceStore, key: string): string | null {
  const row = store.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function writeMeta(store: WorkspaceStore, key: string, value: string): void {
  store.db
    .prepare(
      "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    )
    .run(key, value);
}

/** `<dir>/snapshots/<file>.schema-<from>.<utc-stamp>-<pid>.db` — unique per process and instant. */
function snapshotPathFor(dbPath: string, from: number, now: Date): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return join(
    dirname(dbPath),
    SNAPSHOT_DIRNAME,
    `${basename(dbPath)}.schema-${from}.${stamp}-${process.pid}.db`,
  );
}

/**
 * The snapshot is only worth keeping if it is the file it claims to be: intact,
 * and at the version the source was stamped with when it was read.
 */
function verifySnapshot(snapshotPath: string, expectedVersion: number): void {
  const snap = new DatabaseSync(snapshotPath, { readOnly: true });
  try {
    const rows = snap.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const verdict = rows.map((row) => row.integrity_check).join("; ");
    if (verdict !== "ok") {
      throw new StapleError(
        "conflict",
        `The pre-upgrade snapshot at ${snapshotPath} failed integrity_check: ${verdict}.`,
      );
    }
    const state = describeSchema(snap, WORKSPACE_TARGET);
    if (state.current !== expectedVersion) {
      throw new StapleError(
        "conflict",
        `The pre-upgrade snapshot at ${snapshotPath} is at schema version ${state.current}; ` +
          `the source was read at ${expectedVersion}.`,
      );
    }
  } finally {
    snap.close();
  }
}

/**
 * Copy a workspace file that is about to be migrated, through a READ-ONLY
 * handle, in a form SQLite guarantees is consistent.
 *
 * `VACUUM INTO` rather than a file copy, for the reason `path-migration.ts`
 * measured and recorded: it reads *through* the write-ahead log, so rows
 * another process committed and never checkpointed come across, and the
 * `-wal` / `-shm` sidecar question disappears instead of being answered. The
 * handle is read-only so the copy cannot be the write that touches the file
 * first — and the copy is verified before the caller is allowed to open a
 * writable handle. If the snapshot cannot be taken, the upgrade does not run.
 */
export function snapshotWorkspaceForUpgrade(
  dbPath: string,
  state: SchemaState,
  now = new Date(),
): string {
  const snapshotPath = snapshotPathFor(dbPath, state.current, now);
  try {
    mkdirSync(dirname(snapshotPath), { recursive: true });
    const reader = new DatabaseSync(dbPath, { readOnly: true });
    try {
      reader.exec(`VACUUM INTO '${snapshotPath.replace(/'/g, "''")}'`);
    } finally {
      reader.close();
    }
    verifySnapshot(snapshotPath, state.current);
  } catch (error) {
    // A snapshot that failed verification must not be left looking like one.
    try {
      rmSync(snapshotPath, { force: true });
    } catch {
      // The path may not be creatable at all (that is often the failure itself).
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new StapleError(
      "conflict",
      `Could not take a pre-upgrade snapshot of ${dbPath} (schema ${state.current} -> ${state.latest}): ` +
        `${detail} The workspace was not opened and nothing in it was changed. ` +
        `Fix the problem under ${dirname(snapshotPath)} and retry.`,
    );
  }
  return snapshotPath;
}

/**
 * Open an existing workspace file (must have been initialized by `staple init`).
 *
 * Order matters, and every step before `openDb` is read-only by construction:
 *
 *   1. inspect the schema through a read-only handle
 *   2. refuse a file stamped newer than this build — before any write
 *   3. if an upgrade is pending, snapshot the file (still read-only) and verify it
 *   4. only now open a writable handle and migrate
 *
 * `openDb` is where the first write can happen (`PRAGMA journal_mode=WAL`), so
 * the decision to refuse, and the recovery point for a migration, both exist
 * before it runs. The runner re-checks the version under its own lock; the
 * read-only pass here is what keeps an older build from touching a newer file
 * at all, rather than merely from committing to it.
 */
export function openWorkspace(dbPath: string): OpenedWorkspace {
  if (!existsSync(dbPath)) {
    throw new StapleError(
      "not_found",
      `No workspace at ${dbPath}. Run \`staple init\` in the repo (or \`staple init --global <slug>\`).`,
    );
  }

  const inspected = inspectWorkspaceSchema(dbPath);
  assertNotNewer(inspected, WORKSPACE_TARGET, dbPath);

  let upgrade: WorkspaceUpgrade | undefined;
  // An empty file has nothing to protect; it takes the fresh-create path.
  if (inspected.detection !== "empty" && inspected.pending.length > 0) {
    upgrade = {
      from: inspected.current,
      to: inspected.latest,
      snapshotPath: snapshotWorkspaceForUpgrade(dbPath, inspected),
    };
    // Said BEFORE the migration runs, so the recovery path is on the user's
    // terminal even if the migration itself fails. stderr keeps stdout and
    // `--json` output exactly as they were.
    console.error(
      `staple: upgrading workspace ${dbPath} from schema ${upgrade.from} to ${upgrade.to}; ` +
        `pre-upgrade snapshot retained at ${upgrade.snapshotPath}`,
    );
  }

  const db = openDb(dbPath);
  migrateWorkspace(db);
  const probe = new WorkspaceStore(db, "", "");
  const slug = readMeta(probe, "slug");
  const prefix = readMeta(probe, "prefix");
  if (!slug || !prefix) {
    throw new StapleError("validation", `Workspace at ${dbPath} is missing slug/prefix metadata`);
  }
  const opened: OpenedWorkspace = { store: new WorkspaceStore(db, slug, prefix), dbPath };
  if (upgrade) opened.upgrade = upgrade;
  return opened;
}
