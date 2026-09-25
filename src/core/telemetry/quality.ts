/**
 * Quality states (docs/timing-semantics.md, "Quality states"): exactly one state per record
 * that carries a timing or budget figure, and the machine-readable reasons that produced it.
 *
 * The state set is closed: `exact`, `approximate`, `missing`, `timing-floor`, `reconstructed`
 * and `provider-unavailable`. Each record type uses the subset that can apply to it:
 *
 *   - an issue's `workSeconds`: `missing` > `reconstructed` > `approximate` > `timing-floor` >
 *     `exact`, from replicated inputs only (null for a cancelled issue, which owes no work);
 *   - an issue's `wall`: `missing` > `approximate` > `exact`, from device-local inputs;
 *   - an attempt's `effortSeconds`: `reconstructed` > `approximate` > `timing-floor` > `exact`
 *     (an attempt always has a figure, so it is never `missing`);
 *   - a budget sample, limit reading, window burn, limit burn or attempt burn:
 *     `provider-unavailable` or `missing` when its figure is null (which one is decided by the
 *     figure's reason code), otherwise `approximate` > `exact`.
 *
 * `reasons` lists every reason that holds, highest precedence first, so the state is always
 * the level of `reasons[0]` (or `exact` when the list is empty). A lower-precedence reason is
 * kept: a sparse attempt below 60 seconds reads `approximate` with
 * `["sparse", "timing_floor"]`, and an analytics consumer can see both.
 *
 * This is the ONE place the precedence is written. The store, the attempt reads, the budget
 * reads and the cohort read all call it, so every surface answers the same state.
 */

export type QualityState = "exact" | "approximate" | "missing" | "timing-floor" | "reconstructed" | "provider-unavailable";

/** Every state, in the order reads list their counts. */
export const QUALITY_STATES: readonly QualityState[] = ["exact", "timing-floor", "approximate", "reconstructed", "missing", "provider-unavailable"];

/** The states an issue's work figure can take, highest precedence first. */
export const WORK_STATES = ["missing", "reconstructed", "approximate", "timing-floor", "exact"] as const;
export type WorkState = (typeof WORK_STATES)[number];

/** The states an issue's wall figure can take. */
export type WallState = "missing" | "approximate" | "exact";

/** `timing-floor`: a figure below this many seconds fits inside the write cadence the measure resolves. */
export const TIMING_FLOOR_SECONDS = 60;

/** The reason code of `timing-floor`. */
export const TIMING_FLOOR = "timing_floor";
/** The reason code of `reconstructed`. */
export const RECONSTRUCTED = "reconstructed";

export interface Quality<S extends string = QualityState> {
  readonly state: S;
  /** Every reason that holds, highest precedence first. Empty exactly when the state is `exact`. */
  readonly reasons: string[];
}

export function isQualityState(value: string): value is QualityState {
  return (QUALITY_STATES as readonly string[]).includes(value);
}

/**
 * An issue's work state (docs/timing-semantics.md, "Quality inputs"). `missingReason` is the
 * `missing.workSeconds` code when the figure is null; `inputs` are the approximate inputs.
 */
export function workQuality(input: {
  readonly workSeconds: number | null;
  readonly missingReason: string | null;
  readonly reconstructed: boolean;
  readonly inputs: readonly string[];
}): Quality<WorkState> {
  const reasons: string[] = [];
  if (input.workSeconds === null) reasons.push(input.missingReason ?? "input_missing");
  if (input.reconstructed) reasons.push(RECONSTRUCTED);
  reasons.push(...[...input.inputs].sort());
  if (input.workSeconds !== null && input.workSeconds < TIMING_FLOOR_SECONDS) reasons.push(TIMING_FLOOR);
  let state: WorkState;
  if (input.workSeconds === null) state = "missing";
  else if (input.reconstructed) state = "reconstructed";
  else if (input.inputs.length > 0) state = "approximate";
  else if (input.workSeconds < TIMING_FLOOR_SECONDS) state = "timing-floor";
  else state = "exact";
  return { state, reasons };
}

/** An issue's wall state: `missing` when there is no `wall` (with its reason), else approximate on any input. */
export function wallQuality(input: { readonly present: boolean; readonly missingReason: string | null; readonly inputs: readonly string[] }): Quality<WallState> {
  if (!input.present) return { state: "missing", reasons: [input.missingReason ?? "input_missing"] };
  const reasons = [...input.inputs].sort();
  return { state: reasons.length > 0 ? "approximate" : "exact", reasons };
}

/** One attempt's state, over its contribution to the issue's effort (`effortSeconds`). */
export function attemptQuality(input: { readonly seconds: number; readonly provenance: string; readonly inputs: readonly string[] }): Quality<Exclude<WorkState, "missing">> {
  const reconstructed = input.provenance === "reconstructed";
  const { state, reasons } = workQuality({ workSeconds: input.seconds, missingReason: null, reconstructed, inputs: input.inputs });
  return { state: state as Exclude<WorkState, "missing">, reasons };
}

// ------------------------------------------------------------------------------- budget

/**
 * Reasons that say the PROVIDER does not expose the figure: no capture on this machine could
 * fill it. Every other reason for a null budget figure is a gap in capture (`missing`): nothing
 * ingested yet, a stale reading, a window that elapsed, an attempt opened on another device,
 * no ingestion path configured here (`source_unavailable`, which is this machine's
 * configuration, not the provider's).
 */
export const PROVIDER_UNAVAILABLE_REASONS: ReadonlySet<string> = new Set([
  "not_reported_by_source",
  "not_subscriber",
  "sliding_window",
  "limit_not_published",
  "unit_not_normalizable",
  "reset_not_reported",
]);

export type BudgetState = "provider-unavailable" | "missing" | "approximate" | "exact";

/** The state of a null budget figure, from its reason code. */
function unknownFigure(reason: string | undefined): Quality<BudgetState> {
  const code = reason ?? "input_missing";
  return { state: PROVIDER_UNAVAILABLE_REASONS.has(code) ? "provider-unavailable" : "missing", reasons: [code] };
}

function known(reasons: string[]): Quality<BudgetState> {
  return { state: reasons.length > 0 ? "approximate" : "exact", reasons };
}

/** What a sample's state reads. */
interface SampleLike {
  readonly usedPercent: number | null;
  readonly remainingPercent: number | null;
  readonly method: string;
  readonly confidence: string;
  readonly windowId: string | null;
  readonly missing: Readonly<Record<string, string>>;
}

/** The provenance reasons of a reading: estimated, low confidence, no reset instant. */
function readingReasons(sample: SampleLike): string[] {
  const reasons: string[] = [];
  if (sample.method === "estimated") reasons.push("estimated");
  if (sample.confidence === "low") reasons.push("low_confidence");
  if (sample.windowId === null) reasons.push(sample.missing.windowId ?? "reset_not_reported");
  return reasons;
}

/**
 * A stored sample. Its figure is the normalized `remainingPercent` (the reading as a budget):
 * null when the provider reported no value or publishes no limit to normalize against.
 * Known: approximate when `estimated`, `low` confidence, or it joined no window because the
 * source gave no reset (`reset_not_reported`).
 */
export function sampleQuality(sample: SampleLike): Quality<BudgetState> {
  if (sample.usedPercent === null) return unknownFigure(sample.missing.usedPercent);
  if (sample.remainingPercent === null) return unknownFigure(sample.missing.remainingPercent);
  return known(readingReasons(sample));
}

/** A limit's current reading (`get_budget`): its figure is `remainingPercent`. */
export function limitReadingQuality(reading: {
  readonly remainingPercent: number | null;
  readonly stale: boolean | null;
  readonly latestSample: SampleLike | null;
  readonly missing: Readonly<Record<string, string>>;
}): Quality<BudgetState> {
  if (reading.remainingPercent === null) return unknownFigure(reading.missing.remainingPercent);
  const reasons: string[] = [];
  if (reading.stale === true) reasons.push("stale");
  if (reading.latestSample !== null) reasons.push(...readingReasons(reading.latestSample).filter((reason) => reason !== "reset_not_reported"));
  return known(reasons);
}

/** One window instance's part of a burn: its figure is `deltaPercent`. */
export function windowBurnQuality(burn: { readonly deltaPercent: number | null; readonly lowerBound: boolean; readonly missing: Readonly<Record<string, string>> }): Quality<BudgetState> {
  if (burn.deltaPercent === null) return unknownFigure(burn.missing.deltaPercent);
  return known(burn.lowerBound ? ["lower_bound"] : []);
}

/** One limit's burn over an attempt: its figure is `burnPercent`. */
export function limitBurnQuality(burn: {
  readonly burnPercent: number | null;
  readonly lowerBound: boolean;
  readonly partial: boolean;
  readonly missing: Readonly<Record<string, string>>;
}): Quality<BudgetState> {
  if (burn.burnPercent === null) return unknownFigure(burn.missing.burnPercent);
  const reasons: string[] = [];
  if (burn.lowerBound) reasons.push("lower_bound");
  if (burn.partial) reasons.push("partial");
  return known(reasons);
}

/**
 * An attempt's whole burn: the per-limit burns taken together. Unknown when no limit has a
 * figure: the reason of the burn itself (`limits`), else of its limits, a provider reason only
 * when every limit is provider-unavailable. Known: approximate when any limit is approximate
 * or unknown (`partial`), or the attribution is not known to be sole.
 */
export function attemptBurnQuality(burn: {
  readonly limits: ReadonlyArray<{ readonly burnPercent: number | null; readonly quality: Quality<BudgetState> }>;
  readonly attribution: string | null;
  readonly missing: Readonly<Record<string, string>>;
}): Quality<BudgetState> {
  const knownLimits = burn.limits.filter((limit) => limit.burnPercent !== null);
  if (knownLimits.length === 0) {
    if (burn.limits.length === 0) return unknownFigure(burn.missing.limits);
    const provider = burn.limits.every((limit) => limit.quality.state === "provider-unavailable");
    const reasons = [...new Set(burn.limits.flatMap((limit) => limit.quality.reasons))].sort();
    return { state: provider ? "provider-unavailable" : "missing", reasons };
  }
  const reasons = new Set<string>();
  for (const limit of knownLimits) for (const reason of limit.quality.reasons) reasons.add(reason);
  if (knownLimits.length < burn.limits.length) reasons.add("partial");
  if (burn.attribution !== "sole_known") reasons.add(burn.attribution === "shared" ? "shared" : "attribution_unknown");
  return known([...reasons].sort());
}
