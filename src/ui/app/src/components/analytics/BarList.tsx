/**
 * Ranked horizontal bars: one named row per item, bars on one baseline, one hue. For comparing
 * parts with each other (workspaces, model families, document types) and for a row of ratios.
 *
 * Data contract: `items` in the order to draw (the caller ranks), each with a `label`, a `value`
 * and the `text` that says the value; `detail` is a quiet second figure on the right. `max`
 * defaults to the largest value. `color` paints a row's bar (a workspace keeps its series colour);
 * without it the bar is the accent.
 */
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export interface BarListItem {
  id: string;
  label: ReactNode;
  value: number;
  /** The value in words: "490 h". */
  text: string;
  detail?: ReactNode;
  color?: string;
  /** A row whose figure is a caveat, not a category ("No model logged"): drawn in the neutral. */
  muted?: boolean;
}

export function BarList({ items, max, labelWidth = "9rem", className, ariaLabel }: { items: readonly BarListItem[]; max?: number; labelWidth?: string; className?: string; ariaLabel: string }) {
  const top = max ?? Math.max(...items.map((item) => item.value), 0);
  return (
    <ul aria-label={ariaLabel} className={cn("@container/bars flex flex-col gap-2", className)} data-chart="bars">
      {items.map((item) => (
        <li key={item.id} className="grid items-center gap-x-3 gap-y-1 @max-[340px]/bars:grid-cols-[1fr_auto] @min-[340px]/bars:grid-cols-[var(--label)_1fr_auto]" style={{ ["--label" as string]: labelWidth }}>
          <span className={cn("min-w-0 truncate text-body", item.muted && "text-muted-foreground italic")}>{item.label}</span>
          <span className="h-2 min-w-0 overflow-hidden rounded-full bg-[var(--viz-track)] @max-[340px]/bars:order-last @max-[340px]/bars:col-span-2">
            <span
              className="block h-full rounded-full"
              style={{ width: top > 0 ? `${Math.max((item.value / top) * 100, item.value > 0 ? 1.5 : 0)}%` : 0, background: item.muted ? "var(--viz-series-other)" : (item.color ?? "var(--viz-accent)") }}
            />
          </span>
          <span className="text-right text-body whitespace-nowrap tabular-nums">
            <span className="font-medium">{item.text}</span>
            {item.detail ? <span className="ml-2 text-label text-muted-foreground">{item.detail}</span> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
