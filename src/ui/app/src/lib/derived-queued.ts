/**
 * Rendering a review gate — Q2 (STA-144). The sibling of derived-blocked.ts.
 *
 * That file answers "who is this waiting on for WORK". This one answers "who is
 * this waiting on for a DECISION", which is a different question with a different
 * owner and a different remedy, and VP's STA-142 decision turns on keeping the two
 * apart: an agent that cannot tell them apart either nags a human about a
 * dependency or waits patiently for a human who was never told.
 *
 * Nothing here renders, reads a clock, or touches storage.
 *
 * ══ THE ONE SOURCE, AND WHY IT IS THE ROW AND NOT THE INBOX BUCKET ═══════════════
 *
 * Every predicate below reads `gate` and `queuedBy` — the two SIBLINGS that ride
 * beside `issue` on `/api/issues`, `/api/inbox` and `/api/issue`. That is the whole
 * definition. `views/tree/pickup-model.ts` gets its sections from here, the tree
 * rows get their captions from here, and the detail panel's checklist gets its
 * children from here, so the three cannot word or bucket one ticket differently.
 *
 * pickup-model.ts states a rule this file has to answer to: readiness has exactly
 * one definition, it lives in `store.inbox()`, and the browser reads the answer
 * rather than re-deriving it. There is an inbox `queued` bucket, so why is that not
 * the source here?
 *
 * BECAUSE READING `queuedBy` IS BORROWING, NOT RE-DERIVING. It is the store's own
 * computed answer, produced by `store.queuedByFor()` — the very call `store.inbox()`
 * itself makes to decide which bucket a row belongs in. The rule forbids a second
 * IMPLEMENTATION in the browser; there is none here, only a field being read.
 *
 * And it is the source that survives contact with the rest of the app:
 *
 *   1. THE CAPTION HAS TO RENDER IN EVERY MODE. Flat and status grouping never
 *      build a `PickupIndex` — the inbox is fetched only for pickup order. Taking
 *      membership from the bucket and wording from the row would mean the section
 *      and the caption came from two fetches 1.5s apart, and a row could sit in
 *      Pending approval with no caption (or wear one in Up next) for exactly as
 *      long as they disagreed.
 *
 *   2. `gate` HAS NO BUCKET AT ALL. The parked parent lands in `queued` beside the
 *      work it is holding, so the bucket cannot tell the gate from the queue. The
 *      owner's name — the one fact the parent's caption exists to carry — lives
 *      only on the `gate` sibling.
 *
 *   3. THE PRECEDENCE COMES OUT IDENTICAL. `store.inbox()` decides
 *      `queuedBy || awaiting_approval` BEFORE it looks at `blocked`, in its own
 *      words: "a queued issue with unresolved blockers is still gated, and naming
 *      the gate is the more actionable of the two facts". `pickupSectionOf` ranks
 *      the gate above Waiting for that reason and cites it.
 */
import type { GateState, IssueGate, IssueRow, QueuedBy } from "./types";

/**
 * The gate states that HOLD A QUEUE. Mirrors `GATE_QUEUEING_STATES` in
 * src/core/store.ts, and the membership of `changes_requested` is the interesting
 * half: requesting changes does not drain the queue. VP's decision — the reviewer
 * said "fix it", which is the opposite of "carry on" — so the children stay queued
 * and the parent stays gate-bearing until somebody approves or re-gates.
 *
 * `approved` is history. A row carrying an approved gate is an ordinary row that
 * once went through review, and must render as one.
 */
export const ACTIVE_GATE_STATES: readonly GateState[] = ["pending", "changes_requested"];

/** Is this gate still holding its queue, or is it a record of one that closed? */
export function isActiveGate(gate: IssueGate | null | undefined): gate is IssueGate {
  return !!gate && ACTIVE_GATE_STATES.includes(gate.state);
}

/**
 * The two siblings plus the one field of the issue that matters, as the predicates
 * below need them. Structural rather than `IssueRow`, so an inbox entry, a detail
 * payload and a test fixture all satisfy it without constructing thirty fields
 * nobody reads.
 */
type GateBearing = Pick<IssueRow, "gate" | "queuedBy"> & {
  issue: Pick<IssueRow["issue"], "id" | "status">;
};

/**
 * IS THIS ROW THE GATE — parked, holding work, waiting on a named human.
 *
 * BOTH halves are required, and neither is redundant with the other. The status
 * alone would be true for a row whose gate has been approved but whose status the
 * store has not re-derived yet; the gate alone would be true for a row that was
 * sent back to `todo` by request-changes, which is pickable and must never render
 * as parked. A row is parked when it says so AND the gate agrees.
 */
export function isGateParked(row: GateBearing): boolean {
  return row.issue.status === "awaiting_approval" && isActiveGate(row.gate);
}

/**
 * IS THIS ROW STANDING IN A QUEUE — checkout of it will be refused.
 *
 * One field, no derivation, deliberately. `queuedBy` is the nearest ancestor with
 * an active gate, computed by walking the tree server-side and honouring the
 * per-child release flag that "Approve selected" sets. A released child simply
 * stops carrying the field, which is the entire mechanism behind granular
 * approval — and the reason this must never be re-derived from "my parent is
 * gated", which cannot see the release.
 */
export function isQueuedBehindGate(row: Pick<IssueRow, "queuedBy">): boolean {
  return row.queuedBy != null;
}

/**
 * The parked parent's caption: "awaiting VP".
 *
 * Lower case and no identifier, because it renders INSIDE the row it is about —
 * the reader already has the ticket. The queued child's version below is the one
 * that has to name the gate, since the gate is somewhere else on the page.
 */
export function gateCaption(gate: IssueGate): string {
  return `awaiting ${gate.owner}`;
}

/** The queued child's caption: "Queued · awaiting VP on STA-108". */
export function queuedCaption(queuedBy: QueuedBy): string {
  return `Queued · awaiting ${queuedBy.owner} on ${queuedBy.identifier}`;
}

/**
 * The same fact, as a full sentence, for a disabled control's tooltip and
 * `aria-description`. It extends the caption rather than re-wording it, so the
 * text under the row and the text on the button cannot say two different things.
 */
export function gateRefusalReason(queuedBy: QueuedBy): string {
  return `${queuedCaption(queuedBy)} — checkout is refused until the gate is approved`;
}

/**
 * `issue.id -> the one muted sentence that row should carry`, for the whole page.
 *
 * Built once per fetch, exactly like `buildPickupIndex`, rather than once per row
 * per 1.5s poll. Rows with nothing to say are ABSENT from the map, not mapped to
 * `""` — `TaskRowLine` treats an undefined caption as absent from the DOM, and an
 * empty string would put an empty element in every row on the page.
 *
 * The row's OWN gate wins over a gate it stands in. The two are complementary and
 * at most one is ever non-null on the wire, so this only decides a case the server
 * does not produce — but it decides it the way a reader needs: a row that IS a gate
 * should say who must act on IT, not who must act two levels up.
 */
export function buildGateCaptions(rows: readonly GateBearing[]): Map<string, string> {
  const captions = new Map<string, string>();
  for (const row of rows) {
    if (isGateParked(row)) captions.set(row.issue.id, gateCaption(row.gate!));
    else if (row.queuedBy) captions.set(row.issue.id, queuedCaption(row.queuedBy));
  }
  return captions;
}

/**
 * ══ THE CHECKLIST IS A TREE, AND TICKING A ROW TICKS ITS SUBTREE ═══════════════
 *
 * `/api/issue`'s `childrenQueued` arrives as a flat PRE-ORDER list with a
 * `depth` per row — the shape `store.gateQueueOf()` produces. Everything below
 * reads the tree structure straight out of that ordering, which is the entire
 * reason the wire shape is flat: in pre-order, **a row's subtree is exactly the
 * run of following rows whose depth is greater than its own**, and it ends at
 * the first row whose depth is less than or equal to it.
 *
 * Q5 (STA-154) filtering moved SERVER-SIDE. Q2 shipped a `queuedChildrenOf` here
 * that dropped children the gate was not holding, and it is gone: eligibility
 * (open, not an emptied-out container, not behind an inner gate) is the store's
 * rule, the store now applies it, and a second copy in the browser is exactly the
 * drift this file's opening argument exists to prevent. What is left here is
 * SELECTION — a question about what the reviewer ticked, which the server has no
 * opinion about.
 */
type QueueRow = { identifier: string; depth: number };

/**
 * The rows implied by `row` — its subtree, not counting itself.
 *
 * Returned as a slice rather than a count because both callers want the rows:
 * one to render them as already-decided, one to count them for the "+n".
 */
export function subtreeOf<T extends QueueRow>(queue: readonly T[], index: number): T[] {
  const root = queue[index];
  if (!root) return [];
  const out: T[] = [];
  for (let i = index + 1; i < queue.length; i += 1) {
    const row = queue[i]!;
    if (row.depth <= root.depth) break;
    out.push(row);
  }
  return out;
}

/**
 * Every identifier a selection actually releases — what the reviewer ticked,
 * plus everything underneath it.
 *
 * This is what the count on the button is drawn from. A reviewer who ticks one
 * parent is releasing five tickets, and a button that says "1" about that is
 * understating the blast radius of the click.
 */
export function impliedSelection<T extends QueueRow>(
  queue: readonly T[],
  selected: ReadonlySet<string>,
): Set<string> {
  const all = new Set<string>();
  queue.forEach((row, index) => {
    if (!selected.has(row.identifier)) return;
    all.add(row.identifier);
    for (const child of subtreeOf(queue, index)) all.add(child.identifier);
  });
  return all;
}

/**
 * The identifiers that go ON THE WIRE — the ticked rows that no other ticked row
 * already covers.
 *
 * The store's release flag propagates DOWN a subtree on its own (see
 * `queuedByFor`), so sending a parent releases its children. Sending both would
 * be the same decision written twice: two `gate_child_approved` events per
 * ticket, and a timeline that reads as two reviews.
 *
 * Order is the checklist's own, so the confirmation the CLI would print and the
 * order on screen agree.
 */
export function selectionRoots<T extends QueueRow>(
  queue: readonly T[],
  selected: ReadonlySet<string>,
): string[] {
  const covered = new Set<string>();
  queue.forEach((row, index) => {
    if (!selected.has(row.identifier)) return;
    for (const child of subtreeOf(queue, index)) covered.add(child.identifier);
  });
  return queue
    .filter((row) => selected.has(row.identifier) && !covered.has(row.identifier))
    .map((row) => row.identifier);
}
