/**
 * A status as a 16px glyph — V5 (STA-97) §6.1, re-keyed onto the CATEGORY by O7b (STA-141).
 *
 * ── THE SEQUENCE IS THE POINT ─────────────────────────────────────────────────────────
 *
 *   unstarted → ready → active → review → done
 *   dashed    → empty → half   → three-quarter → complete
 *
 * It reads as a progress ring filling up, which is the whole reason this icon language
 * works at 16px from four feet away: you do not read the glyph, you read how full it is.
 * `blocked`, `gated` and `cancelled` deliberately break the sequence — a filled disc with
 * a minus, a ring with a minus, and a faded ring with a cross. They are not stops on the
 * path and must not look like one.
 *
 * Every state differs in SHAPE, not only in hue. That is a WCAG 1.4.1 requirement and it is
 * also what makes the list survive a projector, a bad monitor, and a red-deficient reader.
 *
 * ── WHY THE SWITCH IS ON THE CATEGORY AND NOT ON THE ID ───────────────────────────────
 *
 * O7 (STA-139/140) made the status set workspace DATA. `pairing`, `awaiting_qa` and
 * `on_ice` are all legal ids, and a switch over the seven built-ins would have fallen
 * through to nothing for every one of them — a row with an invisible status column.
 *
 * Every status carries a category from a fixed set of eight, and the store keys every
 * BEHAVIOUR off that category rather than off the id. This file now keys the glyph off it
 * too, which is what makes the language closed again: a workspace can invent any status it
 * likes and it will draw as the thing it behaves like. A custom status in `active` gets the
 * half-ring and the in_progress hue, which is STA-141's acceptance criterion stated as a
 * picture. The switch is exhaustive over `StatusCategory`, so a ninth category cannot be
 * added to core without this file failing to compile.
 *
 * `gated` — parked awaiting an approval, reserved for STA-142/143 — takes `blocked`'s hue
 * and a DIFFERENT shape: the same minus bar on an unfilled ring rather than a filled disc.
 * Two kinds of waiting, told apart by fill, which is the axis this set already uses.
 *
 * ── COLOUR COMES FROM THE ICON FAMILY, NOT THE CHIP FAMILY ────────────────────────────
 *
 * `--status-task-icon-*` was already tuned to clear 3:1 against the page in both themes,
 * and V1 (STA-86) re-pointed the whole family onto the Geist surfaces. The neighbouring
 * `--status-task-*` tokens are CHIP-FILL SEEDS — they are mixed toward the card inside
 * `.status-chip` and are far too light to carry a bare 1.5px stroke. Reaching for them here
 * is the obvious mistake and it produces a glyph nobody can see in light mode.
 *
 * NO NEW TOKENS were added for the categories. Each one names the icon token of the
 * built-in that seeds it, which is why a default workspace renders byte-identically to
 * what V5 shipped.
 */
import { statusCategory, statusLabel } from "@/lib/settings";
import type { StatusCategory, StatusId } from "@/lib/types";

/**
 * Category -> the existing icon hue token. Eight categories, six tokens: `gated` and
 * `blocked` share, which is deliberate (see the header) and is the same pairing
 * styles/app.css makes for the chip.
 */
const CATEGORY_HUE: Record<StatusCategory, string> = {
  unstarted: "backlog",
  ready: "todo",
  active: "in_progress",
  review: "in_review",
  gated: "blocked",
  blocked: "blocked",
  done: "done",
  cancelled: "cancelled",
};

/** The CSS custom property carrying a category's stroke/fill colour. */
export function statusIconColour(category: StatusCategory): string {
  return `var(--status-task-icon-${CATEGORY_HUE[category]})`;
}

/**
 * 8 even dashes around an r=6 ring. The spec wrote `2 2`, which on a 37.7px circumference
 * gives 9.4 dashes and therefore a visible seam where the pattern fails to close. These are
 * the same values rounded to make the pattern divide the circle exactly.
 */
const BACKLOG_DASHES = "2.4 2.31";

function Glyph({ category }: { category: StatusCategory }) {
  const colour = statusIconColour(category);

  switch (category) {
    case "unstarted":
      return (
        <circle
          cx="8"
          cy="8"
          r="6"
          fill="none"
          stroke={colour}
          strokeWidth="1.5"
          strokeDasharray={BACKLOG_DASHES}
        />
      );

    case "ready":
      return <circle cx="8" cy="8" r="6" fill="none" stroke={colour} strokeWidth="1.5" />;

    case "active":
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke={colour} strokeWidth="1.5" />
          {/* Right half, 12 o'clock clockwise to 6 o'clock. */}
          <path d="M8 8 L8 4 A4 4 0 0 1 8 12 Z" fill={colour} />
        </>
      );

    case "review":
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke={colour} strokeWidth="1.5" />
          {/* 270°: 12 o'clock clockwise round to 9 o'clock. large-arc-flag must be 1. */}
          <path d="M8 8 L8 4 A4 4 0 1 1 4 8 Z" fill={colour} />
        </>
      );

    case "done":
      return (
        <>
          <circle cx="8" cy="8" r="7" fill={colour} />
          <path
            d="M4.8 8.2 L6.9 10.3 L11.2 5.8"
            fill="none"
            stroke="var(--card)"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      );

    case "blocked":
      return (
        <>
          <circle cx="8" cy="8" r="7" fill={colour} />
          <rect x="4.5" y="7.2" width="7" height="1.6" rx="0.8" fill="var(--card)" />
        </>
      );

    case "gated":
      // Blocked's bar on an unfilled ring. Same hue, same symbol, half the weight —
      // "waiting on a person" beside "waiting on a thing", told apart by fill so the
      // pair still survives a monochrome print.
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke={colour} strokeWidth="1.5" />
          <rect x="5" y="7.2" width="6" height="1.6" rx="0.8" fill={colour} />
        </>
      );

    case "cancelled":
      // The only glyph carrying opacity, and it is carrying meaning: cancelled work should
      // recede. A cross on an unfilled ring cannot be "inverse" — there is nothing behind it
      // to invert against — so both strokes take the status hue and the group fades together.
      return (
        <g opacity="0.6">
          <circle cx="8" cy="8" r="6" fill="none" stroke={colour} strokeWidth="1.5" />
          <path
            d="M5.8 5.8 L10.2 10.2 M10.2 5.8 L5.8 10.2"
            stroke={colour}
            strokeWidth="1.5"
            strokeLinecap="round"
          />
        </g>
      );
  }
}

/**
 * `category` may be passed by a caller that already has the row in hand (the settings
 * editor previewing a category it has not saved yet); everything else passes the id and
 * lets `statusCategory` resolve it against the served vocabulary.
 */
export function StatusIcon({
  status,
  category,
  className,
}: {
  status: StatusId;
  category?: StatusCategory;
  className?: string;
}) {
  const resolved = category ?? statusCategory(status);
  const name = `Status: ${statusLabel(status)}`;
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      className={className}
      role="img"
      aria-label={name}
      focusable="false"
    >
      <title>{name}</title>
      <Glyph category={resolved} />
    </svg>
  );
}
