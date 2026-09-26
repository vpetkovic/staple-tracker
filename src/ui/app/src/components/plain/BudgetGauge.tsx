/**
 * The budget gauge of one provider limit: the whole allowance as a bar from 0% to 100%, read left
 * to right as what is LEFT.
 *
 * - solid blue from 0 to `after`: what this work leaves (at the reset);
 * - striped from `after` to `remaining`: what this work is expected to use (striped, not a second
 *   hue, so it reads under colour-blindness and in print);
 * - the grey track beyond `remaining`: already used;
 * - a dashed ink line at `reserve`: the safety reserve.
 *
 * With no projection (`after` null) the fill is simply what is left now. An `after` under 0 (the
 * work alone runs the limit out) is drawn clamped at 0; the sentence beside the gauge says so in
 * words. All values are payload percents; the component only positions them.
 *
 * `role="img"` with `description` (lib/plain-language.ts `gaugeDescription`) as its name; the
 * legend repeats it for sighted readers and is hidden from the accessibility tree.
 */
import { barPercent } from "@/lib/plain-language";

export interface BudgetGaugeProps {
  remaining: number;
  after: number | null;
  reserve: number | null;
  /** The work's use is a lower bound: the legend says "at least" / "at most". */
  lowerBound: boolean;
  description: string;
  testId?: string;
}

const STRIPES = "repeating-linear-gradient(135deg, var(--viz-likely) 0 2px, var(--viz-wide) 2px 6px)";

export function BudgetGauge({ remaining, after, reserve, lowerBound, description, testId }: BudgetGaugeProps) {
  const left = barPercent(remaining, 100);
  const afterAt = after === null ? left : Math.min(left, barPercent(after, 100));
  return (
    <div className="space-y-2" data-testid={testId}>
      <div role="img" aria-label={description} className="relative h-7 pt-2">
        <div className="absolute inset-x-0 top-2 h-3.5 overflow-hidden rounded-full border border-[var(--viz-track-edge)] bg-[var(--viz-track)]">
          <div data-mark="left-after" className="absolute inset-y-0 left-0 bg-[var(--viz-likely)]" style={{ width: `${afterAt}%` }} />
          {after !== null ? (
            <div
              data-mark="this-work"
              className="absolute inset-y-0 border-l-2 border-[var(--card)]"
              style={{ left: `${afterAt}%`, width: `${Math.max(left - afterAt, 0)}%`, backgroundImage: STRIPES }}
            />
          ) : null}
        </div>
        {reserve !== null ? (
          <div data-mark="reserve" className="absolute top-0 h-7 w-0 border-l-2 border-dashed border-[var(--viz-marker)] shadow-[0_0_0_2px_var(--card)]" style={{ left: `${barPercent(reserve, 100)}%` }} />
        ) : null}
      </div>
      <ul aria-hidden className="flex flex-wrap gap-x-4 gap-y-1 text-[12px] text-muted-foreground">
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm bg-[var(--viz-likely)]" />
          {after === null ? `Left now (${Math.round(remaining)}%)` : `Left after this work (${after < 0 ? "none" : `${lowerBound ? "at most" : "about"} ${Math.round(after)}%`})`}
        </li>
        {after !== null ? (
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-2.5 w-4 rounded-sm" style={{ backgroundImage: STRIPES }} />
            {lowerBound ? "This work (at least)" : "This work"}
          </li>
        ) : null}
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-2.5 w-4 rounded-sm border border-[var(--viz-track-edge)] bg-[var(--viz-track)]" />
          Already used
        </li>
        {reserve !== null ? (
          <li className="inline-flex items-center gap-1.5">
            <span className="inline-block h-3 w-0 border-l-2 border-dashed border-[var(--viz-marker)]" />
            Safety reserve ({Math.round(reserve)}%)
          </li>
        ) : null}
      </ul>
    </div>
  );
}
