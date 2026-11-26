/**
 * The toolbar's "Show only" focus and filter text, as data: which ideas every lens draws while
 * one is on, and the counts its pills print. A match keeps its ancestors, so a sub-idea is never
 * shown without the parent that gives it context. Pure, and it computes no number of its own:
 * each focus reads one flag the payload already carries.
 */
import type { IdeaData, PlanData } from "../../lib/plan-types.js";
import { ancestorsOf } from "./plan-model";

export type PlanFocus = "all" | "you" | "late" | "notStarted";

/** What each focus keeps, from the payload's own flags. */
const FOCUS: Record<Exclude<PlanFocus, "all">, (idea: IdeaData) => boolean> = {
  you: (idea) => idea.nextStep?.who === "person",
  late: (idea) => idea.late && idea.state !== "shipped",
  notStarted: (idea) => idea.notStarted,
};

const live = (idea: IdeaData) => idea.state !== "dropped";

/** How many live ideas each pill would keep. */
export function focusCounts(plan: Pick<PlanData, "ideas">): Record<Exclude<PlanFocus, "all">, number> {
  const ideas = plan.ideas.filter(live);
  return {
    you: ideas.filter(FOCUS.you).length,
    late: ideas.filter(FOCUS.late).length,
    notStarted: ideas.filter(FOCUS.notStarted).length,
  };
}

/** A focus or filter text is on: lenses then fold nothing away. */
export function focusing(focus: PlanFocus, text: string): boolean {
  return focus !== "all" || text.trim() !== "";
}

/**
 * The plan with `ideas` narrowed to those that match the focus and the text (a title holding
 * it, case aside), plus every ancestor of a match, in plan order. The whole plan, unchanged,
 * when neither is on.
 */
export function focusPlan(plan: PlanData, focus: PlanFocus, text: string): PlanData {
  if (!focusing(focus, text)) return plan;
  const query = text.trim().toLowerCase();
  const matches = plan.ideas.filter((idea) => (focus === "all" || (live(idea) && FOCUS[focus](idea))) && (query === "" || idea.title.toLowerCase().includes(query)));
  const keep = new Set(matches.map((idea) => idea.id));
  for (const idea of matches) for (const ancestor of ancestorsOf(plan, idea)) keep.add(ancestor.id);
  return { ...plan, ideas: plan.ideas.filter((idea) => keep.has(idea.id)) };
}
