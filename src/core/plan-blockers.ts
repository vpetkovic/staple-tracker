/**
 * Idea blockers: one plan record waits on another, as a structured edge (design/plan.md,
 * "Dependencies between records"). One `plan_blockers` row each (migration 030).
 *
 * On the wire each edge is one field of the blocked record's `milestone` entity,
 * `planBlocker.<blocker id>`, whose value is `true` and whose null removes it: the shape plan
 * links use (`plan-links.ts`). The value is a constant on purpose: two devices that add the same
 * edge offline write the same value, which is no conflict, and two that add different edges
 * write two fields, both kept. Adding an edge on one device and removing it on another is one
 * field with two answers, a conflict like any other.
 *
 * The text a plan's Dependencies section holds keeps naming records too (`resolveDependencies`):
 * a record's `dependsOn` is both, and only these edges hold Scaffold back.
 */
import type { DatabaseSync } from "node:sqlite";

export const PLAN_BLOCKER_PREFIX = "planBlocker.";

export function planBlockerField(blockerId: string): string {
  return `${PLAN_BLOCKER_PREFIX}${blockerId}`;
}

/** The blocker id a field names, or null when it is not a blocker field. */
export function planBlockerId(field: string): string | null {
  if (!field.startsWith(PLAN_BLOCKER_PREFIX)) return null;
  const id = field.slice(PLAN_BLOCKER_PREFIX.length);
  return id.length > 0 && id.length <= 128 ? id : null;
}

/** A wire value read back: true for an edge, null for a removal, undefined for a value that is not one. */
export function planBlockerFromValue(value: unknown): true | null | undefined {
  if (value === null) return null;
  return value === true ? true : undefined;
}

/** Write one edge, or remove it with null. */
export function writePlanBlocker(db: DatabaseSync, ideaId: string, blockerId: string, value: true | null): void {
  if (value === null) {
    db.prepare("DELETE FROM plan_blockers WHERE idea_id = ? AND blocker_id = ?").run(ideaId, blockerId);
    return;
  }
  db.prepare("INSERT INTO plan_blockers (idea_id, blocker_id) VALUES (?, ?) ON CONFLICT (idea_id, blocker_id) DO NOTHING").run(ideaId, blockerId);
}

/** A record's edges as the wire carries them, one field each. */
export function planBlockerFields(db: DatabaseSync, ideaId: string): Record<string, true> {
  const rows = db.prepare("SELECT blocker_id FROM plan_blockers WHERE idea_id = ? ORDER BY blocker_id").all(ideaId) as Array<{ blocker_id: string }>;
  return Object.fromEntries(rows.map((row) => [planBlockerField(row.blocker_id), true as const]));
}

/** Every record's blockers in one read, by blocked record: what the plan's derivation reads. */
export function allPlanBlockers(db: DatabaseSync): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of db.prepare("SELECT idea_id, blocker_id FROM plan_blockers ORDER BY idea_id, blocker_id").all() as Array<{ idea_id: string; blocker_id: string }>) {
    const list = out.get(row.idea_id) ?? [];
    list.push(row.blocker_id);
    out.set(row.idea_id, list);
  }
  return out;
}
