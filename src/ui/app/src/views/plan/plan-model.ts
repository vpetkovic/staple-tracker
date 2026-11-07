/**
 * The Plan view's boards as data: which ideas sit in which column of each lens, and what a
 * drop on a column writes. Pure, so `plan-model.test.ts` pins it without rendering.
 */
import type { HorizonData, IdeaData, Maturity, PlanData } from "@/lib/plan-types";

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

export const MATURITY_COLUMNS: ReadonlyArray<{ id: Exclude<Maturity, "dropped">; title: string; hint: string }> = [
  { id: "raw", title: "Raw", hint: "just captured" },
  { id: "exploring", title: "Exploring", hint: "questions open" },
  { id: "shaped", title: "Shaped", hint: "scope is clear" },
];

/** Work started from an idea lives in the tracker; the Ideas lens shows what is still being shaped. */
export function isStarted(idea: IdeaData): boolean {
  return idea.stage === "started" || idea.stage === "shipped";
}

export function ideasColumns(plan: PlanData): BoardColumn[] {
  return MATURITY_COLUMNS.map((column) => ({
    key: `m:${column.id}`,
    title: column.title,
    hint: column.hint,
    ideas: plan.ideas.filter((idea) => idea.maturity === column.id && !isStarted(idea)),
    drop: { maturity: column.id },
  }));
}

export function droppedIdeas(plan: PlanData): IdeaData[] {
  return plan.ideas.filter((idea) => idea.maturity === "dropped" && !isStarted(idea));
}

export function horizonsColumns(plan: PlanData): BoardColumn[] {
  const unscheduled: BoardColumn = {
    key: "h:",
    title: "Unscheduled",
    hint: "shaped, no when yet",
    ideas: plan.ideas.filter((idea) => idea.horizonId === null && idea.maturity !== "dropped" && (idea.maturity === "shaped" || isStarted(idea))),
    drop: { horizon: null },
  };
  return [
    unscheduled,
    ...plan.horizons.map((horizon) => ({
      key: `h:${horizon.id}`,
      title: horizon.name,
      hint: horizon.date ? "" : "no date",
      ideas: plan.ideas.filter((idea) => idea.horizonId === horizon.id && idea.maturity !== "dropped"),
      drop: { horizon: horizon.id },
      horizon,
    })),
  ];
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
