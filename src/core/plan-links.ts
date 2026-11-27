/**
 * Links from an idea to tracker work, one `plan_links` row each (design/plan.md, "Links").
 *
 * On the wire each link is one field of the idea's `milestone` entity, `planLink.<issue id>`,
 * whose value is `{ linkedBy, linkedAt }` and whose null is an unlink. That is the shape
 * criterion marks use (`criterion<n>`): the service folds the entity's keys one by one, so
 * two devices linking different work write two fields, never one, and both links arrive.
 * Linking and unlinking the same issue on two devices is one field, and a conflict like any
 * other.
 *
 * A link has a purpose (migration 027). `delivery` is the work the idea stands for: it starts the
 * idea, measures its progress and joins its horizon. `exploration` is research or a proof of
 * concept done while the idea is worked out: listed on the idea on its own, and nothing the idea is
 * measured by. The purpose rides the same field (`purpose: "exploration"` in the value; a delivery
 * link's value carries none), so an issue is linked to an idea one way at a time.
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

export const PLAN_LINK_PURPOSES = ["delivery", "exploration"] as const;
export type PlanLinkPurpose = (typeof PLAN_LINK_PURPOSES)[number];

export interface PlanLinkValue {
  linkedBy: string;
  linkedAt: string;
  /** Present only on an exploration link: a delivery link's value is the shape it always was. */
  purpose?: "exploration";
}

/** A link's value for the wire and the row: the purpose named only when it is exploration. */
export function planLinkValue(linkedBy: string, linkedAt: string, purpose: PlanLinkPurpose): PlanLinkValue {
  return purpose === "exploration" ? { linkedBy, linkedAt, purpose } : { linkedBy, linkedAt };
}

/** The purpose a link value carries. */
export function planLinkPurpose(value: PlanLinkValue): PlanLinkPurpose {
  return value.purpose === "exploration" ? "exploration" : "delivery";
}

/**
 * A wire value read back as a link; null for an unlink or a value that is not one. A purpose
 * other than the two is not a link this build knows how to read, so it is not one.
 */
export function planLinkFromValue(value: unknown): PlanLinkValue | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.linkedBy !== "string" || typeof v.linkedAt !== "string") return null;
  if (v.purpose !== undefined && v.purpose !== "delivery" && v.purpose !== "exploration") return null;
  return planLinkValue(v.linkedBy, v.linkedAt, v.purpose === "exploration" ? "exploration" : "delivery");
}

/** Write one link, or remove it with null. */
export function writePlanLink(db: DatabaseSync, ideaId: string, issueId: string, value: PlanLinkValue | null): void {
  if (value === null) {
    db.prepare("DELETE FROM plan_links WHERE idea_id = ? AND issue_id = ?").run(ideaId, issueId);
    return;
  }
  db.prepare(
    `INSERT INTO plan_links (idea_id, issue_id, linked_by, linked_at, purpose) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (idea_id, issue_id) DO UPDATE SET linked_by = excluded.linked_by, linked_at = excluded.linked_at, purpose = excluded.purpose`,
  ).run(ideaId, issueId, value.linkedBy, value.linkedAt, planLinkPurpose(value));
}

/** An idea's links as the wire carries them, one field each, whatever their purpose. */
export function planLinkFields(db: DatabaseSync, ideaId: string): Record<string, PlanLinkValue> {
  const rows = db
    .prepare("SELECT issue_id, linked_by, linked_at, purpose FROM plan_links WHERE idea_id = ? ORDER BY linked_at, issue_id")
    .all(ideaId) as Array<{ issue_id: string; linked_by: string; linked_at: string; purpose: PlanLinkPurpose }>;
  return Object.fromEntries(rows.map((row) => [planLinkField(row.issue_id), planLinkValue(row.linked_by, row.linked_at, row.purpose)]));
}

/**
 * The issue ids an idea links for a purpose (delivery unless named), in the order they were
 * linked. Some may name no issue any more.
 */
export function planLinksOf(db: DatabaseSync, ideaId: string, purpose: PlanLinkPurpose = "delivery"): string[] {
  return (
    db.prepare("SELECT issue_id FROM plan_links WHERE idea_id = ? AND purpose = ? ORDER BY linked_at, issue_id").all(ideaId, purpose) as Array<{ issue_id: string }>
  ).map((row) => row.issue_id);
}

/** The purpose an idea links an issue for, or null when it does not link it. */
export function planLinkPurposeOf(db: DatabaseSync, ideaId: string, issueId: string): PlanLinkPurpose | null {
  const row = db.prepare("SELECT purpose FROM plan_links WHERE idea_id = ? AND issue_id = ?").get(ideaId, issueId) as { purpose: PlanLinkPurpose } | undefined;
  return row?.purpose ?? null;
}

/**
 * Every record's links in one read, split by purpose, each list in `planLinksOf`'s order: what
 * the plan's derivation reads.
 */
export function allPlanLinks(db: DatabaseSync): { delivery: Map<string, string[]>; exploration: Map<string, string[]> } {
  const out = { delivery: new Map<string, string[]>(), exploration: new Map<string, string[]>() };
  for (const row of db.prepare("SELECT idea_id, issue_id, purpose FROM plan_links ORDER BY linked_at, issue_id").all() as Array<{
    idea_id: string;
    issue_id: string;
    purpose: PlanLinkPurpose;
  }>) {
    const byRecord = row.purpose === "exploration" ? out.exploration : out.delivery;
    const list = byRecord.get(row.idea_id) ?? [];
    list.push(row.issue_id);
    byRecord.set(row.idea_id, list);
  }
  return out;
}
