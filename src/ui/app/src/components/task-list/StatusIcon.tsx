/**
 * All seven statuses as a 16px glyph — V5 (STA-97) §6.1.
 *
 * ── THE SEQUENCE IS THE POINT ─────────────────────────────────────────────────────────
 *
 *   backlog → todo → in_progress → in_review → done
 *   dashed  → empty → half        → three-quarter → complete
 *
 * It reads as a progress ring filling up, which is the whole reason this icon language
 * works at 16px from four feet away: you do not read the glyph, you read how full it is.
 * `blocked` and `cancelled` deliberately break the sequence — a filled disc with a minus,
 * and a faded ring with a cross. They are not stops on the path and must not look like one.
 *
 * Every state differs in SHAPE, not only in hue. That is a WCAG 1.4.1 requirement and it is
 * also what makes the list survive a projector, a bad monitor, and a red-deficient reader.
 *
 * ── COLOUR COMES FROM THE ICON FAMILY, NOT THE CHIP FAMILY ────────────────────────────
 *
 * `--status-task-icon-*` was already tuned to clear 3:1 against the page in both themes,
 * and V1 (STA-86) re-pointed the whole family onto the Geist surfaces. The neighbouring
 * `--status-task-*` tokens are CHIP-FILL SEEDS — they are mixed toward the card inside
 * `.status-chip` and are far too light to carry a bare 1.5px stroke. Reaching for them here
 * is the obvious mistake and it produces a glyph nobody can see in light mode.
 */
import type { IssueStatus } from "@/lib/types";
import { STATUS_LABEL } from "./model";

/**
 * 8 even dashes around an r=6 ring. The spec wrote `2 2`, which on a 37.7px circumference
 * gives 9.4 dashes and therefore a visible seam where the pattern fails to close. These are
 * the same values rounded to make the pattern divide the circle exactly.
 */
const BACKLOG_DASHES = "2.4 2.31";

function Glyph({ status }: { status: IssueStatus }) {
  /**
   * `awaiting_approval` SHARES `in_review`'s hue, deliberately and permanently —
   * Q2 (STA-144). No new token is minted.
   *
   * Q1 wrote this as a CSS fallback off an undefined custom property, which was
   * the honest placeholder ("nobody has decided yet") but is the wrong shape for
   * a decision: a fallback reads as a token that is coming, and the first person
   * to define `--status-task-icon-awaiting_approval` would silently change the
   * icon. This points at the real token by name instead.
   *
   * SHARING IS CORRECT HERE, not a shortcut. The icon language differentiates by
   * SHAPE — that is the WCAG 1.4.1 argument at the top of this file, and it is
   * why `done` and `blocked` can both be a filled disc. in_review and
   * awaiting_approval are the two "a human is looking at this" states, so one hue
   * across the pair is the same fact the ring/hourglass split then refines. A
   * ninth hue would claim a distinction the palette does not have room to make
   * legibly at 16px, and every hue added past that point makes the other eight
   * harder to tell apart.
   */
  const colour =
    status === "awaiting_approval"
      ? "var(--status-task-icon-in_review)"
      : `var(--status-task-icon-${status})`;

  switch (status) {
    case "backlog":
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

    case "todo":
      return <circle cx="8" cy="8" r="6" fill="none" stroke={colour} strokeWidth="1.5" />;

    case "in_progress":
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke={colour} strokeWidth="1.5" />
          {/* Right half, 12 o'clock clockwise to 6 o'clock. */}
          <path d="M8 8 L8 4 A4 4 0 0 1 8 12 Z" fill={colour} />
        </>
      );

    case "in_review":
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

    case "awaiting_approval":
      /**
       * AN HOURGLASS IN A RING — Q2 (STA-144).
       *
       * It breaks the fill sequence on purpose, exactly as `blocked` and
       * `cancelled` do: parked is not a stop on the backlog -> done path, and a
       * partially-filled ring would file it as one. What it says instead is the
       * one thing that is true of this state and no other — TIME IS PASSING AND
       * NOBODY HERE CAN MOVE IT. That is the whole of STA-142's origin story
       * (STA-108 sitting in_progress for 56 minutes while it waited on a human),
       * so the glyph is the sentence.
       *
       * The ring is `in_review`'s exact ring, and that is the intended reading:
       * this is the in_review family, one step further along. The hourglass is
       * two triangles meeting at a waist, drawn as a single path so it stays one
       * mark rather than three at 16px, with the caps left as separate 1.4px bars
       * so the silhouette survives being scaled down or printed.
       *
       * Sized to sit inside r=6 with the same optical weight as the pause bars it
       * replaces: 5px wide, 6.4px tall, centred on (8, 8).
       */
      return (
        <>
          <circle cx="8" cy="8" r="6" fill="none" stroke={colour} strokeWidth="1.5" />
          {/* Top bulb down to the waist, then back out to the bottom bulb. */}
          <path
            d="M5.6 4.9 L10.4 4.9 L8 8 L10.4 11.1 L5.6 11.1 L8 8 Z"
            fill={colour}
            stroke={colour}
            strokeWidth="0.7"
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

export function StatusIcon({ status, className }: { status: IssueStatus; className?: string }) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      className={className}
      role="img"
      aria-label={`Status: ${STATUS_LABEL[status]}`}
      focusable="false"
    >
      <title>{`Status: ${STATUS_LABEL[status]}`}</title>
      <Glyph status={status} />
    </svg>
  );
}
