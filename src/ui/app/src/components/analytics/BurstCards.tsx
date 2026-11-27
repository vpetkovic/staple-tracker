/**
 * Work arrives in bursts: one card per run of days with tickets closing. Each says when it was,
 * how much closed, the agent time behind it and the features that landed.
 *
 * Data contract: `bursts` oldest first, each with its `from`/`to` days, `days`, `ticketsDone`,
 * `agentHours`, `bestDay` and up to three `features` (title, closed of children). `hideTitles`
 * drops feature titles for a screen you are about to share.
 */
import { cn } from "@/lib/utils";
import { formatDay, formatDayRange, formatEffortHours } from "./format";

export interface Burst {
  from: string;
  to: string;
  days: number;
  ticketsDone: number;
  agentHours: number;
  bestDay: { day: string; count: number };
  features: readonly { title: string; closed: number; children: number }[];
}

export function BurstCards({ bursts, hideTitles = false, className }: { bursts: readonly Burst[]; hideTitles?: boolean; className?: string }) {
  return (
    <ol className={cn("grid min-w-0 gap-3 @min-[640px]/widget:grid-cols-2 @min-[900px]/widget:grid-cols-3", className)} data-chart="bursts">
      {bursts.map((burst, index) => (
        <li key={burst.from} className="flex min-w-0 flex-col gap-1.5 rounded-lg bg-surface-sunken p-3">
          <p className="flex items-baseline justify-between gap-2 text-label text-muted-foreground">
            <span className="font-medium text-foreground">Burst {index + 1}</span>
            <span className="tabular-nums">
              {formatDayRange(burst.from, burst.to)} · {burst.days} days
            </span>
          </p>
          <p className="text-title font-semibold">
            {burst.ticketsDone.toLocaleString("en-US")} tickets
            <span className="ml-2 text-label font-normal text-muted-foreground">
              {formatEffortHours(burst.agentHours)} of agent time · best day {burst.bestDay.count} on {formatDay(burst.bestDay.day)}
            </span>
          </p>
          {burst.features.length > 0 && !hideTitles ? (
            <ul className="space-y-0.5 text-label text-text-secondary">
              {burst.features.map((feature) => (
                <li key={feature.title} className="flex min-w-0 gap-2">
                  <span className="min-w-0 flex-1 truncate">{feature.title}</span>
                  <span className="shrink-0 text-muted-foreground tabular-nums">
                    {feature.closed} of {feature.children}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </li>
      ))}
    </ol>
  );
}
