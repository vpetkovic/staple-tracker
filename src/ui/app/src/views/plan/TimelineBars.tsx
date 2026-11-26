/**
 * What the Timeline draws in one row's lane, and the parts around it: the planned track (or a
 * diamond for a target alone), the baseline behind it, the actual line under it with its forecast
 * and the hatching past the plan, the shipped check, the notch, the end label and the tooltip;
 * the range control; and the key. Positions are the lens's; every day is the payload's.
 */
import type { CSSProperties, KeyboardEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import type { IdeaData } from "@/lib/plan-types";
import { cn } from "@/lib/utils";
import { STATE_WORDS } from "@/detail/plan-record";
import { ShippedCheck } from "@/detail/ShippedMark";
import { dayIndex, dayLabel, dayOf, isShipped } from "./plan-model";
import { endLabel, RANGES, targetOnly, type EndLabel, type Range } from "./timeline-model";

/** Where each part sits in a lane, from its top: the wide row's 34px lane, the stacked row's 26px one. */
export const LANE = {
  wide: { baseline: 5, planned: 8, notch: 6, actual: 22 },
  stacked: { baseline: 1, planned: 4, notch: 2, actual: 18 },
} as const;
export type Layout = keyof typeof LANE;

/** The planned track's middle, from the lane's top: where an arrow meets a bar. */
export const BAR_MIDDLE = (layout: Layout) => LANE[layout].planned + 6;

/** Planned: the in-progress hue at about 14% on the card, edged at about 55%. Opaque, so the lines behind do not show through. */
const PLANNED = "border border-[color-mix(in_oklab,var(--status-task-in_progress)_55%,var(--card))] bg-[color-mix(in_oklab,var(--status-task-in_progress)_14%,var(--card))]";
const FORECAST: CSSProperties = { backgroundImage: "repeating-linear-gradient(90deg, var(--text-secondary) 0 4px, transparent 4px 7px)" };
const PAST_PLAN: CSSProperties = { backgroundImage: "repeating-linear-gradient(135deg, var(--color-destructive) 0 2px, transparent 2px 5px)" };
/** A red triangle pointing at the bar's start. */
const NOTCH = "size-0 border-y-8 border-l-[7px] border-y-transparent border-l-destructive";

export interface BarHandlers {
  onPointerDown: (event: ReactPointerEvent, mode: "move" | "start" | "end") => void;
  onPointerMove: (event: ReactPointerEvent) => void;
  onPointerUp: (event: ReactPointerEvent) => void;
  onPointerCancel: () => void;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent) => void;
  onFocus: () => void;
  onBlur: () => void;
}

/**
 * One row's bars. `planned` is the window as drawn (a drag's preview while one runs); `movable`
 * says whether the idea offers its dates, which gives the bar its handles and its grab cursor.
 */
export function RowBars({ idea, planned, layout, x, px, today, notch, movable, waitsOn, handlers }: {
  idea: IdeaData;
  planned: { start: number; end: number } | null;
  layout: Layout;
  x: (day: number) => number;
  px: number;
  today: number;
  notch: boolean;
  movable: boolean;
  waitsOn: string[];
  handlers: BarHandlers;
}) {
  const lane = LANE[layout];
  const diamond = planned !== null && targetOnly(idea);
  const actual = actualOf(idea, today);
  const label = layout === "wide" ? endLabel(idea, today) : null;
  const shipped = isShipped(idea);
  // The end label follows the rightmost part drawn: the plan, or the actual line with its forecast and check.
  const right = Math.max(planned ? x(planned.end + 1) + (diamond ? 6 : 0) : -Infinity, actual ? x(actual.last + 1) + (shipped ? 10 : 0) : -Infinity);
  const tip = <BarTip idea={idea} waitsOn={waitsOn} />;
  const notchAt = planned?.start ?? actual?.start ?? null;
  return (
    <>
      <Baseline idea={idea} x={x} top={lane.baseline} />
      {planned ? (
        <Tip tip={tip}>
          <div
            className={cn(
              "absolute touch-pan-x touch-pan-y outline-none focus-visible:ring-2 focus-visible:ring-ring",
              PLANNED,
              diamond ? "-ml-1.5 size-[11px] rotate-45 rounded-[2px] border-[1.5px]" : "h-3 rounded-[3px]",
              movable ? "cursor-grab" : "cursor-pointer",
            )}
            style={diamond ? { left: x(planned.end + 1), top: lane.planned } : { left: x(planned.start), top: lane.planned, width: Math.max(6, (planned.end - planned.start + 1) * px) }}
            data-plan-bar={idea.id}
            data-plan-target-only={diamond ? idea.id : undefined}
            role="slider"
            aria-label={diamond ? `${idea.title} target ${dayLabel(dayOf(planned.end))}` : `${idea.title} planned ${dayLabel(dayOf(planned.start))} to ${dayLabel(dayOf(planned.end))}`}
            aria-valuetext={diamond ? dayOf(planned.end) : `${dayOf(planned.start)} to ${dayOf(planned.end)}`}
            tabIndex={0}
            onPointerDown={(event) => handlers.onPointerDown(event, "move")}
            onPointerMove={handlers.onPointerMove}
            onPointerUp={handlers.onPointerUp}
            onPointerCancel={handlers.onPointerCancel}
            onClick={handlers.onClick}
            onKeyDown={handlers.onKeyDown}
            onFocus={handlers.onFocus}
            onBlur={handlers.onBlur}
          >
            {movable && !diamond ? (
              <>
                <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" onPointerDown={(event) => handlers.onPointerDown(event, "start")} data-plan-bar-start={idea.id} />
                <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" onPointerDown={(event) => handlers.onPointerDown(event, "end")} data-plan-bar-end={idea.id} />
              </>
            ) : null}
          </div>
        </Tip>
      ) : null}
      {notch && notchAt !== null ? (
        <span className={cn("absolute -ml-[9px]", NOTCH)} style={{ left: x(notchAt), top: lane.notch }} title="Starts before something it waits on ends" data-plan-notch={idea.id} />
      ) : null}
      {actual ? (
        planned ? (
          <ActualBar idea={idea} actual={actual} x={x} px={px} top={lane.actual} />
        ) : (
          // With no plan the actual line is what the person points at: it opens the idea and carries the tooltip.
          <Tip tip={tip}>
            <button type="button" className="absolute h-3 -translate-y-1 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" style={{ left: x(actual.start), top: lane.actual, width: Math.max(8, x(actual.last + 1) - x(actual.start)) }} aria-label={`${idea.title} worked ${dayLabel(dayOf(actual.start))} to ${dayLabel(dayOf(actual.done))}`} onClick={handlers.onClick} onFocus={handlers.onFocus} onBlur={handlers.onBlur}>
              <ActualBar idea={idea} actual={actual} x={(day) => x(day) - x(actual.start)} px={px} top={4} />
            </button>
          </Tip>
        )
      ) : null}
      {label && right > -Infinity ? <EndWords label={label} className="pointer-events-none absolute top-[5px] pl-2 leading-[18px]" style={{ left: right }} /> : null}
    </>
  );
}

/** The end label as the stacked row prints it, at the right of its label line. */
export function EndWords({ label, className, style }: { label: EndLabel | null; className?: string; style?: CSSProperties }) {
  if (!label) return null;
  return (
    <span className={cn("shrink-0 whitespace-nowrap text-caption tabular-nums", label.late ? "font-medium text-flag-late" : "text-text-tertiary", className)} style={style} data-plan-end-label={label.late ? "late" : ""}>
      {label.text}
    </span>
  );
}

interface Actual {
  start: number;
  done: number;
  last: number;
  forecast: number | null;
}

function actualOf(idea: IdeaData, today: number): Actual | null {
  // Work that landed with no recorded start (delivered outside the tracker) is the day it landed.
  const first = idea.actual.start ?? idea.actual.end;
  if (!first) return null;
  const start = dayIndex(first);
  const done = idea.actual.end ? dayIndex(idea.actual.end) : today;
  const forecast = idea.actual.forecastEnd ? dayIndex(idea.actual.forecastEnd) : null;
  return { start, done, forecast, last: Math.max(done, forecast ?? done) };
}

/** The derived line: solid over the work that has happened, dashed to the forecast, hatched past the plan, the check once shipped. */
function ActualBar({ idea, actual, x, px, top }: { idea: IdeaData; actual: Actual; x: (day: number) => number; px: number; top: number }) {
  const { start, done, forecast, last } = actual;
  const plannedEnd = idea.planned.target ? dayIndex(idea.planned.target) : null;
  const slipFrom = plannedEnd !== null && last > plannedEnd ? Math.max(start, plannedEnd + 1) : null;
  const shipped = isShipped(idea);
  return (
    <div className="pointer-events-none absolute h-1" style={{ left: x(start), top, width: Math.max(4, x(last + 1) - x(start)) }} data-plan-actual={idea.id}>
      <div className={cn("absolute inset-y-0 left-0 rounded-sm", shipped ? "bg-[color:var(--status-task-done)]" : "bg-foreground")} style={{ width: Math.max(4, (done - start + 1) * px) }} />
      {forecast !== null && forecast > done ? <div className="absolute inset-y-0" style={{ ...FORECAST, left: (done - start + 1) * px, width: (forecast - done) * px }} data-plan-forecast={idea.id} /> : null}
      {slipFrom !== null ? <div className="absolute -inset-y-0.5 rounded-sm" style={{ ...PAST_PLAN, left: (slipFrom - start) * px, width: (last - slipFrom + 1) * px }} data-plan-slip={idea.id} /> : null}
      {shipped ? (
        <span className="absolute top-1/2 -translate-y-1/2" style={{ left: (done - start + 1) * px - 4 }} data-plan-shipped-cap={idea.id}>
          <ShippedCheck label={`${idea.title} shipped`} className="size-3.5 [&_svg]:size-2.5" />
        </span>
      ) : null}
    </div>
  );
}

/** The baseline, a dashed outline behind the plan, only where it differs from the plan. */
function Baseline({ idea, x, top }: { idea: IdeaData; x: (day: number) => number; top: number }) {
  if (!idea.baseline) return null;
  const start = idea.baseline.start ?? idea.baseline.target;
  const end = idea.baseline.target ?? idea.baseline.start;
  if (!start || !end || (start === idea.planned.start && end === idea.planned.target)) return null;
  return (
    <div
      className="pointer-events-none absolute h-[18px] rounded border border-dashed border-text-tertiary opacity-70"
      style={{ left: x(dayIndex(start)), top, width: Math.max(6, x(dayIndex(end) + 1) - x(dayIndex(start))) }}
      title={`Baseline ${dayLabel(start)} to ${dayLabel(end)}`}
      data-plan-baseline={idea.id}
    />
  );
}

function Tip({ tip, children }: { tip: ReactNode; children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side="bottom" align="start" className="w-[268px] px-3 py-2.5 text-label">
        {tip}
      </TooltipContent>
    </Tooltip>
  );
}

const range = (start: string | null | undefined, end: string | null | undefined) =>
  start && end ? `${dayLabel(start, false)} – ${dayLabel(end)}` : start ? `from ${dayLabel(start)}` : end ? `by ${dayLabel(end)}` : "none";

/** The tooltip's facts: the title, the state and percent, then each window and what it waits on. */
function BarTip({ idea, waitsOn }: { idea: IdeaData; waitsOn: string[] }) {
  const baseline = idea.baseline && (idea.baseline.start !== idea.planned.start || idea.baseline.target !== idea.planned.target) ? idea.baseline : null;
  const actual = idea.actual.start
    ? `${dayLabel(idea.actual.start, false)} – ${idea.actual.end ? dayLabel(idea.actual.end) : "open"}`
    : idea.actual.end
      ? `shipped ${dayLabel(idea.actual.end)}`
      : "not started";
  const rows: Array<[string, string]> = [
    ["State", `${STATE_WORDS[idea.state] ?? idea.state}${idea.percent !== null ? ` · ${idea.percent}%` : ""}`],
    ["Planned", range(idea.planned.start, idea.planned.target)],
    ...(baseline ? [["Baseline", range(baseline.start, baseline.target)] as [string, string]] : []),
    ["Actual", actual],
    ...(idea.actual.forecastEnd ? [["Forecast", dayLabel(idea.actual.forecastEnd)] as [string, string]] : []),
    ...(waitsOn.length > 0 ? [["Waits on", waitsOn.join(", ")] as [string, string]] : []),
  ];
  return (
    <>
      <p className="m-0 mb-1.5 text-body font-semibold">{idea.title}</p>
      <dl className="m-0 grid grid-cols-[70px_1fr] gap-x-2 gap-y-0.5">
        {rows.map(([term, value]) => (
          <div key={term} className="contents">
            <dt className="opacity-70">{term}</dt>
            <dd className="m-0 tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </>
  );
}

/** The range presets, a segmented group. */
export function RangeControl({ range: current, onRange, large = false }: { range: Range; onRange: (range: Range) => void; large?: boolean }) {
  return (
    <div role="group" aria-label="Range" className="inline-flex shrink-0 rounded-[7px] bg-muted p-0.5">
      {RANGES.map((preset) => {
        const on = preset.id === current;
        return (
          <button
            key={preset.id}
            type="button"
            aria-pressed={on}
            data-plan-zoom={preset.id}
            onClick={() => onRange(preset.id)}
            className={cn(
              "focus-ring whitespace-nowrap rounded-[5px] font-medium text-text-secondary hover:text-foreground",
              large ? "h-8 px-[11px] text-body" : "h-[26px] px-2.5 text-label",
              on && "bg-card text-foreground shadow-xs ring-1 ring-border",
            )}
          >
            {preset.label}
          </button>
        );
      })}
    </div>
  );
}

/** What each mark means. */
export function TimelineKey({ className }: { className?: string }) {
  const item = "inline-flex items-center gap-1.5";
  return (
    <div className={cn("flex flex-wrap items-center gap-x-4 gap-y-1 text-caption text-text-tertiary", className)} aria-label="Key" role="group" data-plan-key>
      <span className={item}><i aria-hidden className={cn("h-2.5 w-[22px] rounded-[3px]", PLANNED)} />planned</span>
      <span className={item}><i aria-hidden className="h-1 w-[22px] rounded-sm bg-foreground" />actual</span>
      <span className={item}><i aria-hidden className="h-1 w-[22px]" style={FORECAST} />forecast</span>
      <span className={item}><i aria-hidden className="h-2 w-[22px]" style={PAST_PLAN} />past the plan</span>
      <span className={item}><i aria-hidden className="h-3 w-[22px] rounded-[3px] border border-dashed border-text-tertiary" />baseline</span>
      <span className={item}><i aria-hidden className={cn("inline-block border-y-[6px] border-l-[6px] border-y-transparent border-l-destructive")} />starts before something it waits on ends</span>
    </div>
  );
}
