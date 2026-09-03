/**
 * WHERE A ROW GOES WHEN THE QUESTION IS "WHAT DO I GRAB NEXT" — V5 (STA-111).
 *
 * The sibling of tree-model.ts. That file answers "what is the status of this", this one
 * answers "can I pick this up", and the two are deliberately different axes rather than one
 * axis with more values. Status is a WORKFLOW field somebody set; pickup readiness is
 * DERIVED from status plus unresolved blockers plus who is holding it. Merging them forces
 * ambiguous membership — an in-progress ticket with an unresolved blocker is honestly both
 * "in progress" and "waiting" — and ambiguous membership is exactly what tree-model.ts's §1
 * invariant exists to prevent.
 *
 * Nothing here renders, reads a clock, or touches storage.
 *
 * ── THE ONE DEFINITION OF READY, AND WHY IT IS NOT IN THIS FILE ───────────────────────
 *
 * There is exactly one definition of "ready" in this system and it lives in the store:
 * `store.inbox()`, surfaced over `/api/inbox`. This module does NOT re-derive it. It reads
 * the answer and indexes it.
 *
 * That matters more than it looks. Readiness is dependency-aware — a `todo` ticket with an
 * unresolved blocker is not ready, however much its own status protests — and a second
 * implementation in the browser would be a second thing to keep correct, drifting silently
 * because both would look right on the happy path. The order is borrowed for the same
 * reason: `ready` arrives sorted `in_progress -> in_review -> todo -> backlog`, and that
 * sequence IS the pickup queue. Re-sorting it here would throw away the only thing the
 * endpoint was called for.
 *
 * ── THE PARTITION IS TOTAL, WHICH IS WHY NO ROW CAN VANISH ────────────────────────────
 *
 * `store.inbox()` called without a page window runs over every OPEN issue and puts each one
 * in `ready` or in `blocked` — never neither, never both. Two consequences the sections
 * below depend on:
 *
 *   1. There is no leftover bucket to invent. Every open row has a section.
 *   2. Resolved work is not in the payload AT ALL, so done/cancelled rows are recognised by
 *      their own status and nothing else. That is the Done section's only input.
 *
 * The fallback in `pickupSectionOf` therefore covers exactly one thing: a row created in
 * the gap between the issues fetch and the inbox fetch. It reads the row's own `status`
 * field and derives nothing, so it cannot become a rival definition of ready.
 *
 * ── PICKUP MODE IS A QUEUE, AND SINCE O8a IT IS ALSO A TREE ───────────────────────────
 *
 * Rows used to render FLAT, at depth 0, in the store's order, wearing a parent breadcrumb
 * chip instead of an indent. The argument was that nesting a child under its parent moves
 * it off its rank, and a dependency-ordered queue whose items are not in order has stopped
 * being a queue. O3c (STA-128) then carved out one exception — a parent that is not in this
 * section at all has no rank here, so it may be drawn as a dimmed GHOST bracketing its
 * orphans — and left a parent that IS in the section flat.
 *
 * STA-148 rejected that, and rightly. The exception had already conceded the principle:
 * ghost blocks lift orphans out of strict rank order, and the sections are themselves a far
 * coarser reordering than any indent. What the flat rule actually produced was one family
 * reading as a unit under group-by-status and as unrelated rows one menu entry away — the
 * screenshot is STA-25 and STA-40 in Up next, the child flat and chipped a row below its
 * own parent. GROUPING IS A PRESENTATION LAYER: the same rows, the same hierarchy, the same
 * row behaviour, arranged under different headings.
 *
 * So O8a (STA-149) hands the placement to `nesting.ts` — the same call `flatten` makes —
 * and this file keeps exactly the two things that are its own:
 *
 *   THE ORDER. The store's, never re-sorted. A parent sits at its OWN rank; its children
 *   keep the store's order among themselves; a ghost still lands at its best-ranked
 *   orphan's position. Nothing moves ahead of a row it ranks behind except to join the
 *   family it belongs to.
 *
 *   THE LINE. What a rendered row looks like — the chip where there is no indent to draw,
 *   the waiting caption, and no rollup on anything.
 */
import { flatRow, type TaskRow } from "@/components/task-list";
import { waitingLine } from "@/lib/derived-blocked";
import { isResolvedStatus } from "@/lib/settings";
import type { BlockingChild, InboxIssue, InboxRow, Issue, IssueRow } from "@/lib/types";
/**
 * O8a (STA-149). The placement, shared with `tree-model.ts` rather than reimplemented flat
 * here — which is what let the two axes disagree about the same parent/child pair.
 */
import { placeRows, walkPlaced } from "./nesting";

/**
 * The sections, in the order they appear. A registry rather than a switch, the same trick
 * `GROUP_BY_OPTIONS` and `FILTER_DIMENSIONS` play — the header, the count, the empty check
 * and the keyboard sequence all read this, so a fifth section would be one entry here.
 */
export type PickupSectionId = "up_next" | "in_flight" | "waiting" | "resolved";

export interface PickupSection {
  id: PickupSectionId;
  label: string;
  /** The header's tooltip: what membership of this section actually means. */
  hint: string;
}

export const PICKUP_SECTIONS: readonly PickupSection[] = [
  {
    id: "up_next",
    label: "Up next",
    hint: "ready and nobody is on it — in the store's own dependency-ordered pickup sequence",
  },
  {
    id: "in_flight",
    label: "In flight",
    hint: "held by an agent, or already in progress or in review",
  },
  {
    id: "waiting",
    label: "Waiting",
    hint: "blocked by a dependency, or by a child that is itself blocked",
  },
  {
    id: "resolved",
    // Named for what is in it, not for the control that reveals it. It only appears when
    // the V4 filter has already let resolved rows onto the page.
    label: "Done / Cancelled",
    hint: "finished work — shown only because the filter is letting it through",
  },
];

export const PICKUP_SECTION_ORDER: readonly PickupSectionId[] = PICKUP_SECTIONS.map((s) => s.id);

/**
 * There is deliberately NO default-collapsed section here.
 *
 * It is tempting — Waiting can be long, and folding it would push the two actionable
 * sections up the page. But expansion.ts persists only EXPLICIT collapses, so absent means
 * expanded; a section that defaulted to folded would need a negative entry to record the
 * user unfolding it, which is a stored-data change to serve a cosmetic preference. Status
 * groups all open by default and so do these. A user who folds Waiting has that remembered,
 * which is the same deal and one concept fewer.
 */

/**
 * `/api/inbox`, indexed for O(1) lookup by issue id.
 *
 * Built once per render of the list rather than consulted as arrays, because the alternative
 * is a linear scan per row and the list refetches every 1.5s.
 */
export interface PickupIndex {
  /** Position in the store's order. `Infinity` for a row the inbox did not mention. */
  rank: (issueId: string) => number;
  /** In the store's `ready` bucket — the ONE definition, borrowed not re-derived. */
  isReady: (issueId: string) => boolean;
  /** In the store's `blocked` bucket: status `blocked`, OR an unresolved dependency. */
  isBlocked: (issueId: string) => boolean;
  /** The sentence the Waiting section renders under the row, or null. */
  waitingOn: (issueId: string) => string | null;
  /** Whether anything was indexed at all — the view waits for this before rendering. */
  size: number;
}

/** The empty index: every lookup misses, so every row takes the status fallback. */
export const EMPTY_PICKUP_INDEX: PickupIndex = {
  rank: () => Number.POSITIVE_INFINITY,
  isReady: () => false,
  isBlocked: () => false,
  waitingOn: () => null,
  size: 0,
};

/**
 * O7b's wiring (STA-141). The workspace's configured CATEGORY for the status, not
 * membership of the built-in `RESOLVED_STATUSES` pair — the same substitution tree-model.ts
 * makes, and it has to be the same substitution or a custom `shipped` status would land in
 * the resolved section on one axis and in `waiting` on the other.
 *
 * On a default workspace the two spellings agree exactly, which is what makes this a wiring
 * change rather than a behaviour change.
 */
function isResolved(status: Issue["status"]): boolean {
  return isResolvedStatus(status);
}

/**
 * Index the payload.
 *
 * RANKS ARE ASSIGNED ACROSS THE WHOLE PAYLOAD, ready first then blocked, workspace by
 * workspace in the order the server returned them. A single counter is safe because the
 * sections never mix the two buckets — Waiting is drawn entirely from `blocked`, Up next and
 * In flight entirely from `ready` — so two rows compared within a section were always ranked
 * against each other in the same list.
 *
 * Hub mode concatenates workspaces rather than interleaving them. Interleaving would need a
 * cross-workspace priority the store does not have and this module must not invent; keeping
 * each workspace's sequence intact at least means the order inside one is the store's.
 */
export function buildPickupIndex(payload: readonly InboxRow[]): PickupIndex {
  const ranks = new Map<string, number>();
  const ready = new Set<string>();
  const blocked = new Set<string>();
  const waiting = new Map<string, string>();
  let next = 0;

  const take = (entry: InboxIssue, bucket: Set<string>) => {
    ranks.set(entry.id, next);
    next += 1;
    bucket.add(entry.id);
  };

  for (const { inbox } of payload) {
    for (const entry of inbox.ready) take(entry, ready);
  }
  for (const { inbox } of payload) {
    for (const entry of inbox.blocked) {
      take(entry, blocked);
      // Computed at INDEX time, not render time, so the wording is derived once per fetch
      // rather than once per row per poll.
      const line = waitingLine(entry, {
        unresolvedBlockers: entry.unresolvedBlockers,
        derivedBlockers: entry.derivedBlockers as readonly BlockingChild[],
      });
      if (line) waiting.set(entry.id, line);
    }
  }

  return {
    rank: (id) => ranks.get(id) ?? Number.POSITIVE_INFINITY,
    isReady: (id) => ready.has(id),
    isBlocked: (id) => blocked.has(id),
    waitingOn: (id) => waiting.get(id) ?? null,
    size: ranks.size,
  };
}

/**
 * THE PLACEMENT RULE. One row, exactly one section, decided in this order.
 *
 * The precedence is not arbitrary and two rungs of it are the whole design:
 *
 * WAITING BEATS IN FLIGHT. A blocked ticket cannot move regardless of who is holding it,
 * and "who it is waiting on" is the fact a reader can act on. The claim badge still renders
 * — badges are a property of the ROW and apply in every section — so nothing is hidden by
 * this, it is only filed under the more useful heading.
 *
 * IN FLIGHT BEATS UP NEXT, and this is the rung the ticket's own section list forces. The
 * store's `ready` bucket CONTAINS in-progress work; it sorts first, because for an agent
 * resuming its own task that is genuinely the top of the queue. But this view answers "what
 * do I grab next", and something another agent is already inside is not that. Splitting the
 * store's ready list into "already being worked" and "free to take" is not a second
 * definition of ready — readiness and order both still come from the store. It is a
 * partition of the store's answer, which is precisely what sections (1) and (2) asked for.
 */
export function pickupSectionOf(row: IssueRow, index: PickupIndex): PickupSectionId {
  const { issue, claim } = row;

  // 1. Terminal, and decided first. Resolved rows are never in the inbox payload, so
  //    asking the index about them would always miss.
  if (isResolved(issue.status)) return "resolved";

  // 2. Blocked — by a dependency the store resolved, or by a child (STA-98).
  if (index.isBlocked(issue.id)) return "waiting";

  // 3. Somebody is on it. `claim` is the strong signal; the two working statuses cover a
  //    ticket moved by hand without a checkout, which is still not free to take.
  if (claim || issue.status === "in_progress" || issue.status === "in_review") return "in_flight";

  // 4. Ready and free. Also the resting place for a row the inbox has not heard of yet —
  //    see the fallback note below.
  if (index.isReady(issue.id)) return "up_next";

  /**
   * THE RACE FALLBACK, and it is only that.
   *
   * The issue list and the inbox are two fetches; a ticket created between them is in one
   * and not the other. Dropping it would be the one thing a tracker must never do, so it is
   * placed by reading its OWN `status` field — a stored value, not a derivation — and
   * nothing else. `blocked` is honoured because putting a visibly blocked row under "Up
   * next" would be an actively misleading answer to the only question this view asks.
   */
  return issue.status === "blocked" ? "waiting" : "up_next";
}

export interface PickupGroup {
  id: PickupSectionId;
  label: string;
  hint: string;
  /**
   * Rows to render, in the store's order, nested by lineage — O8a (STA-149). Ghost rows are
   * in here too, and every consumer filters them with `row.ghost`.
   */
  rows: TaskRow[];
  /**
   * How many tasks are in this section, folded or not. Same reason `StatusGroup.count` is
   * not `rows.length`: a count that follows what is rendered says zero for a collapsed
   * section, which deletes the only reason the count exists.
   *
   * The two used to be equal by accident, because nothing was nested and nothing could be
   * hidden. O8a made them genuinely different in two ways at once — a ghost is in `rows`
   * and is not a task, and a collapsed parent's children are tasks and are not in `rows` —
   * which is exactly the drift the field was kept separate to survive. `bucket.length` is
   * computed before any of that happens, so it cannot be reached by either.
   */
  count: number;
  /**
   * `issue.id -> who or what it is waiting on`. Populated for the Waiting section and empty
   * everywhere else. It rides beside `rows` rather than on `TaskRow` because `TaskRow` is
   * the shared shape three surfaces render and none of the other two has a Waiting section.
   */
  waitingOn: ReadonlyMap<string, string>;
}

export interface PickupBuildOptions {
  /**
   * Whether resolved rows may form the trailing section. V4 (STA-89) decides this upstream
   * in `lib/filters.ts` and the live app hands `true`, exactly as the status path does —
   * gating twice would throw away rows a user explicitly filtered FOR. There is deliberately
   * no second show-done control in pickup mode.
   */
  showResolved?: boolean;
  /** V4's `hiddenParents()`: a breadcrumb for a child whose parent a FILTER removed. */
  hiddenParents?: ReadonlyMap<string, Issue>;
  /**
   * MAY A MISSING PARENT BE DRAWN INSIDE THIS SECTION — O3c (STA-128).
   *
   * The same switch, spelled the same way, as `BuildOptions.ghostParents` in tree-model.ts,
   * and passed through from the same place (`buildList`). The ghost rule is ONE rule across
   * both grouped axes: a reader who has learned it under group-by-status must not find a
   * different answer one menu entry away.
   *
   * Defaulted to `true`; `TreeGrid` hands it `columns.disclosure`, so a container with no
   * indent to nest into keeps the breadcrumb chip instead.
   *
   * O8a (STA-149) WIDENED WHAT IT GATES, not what it means: it now also decides whether a
   * child nests under a parent that IS in the section. Both the ghost and the indent spend
   * the same pixels to say the same thing, and a container that cannot draw one cannot draw
   * the other — so one switch, not two that would eventually disagree.
   */
  ghostParents?: boolean;
  /**
   * THE USER'S EXPLICIT FOLD, or `undefined` where they have not chosen — O8a (STA-149).
   *
   * `BuildOptions.isExpanded`, passed through unchanged by `buildList`, because it is the
   * same fact about the same issue: expansion is stored per issue and STA-148's principle
   * is that a row keeps its expansion state across every grouping. Absent means EXPANDED
   * here, which is not the tree's default (`DEFAULT_EXPANDED_GROUPS`, by status) and should
   * not be: the sections already fold the backlog away, and a queue that hid ranked work
   * behind an unfolded parent nobody folded would be answering a question nobody asked.
   *
   * It arrived with nesting because nesting is what created chevrons in this view. A
   * chevron that does not toggle is exactly the defect STA-148 raises against ghost rows.
   */
  isExpanded?: (issue: Issue) => boolean | undefined;
}

/**
 * Bucket by pickup readiness, order by the store, emit flat rows.
 *
 * `presentAnywhere` is built from the WHOLE input rather than from the bucket, for the same
 * reason `buildGroups` does it: "my parent is in another section" and "my parent does not
 * exist" must stay different answers. The first earns a breadcrumb; the second earns
 * silence, because a chip pointing at a ticket the reader cannot reach is worse than no chip.
 */
export function buildPickupGroups(
  rows: readonly IssueRow[],
  index: PickupIndex,
  options: PickupBuildOptions = {},
): PickupGroup[] {
  const { showResolved = false, hiddenParents, ghostParents = true, isExpanded } = options;

  const visible = showResolved ? rows : rows.filter((r) => !isResolved(r.issue.status));
  const presentAnywhere = new Map(rows.map((r) => [r.issue.id, r.issue]));

  const buckets = new Map<PickupSectionId, IssueRow[]>();
  for (const r of visible) {
    const id = pickupSectionOf(r, index);
    const bucket = buckets.get(id);
    if (bucket) bucket.push(r);
    else buckets.set(id, [r]);
  }

  const out: PickupGroup[] = [];

  for (const section of PICKUP_SECTIONS) {
    const bucket = buckets.get(section.id);
    // Empty sections do not render. A permanent "Waiting 0" header is furniture announcing
    // a non-event, and furniture stops being read within a day.
    if (!bucket || bucket.length === 0) continue;

    /**
     * THE STORE'S ORDER, with one tiebreak.
     *
     * Rank alone would be enough for everything the inbox knows about. The identifier
     * tiebreak is for the rows it does not — the resolved section, and anything caught by
     * the race fallback, which all rank `Infinity` and would otherwise compare equal. Two
     * equal rows are free to swap on every one of the 1.5s poll's rebuilds, which reads as
     * the list twitching under the pointer. Numeric-aware so STA-9 precedes STA-10.
     */
    const ordered = [...bucket].sort((a, b) => {
      const ra = index.rank(a.issue.id);
      const rb = index.rank(b.issue.id);
      // COMPARED, not subtracted. `Infinity - 5` is `Infinity` and `Infinity - Infinity` is
      // `NaN`, so the arithmetic form sorts an unranked row ahead of a ranked one and then
      // returns NaN for two unranked ones — a comparator that is not even self-consistent.
      if (ra !== rb) return ra < rb ? -1 : 1;
      return a.issue.identifier.localeCompare(b.issue.identifier, undefined, { numeric: true });
    });

    /**
     * ── THE PLACEMENT IS THE TREE'S — O8a (STA-149) ───────────────────────────────────
     *
     * It was not, and that was the bug. This file used to lay every row of a section flat
     * at its own rank and draw exactly one kind of nesting: O3c's ghost, for a parent with
     * no rank here at all. A parent that WAS in the section stayed a sibling of its own
     * child, so STA-25 and STA-40 sat side by side in Up next with STA-40 wearing a
     * `STA-25 ›` chip — the same family reading as one unit under group-by-status and as
     * two unrelated rows one menu entry away.
     *
     * STA-148's principle is that grouping is a PRESENTATION LAYER: a row behaves the same
     * inside every group, and the hierarchy is always visible. So the placement is now
     * literally `nesting.ts`'s, the same call `flatten` makes, and the queue keeps only the
     * two things that are genuinely its own — the ORDER (the store's, never re-sorted) and
     * what a rendered line looks like.
     *
     * WHAT THIS COSTS THE QUEUE, HONESTLY. The file header used to argue that nesting a
     * child under its parent moves it off its rank and a dependency-ordered queue whose
     * items are out of order has stopped being a queue. That is still true and it is the
     * price. It is worth paying because the thing it bought — a strict global rank — was
     * already not what the reader got: ghost blocks lift orphans out of rank order, and the
     * sections themselves are a coarser reordering than any nesting. What is preserved is
     * the part the rank was FOR: a parent sits at its own rank, its children keep the
     * store's order among themselves, and no row ever moves ahead of a row it ranks behind
     * except to join the family it belongs to.
     *
     * GHOSTS ARE UNCHANGED (O3c). A parent that is not in this section is drawn as a dimmed
     * bracket at its best-ranked orphan's position — `placeRows` creates it the first time
     * one of its orphans is reached, which in a list already in rank order is exactly that
     * position.
     */
    const ghostFor = (r: IssueRow): Issue | undefined =>
      r.issue.parentId
        ? (presentAnywhere.get(r.issue.parentId) ?? hiddenParents?.get(r.issue.id))
        : undefined;

    /**
     * `ghostParents` GATES BOTH THE GHOST AND THE NESTING, and it is one switch because it
     * is one fact: `TreeGrid` hands it `columns.disclosure`, "this container has an indent".
     * With no indent, `TaskRowLine` draws neither the padding nor the connectors, so a
     * nested child would be indistinguishable from a root AND would have given up its chip.
     * The `panel` and `popup` presets therefore keep exactly the flat, chipped queue they
     * render today — see `PlaceOptions.nest`.
     */
    /**
     * O8b (STA-150). THE CHAIN, and it is the same rule the tree runs: the next ancestor up
     * from a ghost, read from `presentAnywhere` only. `hiddenParents` is keyed by the
     * CHILD's id, so it has nothing to say about a row that is not on the page, and a chain
     * that climbed into what the filter removed would be undoing the filter.
     *
     * It matters most here, of all places: a section is a much coarser cut than a status
     * group, so an epic and its sub-epic land in different sections routinely and the
     * nearest ghost alone would say "part of O8" where the reader needs "part of O8, which
     * is part of O".
     */
    const ancestorFor = (issue: Issue): Issue | undefined =>
      issue.parentId ? presentAnywhere.get(issue.parentId) : undefined;

    const roots = placeRows(ordered, {
      nest: ghostParents,
      ghostFor: ghostParents ? ghostFor : undefined,
      ancestorFor: ghostParents ? ancestorFor : undefined,
    });

    /**
     * NO SORT AFTER THE PLACEMENT, and that is the whole of "children keep the store's
     * pickup order among themselves". `placeRows` preserves encounter order, `ordered` is
     * the store's rank, and a sibling list is a subsequence of it. The tree sorts here
     * because it has a comparator; the queue has an answer already and re-sorting it would
     * throw away the only thing `/api/inbox` was called for.
     */

    /**
     * A ghost is ALWAYS open — a fold on it would take real, ranked rows out of the queue
     * they belong to. A REAL parent folds, defaulting to open: pickup mode has no
     * "the backlog stays shut" story, its sections are the folding, and a chevron that does
     * not toggle is the defect STA-148 raises about ghosts, reproduced on real rows. The
     * choice is the user's own explicit one, shared with the tree because it is stored per
     * issue — which is what STA-148 means by the same expansion state in every grouping.
     */
    const lines = walkPlaced(
      roots,
      (node) =>
        node.ghost || (node.children.length > 0 && (isExpanded?.(node.row.issue) ?? true)),
    );

    const waitingOn = new Map<string, string>();
    const noteWaiting = (r: IssueRow) => {
      if (section.id !== "waiting") return;
      const line = index.waitingOn(r.issue.id);
      if (line) waitingOn.set(r.issue.id, line);
    };

    const taskRows: TaskRow[] = lines.map((line) => {
      const r = line.row;

      if (line.ghost) {
        return flatRow(r, {
          ghost: true,
          depth: line.depth,
          guides: line.guides,
          isLast: line.isLast,
          hasChildren: true,
          isExpanded: true,
          childCount: line.childCount,
          /*
           * NO ROLLUP ON A PICKUP GHOST — `flatRow`'s `null` stands. No row in this view
           * carries one, and a ghost that alone showed a progress count would read as a
           * different KIND of object rather than as the same object dimmed.
           */
        });
      }

      noteWaiting(r);

      /**
       * THE CHIP IS WHAT IS LEFT WHEN THE INDENT COULD NOT SAY IT — the tree's rule, now
       * this file's too. A nested row is placed by lineage and the elbow already says so;
       * a row at depth 0 whose parent is on the page somewhere else, in a container that
       * could not draw a ghost, still needs to name it.
       */
      const parent =
        line.depth === 0 && r.issue.parentId
          ? (presentAnywhere.get(r.issue.parentId) ?? hiddenParents?.get(r.issue.id))
          : undefined;

      return flatRow(r, {
        depth: line.depth,
        guides: line.guides,
        isLast: line.isLast,
        hasChildren: line.hasChildren,
        isExpanded: line.isExpanded,
        childCount: line.childCount,
        breadcrumb: parent ? { identifier: parent.identifier, title: parent.title } : null,
      });
    });

    out.push({
      id: section.id,
      label: section.label,
      hint: section.hint,
      rows: taskRows,
      count: bucket.length,
      waitingOn,
    });
  }

  return out;
}
