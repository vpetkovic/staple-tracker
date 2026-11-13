/**
 * Links from an idea to tracker work, one `plan_links` row each (design/plan.md, "Links").
 *
 * On the wire each link is one field of the idea's `milestone` entity, `planLink.<issue id>`,
 * whose value is `{ linkedBy, linkedAt }` and whose null is an unlink. That is the shape
 * criterion marks use (`criterion<n>`): the service folds the entity's keys one by one, so
 * two devices linking different work write two fields, never one, and both links arrive.
 * Linking and unlinking the same issue on two devices is one field, and a conflict like any
 * other.
 */
import type { DatabaseSync } from "node:sqlite";

export const PLAN_LINK_PREFIX = "planLink.";

export function planLinkField(issueId: string): string {
  return `${PLAN_LINK_PREFIX}${issueId}`;
}

/** The issue id a field names, or null when it is not a link field. */
export function planLinkIssue(field: string): string | null {
  if (!field.startsWith(PLAN_LINK_PREFIX)) return null;
  const id = field.slice(PLAN_LINK_PREFIX.length);
  return id.length > 0 && id.length <= 128 ? id : null;
}

export interface PlanLinkValue {
  linkedBy: string;
  linkedAt: string;
}

/** A wire value read back as a link; null for an unlink or a value that is not one. */
export function planLinkFromValue(value: unknown): PlanLinkValue | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.linkedBy !== "string" || typeof v.linkedAt !== "string") return null;
  return { linkedBy: v.linkedBy, linkedAt: v.linkedAt };
}

/** Write one link, or remove it with null. */
export function writePlanLink(db: DatabaseSync, ideaId: string, issueId: string, value: PlanLinkValue | null): void {
  if (value === null) {
    db.prepare("DELETE FROM plan_links WHERE idea_id = ? AND issue_id = ?").run(ideaId, issueId);
    return;
  }
  db.prepare(
    `INSERT INTO plan_links (idea_id, issue_id, linked_by, linked_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (idea_id, issue_id) DO UPDATE SET linked_by = excluded.linked_by, linked_at = excluded.linked_at`,
  ).run(ideaId, issueId, value.linkedBy, value.linkedAt);
}

/** An idea's links as the wire carries them, one field each. */
export function planLinkFields(db: DatabaseSync, ideaId: string): Record<string, PlanLinkValue> {
  const rows = db
    .prepare("SELECT issue_id, linked_by, linked_at FROM plan_links WHERE idea_id = ? ORDER BY linked_at, issue_id")
    .all(ideaId) as Array<{ issue_id: string; linked_by: string; linked_at: string }>;
  return Object.fromEntries(rows.map((row) => [planLinkField(row.issue_id), { linkedBy: row.linked_by, linkedAt: row.linked_at }]));
}

/** The issue ids an idea links, in the order they were linked. Some may name no issue any more. */
export function planLinksOf(db: DatabaseSync, ideaId: string): string[] {
  return (db.prepare("SELECT issue_id FROM plan_links WHERE idea_id = ? ORDER BY linked_at, issue_id").all(ideaId) as Array<{ issue_id: string }>).map(
    (row) => row.issue_id,
  );
}

/** Every record's links in one read, each list in `planLinksOf`'s order: what the plan's derivation reads. */
export function allPlanLinks(db: DatabaseSync): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const row of db.prepare("SELECT idea_id, issue_id FROM plan_links ORDER BY linked_at, issue_id").all() as Array<{ idea_id: string; issue_id: string }>) {
    const list = out.get(row.idea_id) ?? [];
    list.push(row.issue_id);
    out.set(row.idea_id, list);
  }
  return out;
}
