/**
 * Test-support builders for the milestone view shape. NOT imported by any app code — Vite
 * drops it from the bundle because nothing in the module graph reaches it. Beside the code
 * for the reason `components/task-list/fixtures.ts` gives: typed against the browser app's
 * `lib/types.ts`, which the Node-side suite cannot see.
 */
import type { GoalCriterion, GoalPace, MilestoneGoal, MilestoneListRow, MilestoneMemberRow, MilestoneProgress, MilestoneView } from "@/lib/types";

type ProgressOver = Omit<Partial<MilestoneProgress>, "counts"> & { counts?: Partial<MilestoneProgress["counts"]> };
type ViewOver = Omit<Partial<MilestoneView>, "milestone"> & { milestone?: Partial<MilestoneView["milestone"]> };
type ListRowOver = Omit<Partial<MilestoneListRow>, "milestone"> & { milestone?: Partial<MilestoneView["milestone"]> };

export function progress(over: ProgressOver = {}): MilestoneProgress {
  const counts = {
    unstarted: 0,
    ready: 0,
    active: 0,
    review: 0,
    gated: 0,
    blocked: 0,
    done: 0,
    cancelled: 0,
    ...(over.counts ?? {}),
  };
  const countable = over.countable ?? Object.values(counts).reduce((a, b) => a + b, 0) - counts.cancelled;
  return {
    total: over.total ?? countable + counts.cancelled,
    countable,
    counts,
    percent: over.percent ?? (countable === 0 ? null : Math.floor((counts.done * 100) / countable)),
    complete: over.complete ?? (countable > 0 && counts.done === countable),
  };
}

export function member(over: Partial<MilestoneMemberRow> & { identifier: string }): MilestoneMemberRow {
  return {
    issueId: `id-${over.identifier}`,
    title: `${over.identifier} title`,
    kind: "task",
    status: "todo",
    position: 1,
    rank: 1024,
    parent: null,
    nestedUnder: null,
    addedBy: "vp",
    addedAt: "2026-09-01T00:00:00.000Z",
    note: null,
    ...over,
  };
}

export function view(over: ViewOver = {}): MilestoneView {
  return {
    milestone: {
      id: "id-STA-190",
      identifier: "STA-190",
      title: "October cut",
      status: "in_progress",
      kind: "milestone",
      assignee: null,
      description: null,
      acceptanceCriteria: [],
      targetDate: "2026-10-31",
      startDate: null,
      state: "active",
      planPosition: null,
      closedAt: null,
      ...(over.milestone ?? {}),
    },
    progress: over.progress ?? progress(),
    revision: over.revision ?? 3,
    members: over.members ?? [],
    next: over.next ?? null,
    goal: over.goal ?? goal(),
    remaining: over.remaining ?? { estimated: 0, unestimated: 0, estimateSeconds: null, forecastSeconds: null },
  };
}

/** A criterion as the goal check reads it; unmarked (`unknown`) unless told otherwise. */
export function criterion(over: Partial<GoalCriterion> & { position: number }): GoalCriterion {
  return {
    text: `Criterion ${over.position}`,
    verdict: "unknown",
    marked: null,
    evidence: [],
    note: null,
    markedBy: null,
    markedAt: null,
    runId: null,
    why: "not marked yet",
    ...over,
  };
}

export function pace(over: Partial<GoalPace> = {}): GoalPace {
  return {
    targetDate: "2026-10-31",
    daysToTarget: 33,
    leaves: { done: 0, countable: 0, percent: null },
    laborSeconds: null,
    remainingSeconds: null,
    partial: false,
    unplannedRefs: [],
    verdict: "no_estimate",
    message: "",
    ...over,
  };
}

/** The goal check: counts and `met` follow the criteria, as core computes them. */
export function goal(over: { criteria?: GoalCriterion[]; pace?: Partial<GoalPace> } = {}): MilestoneGoal {
  const criteria = over.criteria ?? [];
  const count = (verdict: GoalCriterion["verdict"]) => criteria.filter((c) => c.verdict === verdict).length;
  const counts = { met: count("met"), unmet: count("unmet"), unknown: count("unknown"), total: criteria.length };
  return { criteria, counts, met: counts.met === counts.total, pace: pace(over.pace) };
}

export function listRow(over: ListRowOver = {}): MilestoneListRow {
  const { members: _members, goal: _goal, ...rest } = view(over);
  return { ...rest, memberCount: over.memberCount ?? 0 };
}
