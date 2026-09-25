/**
 * The controlled-run harness (`docs/timing-semantics.md`, "Controlled runs").
 *
 * A controlled run states a timeline as a list of transitions at known instants, and what
 * every timing figure must read at a later `asOf`. The runner replays the timeline through
 * the real store, the real journal, the real attempt ledger and, for the device variants, the
 * real sync engine against the in-process service, with the write clock installed through
 * the one seam every recorded instant reads (`setClock` in `src/core/types.ts`). It then
 * reads `timingFor(ids, asOf)` on each device and compares every figure the run states
 * within the spec's tolerance.
 *
 * Nothing here writes a row by hand. Every step is one store method, the same method the
 * CLI, MCP and HTTP surfaces call.
 *
 * Reads interleave with the steps by instant (at one instant, the steps first), so a run
 * can read a provisional bucket before the step that settles it.
 *
 * Devices: `a` writes. When a run sets `devices.tail`, `b` is enrolled before the first step
 * and pulls the log at each read (a device that read the tail); steps can also run on it.
 * When it sets `devices.hydrate`, a fresh `c` is enrolled at the last read and hydrates from
 * the service's fold. `c` holds no event history, so its `wall` must read
 * `replay_unavailable` while its effort matches `a`'s. `devices.skew` sets a device's clock
 * off the run's.
 */
import { readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { nowIso, setClock, StapleError } from "../../src/core/types.js";
import { tx } from "../../src/core/db.js";
import { writeEventRow } from "../../src/core/event-row.js";
import type { IssueTiming, IssuePriority, IssueStatus } from "../../src/core/types.js";
import type { CalibrationCohort, CalibrationSample } from "../../src/core/telemetry/calibration.js";
import { FakeSyncServer } from "../fixtures/fake-sync-server.js";
import { OlderBuildDevice } from "../fixtures/older-build.js";
import { Fleet, type Machine } from "../fixtures/sync-machines.js";

// ---------------------------------------------------------------- the fixture format

/** A step of the timeline: one store mutation at one instant, on one device (default `a`). */
/**
 * `refused`: the error code the step must be refused with (`conflict`, `validation`, …). A
 * refused step is a check like any other: the run fails if it succeeds or is refused with
 * another code, and goes on either way, since a refusal writes nothing.
 */
export type Step = { at: string; device?: string; refused?: string } & (
  | {
      do: "create";
      ref: string;
      title?: string;
      parent?: string;
      status?: string;
      estimate?: string | number;
      blockedBy?: string[];
      blockParentUntilDone?: boolean;
      agent?: string;
      kind?: string;
      priority?: string;
      labels?: string[];
    }
  /** `model`: the checkout names a harness (`claude_code`) and this model, as `--harness --model` do. */
  | { do: "checkout"; ref: string; agent: string; stealIfIdle?: string | number; model?: string }
  /** `staple estimate <ref> <duration>`: an explicit re-estimate; `null` clears it. */
  | { do: "estimate"; ref: string; agent: string; estimate: string | number | null }
  | { do: "release"; ref: string; agent: string; ifIdle?: string | number }
  | { do: "status"; ref: string; to: string; agent: string; assignee?: string }
  | { do: "comment"; ref: string; agent: string; body?: string; saveAs?: string }
  | { do: "document"; ref: string; agent: string; key: string; body?: string }
  | { do: "pause" | "resume" | "milestone" | "interrupt"; ref: string; agent: string; reason?: string; label?: string; role?: string }
  | { do: "blockedBy"; ref: string; blockers: string[]; agent: string }
  | { do: "gate"; ref: string; owner: string; agent: string }
  | { do: "approve"; ref: string; agent: string }
  | { do: "requestChanges"; ref: string; agent: string; comment: string }
  | { do: "orchestrate"; ref: string; agent: string }
  | { do: "orchestrateEnd"; ref: string; agent: string }
  | { do: "sync"; devices: string[] }
  | { do: "addStatus"; id: string; category: string; agent: string }
  | { do: "recategorize"; id: string; category: string; agent: string }
  /**
   * An issue a device on a build from before attempts were captured created and worked:
   * pushed through the service's own route with the envelope every build sends, so it
   * arrives with a start and no attempt, as that history does.
   */
  | { do: "olderBuildCreate"; ref: string; parent?: string; status: string; startedAt: string; completedAt?: string }
  /**
   * The same older build changing an issue or a comment it did not create: an `update` at the
   * version device `a` holds. A payload key ending in `At` is an offset, like every instant here.
   */
  | { do: "olderBuildUpdate"; entity: "issue" | "comment"; ref: string; payload: Record<string, unknown> }
  /**
   * An event an older build of THIS device wrote to its local log before attempts were
   * captured (`checkout`, `release`, `status_changed`), dated at `eventAt`: the history
   * `staple attempt reconstruct` reads. Written by the event writer, as that build wrote it.
   */
  | { do: "legacyEvent"; ref: string; kind: "checkout" | "release" | "status_changed"; agent: string; eventAt: string; from?: string; to?: string }
  /** `staple attempt reconstruct` on the device: the real command, journaled like any write. */
  | { do: "reconstruct" }
);

/** A duration: whole seconds, or `"1h2m3.5s"`. */
export type Duration = number | string;

/** What one issue must read at one instant. Every field is optional: a run states what it controls. */
export interface Expectation {
  asOf: string;
  ref: string;
  /** Devices that must read all of it: default `a`, plus `b` when the run has a tail device. */
  on?: string[];
  /**
   * The syncs before this read, in this order, once each: a device left out reads what it
   * holds. Default: every device, twice round, so everything written has reached everyone.
   */
  sync?: string[];
  /** Attempt intervals behind the effort figures: the tolerance is one second per interval. */
  intervals?: number;
  activeSeconds?: Duration | null;
  reviewSeconds?: Duration | null;
  workSeconds?: Duration | null;
  ownWorkSeconds?: Duration | null;
  orchestrationSeconds?: Duration | null;
  estimateRatio?: number | null;
  leadSeconds?: Duration | null;
  /** Instants as offsets from the run's start; `null` for an open span. Unlisted buckets must read 0. */
  wall?: { startAt: string; endAt: string | null; buckets: Record<string, Duration> } | null;
  missing?: Record<string, string>;
  quality?: { work?: string | null; wall?: string | null; workInputs?: string[]; wallInputs?: string[]; workReasons?: string[]; wallReasons?: string[] };
  /**
   * Each worker-lane attempt on the issue, oldest first, as `staple attempts` reads it: its
   * `effortSeconds` and the one quality state of that figure, with its reasons. Replicated
   * data only, so it is checked on the hydrated device too.
   */
  attempts?: Array<{ state: string; reasons?: string[]; effortSeconds?: Duration }>;
  /**
   * `staple timing quality --parent <ref>` read at this instant: the eligible population,
   * the work counts, the ratio population and the aggregates, and what an exclusion drops.
   * Work fields are replicated and checked on every device; `wallCounts` on the writer and
   * the tail only.
   */
  cohort?: {
    include?: string[];
    exclude?: string[];
    excludeReasons?: string[];
    eligible?: number;
    notEligible?: { parents: number; open: number; cancelled: number };
    workCounts?: Record<string, number>;
    wallCounts?: Record<string, number>;
    reasons?: Record<string, number>;
    ratioTotal?: number;
    exactRatio?: number | null;
    exactCount?: number;
    admittedRatio?: number | null;
    admittedCount?: number;
    excluded?: number;
    /** The identifiers' refs listed, in order. */
    items?: string[];
  };
  coverage?: { known: number; total: number; partial: boolean } | null;
  /**
   * `staple calibrate --parent <ref>` read at this instant. Replicated data only, so every field
   * is checked on every device, and the snapshot id must be the same on all of them.
   */
  calibration?: {
    include?: string[];
    /** The ratio population beneath the parent. */
    population?: number;
    /** Samples per evidence set. */
    sets?: Record<string, number>;
    /** Every cohort listed, in order: its set, its full key, and what it read. */
    cohorts?: Array<{
      set: string;
      key: Record<string, string>;
      keySamples: number;
      level: string;
      samples: number;
      eligible?: number;
      medianRatio?: number;
      members?: string[];
    }>;
    /** Every sample, in listing order: its set, the estimate source and its ratio. */
    samples?: Array<{ ref: string; set: string; estimateSource: string; ratio: number; model?: string }>;
  };
  /**
   * The claim's liveness (`claim.lastActivityAt`, as `show` and the steal guard read it), an
   * offset; `null` when the issue is not held. Checked on the hydrated device too.
   */
  claim?: { lastActivityAt: string } | null;
  /** Each worker-lane chain link's `resumeGapSeconds`, oldest first. */
  resumeGaps?: Duration[];
  /** Which of those links read `clockSkew` (an inverted gap over a second): default none. */
  resumeGapsClockSkew?: boolean[];
}

export interface ControlledRun {
  /** The file name without `.json`. */
  name: string;
  title: string;
  /** The spec rules the run exercises, as prose. */
  covers: string[];
  /** The instant every offset is measured from. */
  start: string;
  /**
   * `tail` enrolls `b`, `hydrate` enrolls `c` at the last read. `skew` sets a device's clock
   * off the run's: `{ "b": "-2m" }` is a device whose clock reads two minutes behind. Offsets in
   * the steps are the real instants; each device stamps them through its own clock.
   */
  devices?: { tail?: boolean; hydrate?: boolean; skew?: Record<string, string> };
  steps: Step[];
  expect: Expectation[];
}

/** One comparison the run made. */
export interface Check {
  run: string;
  device: string;
  ref: string;
  asOf: string;
  field: string;
  expected: unknown;
  actual: unknown;
  tolerance: number;
  pass: boolean;
}

// ---------------------------------------------------------------- tolerance

/** One second per interval for effort and category time (`activeSeconds` floors each interval). */
const PER_INTERVAL = 1;
/** One second per nonzero bucket for the partition, which floors each bucket once. */
const PER_BUCKET = 1;
/** The one-second window inside which an attempt instant snaps to a category boundary. */
const SNAP = 1;

// ---------------------------------------------------------------- parsing

const DURATION = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/;

/** `"1h2m3.5s"` to milliseconds. */
export function durationMs(value: Duration): number {
  if (typeof value === "number") return value * 1000;
  const match = DURATION.exec(value.trim());
  if (!match || value.trim() === "") throw new Error(`Not a duration: "${value}". Write "1h2m3.5s", "40m" or a number of seconds.`);
  return Math.round(((Number(match[1] ?? 0) * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000);
}

const seconds = (value: Duration): number => Math.floor(durationMs(value) / 1000);

export function loadRuns(dir: string): ControlledRun[] {
  return readdirSync(dir)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => ({ ...(JSON.parse(readFileSync(join(dir, file), "utf8")) as Omit<ControlledRun, "name">), name: basename(file, ".json") }));
}

// ---------------------------------------------------------------- the runner

const REPOSITORY = "5eed0000-0000-4000-8000-00000c0a7201";

export async function runControlled(run: ControlledRun): Promise<Check[]> {
  const start = Date.parse(run.start);
  if (Number.isNaN(start)) throw new Error(`${run.name}: start "${run.start}" is not an instant`);
  const instant = (offset: string): number => start + durationMs(offset);
  const iso = (offset: string): string => new Date(instant(offset)).toISOString();
  let clock = start;
  /** The device whose clock the seam reads: the one acting now. */
  let current = "a";
  const skew = (label: string): number => {
    const value = run.devices?.skew?.[label];
    if (value === undefined) return 0;
    return value.startsWith("-") ? -durationMs(value.slice(1)) : durationMs(value);
  };
  setClock(() => clock + skew(current));
  const server = new FakeSyncServer({ repositoryId: REPOSITORY });
  server.now = () => clock;
  const fleet = new Fleet(server, REPOSITORY);
  const checks: Check[] = [];
  try {
    const machines = new Map<string, Machine>();
    machines.set("a", fleet.machine("a"));
    if (run.devices?.tail) machines.set("b", fleet.machine("b"));
    for (const machine of machines.values()) {
      machine.use();
      await machine.sync();
    }
    const refs = new Map<string, string>();
    const id = (ref: string): string => {
      const found = refs.get(ref);
      if (!found) throw new Error(`${run.name}: "${ref}" is not created before it is used`);
      return found;
    };
    const device = (label: string | undefined): Machine => {
      const machine = machines.get(label ?? "a");
      if (!machine) throw new Error(`${run.name}: no device "${label}"`);
      machine.use();
      current = label ?? "a";
      return machine;
    };

    // The timeline and the reads, in time order; at one instant, the steps first.
    const timeline = [
      ...run.steps.map((step, index) => ({ at: instant(step.at), order: 0, index, step, read: null as Expectation | null })),
      ...run.expect.map((read, index) => ({ at: instant(read.asOf), order: 1, index, step: null as Step | null, read })),
    ].sort((x, y) => x.at - y.at || x.order - y.order || x.index - y.index);
    const lastRead = Math.max(...run.expect.map((read) => instant(read.asOf)));
    let previous = -Infinity;
    let hydrated: Machine | null = null;
    /** Each calibration read's snapshot id, as the first device read it. */
    const snapshots = new Map<Expectation, string>();
    let older: OlderBuildDevice | null = null;
    const olderCount = { n: 0 };
    for (const entry of timeline) {
      clock = entry.at;
      if (entry.step !== null) {
        const step = entry.step;
        if (entry.at < previous) throw new Error(`${run.name}: step ${entry.index} (${step.do} at ${step.at}) is before the step above it`);
        previous = entry.at;
        let refusal: unknown = null;
        try {
          await apply(step, { device, id, refs, iso, older: () => (older ??= olderBuild(machines.get("a")!, server)), olderCount });
        } catch (error) {
          if (step.refused === undefined) throw new Error(`${run.name}: step ${entry.index} (${step.do} at ${step.at}) failed: ${(error as Error).message}`);
          refusal = error;
        }
        if (step.refused !== undefined) {
          const code = refusal instanceof StapleError ? refusal.code : refusal === null ? "accepted" : `not a StapleError: ${(refusal as Error).message}`;
          const ref = "ref" in step ? String(step.ref) : "-";
          checks.push({ run: run.name, device: step.device ?? "a", ref, asOf: step.at, field: `step ${entry.index} (${step.do}) refused`, expected: step.refused, actual: code, tolerance: 0, pass: code === step.refused });
        }
        continue;
      }
      const expectation = entry.read!;
      // Every device catches up before it reads: two rounds, so what the second device pushes reaches the first.
      for (const label of expectation.sync ?? [...machines.keys(), ...machines.keys()]) await device(label).sync();
      // A device enrolled at the last read hydrates from the service's fold, with no history.
      if (run.devices?.hydrate && entry.at === lastRead && hydrated === null) {
        current = "c";
        hydrated = fleet.machine("c");
        await hydrated.sync();
      }
      const where = (label: string): Where => ({ run: run.name, device: label, ref: expectation.ref, asOf: expectation.asOf });
      for (const label of expectation.on ?? [...machines.keys()]) {
        const machine = device(label);
        const timing = machine.store.timingFor([id(expectation.ref)], iso(expectation.asOf)).get(id(expectation.ref))!;
        compare(checks, where(label), timing, expectation, iso, false);
        invariants(checks, where(label), timing);
        attemptsAgree(checks, where(label), machine, id(expectation.ref), expectation);
        cohortAgrees(checks, where(label), machine, id, expectation, iso, false);
        calibrationAgrees(checks, where(label), machine, id, expectation, iso, snapshots, refs);
        if (expectation.resumeGaps !== undefined) chainAgrees(checks, where(label), machine, timing);
        if (expectation.claim !== undefined) claimAgrees(checks, where(label), machine, id(expectation.ref), expectation.claim, iso);
      }
      if (hydrated !== null && entry.at === lastRead) {
        hydrated.use();
        current = "c";
        const timing = hydrated.store.timingFor([id(expectation.ref)], iso(expectation.asOf)).get(id(expectation.ref))!;
        compare(checks, where("c"), timing, expectation, iso, true);
        invariants(checks, where("c"), timing);
        attemptsAgree(checks, where("c"), hydrated, id(expectation.ref), expectation);
        cohortAgrees(checks, where("c"), hydrated, id, expectation, iso, true);
        calibrationAgrees(checks, where("c"), hydrated, id, expectation, iso, snapshots, refs);
        if (expectation.resumeGaps !== undefined) chainAgrees(checks, where("c"), hydrated, timing);
        if (expectation.claim !== undefined) claimAgrees(checks, where("c"), hydrated, id(expectation.ref), expectation.claim, iso);
      }
    }
  } finally {
    setClock(null);
    fleet.close();
  }
  return checks;
}

/** A peer on a build from before attempts, stamping the schema the writer's workspace has. */
function olderBuild(writer: Machine, server: FakeSyncServer): OlderBuildDevice {
  const schema = Number((writer.db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string }).value);
  return new OlderBuildDevice(server, REPOSITORY, "device-older", schema);
}

interface StepContext {
  device: (label: string | undefined) => Machine;
  id: (ref: string) => string;
  refs: Map<string, string>;
  iso: (offset: string) => string;
  older: () => OlderBuildDevice;
  /** How many issues the older build has created in this run: its ids and identifiers. */
  olderCount: { n: number };
}

async function apply(step: Step, context: StepContext): Promise<void> {
  const { device, id, refs, iso } = context;
  if (step.do === "sync") {
    for (const label of step.devices) await device(label).sync();
    return;
  }
  if (step.do === "olderBuildUpdate") {
    const writer = device("a");
    await writer.sync();
    const entityId = id(step.ref);
    const version =
      (writer.db.prepare("SELECT version FROM sync_entity_versions WHERE entity = ? AND entity_id = ?").get(step.entity, entityId) as { version: number } | undefined)?.version ?? 0;
    const payload = Object.fromEntries(
      Object.entries(step.payload).map(([key, value]) => [key, key.endsWith("At") && typeof value === "string" ? iso(value) : value]),
    );
    await context.older().push([{ entity: step.entity, entityId, verb: "update", baseVersion: version, payload, createdAt: nowIso() }]);
    return;
  }
  if (step.do === "olderBuildCreate") {
    context.olderCount.n += 1;
    const issueId = `01d0b111-0000-4000-8000-${String(context.olderCount.n).padStart(12, "0")}`;
    const title = step.ref;
    await context.older().push([
      {
        entity: "issue",
        entityId: issueId,
        verb: "create",
        payload: {
          identifier: `TRA-${900 + context.olderCount.n}`,
          title,
          normalizedTitle: title,
          status: step.status,
          kind: "task",
          priority: "medium",
          ...(step.parent !== undefined ? { parentId: id(step.parent) } : {}),
          createdAt: iso(step.startedAt),
          updatedAt: iso(step.completedAt ?? step.startedAt),
          startedAt: iso(step.startedAt),
          ...(step.completedAt !== undefined ? { completedAt: iso(step.completedAt) } : {}),
        },
        createdAt: nowIso(),
      },
    ]);
    refs.set(step.ref, issueId);
    return;
  }
  if (step.do === "legacyEvent") {
    const machine = device(step.device);
    const payload = step.kind === "status_changed" ? { from: step.from, to: step.to } : {};
    tx(machine.db, () =>
      writeEventRow(machine.db, { kind: step.kind, issueId: id(step.ref), actor: step.agent, payload, createdAt: iso(step.eventAt), dedupKey: `legacy-${step.kind}-${step.ref}-${step.eventAt}` }),
    );
    return;
  }
  const { store } = device(step.device);
  switch (step.do) {
    case "reconstruct":
      store.reconstructAttemptHistory();
      return;
    case "create": {
      const issue = store.createIssue({
        title: step.title ?? step.ref,
        ...(step.parent !== undefined ? { parent: id(step.parent) } : {}),
        ...(step.status !== undefined ? { status: step.status as IssueStatus } : {}),
        ...(step.estimate !== undefined ? { estimatedSeconds: seconds(step.estimate) } : {}),
        ...(step.blockedBy !== undefined ? { blockedBy: step.blockedBy.map(id) } : {}),
        ...(step.blockParentUntilDone !== undefined ? { blockParentUntilDone: step.blockParentUntilDone } : {}),
        ...(step.agent !== undefined ? { createdBy: step.agent } : {}),
        ...(step.kind !== undefined ? { kind: step.kind } : {}),
        ...(step.priority !== undefined ? { priority: step.priority as IssuePriority } : {}),
        ...(step.labels !== undefined ? { labels: step.labels } : {}),
      });
      refs.set(step.ref, issue.id);
      return;
    }
    case "checkout":
      store.checkoutIssue(id(step.ref), step.agent, undefined, {
        ...(step.stealIfIdle !== undefined ? { stealIfIdleSeconds: seconds(step.stealIfIdle) } : {}),
        ...(step.model !== undefined ? { attempt: { harness: "claude_code", model: step.model } } : {}),
      });
      return;
    case "estimate":
      store.setEstimate(id(step.ref), step.estimate === null ? null : seconds(step.estimate), step.agent);
      return;
    case "release":
      store.releaseIssue(id(step.ref), step.agent, step.ifIdle !== undefined ? { ifIdleSeconds: seconds(step.ifIdle) } : {});
      return;
    case "status":
      store.updateIssue(id(step.ref), { status: step.to as IssueStatus, ...(step.assignee !== undefined ? { assignee: step.assignee } : {}) }, step.agent);
      return;
    case "comment": {
      const comment = store.addComment(id(step.ref), step.body ?? "progress", step.agent, "agent");
      if (step.saveAs !== undefined) refs.set(step.saveAs, comment.id);
      return;
    }
    case "addStatus":
      store.addStatus({ id: step.id, category: step.category }, step.agent);
      return;
    case "recategorize":
      store.recategorizeStatus(step.id, step.category, step.agent);
      return;
    case "document":
      store.putDocument(id(step.ref), step.key, step.body ?? `${step.key} from ${step.agent}`, { author: step.agent });
      return;
    case "pause":
    case "resume":
    case "milestone":
    case "interrupt":
      store.recordAttemptEvent(id(step.ref), step.do, step.agent, {
        ...(step.reason !== undefined ? { reason: step.reason } : {}),
        ...(step.label !== undefined ? { label: step.label } : {}),
        ...(step.role !== undefined ? { role: step.role } : {}),
      });
      return;
    case "blockedBy":
      store.setBlockedBy(id(step.ref), step.blockers.map(id), step.agent);
      return;
    case "gate":
      store.gateIssue(id(step.ref), { owner: step.owner }, step.agent);
      return;
    case "approve":
      store.approveGate(id(step.ref), {}, step.agent);
      return;
    case "requestChanges":
      store.requestChanges(id(step.ref), { comment: step.comment }, step.agent);
      return;
    case "orchestrate":
      store.openOrchestratorAttempt(id(step.ref), step.agent, "orchestrator");
      return;
    case "orchestrateEnd":
      store.endOrchestratorAttempt(id(step.ref), step.agent, "orchestrator");
      return;
    default:
      throw new Error(`unknown step ${(step as { do: string }).do}`);
  }
}

// ---------------------------------------------------------------- comparing

type Where = Pick<Check, "run" | "device" | "ref" | "asOf">;

function check(checks: Check[], where: Where, field: string, expected: unknown, actual: unknown, tolerance = 0): void {
  let pass: boolean;
  if (typeof expected === "number" && typeof actual === "number") pass = Math.abs(expected - actual) <= tolerance + 1e-9;
  else pass = JSON.stringify(expected) === JSON.stringify(actual);
  checks.push({ ...where, field, expected, actual, tolerance, pass });
}

const secondsOrNull = (value: Duration | null): number | null => (value === null ? null : seconds(value));

/** The fields a hydrated device must read as the writer does: replicated data only. */
const EFFORT_FIELDS = ["workSeconds", "ownWorkSeconds", "orchestrationSeconds"] as const;

function compare(checks: Check[], where: Where, timing: IssueTiming, expectation: Expectation, iso: (offset: string) => string, hydrated: boolean): void {
  const effortTolerance = PER_INTERVAL * (expectation.intervals ?? 1) + SNAP;
  for (const field of EFFORT_FIELDS) {
    const expected = expectation[field];
    if (expected !== undefined) check(checks, where, field, secondsOrNull(expected), timing[field], expected === null ? 0 : effortTolerance);
  }
  if (expectation.quality?.work !== undefined) check(checks, where, "quality.work.state", expectation.quality.work, timing.quality.work.state);
  if (expectation.quality?.workInputs !== undefined) check(checks, where, "quality.work.inputs", expectation.quality.workInputs, timing.quality.work.inputs);
  if (expectation.quality?.workReasons !== undefined) check(checks, where, "quality.work.reasons", expectation.quality.workReasons, timing.quality.work.reasons);
  if (expectation.coverage !== undefined) check(checks, where, "quality.work.coverage", expectation.coverage, timing.quality.work.coverage);
  if (expectation.estimateRatio !== undefined) check(checks, where, "estimateRatio", expectation.estimateRatio, timing.estimateRatio, 0.01);
  if (expectation.resumeGaps !== undefined) {
    check(checks, where, "resumeGaps.length", expectation.resumeGaps.length, timing.resumeGaps?.length ?? null);
    expectation.resumeGaps.forEach((gap, index) => {
      check(checks, where, `resumeGaps[${index}].resumeGapSeconds`, seconds(gap), timing.resumeGaps?.[index]?.resumeGapSeconds ?? null, PER_INTERVAL + SNAP);
      check(checks, where, `resumeGaps[${index}].clockSkew`, expectation.resumeGapsClockSkew?.[index] ?? false, timing.resumeGaps?.[index]?.clockSkew ?? null);
    });
  }
  for (const field of ["workSeconds", "ownWorkSeconds", "orchestrationSeconds"] as const) {
    const reason = expectation.missing?.[field];
    if (reason !== undefined) check(checks, where, `missing.${field}`, reason, timing.missing[field] ?? null);
  }

  if (hydrated) {
    // A device that hydrated holds no history: the elapsed axis says why it cannot answer,
    // and its record still has one state.
    check(checks, where, "wall", null, timing.wall);
    check(checks, where, "missing.wall", "replay_unavailable", timing.missing.wall ?? null);
    check(checks, where, "quality.wall", { state: "missing", reasons: ["replay_unavailable"] }, { state: timing.quality.wall.state, reasons: timing.quality.wall.reasons });
    return;
  }

  for (const [field, value] of [
    ["activeSeconds", expectation.activeSeconds],
    ["reviewSeconds", expectation.reviewSeconds],
    ["leadSeconds", expectation.leadSeconds],
  ] as const) {
    if (value !== undefined) check(checks, where, field, secondsOrNull(value), timing[field], value === null ? 0 : effortTolerance);
  }
  for (const [field, reason] of Object.entries(expectation.missing ?? {})) {
    if ((EFFORT_FIELDS as readonly string[]).includes(field)) continue;
    check(checks, where, `missing.${field}`, reason, timing.missing[field] ?? null);
  }
  if (expectation.quality?.wall !== undefined) check(checks, where, "quality.wall.state", expectation.quality.wall, timing.quality.wall.state);
  if (expectation.quality?.wallInputs !== undefined) check(checks, where, "quality.wall.inputs", expectation.quality.wallInputs, timing.quality.wall.inputs);
  if (expectation.quality?.wallReasons !== undefined) check(checks, where, "quality.wall.reasons", expectation.quality.wallReasons, timing.quality.wall.reasons);
  if (expectation.wall === undefined) return;
  if (expectation.wall === null) {
    check(checks, where, "wall", null, timing.wall);
    return;
  }
  const wall = timing.wall;
  if (wall === null) {
    check(checks, where, "wall", "a partition", null);
    return;
  }
  check(checks, where, "wall.startAt", iso(expectation.wall.startAt), wall.startAt);
  check(checks, where, "wall.endAt", expectation.wall.endAt === null ? null : iso(expectation.wall.endAt), wall.endAt);
  const expectedBuckets = Object.fromEntries(Object.entries(expectation.wall.buckets).map(([bucket, value]) => [bucket, seconds(value)]));
  for (const bucket of Object.keys(expectedBuckets)) {
    if (!(bucket in wall.buckets)) check(checks, where, `wall.buckets.${bucket}`, expectedBuckets[bucket], "no such bucket");
  }
  for (const [bucket, actual] of Object.entries(wall.buckets)) {
    const expected = expectedBuckets[bucket] ?? 0;
    // A bucket the timeline never enters reads exactly zero; a nonzero one within a second, plus the snap.
    check(checks, where, `wall.buckets.${bucket}`, expected, actual, expected === 0 ? 0 : PER_BUCKET + SNAP);
  }
}

/** The claim's liveness, as the steal and release guards read it (`claimActivity`). */
function claimAgrees(checks: Check[], where: Where, machine: Machine, issueId: string, expected: { lastActivityAt: string } | null, iso: (offset: string) => string): void {
  const claim = machine.store.claimActivity(issueId);
  check(checks, where, "claim.lastActivityAt", expected === null ? null : iso(expected.lastActivityAt), claim?.lastActivityAt ?? null);
}

/** `staple attempt <id>`'s `chain` says the same gap as `timing.resumeGaps`, link by link. */
function chainAgrees(checks: Check[], where: Where, machine: Machine, timing: IssueTiming): void {
  for (const [index, link] of (timing.resumeGaps ?? []).entries()) {
    const entry = machine.store.getAttempt(link.attemptId, {}, machine.home).chain.find((candidate) => candidate.id === link.attemptId);
    check(checks, where, `chain[${index}].resumeGapSeconds`, link.resumeGapSeconds, entry?.resumeGapSeconds ?? null);
  }
}

/** Each worker attempt's effort figure and its one state, as `staple attempts` reads them. */
function attemptsAgree(checks: Check[], where: Where, machine: Machine, issueId: string, expectation: Expectation): void {
  if (expectation.attempts === undefined) return;
  const items = machine.store.listAttempts(issueId, { limit: 500 }).items.filter((attempt) => attempt.role === "worker");
  check(checks, where, "attempts.length", expectation.attempts.length, items.length);
  expectation.attempts.forEach((expected, index) => {
    const actual = items[index];
    check(checks, where, `attempts[${index}].quality.state`, expected.state, actual?.quality.state ?? null);
    if (expected.reasons !== undefined) check(checks, where, `attempts[${index}].quality.reasons`, expected.reasons, actual?.quality.reasons ?? null);
    if (expected.effortSeconds !== undefined) check(checks, where, `attempts[${index}].effortSeconds`, seconds(expected.effortSeconds), actual?.effortSeconds ?? null, PER_INTERVAL + SNAP);
  });
}

/** `staple timing quality --parent <ref>` at the read's instant. */
function cohortAgrees(
  checks: Check[],
  where: Where,
  machine: Machine,
  id: (ref: string) => string,
  expectation: Expectation,
  iso: (offset: string) => string,
  hydrated: boolean,
): void {
  const expected = expectation.cohort;
  if (expected === undefined) return;
  const report = machine.store.timingQuality(
    { parent: id(expectation.ref), include: expected.include, exclude: expected.exclude, excludeReasons: expected.excludeReasons, limit: 500 },
    iso(expectation.asOf),
  );
  const at = (field: string, want: unknown, got: unknown, tolerance = 0): void => {
    if (want !== undefined) check(checks, where, `cohort.${field}`, want, got, tolerance);
  };
  at("eligible", expected.eligible, report.population.eligible);
  at("notEligible", expected.notEligible, report.population.notEligible);
  at("work.counts", expected.workCounts, report.work.counts);
  at("work.reasons", expected.reasons, report.work.reasons);
  if (!hydrated) at("wall.counts", expected.wallCounts, report.wall.counts);
  at("ratio.total", expected.ratioTotal, report.ratio.total);
  at("ratio.exact.count", expected.exactCount, report.ratio.exact.count);
  at("ratio.exact.ratio", expected.exactRatio, report.ratio.exact.ratio, 0.01);
  at("ratio.admitted.count", expected.admittedCount, report.ratio.admitted.count);
  at("ratio.admitted.ratio", expected.admittedRatio, report.ratio.admitted.ratio, 0.01);
  at("excluded.count", expected.excluded, report.excluded.count);
  if (expected.items !== undefined) {
    const byId = new Map<string, string>();
    for (const ref of expected.items) byId.set(machine.store.getIssue(id(ref)).identifier, ref);
    at("items", expected.items, report.items.map((item) => byId.get(item.identifier) ?? item.identifier));
  }
  // Coverage is over the eligible population, whatever was excluded: the counts add up to it.
  const sum = Object.values(report.work.counts).reduce((a, b) => a + b, 0);
  check(checks, where, "invariant: cohort work counts add up to the eligible population", report.population.eligible, sum);
}

/**
 * `staple calibrate --parent <ref>` at the read's instant: the samples, the cohorts and their
 * fallback, on every device alike, and one snapshot id for all of them.
 */
function calibrationAgrees(
  checks: Check[],
  where: Where,
  machine: Machine,
  id: (ref: string) => string,
  expectation: Expectation,
  iso: (offset: string) => string,
  snapshots: Map<Expectation, string>,
  runRefs: ReadonlyMap<string, string>,
): void {
  const expected = expectation.calibration;
  if (expected === undefined) return;
  const query = { parent: id(expectation.ref), include: expected.include, limit: 500 };
  const report = machine.store.calibration(query, iso(expectation.asOf));
  const sampled = machine.store.calibration({ ...query, list: "samples" }, iso(expectation.asOf));
  // Identifiers back to the run's refs, as this device numbers them.
  const refOf = new Map<string, string>();
  for (const [ref, entityId] of runRefs) {
    // A ref can name a comment (`saveAs`); only issues have identifiers.
    const row = machine.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(entityId) as { identifier: string } | undefined;
    if (row !== undefined) refOf.set(row.identifier, ref);
  }
  const refs = (identifiers: readonly string[]): string[] => identifiers.map((identifier) => refOf.get(identifier) ?? identifier);
  const at = (field: string, want: unknown, got: unknown, tolerance = 0): void => {
    if (want !== undefined) check(checks, where, `calibration.${field}`, want, got, tolerance);
  };
  at("population", expected.population, report.population.ratio);
  at("sets", expected.sets, Object.fromEntries(report.sets.map((set) => [set.set, set.samples])));
  if (expected.cohorts !== undefined) {
    const cohorts = report.items as CalibrationCohort[];
    at("cohorts.length", expected.cohorts.length, cohorts.length);
    expected.cohorts.forEach((want, index) => {
      const got = cohorts[index];
      at(`cohorts[${index}].set`, want.set, got?.set ?? null);
      at(`cohorts[${index}].key`, want.key, got?.key ?? null);
      at(`cohorts[${index}].keySamples`, want.keySamples, got?.keySamples ?? null);
      at(`cohorts[${index}].level`, want.level, got?.levelName ?? null);
      at(`cohorts[${index}].samples`, want.samples, got?.samples ?? null);
      at(`cohorts[${index}].eligible`, want.eligible, got?.coverage.eligible ?? null);
      at(`cohorts[${index}].ratio.median`, want.medianRatio, got?.ratio.median ?? null, 0.001);
      if (want.members !== undefined) at(`cohorts[${index}].members`, want.members, got === undefined ? null : refs(got.members.refs));
    });
  }
  if (expected.samples !== undefined) {
    const items = sampled.items as CalibrationSample[];
    at("samples.length", expected.samples.length, items.length);
    expected.samples.forEach((want, index) => {
      const got = items[index];
      at(`samples[${index}].ref`, want.ref, got === undefined ? null : refs([got.identifier])[0]);
      at(`samples[${index}].set`, want.set, got?.set ?? null);
      at(`samples[${index}].estimate.source`, want.estimateSource, got?.estimate.source ?? null);
      at(`samples[${index}].ratio`, want.ratio, got?.ratio ?? null, 0.001);
      if (want.model !== undefined) at(`samples[${index}].dimensions.model`, want.model, got?.dimensions.model ?? null);
    });
  }
  // One identity for the data, whichever device read it and whatever it listed.
  check(checks, where, "invariant: one snapshot id for cohorts and samples", report.snapshot.id, sampled.snapshot.id);
  const first = snapshots.get(expectation);
  if (first === undefined) snapshots.set(expectation, report.snapshot.id);
  else check(checks, where, "calibration.snapshot.id (as the first device read it)", first, report.snapshot.id);
}

/**
 * What must hold on every read, whatever the run states: the buckets partition the span, so
 * no second is in two of them (the reported sum can fall short of the span by at most one
 * second per nonzero bucket, and never exceed it).
 */
function invariants(checks: Check[], where: Where, timing: IssueTiming): void {
  // One state per record, and it is the level of its first reason: exact exactly when nothing holds.
  const work = timing.quality.work;
  if (work.state !== null) {
    checks.push({ ...where, field: "invariant: work state is exact exactly when it has no reason", expected: work.state === "exact", actual: work.reasons.length === 0, tolerance: 0, pass: (work.state === "exact") === (work.reasons.length === 0) });
  }
  checks.push({ ...where, field: "invariant: wall has one state", expected: "a state", actual: timing.quality.wall.state, tolerance: 0, pass: timing.quality.wall.state !== null });
  const wall = timing.wall;
  if (wall === null) return;
  const values = Object.values(wall.buckets);
  const sum = values.reduce((a, b) => a + b, 0);
  const nonzero = values.filter((value) => value > 0).length;
  const shortfall = wall.seconds - sum;
  checks.push({ ...where, field: "invariant: buckets partition wall.seconds", expected: `0..${nonzero}`, actual: shortfall, tolerance: 0, pass: shortfall >= 0 && shortfall <= nonzero * PER_BUCKET });
}

/** The failing checks, one line each, for a test failure message. */
export function describeFailures(checks: readonly Check[]): string {
  return checks
    .filter((c) => !c.pass)
    .map((c) => `${c.run} [${c.device}] ${c.ref} @${c.asOf} ${c.field}: expected ${JSON.stringify(c.expected)}${c.tolerance ? ` ±${c.tolerance}` : ""}, read ${JSON.stringify(c.actual)}`)
    .join("\n");
}
