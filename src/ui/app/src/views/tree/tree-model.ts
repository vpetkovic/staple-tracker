/**
 * Where a row goes, in what order, and what the connector under it looks like — V5 (STA-97).
 *
 * This is the whole placement rule of the tree view, kept as pure functions so the thing
 * that is genuinely easy to get wrong is also the thing that is cheap to pin down in a test.
 * Nothing here renders, reads a clock, or touches storage.
 *
 * ── THE INVARIANT (row spec §1) ───────────────────────────────────────────────────────
 *
 *   > Every task in the "In Progress" group is in progress.
 *
 * A task is placed in the group of its OWN status. That sounds obvious and the obvious
 * implementation gets it wrong: the natural thing is to walk the parent tree and put each
 * family under its head, which drops an in-progress child into the Backlog group. Then the
 * header is a lie, the count counts something else, and — once done/cancelled are hidden by
 * default — a live child of a finished parent silently vanishes from the tracker.
 *
 * The cost is stated plainly in the spec and is worth restating here, because it is the
 * first thing a reader will want to "fix": in status-grouped mode YOU DO NOT SEE THE WHOLE
 * TREE IN ONE PLACE. A parent and child with different statuses appear in different groups
 * and the child carries a breadcrumb chip instead of an indent. That is the correct trade —
 * status grouping is a triage view whose job is "what is happening right now", not "how is
 * this epic shaped". The graph view and the detail drawer's children list own the whole-tree
 * question properly.
 *
 * `buildGroups` therefore takes placement inputs and derives none of them. When V4's
 * grouping control grows a `group by: none` mode (spec §18 Q3), it supplies a different
 * bucketing and reuses every row component untouched.
 */
import {
  OPEN_STATUS_ORDER,
  RESOLVED_STATUSES,
  type ClaimActivity,
  type Issue,
  type IssuePriority,
  type IssueRow,
  type IssueStatus,
  type PullRequestRef,
} from "@/lib/types";

/**
 * Group order: the open statuses in board order, then the resolved ones.
 *
 * DERIVED, NOT RETYPED. Two constants that both know the column order will drift, and the
 * board already learned that lesson once.
 */
export const GROUP_ORDER: readonly IssueStatus[] = [...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES];

/** Title Case for a group header. `in_progress` is two words to a reader, one to the wire. */
export const STATUS_LABEL: Record<IssueStatus, string> = {
  backlog: "Backlog",
  todo: "Todo",
  in_progress: "In Progress",
  in_review: "In Review",
  done: "Done",
  blocked: "Blocked",
  cancelled: "Cancelled",
};

/**
 * THE ONE PLACE "hidden unless asked for" is decided — V4 (STA-89) rewires exactly here.
 *
 * V5 must not ship its own "show done" control and must not hardcode the exclusion at a
 * call site either, or turning the filter on becomes a hunt. `buildGroups` consults this
 * and nothing else does.
 */
export function isResolvedStatus(status: IssueStatus): boolean {
  return RESOLVED_STATUSES.includes(status);
}

/**
 * Groups whose parents start expanded. Active work is what you came to see; a fully
 * expanded backlog is a wall. This is a DEFAULT, not a rule — an explicit toggle on any
 * row overrides it and persists (see expansion.ts).
 */
export const DEFAULT_EXPANDED_GROUPS: ReadonlySet<IssueStatus> = new Set<IssueStatus>([
  "in_progress",
  "in_review",
  "blocked",
]);

/** 20px per level (§11.1). */
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
 * Row grid geometry. MIRRORED IN tree-row.css — the grid template there uses these same
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
 * and clear of every glyph on the child row. Everything else in §11.2 — 1px
 * `--border-strong`, 6px radius, terminate-on-last-child, ancestor rails — is unchanged.
 */
export function guideX(level: number): number {
  return ROW_PAD_LEFT + indentPx(level) + COL_SELECT + COL_GAP + COL_DISCLOSURE / 2;
}

const PRIORITY_RANK: Record<IssuePriority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** The parent chip a cross-group child wears instead of an indent. */
export interface Breadcrumb {
  identifier: string;
  title: string;
}

/**
 * One rendered line. Everything the row component needs and nothing it has to derive.
 *
 * `claim` rides along because the working pill is impossible without it — and because the
 * view used to drop it: `groupByWorkspace()` mapped `IssueRow[] -> Issue[]` and threw the
 * liveness the server had already batched a query to produce. That map is deleted; this
 * type is the shape that replaces it.
 */
export interface TreeRow {
  issue: Issue;
  claim: ClaimActivity | null;
  workspace: string;
  pullRequests?: PullRequestRef[];
  /** Depth WITHIN THE GROUP. A family head is depth 0 wherever it sits in the real tree. */
  depth: number;
  hasChildren: boolean;
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

export interface StatusGroup {
  status: IssueStatus;
  /** Rows to render — children of a collapsed parent are absent. */
  rows: TreeRow[];
  /**
   * How many tasks are in this group, collapsed or not. Deliberately NOT `rows.length`:
   * a count that follows what is rendered says zero for a collapsed group, which deletes
   * the only reason the count exists.
   */
  count: number;
}

export interface BuildOptions {
  /** Whether a parent's children are shown. Owned by expansion.ts, injected here. */
  isExpanded: (issue: Issue) => boolean;
  /**
   * Whether resolved statuses may form groups. THE ONE PLACE the hide-resolved default is
   * applied inside V5 — and in the live app it is now handed `true`, because V4 (STA-89)
   * landed and `lib/filters.ts` decides this upstream. Gating twice would silently break
   * V4's second, subtler rule: selecting the "Done" status IS the opt-in, so a user who
   * filters for Done gets rows that a hardcoded exclusion here would throw away again, and
   * would be shown an empty list and told the filter is broken.
   */
  showResolved?: boolean;
  /**
   * `issue.id -> the parent that is NOT in `rows``, for breadcrumbs across a filter rather
   * than across a group. This is V4's `hiddenParents()` output, passed straight through.
   *
   * It matters because a done epic disappears under the default filter while its
   * in-progress children stay — correctly — and those children would otherwise be rendered
   * at depth 0 with no indication of where they came from.
   */
  hiddenParents?: ReadonlyMap<string, Issue>;
}

/**
 * Sort key within a group: priority, then newest update, then identifier.
 *
 * The identifier tiebreak is not cosmetic. The view refetches every 1.5s on the fingerprint
 * poll, and two rows that compare equal are free to swap on every rebuild — which reads as
 * the list twitching under the pointer. Numeric-aware so STA-9 precedes STA-10.
 */
function compareRows(a: Issue, b: Issue): number {
  const byPriority = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
  if (byPriority !== 0) return byPriority;
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? 1 : -1;
  return a.identifier.localeCompare(b.identifier, undefined, { numeric: true });
}

/**
 * Bucket by own status, nest only within a bucket, emit rows depth-first.
 *
 * The two-pass shape matters: `presentAnywhere` is built from the WHOLE input, not from the
 * bucket, so "my parent is in another group" and "my parent does not exist" stay different
 * answers. The first earns a breadcrumb; the second earns silence, because a chip pointing
 * at a ticket the reader cannot see is worse than no chip.
 */
export function buildGroups(rows: IssueRow[], options: BuildOptions): StatusGroup[] {
  const { isExpanded, showResolved = false, hiddenParents } = options;

  const visible = showResolved ? rows : rows.filter((r) => !isResolvedStatus(r.issue.status));
  const presentAnywhere = new Map(rows.map((r) => [r.issue.id, r.issue]));

  const buckets = new Map<IssueStatus, IssueRow[]>();
  for (const r of visible) {
    const bucket = buckets.get(r.issue.status);
    if (bucket) bucket.push(r);
    else buckets.set(r.issue.status, [r]);
  }

  const out: StatusGroup[] = [];

  for (const status of GROUP_ORDER) {
    const bucket = buckets.get(status);
    // Empty groups do not render. A "Blocked 0" header is permanent furniture announcing
    // a non-event, and furniture stops being read within a day.
    if (!bucket || bucket.length === 0) continue;

    const inGroup = new Map(bucket.map((r) => [r.issue.id, r]));
    const children = new Map<string, IssueRow[]>();
    const roots: IssueRow[] = [];

    for (const r of bucket) {
      const parentId = r.issue.parentId;
      // Nesting happens ONLY where parent and child landed in the same group.
      if (parentId && inGroup.has(parentId)) {
        const bucketed = children.get(parentId);
        if (bucketed) bucketed.push(r);
        else children.set(parentId, [r]);
      } else {
        roots.push(r);
      }
    }

    const byIssue = (a: IssueRow, b: IssueRow) => compareRows(a.issue, b.issue);
    roots.sort(byIssue);
    for (const list of children.values()) list.sort(byIssue);

    const rendered: TreeRow[] = [];

    const walk = (list: IssueRow[], depth: number, ancestorGuides: boolean[]): void => {
      list.forEach((r, index) => {
        const kids = children.get(r.issue.id) ?? [];
        const isLast = index === list.length - 1;
        // Two ways to lose your parent, both worth a chip: it landed in another GROUP, or
        // it was removed by a FILTER. The first is on the page somewhere, the second is not
        // — and neither is a reason to render a child as though it were a root.
        const parent = r.issue.parentId
          ? (presentAnywhere.get(r.issue.parentId) ?? hiddenParents?.get(r.issue.id))
          : undefined;

        rendered.push({
          issue: r.issue,
          claim: r.claim,
          workspace: r.workspace,
          pullRequests: r.pullRequests,
          depth,
          hasChildren: kids.length > 0,
          childCount: kids.length,
          guides: depth === 0 ? [] : [...ancestorGuides, !isLast],
          isLast,
          // A nested child is placed by lineage and the elbow already says so; only a row
          // that could NOT be nested needs to name the parent it belongs to.
          breadcrumb:
            depth === 0 && parent
              ? { identifier: parent.identifier, title: parent.title }
              : null,
        });

        if (kids.length > 0 && isExpanded(r.issue)) {
          walk(kids, depth + 1, depth === 0 ? [] : [...ancestorGuides, !isLast]);
        }
      });
    };

    walk(roots, 0, []);
    out.push({ status, rows: rendered, count: bucket.length });
  }

  return out;
}
