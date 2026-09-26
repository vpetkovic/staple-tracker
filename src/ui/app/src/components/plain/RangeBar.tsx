/**
 * The likely-range bar: where a figure will most likely land, on a scale that starts at 0.
 *
 * Marks (one blue ramp, docs/web-ui.md "Plain-language cards"): a pale WIDE band with a ≥3:1 edge,
 * a strong LIKELY band inside it, and the EXPECTED figure as an ink marker with a card-coloured
 * ring. An optional REFERENCE is a dashed line (the estimate, on the estimate-accuracy cards).
 *
 * The drawing is `role="img"` with `description` as its name: every mark in words. The legend
 * under it repeats the same in short form for sighted readers and is hidden from the
 * accessibility tree so nothing is heard twice. Values are the caller's payload figures; the
 * component only positions them (`barPercent`).
 */
import { barPercent } from "@/lib/plain-language";

export interface RangeBarProps {
  /** The right end of the scale (the left is 0). */
  max: number;
  wide: { lower: number; upper: number };
  likely: { lower: number; upper: number };
  /** The expected figure, or null for none. */
  marker: number | null;
  reference?: { value: number; label: string };
  /** The text alternative: every mark in words. */
  description: string;
  legend: { likely: string; wide: string; marker?: string; reference?: string };
  testId?: string;
}

export function RangeBar({ max, wide, likely, marker, reference, description, legend, testId }: RangeBarProps) {
  const at = (value: number): string => `${barPercent(value, max)}%`;
  const span = (lower: number, upper: number): string => `${Math.max(barPercent(upper, max) - barPercent(lower, max), 0.75)}%`;
  return (
    <div className="space-y-2" data-testid={testId}>
      <div role="img" aria-label={description} className="relative h-6 pt-1.5">
        <div className="absolute inset-x-0 top-1.5 h-3 rounded-full border border-[var(--viz-track-edge)]/40 bg-[var(--viz-track)]" />
        <div
          data-mark="wide"
          className="absolute top-1.5 h-3 rounded-full border border-[var(--viz-wide-edge)] bg-[var(--viz-wide)]"
          style={{ left: at(wide.lower), width: span(wide.lower, wide.upper) }}
        />
        <div
          data-mark="likely"
          className="absolute top-1.5 h-3 rounded-full bg-[var(--viz-likely)]"
          style={{ left: at(likely.lower), width: span(likely.lower, likely.upper) }}
        />
        {reference ? (
          <div
            data-mark="reference"
            className="absolute top-0 h-6 w-0 border-l-2 border-dashed border-[var(--viz-marker)]"
            style={{ left: at(reference.value) }}
          />
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
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-full bg-[var(--viz-likely)]" />
          {legend.likely}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-full border border-[var(--viz-wide-edge)] bg-[var(--viz-wide)]" />
          {legend.wide}
        </li>
        {legend.marker && marker !== null ? (
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-[3px] rounded-full bg-[var(--viz-marker)]" />
            {legend.marker}
          </li>
        ) : null}
        {legend.reference && reference ? (
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-0 border-l-2 border-dashed border-[var(--viz-marker)]" />
            {legend.reference}
          </li>
        ) : null}
      </ul>
    </div>
  );
}
