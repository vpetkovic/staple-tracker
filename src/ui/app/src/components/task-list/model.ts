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
import { isStaleClaim } from "@/lib/claim";
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
  /**
   * Title Case like its seven neighbours, NOT the "Awaiting approval" the ticket
   * spelled — Q2 (STA-144). This record's contract is the line above, and it is
   * read as a set: a status column reading `In Progress · In Review · Awaiting
   * approval · Done` shows the odd one out as a typo rather than as a decision.
   * Sentence case is the register of the SECTION labels ("Up next", "Pending
   * approval") and of the Gate filter's values, and it is used there.
   */
  awaiting_approval: "Awaiting Approval",
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
  /**
   * What is underneath this parent — O3b (STA-127). Absent on a leaf, and on any surface
   * that does not compute it.
   *
   * OPTIONAL for the reason `worklog` and `deps` are: a caller with nothing to say passes
   * nothing, so every view is obliged to CHECK the field rather than assume it. A rollup
   * that was present-but-empty would render a bar claiming an epic has no children.
   *
   * It is NOT derivable from `childCount`, and the difference is the whole ticket:
   * `childCount` is DIRECT children that survived into this bucket, and the rollup counts
   * every DESCENDANT in the unfiltered list. See `parentRollups`.
   */
  rollup?: ParentRollup | null;
  /**
   * ── THIS ROW IS CONTEXT, NOT CONTENT — O3c (STA-128) ────────────────────────────────
   *
   * A GHOST: a parent that is NOT in this bucket, drawn inside it anyway so the children
   * that are can be nested under it and read as one epic instead of three unrelated rows
   * wearing the same chip. Its parent landed in another group, or a filter removed it.
   *
   * A ghost is a BRACKET AROUND ROWS, not a row, and every consumer has to treat it as
   * one. It is excluded from the group's count, from `visibleOrder` (R6's prev/next
   * contract) and from the keyboard sequence; it is dimmed; it is non-interactive except
   * that clicking it opens the parent. See `views/tree/tree-model.ts`.
   *
   * OPTIONAL for the reason `rollup`, `worklog` and `deps` are: a caller with nothing to
   * say passes nothing, so a surface that has never heard of ghosts CHECKS the field
   * rather than inheriting a default it did not choose. Absent means "an ordinary row",
   * which is what every existing caller means.
   */
  ghost?: boolean;
}

/**
 * ── THE PARENT ROLLUP — O3b (STA-127) ────────────────────────────────────────────────
 *
 * A folded parent is the one row on the page that is hiding something, and today it says
 * only how many. `+3` does not distinguish an epic that is nearly finished from one that
 * has not started, and it does not say that an agent is inside it right now — which is the
 * one fact that would make you unfold it.
 *
 * Everything below is PURE and lives here rather than in `views/tree/tree-model.ts` for the
 * reason the rest of this file does: the detail panel and the command palette render task
 * rows too, and neither has any business importing the tree's bucketing rules to draw a
 * progress bar.
 */

/**
 * The four segments of the bar, in render order. Four and not seven, because a 36px bar
 * split seven ways is a texture rather than a reading.
 */
export type RollupSegment = "done" | "in_progress" | "blocked" | "open";

export const ROLLUP_SEGMENTS: readonly RollupSegment[] = [
  "done",
  "in_progress",
  "blocked",
  "open",
];

/**
 * STATUS CATEGORY -> SEGMENT, which is the mapping that survives O7.
 *
 * O7a made the status set DATA: a workspace may add, rename and reorder statuses, and each
 * one carries a `StatusCategory` from a FIXED set (src/core/types.ts). The category is what
 * a rollup can safely be written against — the ids cannot be, because a workspace with a
 * `qa` status would fall off a table keyed by the built-in seven.
 *
 * `null` means EXCLUDED FROM THE ROLLUP ENTIRELY — see `CANCELLED_IS_NOT_PROGRESS` below.
 */
const CATEGORY_SEGMENT = new Map<string, RollupSegment | null>([
  ["done", "done"],
  ["cancelled", null],
  ["active", "in_progress"],
  ["review", "in_progress"],
  ["gated", "blocked"],
  ["blocked", "blocked"],
  ["ready", "open"],
  ["unstarted", "open"],
]);

/**
 * The same mapping keyed by the BUILT-IN status ids, for today.
 *
 * The browser mirror of the wire vocabulary carries no category — `src/core` is Node-only
 * and O7b (STA-141) is what wires `/api/settings` through to the views. Until it does, this
 * table is what the rollup reads, and it is `BUILTIN_STATUS_SEED`'s categories resolved
 * through the map above rather than an independent opinion, so the two cannot disagree
 * about the seeded seven.
 */
const BUILTIN_STATUS_SEGMENT = new Map<IssueStatus, RollupSegment | null>([
  ["done", "done"],
  ["cancelled", null],
  ["in_progress", "in_progress"],
  ["in_review", "in_progress"],
  ["blocked", "blocked"],
  ["todo", "open"],
  ["backlog", "open"],
]);

/**
 * CANCELLED IS NOT PROGRESS, AND IT IS NOT WORK EITHER.
 *
 * The bar has four segments and none of them is cancelled, which leaves exactly three
 * options and only one of them is honest:
 *
 *   - count it as `done`  — claims credit for work that was abandoned;
 *   - keep it in `total` with no segment — gives the bar a denominator it can never reach,
 *     so a finished epic renders permanently short of full and reads as stuck;
 *   - drop it from both.
 *
 * The third is what this does, and it buys an invariant worth having: the four segments SUM
 * TO `total` by construction, which is what makes the bar drawable from the segments alone
 * with no remainder to reconcile.
 *
 * A status the tables do not mention resolves to `open` — work that is not done. Never
 * silently dropped: a denominator that quietly shrinks is worse than a coarse bucket.
 */
export function rollupSegmentOf(
  status: IssueStatus,
  categoryOf?: (status: IssueStatus) => string | null | undefined,
): RollupSegment | null {
  const category = categoryOf?.(status);
  if (category != null) {
    return CATEGORY_SEGMENT.has(category) ? (CATEGORY_SEGMENT.get(category) ?? null) : "open";
  }
  return BUILTIN_STATUS_SEGMENT.has(status)
    ? (BUILTIN_STATUS_SEGMENT.get(status) ?? null)
    : "open";
}

/**
 * A live descendant claim, named. NEVER a stale one — see `parentRollups`.
 *
 * The identifier rides along because the accessible name has to say WHICH child is live.
 * "opus-x is working" on a parent row is indistinguishable from the parent's own claim,
 * which is the one confusion this element must not create.
 */
export interface RollupLive {
  heldBy: string;
  identifier: string;
}

/** What is underneath one parent, over the rows it was computed from. */
export interface ParentRollup {
  /** Strict descendants that count. The four segments sum to exactly this. */
  total: number;
  /** Of `total`, how many are in the `done` segment. The numerator of `resolved/total`. */
  resolved: number;
  /** Counts per segment; every segment present, zeros included, so the bar can just map. */
  segments: Readonly<Record<RollupSegment, number>>;
  /** The most recently active LIVE descendant claim, or null. */
  live: RollupLive | null;
}

/** The minimum a row has to be for the rollup to place it. `TaskRow` and `IssueRow` both fit. */
export interface RollupInput {
  issue: Pick<Issue, "id" | "parentId" | "identifier" | "status">;
  claim: ClaimActivity | null;
}

export interface RollupOptions {
  /**
   * O7b's seam (STA-141): the configured category of a status. When it answers, the
   * category tables above decide; when it is absent the built-in ids do. Optional so every
   * caller today compiles untouched and nothing about the mapping changes when it arrives.
   */
  categoryOf?: (status: IssueStatus) => string | null | undefined;
}

/**
 * WHAT IS UNDERNEATH EVERY PARENT, in one pass over the ancestor chains.
 *
 * `issue.id -> ParentRollup`, strict descendants only, at EVERY depth — a grandchild counts
 * exactly as much as a child, because an epic's progress is the progress of everything
 * under it and a task is not less finished for being one level further down. That falls out
 * of `forEachAncestor` for free: every row walks up to all of its ancestors, so a
 * grandparent is reached on the same pass as a parent, with no recursion and no depth bound.
 *
 * ── PASS IT THE UNFILTERED LIST ───────────────────────────────────────────────────────
 *
 * A count computed over the rows on screen is not a count. `done` is hidden by the default
 * filter, so an epic with three finished children and two open ones would read `0/2` —
 * precisely the arithmetic the reader opened the tracker to avoid doing. The caller in
 * `views/tree/tree-model.ts` passes the whole `/api/issues` payload; nothing here refetches
 * anything, and nothing here knows what a filter is.
 *
 * This is deliberately the OPPOSITE choice to O3a's sort, which computes its activity tiers
 * over the VISIBLE rows. The two are not inconsistent — they answer different questions. An
 * ORDER the reader cannot account for from what is in front of them is worse than a plain
 * order; a COUNT that only counts what is in front of them is not a count at all.
 *
 * ── LIVENESS IS `isStaleClaim` AND NOTHING ELSE ───────────────────────────────────────
 *
 * The same judgement the working pill, the takeover buttons and O3a's tier make about the
 * same number. A STALE descendant claim yields NO `live` at all — not a static variant, not
 * a dimmed one. The field exists to say "someone is inside this subtree right now"; an agent
 * that died four hours ago is not, and the row already has a place where a stale claim is
 * drawn honestly — `RowClaimSlot`, on the row that actually owns it.
 *
 * When several descendants are live the MOST RECENTLY ACTIVE one wins, ties broken by
 * identifier. Determinism is not cosmetic here: the view rebuilds every 1.5s on the
 * fingerprint poll, and two live children swapping initials on every poll reads as the row
 * twitching under the pointer.
 */
export function parentRollups(
  rows: readonly RollupInput[],
  options: RollupOptions = {},
): Map<string, ParentRollup> {
  const { categoryOf } = options;
  const acc = new Map<string, Accumulator>();

  forEachAncestor(rows, (row, ancestorId) => {
    let into = acc.get(ancestorId);
    if (!into) {
      into = { total: 0, resolved: 0, segments: emptySegments(), live: null, liveIdle: Infinity };
      acc.set(ancestorId, into);
    }

    const segment = rollupSegmentOf(row.issue.status, categoryOf);
    if (segment !== null) {
      into.segments[segment] += 1;
      into.total += 1;
      if (segment === "done") into.resolved += 1;
    }

    // Considered even when the segment is null: a cancelled ticket somebody is still
    // holding is exactly the handoff risk this indicator exists to surface.
    const { claim } = row;
    if (claim && !isStaleClaim(claim) && beatsIncumbent(claim.idleSeconds, row.issue.identifier, into)) {
      into.live = { heldBy: claim.heldBy, identifier: row.issue.identifier };
      into.liveIdle = claim.idleSeconds;
    }
  });

  const out = new Map<string, ParentRollup>();
  for (const [id, { total, resolved, segments, live }] of acc) {
    out.set(id, { total, resolved, segments, live });
  }
  return out;
}

/**
 * The mutable half of a `ParentRollup` while it is being built.
 *
 * `liveIdle` is carried rather than re-read off the winning row, so the tiebreak costs one
 * comparison instead of a scan back through `rows` on every live descendant — which would
 * have made a wide epic quadratic on a list the poll rebuilds every 1.5 seconds.
 */
interface Accumulator {
  total: number;
  resolved: number;
  segments: Record<RollupSegment, number>;
  live: RollupLive | null;
  liveIdle: number;
}

function emptySegments(): Record<RollupSegment, number> {
  return { done: 0, in_progress: 0, blocked: 0, open: 0 };
}

/**
 * The tiebreak, kept out of the loop body so the loop stays readable.
 *
 * `idleSeconds` is a server reading frozen at response time, so "lowest wins" is "most
 * recently active". The identifier breaks the tie because two agents that both checked in
 * during the same second must still produce ONE stable answer across two rebuilds — and
 * numeric-aware, so STA-9 precedes STA-10 here exactly as it does in the sort.
 */
function beatsIncumbent(idleSeconds: number, identifier: string, into: Accumulator): boolean {
  if (!into.live) return true;
  if (idleSeconds !== into.liveIdle) return idleSeconds < into.liveIdle;
  return identifier.localeCompare(into.live.identifier, undefined, { numeric: true }) < 0;
}

/**
 * THE SUBTREE WALK, ONCE — every row paired with each of its ancestors, upwards.
 *
 * Extracted by O3a (STA-126) for the activity rollup and the flat-mode expansion default,
 * and MOVED HERE by O3b (STA-127) when the parent rollup became a third caller. It did not
 * become a copy: O3a's own note is that two hand-written copies of "walk up the parent
 * chain" is exactly the pair that drifts once and is then wrong in only one view, and the
 * third caller is where that stops being hypothetical.
 *
 * It sits in this file rather than in `views/tree/tree-model.ts` because the rollup is not
 * a placement fact — the panel and the palette can want it — and because a pure module may
 * not import the tree's bucketing rules to get one function.
 *
 * Structurally typed rather than `IssueRow`-typed, so a caller with any row shape carrying
 * an id and a parent can use it. The body and the `seen` cycle guard are O3a's, verbatim:
 * the guard is against a cycle the store should never produce and which would otherwise
 * hang the render rather than draw a wrong row.
 */
export function forEachAncestor<T extends { issue: Pick<Issue, "id" | "parentId"> }>(
  rows: readonly T[],
  visit: (row: T, ancestorId: string) => void,
): void {
  const parentOf = new Map(rows.map((r) => [r.issue.id, r.issue.parentId]));

  for (const r of rows) {
    const seen = new Set<string>();
    let parentId = parentOf.get(r.issue.id) ?? null;
    while (parentId && parentOf.has(parentId) && !seen.has(parentId)) {
      seen.add(parentId);
      visit(r, parentId);
      parentId = parentOf.get(parentId) ?? null;
    }
  }
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
    // A row that is not in a tree has nothing beneath it to roll up. Explicit, not absent,
    // for the same reason every other field here is: the shorthand's whole job is that a
    // caller never has to remember which of these has a no-tree value.
    rollup: null,
    // O3c (STA-128). A row that is not in a tree cannot be standing in for a parent that
    // is missing from a bucket, because there are no buckets. Explicit for the same reason
    // `rollup` is: the shorthand's whole job is that a caller never has to remember which
    // of these has a no-tree value.
    ghost: false,
    ...over,
  };
}
