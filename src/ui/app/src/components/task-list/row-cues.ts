/**
 * WHERE THIS ROW SITS IN THE PLAN, AS ONE GLYPH AND ONE WORD — R4c (STA-188).
 *
 * Ungrouped is the normal working view, not the absence of information. The status icon and
 * the kind glyph already say what a row IS; this file answers the other two questions a
 * reader has about it — CAN I TAKE IT, and WHAT WAS IT COMMITTED TO — and answers both
 * without a second badge per fact.
 *
 * Nothing here renders, fetches, reads a clock or writes. It is the join and the vocabulary;
 * `RowCues.tsx` is the markup and `views/TreeView.tsx` is the wiring.
 *
 * ── THE QUEUE IS THE SOURCE, AND IT IS JOINED IN THE BROWSER ──────────────────────────
 *
 * `lib/types.ts` reserves `pickupState`, `pickupReason`, `queuePosition` and `planPosition`
 * on `IssueRow` for the day `/api/issues` sends them. It does not send them today. So the
 * cues are joined here against `GET /api/queue` — the ONE view R2c already publishes, the
 * same `{revision, entries, effective}` the CLI prints and the MCP tools return — and the
 * four served fields are left untouched, so nothing has to be unpicked when the list route
 * catches up.
 *
 * ONE JOIN, MEMOISED, ON THE EXISTING POLL. `/api/queue` is one request per fingerprint
 * change, the bargain `/api/settings` and `/api/milestones` already make, and it is fetched
 * only in the ungrouped shape — the same short-circuit TreeView applies to `/api/inbox`.
 *
 * ── PICKABLE IS THE RESOLVER'S ANSWER, NOT A PREDICATE ────────────────────────────────
 *
 * There is exactly one row in a workspace an agent would be handed next, and it is the
 * FIRST eligible row of the effective order — `effectiveQueue`'s own `next`. So `pickable`
 * is that row and no other. Every later eligible row inside the plan is `queued`, which is
 * the only reading under which the word means what lib/types.ts says it means ("eligible,
 * but the plan puts another row first"), and it is what keeps the cue from printing
 * "pickable" on forty rows at once — a badge wall that says nothing.
 *
 * ── CONTAINERS ARE NEVER IN THE EFFECTIVE ORDER, SO THEY GET THE PLAN NUMBER ──────────
 *
 * `queue-store.ts` STEP 1: a container "is never emitted as itself; it expands in place".
 * An epic therefore has no effective position and it would be wrong to invent one — the
 * number an agent acts on belongs to the leaf. What a container does have is a PLACE IN THE
 * PLAN, and this file recovers it from two directions:
 *
 *   1. its own `entries` row, when a human queued that container directly;
 *   2. otherwise the smallest `planPosition` among the effective rows that name it — in
 *      `via` (the container they were expanded out of), in `epicPath` (their ancestor
 *      epics) or in `milestonePath`.
 *
 * (2) is what makes an INTERMEDIATE container honest. Queue a milestone that contains an
 * epic and the epic is in neither list; without the derivation it would read "unqueued"
 * directly above children reading "#3", which is the exact confusion the ticket exists to
 * remove.
 *
 * ── MILESTONE MEMBERSHIP IS THE QUEUE'S, NOT THE TREE'S ───────────────────────────────
 *
 * `EffectiveQueueRow.milestonePath` is membership-derived: the milestone the row or its
 * nearest ancestor is a MEMBER of. Never `parentId` — a milestone contains epics and tasks
 * without reparenting them, so reading the tree would answer a different question and answer
 * it wrongly. Containers inherit it by the same upward pass as the plan position, and only
 * when every effective row underneath agrees: two milestones under one epic means the epic
 * is under neither, and silence is the honest answer.
 */
import {
  type EffectiveQueueRow,
  type IssueRow,
  type QueueView,
  type RowCues,
  type RowCueState,
  type RowPickupCue,
} from "@/lib/types";
import { PICKUP_HINTS } from "@/lib/filter-dimensions";
import { isResolvedStatus } from "@/lib/settings";

/**
 * ONE GLYPH AND ONE WORD PER STATE, so a state is legible with no colour at all (WCAG
 * 1.4.1). The glyphs are TEXT rather than svg for the reason `STATE_PRESENTATION` in
 * views/milestones/milestones-model.ts gives: they render in a static-markup test and in a
 * terminal-shaped mind without a sprite sheet.
 *
 * The hints for the five shared states are `PICKUP_HINTS` — the SAME sentences the filter
 * menu shows — imported rather than restated, because a row and a filter that described the
 * same word differently would be two vocabularies for one contract. `unqueued` is not a
 * filter value and carries its own.
 *
 * `short` is what the row PRINTS beside the glyph, and it is empty for four of the six on
 * purpose: a word per row is a badge wall. The word itself is never lost — it leads the
 * `title` and the screen-reader sentence on every cue, which is where a reader who needs it
 * goes looking.
 */
export const ROW_CUE_PRESENTATION: Readonly<
  Record<RowCueState, { glyph: string; label: string; hint: string }>
> = {
  pickable: { glyph: "▸", label: "Pickable", hint: PICKUP_HINTS.pickable },
  queued: { glyph: "#", label: "Queued", hint: PICKUP_HINTS.queued },
  waiting: { glyph: "⋯", label: "Waiting", hint: PICKUP_HINTS.waiting },
  gated: { glyph: "⚑", label: "Gated", hint: PICKUP_HINTS.gated },
  in_flight: { glyph: "◐", label: "In flight", hint: PICKUP_HINTS.in_flight },
  unqueued: {
    glyph: "·",
    label: "Unqueued",
    hint: "not in the pickup plan — still work, just later",
  },
};

/** The milestone marker's glyph. A diamond: a dated commitment, not a status and not a kind. */
export const MILESTONE_CUE_GLYPH = "◇";

/**
 * What the row prints beside the glyph. Empty means the glyph stands alone.
 *
 * The two that print are the two that carry a NUMBER, plus the one row in the workspace
 * that is worth a word — "next". `plan #2` is spelled out rather than shown as a bare `#2`
 * because a container's number and a leaf's number are different numbers, and a reader who
 * cannot tell which one they are looking at cannot use either.
 */
export function rowCueShort(cue: RowPickupCue): string {
  if (cue.state === "pickable") return "next";
  if (cue.position === null) return "";
  return cue.scope === "plan" ? `plan #${cue.position}` : `#${cue.position}`;
}

/**
 * The sentence in `title` and in the screen-reader text — the word first, then what it
 * means, then the number, then the resolver's own reason when it sent one.
 *
 * The word LEADS, always. It is the half of "glyph and word" that a glyph cannot carry, and
 * a reader who hovers a `·` is asking exactly one question.
 */
export function rowCueSentence(cue: RowPickupCue): string {
  const { label, hint } = ROW_CUE_PRESENTATION[cue.state];
  const parts = [`${label} — ${hint}`];
  if (cue.position !== null) {
    parts.push(
      cue.scope === "plan"
        ? `Plan position ${cue.position}.`
        : `Queue position ${cue.position}.`,
    );
  }
  if (cue.reason) parts.push(cue.reason);
  return parts.join(" ");
}

/** The milestone marker's sentence, for `title`, `aria-label` and the tooltip alike. */
export function milestoneCueSentence(identifier: string, title: string | null): string {
  const named = title ? `${identifier}: ${title}` : identifier;
  return `Planned under milestone ${named} — open the milestone plan`;
}

/**
 * The join, built once per fetch.
 *
 * `size` is the number of rows the queue accounted for. ZERO MEANS SILENCE: a page that has
 * not loaded the queue, or a workspace with no plan and no open work, renders no cues at all
 * rather than stamping `·` on every row to say nothing.
 */
export interface RowCueIndex {
  size: number;
  cuesFor: (row: IssueRow) => RowCues | null;
}

export const EMPTY_ROW_CUE_INDEX: RowCueIndex = { size: 0, cuesFor: () => null };

/**
 * The upward pass: what a CONTAINER inherits from the effective rows underneath it.
 *
 * `plan` takes the smallest position seen, because a container is reached at the earliest
 * point any of its work is planned. `milestone` takes the agreed one or nothing — `false`
 * is the conflicted marker, and once conflicted it stays conflicted.
 */
interface ContainerFacts {
  plan: Map<string, number>;
  milestone: Map<string, string | false>;
}

function noteContainer(facts: ContainerFacts, identifier: string, row: EffectiveQueueRow): void {
  if (row.planPosition !== null) {
    const seen = facts.plan.get(identifier);
    if (seen === undefined || row.planPosition < seen) facts.plan.set(identifier, row.planPosition);
  }
  const milestone = row.milestonePath[0] ?? null;
  const current = facts.milestone.get(identifier);
  if (current === false) return;
  if (current === undefined) {
    if (milestone !== null) facts.milestone.set(identifier, milestone);
    else facts.milestone.set(identifier, false);
    return;
  }
  if (current !== milestone) facts.milestone.set(identifier, false);
}

export function buildRowCueIndex(
  queue: QueueView | null | undefined,
  milestoneTitles: ReadonlyMap<string, string> = new Map(),
): RowCueIndex {
  if (!queue) return EMPTY_ROW_CUE_INDEX;

  const effective = new Map<string, EffectiveQueueRow>();
  for (const row of queue.effective) effective.set(row.identifier, row);

  const planned = new Map<string, number>();
  for (const entry of queue.entries) {
    if (!entry.resolved) planned.set(entry.identifier, entry.planPosition);
  }

  const containers: ContainerFacts = { plan: new Map(), milestone: new Map() };
  for (const row of queue.effective) {
    const ancestors = [...row.epicPath, ...row.milestonePath];
    if (row.via && !ancestors.includes(row.via)) ancestors.push(row.via);
    for (const ancestor of ancestors) noteContainer(containers, ancestor, row);
  }

  /**
   * The resolver's `next`: the first eligible row of the effective order, unqueued band
   * included. It is the row an agent would actually be handed, which is the only thing
   * `pickable` is allowed to mean.
   */
  const nextUp = queue.effective.find((row) => row.eligibility === "eligible")?.identifier ?? null;

  const size = effective.size + planned.size;
  if (size === 0) return EMPTY_ROW_CUE_INDEX;

  const pickupFor = (identifier: string, resolved: boolean): RowPickupCue | null => {
    if (resolved) return null;
    const row = effective.get(identifier);
    if (row) {
      if (row.eligibility === "resolved") return null;
      const reason = row.reason;
      if (row.eligibility === "gated") return { state: "gated", position: null, scope: "effective", reason };
      if (row.eligibility === "blocked") return { state: "waiting", position: null, scope: "effective", reason };
      if (row.eligibility === "claimed") {
        return { state: "in_flight", position: null, scope: "effective", reason };
      }
      if (identifier === nextUp) {
        return { state: "pickable", position: row.position, scope: "effective", reason };
      }
      if (row.unqueued) return { state: "unqueued", position: null, scope: "effective", reason };
      return { state: "queued", position: row.position, scope: "effective", reason };
    }
    // Not in the effective order: a container, which the resolver expands rather than emits.
    const plan = planned.get(identifier) ?? containers.plan.get(identifier);
    if (plan === undefined) return { state: "unqueued", position: null, scope: "plan", reason: null };
    return { state: "queued", position: plan, scope: "plan", reason: null };
  };

  const milestoneFor = (identifier: string) => {
    // A milestone is never a member of a milestone, so it never wears the marker: the row
    // IS the thing the marker would point at.
    if (milestoneTitles.has(identifier)) return null;
    const own = effective.get(identifier)?.milestonePath[0] ?? null;
    const inherited = containers.milestone.get(identifier);
    const ref = own ?? (typeof inherited === "string" ? inherited : null);
    // A row can reach itself through its own `milestonePath` when the page has not listed
    // the milestones; the self-check is what stops a milestone pointing at itself then.
    if (ref === null || ref === identifier) return null;
    return { identifier: ref, title: milestoneTitles.get(ref) ?? null };
  };

  return {
    size,
    cuesFor: (row) => {
      const identifier = row.issue.identifier;
      const pickup = pickupFor(identifier, isResolvedStatus(row.issue.status));
      const milestone = milestoneFor(identifier);
      if (pickup === null && milestone === null) return null;
      return { pickup, milestone };
    },
  };
}

/**
 * The one wiring call: the list, with the plan joined onto it.
 *
 * Returns the SAME array when there is nothing to join, so an empty index cannot cost a
 * re-render of every downstream memo on a 1.5s poll.
 */
export function attachRowCues(rows: readonly IssueRow[], index: RowCueIndex): IssueRow[] {
  if (index.size === 0) return rows as IssueRow[];
  return rows.map((row) => ({ ...row, cues: index.cuesFor(row) }));
}
