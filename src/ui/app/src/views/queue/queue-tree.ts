/**
 * The Queue page's stand-ins for rows the page's issue list does not carry: an `Issue` built
 * from an effective row, and the issue list as a lookup by reference. Nothing here renders,
 * fetches, or reads a clock.
 */
import type { EffectiveQueueRow, Issue, IssueRow } from "@/lib/types";

/** A synthesised row has no clock of its own. One constant, not two `Date`s per row. */
const EPOCH = new Date(0).toISOString();

/**
 * An `Issue` for an effective row the page's issue list does not carry.
 *
 * Same shape and same reason as `queue-model.ts`'s `issueFromEntry`. The fields the wire does
 * not send are given their no-information values rather than a guess: a synthesised row
 * draws a kind glyph, a status icon and a title, and claims nothing else.
 */
export function issueFromEffective(row: EffectiveQueueRow): Issue {
  return {
    id: row.issueId,
    identifier: row.identifier,
    title: row.title,
    description: null,
    status: row.status,
    statusVersion: 0,
    kind: row.kind,
    priority: "medium",
    parentId: row.parent,
    depth: 0,
    assignee: null,
    createdBy: "",
    labels: [],
    acceptanceCriteria: null,
    blockParentUntilDone: false,
    unblockOwner: null,
    unblockAction: null,
    originKind: "manual",
    originId: null,
    idempotencyKey: null,
    checkoutAgent: null,
    checkoutAt: null,
    blockedTransitionAt: null,
    estimatedSeconds: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: EPOCH,
    updatedAt: EPOCH,
  };
}

/** The page's issue list as a lookup by reference. One pass, one place. */
export function knownRows(issues: readonly IssueRow[]): Map<string, IssueRow> {
  return new Map(issues.map((row) => [row.issue.identifier, row]));
}
