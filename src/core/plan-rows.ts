/**
 * An idea's task breakdown, one `plan_rows` row per breakdown row (design/plan.md, "Task
 * breakdown rows").
 *
 * On the wire each row is one field of the idea's `milestone` entity, `planRow.<row id>`, whose
 * value is the row (key, title, estimate, dependsOn, acceptance, owner, notes and its rank) and
 * whose null removes it: the shape plan links use (`plan-links.ts`). The service folds the
 * entity's keys one by one, so two devices editing different rows write two fields and both
 * edits arrive; the same row edited on two devices is one field, and a conflict like any other.
 * A row's id never changes, so renaming its key is an edit of that one field.
 */
import type { DatabaseSync } from "node:sqlite";
import type { BreakdownRow } from "./plan-sections.js";

export const PLAN_ROW_PREFIX = "planRow.";

export function planRowField(rowId: string): string {
  return `${PLAN_ROW_PREFIX}${rowId}`;
}

/** The row id a field names, or null when it is not a row field. */
export function planRowId(field: string): string | null {
  if (!field.startsWith(PLAN_ROW_PREFIX)) return null;
  const id = field.slice(PLAN_ROW_PREFIX.length);
  return id.length > 0 && id.length <= 128 ? id : null;
}

/** A row as it travels: everything but its id (the field names it), and its place in the breakdown. */
export interface PlanRowValue {
  key: string;
  title: string;
  estimate: string | null;
  dependsOn: string[];
  acceptance: string | null;
  owner: string | null;
  notes: string | null;
  rank: number;
}

const textOrNull = (value: unknown): string | null | undefined => (value === null ? null : typeof value === "string" ? value : undefined);

/** A wire value read back as a row; null for a removal or a value that is not one. */
export function planRowFromValue(value: unknown): PlanRowValue | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.key !== "string" || typeof v.title !== "string" || typeof v.rank !== "number" || !Number.isFinite(v.rank)) return null;
  if (!Array.isArray(v.dependsOn) || v.dependsOn.some((dep) => typeof dep !== "string")) return null;
  const estimate = textOrNull(v.estimate);
  const acceptance = textOrNull(v.acceptance);
  const owner = textOrNull(v.owner);
  const notes = textOrNull(v.notes);
  if (estimate === undefined || acceptance === undefined || owner === undefined || notes === undefined) return null;
  return { key: v.key, title: v.title, estimate, dependsOn: v.dependsOn as string[], acceptance, owner, notes, rank: v.rank };
}

export function planRowValue(row: BreakdownRow, rank: number): PlanRowValue {
  return { key: row.key, title: row.title, estimate: row.estimate, dependsOn: [...row.dependsOn], acceptance: row.acceptance, owner: row.owner, notes: row.notes, rank };
}

/** Write one row, or remove it with null. */
export function writePlanRow(db: DatabaseSync, ideaId: string, rowId: string, value: PlanRowValue | null): void {
  if (value === null) {
    db.prepare("DELETE FROM plan_rows WHERE idea_id = ? AND row_id = ?").run(ideaId, rowId);
    return;
  }
  db.prepare(
    `INSERT INTO plan_rows (idea_id, row_id, body, rank) VALUES (?, ?, ?, ?)
     ON CONFLICT (idea_id, row_id) DO UPDATE SET body = excluded.body, rank = excluded.rank`,
  ).run(ideaId, rowId, JSON.stringify(value), value.rank);
}

/** An idea's rows as the wire carries them, one field each. */
export function planRowFields(db: DatabaseSync, ideaId: string): Record<string, PlanRowValue> {
  const out: Record<string, PlanRowValue> = {};
  for (const row of db.prepare("SELECT row_id, body FROM plan_rows WHERE idea_id = ? ORDER BY rank, row_id").all(ideaId) as Array<{ row_id: string; body: string }>) {
    const value = planRowFromValue(JSON.parse(row.body));
    if (value) out[planRowField(row.row_id)] = value;
  }
  return out;
}

/** An idea's breakdown in order: by rank, then by id, so two devices that ranked alike read alike. */
export function planRowsOf(db: DatabaseSync, ideaId: string): Array<BreakdownRow & { rank: number }> {
  const out: Array<BreakdownRow & { rank: number }> = [];
  for (const row of db.prepare("SELECT row_id, body FROM plan_rows WHERE idea_id = ? ORDER BY rank, row_id").all(ideaId) as Array<{ row_id: string; body: string }>) {
    const value = planRowFromValue(JSON.parse(row.body));
    if (!value) continue;
    out.push({ id: row.row_id, key: value.key, title: value.title, estimate: value.estimate, dependsOn: value.dependsOn, acceptance: value.acceptance, owner: value.owner, notes: value.notes, rank: value.rank });
  }
  return out;
}

/** Every record's breakdown in one read, each in the order `planRowsOf` answers it. */
export function planRowsByRecord(db: DatabaseSync): Map<string, BreakdownRow[]> {
  const out = new Map<string, BreakdownRow[]>();
  for (const row of db.prepare("SELECT idea_id, row_id, body FROM plan_rows ORDER BY idea_id, rank, row_id").all() as Array<{ idea_id: string; row_id: string; body: string }>) {
    const value = planRowFromValue(JSON.parse(row.body));
    if (!value) continue;
    const list = out.get(row.idea_id) ?? [];
    list.push({ id: row.row_id, key: value.key, title: value.title, estimate: value.estimate, dependsOn: value.dependsOn, acceptance: value.acceptance, owner: value.owner, notes: value.notes });
    out.set(row.idea_id, list);
  }
  return out;
}
