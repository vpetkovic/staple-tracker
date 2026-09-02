import type { DatabaseSync } from "node:sqlite";

export interface SchemaRow {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

/**
 * Every `sqlite_master` row, in creation order.
 *
 * Includes the internal objects — `sqlite_autoindex_*` (which carry `sql`
 * NULL and prove a UNIQUE/PRIMARY KEY constraint exists) and `sqlite_sequence`
 * (which proves an AUTOINCREMENT column exists). They are exactly the rows a
 * lazy comparison would drop, and exactly the rows that catch a consolidated
 * snapshot that recreated a table without its constraints.
 */
export function schemaRows(db: DatabaseSync): SchemaRow[] {
  return db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid")
    .all() as unknown as SchemaRow[];
}

/**
 * The rows whose `sql` SQLite stored verbatim — i.e. the ones that can be
 * replayed to reproduce the schema. Internal objects are excluded because
 * SQLite recreates them itself, at the same point, from the statements below.
 */
export function replayableStatements(db: DatabaseSync): string[] {
  return schemaRows(db)
    .filter((row) => row.sql !== null && !row.name.startsWith("sqlite_"))
    .map((row) => `${row.sql};`);
}

/**
 * A stable, order-independent rendering of a schema for diffing two databases.
 *
 * Sorted by type+name rather than creation order: two paths that produce the
 * same objects in a different order are the same schema, and pinning creation
 * order would make the equivalence test fail for a reason nobody cares about.
 * Whitespace inside each statement is left alone — SQLite stores the CREATE
 * text verbatim, so the comparison really is byte-for-byte on the SQL.
 */
export function normalizedSchema(db: DatabaseSync): string {
  return schemaRows(db)
    .map((row) => `${row.type}:${row.name}:${row.tbl_name}:${row.sql ?? "<internal>"}`)
    .sort()
    .join("\n");
}
