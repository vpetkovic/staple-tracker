/**
 * The Analytics read: delivery, capacity, speed, reliability, effort and rhythm over one
 * period, for one workspace or several. Pure: rows in (`rows.ts`), a report out
 * (`contract.ts`), no database and no clock.
 *
 * ## Where the definitions come from, and where they differ
 *
 * The figures follow the standalone impact report VP approved (2026-11-14) wherever its
 * definition still holds. Where this read changes one, it is because the report's was
 * dishonest in a way the tracker can now avoid. Each change is listed in the `api-contract`
 * document, and here:
 *
 *  1. **Agent-hours count the replicated effort, not the stored span.** The report summed
 *     `endedAt − startedAt` and dropped attempts with no end. This read sums each attempt's
 *     effort (`issueEffort`: pauses taken out, an inferred end corrected, an open attempt
 *     counted through its last evidence), still capped at 12 h per attempt.
 *  2. **An attempt's hours land on the days it ran.** The report put a whole attempt on the
 *     day it started. Here its capped effort is spread over its span, so a period boundary
 *     cuts an attempt rather than taking or leaving all of it.
 *  3. **Planned effort is not counted twice.** The report added every done ticket's estimate,
 *     an epic's included, on top of its children's. Here a ticket with an estimated descendant
 *     contributes nothing of its own.
 *  4. **Attempt success excludes attempts still running.** The report divided by every
 *     attempt; one still open has not failed.
 *  5. **Tickets closed on import are kept out of speed.** A done ticket with no attempt that
 *     was closed within two minutes of being created was imported already done; its
 *     zero-minute cycle would flatter every speed figure. It still counts as delivered, and a
 *     caveat says how many there are.
 *  6. **Percentiles are the lower quantile**, as everywhere else in staple.
 *
 * Cycle time stays the replicated first-start-to-done span (`startedAt` to `completedAt`)
 * rather than STA-90's elapsed partition: the partition is read from the local event log and
 * differs between devices, and an Analytics page must read the same on every device. Agent
 * work per ticket, which IS replicated interval timing, is reported beside it.
 */
import { StapleError } from "../types.js";
import { deriveAgentType, type AgentType, type AgentTypeReason, type AgentTypeRule, AGENT_TYPES } from "./agent-type.js";
import type {
  AgentRow,
  AgentTypeRow,
  AnalyticsDefinitions,
  AnalyticsHeadline,
  AnalyticsPeriod,
  AnalyticsReport,
  AnalyticsWorkspaceRef,
  AttemptStandingId,
  Bucket,
  Caveat,
  DateKey,
  EpicRow,
  HistogramBin,
  ModelRow,
  SeriesPoint,
  SprintRow,
  WorkspaceRow,
} from "./contract.js";
import { daysBetween, eachDate, isDateKey, nextDate, Zone } from "./local-time.js";
import type { AnalyticsAttempt, AnalyticsIssue, WorkspaceRows } from "./rows.js";

export const ANALYTICS_DEFINITIONS: AnalyticsDefinitions = Object.freeze({
  attemptCapHours: 12,
  fteHoursPerWeek: 40,
  fteHoursPerDay: 8,
  sprintGapDays: 5,
  sprintMinDone: 10,
  importWindowSeconds: 120,
});

/** The longest period one read covers: ten years of days. */
const MAX_PERIOD_DAYS = 3660;
const BUCKETS: readonly Bucket[] = ["day", "week", "month"];
const STANDINGS: readonly AttemptStandingId[] = ["completed", "yielded", "failed", "interrupted", "orphaned", "open"];
const HISTOGRAM: ReadonlyArray<readonly [string, number, number | null]> = [
  ["<15m", 0, 0.25],
  ["15–30m", 0.25, 0.5],
  ["30m–1h", 0.5, 1],
  ["1–2h", 1, 2],
  ["2–4h", 2, 4],
  ["4–8h", 4, 8],
  ["8–24h", 8, 24],
  ["1–3d", 24, 72],
  ["3–7d", 72, 168],
  ["7d+", 168, null],
];

export interface AnalyticsQuery {
  readonly from?: string;
  readonly to?: string;
  readonly tz?: string;
  readonly bucket?: string;
  /** The read's instant. */
  readonly now: string;
  /** The person's agent-type rules (`analytics.roleMapping`). */
  readonly rules?: readonly AgentTypeRule[];
}

const round2 = (value: number): number => Math.round(value * 100) / 100;
const hours = (seconds: number): number => seconds / 3600;
const ms = (iso: string): number => Date.parse(iso);

/** The lower quantile: `sorted[floor(p × (n − 1))]`. */
export function lowerQuantile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(p * (sorted.length - 1))]!;
}

function increment(record: Record<string, number>, key: string, by = 1): void {
  record[key] = (record[key] ?? 0) + by;
}

// ------------------------------------------------------------------ the scope, indexed once

interface ScopedIssue extends AnalyticsIssue {
  readonly workspace: string;
  readonly prefix: string;
}

interface ScopedAttempt extends AnalyticsAttempt {
  readonly workspace: string;
  readonly issue: ScopedIssue | undefined;
  readonly startMs: number;
  readonly endMs: number;
  /** Effort with the per-attempt cap applied. */
  readonly cappedSeconds: number;
  readonly type: AgentType;
  readonly reason: AgentTypeReason;
}

interface Scope {
  readonly issues: readonly ScopedIssue[];
  readonly attempts: readonly ScopedAttempt[];
  readonly byKey: ReadonlyMap<string, ScopedIssue>;
  readonly children: ReadonlyMap<string, readonly ScopedIssue[]>;
  readonly attemptsOf: ReadonlyMap<string, readonly ScopedAttempt[]>;
  readonly hasEstimatedDescendant: ReadonlySet<string>;
  readonly slugs: readonly string[];
  readonly prefixes: ReadonlyMap<string, string>;
  readonly rules: readonly AgentTypeRule[];
}

/** Issues are keyed by workspace and id, since two workspaces can hold the same uuid only by accident, but can. */
const keyOf = (workspace: string, id: string): string => `${workspace}\u0000${id}`;

function isWork(issue: AnalyticsIssue): boolean {
  return issue.kind !== "milestone";
}

function indexScope(workspaces: readonly WorkspaceRows[], rules: readonly AgentTypeRule[]): Scope {
  const cap = ANALYTICS_DEFINITIONS.attemptCapHours * 3600;
  const issues: ScopedIssue[] = [];
  const byKey = new Map<string, ScopedIssue>();
  const attempts: ScopedAttempt[] = [];
  for (const workspace of workspaces) {
    for (const issue of workspace.issues) {
      const scoped: ScopedIssue = { ...issue, workspace: workspace.slug, prefix: workspace.prefix };
      issues.push(scoped);
      byKey.set(keyOf(workspace.slug, issue.id), scoped);
    }
    for (const attempt of workspace.attempts) {
      const issue = byKey.get(keyOf(workspace.slug, attempt.issueId));
      const { type, reason } = deriveAgentType(
        {
          agent: attempt.agent,
          role: attempt.role,
          workspace: workspace.prefix,
          kind: issue?.kind ?? "task",
          labels: issue?.labels ?? [],
          title: issue?.title ?? "",
        },
        rules,
      );
      attempts.push({
        ...attempt,
        workspace: workspace.slug,
        issue,
        startMs: ms(attempt.startedAt),
        endMs: Math.max(ms(attempt.endAt), ms(attempt.startedAt)),
        cappedSeconds: Math.min(attempt.effortSeconds, cap),
        type,
        reason,
      });
    }
  }
  const children = new Map<string, ScopedIssue[]>();
  for (const issue of issues) {
    if (issue.parentId === null) continue;
    const key = keyOf(issue.workspace, issue.parentId);
    const list = children.get(key) ?? [];
    list.push(issue);
    children.set(key, list);
  }
  const attemptsOf = new Map<string, ScopedAttempt[]>();
  for (const attempt of attempts) {
    const key = keyOf(attempt.workspace, attempt.issueId);
    const list = attemptsOf.get(key) ?? [];
    list.push(attempt);
    attemptsOf.set(key, list);
  }
  const hasEstimatedDescendant = new Set<string>();
  for (const issue of issues) {
    if (issue.estimatedSeconds === null || issue.estimatedSeconds <= 0 || !isWork(issue)) continue;
    let parent = issue.parentId;
    const seen = new Set<string>();
    while (parent !== null && !seen.has(parent)) {
      seen.add(parent);
      const key = keyOf(issue.workspace, parent);
      hasEstimatedDescendant.add(key);
      parent = byKey.get(key)?.parentId ?? null;
    }
  }
  return { issues, attempts, byKey, children, attemptsOf, hasEstimatedDescendant, slugs: workspaces.map((w) => w.slug), prefixes: new Map(workspaces.map((w) => [w.slug, w.prefix])), rules };
}

function descendantsOf(scope: Scope, issue: ScopedIssue): ScopedIssue[] {
  const out: ScopedIssue[] = [];
  const stack = [...(scope.children.get(keyOf(issue.workspace, issue.id)) ?? [])];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const next = stack.pop()!;
    const key = keyOf(next.workspace, next.id);
    if (seen.has(key)) continue;
    seen.add(key);
    if (isWork(next)) out.push(next);
    stack.push(...(scope.children.get(key) ?? []));
  }
  return out;
}

// ------------------------------------------------------------------ the period

interface Window {
  readonly from: DateKey;
  readonly to: DateKey;
  readonly days: readonly DateKey[];
  /** Local midnight of each day, then of the day after `to`: `days.length + 1` instants. */
  readonly edges: readonly number[];
  readonly startMs: number;
  readonly endMs: number;
}

function windowOf(zone: Zone, from: DateKey, to: DateKey): Window {
  const days = eachDate(from, to);
  const edges = [...days.map((day) => zone.startOf(day)), zone.startOf(nextDate(to))];
  return { from, to, days, edges, startMs: edges[0]!, endMs: edges[edges.length - 1]! };
}

function activitySpan(scope: Scope, zone: Zone): { first: DateKey | null; last: DateKey | null } {
  let first: number | null = null;
  let last: number | null = null;
  const see = (iso: string | null): void => {
    if (iso === null) return;
    const at = ms(iso);
    if (Number.isNaN(at)) return;
    if (first === null || at < first) first = at;
    if (last === null || at > last) last = at;
  };
  for (const issue of scope.issues) {
    see(issue.createdAt);
    see(issue.completedAt);
  }
  for (const attempt of scope.attempts) {
    see(attempt.startedAt);
    see(attempt.endAt);
  }
  return { first: first === null ? null : zone.dateOf(first), last: last === null ? null : zone.dateOf(last) };
}

function bucketOf(raw: string | undefined, days: number): Bucket {
  if (raw === undefined || raw === "") return days <= 92 ? "day" : days <= 731 ? "week" : "month";
  if (!(BUCKETS as readonly string[]).includes(raw)) throw new StapleError("validation", `bucket takes day, week or month; got "${raw}".`);
  return raw as Bucket;
}

function requireDay(raw: string, name: string): DateKey {
  if (!isDateKey(raw)) throw new StapleError("validation", `${name} takes a calendar day YYYY-MM-DD; got "${raw}".`);
  return raw;
}

// ------------------------------------------------------------------ one window's figures

/** Capped effort of `attempt` that falls inside `[from, to)`, spread evenly over its span. */
function cappedWithin(attempt: ScopedAttempt, from: number, to: number): number {
  const span = attempt.endMs - attempt.startMs;
  if (span <= 0) return attempt.startMs >= from && attempt.startMs < to ? attempt.cappedSeconds : 0;
  const overlap = Math.min(attempt.endMs, to) - Math.max(attempt.startMs, from);
  return overlap <= 0 ? 0 : (attempt.cappedSeconds * overlap) / span;
}

function uncappedWithin(attempt: ScopedAttempt, from: number, to: number): number {
  const span = attempt.endMs - attempt.startMs;
  if (span <= 0) return attempt.startMs >= from && attempt.startMs < to ? attempt.effortSeconds : 0;
  const overlap = Math.min(attempt.endMs, to) - Math.max(attempt.startMs, from);
  return overlap <= 0 ? 0 : (attempt.effortSeconds * overlap) / span;
}

/** An attempt runs in `[from, to)` when its span meets the window; an instant attempt when it starts inside. */
function runsWithin(attempt: ScopedAttempt, from: number, to: number): boolean {
  if (attempt.endMs === attempt.startMs) return attempt.startMs >= from && attempt.startMs < to;
  return attempt.startMs < to && attempt.endMs > from;
}

function within(iso: string | null, window: Window): boolean {
  if (iso === null) return false;
  const at = ms(iso);
  return at >= window.startMs && at < window.endMs;
}

/** The index of the day `at` falls on, or -1 outside the window. */
function dayIndex(window: Window, at: number): number {
  if (at < window.startMs || at >= window.endMs) return -1;
  let low = 0;
  let high = window.days.length - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (window.edges[mid]! <= at) low = mid;
    else high = mid - 1;
  }
  return low;
}

interface DayFigures {
  done: number;
  created: number;
  seconds: number;
  peak: number;
  byWorkspace: Map<string, { done: number; seconds: number }>;
}

interface WindowFigures {
  readonly report: Omit<AnalyticsReport, "asOf" | "scope" | "period" | "definitions" | "previous" | "series" | "caveats">;
  readonly headline: AnalyticsHeadline;
  readonly daily: readonly DayFigures[];
  readonly caveats: Caveat[];
}

function isImported(scope: Scope, issue: ScopedIssue): boolean {
  if (issue.completedAt === null) return false;
  if ((scope.attemptsOf.get(keyOf(issue.workspace, issue.id))?.length ?? 0) > 0) return false;
  return ms(issue.completedAt) - ms(issue.createdAt) <= ANALYTICS_DEFINITIONS.importWindowSeconds * 1000;
}

function computeWindow(scope: Scope, window: Window, zone: Zone): WindowFigures {
  const daily: DayFigures[] = window.days.map(() => ({ done: 0, created: 0, seconds: 0, peak: 0, byWorkspace: new Map() }));
  const dayWorkspace = (day: DayFigures, slug: string): { done: number; seconds: number } => {
    const held = day.byWorkspace.get(slug) ?? { done: 0, seconds: 0 };
    day.byWorkspace.set(slug, held);
    return held;
  };

  // ---- tickets
  const work = scope.issues.filter(isWork);
  const done = work.filter((issue) => issue.category === "done" && within(issue.completedAt, window));
  const doneKeys = new Set(done.map((issue) => keyOf(issue.workspace, issue.id)));
  const created = work.filter((issue) => within(issue.createdAt, window));
  const cancelled = work.filter((issue) => issue.category === "cancelled" && within(issue.cancelledAt, window));
  const byKind: Record<string, number> = {};
  const byPriority: Record<string, number> = {};
  for (const issue of done) {
    increment(byKind, issue.kind);
    increment(byPriority, issue.priority);
    const index = dayIndex(window, ms(issue.completedAt!));
    if (index >= 0) {
      daily[index]!.done += 1;
      dayWorkspace(daily[index]!, issue.workspace).done += 1;
    }
  }
  for (const issue of created) {
    const index = dayIndex(window, ms(issue.createdAt));
    if (index >= 0) daily[index]!.created += 1;
  }
  const openNow: Record<string, number> = {};
  for (const issue of work) {
    if (issue.category === "done" || issue.category === "cancelled") continue;
    increment(openNow, issue.category ?? "unknown");
  }
  let bestDay: { date: DateKey; done: number } | null = null;
  for (const [index, day] of daily.entries()) {
    if (day.done > 0 && (bestDay === null || day.done > bestDay.done)) bestDay = { date: window.days[index]!, done: day.done };
  }
  const epicsDone = done.filter((issue) => issue.kind === "epic").length;
  const epicsDoneHere = new Set(done.filter((issue) => issue.kind === "epic").map((issue) => keyOf(issue.workspace, issue.identifier)));
  const bugsFixed = done.filter((issue) => issue.kind === "bug").length;

  // ---- attempts
  const running = scope.attempts.filter((attempt) => runsWithin(attempt, window.startMs, window.endMs));
  let agentSeconds = 0;
  let uncappedSeconds = 0;
  let orchestrationSeconds = 0;
  for (const attempt of running) {
    const inside = cappedWithin(attempt, window.startMs, window.endMs);
    agentSeconds += inside;
    uncappedSeconds += uncappedWithin(attempt, window.startMs, window.endMs);
    if (attempt.role === "orchestrator") orchestrationSeconds += inside;
    const first = Math.max(0, dayIndex(window, Math.max(attempt.startMs, window.startMs)));
    for (let index = first; index < window.days.length; index += 1) {
      const from = window.edges[index]!;
      const to = window.edges[index + 1]!;
      if (from >= attempt.endMs && attempt.endMs !== attempt.startMs) break;
      const seconds = cappedWithin(attempt, from, to);
      if (seconds > 0 || runsWithin(attempt, from, to)) {
        daily[index]!.seconds += seconds;
        dayWorkspace(daily[index]!, attempt.workspace).seconds += seconds;
      }
      if (attempt.endMs === attempt.startMs) break;
    }
  }
  const activeDays = window.days.filter((_, index) =>
    running.some((attempt) => runsWithin(attempt, window.edges[index]!, window.edges[index + 1]!)),
  ).length;

  // Concurrency: half-open spans, so an end and a start at one instant do not overlap.
  const events: Array<[number, number]> = [];
  for (const attempt of running) {
    if (attempt.endMs === attempt.startMs) continue;
    events.push([Math.max(attempt.startMs, window.startMs), 1], [Math.min(attempt.endMs, window.endMs), -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let current = 0;
  let peak = 0;
  let peakAt: number | null = null;
  let cursor = 0;
  for (const [index, day] of daily.entries()) {
    const end = window.edges[index + 1]!;
    day.peak = current;
    while (cursor < events.length && events[cursor]![0] < end) {
      current += events[cursor]![1];
      if (current > day.peak) day.peak = current;
      if (current > peak) {
        peak = current;
        peakAt = events[cursor]![0];
      }
      cursor += 1;
    }
  }

  const models = new Map<string, { model: string | null; harness: string | null; attempts: number; completed: number; seconds: number }>();
  for (const attempt of running) {
    const key = `${attempt.model ?? ""}\u0000${attempt.harness ?? ""}`;
    const held = models.get(key) ?? { model: attempt.model, harness: attempt.harness, attempts: 0, completed: 0, seconds: 0 };
    held.attempts += 1;
    if (attempt.standing === "completed") held.completed += 1;
    held.seconds += cappedWithin(attempt, window.startMs, window.endMs);
    models.set(key, held);
  }
  const byModel: ModelRow[] = [...models.values()]
    .map(({ seconds, ...row }) => ({ ...row, agentHours: round2(hours(seconds)) }))
    .sort((a, b) => b.attempts - a.attempts || b.agentHours - a.agentHours || String(a.model).localeCompare(String(b.model)));

  const agentHours = hours(agentSeconds);
  const periodWeeks = window.days.length / 7;
  const ftePeriod = window.days.length > 0 ? agentHours / (periodWeeks * ANALYTICS_DEFINITIONS.fteHoursPerWeek) : null;
  const fteActiveDays = activeDays > 0 ? agentHours / (activeDays * ANALYTICS_DEFINITIONS.fteHoursPerDay) : null;

  // ---- speed
  const settled = done.filter((issue) => !isImported(scope, issue));
  const cycle: number[] = [];
  const cycleByKindValues = new Map<string, number[]>();
  for (const issue of settled) {
    if (issue.startedAt === null) continue;
    const span = ms(issue.completedAt!) - ms(issue.startedAt);
    if (span < 0) continue;
    const value = hours(span / 1000);
    cycle.push(value);
    const list = cycleByKindValues.get(issue.kind) ?? [];
    list.push(value);
    cycleByKindValues.set(issue.kind, list);
  }
  const lead = settled.map((issue) => hours((ms(issue.completedAt!) - ms(issue.createdAt)) / 1000)).filter((value) => value >= 0);
  const histogram: HistogramBin[] = HISTOGRAM.map(([label, min, max]) => ({
    label,
    minHours: min,
    maxHours: max,
    count: cycle.filter((value) => value >= min && (max === null || value < max)).length,
  }));
  const cycleByKind: Record<string, { n: number; medianHours: number | null }> = {};
  for (const [kind, values] of [...cycleByKindValues.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    cycleByKind[kind] = { n: values.length, medianHours: round2OrNull(lowerQuantile(values, 0.5)) };
  }
  const effortPerTicket = done
    .map((issue) => (scope.attemptsOf.get(keyOf(issue.workspace, issue.id)) ?? []).reduce((sum, attempt) => sum + attempt.cappedSeconds, 0))
    .filter((seconds) => seconds > 0)
    .map(hours);

  // ---- reliability
  const started = scope.attempts.filter((attempt) => attempt.startMs >= window.startMs && attempt.startMs < window.endMs);
  const outcomes = Object.fromEntries(STANDINGS.map((standing) => [standing, 0])) as Record<AttemptStandingId, number>;
  for (const attempt of started) outcomes[attempt.standing] += 1;
  const ended = started.length - outcomes.open;
  const successRate = ended > 0 ? outcomes.completed / ended : null;

  // ---- estimates
  const planned = done.filter(
    (issue) => issue.estimatedSeconds !== null && issue.estimatedSeconds > 0 && !scope.hasEstimatedDescendant.has(keyOf(issue.workspace, issue.id)),
  );
  const plannedSeconds = planned.reduce((sum, issue) => sum + issue.estimatedSeconds!, 0);
  const ratios: number[] = [];
  let pairEstimate = 0;
  let pairWork = 0;
  for (const issue of done) {
    if (issue.estimatedSeconds === null || issue.estimatedSeconds <= 0) continue;
    const work = (scope.attemptsOf.get(keyOf(issue.workspace, issue.id)) ?? []).reduce((sum, attempt) => sum + attempt.effortSeconds, 0);
    if (work <= 0) continue;
    ratios.push(work / issue.estimatedSeconds);
    pairEstimate += issue.estimatedSeconds;
    pairWork += work;
  }

  // ---- rhythm
  const heatmap = Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0));
  let night = 0;
  let weekend = 0;
  for (const issue of done) {
    const parts = zone.parts(issue.completedAt!);
    heatmap[parts.weekday]![parts.hour]! += 1;
    if (parts.hour < 6 || parts.hour >= 22) night += 1;
    if (parts.weekday >= 5) weekend += 1;
  }

  // ---- epics and workspaces
  const epics: EpicRow[] = [];
  for (const epic of work) {
    if (epic.kind !== "epic") continue;
    const descendants = descendantsOf(scope, epic);
    const doneDescendants = descendants.filter((issue) => issue.category === "done" && issue.completedAt !== null);
    const doneInPeriod = doneDescendants.filter((issue) => doneKeys.has(keyOf(issue.workspace, issue.id))).length;
    const epicDoneHere = doneKeys.has(keyOf(epic.workspace, epic.id));
    if (doneInPeriod === 0 && !epicDoneHere) continue;
    const subtree = [epic, ...descendants];
    const seconds = subtree.reduce(
      (sum, issue) => sum + (scope.attemptsOf.get(keyOf(issue.workspace, issue.id)) ?? []).reduce((inner, attempt) => inner + attempt.cappedSeconds, 0),
      0,
    );
    const createdTimes = descendants.map((issue) => ms(issue.createdAt));
    const doneTimes = doneDescendants.map((issue) => ms(issue.completedAt!));
    epics.push({
      workspace: epic.workspace,
      identifier: epic.identifier,
      title: epic.title,
      status: epic.status,
      category: epic.category,
      descendants: descendants.length,
      descendantsDone: doneDescendants.length,
      doneInPeriod,
      startedOn: zone.dateOf(createdTimes.length > 0 ? Math.min(...createdTimes) : ms(epic.createdAt)),
      lastDoneOn: doneTimes.length > 0 ? zone.dateOf(Math.max(...doneTimes)) : null,
      completedOn: epic.category === "done" && epic.completedAt !== null ? zone.dateOf(epic.completedAt) : null,
      agentHours: round2(hours(seconds)),
    });
  }
  epics.sort((a, b) => b.doneInPeriod - a.doneInPeriod || b.descendantsDone - a.descendantsDone || a.identifier.localeCompare(b.identifier));

  const workspaces: WorkspaceRow[] = scope.slugs.map((slug) => {
    const mine = work.filter((issue) => issue.workspace === slug);
    const myDone = done.filter((issue) => issue.workspace === slug);
    const mySpan = activitySpan(
      { ...scope, issues: mine, attempts: scope.attempts.filter((attempt) => attempt.workspace === slug) },
      zone,
    );
    const myRunning = running.filter((attempt) => attempt.workspace === slug);
    return {
      slug,
      prefix: scope.prefixes.get(slug) ?? slug,
      done: myDone.length,
      created: created.filter((issue) => issue.workspace === slug).length,
      bugsFixed: myDone.filter((issue) => issue.kind === "bug").length,
      epicsDone: myDone.filter((issue) => issue.kind === "epic").length,
      agentHours: round2(hours(myRunning.reduce((sum, attempt) => sum + cappedWithin(attempt, window.startMs, window.endMs), 0))),
      activeDays: window.days.filter((_, index) => myRunning.some((attempt) => runsWithin(attempt, window.edges[index]!, window.edges[index + 1]!))).length,
      firstActivity: mySpan.first,
      lastActivity: mySpan.last,
      features: epics
        .filter((epic) => epic.workspace === slug && epicsDoneHere.has(keyOf(slug, epic.identifier)))
        .sort((a, b) => b.descendantsDone - a.descendantsDone || a.identifier.localeCompare(b.identifier))
        .slice(0, 5)
        .map((epic) => ({ identifier: epic.identifier, title: epic.title, descendantsDone: epic.descendantsDone })),
    };
  });

  // ---- sprints: runs of completion days split by more than `sprintGapDays` quiet days
  const sprints: SprintRow[] = [];
  const completionDays = window.days.map((day, index) => ({ day, index })).filter(({ index }) => daily[index]!.done > 0);
  let run: Array<{ day: DateKey; index: number }> = [];
  const closeRun = (): void => {
    if (run.length === 0) return;
    const first = run[0]!;
    const last = run[run.length - 1]!;
    const doneCount = run.reduce((sum, { index }) => sum + daily[index]!.done, 0);
    if (doneCount >= ANALYTICS_DEFINITIONS.sprintMinDone) {
      let seconds = 0;
      const perWorkspace: Record<string, number> = {};
      for (let index = first.index; index <= last.index; index += 1) {
        seconds += daily[index]!.seconds;
        for (const [slug, figures] of daily[index]!.byWorkspace) if (figures.done > 0) increment(perWorkspace, slug, figures.done);
      }
      const best = run.reduce((top, entry) => (daily[entry.index]!.done > daily[top.index]!.done ? entry : top), first);
      sprints.push({
        start: first.day,
        end: last.day,
        days: daysBetween(first.day, last.day),
        done: doneCount,
        agentHours: round2(hours(seconds)),
        bestDay: { date: best.day, done: daily[best.index]!.done },
        features: epics
          .filter((epic) => epic.completedOn !== null && epic.completedOn >= first.day && epic.completedOn <= last.day && epic.descendantsDone >= 3)
          .sort((a, b) => b.descendantsDone - a.descendantsDone || a.identifier.localeCompare(b.identifier))
          .slice(0, 3)
          .map((epic) => ({ workspace: epic.workspace, identifier: epic.identifier, title: epic.title, descendantsDone: epic.descendantsDone })),
        workspaces: Object.entries(perWorkspace)
          .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
          .map(([slug]) => slug),
      });
    }
    run = [];
  };
  for (const entry of completionDays) {
    const previous = run[run.length - 1];
    if (previous !== undefined && daysBetween(previous.day, entry.day) - 1 > ANALYTICS_DEFINITIONS.sprintGapDays) closeRun();
    run.push(entry);
  }
  closeRun();

  // ---- agent types and agents
  const typeRows = new Map<AgentType, { attempts: number; seconds: number; plannedSeconds: number; plannedTickets: number; reasons: Record<string, number>; agents: Record<string, number> }>();
  const typeRow = (type: AgentType) => {
    const held = typeRows.get(type) ?? { attempts: 0, seconds: 0, plannedSeconds: 0, plannedTickets: 0, reasons: {}, agents: {} };
    typeRows.set(type, held);
    return held;
  };
  for (const attempt of running) {
    const row = typeRow(attempt.type);
    row.attempts += 1;
    row.seconds += cappedWithin(attempt, window.startMs, window.endMs);
    increment(row.reasons, attempt.reason.code);
    increment(row.agents, attempt.agent);
  }
  for (const issue of planned) {
    const type = plannedTypeOf(scope, issue, scope.rules);
    const row = typeRow(type);
    row.plannedSeconds += issue.estimatedSeconds!;
    row.plannedTickets += 1;
  }
  const agentTypes: AgentTypeRow[] = AGENT_TYPES.filter((type) => typeRows.has(type)).map((type) => {
    const row = typeRows.get(type)!;
    return {
      type,
      attempts: row.attempts,
      agentHours: round2(hours(row.seconds)),
      plannedHours: round2(hours(row.plannedSeconds)),
      plannedTickets: row.plannedTickets,
      reasons: row.reasons,
      topAgents: Object.entries(row.agents)
        .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
        .slice(0, 5)
        .map(([name, attempts]) => ({ name, attempts })),
    };
  });

  const agentGroups = new Map<string, ScopedAttempt[]>();
  for (const attempt of running) {
    const list = agentGroups.get(attempt.agent) ?? [];
    list.push(attempt);
    agentGroups.set(attempt.agent, list);
  }
  const agents: AgentRow[] = [...agentGroups.entries()]
    .map(([name, list]) => {
      const counts: Partial<Record<AgentType, number>> = {};
      for (const attempt of list) counts[attempt.type] = (counts[attempt.type] ?? 0) + 1;
      const type = AGENT_TYPES.reduce<AgentType>((top, candidate) => ((counts[candidate] ?? 0) > (counts[top] ?? 0) ? candidate : top), list[0]!.type);
      const typed = list.find((attempt) => attempt.type === type)!;
      return {
        name,
        attempts: list.length,
        agentHours: round2(hours(list.reduce((sum, attempt) => sum + cappedWithin(attempt, window.startMs, window.endMs), 0))),
        type,
        reason: { code: typed.reason.code, detail: typed.reason.detail },
        mixed: Object.keys(counts).length > 1,
      };
    })
    .sort((a, b) => b.attempts - a.attempts || a.name.localeCompare(b.name));

  // ---- caveats
  const caveats: Caveat[] = [];
  const caveat = (code: Caveat["code"], count: number, of: number | null): void => {
    if (count > 0) caveats.push({ code, count, of });
  };
  caveat("no_model", running.filter((attempt) => attempt.model === null).length, running.length);
  caveat("reconstructed", running.filter((attempt) => attempt.provenance === "reconstructed").length, running.length);
  caveat("open_attempts", running.filter((attempt) => attempt.standing === "open" || attempt.standing === "orphaned").length, running.length);
  caveat("capped_attempts", running.filter((attempt) => attempt.effortSeconds > attempt.cappedSeconds).length, running.length);
  caveat("done_without_agent_time", done.filter((issue) => (scope.attemptsOf.get(keyOf(issue.workspace, issue.id))?.length ?? 0) === 0).length, done.length);
  caveat("closed_on_import", done.length - settled.length, done.length);
  caveat("estimates_partial", done.length - planned.length > 0 && planned.length > 0 ? done.length - planned.length : 0, done.length);

  const medianCycle = lowerQuantile(cycle, 0.5);
  const headline: AnalyticsHeadline = {
    done: done.length,
    epicsDone,
    bugsFixed,
    agentHours: round2(agentHours),
    ftePeriod: ftePeriod === null ? null : round2(ftePeriod),
    peakConcurrency: peak,
    medianCycleHours: round2OrNull(medianCycle),
    attemptSuccessRate: successRate,
    plannedHours: round2(hours(plannedSeconds)),
  };

  return {
    headline,
    daily,
    caveats,
    report: {
      headline,
      delivery: {
        done: done.length,
        created: created.length,
        cancelled: cancelled.length,
        byKind,
        byPriority,
        epicsDone,
        bugsFixed,
        daysWithDone: daily.filter((day) => day.done > 0).length,
        bestDay,
        openNow,
      },
      capacity: {
        agentHours: round2(agentHours),
        agentHoursUncapped: round2(hours(uncappedSeconds)),
        orchestrationHours: round2(hours(orchestrationSeconds)),
        attempts: running.length,
        attemptsCapped: running.filter((attempt) => attempt.effortSeconds > attempt.cappedSeconds).length,
        agents: agentGroups.size,
        activeDays,
        ftePeriod: ftePeriod === null ? null : round2(ftePeriod),
        fteActiveDays: fteActiveDays === null ? null : round2(fteActiveDays),
        workWeeks: round2(agentHours / ANALYTICS_DEFINITIONS.fteHoursPerWeek),
        peakConcurrency: { count: peak, at: peakAt === null ? null : new Date(peakAt).toISOString() },
        byModel,
      },
      speed: {
        cycle: {
          n: cycle.length,
          medianHours: round2OrNull(medianCycle),
          p25Hours: round2OrNull(lowerQuantile(cycle, 0.25)),
          p75Hours: round2OrNull(lowerQuantile(cycle, 0.75)),
          under1h: cycle.filter((value) => value < 1).length,
          under4h: cycle.filter((value) => value < 4).length,
        },
        lead: { n: lead.length, medianHours: round2OrNull(lowerQuantile(lead, 0.5)), within24h: lead.filter((value) => value < 24).length },
        histogram,
        cycleByKind,
        effortPerTicket: { n: effortPerTicket.length, medianHours: round2OrNull(lowerQuantile(effortPerTicket, 0.5)) },
      },
      reliability: { started: started.length, outcomes, successRate },
      estimates: {
        planned: { hours: round2(hours(plannedSeconds)), tickets: planned.length, ofDone: done.length },
        pairs: {
          n: ratios.length,
          estimateHours: round2(hours(pairEstimate)),
          workHours: round2(hours(pairWork)),
          medianRatio: lowerQuantile(ratios, 0.5),
          underEstimate: ratios.filter((ratio) => ratio < 1).length,
        },
      },
      rhythm: { heatmap, night, weekend },
      epics,
      workspaces,
      sprints,
      agentTypes,
      agents,
    },
  };
}

function round2OrNull(value: number | null): number | null {
  return value === null ? null : round2(value);
}

/**
 * The type a planned ticket's hours are priced as: the type of the attempt that did most of
 * its work, or, for a ticket no agent worked, the type its own kind, labels and title give.
 */
export function plannedTypeOf(scope: Pick<Scope, "attemptsOf">, issue: ScopedIssue, rules: readonly AgentTypeRule[] = []): AgentType {
  const attempts = scope.attemptsOf.get(keyOf(issue.workspace, issue.id)) ?? [];
  if (attempts.length > 0) {
    return attempts.reduce((top, attempt) => (attempt.effortSeconds > top.effortSeconds ? attempt : top), attempts[0]!).type;
  }
  return deriveAgentType({ agent: "", role: "worker", workspace: issue.prefix, kind: issue.kind, labels: issue.labels, title: issue.title }, rules).type;
}

function seriesOf(window: Window, daily: readonly DayFigures[], bucket: Bucket): SeriesPoint[] {
  const keyFor = (day: DateKey): string => {
    if (bucket === "day") return day;
    if (bucket === "month") return day.slice(0, 7);
    const weekday = (new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7;
    return new Date(Date.parse(`${day}T00:00:00Z`) - weekday * 86_400_000).toISOString().slice(0, 10);
  };
  const out: Array<{ key: string; start: DateKey; end: DateKey; done: number; created: number; seconds: number; peak: number; byWorkspace: Map<string, { done: number; seconds: number }> }> = [];
  for (const [index, day] of window.days.entries()) {
    const figures = daily[index]!;
    const key = keyFor(day);
    let point = out[out.length - 1];
    if (point === undefined || point.key !== key) {
      point = { key, start: day, end: day, done: 0, created: 0, seconds: 0, peak: 0, byWorkspace: new Map() };
      out.push(point);
    }
    point.end = day;
    point.done += figures.done;
    point.created += figures.created;
    point.seconds += figures.seconds;
    point.peak = Math.max(point.peak, figures.peak);
    for (const [slug, held] of figures.byWorkspace) {
      const into = point.byWorkspace.get(slug) ?? { done: 0, seconds: 0 };
      into.done += held.done;
      into.seconds += held.seconds;
      point.byWorkspace.set(slug, into);
    }
  }
  return out.map((point) => ({
    start: point.start,
    end: point.end,
    done: point.done,
    created: point.created,
    agentHours: round2(hours(point.seconds)),
    peakConcurrency: point.peak,
    byWorkspace: Object.fromEntries(
      [...point.byWorkspace.entries()]
        .filter(([, held]) => held.done > 0 || held.seconds > 0)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([slug, held]) => [slug, { done: held.done, agentHours: round2(hours(held.seconds)) }]),
    ),
  }));
}

/** The resolved period, its zone and its windows: what both the report and the ROI read stand on. */
export interface ResolvedPeriod {
  readonly period: AnalyticsPeriod;
  readonly zone: Zone;
  readonly window: Window;
  readonly previous: Window | null;
}

export function resolvePeriod(workspaces: readonly WorkspaceRows[], query: AnalyticsQuery): ResolvedPeriod {
  const zone = Zone.of(query.tz);
  const scope = indexScope(workspaces, []);
  const span = activitySpan(scope, zone);
  const today = zone.dateOf(query.now);
  const explicit = query.from !== undefined && query.from !== "";
  const from = explicit ? requireDay(query.from!, "from") : (span.first ?? today);
  const to = query.to !== undefined && query.to !== "" ? requireDay(query.to, "to") : today < from ? from : today;
  if (to < from) throw new StapleError("validation", `to (${to}) is before from (${from}).`);
  const days = daysBetween(from, to);
  if (days > MAX_PERIOD_DAYS) throw new StapleError("validation", `A period covers at most ${MAX_PERIOD_DAYS} days; ${from} to ${to} is ${days}.`);
  const bucket = bucketOf(query.bucket, days);
  const window = windowOf(zone, from, to);
  let previous: Window | null = null;
  if (explicit) {
    const previousTo = new Date(Date.parse(`${from}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    const previousFrom = new Date(Date.parse(`${from}T00:00:00Z`) - days * 86_400_000).toISOString().slice(0, 10);
    previous = windowOf(zone, previousFrom, previousTo);
  }
  return {
    period: { from, to, tz: zone.name, days, bucket, explicit, firstActivity: span.first, lastActivity: span.last },
    zone,
    window,
    previous,
  };
}

/** The whole report. `refs` names every workspace the scope covers, unavailable ones included. */
export function analyticsReport(
  workspaces: readonly WorkspaceRows[],
  scopeInfo: { kind: "hub" | "workspace"; workspaces: readonly AnalyticsWorkspaceRef[] },
  query: AnalyticsQuery,
): AnalyticsReport {
  const resolved = resolvePeriod(workspaces, query);
  const scope = indexScope(workspaces, query.rules ?? []);
  const current = computeWindow(scope, resolved.window, resolved.zone);
  const previous = resolved.previous === null ? null : computeWindow(scope, resolved.previous, resolved.zone);
  const unavailable = scopeInfo.workspaces.filter((ref) => !ref.available).length;
  const caveats = [...current.caveats];
  if (unavailable > 0) caveats.push({ code: "workspace_unavailable", count: unavailable, of: scopeInfo.workspaces.length });
  return {
    asOf: query.now,
    scope: { kind: scopeInfo.kind, workspaces: scopeInfo.workspaces },
    period: resolved.period,
    definitions: ANALYTICS_DEFINITIONS,
    previous: previous === null || resolved.previous === null ? null : { from: resolved.previous.from, to: resolved.previous.to, headline: previous.headline },
    series: seriesOf(resolved.window, current.daily, resolved.period.bucket),
    ...current.report,
    caveats,
  };
}

/**
 * Hours by agent type for one window, both lenses: the ROI read's input. Measured: capped
 * agent-hours of the attempts that ran, by the attempt's type. Planned: planned hours of the
 * tickets done, by `plannedTypeOf`.
 */
export function hoursByType(
  workspaces: readonly WorkspaceRows[],
  resolved: ResolvedPeriod,
  rules: readonly AgentTypeRule[],
): { measured: Record<AgentType, number>; planned: Record<AgentType, number>; agentHours: number; activeDays: number } {
  const scope = indexScope(workspaces, rules);
  const figures = computeWindow(scope, resolved.window, resolved.zone);
  const measured = Object.fromEntries(AGENT_TYPES.map((type) => [type, 0])) as Record<AgentType, number>;
  const planned = Object.fromEntries(AGENT_TYPES.map((type) => [type, 0])) as Record<AgentType, number>;
  for (const row of figures.report.agentTypes) {
    measured[row.type] = row.agentHours;
    planned[row.type] = row.plannedHours;
  }
  return { measured, planned, agentHours: figures.headline.agentHours, activeDays: figures.report.capacity.activeDays };
}
