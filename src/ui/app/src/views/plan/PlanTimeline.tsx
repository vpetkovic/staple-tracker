/**
 * The Timeline lens: ideas as rows grouped by horizon, on a month axis.
 *
 * Each row shows the PLANNED window, which the person edits by dragging the bar (move) or its
 * ends (resize), and, once work is linked, the ACTUAL window derived from it: solid while
 * work has happened, dashed to the forecast end, hatched where it runs past the planned end.
 * A started idea that was re-planned shows its baseline as a faint outline behind the plan.
 * Vertical lines mark today and every dated horizon.
 *
 * The chart scrolls inside its own frame in both directions with the idea names pinned on
 * the left and the axis pinned on top, so the page itself never scrolls sideways.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Button } from "@/components/ui/button";
import type { IdeaData, PlanData } from "@/lib/plan-types";
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { Chip, type Write } from "./PlanBoards";
import { dayIndex, dayLabel, dayOf, dragWindow, monthsIn, riskOf, timelineGroups, timelineRange } from "./plan-model";
import { offers } from "@/detail/plain-actions";

/** Every bar is drawn in a 40px band; a phone row is taller so its name can take up to three lines. */
const BAND = 40;
type Zoom = "fit" | "month" | "week";
const ZOOM_PX: Record<Exclude<Zoom, "fit">, number> = { month: 5, week: 18 };

interface Drag {
  id: string;
  mode: "move" | "start" | "end";
  x0: number;
  window: { start: number; end: number };
  moved: boolean;
}

export function PlanTimeline({ plan, write, onOpen, selected }: { plan: PlanData; write: Write; onOpen: (id: string) => void; selected: string | null }) {
  const desk = useIsDesk();
  const nameWidth = desk ? 240 : 176;
  const rowHeight = desk ? BAND : 52;
  const [zoom, setZoom] = useState<Zoom>(desk ? "fit" : "month");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [preview, setPreview] = useState<{ id: string; start: number; end: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [frameWidth, setFrameWidth] = useState(1000);

  useEffect(() => {
    const element = frame.current;
    if (!element || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => setFrameWidth(element.clientWidth));
    observer.observe(element);
    setFrameWidth(element.clientWidth);
    return () => observer.disconnect();
  }, []);

  const range = useMemo(() => timelineRange(plan), [plan]);
  const days = range.to - range.from;
  const px = zoom === "fit" ? Math.max(1.5, (frameWidth - nameWidth - 8) / days) : ZOOM_PX[zoom];
  const width = Math.ceil(days * px);
  const x = (day: number) => (day - range.from) * px;
  const groups = useMemo(() => timelineGroups(plan, folded), [plan, folded]);
  const months = useMemo(() => monthsIn(range), [range]);
  const today = dayIndex(plan.today);

  // Bring today into view once per zoom level, after the frame has been measured.
  const centred = useRef<Zoom | null>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element || element.clientWidth === 0 || centred.current === zoom) return;
    centred.current = zoom;
    const visible = element.clientWidth;
    if (width > visible - nameWidth) element.scrollLeft = Math.max(0, x(today) - (visible - nameWidth) / 3);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, frameWidth, width]);

  const begin = (event: ReactPointerEvent, idea: IdeaData, mode: Drag["mode"]) => {
    // Dates move only where the idea's state offers it (a shipped or raw idea's bar stays put).
    if (!offers(idea, "plan_dates")) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const start = idea.planned.start ?? idea.planned.target!;
    const end = idea.planned.target ?? idea.planned.start!;
    drag.current = { id: idea.id, mode, x0: event.clientX, window: { start: dayIndex(start), end: dayIndex(end) }, moved: false };
  };
  const move = (event: ReactPointerEvent) => {
    const current = drag.current;
    if (!current) return;
    const delta = Math.round((event.clientX - current.x0) / px);
    if (delta !== 0) current.moved = true;
    setPreview({ id: current.id, ...dragWindow(current.window, current.mode, delta) });
  };
  const end = (event: ReactPointerEvent) => {
    const current = drag.current;
    drag.current = null;
    if (!current) return;
    const delta = Math.round((event.clientX - current.x0) / px);
    const next = dragWindow(current.window, current.mode, delta);
    if (!current.moved || (next.start === current.window.start && next.end === current.window.end)) {
      setPreview(null);
      if (!current.moved) onOpen(current.id);
      return;
    }
    void write("update", { ref: current.id, plannedStart: dayOf(next.start), plannedTarget: dayOf(next.end) }).finally(() => setPreview(null));
  };

  const addDates = (idea: IdeaData) =>
    void write("update", { ref: idea.id, plannedStart: plan.today, plannedTarget: dayOf(today + 28) });

  return (
    <div className="flex h-full min-h-0 flex-col" data-plan-timeline>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-gutter pt-2">
        <p className="hidden min-w-0 flex-1 text-caption text-text-tertiary md:block">
          Drag a planned bar to move it, its ends to change the dates. Actual dates come from the linked work.
        </p>
        <div className="flex items-center gap-1" role="group" aria-label="Zoom">
          {(["fit", "month", "week"] as const).map((level) => (
            <Button key={level} size="sm" variant={zoom === level ? "secondary" : "ghost"} className="min-h-8 capitalize" aria-pressed={zoom === level} onClick={() => setZoom(level)} data-plan-zoom={level}>
              {level === "fit" ? "Fit" : level}
            </Button>
          ))}
        </div>
      </div>
      <Legend />
      <div ref={frame} className="relative mx-gutter mb-3 min-h-0 flex-1 overflow-auto rounded-lg border bg-card" data-plan-timeline-frame>
        <div className="relative" style={{ width: nameWidth + width }}>
          {/* The axis, pinned on top. */}
          <div className="sticky top-0 z-20 flex h-8 border-b bg-card">
            <div className="sticky left-0 z-30 shrink-0 border-r bg-card" style={{ width: nameWidth }} />
            <div className="relative" style={{ width }}>
              {months.map((month) => (
                <div key={month.day} className="absolute top-0 h-full border-l pl-1 text-caption leading-8 text-text-tertiary" style={{ left: x(month.day) }}>
                  {px * 30 > 34 ? month.label : ""}
                </div>
              ))}
              <span className="absolute top-1.5 z-10 -translate-x-1/2 rounded bg-primary px-1 text-[10px] leading-5 text-primary-foreground" style={{ left: x(today) }}>
                today
              </span>
            </div>
          </div>
          {/* Today and every dated horizon, through the whole chart. */}
          <div className="pointer-events-none absolute inset-y-0 z-10" style={{ left: nameWidth, width }}>
            <div className="absolute inset-y-0 w-px bg-primary" style={{ left: x(today) }} data-plan-today />

            {plan.horizons
              .filter((horizon) => horizon.date)
              .map((horizon) => (
                <div key={horizon.id} className="absolute inset-y-0 border-l border-dashed border-destructive/70" style={{ left: x(dayIndex(horizon.date!) + 1) }} data-plan-horizon-line={horizon.identifier}>
                  <span className="absolute top-9 left-1 whitespace-nowrap rounded bg-card/90 px-1 text-[10px] leading-4 text-destructive">{horizon.name}</span>
                </div>
              ))}
          </div>
          {groups.map((group) => {
            const risk = riskOf(group.rows.map((row) => row.idea).concat(group.undated));
            return (
              <div key={group.key} data-plan-timeline-group={group.key || "none"}>
                <div className="flex border-b bg-surface-sunken" style={{ height: BAND - 8 }}>
                  <div className="sticky left-0 z-10 flex shrink-0 items-center gap-2 border-r bg-surface-sunken px-2 text-label font-semibold" style={{ width: nameWidth }}>
                    <span className="truncate">{group.title}</span>
                    {group.date ? <span className="shrink-0 font-normal text-text-tertiary">{dayLabel(group.date, false)}</span> : null}
                  </div>
                  <div className="sticky z-10 flex items-center gap-1.5 px-2 text-caption" style={{ left: nameWidth }}>
                    {risk.late > 0 ? <Chip tone="red">{risk.late} late</Chip> : null}
                    {risk.notStarted > 0 ? <Chip tone="amber">{risk.notStarted} not started</Chip> : null}
                  </div>
                </div>
                {group.rows.map((row) => {
                  const idea = row.idea;
                  const planned = preview?.id === idea.id ? { start: preview.start, end: preview.end } : windowOf(idea);
                  return (
                    <div key={idea.id} className={cn("flex border-b", selected === idea.id && "bg-surface-selected")} style={{ height: rowHeight }} data-plan-timeline-row={idea.id}>
                      <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1 border-r bg-card pr-2" style={{ width: nameWidth, paddingLeft: 4 + row.depth * (desk ? 14 : 10) }}>
                        {row.folds ? (
                          <button
                            type="button"
                            className="flex size-6 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover"
                            aria-label={folded.has(idea.id) ? `Show ${idea.title}'s sub-ideas` : `Hide ${idea.title}'s sub-ideas`}
                            aria-expanded={!folded.has(idea.id)}
                            onClick={() => {
                              const next = new Set(folded);
                              if (next.has(idea.id)) next.delete(idea.id);
                              else next.add(idea.id);
                              setFolded(next);
                            }}
                          >
                            {folded.has(idea.id) ? <ChevronRight className="size-3.5" aria-hidden /> : <ChevronDown className="size-3.5" aria-hidden />}
                          </button>
                        ) : (
                          <span className="w-6 shrink-0" />
                        )}
                        <button type="button" className={cn("min-w-0 flex-1 text-left text-label hover:underline", desk ? "truncate" : "line-clamp-3 leading-tight [overflow-wrap:anywhere]")} onClick={() => onOpen(idea.id)} title={idea.title} data-plan-timeline-name={idea.id}>
                          {idea.title}
                        </button>
                        {idea.late ? <span className="size-1.5 shrink-0 rounded-full bg-destructive" aria-label="late" /> : idea.notStarted ? <span className="size-1.5 shrink-0 rounded-full bg-[color:var(--status-task-todo)]" aria-label="not started" /> : null}
                      </div>
                      <div className="relative" style={{ width }}>
                        <div className="absolute inset-x-0 top-1/2 -translate-y-1/2" style={{ height: BAND }}>
                        {idea.baseline ? <BaselineGhost idea={idea} x={x} /> : null}
                        {planned ? (
                          <div
                            className="group absolute top-2 h-4 cursor-grab touch-none rounded-sm border border-[color:var(--status-task-in_progress)]/70 bg-[color:var(--status-task-in_progress)]/20 hover:bg-[color:var(--status-task-in_progress)]/30 focus-visible:ring-2 focus-visible:ring-ring"
                            style={{ left: x(planned.start), width: Math.max(6, (planned.end - planned.start + 1) * px) }}
                            data-plan-bar={idea.id}
                            role="slider"
                            aria-label={`${idea.title} planned ${dayLabel(dayOf(planned.start))} to ${dayLabel(dayOf(planned.end))}`}
                            aria-valuetext={`${dayOf(planned.start)} to ${dayOf(planned.end)}`}
                            tabIndex={0}
                            onPointerDown={(event) => begin(event, idea, "move")}
                            onPointerMove={move}
                            onPointerUp={end}
                            onPointerCancel={() => {
                              drag.current = null;
                              setPreview(null);
                            }}
                            onKeyDown={(event) => {
                              const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
                              if (step === 0 || !planned) return;
                              event.preventDefault();
                              const mode = event.shiftKey ? "end" : "move";
                              const next = dragWindow(planned, mode, step * 7);
                              void write("update", { ref: idea.id, plannedStart: dayOf(next.start), plannedTarget: dayOf(next.end) });
                            }}
                          >
                            <span className="absolute inset-y-0 left-0 w-2 cursor-ew-resize" onPointerDown={(event) => begin(event, idea, "start")} onPointerMove={move} onPointerUp={end} data-plan-bar-start={idea.id} />
                            <span className="absolute inset-y-0 right-0 w-2 cursor-ew-resize" onPointerDown={(event) => begin(event, idea, "end")} onPointerMove={move} onPointerUp={end} data-plan-bar-end={idea.id} />
                          </div>
                        ) : null}
                        <ActualBar idea={idea} x={x} px={px} today={today} />
                        </div>
                      </div>
                    </div>
                  );
                })}
                {group.undated.length > 0 ? (
                  <div className="flex border-b" data-plan-undated={group.key || "none"}>
                    <div className="sticky left-0 z-10 shrink-0 border-r bg-card px-2 py-1.5 text-caption text-text-tertiary" style={{ width: nameWidth }}>
                      No dates yet
                    </div>
                    <div className="sticky flex flex-wrap items-center gap-1.5 px-2 py-1.5" style={{ left: nameWidth }}>
                      {group.undated.map((idea) =>
                        offers(idea, "plan_dates") ? (
                          <Button key={idea.id} size="sm" variant="outline" className="h-7 text-caption" onClick={() => addDates(idea)} data-plan-add-dates={idea.id}>
                            {idea.title} · add dates
                          </Button>
                        ) : (
                          <span key={idea.id} className="inline-flex h-7 items-center rounded-md border border-dashed px-2 text-caption text-text-tertiary" data-plan-undated-idea={idea.id}>
                            {idea.title}
                          </span>
                        ),
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function windowOf(idea: IdeaData): { start: number; end: number } | null {
  const start = idea.planned.start ?? idea.planned.target;
  const end = idea.planned.target ?? idea.planned.start;
  return start && end ? { start: dayIndex(start), end: dayIndex(end) } : null;
}

function BaselineGhost({ idea, x }: { idea: IdeaData; x: (day: number) => number }) {
  const start = idea.baseline!.start ?? idea.baseline!.target;
  const end = idea.baseline!.target ?? idea.baseline!.start;
  if (!start || !end) return null;
  const same = start === idea.planned.start && end === idea.planned.target;
  if (same) return null;
  return (
    <div
      className="pointer-events-none absolute top-1 h-6 rounded-sm border border-dashed border-text-tertiary/70"
      style={{ left: x(dayIndex(start)), width: Math.max(6, x(dayIndex(end) + 1) - x(dayIndex(start))) }}
      title={`Baseline ${dayLabel(start)} to ${dayLabel(end)}`}
      data-plan-baseline={idea.id}
    />
  );
}

/** The derived bar: solid over the work that has happened, dashed to the forecast, hatched past the plan. */
function ActualBar({ idea, x, px, today }: { idea: IdeaData; x: (day: number) => number; px: number; today: number }) {
  if (!idea.actual.start) return null;
  const start = dayIndex(idea.actual.start);
  const done = idea.actual.end ? dayIndex(idea.actual.end) : today;
  const forecast = idea.actual.forecastEnd ? dayIndex(idea.actual.forecastEnd) : null;
  const plannedEnd = idea.planned.target ? dayIndex(idea.planned.target) : null;
  const last = Math.max(done, forecast ?? done);
  const slipFrom = plannedEnd !== null && last > plannedEnd ? Math.max(start, plannedEnd + 1) : null;
  const shipped = idea.stage === "shipped";
  return (
    <div className="pointer-events-none absolute top-[26px] h-1.5" style={{ left: x(start), width: Math.max(4, x(last + 1) - x(start)) }} data-plan-actual={idea.id}>
      <div className={cn("absolute inset-y-0 left-0 rounded-full", shipped ? "bg-[color:var(--status-task-done)]" : "bg-foreground/80")} style={{ width: Math.max(4, (done - start + 1) * px) }} />
      {forecast !== null && forecast > done ? (
        <div className="absolute inset-y-0 rounded-full border border-dashed border-foreground/60" style={{ left: (done - start + 1) * px, width: (forecast - done) * px }} data-plan-forecast={idea.id} />
      ) : null}
      {slipFrom !== null ? (
        <div
          className="absolute -inset-y-0.5 rounded-sm"
          style={{
            left: (slipFrom - start) * px,
            width: (last - slipFrom + 1) * px,
            backgroundImage: "repeating-linear-gradient(135deg, var(--color-destructive) 0 2px, transparent 2px 5px)",
            opacity: 0.8,
          }}
          data-plan-slip={idea.id}
        />
      ) : null}
    </div>
  );
}

function Legend() {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-gutter py-2 text-caption text-text-tertiary" aria-label="Legend">
      <span className="flex items-center gap-1.5"><span className="h-3 w-6 rounded-sm border border-[color:var(--status-task-in_progress)]/70 bg-[color:var(--status-task-in_progress)]/20" />planned</span>
      <span className="flex items-center gap-1.5"><span className="h-3 w-6 rounded-sm border border-dashed border-text-tertiary/70" />baseline</span>
      <span className="flex items-center gap-1.5"><span className="h-1.5 w-6 rounded-full bg-foreground/80" />actual</span>
      <span className="flex items-center gap-1.5"><span className="h-1.5 w-6 rounded-full border border-dashed border-foreground/60" />forecast</span>
      <span className="flex items-center gap-1.5"><span className="h-2 w-6 rounded-sm" style={{ backgroundImage: "repeating-linear-gradient(135deg, var(--color-destructive) 0 2px, transparent 2px 5px)" }} />past the plan</span>
    </div>
  );
}
