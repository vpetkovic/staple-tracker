/**
 * The Timeline lens's arithmetic, apart from React so it is pinned without rendering: how many
 * pixels a day takes in each range, what each bar's end label says, which links show for the row
 * in focus, which rows start before something they wait on ends, the elbow an arrow draws, and
 * which writes a pointer or a key may start. Every day it reads is the payload's; the only numbers
 * it makes are differences between two of those days.
 */
import type { IdeaData, PlanData } from "../../lib/plan-types.js";
import { offers } from "@/detail/plain-actions";
import { dayIndex, dayLabel, dayOf, dragWindow, timelineGroups, type DependencyEdge, type TimelineGroup } from "./plan-model";

export type Range = "3m" | "6m" | "1y" | "all";

/** The range presets, in the order the control shows them; `days` is what one visible chart width holds, null fits it all. */
export const RANGES: ReadonlyArray<{ id: Range; label: string; days: number | null }> = [
  { id: "3m", label: "3 mo", days: 92 },
  { id: "6m", label: "6 mo", days: 183 },
  { id: "1y", label: "Year", days: 365 },
  { id: "all", label: "All", days: null },
];

/** Room left at the right of a fitted chart, so rounding never adds a sideways scroll. */
const FIT_MARGIN = 8;

/** Pixels per day: the visible chart width over the range's days, or the whole span fitted to it. Never under one. */
export function pxPerDay(range: Range, view: number, span: number): number {
  const days = RANGES.find((preset) => preset.id === range)?.days ?? null;
  return Math.max(1, days === null ? (view - FIT_MARGIN) / span : view / days);
}

/** Where the frame scrolls to put today a third of the way in from the left. */
export function todayScroll(todayX: number, view: number): number {
  return Math.max(0, todayX - view / 3);
}

/** A planned window as days; a window with one end set is that one day. */
export function windowOf(idea: IdeaData): { start: number; end: number } | null {
  const start = idea.planned.start ?? idea.planned.target;
  const end = idea.planned.target ?? idea.planned.start;
  return start && end ? { start: dayIndex(start), end: dayIndex(end) } : null;
}

/** Only a target, no start: drawn as a diamond on that day. */
export function targetOnly(idea: IdeaData): boolean {
  return idea.planned.target !== null && idea.planned.start === null;
}

/** The days a record's bar starts and ends on: planned where it has a plan, else its actual work. */
export function spanOf(idea: IdeaData): { start: number; end: number } | null {
  const planned = windowOf(idea);
  if (planned) return planned;
  // Work that landed with no recorded start (delivered outside the tracker) is the day it landed.
  const first = idea.actual.start ?? idea.actual.end;
  if (!first) return null;
  const end = idea.actual.end ?? idea.actual.forecastEnd ?? first;
  return { start: dayIndex(first), end: dayIndex(end) };
}

/** The one waiting starts on or before the day the one it waits on ends. */
export function startsEarly(waitedOn: IdeaData, waiting: IdeaData): boolean {
  const a = spanOf(waitedOn);
  const b = spanOf(waiting);
  return a !== null && b !== null && b.start <= a.end;
}

/** The rows that start before something they wait on ends: each gets the red notch. */
export function notched(edges: readonly DependencyEdge[], ideas: ReadonlyMap<string, IdeaData>): Set<string> {
  const out = new Set<string>();
  for (const edge of edges) {
    const from = ideas.get(edge.from);
    const to = ideas.get(edge.to);
    if (from && to && startsEarly(from, to)) out.add(edge.to);
  }
  return out;
}

/**
 * Which links show: all of them with the toggle on (and nothing dimmed), else those touching the
 * row in focus (hovered, its bar focused, or selected), with every row they do not touch dimmed.
 * A focused row with no links dims nothing.
 */
export function linkView(edges: readonly DependencyEdge[], focus: string | null, all: boolean): { drawn: DependencyEdge[]; related: ReadonlySet<string> | null } {
  if (all) return { drawn: [...edges], related: null };
  if (focus === null) return { drawn: [], related: null };
  const drawn = edges.filter((edge) => edge.from === focus || edge.to === focus);
  return { drawn, related: drawn.length > 0 ? new Set([focus, ...drawn.flatMap((edge) => [edge.from, edge.to])]) : null };
}

/** The rows the lens draws: with a focus or filter on, nothing is folded away. */
export function timelineRows(plan: PlanData, folded: ReadonlySet<string>, filtering: boolean): TimelineGroup[] {
  return timelineGroups(plan, filtering ? new Set() : folded);
}

const CORNER = 5;

/**
 * A right-angle arrow from the end of one bar to the start of another, its corners rounded. When
 * the second starts after the first ends it turns down just past the first; when it starts
 * before, it steps out, doubles back between the rows and comes in from the left.
 */
export function elbowPath(x1: number, y1: number, x2: number, y2: number): string {
  const dir = y2 >= y1 ? 1 : -1;
  const r = CORNER;
  const out = x1 + 8;
  if (x2 > x1 + 14) {
    return `M${x1} ${y1} H${out - r} Q${out} ${y1} ${out} ${y1 + dir * r} V${y2 - dir * r} Q${out} ${y2} ${out + r} ${y2} H${x2}`;
  }
  const back = x2 - 10;
  const mid = y1 + dir * 13;
  return [
    `M${x1} ${y1} H${out - r} Q${out} ${y1} ${out} ${y1 + dir * r}`,
    `V${mid - dir * r} Q${out} ${mid} ${out - r} ${mid}`,
    `H${back + r} Q${back} ${mid} ${back} ${mid + dir * r}`,
    `V${y2 - dir * r} Q${back} ${y2} ${back + r} ${y2} H${x2}`,
  ].join(" ");
}

export interface EndLabel {
  text: string;
  /** Over or past the plan: drawn in the destructive colour. */
  late: boolean;
}

const short = (day: number) => dayLabel(dayOf(day), false);

/**
 * The words after a bar: when it shipped, when it is forecast and by how much that overruns the
 * plan, how long ago the planned end passed, or where the plan ends. Day counts are differences
 * of the payload's days.
 */
export function endLabel(idea: IdeaData, today: number): EndLabel | null {
  if (idea.state === "shipped") return idea.actual.end ? { text: `shipped ${dayLabel(idea.actual.end, false)}`, late: false } : null;
  const end = idea.planned.target ? dayIndex(idea.planned.target) : null;
  const forecast = idea.actual.forecastEnd ? dayIndex(idea.actual.forecastEnd) : null;
  if (forecast !== null && end !== null && forecast > end) return { text: `forecast ${short(forecast)} · ${forecast - end}d over`, late: true };
  if (end !== null && today > end) return { text: `${today - end}d past ${short(end)}`, late: true };
  if (forecast !== null) return { text: `forecast ${short(forecast)}`, late: false };
  if (end !== null) return { text: `to ${short(end)}`, late: false };
  if (idea.planned.start) return { text: `from ${dayLabel(idea.planned.start, false)}`, late: false };
  return null;
}

/** What a move of the planned window writes; a target-only window keeps having no start. */
export function datesBody(idea: IdeaData, next: { start: number; end: number }): Record<string, string> {
  return targetOnly(idea) ? { plannedTarget: dayOf(next.end) } : { plannedStart: dayOf(next.start), plannedTarget: dayOf(next.end) };
}

/** A pointer starts a drag only from a mouse or a pen, and only where the idea offers its dates. A finger pans. */
export function startsDrag(idea: IdeaData, pointerType: string): boolean {
  return pointerType !== "touch" && offers(idea, "plan_dates");
}

/** The arrow keys move the planned window a week (Shift moves its end), under the same offer as the drag. */
export function nudge(idea: IdeaData, key: string, shift: boolean): Record<string, string> | null {
  const step = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  const planned = windowOf(idea);
  if (step === 0 || planned === null || !offers(idea, "plan_dates")) return null;
  return datesBody(idea, dragWindow(planned, shift && !targetOnly(idea) ? "end" : "move", step * 7));
}

/**
 * A month on the axis: its short name when the month is wider than 44px, a letter down to 16px,
 * nothing below. January and the first month print the year in bold instead.
 */
export function monthLabel(day: number, monthWidth: number, first: boolean): { text: string; year: boolean } {
  const date = new Date(`${dayOf(day)}T00:00:00.000Z`);
  const january = date.getUTCMonth() === 0;
  const year = String(date.getUTCFullYear());
  const name = (style: "short" | "narrow") => date.toLocaleDateString("en-US", { month: style, timeZone: "UTC" });
  if (monthWidth > 44) return january || first ? { text: `${name("short")} ${year}`, year: true } : { text: name("short"), year: false };
  if (monthWidth > 16) return january || first ? { text: year, year: true } : { text: name("narrow"), year: false };
  return january ? { text: year, year: true } : { text: "", year: false };
}
