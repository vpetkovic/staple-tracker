/**
 * A horizon's plan as a tree (design/plan.md, "Presentation"): the one model the Horizons lens,
 * the horizon drawer and the Milestones view draw. Which records a horizon carries, each parent
 * with its sub-ideas under it, each record with its own state, units, open questions and plan
 * step; a sub-idea carried elsewhere dimmed with where it is; a record still being explored a
 * reserved row. Pure, and it computes no number: every count, unit and percent is the server's.
 */
import type { HorizonData, IdeaData, PlanStepData, PlanUnits } from "../../lib/plan-types.js";
import { dayLabel } from "./plan-model";
import { planCounts } from "./plan-counts";

/** A plan step as a row says it: a few words, and whether it waits on the person. */
export interface StepLabel {
  label: string;
  person: boolean;
}

export interface TreeRow {
  idea: IdeaData;
  /** Still being thought (raw or exploring): a reserved row, never a delivery card, never dragged. */
  reserved: boolean;
  /** Not carried by this tree's horizon: `on <horizon>` or `unscheduled`, drawn dimmed. Null when it is. */
  where: string | null;
  /** A top row whose parent is not on this tree: the parent's title. */
  parentTitle: string | null;
  /** What its bar draws: a group's rollup, a leaf's own work items. */
  units: PlanUnits;
  step: StepLabel | null;
  children: TreeRow[];
}

/** The states that are still thinking: on a horizon they reserve a row, not a delivery card. */
const THINKING = new Set(["raw", "exploring"]);
/** The states delivery tracks: a top row of the Unscheduled column is one of these. */
const DELIVERY = new Set(["shaped", "started", "shipped"]);

/**
 * The tree for one horizon, or for the Unscheduled column (`horizonId` null). Its records are
 * those the horizon carries (`carriedBy`), not dropped; on Unscheduled, those no horizon carries
 * that delivery tracks. A record whose parent is on the tree sits under it; the rest are top rows.
 * A row's sub-ideas are all shown: carried here, as rows of their own; elsewhere, dimmed with
 * where. In the payload's order, which is the plan's.
 */
export function planTree(input: { horizonId: string | null; ideas: readonly IdeaData[]; horizons: ReadonlyArray<{ id: string; name: string }> }): TreeRow[] {
  const { horizonId, ideas } = input;
  const live = ideas.filter((idea) => idea.state !== "dropped");
  const here = new Set(live.filter((idea) => idea.carriedBy === horizonId).map((idea) => idea.id));
  const titleOf = new Map(ideas.map((idea) => [idea.id, idea.title]));
  const nameOf = new Map(input.horizons.map((horizon) => [horizon.id, horizon.name]));
  const where = (idea: IdeaData): string | null => {
    if (here.has(idea.id)) return null;
    return idea.carriedBy === null ? "unscheduled" : `on ${nameOf.get(idea.carriedBy) ?? "another horizon"}`;
  };
  const row = (idea: IdeaData, seen: ReadonlySet<string>): TreeRow => {
    const away = where(idea);
    const children = away !== null || seen.has(idea.id) ? [] : live.filter((child) => child.parentId === idea.id).map((child) => row(child, new Set([...seen, idea.id])));
    return {
      idea,
      reserved: THINKING.has(idea.state),
      where: away,
      parentTitle: null,
      units: children.length > 0 ? idea.units : idea.own,
      step: stepLabel(idea.nextStep),
      children,
    };
  };
  return live
    .filter((idea) => here.has(idea.id) && (idea.parentId === null || !here.has(idea.parentId)))
    .filter((idea) => horizonId !== null || DELIVERY.has(idea.state))
    .map((idea) => ({ ...row(idea, new Set()), parentTitle: idea.parentId === null ? null : (titleOf.get(idea.parentId) ?? null) }));
}

/** What a record's plan step needs, in the words a row prints. */
export function stepLabel(step: PlanStepData | null): StepLabel | null {
  if (step === null) return null;
  const person = step.who === "person";
  switch (step.need) {
    case "wait": {
      const parts = [
        step.waitingOn?.start ? `starts ${dayLabel(step.waitingOn.start, false)}` : null,
        step.waitingOn?.records?.length ? `waits on ${step.waitingOn.records.map((record) => record.title).join(", ")}` : null,
      ].filter((part): part is string => part !== null);
      return { label: parts.join(" · ") || "waiting", person };
    }
    case "scaffold":
      return { label: "ready to scaffold", person };
    case "answer_questions": {
      // The questions the step lists for the person: the server's list, printed as it is.
      const asked = step.questions ?? [];
      return { label: `needs you: ${asked.length} question${asked.length === 1 ? "" : "s"}`, person };
    }
    case "write_plan":
    case "fix_plan":
      return { label: "plan needed", person };
    case "mark_shaped":
      return { label: "ready to mark shaped", person };
    case "brainstorm":
      return { label: "to develop", person };
  }
}

/** The server's percent as the CLI prints it (`percentText` in the core): a whole 100 that is not complete says so. */
export function percentText(percent: number | null, complete: boolean): string | null {
  if (percent === null) return null;
  return `${percent}%${percent === 100 && !complete ? " incomplete" : ""}`;
}

/** What a horizon's header prints beside its bar: leaf records apart from parents, its states and what waits on the person. */
export interface TreeHeaderWords {
  records: string;
  states: string | null;
  needsYou: string | null;
}

export function treeHeader(horizon: Pick<HorizonData, "memberCount" | "records" | "needsYou">): TreeHeaderWords {
  const { records } = horizon;
  const states = (["shipped", "started", "shaped", "exploring", "raw"] as const)
    .filter((state) => records[state] > 0)
    .map((state) => `${records[state]} ${state}`);
  return {
    records: planCounts(horizon),
    states: states.length > 0 ? states.join(" · ") : null,
    needsYou: horizon.needsYou > 0 ? `Needs you: ${horizon.needsYou}` : null,
  };
}
