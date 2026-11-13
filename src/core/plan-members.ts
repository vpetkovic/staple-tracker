/**
 * The members a horizon holds through the plan (design/plan.md, "Membership").
 *
 * A horizon is a milestone. Its members come from its plan records without anyone typing them:
 * a promoted record on the horizon is a member, and so is every issue a record on it links.
 * Moving a record moves its work; unscheduling removes it; a member a person put in a
 * milestone by hand (`milestone_members`) stays where it was put and wins over the plan.
 *
 * `plan_members` holds the result on this device. It is rebuilt by one deterministic function of
 * synchronized facts (the records' horizon, rank, kind and links, and which issues exist), so
 * every device that holds the same facts holds the same rows. It is never journaled and never
 * seeded: two devices that move ideas offline exchange only the ideas' fields, which merge per
 * field, and each rebuilds the same membership. A replicated ordered list for it would make two
 * such moves a conflict on the plan for a person to settle.
 */
import type { DatabaseSync } from "node:sqlite";
import { MILESTONE_KIND } from "./milestones.js";
import { IDEA_KIND } from "./plan.js";

interface RecordRow {
  id: string;
  kind: string;
  plan_horizon_id: string;
  plan_rank: number | null;
}

/**
 * The horizons the plan shows, as a condition on `issues`: a milestone with a plan rank, unless a
 * person removed it. Removing one cancels it by hand, and that cancel is the only status that
 * hides a horizon. Its derived status never does: a horizon whose work is all done is shipped and
 * still a column, and one derivation cancelled (an earlier build did) is still a column, keeps
 * its members, and derives again from them.
 */
export const LISTED_HORIZON = `kind = '${MILESTONE_KIND}' AND plan_rank IS NOT NULL
  AND NOT (status IN (SELECT id FROM workspace_statuses WHERE category = 'cancelled')
           AND (derived_status IS NULL OR derived_status <> status))`;

/** The membership the plan's facts imply: issue id to horizon id, in the plan's order. */
export function derivePlanMembers(db: DatabaseSync): Array<{ issueId: string; milestoneId: string }> {
  const horizons = new Set((db.prepare(`SELECT id FROM issues WHERE ${LISTED_HORIZON}`).all() as Array<{ id: string }>).map((row) => row.id));
  if (horizons.size === 0) return [];
  const records = (
    db
      .prepare("SELECT id, kind, plan_horizon_id, plan_rank FROM issues WHERE plan_maturity IS NOT NULL AND plan_horizon_id IS NOT NULL")
      .all() as unknown as RecordRow[]
  )
    .filter((row) => horizons.has(row.plan_horizon_id))
    // The plan's order, then the UUID: the same order on every device for the same facts.
    .sort((a, b) => (a.plan_rank ?? Number.MAX_SAFE_INTEGER) - (b.plan_rank ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id));
  const kindOf = db.prepare("SELECT kind FROM issues WHERE id = ?");
  const links = db.prepare("SELECT issue_id FROM plan_links WHERE idea_id = ? ORDER BY linked_at, issue_id");
  const out: Array<{ issueId: string; milestoneId: string }> = [];
  const placed = new Set<string>();
  const place = (issueId: string, milestoneId: string) => {
    if (placed.has(issueId) || horizons.has(issueId)) return;
    const kind = (kindOf.get(issueId) as { kind: string } | undefined)?.kind;
    // Only tracker work is a member: not an idea, not a milestone, not an issue this device lacks.
    if (kind === undefined || kind === IDEA_KIND || kind === MILESTONE_KIND) return;
    placed.add(issueId);
    out.push({ issueId, milestoneId });
  };
  for (const record of records) {
    if (record.kind !== IDEA_KIND) place(record.id, record.plan_horizon_id);
    for (const { issue_id } of links.all(record.id) as Array<{ issue_id: string }>) place(issue_id, record.plan_horizon_id);
  }
  return out;
}

/**
 * Rebuild `plan_members` from the plan's facts. Answers the milestones whose derived membership
 * changed, so a caller that wrote the facts can re-derive their status; a device applying a pull
 * receives that re-derivation from the device that made the change.
 */
export function rebuildPlanMembers(db: DatabaseSync): string[] {
  const exists = db.prepare("SELECT 1 AS hit FROM sqlite_master WHERE type = 'table' AND name = 'plan_members'").get() !== undefined;
  if (!exists) return [];
  const next = derivePlanMembers(db);
  const before = new Map(
    (db.prepare("SELECT issue_id, milestone_id, position FROM plan_members").all() as Array<{ issue_id: string; milestone_id: string; position: number }>).map(
      (row) => [row.issue_id, row],
    ),
  );
  const changed = new Set<string>();
  const wanted = new Map(next.map((entry, position) => [entry.issueId, { milestoneId: entry.milestoneId, position }]));
  for (const [issueId, row] of before) {
    const want = wanted.get(issueId);
    if (want === undefined || want.milestoneId !== row.milestone_id || want.position !== row.position) {
      db.prepare("DELETE FROM plan_members WHERE issue_id = ?").run(issueId);
      changed.add(row.milestone_id);
      if (want !== undefined) changed.add(want.milestoneId);
    }
  }
  const insert = db.prepare("INSERT OR IGNORE INTO plan_members (issue_id, milestone_id, position) VALUES (?, ?, ?)");
  for (const [issueId, want] of wanted) {
    const row = before.get(issueId);
    if (row !== undefined && row.milestone_id === want.milestoneId && row.position === want.position) continue;
    insert.run(issueId, want.milestoneId, want.position);
    changed.add(want.milestoneId);
  }
  return [...changed].sort();
}
