/**
 * THE TWO CUES ON AN UNGROUPED ROW — R4c (STA-188).
 *
 * The vocabulary and the join are in `row-cues.ts`; this file is only the markup, and it is
 * deliberately as small as it looks.
 *
 * ── IT CANNOT CHANGE THE ROW'S HEIGHT ─────────────────────────────────────────────────
 *
 * The argument is R7c's, unchanged (see ParentRollup.tsx): nothing here sets a height, a
 * padding, a border or a line box taller than the 13px title beside it. Both cues are inline
 * 11px spans living inside `.staple-row-title-cell`'s `minmax(0, 1fr)` track, so they can
 * only ever take space the TITLE was going to have — they cannot push the meta cluster, they
 * cannot collide with it at any width, and `.staple-row`'s `height: var(--row-height)` is
 * untouched in every density preset and at every §14 breakpoint.
 *
 * They lead the title cell rather than trailing it, which is the one thing the ticket asks
 * for geometrically: "near the identifier". A grid track of their own would have changed the
 * column template for all three presets and every breakpoint at once, to say one thing about
 * one surface — the same trade the kind glyph and the connector glyph both declined.
 *
 * ── GLYPH AND WORD, NEVER COLOUR ALONE ────────────────────────────────────────────────
 *
 * Neither element carries a hue. The state is legible from the GLYPH for a sighted reader
 * (WCAG 1.4.1) and from the WORD for everyone: `rowCueSentence` leads with it, and it is on
 * both the `title` and an `sr-only` span, so a pointer and a screen reader get the same
 * sentence rather than two different abridgements of it.
 */
import type { RowMilestoneCue, RowPickupCue } from "@/lib/types";
import {
  MILESTONE_CUE_GLYPH,
  ROW_CUE_PRESENTATION,
  milestoneCueSentence,
  rowCueShort,
  rowCueSentence,
} from "./row-cues";

/**
 * "Can I take this, and where is it in the plan."
 *
 * A span and not a button: the cue is a READING of the queue and this list may never write
 * one (docs/queue.md, "Presentation sort is not the queue"). Making it clickable would
 * advertise an affordance that does not and must not exist here.
 */
export function PickupCue({ cue }: { cue: RowPickupCue }) {
  const { glyph } = ROW_CUE_PRESENTATION[cue.state];
  const sentence = rowCueSentence(cue);
  const short = rowCueShort(cue);

  return (
    <span
      className="staple-row-cue"
      data-testid="row-pickup-cue"
      data-pickup-cue={cue.state}
      // The number is on the element rather than only in the text, so a test and a
      // stylesheet can both ask "which number is this" without parsing a sentence.
      data-cue-position={cue.position ?? undefined}
      data-cue-scope={cue.position === null ? undefined : cue.scope}
      title={sentence}
    >
      <span aria-hidden="true">{glyph}</span>
      {short ? <span aria-hidden="true">{short}</span> : null}
      {/* The glyph and the short form are decoration; THIS is the cue. */}
      <span className="sr-only">{sentence}</span>
    </span>
  );
}

/**
 * "And it was committed to this."
 *
 * A button, because unlike the pickup cue this one GOES somewhere: the Milestones view, with
 * this milestone focused. `stopPropagation` is what keeps "the marker opens the milestone,
 * the rest of the row opens the task" true without a second rule for it — the same bargain
 * the breadcrumb chip and the chevron already make one element to the left.
 *
 * The identifier is NOT printed. A milestone reference on every row of a milestone's worth
 * of work is the badge wall the ticket exists to avoid; the glyph says "there is a
 * commitment here" and the tooltip and the accessible name say which one.
 */
export function MilestoneCue({
  cue,
  onOpen,
}: {
  cue: RowMilestoneCue;
  onOpen?: (identifier: string) => void;
}) {
  const sentence = milestoneCueSentence(cue.identifier, cue.title);

  return (
    <button
      type="button"
      className="staple-row-milestone"
      data-testid="row-milestone-cue"
      data-milestone={cue.identifier}
      title={sentence}
      aria-label={sentence}
      onClick={(event) => {
        event.stopPropagation();
        onOpen?.(cue.identifier);
      }}
    >
      <span aria-hidden="true">{MILESTONE_CUE_GLYPH}</span>
    </button>
  );
}
