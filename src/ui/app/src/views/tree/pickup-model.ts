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
 * ── PICKUP MODE IS A QUEUE, NOT A TREE ────────────────────────────────────────────────
 *
 * Rows render FLAT, at depth 0, in the store's order, wearing a parent breadcrumb chip
 * instead of an indent. This is a real trade and it is the right one: nesting a child under
 * its parent moves it off its rank, and a dependency-ordered queue whose items are not in
 * order has stopped being a queue. tree-model.ts already accepts the smaller version of this
 * trade for status grouping ("you do not see the whole tree in one place"); a pickup queue
 * takes it one step further, and gets to skip the flatten and expansion machinery entirely
 * as a result.
 *
 * O3c (STA-128) adds ONE exception and it does not cost the queue anything, which is why it
 * is allowed: a parent that is NOT IN THIS SECTION AT ALL has no rank here to move anything
 * off. It is drawn as a dimmed GHOST at the position of its best-ranked orphan, and that
 * orphan's siblings are lifted under it. A parent that IS in this section keeps the old
 * behaviour exactly — flat, ranked, chip — because it does have a rank and moving it would
 * be the trade this file just refused.
 */
import { flatRow, type TaskRow } from "@/components/task-list";
import { waitingLine } from "@/lib/derived-blocked";
import { isResolvedStatus } from "@/lib/settings";
import type { BlockingChild, InboxIssue, InboxRow, Issue, IssueRow } from "@/lib/types";

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
  /** Rows to render, in the store's order. Flat: pickup mode is a queue. */
  rows: TaskRow[];
  /**
   * How many tasks are in this section, folded or not. Same reason `StatusGroup.count` is
   * not `rows.length`: a count that follows what is rendered says zero for a collapsed
   * section, which deletes the only reason the count exists. Here they happen to be equal —
   * nothing is nested, so nothing is hidden by a collapsed parent — and it stays a separate
   * field so that a later change to either cannot silently make the header lie.
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
   */
  ghostParents?: boolean;
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
  const { showResolved = false, hiddenParents, ghostParents = true } = options;

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
     * ── GHOST BLOCKS, PLACED BY THE QUEUE'S OWN ORDER — O3c (STA-128) ─────────────────
     *
     * A row whose parent is NOT in this section is filed under a synthesised ghost of that
     * parent, and the ghost is created THE FIRST TIME one of its orphans is reached in the
     * ordered sequence. That single fact is what keeps the queue a queue: the block lands
     * exactly where its best-ranked orphan would have landed, and the epic's other orphans
     * are lifted to join it rather than every row being moved to accommodate a parent.
     *
     * A row whose parent IS in this section is left exactly as it was: flat, at depth 0,
     * wearing the chip. Pickup mode does not nest a real parent/child pair — that would
     * move the child off its rank, which is the trade this file's header refuses — and the
     * ghost does not change that, because a ghost is not a rank, it is a bracket around
     * rows that already have one.
     *
     * NO ROLLUP ON A PICKUP GHOST. No row in this view carries one (`flatRow` sets null and
     * this module never computes `parentRollups`), and a ghost that alone showed a progress
     * count would read as a different KIND of object rather than as the same object dimmed.
     */
    const inSection = new Set(bucket.map((r) => r.issue.id));

    interface Block {
      /** The parent to draw above `rows`, or null for an ordinary single row. */
      ghost: Issue | null;
      rows: IssueRow[];
    }

    const blocks: Block[] = [];
    const ghostOf = new Map<string, Block>();

    for (const r of ordered) {
      const parentId = r.issue.parentId;
      const missing =
        ghostParents && parentId && !inSection.has(parentId)
          ? (presentAnywhere.get(parentId) ?? hiddenParents?.get(r.issue.id))
          : undefined;

      if (missing && parentId) {
        const existing = ghostOf.get(parentId);
        if (existing) {
          existing.rows.push(r);
        } else {
          const block: Block = { ghost: missing, rows: [r] };
          ghostOf.set(parentId, block);
          blocks.push(block);
        }
        continue;
      }
      blocks.push({ ghost: null, rows: [r] });
    }

    const waitingOn = new Map<string, string>();
    const noteWaiting = (r: IssueRow) => {
      if (section.id !== "waiting") return;
      const line = index.waitingOn(r.issue.id);
      if (line) waitingOn.set(r.issue.id, line);
    };

    const taskRows: TaskRow[] = [];

    for (const block of blocks) {
      if (block.ghost) {
        taskRows.push(
          flatRow(
            // The parent's issue and NOTHING about the parent's own liveness — the same
            // reading tree-model.ts's ghost makes, for the same reason: `hiddenParents`
            // yields an `Issue` alone, so a ghost could not report a claim consistently.
            // The workspace is the child's; `parentId` is intra-workspace by construction.
            { issue: block.ghost, claim: null, workspace: block.rows[0]!.workspace },
            {
              ghost: true,
              hasChildren: true,
              // Always open. A fold here would take real, ranked rows out of the queue
              // they belong to, which is the one thing a queue may not do.
              isExpanded: true,
              childCount: block.rows.length,
            },
          ),
        );
        block.rows.forEach((r, i) => {
          noteWaiting(r);
          const last = i === block.rows.length - 1;
          taskRows.push(
            flatRow(r, {
              // One level, and one only: the ghost IS the nearest missing ancestor.
              depth: 1,
              guides: [!last],
              isLast: last,
              // The parent is the row directly above; the elbow says so and a chip
              // pointing at it would be the same fact twice.
              breadcrumb: null,
            }),
          );
        });
        continue;
      }

      const r = block.rows[0]!;
      noteWaiting(r);
      const parent = r.issue.parentId
        ? (presentAnywhere.get(r.issue.parentId) ?? hiddenParents?.get(r.issue.id))
        : undefined;
      taskRows.push(
        flatRow(r, {
          // A queue has no indentation to lose a parent to, so EVERY row with a parent
          // still on this list wears the chip — unlike the tree, where only a row that
          // could not be nested needs one.
          breadcrumb: parent ? { identifier: parent.identifier, title: parent.title } : null,
        }),
      );
    }

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
