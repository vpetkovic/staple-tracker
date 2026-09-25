/**
 * The elapsed partition of one issue: `wall` and its buckets (`docs/timing-semantics.md`,
 * "The elapsed partition of one issue" and "Boundary rules").
 *
 * Every millisecond of `[startAt, endAt or through)` falls into exactly one bucket, chosen by
 * the issue's status category at that instant (replayed from the local event log, the same
 * replay `timingFor` runs) and, for a leaf in `active`, by worker-attempt coverage. A parent's
 * `active` is not divided: its effort is on the effort axis.
 *
 * Pure: the store hands in the replayed path, the attempts as this device's ledger reads
 * them, and the blocker history; this module only does arithmetic on instants, in
 * milliseconds, and floors each bucket once.
 */

export type LeafBucket = "work" | "paused" | "silent" | "interrupted" | "unattributed" | "review" | "gated" | "blocked" | "queued" | "resolved";
export type ParentBucket = "active" | "review" | "gated" | "blocked" | "queued" | "resolved";

export const LEAF_BUCKETS: readonly LeafBucket[] = ["work", "paused", "silent", "interrupted", "unattributed", "review", "gated", "blocked", "queued", "resolved"];
export const PARENT_BUCKETS: readonly ParentBucket[] = ["active", "review", "gated", "blocked", "queued", "resolved"];

/** One replayed entry into a status: the category entered, when, and whether a derived flip did it. */
export interface PathEntry {
  readonly at: string;
  readonly category: string | null;
  readonly derived: boolean;
}

/** A worker attempt as this device's ledger reads it. */
export interface CoverageAttempt {
  readonly startedAt: string;
  /** `end(A)`: the stored end, the orphan's `endedAtBound`, or `asOf` while effectively open. */
  readonly end: string;
  /** `c(A)`: `countedThrough` while open, `end(A)` otherwise. */
  readonly countedThrough: string;
  readonly open: boolean;
  /** Effectively ended `interrupted`, or read `orphaned`. */
  readonly interruptedOrOrphaned: boolean;
  readonly pauses: ReadonlyArray<readonly [string, string]>;
}

/** Instants at which the issue had at least one unresolved blocker, as half-open intervals in ms. */
export type Intervals = ReadonlyArray<readonly [number, number]>;

export interface WallInput {
  readonly parent: boolean;
  readonly path: readonly PathEntry[];
  readonly asOf: string;
  readonly attempts: readonly CoverageAttempt[];
  readonly blocked: Intervals;
  /** Blocked intervals whose edge no `blockers_changed` explains: time in them makes the record approximate. */
  readonly unexplainedBlocked: Intervals;
}

export interface Wall {
  readonly startAt: string;
  readonly endAt: string | null;
  readonly through: string | null;
  readonly seconds: number;
  readonly buckets: Record<string, number>;
  readonly inputs: string[];
}

const SNAP_MS = 1000;
const ms = (iso: string): number => Date.parse(iso);

function inAny(intervals: Intervals, x: number): boolean {
  for (const [from, to] of intervals) if (from <= x && x < to) return true;
  return false;
}

/**
 * The partition, or null when the issue never entered `active` (a leaf: by anything but a
 * derived flip; a parent: by any means) — `never_started`.
 */
export function partition(input: WallInput): Wall | null {
  const { path, parent } = input;
  const startIndex = path.findIndex((entry) => entry.category === "active" && (parent || !entry.derived));
  if (startIndex < 0) return null;
  const start = ms(path[startIndex]!.at);
  const last = path[path.length - 1]!;
  const resolvedNow = last.category === "done" || last.category === "cancelled";
  const endIso = resolvedNow ? last.at : input.asOf;
  const end = Math.max(start, ms(endIso));
  const inputs = new Set<string>();

  // Category boundaries, for the one-second snap of attempt instants to them.
  const boundaries = path.map((entry) => ms(entry.at));
  const snap = (x: number): number => {
    let best = x;
    let distance = SNAP_MS + 1;
    for (const boundary of boundaries) {
      const d = Math.abs(boundary - x);
      if (d <= SNAP_MS && d < distance) {
        best = boundary;
        distance = d;
      }
    }
    return best;
  };
  const attempts = input.attempts
    .map((attempt) => {
      const from = snap(ms(attempt.startedAt));
      let to = attempt.open ? ms(attempt.end) : snap(ms(attempt.end));
      if (to + SNAP_MS < from) inputs.add("clock_skew");
      if (to < from) to = from;
      const counted = attempt.open ? Math.max(from, Math.min(ms(attempt.countedThrough), to)) : to;
      const pauses: Array<[number, number]> = attempt.pauses.map(([p, q]) => [Math.max(from, ms(p)), Math.min(to, ms(q))]);
      return { from, to, counted, open: attempt.open, broken: attempt.interruptedOrOrphaned, pauses: pauses.filter(([p, q]) => p < q) };
    })
    .sort((a, b) => a.from - b.from);

  const buckets: Record<string, number> = Object.fromEntries((parent ? PARENT_BUCKETS : LEAF_BUCKETS).map((bucket) => [bucket, 0]));
  let unexplained = false;

  const activeBucket = (x: number): LeafBucket => {
    let covered = false;
    let work = false;
    let paused = false;
    let silent = false;
    for (const attempt of attempts) {
      if (!(attempt.from <= x && x < attempt.to)) continue;
      covered = true;
      const isPaused = attempt.pauses.some(([p, q]) => p <= x && x < q);
      if (isPaused) paused = true;
      else if (x < attempt.counted) work = true;
      else if (attempt.open) silent = true;
    }
    if (work) return "work";
    if (paused) return "paused";
    if (silent) return "silent";
    if (!covered) {
      let latest: (typeof attempts)[number] | null = null;
      for (const attempt of attempts) if (attempt.from <= x) latest = attempt;
      if (latest !== null && latest.broken) return "interrupted";
    }
    return "unattributed";
  };

  // Walk the category segments inside the span, and within each the elementary intervals.
  for (let i = startIndex; i < path.length; i += 1) {
    const entry = path[i]!;
    const segFrom = Math.max(start, ms(entry.at));
    const segTo = Math.min(end, i + 1 < path.length ? ms(path[i + 1]!.at) : end);
    if (segTo <= segFrom) continue;
    const category = entry.category;
    const cuts = new Set<number>([segFrom, segTo]);
    const cut = (x: number): void => {
      if (x > segFrom && x < segTo) cuts.add(x);
    };
    if (category === "active" && !parent) {
      for (const attempt of attempts) {
        cut(attempt.from);
        cut(attempt.to);
        cut(attempt.counted);
        for (const [p, q] of attempt.pauses) {
          cut(p);
          cut(q);
        }
      }
    }
    if (category === "unstarted" || category === "ready") {
      for (const [from, to] of input.blocked) {
        cut(from);
        cut(to);
      }
      for (const [from, to] of input.unexplainedBlocked) {
        cut(from);
        cut(to);
      }
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let j = 0; j + 1 < points.length; j += 1) {
      const from = points[j]!;
      const length = points[j + 1]! - from;
      let bucket: string;
      switch (category) {
        case "active":
          bucket = parent ? "active" : activeBucket(from);
          break;
        case "review":
          bucket = "review";
          break;
        case "gated":
          bucket = "gated";
          break;
        case "blocked":
          bucket = "blocked";
          break;
        case "done":
        case "cancelled":
          bucket = "resolved";
          break;
        default:
          // unstarted / ready, and a category this build does not know: blocked by an edge, or queued.
          if (inAny(input.blocked, from)) {
            bucket = "blocked";
            if (inAny(input.unexplainedBlocked, from)) unexplained = true;
          } else bucket = "queued";
      }
      buckets[bucket] = (buckets[bucket] ?? 0) + length;
    }
  }

  const floored: Record<string, number> = {};
  for (const [bucket, total] of Object.entries(buckets)) floored[bucket] = Math.floor(total / 1000);
  if (!parent && (floored.unattributed ?? 0) > 0) inputs.add("unattributed");
  if (unexplained) inputs.add("edge_history_incomplete");
  return {
    startAt: new Date(start).toISOString(),
    endAt: resolvedNow ? endIso : null,
    through: resolvedNow ? null : input.asOf,
    seconds: Math.floor((end - start) / 1000),
    buckets: floored,
    inputs: [...inputs].sort(),
  };
}

/** The union of half-open intervals, merged and sorted. */
export function union(intervals: Array<[number, number]>): Array<[number, number]> {
  const sorted = intervals.filter(([a, b]) => a < b).sort((x, y) => x[0] - y[0]);
  const out: Array<[number, number]> = [];
  for (const [a, b] of sorted) {
    const last = out[out.length - 1];
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else out.push([a, b]);
  }
  return out;
}

/** The intersection of two sets of half-open intervals. */
export function intersect(left: Intervals, right: Intervals): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const [a, b] of left) for (const [c, d] of right) {
    const from = Math.max(a, c);
    const to = Math.min(b, d);
    if (from < to) out.push([from, to]);
  }
  return union(out);
}
