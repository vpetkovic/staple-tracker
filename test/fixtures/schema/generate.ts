/**
 * Regenerate the upgrade fixtures in this directory.
 *
 *   npx tsx test/fixtures/schema/generate.ts
 *
 * These are REAL database files, not scripts that fake an old shape at test
 * time. The point of a fixture is that it was written by the old code path and
 * then left alone: a test that rebuilds "what v1 looked like" from today's
 * source can drift with today's source, and it stops being evidence about
 * files that already exist on people's disks.
 *
 * So each fixture is built by running a PREFIX of the migration list — nothing
 * later — and then, for the workspace ones, stuffing real rows in through raw
 * SQL rather than through `WorkspaceStore` (whose queries assume the current
 * schema). Once written they are checked in and should not be regenerated
 * casually; regenerate only when you have deliberately changed what an old
 * database looked like, which should be never.
 *
 * The `.sqlite` extension is not decoration. The prototype `.gitignore` has a
 * blanket `*.db` rule, so a fixture named `workspace-v1.db` would be silently
 * untracked — a checked-in fixture that is not actually checked in is worse
 * than no fixture. `.sqlite` keeps them tracked without editing a shared ignore
 * file while several agents are working in this tree.
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { MigrationTarget } from "../../../src/core/migrations/types.js";
import { WORKSPACE_LATEST_VERSION, WORKSPACE_TARGET } from "../../../src/core/migrations/workspace/index.js";
import { HUB_TARGET } from "../../../src/core/migrations/hub/index.js";

export const FIXTURE_DIR = dirname(fileURLToPath(import.meta.url));

/** Fixture files, by the shape they capture. */
export const FIXTURES = {
  /** Pre-idempotency workspace, stamped '1', with real content. */
  workspaceV1: "workspace-v1.sqlite",
  /** Same shape, `schema_version` row absent — "exists but was never stamped". */
  workspaceV1Unstamped: "workspace-v1-unstamped.sqlite",
  /** Current shape, stamped '2', with real content including an idempotency key. */
  workspaceV2: "workspace-v2.sqlite",
  /**
   * v2 as the SHIPPED pre-A4 code created it from scratch — `idempotency_key`
   * inline in `comments` rather than appended by ALTER. Databases with this
   * exact shape exist on disk right now.
   */
  workspaceV2LegacyDdl: "workspace-v2-legacy-ddl.sqlite",
  /**
   * Stamped '3', with real content — what the retired prototype checkout
   * wrote, three migrations behind the live workspace. The package-level
   * matrix walks it to the latest version through the packed runtime.
   */
  workspaceV3: "workspace-v3.sqlite",
  /**
   * Stamped '5', with real content — the last shape before approval gates, and
   * the shape some installed builds still write. The pre-upgrade snapshot
   * tests walk THIS forward.
   */
  workspaceV5: "workspace-v5.sqlite",
  /**
   * Stamped '6', with real content — the live workspace's shape at the time
   * approval gates shipped. A build that understands 3 or 5 must refuse it;
   * this build walks it forward by whatever came after 006. There is no
   * checked-in fixture for "current": see `writeCurrentWorkspace`.
   */
  workspaceV6: "workspace-v6.sqlite",
  /** Stamped '99' — the downgrade guard's target. */
  workspaceV99: "workspace-v99.sqlite",
  /** Today's hub: registry tables, NO meta table, therefore unversioned. */
  hubV1: "hub-v1.sqlite",
  /** Hub stamped '99'. */
  hubV99: "hub-v99.sqlite",
} as const;

export function fixturePath(name: string): string {
  return join(FIXTURE_DIR, name);
}

/**
 * `npx tsx generate.ts workspace-v3.sqlite` regenerates only the named files.
 * A fixture added later must not rewrite the ones already checked in: the
 * SQLite library stamps its own version into the file header, so a full
 * regeneration under a newer Node changes bytes in files whose whole value is
 * that they were left alone.
 */
const only = new Set(process.argv.slice(2));

function wanted(file: string): boolean {
  return only.size === 0 || only.has(file);
}

/**
 * Write a database at `path` by walking migrations up to and including
 * `throughVersion`. Journal mode stays `delete` so the finished file is one
 * self-contained file with no `-wal` sidecar to check in or forget.
 */
export function writeFixture(
  target: MigrationTarget,
  path: string,
  throughVersion: number,
  seed?: (db: DatabaseSync) => void,
): void {
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });

  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=delete");
  db.exec("PRAGMA foreign_keys=ON");
  for (const migration of [...target.migrations].sort((a, b) => a.version - b.version)) {
    if (migration.version > throughVersion) break;
    migration.up(db);
  }
  seed?.(db);
  db.close();
}

/** `writeFixture` into this directory, for the checked-in files `main` regenerates. */
function build(
  target: MigrationTarget,
  file: string,
  throughVersion: number,
  seed?: (db: DatabaseSync) => void,
): void {
  if (!wanted(file)) return;
  writeFixture(target, fixturePath(file), throughVersion, seed);
  process.stdout.write(`wrote ${file}\n`);
}

/** Stamp a version directly, bypassing the runner — that is the whole point. */
function stampRaw(db: DatabaseSync, version: string): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES ('schema_version', ?) " +
      "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(version);
}

/**
 * Rows an upgrade must not disturb. Written as raw SQL against the fixture's
 * own (old) column set, so this seeder stays valid even as `store.ts` moves on.
 */
function seedWorkspaceRows(db: DatabaseSync, opts: { idempotencyKey: boolean }): void {
  db.prepare("INSERT INTO meta (key, value) VALUES ('slug', 'legacyrepo')").run();
  db.prepare("INSERT INTO meta (key, value) VALUES ('prefix', 'LEG')").run();

  const now = "2026-01-15T09:00:00.000Z";
  db.prepare(
    `INSERT INTO issues (id, identifier, title, normalized_title, description, status,
                         status_version, priority, depth, assignee, created_by, labels,
                         origin_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'in_progress', 3, 'high', 0, 'claude', 'vlad', '["legacy"]',
             'manual', ?, ?)`,
  ).run("iss-legacy-1", "LEG-1", "Existing work", "existing work", "carried over", now, now);
  db.prepare(
    `INSERT INTO issues (id, identifier, title, normalized_title, status, status_version,
                         priority, parent_id, depth, labels, origin_kind, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'done', 7, 'medium', ?, 1, '[]', 'manual', ?, ?)`,
  ).run("iss-legacy-2", "LEG-2", "Child work", "child work", "iss-legacy-1", now, now);

  db.prepare(
    `INSERT INTO relations (blocker_id, blocked_id, type, created_by, created_at)
     VALUES ('iss-legacy-2', 'iss-legacy-1', 'blocks', 'vlad', ?)`,
  ).run(now);

  const commentColumns = opts.idempotencyKey
    ? "(id, issue_id, author, author_type, body, created_at, idempotency_key)"
    : "(id, issue_id, author, author_type, body, created_at)";
  const commentValues = opts.idempotencyKey ? "(?, ?, ?, ?, ?, ?, ?)" : "(?, ?, ?, ?, ?, ?)";
  const historic = ["cmt-legacy-1", "iss-legacy-1", "vlad", "user", "historic note", now];
  db.prepare(`INSERT INTO comments ${commentColumns} VALUES ${commentValues}`).run(
    ...(opts.idempotencyKey ? [...historic, "seed-key-1"] : historic),
  );

  db.prepare(
    `INSERT INTO documents (issue_id, key, current_revision, title, updated_at)
     VALUES ('iss-legacy-1', 'plan', 1, 'Plan', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO document_revisions (issue_id, key, revision, body, author, created_at)
     VALUES ('iss-legacy-1', 'plan', 1, '# Legacy plan', 'vlad', ?)`,
  ).run(now);

  db.prepare(
    `INSERT INTO events (kind, issue_id, actor, payload, created_at)
     VALUES ('issue.created', 'iss-legacy-1', 'vlad', '{}', ?)`,
  ).run(now);
}

/**
 * A workspace at THIS build's latest version — seeded like the checked-in
 * workspace fixtures, stamped `WORKSPACE_LATEST_VERSION`, written to `path`
 * (a `.db` in a scratch directory, normally). Returns `path`.
 *
 * There is deliberately no `workspace-v<latest>.sqlite` in `FIXTURES`. A
 * checked-in file is only "current" until the next migration lands; then every
 * test that read it as current breaks and someone regenerates it — the drift
 * the README warns about, from the other side. So "current" is built at test
 * time from the migration list and is by construction whatever
 * `WORKSPACE_LATEST_VERSION` says, while the files on disk are only ever OLDER
 * shapes that a test walks forward.
 */
export function writeCurrentWorkspace(path: string): string {
  writeFixture(WORKSPACE_TARGET, path, WORKSPACE_LATEST_VERSION, (db) => {
    seedWorkspaceRows(db, { idempotencyKey: true });
    stampRaw(db, String(WORKSPACE_LATEST_VERSION));
  });
  return path;
}

/** `support.withFixture` for the generated current workspace: scratch directory, removed afterwards. */
export function withCurrentWorkspace<T>(fn: (path: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "staple-fixture-"));
  try {
    return fn(writeCurrentWorkspace(join(dir, "workspace-current.db")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function seedHubRows(db: DatabaseSync): void {
  const now = "2026-01-15T09:00:00.000Z";
  db.prepare(
    `INSERT INTO workspaces (slug, prefix, path, kind, added_at, last_seen_at)
     VALUES ('legacyrepo', 'LEG', '/tmp/legacyrepo/.tasks/tasks.db', 'repo', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO cross_links (blocker_ws, blocker_identifier, blocked_ws, blocked_identifier,
                              type, created_at)
     VALUES ('legacyrepo', 'LEG-1', 'otherrepo', 'OTH-4', 'blocks', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO hub_events (kind, payload, created_at) VALUES ('workspace.registered', '{}', ?)`,
  ).run(now);
}

/**
 * The pre-A4 `WORKSPACE_DDL`, verbatim, plus the post-migration index block
 * that followed it. Copied out of `src/core/schema.ts` at commit d47868f and
 * frozen here.
 *
 * This is not redundant with `workspace-v2.sqlite`. The old code created a
 * fresh database from ONE `CREATE ... IF NOT EXISTS` blob with
 * `idempotency_key` declared inline between `body` and `deleted_at`, while an
 * upgraded database got it APPENDED by `ALTER TABLE`. Both were stamped '2'.
 * So version 2 shipped as two different physical layouts, and the runner has
 * to leave both of them alone — rewriting a table to normalise column order
 * would be a far bigger risk than the inconsistency it fixes.
 *
 * Do not "sync" this with the current migrations. It is a historical record.
 */
const LEGACY_V2_DDL = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  identifier TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'backlog',
  status_version INTEGER NOT NULL DEFAULT 0,
  priority TEXT NOT NULL DEFAULT 'medium',
  parent_id TEXT REFERENCES issues(id) ON DELETE SET NULL,
  depth INTEGER NOT NULL DEFAULT 0,
  assignee TEXT,
  created_by TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  acceptance_criteria TEXT,
  block_parent_until_done INTEGER NOT NULL DEFAULT 0,
  unblock_owner TEXT,
  unblock_action TEXT,
  origin_kind TEXT NOT NULL DEFAULT 'manual',
  origin_id TEXT,
  idempotency_key TEXT,
  checkout_agent TEXT,
  checkout_at TEXT,
  blocked_transition_at TEXT,
  started_at TEXT,
  completed_at TEXT,
  cancelled_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS issues_idempotency_uq
  ON issues(idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS issues_normalized_title_open_idx
  ON issues(normalized_title) WHERE status NOT IN ('done','cancelled');
CREATE UNIQUE INDEX IF NOT EXISTS issues_live_origin_uq
  ON issues(origin_kind, origin_id)
  WHERE origin_kind <> 'manual' AND origin_id IS NOT NULL
    AND status NOT IN ('done','cancelled');
CREATE INDEX IF NOT EXISTS issues_status_idx ON issues(status);
CREATE INDEX IF NOT EXISTS issues_parent_idx ON issues(parent_id);
CREATE INDEX IF NOT EXISTS issues_assignee_status_idx ON issues(assignee, status);
CREATE INDEX IF NOT EXISTS issues_updated_idx ON issues(updated_at);

CREATE TABLE IF NOT EXISTS relations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  blocker_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  blocked_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  type TEXT NOT NULL DEFAULT 'blocks',
  created_by TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (blocker_id, blocked_id, type)
);
CREATE INDEX IF NOT EXISTS relations_blocked_idx ON relations(blocked_id);
CREATE INDEX IF NOT EXISTS relations_blocker_idx ON relations(blocker_id);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  author_type TEXT NOT NULL DEFAULT 'user',
  body TEXT NOT NULL,
  idempotency_key TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS comments_issue_idx ON comments(issue_id, created_at);

CREATE TABLE IF NOT EXISTS documents (
  issue_id TEXT NOT NULL REFERENCES issues(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  current_revision INTEGER NOT NULL,
  title TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, key)
);

CREATE TABLE IF NOT EXISTS document_revisions (
  issue_id TEXT NOT NULL,
  key TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body TEXT NOT NULL,
  author TEXT,
  change_summary TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (issue_id, key, revision)
);

CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  issue_id TEXT,
  actor TEXT,
  payload TEXT NOT NULL DEFAULT '{}',
  dedup_key TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS events_dedup_uq
  ON events(dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS events_issue_idx ON events(issue_id, seq);

CREATE UNIQUE INDEX IF NOT EXISTS comments_idempotency_uq
  ON comments(issue_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
`;

/** Build a fixture from raw DDL rather than from the migration list. */
function buildRaw(file: string, ddl: string, seed: (db: DatabaseSync) => void): void {
  if (!wanted(file)) return;
  const path = fixturePath(file);
  for (const suffix of ["", "-wal", "-shm"]) rmSync(`${path}${suffix}`, { force: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode=delete");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(ddl);
  seed(db);
  db.close();
  process.stdout.write(`wrote ${file}\n`);
}

function main(): void {
  mkdirSync(FIXTURE_DIR, { recursive: true });

  build(WORKSPACE_TARGET, FIXTURES.workspaceV1, 1, (db) => {
    seedWorkspaceRows(db, { idempotencyKey: false });
    stampRaw(db, "1");
  });

  build(WORKSPACE_TARGET, FIXTURES.workspaceV1Unstamped, 1, (db) => {
    seedWorkspaceRows(db, { idempotencyKey: false });
    // No stamp at all: the runner has to infer version 1 from "sentinel table
    // present, no version row".
  });

  build(WORKSPACE_TARGET, FIXTURES.workspaceV2, 2, (db) => {
    seedWorkspaceRows(db, { idempotencyKey: true });
    stampRaw(db, "2");
  });

  buildRaw(FIXTURES.workspaceV2LegacyDdl, LEGACY_V2_DDL, (db) => {
    seedWorkspaceRows(db, { idempotencyKey: true });
    stampRaw(db, "2");
  });

  build(WORKSPACE_TARGET, FIXTURES.workspaceV3, 3, (db) => {
    seedWorkspaceRows(db, { idempotencyKey: true });
    stampRaw(db, "3");
  });

  build(WORKSPACE_TARGET, FIXTURES.workspaceV5, 5, (db) => {
    seedWorkspaceRows(db, { idempotencyKey: true });
    stampRaw(db, "5");
  });

  build(WORKSPACE_TARGET, FIXTURES.workspaceV6, 6, (db) => {
    seedWorkspaceRows(db, { idempotencyKey: true });
    stampRaw(db, "6");
  });

  build(WORKSPACE_TARGET, FIXTURES.workspaceV99, 2, (db) => {
    seedWorkspaceRows(db, { idempotencyKey: true });
    stampRaw(db, "99");
  });

  // Hub v1 is today's hub exactly: migration 001 only, so no `meta` table and
  // nowhere to put a version even if we wanted one.
  build(HUB_TARGET, FIXTURES.hubV1, 1, seedHubRows);

  build(HUB_TARGET, FIXTURES.hubV99, 2, (db) => {
    seedHubRows(db);
    stampRaw(db, "99");
  });
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) main();
