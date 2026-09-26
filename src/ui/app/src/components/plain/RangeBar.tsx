/**
 * The likely-range bar: where a figure will most likely land, on a scale that starts at 0.
 *
 * Marks (one blue ramp, docs/web-ui.md "Plain-language cards"): an optional pale WIDE band with a
 * ≥3:1 edge, a strong LIKELY band, the EXPECTED figure as an ink marker with a card-coloured ring,
 * and an optional REFERENCE as a dashed line (the estimate, on the estimate-accuracy cards).
 *
 * The drawing is `role="img"` with `description` as its name: every mark in words. The legend
 * under it names the marks for sighted readers and is hidden from the accessibility tree so
 * nothing is heard twice; it carries ONE range (the caller's words), never the same range twice.
 * Values are the caller's payload figures; the component only positions them (`barPercent`).
 */
import { barPercent } from "@/lib/plain-language";

export type RangeMark = "likely" | "wide" | "marker" | "reference";

export interface RangeBarProps {
  /** The right end of the scale (the left is 0). */
  max: number;
  wide: { lower: number; upper: number } | null;
  likely: { lower: number; upper: number };
  /** The expected figure, or null for none. */
  marker: number | null;
  reference?: number;
  /** The text alternative: every mark in words. */
  description: string;
  /** The legend, in order; a mark with no entry is not named. */
  legend: Array<{ mark: RangeMark; text: string }>;
  testId?: string;
}

function Swatch({ mark }: { mark: RangeMark }) {
  if (mark === "likely") return <span className="inline-block h-2.5 w-4 shrink-0 rounded-full bg-[var(--viz-likely)]" />;
  if (mark === "wide") return <span className="inline-block h-2.5 w-4 shrink-0 rounded-full border border-[var(--viz-wide-edge)] bg-[var(--viz-wide)]" />;
  if (mark === "marker") return <span className="inline-block h-3 w-[3px] shrink-0 rounded-full bg-[var(--viz-marker)]" />;
  return <span className="inline-block h-3 w-0 shrink-0 border-l-2 border-dashed border-[var(--viz-marker)]" />;
}

export function RangeBar({ max, wide, likely, marker, reference, description, legend, testId }: RangeBarProps) {
  const at = (value: number): string => `${barPercent(value, max)}%`;
  const span = (lower: number, upper: number): string => `${Math.max(barPercent(upper, max) - barPercent(lower, max), 0.75)}%`;
  return (
    <div className="space-y-2" data-testid={testId}>
      <div role="img" aria-label={description} className="relative h-6 pt-1.5">
        <div className="absolute inset-x-0 top-1.5 h-3 rounded-full border border-[var(--viz-track-edge)] bg-[var(--viz-track)]" />
        {wide ? (
          <div
            data-mark="wide"
            className="absolute top-1.5 h-3 rounded-full border border-[var(--viz-wide-edge)] bg-[var(--viz-wide)]"
            style={{ left: at(wide.lower), width: span(wide.lower, wide.upper) }}
          />
        ) : null}
        <div data-mark="likely" className="absolute top-1.5 h-3 rounded-full bg-[var(--viz-likely)]" style={{ left: at(likely.lower), width: span(likely.lower, likely.upper) }} />
        {reference !== undefined ? (
          <div data-mark="reference" className="absolute top-0 h-6 w-0 border-l-2 border-dashed border-[var(--viz-marker)]" style={{ left: at(reference) }} />
        ) : null}
        {marker !== null ? (
          <div
            data-mark="expected"
            className="absolute top-0 h-6 w-[3px] -translate-x-1/2 rounded-full bg-[var(--viz-marker)] ring-2 ring-[var(--card)]"
            style={{ left: at(marker) }}
          />
        ) : null}
      </div>
      <ul aria-hidden className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        {legend.map((entry) => (
          <li key={entry.mark} data-legend={entry.mark} className="inline-flex items-center gap-1.5">
            <Swatch mark={entry.mark} />
            {entry.text}
          </li>
        ))}
      </ul>
    </div>
  );
}
