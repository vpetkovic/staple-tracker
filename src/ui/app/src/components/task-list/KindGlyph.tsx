/**
 * A KIND as a glyph — O1b (STA-125), the UI half of O1a's `issues.kind`.
 *
 * ── WHAT THIS IS FOR ──────────────────────────────────────────────────────────────────
 *
 * The row's brief (TaskRowLine.tsx) is that nobody should have to open a task to see its
 * state. Kind is the one fact that survived that pass without a mark: an epic and a task
 * were the same line, and you could only tell them apart by folding the list and counting
 * chevrons — which stops working the moment a filter hides the children, and never worked
 * at all in the palette or the panel's flat children list. This is that mark.
 *
 * ── SHAPE, NOT HUE, AND NOT A SECOND STATUS ───────────────────────────────────────────
 *
 * Monochrome, `currentColor` throughout. It inherits `--text-tertiary` from
 * `.staple-row-id`, the cluster it sits in, for the reason `SubtaskGlyph` does: the
 * identifier cluster carries no hue anywhere, and one coloured glyph there would read as
 * a status rather than as a type. Every kind therefore differs in SILHOUETTE — the same
 * WCAG 1.4.1 rule StatusIcon states, made load-bearing here because there is no colour
 * axis at all to fall back on.
 *
 * IT ALSO HAS TO DIFFER FROM ITS NEIGHBOURS, which is a constraint the status set never
 * had. This glyph sits two 8px column gaps from `PrioritySignal` and one from `StatusIcon`,
 * so three shapes were ruled out before anything was drawn: a filled rounded square (that
 * is `critical`, at `x=2 y=2 w=12 h=12 rx=3`), stacked horizontal bars (the no-priority
 * dash cluster), and a bare ring (`ready`). The first two were the obvious choices for
 * `epic` and `chore`, and each would have put the same mark twice on one row, 20px apart,
 * meaning two different things.
 *
 * The first cut drew `task` as a hollow rounded square and it survived until the browser:
 * on an URGENT row it lands beside `critical`'s filled rounded square, and one glance at
 * that pair at 3× was enough. Different hue and different fill were not the point — the
 * SILHOUETTE echoed, and a row should not say the same shape twice.
 *
 * ── THE SET ───────────────────────────────────────────────────────────────────────────
 *
 *   epic   filled diamond    THE ONLY SOLID MARK IN THE SET. An epic is roughly eight
 *                            times the ink of any other row, and mass is what
 *                            "recognisable in a folded list at a glance" has to mean when
 *                            you cannot use colour. Fill is also PRE-ATTENTIVE in a way
 *                            shape is not: you see a run of solid marks down a list
 *                            without reading any of them.
 *   task   hollow diamond    The same diamond, one shade smaller and open. THE ONE PAIR
 *                            IN THIS SET ALLOWED TO SHARE A SILHOUETTE, and deliberately
 *                            so: epic and task are not two unrelated types, they are the
 *                            container and the unit, and "the filled version of the same
 *                            mark" says that in a way two arbitrary shapes cannot. It is
 *                            the axis StatusIcon already uses for blocked vs gated, and
 *                            it survives a monochrome print, which is the test.
 *   bug    ring + antennae   The one organic outline. The antennae are the identity —
 *                            a bare ring is `ready` in the status column, 20px away.
 *   chore  circular arrow    Routine, recurring upkeep. Told apart from `bug` by the gap
 *                            and the arrowhead rather than by the circle.
 *   spike  zigzag peak       Literally a spike, and the only open polyline with no
 *                            enclosure at all.
 *   ·      small dot         ANY OTHER CONFIGURED KIND. See below.
 *
 * ── WHY THERE IS A GENERIC MARK AT ALL ────────────────────────────────────────────────
 *
 * O7a (STA-140) made the kind vocabulary workspace DATA — `staple kinds add milestone` is
 * a supported thing to do — so a switch over the five built-ins would fall through to
 * nothing for a legal kind, and the row would lose its glyph. That is worse than it
 * sounds: this slot is what puts every identifier on one left edge (see task-list.css),
 * so an absent glyph would shift that ONE row's identifier and read as a rendering bug.
 *
 * The generic mark is deliberately the QUIETEST available. A configured kind must occupy
 * the slot, and it must not impersonate one of the five — inventing a plausible-looking
 * glyph for `milestone` would be this file guessing at a meaning only the operator knows.
 *
 * ── ONE GEOMETRY, TWO SIZES ───────────────────────────────────────────────────────────
 *
 * Drawn in StatusIcon's 16-unit viewBox and rendered at 12px in the row. "Sized like
 * StatusIcon" is about the drawing grid and the stroke weight, not about the box: the
 * identifier cluster's icon size is 12px (`Chevron`, `SubtaskGlyph`) and a 16px mark
 * beside an 11px mono identifier towers over it.
 *
 * The strokes are 1.6 in the 16-unit grid, which is not a rounding of StatusIcon's 1.5 —
 * it is the number that renders 1.2px at 12px, which is exactly `SubtaskGlyph`'s weight,
 * its immediate neighbour in the same cluster. At the full 16px it renders 1.6px, which
 * is StatusIcon's register. So a caller that wants the bigger mark — the graph canvas,
 * whose `EpicKindMark` placeholder this is meant to replace — gets the right weight from
 * the same paths rather than from a second set tuned by hand.
 */
import { kindLabel } from "@/lib/settings";
import type { IssueKind } from "@/lib/types";
import { cn } from "@/lib/utils";

/** What the row draws at. Exported so a caller can line something else up with it. */
export const KIND_GLYPH_SIZE = 12;

/**
 * The one stroke weight in this file. See the header: it is chosen so that the glyph
 * agrees with SubtaskGlyph at 12px and with StatusIcon at 16px, from one set of paths.
 */
const STROKE = 1.6;

function Mark({ kind }: { kind: IssueKind }) {
  switch (kind) {
    case "epic":
      // Rounded via a matching stroke rather than by hand-fitting corner curves — a
      // filled polygon has no `rx`, and at 12px a hard vertex reads as a spike.
      return (
        <path
          d="M8 3 L13 8 L8 13 L3 8 Z"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      );

    case "task":
      // The same diamond, hollow and a shade smaller. See the header for why this is the
      // one pair in the set allowed to share a silhouette.
      return (
        <path
          d="M8 3.7 L12.3 8 L8 12.3 L3.7 8 Z"
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinejoin="round"
        />
      );

    case "bug":
      return (
        <>
          <circle cx="8" cy="9" r="3.7" fill="none" stroke="currentColor" strokeWidth={STROKE} />
          {/* The identity of the mark. Struck from the ring's own 45° points so they
              read as growing out of it rather than as two ticks floating above it. */}
          <path
            d="M5.4 6.4 L4 3.8 M10.6 6.4 L12 3.8"
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
        </>
      );

    case "chore":
      return (
        <>
          {/* 315°, leaving the gap at 1:30 for the head. A full ring with an arrow
              stuck on it reads as a ring; the GAP is what makes it read as motion. */}
          <path
            d="M12.6 8 A4.6 4.6 0 1 1 11.3 4.8"
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
          />
          <path
            d="M9.3 3.9 L11.5 4.7 L10.8 6.9"
            fill="none"
            stroke="currentColor"
            strokeWidth={STROKE}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );

    case "spike":
      return (
        <path
          d="M2.6 12 L5.9 5.2 L8.4 9.6 L13.4 3.4"
          fill="none"
          stroke="currentColor"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      );

    default:
      // See the header. Present, neutral, and impersonating nothing.
      return <circle cx="8" cy="8" r="2.1" fill="currentColor" />;
  }
}

export interface KindGlyphProps {
  kind: IssueKind;
  /** Rendered size in px. 12 is the identifier cluster; 16 matches StatusIcon. */
  size?: number;
  className?: string;
  /**
   * Emit the kind as text for assistive tech.
   *
   * ON by default, and the svg is `aria-hidden` rather than `role="img"`: the mark has
   * to sit INSIDE the identifier cluster to be left of the identifier, and an
   * `aria-label` on the svg would be announced as a separate image in the middle of a
   * name that reads "STA-119, the epic". A visually-hidden span in the flow reads as
   * part of that sentence — "Kind: Epic, STA-119, the epic" — which is the same bargain
   * the subtask connector already makes one element to the right.
   *
   * A caller whose surface already names the kind in text passes `false`; two readings
   * of one fact is worse than none.
   */
  labelled?: boolean;
}

export function KindGlyph({ kind, size = KIND_GLYPH_SIZE, className, labelled = true }: KindGlyphProps) {
  return (
    /* `data-issue-kind` and not `data-kind`: the row already carries `data-kind` on its
       avatars, where it means human-or-agent. Two spellings of one attribute name on one
       row is a query that silently matches the wrong element. */
    <span className={cn("staple-kind-glyph", className)} data-issue-kind={kind} data-testid="kind-glyph">
      <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        <Mark kind={kind} />
      </svg>
      {/* `kindLabel`, not the raw id: a workspace that renamed `spike` to "Investigation"
          must be heard saying so, and O7b's accessor is the only place that knows. */}
      {labelled ? <span className="sr-only">Kind: {kindLabel(kind)}</span> : null}
    </span>
  );
}
