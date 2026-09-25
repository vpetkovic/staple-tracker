/**
 * Calibration cohorts (`docs/timing-semantics.md`, "Calibration cohorts"): trusted samples by
 * default, reconstructed history only as its own set, the dimensions, the fallback to broader
 * classes, coverage with a named denominator, the estimate a sample divides by, and a snapshot
 * identity that follows the data and nothing else.
 *
 * Every history is written by real store calls at instants this suite controls (the write clock
 * is faked, `Date` only). No issue, attempt or event row is written by hand, except the one
 * legacy checkout event an older build narrated, which `staple attempt reconstruct` reads.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDb, tx } from "../src/core/db.js";
import { writeEventRow } from "../src/core/event-row.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import {
  LEVELS,
  MIN_COHORT_SAMPLES,
  labelDimension,
  lowerMedian,
  modelDimension,
  snapshotId,
  type CalibrationCohort,
  type CalibrationMember,
  type CalibrationSample,
} from "../src/core/telemetry/calibration.js";
import { StapleError } from "../src/core/types.js";

const T0 = Date.parse("2026-09-01T09:00:00.000Z");
const iso = (minutes: number): string => new Date(T0 + minutes * 60_000).toISOString();
const at = (minutes: number): void => void vi.setSystemTime(T0 + minutes * 60_000);
const min = (n: number): number => n * 60;

let store: WorkspaceStore;
let home: string;
const previousHome = process.env.STAPLE_HOME;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(0);
  home = mkdtempSync(join(tmpdir(), "staple-calibration-home-"));
  process.env.STAPLE_HOME = home;
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.STAPLE_HOME;
  else process.env.STAPLE_HOME = previousHome;
});

function refusal(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    if (error instanceof StapleError) return error;
    throw error;
  }
  throw new Error("expected a refusal");
}

let clock = 0;
/** The next free minute: every history is written after the one before it. */
const next = (span: number): number => {
  const from = clock;
  clock += span + 1;
  return from;
};

interface Worked {
  /** `null`: no estimate. Default 2h. */
  estimate?: number | null;
  minutes?: number;
  kind?: string;
  priority?: "critical" | "high" | "medium" | "low";
  labels?: string[];
  model?: string;
  parent?: string;
  /** Minutes between comments: 10 keeps the work exact; `null` leaves it silent (sparse past 30). */
  every?: number | null;
  reestimate?: number;
}

/** A leaf worked from checkout to done, commenting as it goes. */
function worked(title: string, opts: Worked = {}): string {
  const minutes = opts.minutes ?? 20;
  const from = next(minutes);
  at(from);
  const issue = store.createIssue({
    title,
    ...(opts.estimate === null ? {} : { estimatedSeconds: opts.estimate ?? min(120) }),
    ...(opts.kind ? { kind: opts.kind } : {}),
    ...(opts.priority ? { priority: opts.priority } : {}),
    ...(opts.labels ? { labels: opts.labels } : {}),
    ...(opts.parent ? { parent: opts.parent } : {}),
  });
  store.checkoutIssue(issue.id, "w", undefined, opts.model ? { attempt: { harness: "claude_code", model: opts.model } } : {});
  const every = opts.every === undefined ? 10 : opts.every;
  if (every !== null) {
    for (let m = from + every; m < from + minutes; m += every) {
      at(m);
      store.addComment(issue.id, "progress", "w", "agent");
    }
  }
  if (opts.reestimate !== undefined) store.setEstimate(issue.id, opts.reestimate, "w");
  at(from + minutes);
  store.updateIssue(issue.id, { status: "done" }, "w");
  return issue.id;
}

/** A leaf an older build worked (a narrated checkout, no attempt), rebuilt later by reconstruct. */
function legacy(title: string, opts: { minutes?: number; estimate?: number; comments?: boolean } = {}): string {
  const minutes = opts.minutes ?? 20;
  const from = next(minutes);
  at(from);
  const id = store.createIssue({ title, estimatedSeconds: opts.estimate ?? min(120) }).id;
  tx(store.db, () => writeEventRow(store.db, { kind: "checkout", issueId: id, actor: "old", payload: {}, createdAt: iso(from), dedupKey: `legacy-${id}` }));
  if (opts.comments !== false) {
    for (let m = from + 10; m < from + minutes; m += 10) {
      at(m);
      store.addComment(id, "progress", "old", "agent");
    }
  }
  at(from + minutes);
  store.updateIssue(id, { status: "done" }, "old");
  return id;
}

const ident = (id: string): string => store.getIssue(id).identifier;
const cohorts = (report: { items: unknown[] }): CalibrationCohort[] => report.items as CalibrationCohort[];
const samples = (report: { items: unknown[] }): CalibrationSample[] => report.items as CalibrationSample[];
const readAt = (minutes: number, query: Parameters<WorkspaceStore["calibration"]>[0] = {}) => store.calibration({ limit: 500, ...query }, iso(minutes));

beforeEach(() => {
  clock = 0;
});

// ------------------------------------------------------------------ samples

describe("trusted samples by default", () => {
  it("samples exact records only; approximate, timing-floor, missing and reconstructed are counted as excluded", () => {
    const exact = worked("exact");
    const sparse = worked("sparse", { minutes: 45, every: null });
    const floor = worked("floor", { minutes: 0.5 });
    at(next(1));
    const never = store.createIssue({ title: "never started", estimatedSeconds: min(30) }).id;
    store.updateIssue(never, { status: "done" }, "w");
    const recon = legacy("recon");
    at(next(1));
    expect(store.reconstructAttemptHistory().reconstructed).toBe(1);
    // An unestimated done leaf is not in the population at all.
    at(next(1));
    const unestimated = store.createIssue({ title: "no estimate" }).id;
    store.updateIssue(unestimated, { status: "done" }, "w");

    const report = readAt(clock + 1, { list: "samples" });
    expect(report.population.ratio).toBe(5);
    expect(report.sets).toHaveLength(1);
    const [set] = report.sets;
    expect(set!.set).toBe("exact");
    expect(set!.samples).toBe(1);
    expect(set!.coverage).toEqual({ samples: 1, eligible: 5, fraction: 0.2, denominator: "ratio_population" });
    expect(set!.excluded.counts).toEqual({ "timing-floor": 1, approximate: 1, reconstructed: 1, missing: 1 });
    expect(set!.excluded.reasons).toEqual({ sparse: 1, timing_floor: 1, reconstructed: 1, never_started: 1 });
    expect(samples(report).map((sample) => sample.identifier)).toEqual([ident(exact)]);
    const [sample] = samples(report);
    expect(sample!.workSeconds).toBe(min(20));
    expect(sample!.ratio).toBeCloseTo(20 / 120, 6);
    expect(sample!.evidence).toEqual({ state: "exact", reasons: [], workerAttempts: 1, provenance: ["recorded"], harnessSupplied: 0 });
    for (const id of [sparse, floor, never, recon, unestimated]) expect(samples(report).map((s) => s.identifier)).not.toContain(ident(id));
  });

  it("reconstructed history is its own set, with its own cohorts, only when asked for, and never pooled with exact", () => {
    const exact = worked("exact");
    const recon = legacy("recon");
    legacy("recon sparse", { minutes: 50, comments: false });
    at(next(1));
    store.reconstructAttemptHistory();

    const plain = readAt(clock + 1);
    const both = readAt(clock + 1, { include: ["reconstructed"] });
    expect(both.sets.map((set) => [set.set, set.samples])).toEqual([
      ["exact", 1],
      ["reconstructed", 1],
    ]);
    // The exact set reads the same with or without the reconstructed one beside it.
    expect(both.sets[0]).toEqual(plain.sets[0]);
    expect(cohorts(both).map((cohort) => [cohort.set, cohort.samples, cohort.members.refs])).toEqual([
      ["exact", 1, [ident(exact)]],
      ["reconstructed", 1, [ident(recon)]],
    ]);
    // A reconstructed record that is also sparse is not a sample of either set.
    expect(both.sets[1]!.excluded.counts).toEqual({ exact: 1, reconstructed: 1 });
    expect(both.sets[1]!.excluded.reasons).toEqual({ reconstructed: 1, sparse: 1 });
    // The sample says it divides by the current estimate: a reconstructed attempt read none.
    const reconSample = samples(readAt(clock + 1, { include: ["reconstructed"], list: "samples" })).find((sample) => sample.set === "reconstructed")!;
    expect(reconSample.estimate).toEqual({ seconds: min(120), source: "current", atStartSeconds: null, currentSeconds: min(120), missing: { atStart: "not_recorded" } });
    expect(reconSample.evidence.provenance).toEqual(["reconstructed"]);
  });

  it("refuses to take approximate, timing-floor or missing records as a set, and an unknown list, priority or kind", () => {
    for (const set of ["approximate", "timing-floor", "missing", "all"]) {
      const error = refusal(() => store.calibration({ include: [set] }));
      expect(error.code).toBe("validation");
      expect(error.message).toContain("never calibration samples");
    }
    expect(refusal(() => store.calibration({ list: "everything" })).message).toContain("list takes cohorts or samples");
    expect(refusal(() => store.calibration({ priority: ["urgent"] })).code).toBe("validation");
    expect(refusal(() => store.calibration({ kind: ["nonsense"] })).code).toBe("validation");
  });
});

// ------------------------------------------------------------------ the estimate

describe("the estimate a sample divides by", () => {
  it("is the first worker attempt's estimate at start, so a re-estimate after the start cannot flatter the ratio", () => {
    const id = worked("re-estimated", { estimate: min(60), reestimate: min(20) });
    const [sample] = samples(readAt(clock + 1, { list: "samples" }));
    expect(sample!.identifier).toBe(ident(id));
    expect(sample!.estimate).toEqual({ seconds: min(60), source: "at_start", atStartSeconds: min(60), currentSeconds: min(20), missing: {} });
    expect(sample!.ratio).toBeCloseTo(20 / 60, 6);
    // The issue's own estimateRatio still divides by the current estimate: the two are stated apart.
    expect(store.timingFor([id], iso(clock + 1)).get(id)!.estimateRatio).toBeCloseTo(1, 6);
    expect(cohorts(readAt(clock + 1))[0]!.estimateSources).toEqual({ at_start: 1, current: 0 });
  });

  it("a parent data point reads its model and evidence from the attempts behind its work: no cancelled child, no non-leaf's own attempt", () => {
    at(next(1));
    const parent = store.createIssue({ title: "parent", estimatedSeconds: min(90) }).id;
    const middle = store.createIssue({ title: "middle", parent }).id;
    // A non-leaf's own attempt (Q5: never in workSeconds): the middle parent checked out by m3.
    at(next(5));
    store.checkoutIssue(middle, "mid", undefined, { attempt: { harness: "claude_code", model: "m3" } });
    at(clock);
    store.releaseIssue(middle, "mid");
    // Unestimated children leave the parent's own estimate the only one in its subtree.
    worked("counted", { parent: middle, estimate: null, model: "m1" });
    // Worked by m2 and then cancelled: the rollup skips it, so must calibration.
    const from = next(20);
    at(from);
    const dropped = store.createIssue({ title: "dropped", parent }).id;
    store.checkoutIssue(dropped, "w2", undefined, { attempt: { harness: "claude_code", model: "m2" } });
    at(from + 10);
    store.addComment(dropped, "progress", "w2", "agent");
    at(from + 20);
    store.updateIssue(dropped, { status: "cancelled" }, "w2");
    at(next(1));
    store.updateIssue(middle, { status: "done" }, "w");
    store.updateIssue(parent, { status: "done" }, "w");
    const report = readAt(clock + 1, { list: "samples" });
    expect(report.population.parents).toBe(1);
    const sample = samples(report).find((s) => s.identifier === ident(parent))!;
    expect(sample.workSeconds).toBe(min(20));
    expect(sample.dimensions.model).toBe("m1");
    expect(sample.evidence).toMatchObject({ workerAttempts: 1, provenance: ["recorded"], harnessSupplied: 1 });
    expect(sample.estimate).toEqual({ seconds: min(90), source: "current", atStartSeconds: null, currentSeconds: min(90), missing: { atStart: "parent" } });
  });

  it("a parent data point divides by its current estimate even when its own brief attempt read another", () => {
    at(next(1));
    const parent = store.createIssue({ title: "parent", estimatedSeconds: min(90) }).id;
    // Briefly checked out at 90m (an own attempt Q5 keeps out of workSeconds), re-estimated to 30m.
    store.checkoutIssue(parent, "lead");
    at(next(1));
    store.releaseIssue(parent, "lead");
    store.setEstimate(parent, min(30), "lead");
    worked("child", { parent, estimate: null });
    at(next(1));
    store.updateIssue(parent, { status: "done" }, "w");
    const sample = samples(readAt(clock + 1, { list: "samples" })).find((s) => s.identifier === ident(parent))!;
    expect(sample.estimate).toEqual({ seconds: min(30), source: "current", atStartSeconds: null, currentSeconds: min(30), missing: { atStart: "parent" } });
    expect(sample.evidence.workerAttempts).toBe(1);
  });

  it("a parent data point never takes a child's reading: a child estimated at checkout, its estimate cleared later", () => {
    at(next(1));
    const parent = store.createIssue({ title: "parent", estimatedSeconds: min(90) }).id;
    // The child's attempt reads the child's own 45m; clearing it leaves the parent the only estimate.
    const child = worked("child", { parent, estimate: min(45) });
    store.setEstimate(child, null, "w");
    at(next(1));
    store.updateIssue(parent, { status: "done" }, "w");
    const report = readAt(clock + 1, { list: "samples" });
    expect(report.population.ratio).toBe(1);
    const sample = samples(report).find((s) => s.identifier === ident(parent))!;
    expect(sample.evidence.workerAttempts).toBe(1);
    expect(sample.estimate).toEqual({ seconds: min(90), source: "current", atStartSeconds: null, currentSeconds: min(90), missing: { atStart: "parent" } });
  });

  it("takes the first attempt with an own reading: a reconstructed first attempt read none", () => {
    const from = next(40);
    at(from);
    const id = store.createIssue({ title: "resumed", estimatedSeconds: min(120) }).id;
    // An older build's checkout and release, rebuilt by reconstruct: an attempt with no reading.
    tx(store.db, () => writeEventRow(store.db, { kind: "checkout", issueId: id, actor: "old", payload: {}, createdAt: iso(from), dedupKey: `legacy-co-${id}` }));
    at(from + 10);
    store.addComment(id, "progress", "old", "agent");
    tx(store.db, () => writeEventRow(store.db, { kind: "release", issueId: id, actor: "old", payload: {}, createdAt: iso(from + 20), dedupKey: `legacy-rel-${id}` }));
    at(from + 21);
    expect(store.reconstructAttemptHistory().reconstructed).toBe(1);
    // Captured from here: the attempt reads 2h, and a re-estimate after it started cannot flatter it.
    store.checkoutIssue(id, "w");
    store.setEstimate(id, min(60), "w");
    at(from + 30);
    store.addComment(id, "progress", "w", "agent");
    at(from + 40);
    store.updateIssue(id, { status: "done" }, "w");
    const sample = samples(readAt(clock + 1, { include: ["reconstructed"], list: "samples" })).find((s) => s.identifier === ident(id));
    expect(sample, JSON.stringify(store.timingFor([id], iso(clock + 1)).get(id)!.quality.work)).toBeDefined();
    expect(sample!.set).toBe("reconstructed");
    expect(sample!.evidence.provenance).toEqual(["reconstructed", "recorded"]);
    expect(sample!.estimate).toEqual({ seconds: min(120), source: "at_start", atStartSeconds: min(120), currentSeconds: min(60), missing: {} });
  });
});

// ------------------------------------------------------------------ dimensions

describe("the dimensions", () => {
  it("reads work type and area from labels, model from the attempts' harness, and unknown when there is none", () => {
    expect(labelDimension(["Type:Feature", "area:cloud", "bug"], "type:")).toBe("feature");
    expect(labelDimension(["area:ui", "area:cloud", "area:ui", "area: "], "area:")).toBe("cloud+ui");
    expect(labelDimension([], "area:")).toBe("unknown");
    expect(modelDimension([])).toBe("unknown");
    expect(modelDimension(["opus", "opus"])).toBe("opus");
    expect(modelDimension(["sonnet", null, "opus"])).toBe("opus+sonnet+unknown");

    const id = worked("labelled", { kind: "bug", priority: "low", labels: ["type:fix", "area:sync"], model: "opus" });
    const [sample] = samples(readAt(clock + 1, { list: "samples" }));
    expect(sample!.identifier).toBe(ident(id));
    expect(sample!.dimensions).toEqual({ kind: "bug", priority: "low", workType: "fix", area: "sync", model: "opus" });
    expect(sample!.evidence.harnessSupplied).toBe(1);
  });
});

// ------------------------------------------------------------------ the fallback

describe("sparse cohorts fall back to broader classes", () => {
  it("drops model, then area, then work type, then priority, then kind, and reports the path", () => {
    expect(LEVELS.map((level) => level.name)).toEqual(["full", "without_model", "without_area", "without_work_type", "kind", "all"]);
    expect(MIN_COHORT_SAMPLES).toBe(5);
    // Five task/high/fix/sync samples: three by opus, two by sonnet.
    for (let i = 0; i < 3; i += 1) worked(`opus ${i}`, { priority: "high", labels: ["type:fix", "area:sync"], model: "opus", minutes: 20 + i * 10 });
    for (let i = 0; i < 2; i += 1) worked(`sonnet ${i}`, { priority: "high", labels: ["type:fix", "area:sync"], model: "sonnet", minutes: 60 });
    // One bug alone in its kind; four more tasks elsewhere make eleven samples.
    worked("lonely bug", { kind: "bug", priority: "low" });
    // A sparse bug: in the population, never a sample, and outside every task class.
    worked("sparse bug", { kind: "bug", priority: "low", minutes: 45, every: null });
    for (let i = 0; i < 5; i += 1) worked(`plain ${i}`, { priority: "medium" });

    const report = readAt(clock + 1);
    const byModel = (model: string, kind = "task") => cohorts(report).find((cohort) => cohort.key.model === model && cohort.key.kind === kind)!;
    const opus = byModel("opus");
    expect(opus.keySamples).toBe(3);
    expect(opus.level).toBe(1);
    expect(opus.levelName).toBe("without_model");
    expect(opus.fallback).toBe("below_minimum");
    expect(opus.class).toEqual({ kind: "task", priority: "high", workType: "fix", area: "sync", model: "*" });
    expect(opus.path).toEqual([
      { level: 0, name: "full", samples: 3, floors: 0 },
      { level: 1, name: "without_model", samples: 5, floors: 0 },
    ]);
    expect(opus.samples).toBe(5);
    // The class's coverage names its denominator: the eligible issues in the class.
    expect(opus.coverage).toEqual({ samples: 5, eligible: 5, fraction: 1, denominator: "ratio_population" });
    // Work 20, 30, 40, 60, 60 minutes over 2h each: the lower median is the third.
    expect(opus.workSeconds.median).toBe(min(40));
    expect(opus.ratio.median).toBeCloseTo(40 / 120, 6);
    expect(opus.ratio.pooled).toBeCloseTo(210 / 600, 6);
    // The sample range: at n = 5 it covers the median with probability 1 - 2 * 0.5^5.
    expect(opus.ratio.min).toBeCloseTo(20 / 120, 6);
    expect(opus.ratio.max).toBeCloseTo(60 / 120, 6);
    expect(opus.workSeconds).toMatchObject({ median: min(40), total: min(210), min: min(20), max: min(60) });
    expect(opus.rangeConfidence).toBe(0.9375);
    // Its exclusions are its class's: the sparse bug is outside task/high/fix/sync.
    expect(opus.excluded).toEqual({ count: 0, counts: {}, reasons: {} });
    expect(report.sets[0]!.excluded.count).toBe(1);
    expect(byModel("sonnet").class).toEqual(opus.class);

    const plain = cohorts(report).find((cohort) => cohort.key.priority === "medium")!;
    expect(plain.level).toBe(0);
    expect(plain.fallback).toBe("none");
    expect(plain.path).toEqual([{ level: 0, name: "full", samples: 5, floors: 0 }]);

    // The bug is alone in kind bug: it reads the whole set.
    const bug = byModel("unknown", "bug");
    expect(bug.path.map((step) => step.samples)).toEqual([1, 1, 1, 1, 1, 11]);
    expect(bug.levelName).toBe("all");
    expect(bug.class).toEqual({ kind: "*", priority: "*", workType: "*", area: "*", model: "*" });
    expect(bug.samples).toBe(11);
    expect(bug.coverage).toEqual({ samples: 11, eligible: 12, fraction: 11 / 12, denominator: "ratio_population" });
    expect(bug.excluded).toEqual({ count: 1, counts: { approximate: 1 }, reasons: { sparse: 1 } });
    // Enough samples for the median, too few for bounds at 90%, and read from a broader class.
    expect(bug.warnings).toEqual(["bounds_below_confidence", "quantile_below_confidence", "fallback_used"]);
    expect(bug.rangeConfidence).toBeCloseTo(1 - 2 * 0.5 ** 11, 12);
  });

  it("says so when not even the whole set has enough", () => {
    worked("one");
    worked("two", { kind: "bug" });
    const [first] = cohorts(readAt(clock + 1));
    expect(first!.levelName).toBe("all");
    expect(first!.fallback).toBe("below_minimum_everywhere");
    expect(first!.samples).toBe(2);
    expect(first!.warnings).toEqual(["small_sample", "bounds_below_confidence", "quantile_below_confidence", "fallback_used"]);
  });

  it("filters by kind, priority, parent and since before any cohort is formed", () => {
    worked("task high", { priority: "high" });
    const bug = worked("bug", { kind: "bug", priority: "high" });
    const later = clock;
    worked("task low", { priority: "low" });
    expect(readAt(clock + 1, { kind: ["bug"] }).population.ratio).toBe(1);
    expect(cohorts(readAt(clock + 1, { kind: ["bug"] }))[0]!.members.refs).toEqual([ident(bug)]);
    expect(readAt(clock + 1, { priority: ["high"] }).population.ratio).toBe(2);
    expect(readAt(clock + 1, { since: iso(later) }).population.ratio).toBe(1);
    at(next(1));
    const epic = store.createIssue({ title: "epic", kind: "epic" }).id;
    const beneath = worked("beneath", { parent: epic });
    expect(cohorts(readAt(clock + 1, { parent: ident(epic) })).flatMap((cohort) => cohort.members.refs)).toEqual([ident(beneath)]);
  });

  it("lists cohorts and samples bounded and keyset-cursored", () => {
    for (let i = 0; i < 3; i += 1) worked(`k${i}`, { priority: (["high", "low", "medium"] as const)[i] });
    const first = store.calibration({ limit: 2 }, iso(clock + 1));
    expect(first.items).toHaveLength(2);
    expect(first.truncated).toBe(true);
    const second = store.calibration({ limit: 2, cursor: first.nextCursor! }, iso(clock + 1));
    expect(second.items).toHaveLength(1);
    expect(second.truncated).toBe(false);
    expect([...cohorts(first), ...cohorts(second)].map((cohort) => cohort.key.priority)).toEqual(["high", "low", "medium"]);
    expect(refusal(() => store.calibration({ limit: 2, cursor: first.nextCursor!, list: "samples" }, iso(clock + 1))).code).toBe("validation");
    const s1 = store.calibration({ limit: 2, list: "samples" }, iso(clock + 1));
    const s2 = store.calibration({ limit: 2, list: "samples", cursor: s1.nextCursor! }, iso(clock + 1));
    expect([...samples(s1), ...samples(s2)].map((sample) => sample.title)).toEqual(["k0", "k1", "k2"]);
  });

  it("the lower median is the value at floor((n - 1) / 2)", () => {
    expect(lowerMedian([4, 1, 3, 2])).toBe(2);
    expect(lowerMedian([5, 1, 3])).toBe(3);
    expect(lowerMedian([7])).toBe(7);
  });
});

// ------------------------------------------------------------------ snapshot identity

describe("snapshot identity", () => {
  it("is the same for the same data at any later instant, and changes with a sample, a dimension or the selection", () => {
    const id = worked("a", { model: "opus" });
    worked("b");
    const first = readAt(clock + 1);
    expect(first.snapshot).toMatchObject({ algorithm: "calibration/2", repositoryId: null, members: 2, samples: { exact: 2 } });
    expect(first.snapshot.id).toMatch(/^calibration2:[0-9a-f]{32}$/);
    // A later read of the same data, a page of it, and a sample listing: one identity.
    expect(readAt(clock + 500).snapshot.id).toBe(first.snapshot.id);
    expect(readAt(clock + 1, { limit: 1 }).snapshot.id).toBe(first.snapshot.id);
    expect(readAt(clock + 1, { list: "samples" }).snapshot.id).toBe(first.snapshot.id);
    // The selection is part of it.
    expect(readAt(clock + 1, { include: ["reconstructed"] }).snapshot.id).not.toBe(first.snapshot.id);
    expect(readAt(clock + 1, { priority: ["medium"] }).snapshot.id).not.toBe(first.snapshot.id);
    // A dimension changes it.
    at(clock + 2);
    store.updateIssue(id, { labels: ["area:ui"] }, "w");
    const relabelled = readAt(clock + 3);
    expect(relabelled.snapshot.id).not.toBe(first.snapshot.id);
    // So does the estimate.
    store.setEstimate(id, min(30), "w");
    expect(readAt(clock + 3).snapshot.id).not.toBe(relabelled.snapshot.id);
  });

  it("does not move with the clock under a relative since", () => {
    worked("a");
    worked("b");
    const first = readAt(clock + 1, { since: "400d" });
    const later = readAt(clock + 90, { since: "400d" });
    expect(later.filter.since).not.toBe(first.filter.since);
    expect(later.population.ratio).toBe(2);
    expect(later.snapshot.id).toBe(first.snapshot.id);
    // An instant names another selection, even over the same members.
    expect(readAt(clock + 1, { since: iso(0) }).snapshot.id).not.toBe(first.snapshot.id);
  });

  it("covers what keeps a non-sample out, which a cohort reading the whole set reports", () => {
    worked("kept", { labels: ["area:ui"] });
    worked("sparse", { labels: ["area:ui"], minutes: 45, every: null });
    worked("elsewhere", { kind: "bug", minutes: 0.5 });
    const report = readAt(clock + 1);
    const ui = cohorts(report).find((cohort) => cohort.key.area === "ui")!;
    // Two samples short of the minimum: it reads the whole set, and so its exclusions are the set's.
    expect(ui.levelName).toBe("all");
    expect(ui.excluded.counts).toEqual({ "timing-floor": 1, approximate: 1 });
    const member = (id: string, state: "exact" | "approximate", reasons: string[]): CalibrationMember => ({
      id,
      identifier: id,
      title: id,
      completedAt: iso(1),
      workSeconds: 600,
      estimate: { seconds: 3600, source: "current", atStartSeconds: null, currentSeconds: 3600, missing: { atStart: "not_recorded" } },
      dimensions: { kind: "task", priority: "high", workType: "unknown", area: "unknown", model: "unknown" },
      evidence: { state, reasons, workerAttempts: 1, provenance: ["recorded"], harnessSupplied: 0 },
    });
    const selection = { kind: null, priority: null, parentId: null, since: null, include: ["exact" as const] };
    const base = snapshotId({ repositoryId: "r", selection, members: [member("a", "exact", []), member("b", "approximate", ["sparse"])] });
    // The non-sample now carries another reason: what keeps it out changed, and so does the id.
    expect(snapshotId({ repositoryId: "r", selection, members: [member("a", "exact", []), member("b", "approximate", ["capture_gap"])] })).not.toBe(base);
  });

  it("does not depend on the order the members arrive in", () => {
    const member = (id: string, work: number): CalibrationMember => ({
      id,
      identifier: id,
      title: id,
      completedAt: iso(1),
      workSeconds: work,
      estimate: { seconds: 3600, source: "current", atStartSeconds: null, currentSeconds: 3600, missing: { atStart: "not_recorded" } },
      dimensions: { kind: "task", priority: "high", workType: "unknown", area: "unknown", model: "unknown" },
      evidence: { state: "exact", reasons: [], workerAttempts: 1, provenance: ["recorded"], harnessSupplied: 0 },
    });
    const selection = { kind: null, priority: null, parentId: null, since: null, include: ["exact" as const] };
    const members = [member("a", 600), member("b", 900), member("c", 1200)];
    const forward = snapshotId({ repositoryId: "r", selection, members });
    expect(snapshotId({ repositoryId: "r", selection, members: [...members].reverse() })).toBe(forward);
    expect(snapshotId({ repositoryId: "r", selection, members: [member("a", 600), member("b", 901), member("c", 1200)] })).not.toBe(forward);
    expect(snapshotId({ repositoryId: "other", selection, members })).not.toBe(forward);
  });
});
