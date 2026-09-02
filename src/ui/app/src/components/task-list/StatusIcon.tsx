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
  const colour = `var(--status-task-icon-${status})`;

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
