/**
 * What a mutation changed, read off the rows rather than remembered by the mutation.
 *
 * Contract: `docs/sync.md`, "The journal records what changed, by row".
 *
 * Each mutation declares its operation (`Journal.record`), and for a long time that
 * declaration was also the whole list of what travelled. So a column a path wrote and did
 * not name stayed on the device that wrote it: a release's `status_version`, a partial
 * approval's `gate_released`, an assignment's `updated_at` — found one path at a time, and
 * each fix was a call site remembering one more column. Here the journal stops depending on
 * that. While a local mutation runs, a trigger keeps each synchronized row's image from
 * before its first change; when the mutation ends, every synchronized column that differs
 * from that image joins the entity's operation — the one the mutation declared, or a new
 * `update` (a new `create` for a row it inserted). A path cannot forget a column, because
 * no path lists them.
 *
 * The declaration still decides the verb, and still carries what a row cannot say: a
 * `reopens`, a `blockedBy`, the `entries` beside an ordered list, a document's revision.
 * A column's value in the operation is the row's, as the mutation left it.
 *
 * Only the tables whose columns replicate one for one are read this way: `issues`,
 * `comments`, `projects` and `milestone_meta`. The vocabulary, settings, relations,
 * documents and the two ordered lists replicate as whole values the store states in full.
 * Derived columns (`DERIVED_ISSUE_FIELDS`) are left out: the applier computes them.
 *
 * The triggers are TEMP, on this connection only, created the first time a mutation runs
 * here with a device to journal for. They write nothing to the database file, change no
 * schema a migration or a backup sees, and do nothing while no mutation is being
 * journaled — an applied remote operation, above all, which journals nothing.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  COMMENT_FIELDS,
  DERIVED_ISSUE_FIELDS,
  ISSUE_FIELDS,
  MILESTONE_FIELDS,
  PROJECT_FIELDS,
  decodeColumn,
  type Column,
} from "./apply.js";

export interface CapturedTable {
  readonly table: string;
  readonly entity: "issue" | "comment" | "project" | "milestone";
  /** The primary key column, which is the entity id. */
  readonly key: string;
  /** Payload field to column, for every synchronized column that is not derived. */
  readonly fields: Readonly<Record<string, Column>>;
}

const withoutDerived = (fields: Record<string, Column>): Record<string, Column> =>
  Object.fromEntries(Object.entries(fields).filter(([field]) => !DERIVED_ISSUE_FIELDS.has(field)));

export const CAPTURED_TABLES: readonly CapturedTable[] = [
  { table: "issues", entity: "issue", key: "id", fields: withoutDerived(ISSUE_FIELDS) },
  { table: "comments", entity: "comment", key: "id", fields: COMMENT_FIELDS },
  { table: "projects", entity: "project", key: "id", fields: PROJECT_FIELDS },
  { table: "milestone_meta", entity: "milestone", key: "issue_id", fields: MILESTONE_FIELDS },
];

const prepared = new WeakSet<DatabaseSync>();

/** Create the capture tables and triggers on this connection, once. */
export function ensureRowCapture(db: DatabaseSync): void {
  if (prepared.has(db)) return;
  db.exec(`
    CREATE TEMP TABLE IF NOT EXISTS staple_capture (armed INTEGER NOT NULL);
    CREATE TEMP TABLE IF NOT EXISTS staple_row_before (
      tbl TEXT NOT NULL, row_key TEXT NOT NULL, image TEXT, PRIMARY KEY (tbl, row_key)
    );
  `);
  if (!db.prepare("SELECT 1 AS hit FROM temp.staple_capture").get()) {
    db.prepare("INSERT INTO temp.staple_capture (armed) VALUES (0)").run();
  }
  for (const spec of CAPTURED_TABLES) {
    const present = new Set((db.prepare(`PRAGMA table_info(${spec.table})`).all() as Array<{ name: string }>).map((row) => row.name));
    const columns = Object.values(spec.fields)
      .map((field) => field.column)
      .filter((column) => present.has(column));
    const image = (alias: "OLD") => `json_object(${columns.map((column) => `'${column}', ${alias}.${column}`).join(", ")})`;
    const armed = "(SELECT armed FROM staple_capture) = 1";
    db.exec(`
      CREATE TEMP TRIGGER IF NOT EXISTS staple_capture_${spec.table}_update BEFORE UPDATE ON ${spec.table}
      WHEN ${armed}
      BEGIN
        INSERT OR IGNORE INTO staple_row_before (tbl, row_key, image) VALUES ('${spec.table}', OLD.${spec.key}, ${image("OLD")});
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS staple_capture_${spec.table}_delete BEFORE DELETE ON ${spec.table}
      WHEN ${armed}
      BEGIN
        INSERT OR IGNORE INTO staple_row_before (tbl, row_key, image) VALUES ('${spec.table}', OLD.${spec.key}, ${image("OLD")});
      END;
      CREATE TEMP TRIGGER IF NOT EXISTS staple_capture_${spec.table}_insert AFTER INSERT ON ${spec.table}
      WHEN ${armed}
      BEGIN
        INSERT OR IGNORE INTO staple_row_before (tbl, row_key, image) VALUES ('${spec.table}', NEW.${spec.key}, NULL);
      END;
    `);
  }
  prepared.add(db);
}

/**
 * Start or stop keeping row images. Returns whether they were being kept. Starting a
 * mutation's capture (`fresh`) forgets any image left from before it.
 */
export function armRowCapture(db: DatabaseSync, armed: boolean, fresh = false): boolean {
  if (!prepared.has(db)) return false;
  const was = (db.prepare("SELECT armed FROM temp.staple_capture").get() as { armed: number } | undefined)?.armed === 1;
  if (was !== armed) db.prepare("UPDATE temp.staple_capture SET armed = ?").run(armed ? 1 : 0);
  if (fresh) db.prepare("DELETE FROM temp.staple_row_before").run();
  return was;
}

/** One entity's changed synchronized columns, as payload fields. */
export interface RowChange {
  readonly entity: CapturedTable["entity"];
  readonly entityId: string;
  /** True when the mutation inserted the row. */
  readonly created: boolean;
  readonly fields: Record<string, unknown>;
}

function sameValue(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (before === null || before === undefined || after === null || after === undefined) return before == after;
  return String(before) === String(after) && typeof before === typeof after;
}

/**
 * Every synchronized column the mutation changed, per entity, and forget the images.
 * A row it inserted reports every column; a row it deleted, nothing — its operation is the
 * delete the mutation declared.
 */
export function takeRowChanges(db: DatabaseSync): RowChange[] {
  if (!prepared.has(db)) return [];
  const images = db.prepare("SELECT tbl, row_key, image FROM temp.staple_row_before ORDER BY rowid").all() as Array<{
    tbl: string;
    row_key: string;
    image: string | null;
  }>;
  db.prepare("DELETE FROM temp.staple_row_before").run();
  const changes: RowChange[] = [];
  for (const captured of images) {
    const spec = CAPTURED_TABLES.find((table) => table.table === captured.tbl);
    if (!spec) continue;
    const row = db.prepare(`SELECT * FROM ${spec.table} WHERE ${spec.key} = ?`).get(captured.row_key) as
      | Record<string, unknown>
      | undefined;
    if (!row) continue;
    const before = captured.image === null ? null : (JSON.parse(captured.image) as Record<string, unknown>);
    const fields: Record<string, unknown> = {};
    for (const [field, column] of Object.entries(spec.fields)) {
      if (!(column.column in row)) continue;
      const after = row[column.column];
      if (before !== null && (!(column.column in before) || sameValue(before[column.column], after))) continue;
      fields[field] = decodeColumn(after, column.encoding);
    }
    if (Object.keys(fields).length === 0) continue;
    changes.push({ entity: spec.entity, entityId: captured.row_key, created: before === null, fields });
  }
  return changes;
}
