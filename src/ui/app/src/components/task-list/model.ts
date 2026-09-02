/**
 * What a task row IS, and the geometry it is drawn against — R4 (STA-102).
 *
 * Lifted verbatim out of `views/tree/tree-model.ts`, which is now only about PLACEMENT
 * (which group a task lands in, how a subtree flattens). The split is the whole point of
 * this ticket: a detail panel and a command palette both want to render a task line and
 * neither has any business importing the tree's bucketing rules to do it.
 *
 * Nothing here renders, reads a clock, or touches storage.
 */
import type {
  ClaimActivity,
  Issue,
  IssueDeps,
  IssueStatus,
  PullRequestRef,
  WorklogSummary,
} from "@/lib/types";

/** Title Case for a status. `in_progress` is two words to a reader, one to the wire. */
export const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

/** 20px per level (row spec §11.1). */
export const INDENT_STEP = 20;

/**
 * Past six levels the indent stops growing. The store's own depth cap makes this largely
 * theoretical, which is precisely why it should cost one `Math.min` and no more thought
 * than that: rows stay legible and the title column never starves.
 */
export const MAX_INDENT_DEPTH = 6;

export function indentPx(depth: number): number {
  return Math.min(Math.max(depth, 0), MAX_INDENT_DEPTH) * INDENT_STEP;
}

/**
 * Row grid geometry. MIRRORED IN task-list.css — the grid template there uses these same
 * numbers, and this is the only duplication in the module. It exists because the connector
 * rails are absolutely positioned by JavaScript and CSS cannot tell it where a named grid
 * column starts. If you change one, change the other; a mismatch is instantly visible as a
 * connector that misses the chevron it is supposed to hang from.
 */
export const ROW_PAD_LEFT = 8;
export const COL_SELECT = 24;
export const COL_DISCLOSURE = 16;
export const COL_GAP = 8;

/**
 * The x a connector hangs from, for a parent sitting at `level`.
 *
 * ── DELIBERATE DEVIATION FROM SPEC §11.2, AND WHY IT HAD TO BE ONE ────────────────────
 *
 * The spec puts the origin at the centre of the parent's IDENTIFIER column. That number
 * does not work against the spec's own grid: the identifier column centre lands roughly
 * 110px in, while the CHILD's priority glyph — where §11.2 says the horizontal segment must
 * terminate — starts around 84px in. The elbow would have to run backwards. (The spec's own
 * arithmetic, `24 + 16 + 8 + idWidth/2`, also omits two of the three column gaps, so its
 * "≈78" is short of its own layout; either way the ordering is wrong.)
 *
 * The origin used instead is the centre of the parent's DISCLOSURE column — under the
 * chevron. That is where the eye already is when it decides to expand something, it is what
 * Linear actually does, and the arithmetic closes: origin at 48 + 20·level, a 12px elbow
 * landing exactly on the child's own disclosure column, entirely inside the indent gutter
 * and clear of every glyph on the child row.
 *
 * R4 adds one parameter and no new geometry: when the select column is switched off
 * (STA-101, and every constrained container) the whole grid shifts left by that column's
 * width plus its gap, and the rails have to shift with it or they hang off the wrong glyph.
 * Handling it here rather than at each call site is the difference between one arithmetic
 * fact and three copies of it.
 */
export function guideX(level: number, hasSelectColumn = true): number {
  const select = hasSelectColumn ? COL_SELECT + COL_GAP : 0;
  return ROW_PAD_LEFT + indentPx(level) + select + COL_DISCLOSURE / 2;
}

/** The parent chip a cross-group child wears instead of an indent. */
export interface Breadcrumb {
  identifier: string;
  title: string;
}

/**
 * One rendered line. Everything the row component needs and nothing it has to derive.
 *
 * `claim` rides along because the working pill is impossible without it — and because the
 * tree view used to drop it: `groupByWorkspace()` mapped `IssueRow[] -> Issue[]` and threw
 * away the liveness the server had already batched a query to produce.
 *
 * Everything from `depth` down is TREE-SHAPED: a flat list passes depth 0, no guides and no
 * breadcrumb, and the row renders correctly because each of those is CHECKED rather than
 * assumed. That is what lets one component serve a treegrid, a drawer and a popup.
 */
export interface TaskRow {
  issue: Issue;
  claim: ClaimActivity | null;
  workspace: string;
  pullRequests?: PullRequestRef[];
  /**
   * The latest checkpoint, or nothing — W1 (STA-113), rendered by W4 (STA-116).
   *
   * A SIBLING of `issue` and of `claim`, never a field on the issue, for the reason
   * `claim` is one: a different clock than the entity. And OPTIONAL, though the server
   * always sends it, because a caller with no summary (a fixture, a synthesised row)
   * passes nothing and every view is then obliged to CHECK the field rather than assume
   * it. That is the discipline that keeps a missing worklog from ever rendering as a
   * present-but-empty one.
   *
   * It is NOT a second reading of `claim`. `claim.lastActivityAt` says the holder did
   * something; `worklog.updatedAt` says the holder left a handoff behind. The gap
   * between those two is the entire point of the field — see lib/worklog.ts.
   */
  worklog?: WorklogSummary | null;
  /** Unresolved blockers and open dependents, by identifier — O6 (STA-138). */
  deps?: IssueDeps;
  /** Depth WITHIN THE GROUP. A family head is depth 0 wherever it sits in the real tree. */
  depth: number;
  hasChildren: boolean;
  /**
   * Is this parent's subtree shown? Decided by the placement pass, not by the renderer.
   *
   * It has to live here because the DEFAULT depends on the shape of the list — a parent with
   * no explicit choice is expanded by one rule when the list is grouped by status and by a
   * different one when it is flat (see views/tree/tree-model.ts). A chevron that consulted a
   * hook while the rows were built by a model would eventually point the wrong way.
   */
  isExpanded: boolean;
  /** Children in this same group — what a collapsed parent's `+N` chip declares. */
  childCount: number;
  /**
   * One entry per level from 0 to `depth - 1`: does a vertical rail continue BELOW this row
   * at that level. The last entry is this row's own level and is `!isLast`; the earlier ones
   * are ancestor rails whose subtrees are not yet exhausted.
   */
  guides: boolean[];
  isLast: boolean;
  /** Set only when the parent exists but landed in another group (§11.3). */
  breadcrumb: Breadcrumb | null;
}

/**
 * Does this row BELONG TO something — O5 (STA-137).
 *
 * One line, and it lives here rather than inline in the row for the reason every other
 * derivation in this file does: three surfaces ask the question (the tree, the panel's
 * children list, the palette) and a fourth — the tests — has to ask it the same way.
 *
 * It reads `parentId` and nothing else. In particular it does NOT consult `depth` or
 * `guides`: those are PLACEMENT facts, true only in a tree, and every surface the connector
 * glyph was actually asked for renders flat at depth 0. A row that is both a child and a
 * parent answers `true`, because the question is what it belongs to, not what belongs to it.
 */
export function isSubtask(row: Pick<TaskRow, "issue">): boolean {
  return row.issue.parentId !== null;
}

/** The three fields `/api/issues` actually sends for a task, before any placement runs. */
export interface TaskSource {
  issue: Issue;
  claim: ClaimActivity | null;
  workspace: string;
  pullRequests?: PullRequestRef[];
  worklog?: WorklogSummary | null;
  deps?: IssueDeps;
}

/**
 * The flat-list shorthand: a row that is not in a tree.
 *
 * It exists so a consumer never has to write
 * `{ depth: 0, hasChildren: false, childCount: 0, guides: [], isLast: true, breadcrumb: null }`
 * — six fields it does not care about, five of which are easy to get subtly wrong in a way
 * that only shows up as a connector rail drawn in a panel that has no tree in it.
 */
export function flatRow(source: TaskSource, over: Partial<TaskRow> = {}): TaskRow {
  return {
    issue: source.issue,
    claim: source.claim,
    workspace: source.workspace,
    pullRequests: source.pullRequests,
    worklog: source.worklog,
    deps: source.deps,
    depth: 0,
    hasChildren: false,
    isExpanded: false,
    childCount: 0,
    guides: [],
    isLast: true,
    breadcrumb: null,
    ...over,
  };
}
