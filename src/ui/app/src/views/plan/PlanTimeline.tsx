/**
 * The Timeline lens: ideas as rows grouped by horizon, on a month axis.
 *
 * Each row shows the PLANNED window, which the person edits by dragging the bar (move) or its
 * ends (resize) with a mouse or a pen, or with the arrow keys, and, once work is linked, the
 * ACTUAL window derived from it, with a label after the bar saying where it ends. Links between
 * ideas show on demand: for the row hovered, focused or selected, or all of them with "Show all
 * links"; a row that starts before something it waits on ends carries a red notch at all times.
 *
 * The layout follows the Plan container's width. From 760px a name column is pinned on the left
 * and the range sits in the axis corner; under it each row is a label line pinned over its own
 * lane, so the chart takes the full width, and a finger pans it. The chart scrolls inside its
 * own frame (`data-plan-timeline-frame`), the one scroller plan memory restores.
 */
import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import type { HorizonData, IdeaData } from "@/lib/plan-types";
import { useIsDesk } from "@/lib/use-media";
import { cn } from "@/lib/utils";
import { offers } from "@/detail/plain-actions";
import { STATE_WORDS } from "@/detail/plan-record";
import { ShippedMark } from "@/detail/ShippedMark";
import type { BoardProps } from "./plan-board";
import { countWord } from "./plan-counts";
import { dayIndex, dayLabel, dayOf, dependencyEdges, dragWindow, horizonDone, monthsIn, timelineRange, type TimelineGroup } from "./plan-model";
import { Flag, PLAN_WIDTH, SegmentedBar, StateGlyph, useElementWidth } from "./plan-parts";
import { treeHeader } from "./plan-tree";
import { BAR_MIDDLE, EndWords, RangeControl, RowBars, TimelineKey, type BarHandlers, type Layout } from "./TimelineBars";
import { datesBody, elbowPath, endLabel, linkView, monthLabel, notched, nudge, pxPerDay, spanOf, startsDrag, startsEarly, timelineRows, todayScroll, windowOf, type Range } from "./timeline-model";

const AXIS = 34;
/** A wide row; a stacked row is a 24px label line over a 26px lane. */
const ROW = { wide: 34, stacked: 50 } as const;
const LABEL_LINE = 24;

interface Drag {
  id: string;
  mode: "move" | "start" | "end";
  x0: number;
  window: { start: number; end: number };
  moved: boolean;
}

/** The lens, sized by its own container: measured, or before that the shell's guess. */
export function PlanTimeline(props: BoardProps) {
  const desk = useIsDesk();
  const { ref, width } = useElementWidth<HTMLDivElement>();
  return (
    <div ref={ref} className="flex h-full min-h-0 flex-col" data-plan-timeline>
      <Timeline {...props} width={width ?? (desk ? 1280 : 375)} />
    </div>
  );
}

/** The lens at a container width: the wide layout from 760px, the stacked one under it. */
export function Timeline({ plan, write, onOpen, selected, filtering = false, width }: BoardProps & { width: number }) {
  const layout: Layout = width < PLAN_WIDTH.compact ? "stacked" : "wide";
  const stacked = layout === "stacked";
  const nameWidth = stacked ? 0 : width < PLAN_WIDTH.medium ? 220 : 300;
  const { ref: frame, width: frameWidth } = useElementWidth<HTMLDivElement>();
  // The frame's own width less its scrollbar, once laid out.
  const visible = frameWidth ?? width;
  const view = Math.max(1, visible - nameWidth);

  const [chosen, setRange] = useState<Range | null>(null);
  const range = chosen ?? (stacked ? "3m" : "all");
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [hovered, setHovered] = useState<string | null>(null);
  const [focused, setFocused] = useState<string | null>(null);
  const [keyOpen, setKeyOpen] = useState(false);
  const [preview, setPreview] = useState<{ id: string; start: number; end: number } | null>(null);
  const drag = useRef<Drag | null>(null);
  // A drag ends in a click on the bar; that click must not also open the idea.
  const dragged = useRef(false);

  const span = useMemo(() => timelineRange(plan), [plan]);
  const days = span.to - span.from;
  const px = pxPerDay(range, view, days);
  const chartWidth = Math.ceil(days * px);
  const x = (day: number) => (day - span.from) * px;
  const today = dayIndex(plan.today);
  const groups = useMemo(() => timelineRows(plan, folded, filtering), [plan, folded, filtering]);
  const months = useMemo(() => monthsIn(span), [span]);
  const shown = useMemo(() => new Set(groups.flatMap((group) => group.rows.map((row) => row.idea.id))), [groups]);
  const edges = useMemo(() => dependencyEdges(plan, shown), [plan, shown]);
  const ideaById = useMemo(() => new Map(plan.ideas.map((idea) => [idea.id, idea])), [plan]);
  const notches = useMemo(() => notched(edges, ideaById), [edges, ideaById]);
  // On a phone the selected idea is the only focus; the desk adds the row hovered and the bar focused.
  const focus = stacked ? selected : (hovered ?? focused ?? selected);
  const links = linkView(edges, focus, showAll && !stacked);

  // Where each row sits, measured once laid out: an undated line's height follows its chips.
  const canvas = useRef<HTMLDivElement>(null);
  const [rowTops, setRowTops] = useState<Map<string, number>>(new Map());
  useLayoutEffect(() => {
    const element = canvas.current;
    if (!element) return;
    const next = new Map<string, number>();
    for (const row of element.querySelectorAll<HTMLElement>("[data-plan-timeline-row]")) next.set(row.dataset.planTimelineRow!, row.offsetTop);
    setRowTops((current) => (current.size === next.size && [...next].every(([id, top]) => current.get(id) === top) ? current : next));
  }, [groups, layout, visible]);

  // Bring today a third of the way in once per range, after the frame is measured and before
  // plan memory restores a saved position. All starts at the beginning.
  const centred = useRef<Range | null>(null);
  useEffect(() => {
    const element = frame.current;
    if (!element || frameWidth === null || centred.current === range) return;
    centred.current = range;
    element.scrollLeft = range === "all" ? 0 : todayScroll(x(today), view);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range, frameWidth]);
  const toToday = () => {
    if (frame.current) frame.current.scrollLeft = todayScroll(x(today), view);
  };

  const handlersFor = (idea: IdeaData): BarHandlers => ({
    onPointerDown: (event, mode) => {
      dragged.current = false;
      // A finger pans the chart; a mouse or a pen moves the dates where the idea offers them.
      if (!startsDrag(idea, event.pointerType)) return;
      const planned = windowOf(idea);
      if (!planned) return;
      event.preventDefault();
      event.stopPropagation();
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      drag.current = { id: idea.id, mode, x0: event.clientX, window: planned, moved: false };
    },
    onPointerMove: (event) => {
      const current = drag.current;
      if (!current) return;
      const delta = Math.round((event.clientX - current.x0) / px);
      if (delta !== 0) current.moved = true;
      setPreview({ id: current.id, ...dragWindow(current.window, current.mode, delta) });
    },
    onPointerUp: (event) => {
      const current = drag.current;
      drag.current = null;
      if (!current) return;
      dragged.current = current.moved;
      const next = dragWindow(current.window, current.mode, Math.round((event.clientX - current.x0) / px));
      if (!current.moved || (next.start === current.window.start && next.end === current.window.end)) {
        setPreview(null);
        return;
      }
      void write("update", { ref: current.id, ...datesBody(idea, next) }).finally(() => setPreview(null));
    },
    onPointerCancel: () => {
      drag.current = null;
      setPreview(null);
    },
    onClick: () => {
      if (dragged.current) {
        dragged.current = false;
        return;
      }
      onOpen(idea.id);
    },
    onKeyDown: (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        onOpen(idea.id);
        return;
      }
      const body = nudge(idea, event.key, event.shiftKey);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") event.preventDefault();
      if (body) void write("update", { ref: idea.id, ...body });
    },
    onFocus: () => setFocused(idea.id),
    onBlur: () => setFocused((current) => (current === idea.id ? null : current)),
  });

  const toggleFold = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setFolded(next);
  };

  const addDates = (idea: IdeaData) => void write("update", { ref: idea.id, plannedStart: plan.today, plannedTarget: dayOf(today + 28) });
  const canvasWidth = nameWidth + chartWidth;

  return (
    <>
      <div ref={frame} className="relative min-h-0 flex-1 overflow-auto overscroll-x-contain" data-plan-timeline-frame data-plan-timeline-stacked={stacked ? "" : undefined}>
        <div ref={canvas} className="relative" style={{ width: canvasWidth }}>
          <div className="sticky top-0 z-[6] flex border-b bg-card" style={{ height: AXIS }}>
            {stacked ? null : (
              <div className="sticky left-0 z-[7] flex shrink-0 items-center border-r bg-card px-2.5" style={{ width: nameWidth }}>
                <RangeControl range={range} onRange={setRange} />
              </div>
            )}
            <div className="relative shrink-0 overflow-hidden" style={{ width: chartWidth }}>
              {months.map((month, index) => {
                const next = months[index + 1]?.day ?? span.to;
                const label = monthLabel(month.day, (next - month.day) * px, index === 0);
                return (
                  <div key={month.day} className="absolute inset-y-0 whitespace-nowrap border-l pl-1.5 text-caption leading-[34px] text-text-tertiary" style={{ left: x(month.day) }}>
                    {label.year ? <b className="font-semibold text-foreground">{label.text}</b> : label.text}
                  </div>
                );
              })}
              {plan.horizons
                .filter((horizon) => horizon.date)
                .map((horizon) => (
                  <span key={horizon.id} className="absolute top-[9px] z-[5] -translate-x-1/2 whitespace-nowrap rounded-[3px] bg-foreground px-1.5 text-[10px] font-semibold leading-4 text-background" style={{ left: x(dayIndex(horizon.date!) + 1) }} data-plan-horizon-tag={horizon.identifier}>
                    <span aria-hidden>◆ </span>
                    {horizon.name} · {dayLabel(horizon.date, false)}
                  </span>
                ))}
              <span className="absolute top-[9px] z-[6] -translate-x-1/2 whitespace-nowrap rounded-[3px] bg-destructive px-1.5 text-[10px] font-semibold leading-4 text-white" style={{ left: x(today) + px / 2 }}>
                Today
              </span>
            </div>
          </div>
          {/* Month lines, today and every dated horizon, through the whole chart and under the rows. */}
          <div className="pointer-events-none absolute inset-y-0 z-[1]" style={{ left: nameWidth, width: chartWidth }} aria-hidden>
            {months.map((month) => (
              <div key={month.day} className="absolute bottom-0 border-l border-border/55" style={{ left: x(month.day), top: AXIS }} />
            ))}
            {plan.horizons
              .filter((horizon) => horizon.date)
              .map((horizon) => (
                <div key={horizon.id} className="absolute bottom-0 border-l-[1.5px] border-dashed border-foreground opacity-55" style={{ left: x(dayIndex(horizon.date!) + 1), top: AXIS }} data-plan-horizon-line={horizon.identifier} />
              ))}
            <div className="absolute inset-y-0 z-[4] border-l-[1.5px] border-destructive" style={{ left: x(today) + px / 2 }} data-plan-today />
          </div>
          {groups.map((group) => (
            <div key={group.key} data-plan-timeline-group={group.key || "none"}>
              <GroupRow group={group} width={canvasWidth} visible={visible} />
              {group.rows.map((row) => {
                const idea = row.idea;
                const planned = preview?.id === idea.id ? { start: preview.start, end: preview.end } : windowOf(idea);
                const dim = links.related !== null && !links.related.has(idea.id);
                const waitsOn = idea.dependsOn.map((id) => ideaById.get(id)?.title).filter((title): title is string => title !== undefined);
                const name = (
                  <NameLine
                    idea={idea}
                    fold={row.folds && !filtering ? { open: !folded.has(idea.id), toggle: () => toggleFold(idea.id) } : null}
                    onOpen={() => onOpen(idea.id)}
                    end={stacked ? <EndWords label={endLabel(idea, today)} className="ml-auto" /> : null}
                  />
                );
                const bars = (
                  <RowBars idea={idea} planned={planned} layout={layout} x={x} px={px} today={today} notch={notches.has(idea.id)} movable={offers(idea, "plan_dates")} waitsOn={waitsOn} handlers={handlersFor(idea)} />
                );
                const chosenRow = selected === idea.id;
                return (
                  <div
                    key={idea.id}
                    className={cn("group/row relative z-[2] border-b border-border/55", stacked ? "block" : "flex", chosenRow ? "bg-surface-selected" : "hover:bg-surface-hover")}
                    style={{ width: canvasWidth, height: ROW[layout] }}
                    data-plan-timeline-row={idea.id}
                    data-plan-dim={dim ? "" : undefined}
                    data-plan-selected={chosenRow ? "" : undefined}
                    onPointerEnter={(event) => event.pointerType === "mouse" && setHovered(idea.id)}
                    onPointerLeave={() => setHovered((current) => (current === idea.id ? null : current))}
                  >
                    <div
                      className={cn(
                        "sticky left-0 z-[3] flex items-center bg-card",
                        // Opaque over the bars that scroll under it, with the row's own hover or selection on top.
                        chosenRow ? "bg-[image:linear-gradient(var(--surface-selected),var(--surface-selected))]" : "group-hover/row:bg-[image:linear-gradient(var(--surface-hover),var(--surface-hover))]",
                        stacked ? "gap-2 pt-1 pr-3" : "shrink-0 gap-2 border-r pr-3",
                        dim && "[&>*]:opacity-28",
                      )}
                      style={stacked ? { width: visible, height: LABEL_LINE, paddingLeft: 12 + row.depth * 12 } : { width: nameWidth, paddingLeft: 16 + row.depth * 16 }}
                      data-plan-timeline-label={idea.id}
                    >
                      {name}
                    </div>
                    <div className={cn("relative shrink-0", stacked ? "-mt-0.5" : "h-full", dim && "[&>*]:opacity-28")} style={{ width: chartWidth, height: stacked ? ROW.stacked - LABEL_LINE : undefined }}>
                      {bars}
                    </div>
                  </div>
                );
              })}
              {group.undated.length > 0 ? (
                <div className="relative z-[2] border-b" style={{ width: canvasWidth }} data-plan-undated={group.key || "none"}>
                  <div className={cn("sticky left-0 flex flex-wrap items-center gap-1.5 py-[7px] text-label text-text-tertiary", stacked ? "px-3" : "px-4")} style={{ width: visible }}>
                    <span>{countWord(group.undated.length, "idea")} without dates:</span>
                    {group.undated.map((idea) =>
                      offers(idea, "plan_dates") ? (
                        <button key={idea.id} type="button" className={UNDATED} onClick={() => addDates(idea)} title={`${idea.title}: add dates`} data-plan-add-dates={idea.id}>
                          <span className="truncate">{idea.title}</span>
                          <span className="shrink-0 text-text-tertiary">· add dates</span>
                        </button>
                      ) : (
                        <button key={idea.id} type="button" className={UNDATED} onClick={() => onOpen(idea.id)} title={idea.title} data-plan-undated-idea={idea.id}>
                          <span className="truncate">{idea.title}</span>
                        </button>
                      ),
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
          <DependencyArrows edges={links.drawn} ideas={ideaById} rowTops={rowTops} barY={(stacked ? LABEL_LINE - 2 : 0) + BAR_MIDDLE(layout)} x={x} left={nameWidth} width={chartWidth} />
        </div>
      </div>
      {stacked ? (
        <>
          {keyOpen ? <TimelineKey className="gap-x-2.5 border-t px-3 py-[7px]" /> : null}
          <div className="flex flex-none items-center gap-2 border-t px-3 py-1.5" data-plan-timeline-controls>
            <RangeControl range={range} onRange={setRange} large />
            <Button variant="ghost" className="h-[34px] px-3 text-body" onClick={toToday} data-plan-to-today>
              Today
            </Button>
            <Button variant="ghost" className="ml-auto h-[34px] px-3 text-body" aria-pressed={keyOpen} aria-expanded={keyOpen} onClick={() => setKeyOpen(!keyOpen)} data-plan-key-toggle>
              Key
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-none items-center gap-2 border-t px-4 py-1.5" data-plan-timeline-controls>
          <TimelineKey className="min-w-0 flex-1" />
          <Button variant="ghost" size="sm" onClick={toToday} data-plan-to-today>
            Today
          </Button>
          <Button variant={showAll ? "secondary" : "ghost"} size="sm" aria-pressed={showAll} onClick={() => setShowAll(!showAll)} title="Otherwise links show for the row you hover or select" data-plan-show-links>
            Show all links
          </Button>
        </div>
      )}
    </>
  );
}

const UNDATED = "focus-ring inline-flex h-6 max-w-[260px] items-center gap-1 rounded-md border border-dashed border-border-strong bg-card px-2 text-text-secondary hover:bg-surface-hover";

/** A row's name: its fold, state, title and one flag, and on a stacked row the end label at the right. */
function NameLine({ idea, fold, onOpen, end }: { idea: IdeaData; fold: { open: boolean; toggle: () => void } | null; onOpen: () => void; end: ReactNode }) {
  const flag = idea.late && idea.state !== "shipped" ? <Flag tone="late" /> : idea.notStarted ? <Flag tone="notStarted" /> : null;
  return (
    <>
      {fold ? (
        <button
          type="button"
          className="focus-ring -ml-1 flex size-5 shrink-0 items-center justify-center rounded text-text-tertiary hover:bg-surface-hover"
          aria-label={fold.open ? `Hide ${idea.title}'s sub-ideas` : `Show ${idea.title}'s sub-ideas`}
          aria-expanded={fold.open}
          onClick={fold.toggle}
        >
          {fold.open ? <ChevronDown className="size-3.5" aria-hidden /> : <ChevronRight className="size-3.5" aria-hidden />}
        </button>
      ) : null}
      <StateGlyph state={idea.state} percent={idea.percent} />
      <button type="button" className="focus-ring relative min-w-0 flex-1 truncate rounded-sm text-left text-body hover:underline" onClick={onOpen} title={idea.title} data-plan-timeline-name={idea.id}>
        {idea.title}
        <span className="sr-only">, {(STATE_WORDS[idea.state] ?? idea.state).toLowerCase()}</span>
      </button>
      {flag}
      {end}
    </>
  );
}

/** A horizon's group row: its name, date, bar, the server's percent and its flags; "No horizon" for the rest. */
function GroupRow({ group, width, visible }: { group: TimelineGroup; width: number; visible: number }) {
  const horizon = group.horizon;
  return (
    <div className="relative z-[2] flex border-b bg-surface-sunken" style={{ width, height: ROW.wide }}>
      <div className="sticky left-0 z-[3] flex items-center gap-2.5 overflow-hidden whitespace-nowrap bg-surface-sunken px-4 text-label" style={{ maxWidth: visible }}>
        <span className="text-body font-semibold text-foreground">{group.title}</span>
        {group.date ? <span className="text-text-tertiary">{dayLabel(group.date)}</span> : null}
        {horizon ? <GroupFlags horizon={horizon} /> : null}
      </div>
    </div>
  );
}

function GroupFlags({ horizon }: { horizon: HorizonData }) {
  const done = horizonDone(horizon);
  const needsYou = treeHeader(horizon).needsYou;
  return (
    <>
      {horizon.percent !== null ? (
        <SegmentedBar units={horizon.units} percent={horizon.percent} complete={horizon.complete} className="mt-0 shrink-0 [&>div:first-child]:w-[90px] [&>div:first-child]:flex-none [&>span]:text-label [&>span]:font-medium [&>span]:text-foreground" />
      ) : null}
      {horizon.awaitingApproval ? <Flag tone="you" data-plan-horizon-awaiting={horizon.identifier}>Waiting for your approval</Flag> : null}
      {needsYou ? <Flag tone="you">{needsYou}</Flag> : null}
      {!done && horizon.lateCount > 0 ? <Flag tone="late">{horizon.lateCount} late</Flag> : null}
      {!done && horizon.notStartedCount > 0 ? <Flag tone="notStarted">{horizon.notStartedCount} not started</Flag> : null}
      {done ? <ShippedMark className="text-caption" /> : horizon.shippedCount > 0 ? <ShippedMark count={horizon.shippedCount} className="text-caption" /> : null}
    </>
  );
}

/**
 * The links drawn, each an elbow from the end of the record waited on to the start of the one
 * waiting, red when it starts first; over the lanes and under the pinned names. A row not laid
 * out yet (folded away, or before the first layout) draws none.
 */
export function DependencyArrows({
  edges,
  ideas,
  rowTops,
  barY,
  x,
  left,
  width,
}: {
  edges: ReadonlyArray<{ from: string; to: string }>;
  ideas: ReadonlyMap<string, IdeaData>;
  rowTops: ReadonlyMap<string, number>;
  /** From a row's top to the middle of its planned bar. */
  barY: number;
  x: (day: number) => number;
  left: number;
  width: number;
}) {
  const paths = edges.flatMap((edge) => {
    const from = ideas.get(edge.from);
    const to = ideas.get(edge.to);
    const fromTop = rowTops.get(edge.from);
    const toTop = rowTops.get(edge.to);
    if (!from || !to || fromTop === undefined || toTop === undefined) return [];
    const a = spanOf(from);
    const b = spanOf(to);
    if (!a || !b) return [];
    return [{ key: `${edge.from}>${edge.to}`, d: elbowPath(x(a.end + 1), fromTop + barY, x(b.start) - 3, toTop + barY), late: startsEarly(from, to) }];
  });
  if (paths.length === 0) return null;
  return (
    <svg className="pointer-events-none absolute top-0 z-[2] h-full overflow-visible" style={{ left, width }} aria-hidden data-plan-arrows={paths.length}>
      <defs>
        <marker id="plan-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" className="fill-text-secondary" />
        </marker>
        <marker id="plan-arrow-late" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="6" markerHeight="6" orient="auto">
          <path d="M0,0 L8,4 L0,8 z" className="fill-destructive" />
        </marker>
      </defs>
      {paths.map((path) => (
        <path
          key={path.key}
          d={path.d}
          fill="none"
          strokeWidth={1.4}
          className={path.late ? "stroke-destructive" : "stroke-text-secondary"}
          markerEnd={path.late ? "url(#plan-arrow-late)" : "url(#plan-arrow)"}
          data-plan-arrow={path.key}
        />
      ))}
    </svg>
  );
}
