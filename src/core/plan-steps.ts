/**
 * Plan steps (design/plan.md, "Plan steps"): what a horizon's planned work still needs before it is
 * tickets, and who acts on it next. A step is derived from the facts the plan memo already holds,
 * never stored and never claimed: an idea stays unclaimable, and the pickup resolver never sees one.
 *
 * Two pure functions, and every surface reads them: `planStepOf` says what one record needs (or
 * null), `orderPlanSteps` lists a horizon's steps in plan order.
 */
import type { IdeaState } from "./plan-lifecycle-table.js";
import type { Maturity } from "./plan.js";

export const PLAN_STEP_NEEDS = ["answer_questions", "write_plan", "mark_shaped", "fix_plan", "wait", "scaffold", "brainstorm"] as const;
export type PlanStepNeed = (typeof PLAN_STEP_NEEDS)[number];

/** Who must act next: the person, an agent, or nobody yet (a waiting idea). */
export type PlanStepWho = "person" | "agent" | "nobody";

/** What a waiting idea waits for: its planned start, and the records it depends on that have not shipped. */
export interface PlanStepWaitingOn {
  start?: string;
  records?: Array<{ id: string; title: string; state: IdeaState }>;
}

export interface PlanStep {
  ideaId: string;
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  /** The horizon that carries the record: the one it is scheduled on, or its nearest scheduled ancestor's. */
  horizonId: string;
  state: IdeaState;
  need: PlanStepNeed;
  who: PlanStepWho;
  instruction: string;
  /** `answer_questions`: the open questions, not the deferred ones. */
  questions?: string[];
  /** `write_plan` and `fix_plan`: what the shaped gate names. */
  missing?: string[];
  /** `wait`: what it waits for. */
  waitingOn?: PlanStepWaitingOn;
}

/** The facts one record's step reads, all already in the plan memo. */
export interface PlanStepInput {
  id: string;
  /** How a command names it: its ticket number once promoted, else its id. */
  ref: string;
  title: string;
  parentId: string | null;
  parentTitle: string | null;
  horizonId: string;
  /** It is scheduled on a horizon itself; otherwise the horizon carries it through an ancestor. */
  scheduled: boolean;
  state: IdeaState;
  maturity: Maturity;
  /** It has own work: it was promoted, or links issues. */
  ownWork: boolean;
  /** Its questions neither resolved nor deferred. */
  openQuestions: string[];
  /** What the shaped gate finds missing; read only for an exploring record. */
  gate: () => string[];
  /** A shaped plan's gate failures (empty when it passes). */
  planIncomplete: readonly string[];
  /** The day it may start: its own planned start, else its nearest ancestor's; null for none. */
  start: string | null;
  /** The records it depends on, with their state. */
  dependsOn: ReadonlyArray<{ id: string; title: string; state: IdeaState }>;
  today: string;
}

/**
 * What one record a horizon carries still needs, or null when it needs nothing from planning
 * (shipped, dropped, or shaped with its own work). The step table in design/plan.md, row by row.
 */
export function planStepOf(input: PlanStepInput): PlanStep | null {
  if (input.state === "shipped" || input.state === "dropped") return null;
  const step = (need: PlanStepNeed, who: PlanStepWho, instruction: string, extra: Partial<PlanStep> = {}): PlanStep => ({
    ideaId: input.id,
    title: input.title,
    parentId: input.parentId,
    parentTitle: input.parentTitle,
    horizonId: input.horizonId,
    state: input.state,
    need,
    who,
    instruction,
    ...extra,
  });
  const ref = input.ref;
  const brainstorm = () =>
    step(
      "brainstorm",
      "agent",
      `Develop "${input.title}" and capture the result on the idea: its brief, questions (staple idea ask ${ref}), decisions and plan sections (staple idea plan ${ref}). Scheduling it and moving its maturity stay the person's.`,
    );
  if (input.maturity === "raw") return brainstorm();
  if (input.maturity === "exploring") {
    if (!input.scheduled && !input.ownWork) return brainstorm();
    if (input.openQuestions.length > 0) {
      return step(
        "answer_questions",
        "person",
        `Bring these questions on "${input.title}" to the person, and record each answer with staple idea resolve ${ref} <n> (or staple idea defer ${ref} <n> when the person leaves it open on purpose). Never mark it shaped yourself.`,
        { questions: [...input.openQuestions] },
      );
    }
    if (input.ownWork) return null;
    const missing = input.gate();
    if (missing.length > 0) {
      return step("write_plan", "agent", `Write what the shaped gate names for "${input.title}" (staple idea plan ${ref}, staple idea task ${ref} add), then tell the person it is ready to be marked shaped.`, {
        missing: [...missing],
      });
    }
    return step("mark_shaped", "person", `"${input.title}" passes the shaped gate: tell the person it is ready to be marked shaped. Marking it is theirs.`);
  }
  // Shaped.
  if (input.ownWork) return null;
  if (input.planIncomplete.length > 0) {
    return step("fix_plan", "agent", `"${input.title}" was edited since it was shaped and no longer passes the gate: fix what it names (staple idea plan ${ref}, staple idea task ${ref}).`, {
      missing: [...input.planIncomplete],
    });
  }
  const waitingOn: PlanStepWaitingOn = {};
  if (input.start !== null && input.start > input.today) waitingOn.start = input.start;
  const unshipped = input.dependsOn.filter((dep) => dep.state !== "shipped" && dep.state !== "dropped");
  if (unshipped.length > 0) waitingOn.records = unshipped.map(({ id, title, state }) => ({ id, title, state }));
  if (waitingOn.start !== undefined || waitingOn.records !== undefined) {
    const why = [
      ...(waitingOn.start !== undefined ? [`its planned start, ${waitingOn.start}`] : []),
      ...(waitingOn.records ?? []).map((dep) => `"${dep.title}" (${dep.state})`),
    ].join(" and ");
    return step("wait", "nobody", `Nothing to do yet: "${input.title}" waits for ${why}. Never scaffold it before then; the person releases it early by moving its planned start.`, { waitingOn });
  }
  return step(
    "scaffold",
    "agent",
    `Its turn has come. First re-check the breakdown of "${input.title}" against what has landed since it was written and bring the person any change. Then preview and confirm Scaffold (staple idea scaffold ${ref}, then --confirm <fingerprint>), or link existing tickets with Adopt (staple idea adopt ${ref} <issue>) where its recorded decisions say its tickets come from elsewhere.`,
  );
}

/**
 * A record whose Scaffold would also build sub-ideas that still wait (Scaffold builds every shaped
 * sub-idea beneath it) waits with them: scaffolding it now would scaffold them early. Its
 * sub-ideas whose turn has come keep their own `scaffold` steps and are scaffolded one by one.
 */
export function heldBySubIdeas(step: PlanStep, waiting: readonly PlanStep[]): PlanStep {
  const names = waiting.map((sub) => `"${sub.title}"`).join(", ");
  return {
    ...step,
    need: "wait",
    who: "nobody",
    instruction: `Nothing to do yet: Scaffold on "${step.title}" would also build ${names}, which still wait${waiting.length === 1 ? "s" : ""}. Never scaffold it before then; scaffold each of its sub-ideas on its own when its turn comes.`,
    waitingOn: { records: waiting.map((sub) => ({ id: sub.ideaId, title: sub.title, state: sub.state })) },
  };
}

/**
 * A horizon's steps in plan order: its carried records by rank, then id, each parent before the
 * records beneath it; a record whose parent the horizon does not carry is a top one.
 */
export function orderPlanSteps(
  records: ReadonlyArray<{ id: string; rank: number; parentId: string | null; step: PlanStep | null }>,
): PlanStep[] {
  const byPlan = (a: { id: string; rank: number }, b: { id: string; rank: number }): number => a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const ids = new Set(records.map((record) => record.id));
  const children = new Map<string, typeof records[number][]>();
  const tops: Array<(typeof records)[number]> = [];
  for (const record of records) {
    if (record.parentId !== null && ids.has(record.parentId)) {
      const list = children.get(record.parentId) ?? [];
      list.push(record);
      children.set(record.parentId, list);
    } else tops.push(record);
  }
  const out: PlanStep[] = [];
  const seen = new Set<string>();
  const visit = (record: (typeof records)[number]): void => {
    if (seen.has(record.id)) return;
    seen.add(record.id);
    if (record.step !== null) out.push(record.step);
    for (const child of [...(children.get(record.id) ?? [])].sort(byPlan)) visit(child);
  };
  for (const top of [...tops].sort(byPlan)) visit(top);
  return out;
}

/** When every step left waits: the earliest planned start among them, or null when none waits on a date. */
export function earliestWait(steps: readonly PlanStep[]): string | null {
  const starts = steps.map((step) => step.waitingOn?.start).filter((start): start is string => start !== undefined);
  return starts.length === 0 ? null : starts.reduce((a, b) => (a < b ? a : b));
}
