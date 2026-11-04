/**
 * A MILESTONE IS THE TOP OF THE TREE IN THE TASKS LIST.
 *
 * Membership is a relation, not a parent link: adding an epic to a milestone never touches
 * its `parentId`, so the list used to draw the milestone and its own epic as two unrelated
 * roots. VP chose (2026-09-28) to show the plan as a hierarchy instead, and this is the one
 * place that decides it.
 *
 * The rule is PLACEMENT ONLY, and it has two halves:
 *
 *   - A row with NO parent that is a direct member of a milestone present in the same
 *     workspace is placed under that milestone, by giving the list's copy of it the
 *     milestone as `parentId`. Everything downstream (nesting, ghosts, rollups, the
 *     collapsed `+N`, keyboard order) reads `parentId`, so it all follows for free.
 *   - A REAL PARENT ALWAYS WINS. A task that belongs to an epic stays under that epic
 *     even when the task itself is a member; its milestone still shows as a cue.
 *
 * It runs on the list's rows and nowhere else. The detail, the filters' epic dimension and
 * every write read the served issue, never this copy.
 *
 * A row already nested under the milestone its cue names drops that cue: the tree says it.
 */
import type { IssueRow } from "@/lib/types";
import { MILESTONE_KIND } from "@/detail/plain-actions";

export function placeUnderMilestones(rows: readonly IssueRow[]): IssueRow[] {
  const milestones = new Map<string, IssueRow>();
  for (const row of rows) {
    if (row.issue.kind === MILESTONE_KIND) milestones.set(key(row.workspace, row.issue.id), row);
  }
  if (milestones.size === 0) return rows as IssueRow[];

  const realParentOf = new Map(rows.map((row) => [key(row.workspace, row.issue.id), row.issue.parentId]));
  /** Is `id` on the milestone's own real parent chain? Placing it there would close a cycle. */
  const aboveMilestone = (workspace: string, milestoneId: string, id: string): boolean => {
    const seen = new Set<string>();
    let at = realParentOf.get(key(workspace, milestoneId)) ?? null;
    while (at !== null && !seen.has(at)) {
      if (at === id) return true;
      seen.add(at);
      at = realParentOf.get(key(workspace, at)) ?? null;
    }
    return false;
  };

  const placed = rows.map((row) => {
    const milestoneId = row.milestoneId ?? null;
    if (row.issue.parentId !== null || milestoneId === null) return row;
    if (!milestones.has(key(row.workspace, milestoneId))) return row;
    // A milestone filed under the very epic it contains: the real tree already says it.
    if (aboveMilestone(row.workspace, milestoneId, row.issue.id)) return row;
    return { ...row, issue: { ...row.issue, parentId: milestoneId } };
  });

  // Drop a milestone cue the tree already draws: walk each row's placed chain once.
  const parentOf = new Map(placed.map((row) => [key(row.workspace, row.issue.id), row.issue.parentId]));
  return placed.map((row) => {
    const cue = row.cues?.milestone;
    if (!cue) return row;
    const seen = new Set<string>();
    let parentId = row.issue.parentId;
    while (parentId !== null && !seen.has(parentId)) {
      seen.add(parentId);
      const milestone = milestones.get(key(row.workspace, parentId));
      if (milestone && milestone.issue.identifier === cue.identifier) {
        return { ...row, cues: { ...row.cues!, milestone: null } };
      }
      parentId = parentOf.get(key(row.workspace, parentId)) ?? null;
    }
    return row;
  });
}

function key(workspace: string, id: string): string {
  return `${workspace}\u0000${id}`;
}
