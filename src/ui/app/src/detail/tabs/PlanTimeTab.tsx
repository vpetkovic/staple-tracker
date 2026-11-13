/**
 * Time for an idea: its planned window against what really happened, with the baseline the plan
 * was first started on. An idea has no estimate (that is a task's), so this is the plan's own
 * clock: three bars on one axis, and the words a reader needs when the bars disagree.
 */
import type { IdeaData, PlanWindow } from "@/lib/plan-types";
import { dayIndex, dayLabel } from "@/views/plan/plan-model";
import { planRecordOf } from "../plan-record";
import type { TabProps } from "./registry";

interface Bar {
  key: "planned" | "baseline" | "actual";
  label: string;
  start: string | null;
  end: string | null;
  open?: boolean;
}

export function PlanTimeTab({ detail }: TabProps) {
  const record = planRecordOf(detail);
  if (!record) return null;
  const { idea } = record;
  const bars = barsOf(idea);
  const days = bars.flatMap((bar) => [bar.start, bar.end]).filter((day): day is string => day !== null);
  const today = record.today;
  const from = days.length > 0 ? Math.min(...days.map(dayIndex), dayIndex(today)) : dayIndex(today);
  const to = days.length > 0 ? Math.max(...days.map(dayIndex), dayIndex(today)) : dayIndex(today);
  const span = Math.max(1, to - from + 1);
  const at = (day: string) => ((dayIndex(day) - from) / span) * 100;
  return (
    <div className="space-y-5" data-plan-time={idea.id}>
      <p className="m-0 text-body text-text-secondary" data-plan-time-summary>
        {summary(idea)}
      </p>
      {days.length > 0 ? (
        <div className="relative space-y-3 pt-1">
          {bars.map((bar) => (
            <div key={bar.key} className="grid grid-cols-[5.5rem_1fr] items-center gap-3 text-label" data-plan-time-bar={bar.key}>
              <span className="text-text-tertiary">{bar.label}</span>
              <div className="relative h-5 rounded bg-muted/40">
                {bar.start ? (
                  <div
                    className={barClass(bar)}
                    style={{ left: `${at(bar.start)}%`, width: `${Math.max(1.5, at(bar.end ?? today) - at(bar.start) + 100 / span)}%` }}
                    title={`${dayLabel(bar.start)} to ${bar.end ? dayLabel(bar.end) : "open"}`}
                  />
                ) : null}
              </div>
            </div>
          ))}
          <div className="pointer-events-none absolute inset-y-0 right-0 left-[calc(5.5rem+0.75rem)]">
            <div className="absolute inset-y-0 w-px bg-primary/60" style={{ left: `${at(today)}%` }} title={`Today, ${dayLabel(today)}`} />
          </div>
        </div>
      ) : null}
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-label">
        {bars.map((bar) => (
          <div key={bar.key} className="contents">
            <dt className="text-text-tertiary">{bar.label}</dt>
            <dd className="m-0">{bar.start || bar.end ? `${dayLabel(bar.start)} to ${bar.end ? dayLabel(bar.end) : bar.open ? "open" : "—"}` : "—"}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function barsOf(idea: IdeaData): Bar[] {
  const window = (key: Bar["key"], label: string, w: PlanWindow | null): Bar => ({ key, label, start: w?.start ?? null, end: w?.target ?? null });
  return [
    window("planned", "Planned", idea.planned),
    window("baseline", "Baseline", idea.baseline),
    { key: "actual", label: "Actual", start: idea.actual.start, end: idea.actual.end ?? idea.actual.forecastEnd, open: idea.actual.end === null },
  ];
}

function barClass(bar: Bar): string {
  if (bar.key === "planned") return "absolute inset-y-0.5 rounded bg-primary/70";
  if (bar.key === "baseline") return "absolute inset-y-0.5 rounded border-2 border-dashed border-text-tertiary/70";
  return bar.open ? "absolute inset-y-0.5 rounded bg-[color:var(--status-task-done)]/60" : "absolute inset-y-0.5 rounded bg-[color:var(--status-task-done)]";
}

function summary(idea: IdeaData): string {
  // Marked delivered outside the tracker with nothing linked: it landed on its delivery day.
  if (idea.delivered && idea.linkCount === 0) return `Delivered outside the tracker ${dayLabel(idea.delivered.on)}${idea.late ? ", later than planned" : ""}.`;
  if (idea.linkCount === 0) {
    if (idea.notStarted) return "Not started: its planned start has passed and nothing is linked or promoted yet.";
    return idea.planned.start || idea.planned.target ? "Planned, not started. The actual window appears once work is linked or the idea is promoted." : "No planned window yet.";
  }
  if (idea.stage === "shipped") return `Shipped ${dayLabel(idea.actual.end)}${idea.late ? ", later than planned" : ""}.`;
  if (idea.late) return "Late: its work runs past the planned end or the horizon's date.";
  return idea.actual.start ? `Underway since ${dayLabel(idea.actual.start)}${idea.actual.forecastEnd ? `, forecast to land about ${dayLabel(idea.actual.forecastEnd)}` : ""}.` : "Started: work is linked, and nobody has begun it yet.";
}
