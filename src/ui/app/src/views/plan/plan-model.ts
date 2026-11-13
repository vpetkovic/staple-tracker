/**
 * The Plan view's boards and timeline as data: which ideas sit in which column of each lens,
 * how child ideas nest under their parent, what a drop writes, and where a bar sits on the
 * timeline. Pure, so `plan-model.test.ts` pins it without rendering.
 */
import type { HorizonData, IdeaData, Maturity, PlanData } from "../../lib/plan-types.js";

export type Lens = "ideas" | "horizons" | "timeline";

export const LENSES: ReadonlyArray<{ id: Lens; label: string }> = [
  { id: "ideas", label: "Ideas" },
  { id: "horizons", label: "Horizons" },
  { id: "timeline", label: "Timeline" },
];

/** What dropping an idea on a column changes. */
export type DropTarget = { maturity: Maturity } | { horizon: string | null };

export interface BoardColumn {
  /** Stable key: `m:raw`, `h:<horizon id>`, `h:` for Unscheduled. */
  key: string;
  title: string;
  hint: string;
  ideas: IdeaData[];
  drop: DropTarget;
  horizon?: HorizonData;
}

/** The Ideas lens's columns: thinking. Shaping is the hand-off to Horizons, so shaped has no column here. */
export const MATURITY_COLUMNS: ReadonlyArray<{ id: Exclude<Maturity, "dropped" | "shaped">; title: string; hint: string }> = [
  { id: "raw", title: "Raw", hint: "just captured" },
  { id: "exploring", title: "Exploring", hint: "questions open" },
];

/** Work started from an idea lives in the tracker; the Ideas lens shows what is still being shaped. */
export function isStarted(idea: IdeaData): boolean {
  return idea.stage === "started" || idea.stage === "shipped";
}

function byId(plan: PlanData): Map<string, IdeaData> {
  return new Map(plan.ideas.map((idea) => [idea.id, idea]));
}

/** The idea's ancestors, nearest first. */
export function ancestorsOf(plan: PlanData, idea: IdeaData): IdeaData[] {
  const index = byId(plan);
  const out: IdeaData[] = [];
  let cursor = idea.parentId === null ? undefined : index.get(idea.parentId);
  while (cursor && !out.includes(cursor)) {
    out.push(cursor);
    cursor = cursor.parentId === null ? undefined : index.get(cursor.parentId);
  }
  return out;
}

/** Every idea under this one, in plan order. */
export function descendantsOf(plan: PlanData, idea: IdeaData): IdeaData[] {
  const out: IdeaData[] = [];
  const walk = (id: string) => {
    for (const child of plan.ideas.filter((candidate) => candidate.parentId === id)) {
      if (out.includes(child)) continue;
      out.push(child);
      walk(child.id);
    }
  };
  walk(idea.id);
  return out;
}

/** The states that are still thinking. Shaping is the hand-off: a shaped record is delivery's. */
const THINKING = new Set(["raw", "exploring"]);

/** The states delivery tracks: shaped and ready, underway, landed. */
const DELIVERY = new Set(["shaped", "started", "shipped"]);

/**
 * The Ideas lens is thinking only: a record in its own raw or exploring state. Shaped, it is
 * ready and moves to Horizons, whatever its parent is doing; under a started parent, a sub-idea
 * still being explored is still thinking. No record is ever in both lenses.
 */
export function inIdeasLens(_plan: PlanData, idea: IdeaData): boolean {
  return THINKING.has(idea.state);
}

/** The Horizons lens is delivery: shaped, started and shipped records, nothing still being thought. */
export function inHorizonsLens(idea: IdeaData): boolean {
  return DELIVERY.has(idea.state);
}

/** Its work has all landed: the one test every shipped mark reads. */
export function isShipped(idea: IdeaData): boolean {
  return idea.state === "shipped";
}

export function ideasColumns(plan: PlanData): BoardColumn[] {
  return MATURITY_COLUMNS.map((column) => ({
    key: `m:${column.id}`,
    title: column.title,
    hint: column.hint,
    ideas: plan.ideas.filter((idea) => idea.maturity === column.id && inIdeasLens(plan, idea)),
    drop: { maturity: column.id },
  }));
}

export function droppedIdeas(plan: PlanData): IdeaData[] {
  return plan.ideas.filter((idea) => idea.state === "dropped");
}

export function horizonsColumns(plan: PlanData): BoardColumn[] {
  const unscheduled: BoardColumn = {
    key: "h:",
    title: "Unscheduled",
    hint: "Ready, no horizon yet",
    ideas: plan.ideas.filter((idea) => idea.horizonId === null && inHorizonsLens(idea)),
    drop: { horizon: null },
  };
  return [
    unscheduled,
    ...plan.horizons.map((horizon) => ({
      key: `h:${horizon.id}`,
      title: horizon.name,
      hint: horizon.date ? "" : "no date",
      ideas: plan.ideas.filter((idea) => idea.horizonId === horizon.id && inHorizonsLens(idea)),
      drop: { horizon: horizon.id },
      horizon,
    })),
  ];
}

/**
 * A horizon the server reads as shipped: its milestone is done. Never read from the cards, nor
 * from its progress: a member reopened or held for review, a record still being explored, or an
 * idea whose work sits on another horizon can leave every counted unit landed while it is open.
 * Its column folds to a ✓ summary.
 */
export function horizonDone(horizon: Pick<HorizonData, "shipped" | "awaitingApproval">): boolean {
  return !horizon.awaitingApproval && horizon.shipped;
}

/** The late and not-started split of a set of ideas: never one lumped number. */
export interface RiskCounts {
  late: number;
  notStarted: number;
  started: number;
}

export function riskOf(ideas: readonly IdeaData[]): RiskCounts {
  return {
    late: ideas.filter((idea) => idea.late).length,
    notStarted: ideas.filter((idea) => idea.notStarted).length,
    started: ideas.filter(isStarted).length,
  };
}

/** `2 late · 4 not started`, or null when neither applies. */
export function riskWords(risk: RiskCounts, withStarted = false): string | null {
  const parts = [
    risk.late > 0 ? `${risk.late} late` : null,
    risk.notStarted > 0 ? `${risk.notStarted} not started` : null,
    withStarted && risk.started > 0 ? `${risk.started} started` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * One card on a board. A child idea sits under its parent's card when both are in the same
 * column; one in another column is its own card there, labelled with its parent.
 */
export interface BoardEntry {
  idea: IdeaData;
  /** Descendants in this same column, nested under this card. */
  nested: IdeaData[];
  /** Every descendant, wherever it sits: what the card's count and rollup read. */
  descendants: IdeaData[];
  /** The parent's title when the parent is not in this column. */
  parentTitle: string | null;
}

export function columnEntries(plan: PlanData, column: BoardColumn): BoardEntry[] {
  const here = new Set(column.ideas.map((idea) => idea.id));
  const index = byId(plan);
  const top = column.ideas.filter((idea) => !ancestorsOf(plan, idea).some((ancestor) => here.has(ancestor.id)));
  return top.map((idea) => {
    const descendants = descendantsOf(plan, idea);
    return {
      idea,
      nested: descendants.filter((child) => here.has(child.id)),
      descendants,
      parentTitle: idea.parentId === null ? null : (index.get(idea.parentId)?.title ?? null),
    };
  });
}

/** Is the drop a change at all? A drop on the column the idea already sits in writes nothing. */
export function dropChanges(idea: IdeaData, target: DropTarget): boolean {
  return "maturity" in target ? idea.maturity !== target.maturity : idea.horizonId !== target.horizon;
}

export function dropBody(target: DropTarget): Record<string, unknown> {
  return "maturity" in target ? { maturity: target.maturity } : { horizon: target.horizon };
}

/** `Dec 31, 2026`: a calendar day, read in UTC as the store writes it. */
export function dayLabel(day: string | null, withYear = true): string {
  if (!day) return "";
  const date = new Date(`${day}T00:00:00.000Z`);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric", ...(withYear ? { year: "numeric" } : {}), timeZone: "UTC" });
}

export function horizonOf(plan: PlanData, idea: IdeaData): HorizonData | null {
  return idea.horizonId === null ? null : (plan.horizons.find((horizon) => horizon.id === idea.horizonId) ?? null);
}

export function parentOf(plan: PlanData, idea: IdeaData): IdeaData | null {
  return idea.parentId === null ? null : (plan.ideas.find((other) => other.id === idea.parentId) ?? null);
}

// ---------------------------------------------------------------- the timeline

const MS_PER_DAY = 86_400_000;

export function dayIndex(day: string): number {
  return Math.round(Date.parse(`${day}T00:00:00.000Z`) / MS_PER_DAY);
}

export function dayOf(index: number): string {
  return new Date(index * MS_PER_DAY).toISOString().slice(0, 10);
}

export interface TimelineRow {
  idea: IdeaData;
  depth: number;
  /** Has children that this row can fold. */
  folds: boolean;
}

export interface TimelineGroup {
  key: string;
  title: string;
  date: string | null;
  horizon: HorizonData | null;
  rows: TimelineRow[];
  /** Ideas in the group with no planned window. */
  undated: IdeaData[];
}

function hasWindow(idea: IdeaData): boolean {
  return idea.planned.start !== null || idea.planned.target !== null || idea.actual.start !== null;
}

/**
 * Rows grouped by horizon in order, then the ideas with no horizon. Inside a group, child
 * ideas follow their parent indented (a child on another horizon sits in that horizon's group
 * at depth 0). Folded parents hide their rows. Dropped ideas are left out.
 */
export function timelineGroups(plan: PlanData, folded: ReadonlySet<string> = new Set()): TimelineGroup[] {
  const groups: Array<{ key: string; title: string; date: string | null; horizon: HorizonData | null; ideas: IdeaData[] }> = [
    ...plan.horizons.map((horizon) => ({
      key: horizon.id,
      title: horizon.name,
      date: horizon.date,
      horizon,
      ideas: plan.ideas.filter((idea) => idea.horizonId === horizon.id && idea.maturity !== "dropped"),
    })),
    { key: "", title: "No horizon", date: null, horizon: null, ideas: plan.ideas.filter((idea) => idea.horizonId === null && idea.maturity !== "dropped") },
  ];
  return groups
    .map((group) => {
      const here = new Set(group.ideas.map((idea) => idea.id));
      const rows: TimelineRow[] = [];
      const undated: IdeaData[] = [];
      const place = (idea: IdeaData, depth: number) => {
        const children = group.ideas.filter((child) => child.parentId === idea.id);
        if (hasWindow(idea) || children.some(hasWindow)) rows.push({ idea, depth, folds: children.length > 0 });
        else undated.push(idea);
        if (folded.has(idea.id)) return;
        for (const child of children) place(child, depth + 1);
      };
      for (const idea of group.ideas.filter((candidate) => candidate.parentId === null || !here.has(candidate.parentId))) place(idea, 0);
      return { key: group.key, title: group.title, date: group.date, horizon: group.horizon, rows, undated };
    })
    .filter((group) => group.rows.length > 0 || group.undated.length > 0 || (group.horizon !== null && (group.horizon.memberCount > 0 || group.horizon.awaitingApproval || group.horizon.shipped)));
}

/** The days the timeline spans: every planned, baseline and actual day, today and every dated horizon, padded. */
export function timelineRange(plan: PlanData): { from: number; to: number } {
  const days: number[] = [dayIndex(plan.today)];
  for (const horizon of plan.horizons) if (horizon.date) days.push(dayIndex(horizon.date));
  for (const idea of plan.ideas) {
    if (idea.maturity === "dropped") continue;
    for (const day of [idea.planned.start, idea.planned.target, idea.baseline?.start, idea.baseline?.target, idea.actual.start, idea.actual.end, idea.actual.forecastEnd]) {
      if (day) days.push(dayIndex(day));
    }
  }
  const from = Math.min(...days);
  const to = Math.max(...days);
  // Pad to whole months on both sides so the axis starts and ends on a month line.
  const start = new Date(from * MS_PER_DAY);
  const end = new Date(to * MS_PER_DAY);
  return {
    from: Math.floor(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1) / MS_PER_DAY),
    to: Math.floor(Date.UTC(end.getUTCFullYear(), end.getUTCMonth() + 2, 1) / MS_PER_DAY),
  };
}

export function monthsIn(range: { from: number; to: number }): Array<{ day: number; label: string }> {
  const out: Array<{ day: number; label: string }> = [];
  const cursor = new Date(range.from * MS_PER_DAY);
  while (cursor.getTime() / MS_PER_DAY < range.to) {
    out.push({
      day: Math.round(cursor.getTime() / MS_PER_DAY),
      label: cursor.toLocaleDateString("en-US", { month: "short", ...(cursor.getUTCMonth() === 0 ? { year: "numeric" } : {}), timeZone: "UTC" }),
    });
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return out;
}

/** A planned window being dragged: the whole bar moves, or one edge does. Never inverts. */
export function dragWindow(
  window: { start: number; end: number },
  mode: "move" | "start" | "end",
  deltaDays: number,
): { start: number; end: number } {
  if (mode === "move") return { start: window.start + deltaDays, end: window.end + deltaDays };
  if (mode === "start") return { start: Math.min(window.start + deltaDays, window.end), end: window.end };
  return { start: window.start, end: Math.max(window.end + deltaDays, window.start) };
}

/** A dependency drawn on the timeline: from the record waited on to the one waiting. */
export interface DependencyEdge {
  from: string;
  to: string;
}

/** Every dependency between two rows the timeline shows, each once. */
export function dependencyEdges(plan: PlanData, shown: ReadonlySet<string>): DependencyEdge[] {
  const parentOf = new Map(plan.ideas.map((idea) => [idea.id, idea.parentId]));
  // A record and its ancestor never wait on each other: the parent's work holds the child's.
  const isAncestor = (ancestor: string, of: string): boolean => {
    const seen = new Set<string>();
    for (let at = parentOf.get(of) ?? null; at !== null && !seen.has(at); at = parentOf.get(at) ?? null) {
      if (at === ancestor) return true;
      seen.add(at);
    }
    return false;
  };
  const edges: DependencyEdge[] = [];
  for (const idea of plan.ideas) {
    if (!shown.has(idea.id)) continue;
    for (const from of idea.dependsOn) {
      if (shown.has(from) && from !== idea.id && !isAncestor(from, idea.id) && !isAncestor(idea.id, from)) edges.push({ from, to: idea.id });
    }
  }
  return edges;
}
