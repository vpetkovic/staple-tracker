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
 * - **Ratio population**: the eligible leaves with their own estimate (`subtreePlan.source` is
 *   `own`, above 0 seconds), the population the estimate ratio is defined over.
 *
 * ## Counts never move; the admitted set does
 *
 * `work.counts`, `wall.counts` and every coverage figure are over the whole eligible
 * population and are never changed by `exclude`. `exclude` names work states an analysis
 * drops, and `excludeReasons` reason codes (a reconstructed record that is also `sparse` is
 * dropped by `sparse`, which its state alone would hide): those records leave `items` and the
 * `admitted` ratio aggregate, and `excluded` says how many went, per state and per reason. Nothing is dropped silently: with no `exclude`, every eligible
 * record is listed, `timing-floor` included, each with its state.
 *
 * The `exact` ratio aggregate is the page's definition (exact records only), whatever
 * `exclude` says; `admitted` is the same sum over the states not excluded.
 */
import type { WorkQualityState } from "../types.js";
import { WORK_STATES, type WallState, type WorkState } from "./quality.js";
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

/** `Σ workSeconds / Σ estimatedSeconds` over the members of the ratio population in `states`. */
export interface RatioAggregate {
  readonly states: WorkState[];
  /** Members summed: in the ratio population, in `states`, with a `workSeconds`. */
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
    /** The resolved instant: resolved leaves completed at or after it. */
    readonly since: string | null;
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
    /** The ratio population: eligible leaves with their own estimate. */
    readonly total: number;
    /** Exact records only: the definition every per-issue `estimateRatio` uses. */
    readonly exact: RatioAggregate;
    /** Every state not excluded. */
    readonly admitted: RatioAggregate;
  };
  /**
   * What the analysis dropped: `count` records in all; `counts` the eligible records of each
   * excluded state; `reasons` the eligible records carrying each excluded reason.
   */
  readonly excluded: { readonly count: number; readonly counts: Partial<Record<WorkState, number>>; readonly reasons: Record<string, number> };
  readonly items: CohortItem[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

/** An eligible leaf, with what the report reads of it. */
export interface CohortMember extends CohortItem {
  readonly id: string;
  /** In the ratio population: its own estimate, above 0. */
  readonly ratioEligible: boolean;
}

const WALL_STATES: readonly WallState[] = ["exact", "approximate", "missing"];
/** Work states in the order counts are listed: best first. */
const WORK_ORDER: readonly WorkState[] = [...WORK_STATES].reverse();

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

function aggregate(members: readonly CohortMember[], states: readonly WorkState[], total: number, admits: (member: CohortMember) => boolean = () => true): RatioAggregate {
  const summed = members.filter((member) => member.ratioEligible && member.workSeconds !== null && states.includes(member.work.state) && admits(member));
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
    states: WORK_ORDER.filter((state) => states.includes(state)),
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
 * The report over `members` (every eligible leaf in the filter, in keyset order). `page` is the
 * slice to list: the members after the cursor, admitted by `exclude`.
 */
export function cohortReport(input: {
  readonly asOf: string;
  readonly filter: TimingQualityReport["filter"];
  readonly population: TimingQualityReport["population"];
  readonly members: readonly CohortMember[];
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
  const admittedStates = WORK_ORDER.filter((state) => !filter.exclude.includes(state));
  const excludedCounts: Partial<Record<WorkState, number>> = {};
  for (const state of filter.exclude) excludedCounts[state] = workCounts[state];
  const excludedReasons: Record<string, number> = {};
  for (const reason of filter.excludeReasons) excludedReasons[reason] = members.filter((member) => member.work.reasons.includes(reason)).length;
  const admits = (member: CohortMember): boolean =>
    admittedStates.includes(member.work.state) && !member.work.reasons.some((reason) => filter.excludeReasons.includes(reason));
  const total = members.filter((member) => member.ratioEligible).length;

  const listed = members.filter((member) => admits(member) && afterPosition(cohortKey(member), input.after));
  const page = cutPage(listed, input.limit, "timing_quality", input.scope, cohortKey);
  return {
    asOf: input.asOf,
    filter,
    population: input.population,
    work: { counts: workCounts, coverage: fractions(workCounts, eligible), reasons: tally(members.map((member) => member.work.reasons)), missing: { ...empty } },
    wall: { counts: wallCounts, coverage: fractions(wallCounts, eligible), reasons: tally(members.map((member) => member.wall.reasons)), missing: { ...empty } },
    ratio: { total, exact: aggregate(members, ["exact"], total), admitted: aggregate(members, admittedStates, total, admits) },
    excluded: { count: members.filter((member) => !admits(member)).length, counts: excludedCounts, reasons: excludedReasons },
    items: page.items.map(({ id: _id, ratioEligible: _ratio, ...item }) => item),
    truncated: page.truncated,
    nextCursor: page.nextCursor,
  };
}
