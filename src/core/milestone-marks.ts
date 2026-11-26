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
  placeCriterionMarks,
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


/** Every mark a milestone holds, by stored position. */
function heldMarks(db: DatabaseSync, issueId: string): Map<number, CriterionMarkValue> {
  return new Map(
    Object.entries(criterionMarkFields(db, issueId)).map(([field, value]) => [criterionMarkPosition(field)!, value] as const),
  );
}

/** Rewrite the stored marks as `next`, returning the fields that changed (null where a position lost its mark). */
function rewriteMarks(
  db: DatabaseSync,
  issueId: string,
  held: ReadonlyMap<number, CriterionMarkValue>,
  next: ReadonlyMap<number, CriterionMarkValue>,
): Record<string, CriterionMarkValue | null> {
  const fields: Record<string, CriterionMarkValue | null> = {};
  for (const position of new Set([...held.keys(), ...next.keys()])) {
    const value = next.get(position) ?? null;
    const was = held.get(position) ?? null;
    if (value === was) continue;
    writeCriterionMark(db, issueId, position, value);
    fields[criterionMarkField(position)] = value;
  }
  return fields;
}

/** The held marks in the shape `placeCriterionMarks` reads, each carrying its stored value. */
function readable(held: ReadonlyMap<number, CriterionMarkValue>) {
  return [...held].map(([position, value]) => ({ position, criterion: value.criterion, markedAt: value.markedAt, markedBy: value.markedBy, value }));
}

/**
 * Before a mark is written at `position`, move the mark stored there to where it reads
 * (`placeCriterionMarks`) when that is elsewhere, so the write cannot land on it: a mark judged on
 * another device by an old position stays on its criterion. Only then are the marks rewritten
 * where they read, so a write that lands on its own criterion's mark (or on an empty position)
 * touches no other field and cannot conflict on a criterion nobody touched. A mark that reads on
 * no criterion, or was superseded, stays stored (and reported) unless a moved mark now goes where
 * it sits; a criteria edit clears it. Returns the fields that changed, for the journal.
 */
export function placeMarksBeforeMark(
  db: DatabaseSync,
  issueId: string,
  criteria: readonly string[],
  position: number,
): Record<string, CriterionMarkValue | null> {
  const held = heldMarks(db, issueId);
  const there = held.get(position);
  if (there === undefined) return {};
  const { placed, superseded, cleared } = placeCriterionMarks(criteria, readable(held));
  if (placed.get(position)?.value === there) return {};
  const next = new Map([...placed].map(([at, mark]) => [at, mark.value] as const));
  for (const mark of [...superseded, ...cleared]) if (!next.has(mark.position)) next.set(mark.position, mark.value);
  return rewriteMarks(db, issueId, held, next);
}

/**
 * Carry an issue's marks across an edit of its criteria (`followCriterionMarks` decides where each
 * goes), from where each reads now (`placeCriterionMarks`): the rows are rewritten here, and what
 * changed comes back as the fields a milestone update journals (`criterion<n>`, null where a
 * position lost its mark), so every device moves them alike. A mark that read on no criterion, or
 * was superseded, before the edit is cleared by it, and named in `moves.cleared`.
 */
export function followMarksAcrossEdit(
  db: DatabaseSync,
  issueId: string,
  before: readonly string[],
  after: readonly string[],
  positions?: ReadonlyMap<number, number | null>,
): { moves: CriterionMarkMoves; fields: Record<string, CriterionMarkValue | null> } {
  const held = heldMarks(db, issueId);
  const reading = placeCriterionMarks(before, readable(held));
  const placedMarks = [...reading.placed].map(([position, mark]) => ({ position, criterion: mark.criterion, verdict: mark.value.verdict, value: mark.value }));
  const { moves, placement } = followCriterionMarks(before, after, placedMarks, positions);
  const byPosition = new Map(placedMarks.map((mark) => [mark.position, mark.value] as const));
  const next = new Map<number, CriterionMarkValue>();
  for (const [from, to] of placement) if (to !== null) next.set(to, byPosition.get(from)!);
  for (const mark of [...reading.superseded, ...reading.cleared]) moves.cleared.push({ criterion: mark.criterion, verdict: mark.value.verdict, position: mark.position });
  moves.cleared.sort((a, b) => a.position - b.position);
  return { moves, fields: rewriteMarks(db, issueId, held, next) };
}
