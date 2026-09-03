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
 */
import { flatRow, type TaskRow } from "@/components/task-list";
import { waitingLine } from "@/lib/derived-blocked";
import { isGateParked, isQueuedBehindGate } from "@/lib/derived-queued";
import type { BlockingChild, InboxIssue, InboxRow, Issue, IssueRow } from "@/lib/types";
import { RESOLVED_STATUSES } from "@/lib/types";

/**
 * The sections, in the order they appear. A registry rather than a switch, the same trick
 * `GROUP_BY_OPTIONS` and `FILTER_DIMENSIONS` play — the header, the count, the empty check
 * and the keyboard sequence all read this, so a fifth section would be one entry here.
 */
export type PickupSectionId =
  | "up_next"
  | "in_flight"
  | "waiting"
  | "pending_approval"
  | "resolved";

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
  /**
   * Q2 (STA-144). AFTER Waiting and before the resolved coda.
   *
   * Both sections mean "not now", and the ordering follows how much of the page's
   * attention each deserves. Waiting is the common case and its rows usually unstick
   * themselves as other work lands. A gate is rarer, is held by a NAMED HUMAN, and
   * needs somebody to go and ask — so it sits at the bottom of the actionable stack
   * where it reads as a standing item rather than as noise above the queue.
   *
   * It is a section rather than a badge because a gate holds a SET: the parent and
   * every open thing under it. Scattering that set through Up next with a marker
   * would be exactly the state STA-142 exists to end.
   */
  {
    id: "pending_approval",
    label: "Pending approval",
    hint: "parked behind a human review gate, or queued underneath one — checkout is refused",
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

function isResolved(status: Issue["status"]): boolean {
  return RESOLVED_STATUSES.includes(status);
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
  /**
   * The gate bucket, indexed FOR RANK ONLY — Q2 (STA-144), and the distinction is
   * deliberate.
   *
   * There is no `isQueued` on this index and there must not be. Membership of the
   * Pending approval section is decided from the ROW's `gate`/`queuedBy` siblings
   * through `lib/derived-queued.ts`, which is the one definition and the only one
   * that works in flat and status modes (that file argues it at length). Adding a
   * bucket-shaped answer here would give the app a second one to disagree with.
   *
   * What the index still owes those rows is their PLACE IN THE QUEUE, which is a
   * pure ordering fact and is the whole reason this module exists. Ranked between
   * ready and blocked so the counter stays total: `store.inbox()` puts the gate at
   * the head of its own bucket, ahead of the work it holds, and that is the order
   * the section renders in.
   */
  for (const { inbox } of payload) {
    for (const entry of inbox.queued) {
      ranks.set(entry.id, next);
      next += 1;
    }
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

  /**
   * 2. GATED — Q2 (STA-144), and it outranks everything below it.
   *
   * Read off the row's own `gate`/`queuedBy` siblings, never from the index: see
   * lib/derived-queued.ts for why that is borrowing the store's answer rather than
   * re-deriving it, and why it is the source that works in every grouping mode.
   *
   * ABOVE WAITING, mirroring `store.inbox()`, which decides `queuedBy ||
   * awaiting_approval` before it looks at `blocked` — in its own words, "a queued
   * issue with unresolved blockers is still gated, and naming the gate is the more
   * actionable of the two facts". Two surfaces, one precedence.
   *
   * ABOVE IN FLIGHT, on the argument Waiting already wins on one rung down: a
   * queued row cannot move whoever is holding it, because checkout is refused and
   * releasing it would only make it unclaimable. This is the exact rung STA-142
   * exists to add — STA-108 sat in_progress, held, for 56 minutes while what it was
   * really doing was waiting on a human. The claim badge still renders on the row,
   * so nothing is hidden; it is filed under the heading that can act on it.
   */
  if (isGateParked(row) || isQueuedBehindGate(row)) return "pending_approval";

  // 3. Blocked — by a dependency the store resolved, or by a child (STA-98).
  if (index.isBlocked(issue.id)) return "waiting";

  // 4. Somebody is on it. `claim` is the strong signal; the two working statuses cover a
  //    ticket moved by hand without a checkout, which is still not free to take.
  if (claim || issue.status === "in_progress" || issue.status === "in_review") return "in_flight";

  // 5. Ready and free. Also the resting place for a row the inbox has not heard of yet —
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
  const { showResolved = false, hiddenParents } = options;

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
      /**
       * ONE EXCEPTION TO THE STORE'S ORDER, IN ONE SECTION — Q2 (STA-144).
       *
       * Inside Pending approval, the GATES sort ahead of the work they are holding.
       * Everywhere else this comparator is rank and nothing else, and that rule is the
       * whole point of the module — so this needs a reason, and it is not aesthetics.
       *
       * `store.inbox()` returns the queued bucket in plain list order, which puts a
       * parent wherever its `created_at` happens to fall — in practice, after most of
       * its own children. The section then reads bottom-up: eighteen rows all saying
       * "awaiting VP on STA-119", and STA-119 itself at the very end. The heading of a
       * queue belongs at the top of it.
       *
       * Q1 hit this first and made the same call one surface over: the CLI "prints gate
       * holders first within the section; the store keeps pickup order for its MCP and
       * HTTP consumers". So this is not a new opinion, it is the SAME opinion, and
       * writing it here is what keeps `staple inbox` and the tree agreeing about one
       * ticket. Doing nothing would have been the divergence.
       *
       * It is a two-way partition, not a re-sort: rank still decides everything within
       * each half, so the store's sequence survives intact on both sides of the split.
       */
      const ga = a.issue.status === "awaiting_approval" ? 0 : 1;
      const gb = b.issue.status === "awaiting_approval" ? 0 : 1;
      if (section.id === "pending_approval" && ga !== gb) return ga - gb;

      const ra = index.rank(a.issue.id);
      const rb = index.rank(b.issue.id);
      // COMPARED, not subtracted. `Infinity - 5` is `Infinity` and `Infinity - Infinity` is
      // `NaN`, so the arithmetic form sorts an unranked row ahead of a ranked one and then
      // returns NaN for two unranked ones — a comparator that is not even self-consistent.
      if (ra !== rb) return ra < rb ? -1 : 1;
      return a.issue.identifier.localeCompare(b.issue.identifier, undefined, { numeric: true });
    });

    const waitingOn = new Map<string, string>();
    const taskRows = ordered.map((r) => {
      if (section.id === "waiting") {
        const line = index.waitingOn(r.issue.id);
        if (line) waitingOn.set(r.issue.id, line);
      }
      const parent = r.issue.parentId
        ? (presentAnywhere.get(r.issue.parentId) ?? hiddenParents?.get(r.issue.id))
        : undefined;
      return flatRow(r, {
        // A queue has no indentation to lose a parent to, so EVERY row with a parent wears
        // the chip — unlike the tree, where only a row that could not be nested needs one.
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
