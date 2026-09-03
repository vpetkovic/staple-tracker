/**
 * WHAT IS UNDER A FOLDED PARENT — O3b (STA-127).
 *
 * A collapsed parent is the one row on the page that is deliberately hiding something, and
 * until now it said only how many. `+3` cannot tell an epic that is nearly finished from one
 * that has not started, and it certainly cannot tell you that an agent is inside it RIGHT
 * NOW — which is the single fact that would make you unfold it.
 *
 * Three elements, and none of them is new information the page had to fetch: all of it is
 * already in `/api/issues`, which is unpaged. See `parentRollups` in model.ts.
 *
 * ── THE PULSING DOT IS NOT `RowClaimSlot`, AND IT MUST NOT BE MISTAKEN FOR IT ─────────
 *
 * `RowClaimSlot` is the single place the row's OWN liveness is written down — the four claim
 * states, the one threshold, the working pill. This says something else entirely: A CHILD IS
 * LIVE. It never says the parent is held, and a parent whose own claim is live wears BOTH,
 * correctly, because those are two different agents on two different tickets.
 *
 * Two badges that both mean "somebody is here" is exactly the noise this design language
 * spends its rules avoiding, so the pair is separated on four axes at once:
 *
 *   POSITION    the rollup is in the TITLE cell beside `+N`; the claim slot is at the far
 *               right of the meta cluster. Different ends of the row.
 *   SILHOUETTE  no capsule, no border, no avatar circle. A 5px dot and 10px mono initials.
 *   TEXT        no "Working…" label.
 *   NAME        the accessible name says "child STA-nn", naming the ticket that is live.
 *
 * What it does NOT invent is a tempo or a hue. It reuses `--motion-working-pulse` (the house
 * heartbeat, so every live thing on the page breathes on one clock) and
 * `--status-task-in_progress` (the row's single accent, which still means exactly one thing:
 * something is happening right now).
 *
 * ── A STALE DESCENDANT CLAIM RENDERS NOTHING ──────────────────────────────────────────
 *
 * Not a static variant, not a dimmed one — nothing. The judgement is `lib/claim.ts`'s
 * `isStaleClaim` and is made in `parentRollups`, so this component never sees a stale claim
 * and cannot accidentally draw one. An agent that died four hours ago is not inside this
 * subtree, and the row that actually owns that claim already says so honestly in its own
 * claim slot when you unfold.
 *
 * ── EXPANDED KEEPS THE COUNT AND LOSES THE BAR ────────────────────────────────────────
 *
 * STA-127, verbatim. The bar answers "what is in there", and when the children are on the
 * screen underneath, the bar is a redundant restatement of rows the reader can already see.
 * The COUNT survives the fold precisely because it cannot be recovered by looking: the
 * filter may be hiding some of the descendants it counts, which is the whole reason the
 * numbers come from the unfiltered list.
 *
 * ── IT CANNOT CHANGE THE ROW'S HEIGHT ─────────────────────────────────────────────────
 *
 * Nothing here sets a height, a padding, or a line box taller than the 13px title already
 * beside it: the bar is 3px, the dot 5px, the text 11px/1.2. The row's height is
 * `var(--row-height)` on `.staple-row` in every density preset and at every §14 breakpoint,
 * and this lives inside the title's `minmax(0, 1fr)` track — so it can only ever take space
 * the title was going to have, and can never push or collide with the meta cluster.
 */
import { cn } from "@/lib/utils";
import { initials } from "./avatar";
import { ROLLUP_SEGMENTS, type ParentRollup as Rollup, type RollupSegment } from "./model";

/**
 * The four segments, in render order, with what each one is called out loud.
 *
 * The order is `done -> in_progress -> blocked -> open` and it is a reading, not a
 * preference: the bar fills from the left as work finishes, so a nearly-finished epic is a
 * nearly-full bar. `blocked` sits between the two live buckets rather than at the end
 * because it is work that has STARTED and stopped, which is nearer to in-flight than to
 * untouched — and putting it last would bury the one segment worth acting on.
 */
const SEGMENT_LABEL: Record<RollupSegment, string> = {
  done: "done",
  in_progress: "in progress",
  blocked: "blocked",
  open: "open",
};

export function ParentRollupBar({
  rollup,
  collapsed,
  className,
}: {
  rollup: Rollup;
  /** Folded parents get the bar and the live dot; expanded ones get only the count. */
  collapsed: boolean;
  className?: string;
}) {
  // Nothing beneath this row that the rollup counts — which is not the same as no children
  // (an epic whose only child is cancelled reaches here). A `0/0` and an empty bar would be
  // furniture announcing a non-event.
  if (rollup.total === 0) return rollup.live && collapsed ? <ChildLive rollup={rollup} /> : null;

  return (
    <span className={cn("staple-rollup", className)} data-testid="parent-rollup">
      <span
        className="staple-rollup-count"
        // The bar is `aria-hidden`; THIS carries the reading. Spelled out rather than left
        // as "3/5", because a screen reader says "three slash five".
        aria-label={`${rollup.resolved} of ${rollup.total} done`}
        title={summarize(rollup)}
      >
        {rollup.resolved}/{rollup.total}
      </span>
      {collapsed ? <Segments rollup={rollup} /> : null}
      {collapsed && rollup.live ? <ChildLive rollup={rollup} /> : null}
    </span>
  );
}

/**
 * The bar itself — four flex children sized by `flexGrow`, so the four counts turn into four
 * widths with no arithmetic and no rounding drift that could leave a 1px gap at the right
 * edge. A zero-count segment is ABSENT from the DOM rather than a zero-width box: an empty
 * element with a border-radius still paints a hairline at some zoom levels.
 *
 * `aria-hidden`, deliberately. The same fact is one element to the left in a real sentence,
 * and a screen reader reading four nested spans of nothing is worse than silence.
 */
function Segments({ rollup }: { rollup: Rollup }) {
  return (
    <span className="staple-rollup-bar" aria-hidden="true" data-testid="parent-rollup-bar">
      {ROLLUP_SEGMENTS.map((segment) => {
        const count = rollup.segments[segment];
        if (count === 0) return null;
        return (
          <span
            key={segment}
            className="staple-rollup-seg"
            data-segment={segment}
            style={{ flexGrow: count }}
          />
        );
      })}
    </span>
  );
}

/**
 * "Someone is in there" — the dot and two initials, and nothing else.
 *
 * The name says CHILD and names the identifier, so it can never be read as the parent's own
 * claim. `title` repeats it for the pointer, which is the only way a sighted reader learns
 * WHICH child without unfolding.
 */
function ChildLive({ rollup }: { rollup: Rollup }) {
  const live = rollup.live;
  if (!live) return null;
  const sentence = `child ${live.identifier}: ${live.heldBy} is working`;

  return (
    <span
      className="staple-rollup-live"
      data-testid="rollup-child-live"
      aria-label={sentence}
      title={sentence}
    >
      <span className="staple-rollup-live-dot" aria-hidden="true" />
      <span className="staple-rollup-live-initials" aria-hidden="true">
        {initials(live.heldBy)}
      </span>
    </span>
  );
}

/** "3 done, 1 in progress, 1 open" — the tooltip the bar cannot say for itself. */
function summarize(rollup: Rollup): string {
  const parts = ROLLUP_SEGMENTS.filter((s) => rollup.segments[s] > 0).map(
    (s) => `${rollup.segments[s]} ${SEGMENT_LABEL[s]}`,
  );
  return parts.join(", ");
}
