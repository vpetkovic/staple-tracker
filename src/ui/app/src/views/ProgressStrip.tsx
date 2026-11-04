/**
 * A segmented progress bar with a plain legend — the visual half of the Queue and Milestones
 * summaries. Layout only: the caller decides what the segments are and what they are called.
 *
 * The bar is decoration for a sighted reader; the legend is real text beside it, so the
 * numbers never live in colour alone (WCAG 1.4.1). The whole strip carries one sentence as
 * its accessible name.
 */
import "./progress-strip.css";

export interface ProgressSegment {
  key: string;
  count: number;
  /** "finished", "being worked on" — the legend word, lower case. */
  word: string;
  /** A token role for the segment colour, e.g. `var(--status-task-done)`. */
  color: string;
}

export function ProgressStrip({
  segments,
  label,
  testId,
  compact = false,
}: {
  segments: readonly ProgressSegment[];
  /** The one sentence a screen reader hears for the whole strip. */
  label: string;
  testId?: string;
  /** Bar only, no legend: for a row inside a list. */
  compact?: boolean;
}) {
  const total = segments.reduce((sum, segment) => sum + segment.count, 0);
  return (
    <div className="staple-progress" data-testid={testId} data-compact={compact ? "" : undefined} role="img" aria-label={label}>
      <div className="staple-progress-bar" aria-hidden="true">
        {total === 0 ? null : (
          segments
            .filter((segment) => segment.count > 0)
            .map((segment) => (
              <span
                key={segment.key}
                className="staple-progress-seg"
                data-segment={segment.key}
                style={{ flexGrow: segment.count, background: segment.color }}
              />
            ))
        )}
      </div>
      {compact ? null : (
        <ul className="staple-progress-legend" aria-hidden="true">
          {segments.map((segment) => (
            <li key={segment.key} data-legend={segment.key} data-empty={segment.count === 0 ? "" : undefined}>
              <span className="staple-progress-dot" style={{ background: segment.color }} />
              <span className="staple-progress-count">{segment.count}</span> {segment.word}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
