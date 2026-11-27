/**
 * One whole split into parts: a 28px bar of blocks with each share printed on its block where it
 * fits, and a legend that names every part with its amount (so a part too narrow for a label, and
 * a touch reader, still gets the figure).
 *
 * Data contract: `parts` in the order to draw, each `{ id, label, value }` with an optional colour;
 * parts at zero draw nothing. Colours default to the categorical slots in order, so use it for at
 * most six parts and fold a tail into "Other" before passing it in. `tone="ordinal"` draws one hue
 * from dark to light for ordered parts (priority). A share is printed on its block from 9%; every
 * part's name, amount and share stay in the bar's accessible name, so nothing needs hover. With
 * every part at zero the name says "nothing to show".
 */
import { cn } from "@/lib/utils";
import { seriesColor } from "./chart-parts";
import { formatPercent } from "./format";

export interface SegmentPart {
  id: string;
  label: string;
  value: number;
  color?: string;
}

const ORDINAL = ["color-mix(in oklab, var(--viz-accent) 100%, var(--foreground) 0%)", "color-mix(in oklab, var(--viz-accent) 72%, var(--viz-track))", "color-mix(in oklab, var(--viz-accent) 46%, var(--viz-track))", "color-mix(in oklab, var(--viz-accent) 26%, var(--viz-track))"];

export function SegmentedBar({ parts, tone = "categorical", format = (value) => value.toLocaleString("en-US"), ariaLabel, className }: {
  parts: readonly SegmentPart[];
  tone?: "categorical" | "ordinal";
  format?: (value: number) => string;
  ariaLabel: string;
  className?: string;
}) {
  const drawn = parts.filter((part) => part.value > 0);
  const total = drawn.reduce((sum, part) => sum + part.value, 0);
  const colorOf = (part: SegmentPart, index: number) => part.color ?? (tone === "ordinal" ? (ORDINAL[Math.min(index, ORDINAL.length - 1)] as string) : seriesColor(index + 1));
  const summary = drawn.map((part) => `${part.label} ${format(part.value)} (${formatPercent(part.value / total)})`).join(", ");
  const name = summary ? `${ariaLabel}: ${summary}` : `${ariaLabel}: nothing to show`;
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", className)} data-chart="segments">
      <div role="img" aria-label={name} className="flex h-7 w-full gap-[2px]">
        {drawn.map((part, index) => {
          const share = part.value / total;
          // Ordinal steps 3 and 4 are light: their label is ink, not white.
          const lightBlock = tone === "ordinal" && index >= 2;
          return (
            <span
              key={part.id}
              data-mark
              title={`${part.label}: ${format(part.value)} (${formatPercent(share)})`}
              className={cn("flex min-w-[3px] items-center overflow-hidden rounded-[4px] px-1.5 text-caption font-semibold", lightBlock ? "text-foreground" : "text-white")}
              style={{ flexGrow: Number((share * 100).toFixed(4)), flexBasis: 0, background: colorOf(part, index) }}
            >
              {share >= 0.09 ? formatPercent(share) : null}
            </span>
          );
        })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-label text-muted-foreground">
        {drawn.map((part, index) => (
          <li key={part.id} className="inline-flex items-center gap-1.5">
            <span aria-hidden data-mark className="size-2.5 shrink-0 rounded-[3px]" style={{ background: colorOf(part, index) }} />
            {part.label}
            <span className="font-medium text-foreground tabular-nums">{format(part.value)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
