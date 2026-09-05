/**
 * The Queue view's pure model — R2d (STA-169), docs/queue.md.
 *
 * Everything here is a function of the server's `{revision, entries, effective}` view plus
 * the page's issue list; no React, no fetch. The component renders what these return and
 * `queue-model.test.ts` pins them without a DOM.
 *
 * ── WHAT IS DERIVED HERE AND WHAT IS NOT ────────────────────────────────────────────────
 *
 * NOTHING about ORDER or ELIGIBILITY is derived here. `entries` is the plan the human
 * wrote and `effective` is the resolver's answer — expansion, the unqueued band and the
 * eligibility ladder are all `store.queue().effectiveQueue()`'s work, and docs/queue.md is
 * explicit that one function computes them for every surface. This module only JOINS the
 * two lists the server sent (which effective row came out of which plan row), turns the
 * numbers into labels, and does the move arithmetic a reorder needs before it is sent.
 *
 * The one thing that looks like a derivation is `nextEligible`, and it is not a second
 * resolver: with no actor the resolver's next item IS the first `eligible` row of
 * `effective` (docs/queue.md, "Next item"), so reading it off the list the page already
 * holds is the same computation on the same data rather than a second fetch that can
 * disagree with the list under it.
 */
import { flatRow, type TaskRow } from "@/components/task-list";
import type {
  EffectiveQueueRow,
  Issue,
  IssueRow,
  QueueEligibility,
  QueueEntry,
  QueueView,
} from "@/lib/types";

// ---------- eligibility, without colour ----------

/**
 * One glyph and one word per eligibility, so a state is legible with no colour at all
 * (WCAG 1.4.1). Text glyphs on purpose, for the reason `milestones-model.ts` gives: they
 * survive a static-markup test and a pasted terminal screenshot alike. `⊘` and `◇` are the
 * same marks the milestone risk line uses for blocked and gated — one vocabulary.
 */
export const ELIGIBILITY_PRESENTATION: Readonly<Record<QueueEligibility, { glyph: string; label: string }>> = {
  eligible: { glyph: "○", label: "Eligible" },
  claimed: { glyph: "◐", label: "Claimed" },
  blocked: { glyph: "⊘", label: "Blocked" },
  gated: { glyph: "◇", label: "Gated" },
  resolved: { glyph: "✓", label: "Resolved" },
};

/**
 * The sentence under a row that is not pickable, and null for one that is.
 *
 * The store writes the sentence (`reason`) and this never rewords it — the queue's
 * explanation of a refusal has to be the same sentence on every surface. The fallback to
 * the bare word is for a row whose `reason` is null although it is not eligible, which the
 * server does not send today; rendering the eligibility is still more honest than a blank.
 */
export function reasonLabel(row: EffectiveQueueRow): string | null {
  if (row.eligibility === "eligible") return null;
  return row.reason ?? ELIGIBILITY_PRESENTATION[row.eligibility].label;
}

// ---------- the two numbers ----------

/**
 * THE ONE NUMBER A ROW PRINTS: its place in the order an agent is handed.
 *
 * Null for a container, which has no such place. Null also for a row in the unqueued band —
 * it HAS a position, but printing it would put the plan's scale on rows that are not in the
 * plan, and the section those rows live in already says what they are. This is the whole of
 * the numbering after the redesign: one scale, on the rows it describes.
 *
 * It replaces `effectivePositionLabel`, which printed up to three numbers per row
 * (`#12 · from plan #4`) across two scales. "From plan" is gone entirely: the row is drawn
 * UNDERNEATH the plan row it came from, so position answers provenance and a label that
 * repeated it was answering a question the shape answers better.
 */
export function rowOrdinal(row: EffectiveQueueRow | null): number | null {
  if (row === null || row.unqueued) return null;
  // A RESOLVED row keeps its place in the plan and loses its number. The ordinal is a
  // pickup queue position — an answer to "when do I get handed this" — and finished work is
  // never handed to anybody. It still renders, dimmed and in order, so the plan reads whole;
  // it just stops advertising a turn it will not take. Without this the list numbers a done
  // row `9` between a `5` and a `10`, which is a queue position that can never come up.
  if (row.eligibility === "resolved") return null;
  return row.position;
}

/**
 * The blockers named in an effective row's `detail`, local and cross-workspace alike.
 *
 * The STORE wrote them and this never re-derives them — `reasonLabel` above makes the same
 * promise about the sentence. What this adds is that the rail can render them as rows you
 * can OPEN, which a sentence cannot; the sentence still says it in words for anyone reading
 * the row rather than the rail.
 *
 * Shape-checked rather than cast: `detail` is `Record<string, unknown>` on the wire, and a
 * payload that ever stops carrying these should render nothing rather than throw.
 */
export function blockersOf(row: EffectiveQueueRow | null): string[] {
  const detail = row?.detail;
  if (!detail) return [];
  const named = (key: string): string[] => {
    const value = detail[key];
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
  };
  return [...named("blockers"), ...named("crossBlockers")];
}

// ---------- the plan, joined to its expansion ----------

/** How many expanded descendants a queued container shows before it says how many are left. */
export const EXPANSION_PREVIEW_LIMIT = 5;

/** How many rows of the unqueued band the preview shows before it says how many are left. */
export const UNQUEUED_PREVIEW_LIMIT = 10;

export interface PlanRow {
  entry: QueueEntry;
  /** The shared task row, for the shared row component. */
  row: TaskRow;
  /** This entry's OWN effective row — null when it is a container or is not in `effective`. */
  effective: EffectiveQueueRow | null;
  /** The effective rows this entry expanded to, in effective order. Empty for a leaf. */
  expansion: EffectiveQueueRow[];
}

/**
 * An `Issue` for a plan entry the page's issue list does not carry — another workspace in
 * hub mode, or a row the 1.5s poll has not reached yet. Everything the shared row needs to
 * draw a kind glyph, a status glyph and a title is on the entry already. Same shape and
 * same reason as `milestones-model.ts`'s `issueFromMember`.
 */
function issueFromEntry(entry: QueueEntry): Issue {
  return {
    id: entry.issueId,
    identifier: entry.identifier,
    title: entry.title,
    description: null,
    status: entry.status,
    statusVersion: 0,
    kind: entry.kind,
    priority: "medium",
    parentId: entry.parent,
    depth: entry.parent ? 1 : 0,
    assignee: null,
    createdBy: entry.addedBy,
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
    createdAt: entry.addedAt,
    updatedAt: entry.addedAt,
  };
}

/**
 * The plan in plan order, each row carrying the effective rows it accounts for.
 *
 * The join is the wire's own: an effective row names the queued container it came out of
 * in `via`, and a plan row that is a leaf appears in `effective` under its own identifier
 * with `via: null`. Nothing here re-walks the tree to work that out — that walk is the
 * resolver's, and a second one in the browser is exactly how a preview starts disagreeing
 * with the agent it is previewing.
 */
export function planRows(view: QueueView, issues: readonly IssueRow[], workspace: string): PlanRow[] {
  const known = new Map(issues.map((row) => [row.issue.identifier, row]));
  const own = new Map<string, EffectiveQueueRow>();
  const expandedFrom = new Map<string, EffectiveQueueRow[]>();
  for (const row of view.effective) {
    if (row.via === null) {
      // First occurrence wins, as it does in the resolver: an issue reached twice is
      // emitted once, and a later duplicate must not overwrite the row that is real.
      if (!own.has(row.identifier)) own.set(row.identifier, row);
      continue;
    }
    const list = expandedFrom.get(row.via) ?? [];
    list.push(row);
    expandedFrom.set(row.via, list);
  }

  return view.entries.map((entry, index) => {
    const source = known.get(entry.identifier) ?? {
      workspace,
      issue: issueFromEntry(entry),
      claim: null,
    };
    return {
      entry,
      row: flatRow(source, { isLast: index === view.entries.length - 1 }),
      effective: own.get(entry.identifier) ?? null,
      expansion: expandedFrom.get(entry.identifier) ?? [],
    };
  });
}

/** The first `limit` of a list, and how many it did not show. */
export function previewOf<T>(rows: readonly T[], limit: number): { shown: T[]; hidden: number } {
  return { shown: rows.slice(0, limit), hidden: Math.max(0, rows.length - limit) };
}

// ---------- the effective preview ----------

export interface EffectivePreview {
  /**
   * The unqueued band, capped — it is every other open leaf in the workspace.
   *
   * There is no `planned` counterpart any more. It existed to feed the old preview pane's
   * second copy of the list; the plan is now drawn once, from `entries` joined to their
   * expansions, so a second flat projection of the same rows was a filter run per render for
   * nobody.
   */
  unqueued: EffectiveQueueRow[];
  unqueuedHidden: number;
  /** The row an agent asking now would be given, or null when nothing is pickable. */
  next: EffectiveQueueRow | null;
}

export function effectivePreview(view: QueueView, limit = UNQUEUED_PREVIEW_LIMIT): EffectivePreview {
  const band = previewOf(
    view.effective.filter((row) => row.unqueued),
    limit,
  );
  return { unqueued: band.shown, unqueuedHidden: band.hidden, next: nextEligible(view.effective) };
}

/** The resolver's next item for an actorless read: the first eligible row. See the header. */
export function nextEligible(rows: readonly EffectiveQueueRow[]): EffectiveQueueRow | null {
  return rows.find((row) => row.eligibility === "eligible") ?? null;
}

/** "next: STA-67 (#2)", or the honest sentence when the whole order is waiting on something. */
export const NOTHING_PICKABLE_LABEL = "nothing is pickable right now";

export function nextWorkLabel(next: EffectiveQueueRow | null): string {
  return next ? `next: ${next.identifier} (#${next.position})` : NOTHING_PICKABLE_LABEL;
}

// ---------- move arithmetic ----------

/**
 * The plan order with one entry moved from `from` to `to`. Out of range, or a move that
 * lands where it started, returns null — the caller's "already at the edge" — so a move
 * that would change nothing never becomes a write. Same contract as the milestone
 * member move, deliberately: two lists, one idea of what a move is.
 */
export function movedOrder(entries: readonly QueueEntry[], from: number, to: number): string[] | null {
  if (from < 0 || from >= entries.length || to < 0 || to >= entries.length || from === to) return null;
  const order = entries.map((entry) => entry.identifier);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved!);
  return order;
}

/**
 * "Move to position N", where N is the 1-based plan position a human typed.
 *
 * CLAMPED, not refused: somebody who types 99 into a plan of eleven means "put it last",
 * and a form that answers that with an error is arguing with a clear instruction. The
 * clamp is the only interpretation of an out-of-range number that is not a guess. A
 * clamped target equal to the source is still not a write, by `movedOrder`'s contract.
 */
export function orderForPosition(entries: readonly QueueEntry[], from: number, position: number): string[] | null {
  if (entries.length === 0 || !Number.isFinite(position)) return null;
  const to = Math.min(Math.max(Math.trunc(position), 1), entries.length) - 1;
  return movedOrder(entries, from, to);
}

/**
 * The order to RETRY with after a stale reorder — R2d's "deliberate retry".
 *
 * A conflict means somebody else wrote the plan between the read and the write, so
 * replaying the intended order verbatim would silently undo whatever they did to the
 * membership. This keeps the human's intent where it still applies and the other writer's
 * facts where it does not: entries they removed are dropped, entries they ADDED are kept
 * and land after the ones the retry has an opinion about. Null when the result is already
 * the server's order, so a retry that would change nothing is not a write.
 */
export function retryOrder(intended: readonly string[], current: readonly QueueEntry[]): string[] | null {
  const present = current.map((entry) => entry.identifier);
  const wanted = new Set(intended);
  const order = [...intended.filter((id) => present.includes(id)), ...present.filter((id) => !wanted.has(id))];
  if (order.length === present.length && order.every((id, i) => id === present[i])) return null;
  return order;
}
