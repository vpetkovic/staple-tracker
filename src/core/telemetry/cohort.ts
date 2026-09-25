/**
 * Cohort quality: how much of a filtered population's timing can be trusted, and which
 * records an analysis keeps (docs/timing-semantics.md, "Cohort coverage").
 * `staple timing quality` / MCP `timing_quality` / `GET /api/timing/quality`, one store method.
 *
 * ## The populations
 *
 * - **Eligible** (the denominator of every coverage figure): the leaves in the filter that are
 *   resolved `done`. A leaf is the unit that owes a measured `workSeconds`; a parent's is the
 *   sum of its children's, so counting both would count the same seconds twice. An open leaf
 *   owes no final figure yet, and a cancelled one owes none at all.
 * - **Ratio population**: the issues in the filter resolved `done` with their own estimate
 *   (`subtreePlan.source` is `own`, above 0 seconds) and no live estimated descendant. Every
 *   estimated leaf is in it, and so is a parent whose own estimate is the only one in its
 *   subtree; a parent over estimated descendants is not, because its descendants already are.
 *   No seconds are summed twice.
 *
 * ## The admitted levels
 *
 * A record is admitted when every level it touches is admitted: its state, and the level of each
 * of its reasons (`WORK_REASON_LEVEL`). `include` names the admitted states (default: all);
 * `exclude` removes states from them; `excludeReasons` names reason codes that drop a record
 * whatever its levels. So `exclude approximate` drops a reconstructed record that is also sparse,
 * and `include exact,reconstructed` keeps reconstructed records only when nothing approximate,
 * missing or under the floor holds for them.
 *
 * `work.counts`, `wall.counts` and every coverage figure are over the whole eligible population
 * and never move with the selection. Dropped records leave `items` and the `admitted` ratio
 * aggregate, and `excluded` says how many went, by state and by the reasons they carried. The
 * `exact` ratio aggregate is always exact records only, whatever the selection.
 */
import type { WorkQualityState } from "../types.js";
import { WORK_STATES, workLevels, type WallState, type WorkState } from "./quality.js";
import { afterPosition, cutPage, type KeysetPosition } from "./read-page.js";

/** One eligible record as the cohort lists it. */
export interface CohortItem {
  readonly identifier: string;
  readonly title: string;
  readonly kind: string;
  readonly status: string;
  readonly completedAt: string | null;
  readonly estimatedSeconds: number | null;
  readonly workSeconds: number | null;
  readonly estimateRatio: number | null;
  readonly work: { readonly state: WorkQualityState; readonly reasons: string[] };
  readonly wall: { readonly state: WallState; readonly reasons: string[] };
}

/** `Σ workSeconds / Σ estimatedSeconds` over the members of the ratio population the selection admits. */
export interface RatioAggregate {
  readonly states: WorkState[];
  /** Members summed: in the ratio population, admitted, with a `workSeconds`. */
  readonly count: number;
  readonly workSeconds: number | null;
  readonly estimatedSeconds: number | null;
  readonly ratio: number | null;
  /** `known` = `count`; `total` = the ratio population. */
  readonly coverage: { readonly known: number; readonly total: number; readonly partial: boolean };
  readonly missing: Record<string, string>;
}

export interface TimingQualityReport {
  readonly asOf: string;
  readonly filter: {
    readonly kind: string[] | null;
    readonly parent: string | null;
    /** The resolved instant: issues resolved at or after it. */
    readonly since: string | null;
    /** The admitted states the selection started from (every state when none was named). */
    readonly include: WorkState[];
    readonly exclude: WorkState[];
    /** Reason codes an analysis drops: a record carrying any of them is excluded whatever its state. */
    readonly excludeReasons: string[];
  };
  readonly population: {
    /** Issues in the filter (milestones are plans, not work, and are never counted). */
    readonly issues: number;
    /** Of them, the leaves resolved `done`: the denominator. */
    readonly eligible: number;
    /** Why the rest are not eligible. */
    readonly notEligible: { readonly parents: number; readonly open: number; readonly cancelled: number };
  };
  readonly work: {
    readonly counts: Record<WorkState, number>;
    /** `counts[state] / population.eligible`; null with a reason when nothing is eligible. */
    readonly coverage: Record<WorkState, number> | null;
    /** How many eligible records carry each reason (a record can carry several). */
    readonly reasons: Record<string, number>;
    readonly missing: Record<string, string>;
  };
  readonly wall: {
    readonly counts: Record<WallState, number>;
    readonly coverage: Record<WallState, number> | null;
    readonly reasons: Record<string, number>;
    readonly missing: Record<string, string>;
  };
  readonly ratio: {
    /** The ratio population: done issues with their own estimate and no estimated descendant. */
    readonly total: number;
    /** Of them, parents: a parent whose own estimate is the only one in its subtree. */
    readonly parents: number;
    /** Exact records only: the definition every per-issue `estimateRatio` uses. */
    readonly exact: RatioAggregate;
    /** The records the selection admits. */
    readonly admitted: RatioAggregate;
  };
  /**
   * What the selection dropped from the eligible records: `count` in all; `counts` by their
   * state; `reasons` how many of them carried each reason.
   */
  readonly excluded: { readonly count: number; readonly counts: Partial<Record<WorkState, number>>; readonly reasons: Record<string, number> };
  readonly items: CohortItem[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

/** A record the report reads: an eligible leaf, or a member of the ratio population. */
export interface CohortMember extends CohortItem {
  readonly id: string;
}

const WALL_STATES: readonly WallState[] = ["exact", "approximate", "missing"];
/** Work states in the order counts are listed: best first. */
export const WORK_ORDER: readonly WorkState[] = [...WORK_STATES].reverse();

const zeros = <S extends string>(states: readonly S[]): Record<S, number> => Object.fromEntries(states.map((state) => [state, 0])) as Record<S, number>;

function tally(values: ReadonlyArray<readonly string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const reasons of values) for (const reason of reasons) out[reason] = (out[reason] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function fractions<S extends string>(counts: Record<S, number>, total: number): Record<S, number> | null {
  if (total === 0) return null;
  return Object.fromEntries(Object.entries(counts).map(([state, count]) => [state, (count as number) / total])) as Record<S, number>;
}

/** The selection: which records an analysis keeps. */
export function admitter(filter: Pick<TimingQualityReport["filter"], "include" | "exclude" | "excludeReasons">): {
  states: WorkState[];
  admits: (member: { readonly work: { readonly state: WorkState; readonly reasons: readonly string[] } }) => boolean;
} {
  const states = WORK_ORDER.filter((state) => filter.include.includes(state) && !filter.exclude.includes(state));
  return {
    states,
    admits: (member) =>
      [...workLevels(member.work)].every((level) => states.includes(level)) && !member.work.reasons.some((reason) => filter.excludeReasons.includes(reason)),
  };
}

function aggregate(members: readonly CohortMember[], states: readonly WorkState[], admits: (member: CohortMember) => boolean): RatioAggregate {
  const total = members.length;
  const summed = members.filter((member) => member.workSeconds !== null && admits(member));
  const missing: Record<string, string> = {};
  let workSeconds: number | null = null;
  let estimatedSeconds: number | null = null;
  let ratio: number | null = null;
  if (summed.length === 0) {
    for (const field of ["workSeconds", "estimatedSeconds", "ratio"]) missing[field] = total === 0 ? "no_eligible_records" : "input_missing";
  } else {
    workSeconds = summed.reduce((sum, member) => sum + member.workSeconds!, 0);
    estimatedSeconds = summed.reduce((sum, member) => sum + member.estimatedSeconds!, 0);
    ratio = workSeconds / estimatedSeconds;
  }
  return {
    states: [...states],
    count: summed.length,
    workSeconds,
    estimatedSeconds,
    ratio,
    coverage: { known: summed.length, total, partial: summed.length < total },
    missing,
  };
}

/** The keyset of an item: resolution instant, then id. */
export const cohortKey = (member: { completedAt: string | null; id: string }): KeysetPosition => ({ at: member.completedAt ?? "", id: member.id });

/**
 * The report over `members` (every eligible leaf in the filter, in keyset order) and
 * `ratioMembers` (the ratio population). The listing is the admitted members after the cursor.
 */
export function cohortReport(input: {
  readonly asOf: string;
  readonly filter: TimingQualityReport["filter"];
  readonly population: TimingQualityReport["population"];
  readonly members: readonly CohortMember[];
  readonly ratioMembers: readonly CohortMember[];
  readonly ratioParents: number;
  readonly after: KeysetPosition | null;
  readonly limit: number;
  readonly scope: unknown;
}): TimingQualityReport {
  const { members, filter } = input;
  const eligible = members.length;
  const workCounts = zeros(WORK_ORDER);
  const wallCounts = zeros(WALL_STATES);
  for (const member of members) {
    workCounts[member.work.state] += 1;
    wallCounts[member.wall.state] += 1;
  }
  const empty: Record<string, string> = eligible === 0 ? { coverage: "no_eligible_records" } : {};
  const selection = admitter(filter);
  const exactOnly = admitter({ include: ["exact"], exclude: [], excludeReasons: [] });
  const dropped = members.filter((member) => !selection.admits(member));
  const excludedCounts: Partial<Record<WorkState, number>> = {};
  for (const member of dropped) excludedCounts[member.work.state] = (excludedCounts[member.work.state] ?? 0) + 1;

  const listed = members.filter((member) => selection.admits(member) && afterPosition(cohortKey(member), input.after));
  const page = cutPage(listed, input.limit, "timing_quality", input.scope, cohortKey);
  return {
    asOf: input.asOf,
    filter,
    population: input.population,
    work: { counts: workCounts, coverage: fractions(workCounts, eligible), reasons: tally(members.map((member) => member.work.reasons)), missing: { ...empty } },
    wall: { counts: wallCounts, coverage: fractions(wallCounts, eligible), reasons: tally(members.map((member) => member.wall.reasons)), missing: { ...empty } },
    ratio: {
      total: input.ratioMembers.length,
      parents: input.ratioParents,
      exact: aggregate(input.ratioMembers, exactOnly.states, exactOnly.admits),
      admitted: aggregate(input.ratioMembers, selection.states, selection.admits),
    },
    excluded: {
      count: dropped.length,
      counts: Object.fromEntries(WORK_ORDER.filter((state) => excludedCounts[state] !== undefined).map((state) => [state, excludedCounts[state]!])),
      reasons: tally(dropped.map((member) => member.work.reasons)),
    },
    items: page.items.map(({ id: _id, ...item }) => item),
    truncated: page.truncated,
    nextCursor: page.nextCursor,
  };
}
