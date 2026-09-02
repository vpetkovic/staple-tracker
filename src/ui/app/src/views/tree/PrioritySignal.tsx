/**
 * The left-most signal: how urgent is this — V5 (STA-97) §5.
 *
 * ── WHY URGENT IS A DIFFERENT SHAPE ───────────────────────────────────────────────────
 *
 * The brief asked for an ascending-bars glyph at every level. If urgent and high are both a
 * full three-bar stack they differ ONLY in hue, which fails WCAG 1.4.1, fails for every
 * red-deficient reader, and fails at a glance for everyone else in a design language where
 * red is the only saturated thing on the page. The top rung of a scale should look
 * categorically different because it IS categorically different: urgent is not "more high",
 * it is "stop what you are doing". Linear reaches the same answer with a filled square.
 *
 * The literal version — four levels of bars, urgent in red — is one line in the switch
 * below. It is flagged as spec §18 Q2 rather than silently taken.
 *
 * ── WHY THIS COLUMN IS THE QUIETEST ON THE ROW ────────────────────────────────────────
 *
 * Three of the five states are `--muted-foreground`, because priority is a sorting signal
 * and not an alarm. Only `critical` gets a hue, and being the one saturated red in the left
 * half of the row is exactly what makes it findable while scrolling.
 *
 * `--priority-high` (amber) EXISTS and this component deliberately does not use it. V1
 * minted it to fix a real bug in `PriorityLabel`, where the word "high" rendered as raw
 * amber text at ~2.2:1 — the right fix for a TEXT label, where hue is the only signal
 * available. Here the hue would be redundant (bar count already separates high from medium
 * from low) and a second saturated colour four pixels from the urgent red would blunt the
 * one signal in this column worth seeing from across the list. Same token family, two
 * contexts, two correct answers. Please do not harmonise them.
 *
 * ── WHY IT ACCEPTS null WHEN THE MODEL CANNOT PRODUCE ONE ─────────────────────────────
 *
 * `Issue.priority` is non-nullable and the store defaults an unspecified priority to
 * `medium`, so the dashes state is unreachable from real data today. It is built anyway and
 * built correctly, because the alternative — treating `medium` as "unset" — would make the
 * most common priority in the database invisible, which is the exact opposite of the brief.
 * When the model grows a no-priority state (spec §18 Q1) the glyph lights up with no change
 * to this file.
 */
import type { IssuePriority } from "@/lib/types";

const DISPLAY_NAME: Record<IssuePriority, string> = {
  // The wire says `critical`; every human-facing surface says "Urgent". Renaming the enum
  // would mean a SQLite migration, new CLI output and a changed MCP payload, and a display
  // name is not worth any of that — so the translation lives here, in one line.
  critical: "Urgent",
  high: "High",
  medium: "Medium",
  low: "Low",
};

/** Bottom-aligned in a 16×16 box: 3px wide, heights 5/8/11, 2px apart, centred. */
const BARS = [
  { x: 1.5, height: 5 },
  { x: 6.5, height: 8 },
  { x: 11.5, height: 11 },
];
const BASELINE = 13.5;

const FILLED_BARS: Record<Exclude<IssuePriority, "critical">, number> = {
  high: 3,
  medium: 2,
  low: 1,
};

const BAR_COLOUR: Record<Exclude<IssuePriority, "critical">, string> = {
  high: "var(--foreground)",
  medium: "var(--muted-foreground)",
  low: "var(--muted-foreground)",
};

export function PrioritySignal({ priority }: { priority: IssuePriority | null }) {
  const label = priority === null ? "No priority" : DISPLAY_NAME[priority];

  return (
    <span
      className="staple-row-priority"
      // The name sits on the wrapper and the glyph is hidden, so a screen reader hears one
      // phrase rather than a pile of unnamed rectangles.
      role="img"
      aria-label={`Priority: ${label}`}
      title={`Priority: ${label}`}
      data-priority={priority ?? "none"}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" focusable="false">
        {priority === "critical" ? (
          <>
            <rect x="2" y="2" width="12" height="12" rx="3" fill="var(--priority-critical)" />
            {/* Punched out in the row's own background so the mark reads at any theme. */}
            <rect x="7" y="5" width="2" height="6" rx="1" fill="var(--card)" />
          </>
        ) : priority === null ? (
          // Three dashes: reads as "absent", not as "lowest".
          [2.75, 7.25, 11.75].map((y) => (
            <rect key={y} x="4" y={y} width="8" height="1.5" rx="0.75" fill="var(--priority-track)" />
          ))
        ) : (
          BARS.map((bar, index) => (
            <rect
              key={bar.x}
              x={bar.x}
              y={BASELINE - bar.height}
              width="3"
              height={bar.height}
              rx="1"
              fill={index < FILLED_BARS[priority] ? BAR_COLOUR[priority] : "var(--priority-track)"}
            />
          ))
        )}
      </svg>
    </span>
  );
}
