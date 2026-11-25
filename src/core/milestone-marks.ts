/**
 * A milestone's criterion marks in the database: the one writer and the one reader of
 * `milestone_criterion_marks` (workspace migration 016). Its own module, importing nothing
 * but the pure rules, because the store (`milestone-store.ts`) and the sync appliers
 * (`cloud/apply.ts`, `cloud/conflicts.ts`, `cloud/seed.ts`) both need it, and the store
 * sits above the journal those appliers sit under.
 */
import type { DatabaseSync } from "node:sqlite";
import {
  type CriterionMarkMoves,
  type CriterionMarkValue,
  type CriterionVerdict,
  criterionMarkField,
  criterionMarkPosition,
  criterionMarkValue,
  followCriterionMarks,
} from "./milestone-goal.js";

/**
 * Write one criterion's mark, or clear it (null): the one writer the local mark and an applied
 * remote one share (`cloud/apply.ts`), so both hold a mark in exactly one shape.
 */
export function writeCriterionMark(db: DatabaseSync, milestoneId: string, position: number, mark: CriterionMarkValue | null): void {
  if (mark === null) {
    db.prepare("DELETE FROM milestone_criterion_marks WHERE milestone_id = ? AND position = ?").run(milestoneId, position);
    return;
  }
  db.prepare(
    `INSERT INTO milestone_criterion_marks (milestone_id, position, criterion, verdict, evidence, note, marked_by, run_id, marked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (milestone_id, position) DO UPDATE SET
       criterion = excluded.criterion, verdict = excluded.verdict, evidence = excluded.evidence,
       note = excluded.note, marked_by = excluded.marked_by, run_id = excluded.run_id, marked_at = excluded.marked_at`,
  ).run(milestoneId, position, mark.criterion, mark.verdict, JSON.stringify(mark.evidence), mark.note, mark.markedBy, mark.runId, mark.markedAt);
}

/** Every mark a milestone holds, as wire values keyed by field (`criterion<n>`). */
export function criterionMarkFields(db: DatabaseSync, milestoneId: string): Record<string, CriterionMarkValue> {
  const rows = db
    .prepare("SELECT * FROM milestone_criterion_marks WHERE milestone_id = ? ORDER BY position")
    .all(milestoneId) as Array<{ position: number; criterion: string; verdict: string; evidence: string; note: string | null; marked_by: string; run_id: string | null; marked_at: string }>;
  return Object.fromEntries(
    rows.map((row) => [
      criterionMarkField(row.position),
      criterionMarkValue({
        criterion: row.criterion,
        verdict: row.verdict as CriterionVerdict,
        evidence: JSON.parse(row.evidence) as string[],
        note: row.note,
        markedBy: row.marked_by,
        runId: row.run_id,
        markedAt: row.marked_at,
      }),
    ]),
  );
}


/**
 * Carry an issue's marks across an edit of its criteria (`followCriterionMarks` decides where each
 * goes): the rows are rewritten here, and what changed comes back as the fields a milestone update
 * journals (`criterion<n>`, null where a position lost its mark), so every device moves them alike.
 */
export function followMarksAcrossEdit(
  db: DatabaseSync,
  issueId: string,
  before: readonly string[],
  after: readonly string[],
): { moves: CriterionMarkMoves; fields: Record<string, CriterionMarkValue | null> } {
  const held = new Map(
    Object.entries(criterionMarkFields(db, issueId)).map(([field, value]) => [criterionMarkPosition(field)!, value] as const),
  );
  const { moves, placement } = followCriterionMarks(
    before,
    after,
    [...held].map(([position, value]) => ({ position, criterion: value.criterion, verdict: value.verdict })),
  );
  const next = new Map<number, CriterionMarkValue>();
  for (const [from, to] of placement) if (to !== null) next.set(to, held.get(from)!);
  const fields: Record<string, CriterionMarkValue | null> = {};
  for (const position of new Set([...held.keys(), ...next.keys()])) {
    const value = next.get(position) ?? null;
    const was = held.get(position) ?? null;
    if (value === was) continue;
    writeCriterionMark(db, issueId, position, value);
    fields[criterionMarkField(position)] = value;
  }
  return { moves, fields };
}
