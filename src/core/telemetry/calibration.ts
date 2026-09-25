/**
 * Calibration cohorts: how long work of a given class takes against its estimate, from the
 * samples that can be trusted (docs/timing-semantics.md, "Calibration cohorts").
 * `staple calibrate` / MCP `calibration_cohorts` / `GET /api/calibration`, one store method.
 *
 * ## Samples
 *
 * The population is the ratio population of the cohort read (`cohort.ts`): issues resolved
 * `done` with their own estimate and no live estimated descendant. A member is a SAMPLE of an
 * evidence set when the selection of that set admits it:
 *
 * - `exact`, always: exact records only (`include exact`, the definition of `ratio.exact`).
 * - `reconstructed`, only when asked for: reconstructed records with no approximate, missing or
 *   floor reason (`include reconstructed`). It is its own set with its own cohorts, never pooled
 *   with `exact`: backfilled history and captured history are different evidence.
 *
 * Approximate, timing-floor and missing records are never samples. They stay in the
 * denominators and are counted, by state and reason, under `excluded`.
 *
 * ## The estimate a sample divides by
 *
 * Q4's switch: the first `estimateAtStart` that reads the issue's own estimate above 0, among the
 * worker attempts on the issue behind its work (a reconstructed attempt reads none), so a
 * re-estimate made after the work started cannot flatter the ratio; otherwise the current own
 * estimate, with the reason in `estimate.missing.atStart`. A parent data point always reads
 * `parent`: its work is its children's (Q5).
 *
 * ## Dimensions and the fallback
 *
 * A cohort's key is the full combination of {@link DIMENSIONS}. A key with fewer than
 * {@link MIN_COHORT_SAMPLES} samples falls back along {@link LEVELS}, dropping one dimension at
 * a time (model, then area, then work type, then priority, then kind), to the first class that
 * has enough; the path it walked, with the count at each level, is reported. The evidence set is
 * never dropped. When not even the whole set has enough, the cohort reads the whole set and
 * says `below_minimum_everywhere`.
 *
 * ## Snapshot identity
 *
 * Every report carries `snapshot.id`, a SHA-256 over the algorithm version, the repository id,
 * the selection (`since` as given, never resolved against the clock) and every member of the population in id order, so the same data
 * gives the same id on every device and in any order, and a changed sample changes it. It
 * reads replicated data only: no `asOf`, no event sequence (device-local), no wall figure.
 */
import { createHash } from "node:crypto";
import { admitter } from "./cohort.js";
import type { WorkState } from "./quality.js";
import { afterPosition, cutPage, type KeysetPosition } from "./read-page.js";

/** Bumped whenever a rule here changes what a snapshot id covers. */
export const CALIBRATION_ALGORITHM = "calibration/1";

/**
 * The smallest class a cohort reads. With 5 samples the range of the samples covers the
 * median with probability 1 − 2·0.5⁵ = 93.75%, the first n at which the range is at least a
 * 90% distribution-free interval for it (4 samples give 87.5%). Fewer, and a median is two or
 * three numbers.
 */
export const MIN_COHORT_SAMPLES = 5;

/** How many member refs a cohort lists; `members.total` says how many there are. */
export const MEMBER_REFS = 20;

export const EVIDENCE_SETS = ["exact", "reconstructed"] as const;
export type EvidenceSet = (typeof EVIDENCE_SETS)[number];

/** The dimensions of a cohort key, broadest last. */
export const DIMENSIONS = ["kind", "priority", "workType", "area", "model"] as const;
export type Dimension = (typeof DIMENSIONS)[number];
export type CohortKey = Record<Dimension, string>;

/** A dimension with no value on a record. */
export const UNKNOWN = "unknown";
/** A dimension a class dropped. */
export const ANY = "*";

/** The fallback order: each level keeps these dimensions. */
export const LEVELS: ReadonlyArray<{ readonly level: number; readonly name: string; readonly keeps: readonly Dimension[] }> = [
  { level: 0, name: "full", keeps: ["kind", "priority", "workType", "area", "model"] },
  { level: 1, name: "without_model", keeps: ["kind", "priority", "workType", "area"] },
  { level: 2, name: "without_area", keeps: ["kind", "priority", "workType"] },
  { level: 3, name: "without_work_type", keeps: ["kind", "priority"] },
  { level: 4, name: "kind", keeps: ["kind"] },
  { level: 5, name: "all", keeps: [] },
];

/** The label prefixes the two label-sourced dimensions read. */
export const LABEL_PREFIX = { workType: "type:", area: "area:" } as const;

/**
 * A label-sourced dimension: the values of every label `<prefix><value>` (prefix matched
 * without case, value lowercased and trimmed), distinct and sorted, joined with `+`;
 * {@link UNKNOWN} when there is none.
 */
export function labelDimension(labels: readonly string[], prefix: string): string {
  const values = new Set<string>();
  for (const label of labels) {
    if (label.toLowerCase().startsWith(prefix)) {
      const value = label.slice(prefix.length).trim().toLowerCase();
      if (value !== "") values.add(value);
    }
  }
  return values.size === 0 ? UNKNOWN : [...values].sort().join("+");
}

/**
 * The model dimension: the `harness.model` of every contributing worker attempt, distinct and
 * sorted, joined with `+`; an attempt that named none counts as {@link UNKNOWN}, and so does a
 * record with no attempt at all.
 */
export function modelDimension(models: ReadonlyArray<string | null>): string {
  if (models.length === 0) return UNKNOWN;
  return [...new Set(models.map((model) => (model === null || model.trim() === "" ? UNKNOWN : model.trim())))].sort().join("+");
}

/** Why a sample divides by the current estimate and not the one its work started from. */
export type EstimateAtStartMissing = "parent" | "no_worker_attempt" | "not_recorded" | "not_own";

/** The estimate a sample divides by. */
export interface SampleEstimate {
  readonly seconds: number;
  /** `at_start`: the first own `estimateAtStart` behind the work; `current`: the issue's own estimate now. */
  readonly source: "at_start" | "current";
  readonly atStartSeconds: number | null;
  readonly currentSeconds: number;
  /** Why `atStartSeconds` is null. */
  readonly missing: { readonly atStart?: EstimateAtStartMissing };
}

/** The evidence behind a record's work figure. */
export interface SampleEvidence {
  readonly state: WorkState;
  readonly reasons: string[];
  /** Worker attempts contributing to `workSeconds`. */
  readonly workerAttempts: number;
  /** Their provenances, distinct and sorted (`recorded`, `reconstructed`). */
  readonly provenance: string[];
  /** Of them, how many named a harness. */
  readonly harnessSupplied: number;
}

/** A member of the population, as the store supplies it. */
export interface CalibrationMember {
  readonly id: string;
  readonly identifier: string;
  readonly title: string;
  readonly completedAt: string | null;
  readonly workSeconds: number | null;
  readonly estimate: SampleEstimate;
  readonly dimensions: CohortKey;
  readonly evidence: SampleEvidence;
}

/** One sample, as `--samples` lists it. */
export interface CalibrationSample {
  readonly set: EvidenceSet;
  readonly identifier: string;
  readonly title: string;
  readonly completedAt: string | null;
  readonly workSeconds: number;
  readonly estimate: SampleEstimate;
  /** `workSeconds / estimate.seconds`. */
  readonly ratio: number;
  readonly dimensions: CohortKey;
  readonly evidence: SampleEvidence;
}

/** What a class leaves out: the population members in it that are not samples of the set. */
export interface CalibrationExcluded {
  readonly count: number;
  readonly counts: Partial<Record<WorkState, number>>;
  readonly reasons: Record<string, number>;
}

/** `samples / eligible`, with the denominator named. */
export interface CalibrationCoverage {
  readonly samples: number;
  readonly eligible: number;
  /** Null, with `no_eligible_records`, when nothing is eligible. */
  readonly fraction: number | null;
  readonly denominator: "ratio_population";
}

/** One cohort: an observed key, and the class it reads. */
export interface CalibrationCohort {
  readonly set: EvidenceSet;
  /** The full combination of dimensions its samples share. */
  readonly key: CohortKey;
  /** Samples with exactly that key. */
  readonly keySamples: number;
  /** The level it read: 0 is the full key. */
  readonly level: number;
  readonly levelName: string;
  /** The key with the dropped dimensions as `*`. */
  readonly class: CohortKey;
  /** Every level tried, in order, up to the one read, with its sample count. */
  readonly path: Array<{ readonly level: number; readonly name: string; readonly samples: number }>;
  /** `none`: the key had enough; `below_minimum`: it fell back; `below_minimum_everywhere`: even `all` has too few. */
  readonly fallback: "none" | "below_minimum" | "below_minimum_everywhere";
  readonly samples: number;
  /** Samples over the population members in the class, whatever their quality. */
  readonly coverage: CalibrationCoverage;
  /**
   * Median is the lower median (`floor((n − 1) / 2)`); pooled is `Σ work / Σ estimate`; `min` and
   * `max` are the sample range, which covers the median with probability `rangeConfidence`.
   */
  readonly ratio: { readonly median: number; readonly pooled: number; readonly min: number; readonly max: number };
  readonly workSeconds: { readonly median: number; readonly total: number; readonly min: number; readonly max: number };
  /**
   * `1 − 2 · 0.5ⁿ`: the probability that `[min, max]` covers the class's true median, for any
   * distribution (0.9375 at the minimum of 5). 0 with no sample.
   */
  readonly rangeConfidence: number;
  readonly estimatedSeconds: { readonly total: number };
  /** How many samples divided by each estimate source. */
  readonly estimateSources: { readonly at_start: number; readonly current: number };
  /** The class's samples, oldest resolution first, at most {@link MEMBER_REFS}. */
  readonly members: { readonly total: number; readonly refs: string[]; readonly truncated: boolean };
  readonly excluded: CalibrationExcluded;
  /** `small_sample` when the class read has fewer than the minimum. */
  readonly warnings: string[];
}

export interface CalibrationSetSummary {
  readonly set: EvidenceSet;
  readonly samples: number;
  readonly coverage: CalibrationCoverage;
  readonly excluded: CalibrationExcluded;
  /** Distinct full keys among the samples: the cohorts this set lists. */
  readonly cohorts: number;
}

export interface CalibrationFilter {
  readonly kind: string[] | null;
  readonly priority: string[] | null;
  readonly parent: string | null;
  /** The resolved instant: issues resolved at or after it. */
  readonly since: string | null;
  /** The evidence sets read: `exact` always, `reconstructed` when asked for. */
  readonly include: EvidenceSet[];
}

export interface CalibrationReport {
  readonly asOf: string;
  readonly filter: CalibrationFilter;
  /** The identity of the data the report was computed from. */
  readonly snapshot: {
    readonly id: string;
    readonly algorithm: string;
    readonly repositoryId: string | null;
    /** The population the id covers. */
    readonly members: number;
    readonly samples: Partial<Record<EvidenceSet, number>>;
  };
  readonly method: {
    readonly minSamples: number;
    readonly levels: string[];
    readonly median: "lower";
    readonly estimate: "at_start_else_current";
  };
  readonly population: {
    /** Issues in the filter (milestones never). */
    readonly issues: number;
    /** The ratio population: done, their own estimate, no live estimated descendant. */
    readonly ratio: number;
    /** Of them, parents. */
    readonly parents: number;
  };
  readonly sets: CalibrationSetSummary[];
  /** What `items` holds. */
  readonly list: "cohorts" | "samples";
  readonly items: CalibrationCohort[] | CalibrationSample[];
  readonly truncated: boolean;
  readonly nextCursor: string | null;
  readonly missing: Record<string, string>;
}

const SET_SELECTION: Record<EvidenceSet, ReturnType<typeof admitter>> = {
  exact: admitter({ include: ["exact"], exclude: [], excludeReasons: [] }),
  reconstructed: admitter({ include: ["reconstructed"], exclude: [], excludeReasons: [] }),
};

/** Is `member` a sample of `set`: admitted by the set's selection, with a figure and an estimate. */
export function isSample(member: CalibrationMember, set: EvidenceSet): boolean {
  return member.workSeconds !== null && member.estimate.seconds > 0 && SET_SELECTION[set].admits({ work: member.evidence });
}

const keyString = (key: CohortKey): string => JSON.stringify(DIMENSIONS.map((dimension) => key[dimension]));

/** The class of `key` at `level`: dropped dimensions read `*`. */
export function classAt(key: CohortKey, level: number): CohortKey {
  const keeps = LEVELS[level]!.keeps;
  return Object.fromEntries(DIMENSIONS.map((dimension) => [dimension, keeps.includes(dimension) ? key[dimension] : ANY])) as CohortKey;
}

const inClass = (dimensions: CohortKey, klass: CohortKey): boolean => DIMENSIONS.every((dimension) => klass[dimension] === ANY || klass[dimension] === dimensions[dimension]);

/** `1 − 2 · 0.5ⁿ`: how often the range of n samples covers the median, whatever the distribution. */
export function rangeConfidence(n: number): number {
  return n === 0 ? 0 : 1 - 2 * 0.5 ** n;
}

/** The lower median: index `floor((n − 1) / 2)` of the ascending list, the page's quantile method. */
export function lowerMedian(values: readonly number[]): number {
  // Callers guard the empty list.
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

function tally(values: ReadonlyArray<readonly string[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const reasons of values) for (const reason of reasons) out[reason] = (out[reason] ?? 0) + 1;
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => (a < b ? -1 : 1)));
}

function excludedOf(members: readonly CalibrationMember[]): CalibrationExcluded {
  const counts: Partial<Record<WorkState, number>> = {};
  for (const member of members) counts[member.evidence.state] = (counts[member.evidence.state] ?? 0) + 1;
  const ordered = (["exact", "timing-floor", "approximate", "reconstructed", "missing"] as const).filter((state) => counts[state] !== undefined);
  return { count: members.length, counts: Object.fromEntries(ordered.map((state) => [state, counts[state]!])), reasons: tally(members.map((member) => member.evidence.reasons)) };
}

function coverageOf(samples: number, eligible: number): CalibrationCoverage {
  return { samples, eligible, fraction: eligible === 0 ? null : samples / eligible, denominator: "ratio_population" };
}

const byResolution = (a: CalibrationMember, b: CalibrationMember): number => {
  const x = a.completedAt ?? "";
  const y = b.completedAt ?? "";
  return x === y ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : x < y ? -1 : 1;
};

function sampleOf(member: CalibrationMember, set: EvidenceSet): CalibrationSample {
  return {
    set,
    identifier: member.identifier,
    title: member.title,
    completedAt: member.completedAt,
    workSeconds: member.workSeconds!,
    estimate: member.estimate,
    ratio: member.workSeconds! / member.estimate.seconds,
    dimensions: member.dimensions,
    evidence: member.evidence,
  };
}

/**
 * The cohort `key` reads in `set`: the first class along {@link LEVELS} with at least
 * {@link MIN_COHORT_SAMPLES} samples, or the whole set when none has. `population` is every
 * member (samples of the set or not), for coverage and exclusions. Exported so a later reader
 * (an estimate suggestion for one issue) resolves a class exactly as the listing does.
 */
export function resolveCohort(set: EvidenceSet, key: CohortKey, population: readonly CalibrationMember[]): CalibrationCohort {
  const samples = population.filter((member) => isSample(member, set));
  const path: Array<{ level: number; name: string; samples: number }> = [];
  let chosen = LEVELS.length - 1;
  for (const { level, name } of LEVELS) {
    const count = samples.filter((member) => inClass(member.dimensions, classAt(key, level))).length;
    path.push({ level, name, samples: count });
    if (count >= MIN_COHORT_SAMPLES) {
      chosen = level;
      break;
    }
  }
  const klass = classAt(key, chosen);
  const members = samples.filter((member) => inClass(member.dimensions, klass)).sort(byResolution);
  const eligible = population.filter((member) => inClass(member.dimensions, klass));
  const records = members.map((member) => sampleOf(member, set));
  const workTotal = records.reduce((sum, sample) => sum + sample.workSeconds, 0);
  const estimateTotal = records.reduce((sum, sample) => sum + sample.estimate.seconds, 0);
  const n = records.length;
  // A listed cohort has a sample of its own key; a key resolved from elsewhere (an empty set) reads 0.
  const spread = (values: number[], of: (values: number[]) => number): number => (values.length === 0 ? 0 : of(values));
  const ratios = records.map((sample) => sample.ratio);
  const works = records.map((sample) => sample.workSeconds);
  const enough = n >= MIN_COHORT_SAMPLES;
  return {
    set,
    key,
    keySamples: path[0]!.samples,
    level: chosen,
    levelName: LEVELS[chosen]!.name,
    class: klass,
    path,
    fallback: chosen === 0 && enough ? "none" : enough ? "below_minimum" : "below_minimum_everywhere",
    samples: n,
    coverage: coverageOf(n, eligible.length),
    ratio: { median: spread(ratios, lowerMedian), pooled: estimateTotal === 0 ? 0 : workTotal / estimateTotal, min: spread(ratios, (v) => Math.min(...v)), max: spread(ratios, (v) => Math.max(...v)) },
    workSeconds: { median: spread(works, lowerMedian), total: workTotal, min: spread(works, (v) => Math.min(...v)), max: spread(works, (v) => Math.max(...v)) },
    rangeConfidence: rangeConfidence(n),
    estimatedSeconds: { total: estimateTotal },
    estimateSources: { at_start: records.filter((sample) => sample.estimate.source === "at_start").length, current: records.filter((sample) => sample.estimate.source === "current").length },
    members: { total: n, refs: records.slice(0, MEMBER_REFS).map((sample) => sample.identifier), truncated: n > MEMBER_REFS },
    excluded: excludedOf(eligible.filter((member) => !isSample(member, set))),
    warnings: enough ? [] : ["small_sample"],
  };
}

/**
 * The snapshot id: SHA-256 over the algorithm, the repository, the selection (`since` as given), the
 * minimum and every member in id order. A sample contributes its figure, the estimate it divides
 * by (and the current one) and its dimensions; any other member contributes what keeps it out (its state and reasons)
 * and its dimensions, and not its figure, which for an unsettled record can move with `asOf`.
 */
export function snapshotId(input: {
  readonly repositoryId: string | null;
  readonly selection: { readonly kind: readonly string[] | null; readonly priority: readonly string[] | null; readonly parentId: string | null; readonly since: string | null; readonly include: readonly EvidenceSet[] };
  readonly members: readonly CalibrationMember[];
}): string {
  const hash = createHash("sha256");
  hash.update(JSON.stringify([CALIBRATION_ALGORITHM, input.repositoryId, input.selection, MIN_COHORT_SAMPLES]));
  const members = [...input.members].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  for (const member of members) {
    const set = input.selection.include.find((candidate) => isSample(member, candidate)) ?? null;
    const dims = DIMENSIONS.map((dimension) => member.dimensions[dimension]);
    const record =
      set === null
        ? [member.id, null, member.completedAt, member.evidence.state, member.evidence.reasons, dims]
        : [member.id, set, member.completedAt, member.evidence.state, member.evidence.reasons, dims, member.workSeconds, member.estimate.seconds, member.estimate.source, member.estimate.currentSeconds];
    hash.update("\n");
    hash.update(JSON.stringify(record));
  }
  return `${CALIBRATION_ALGORITHM.replace("/", "")}:${hash.digest("hex").slice(0, 32)}`;
}

/** The keyset of a cohort: its set, then its key. */
const cohortPosition = (cohort: CalibrationCohort): KeysetPosition => ({ at: cohort.set, id: keyString(cohort.key) });
/** The keyset of a sample: its set and resolution instant, then its issue's id (as cohort members are ordered). */
const samplePosition = (row: { readonly id: string; readonly sample: CalibrationSample }): KeysetPosition => ({
  at: `${row.sample.set}\u0000${row.sample.completedAt ?? ""}`,
  id: row.id,
});

/** The report over `members` (the ratio population in the filter). */
export function calibrationReport(input: {
  readonly asOf: string;
  readonly filter: CalibrationFilter;
  readonly repositoryId: string | null;
  readonly parentId: string | null;
  /** `since` as the caller gave it: what the snapshot id hashes (a resolved relative one moves with the clock). */
  readonly sinceGiven: string | null;
  readonly population: CalibrationReport["population"];
  readonly members: readonly CalibrationMember[];
  readonly list: "cohorts" | "samples";
  readonly after: KeysetPosition | null;
  readonly limit: number;
  readonly scope: unknown;
}): CalibrationReport {
  const { filter, members } = input;
  const sets: CalibrationSetSummary[] = [];
  const cohorts: CalibrationCohort[] = [];
  /** Every sample with its issue's id, in listing order: by set, then as `byResolution` orders members. */
  const samples: Array<{ id: string; sample: CalibrationSample }> = [];
  for (const set of filter.include) {
    const own = members.filter((member) => isSample(member, set)).sort(byResolution);
    const keys = new Map<string, CohortKey>();
    for (const member of own) keys.set(keyString(member.dimensions), member.dimensions);
    for (const k of [...keys.keys()].sort()) cohorts.push(resolveCohort(set, keys.get(k)!, members));
    for (const member of own) samples.push({ id: member.id, sample: sampleOf(member, set) });
    sets.push({
      set,
      samples: own.length,
      coverage: coverageOf(own.length, members.length),
      excluded: excludedOf(members.filter((member) => !isSample(member, set))),
      cohorts: keys.size,
    });
  }
  const missing: Record<string, string> = {};
  if (members.length === 0) missing.items = "no_eligible_records";
  else if (samples.length === 0) missing.items = "no_samples";
  const snapshot = {
    id: snapshotId({
      repositoryId: input.repositoryId,
      selection: { kind: filter.kind, priority: filter.priority, parentId: input.parentId, since: input.sinceGiven, include: filter.include },
      members,
    }),
    algorithm: CALIBRATION_ALGORITHM,
    repositoryId: input.repositoryId,
    members: members.length,
    samples: Object.fromEntries(sets.map((summary) => [summary.set, summary.samples])),
  };
  const method = { minSamples: MIN_COHORT_SAMPLES, levels: LEVELS.map((level) => level.name), median: "lower" as const, estimate: "at_start_else_current" as const };
  const base = { asOf: input.asOf, filter, snapshot, method, population: input.population, sets, list: input.list, missing };
  if (input.list === "samples") {
    const page = cutPage(
      samples.filter((row) => afterPosition(samplePosition(row), input.after)),
      input.limit,
      "calibration_samples",
      input.scope,
      samplePosition,
    );
    return { ...base, items: page.items.map((row) => row.sample), truncated: page.truncated, nextCursor: page.nextCursor };
  }
  const page = cutPage(
    cohorts.filter((cohort) => afterPosition(cohortPosition(cohort), input.after)),
    input.limit,
    "calibration_cohorts",
    input.scope,
    cohortPosition,
  );
  return { ...base, items: page.items, truncated: page.truncated, nextCursor: page.nextCursor };
}
