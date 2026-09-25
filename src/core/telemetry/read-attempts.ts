/**
 * The attempt read surfaces (docs/execution-telemetry.md, "Surfaces"): the summary on
 * `show`/`get_task`, the bounded list behind `staple attempts`/`list_attempts`, and the one
 * attempt behind `staple attempt <id>`/`get_attempt`.
 *
 * Pure reads. Every attempt is shown as it reads — the effective state from the read-time
 * orphan rule (`attempt-derive.ts`), with `storedState` beside it — and nothing here writes a
 * stored orphan end or anything else: read surfaces never write to the journal.
 */
import type { DatabaseSync } from "node:sqlite";
import { StapleError, nowIso } from "../types.js";
import { openedHere, transitionsOf, type AttemptTransition } from "./attempt-records.js";
import { resumeGapsOf, viewsOfIssue, type AttemptView } from "./attempt-derive.js";
import { inferredEndsOf, issueEffort } from "./effort.js";
import { attemptBurn, type AttemptBurn } from "./read-budget.js";
import { qualifyAttempts, type QualifiedAttempt } from "./attempt-quality.js";
import {
  afterPosition,
  coverage,
  cutPage,
  decodeKeysetCursor,
  pageLimit,
  type CoverageGap,
  type KeysetPosition,
  type PageRequest,
  type TelemetryPage,
} from "./read-page.js";

/**
 * The worker lane (docs/timing-semantics.md, "The orchestrator lane"): the read summary
 * `attempts: {current, last, count}` describes worker attempts only. An attempt with no
 * `role` is a worker attempt, as every attempt opened by checkout, a steal, a re-claim or a
 * status write is. This is the ONE predicate the summary filters on.
 */
export const inWorkerLane = (attempt: { readonly id: string; readonly role?: string | null }): boolean => (attempt.role ?? "worker") === "worker";

export interface AttemptSummary {
  /** The effectively open worker attempt, or null. */
  readonly current: QualifiedAttempt | null;
  /** The newest effectively ended worker attempt, or null when none has ended. */
  readonly last: QualifiedAttempt | null;
  /** Worker attempts on the issue, every state. */
  readonly count: number;
}

/** `attempts` on `show`/`get_task`: derived at read, worker lane only. */
export function attemptSummary(db: DatabaseSync, issueId: string, now: string = nowIso()): AttemptSummary {
  const views = viewsOfIssue(db, issueId, now).filter(inWorkerLane);
  const newestFirst = [...views].reverse();
  const current = newestFirst.find((view) => view.state !== "ended") ?? null;
  const last = newestFirst.find((view) => view.state === "ended") ?? null;
  const [qualifiedCurrent = null, qualifiedLast = null] = (() => {
    const shown = [current, last].filter((view): view is AttemptView => view !== null);
    const read = new Map(qualifyAttempts(db, issueId, shown).map((attempt) => [attempt.id, attempt]));
    return [current === null ? null : read.get(current.id)!, last === null ? null : read.get(last.id)!];
  })();
  return { current: qualifiedCurrent, last: qualifiedLast, count: views.length };
}

const attemptKey = (view: AttemptView): KeysetPosition => ({ at: view.startedAt, id: view.id });

/**
 * The last instant an attempt's record speaks for: its end, the bound of a derived end, or,
 * while it runs, its last activity (`countedThrough`) — the newest evidence, not the clock.
 */
function endOfView(view: AttemptView): string {
  return view.endedAt ?? view.endedAtBound ?? view.lastActivityAt;
}

/**
 * The span of an issue that capture never saw: from the issue's start to the first attempt
 * recorded anywhere in this workspace (capture began no later than that), or to the issue's
 * end. Reconstructed attempts do not close it: they are backfilled from events, and capture
 * did not run.
 */
function beforeCaptureGap(db: DatabaseSync, issueId: string, now: string): CoverageGap | null {
  const issue = db.prepare("SELECT started_at, completed_at, cancelled_at FROM issues WHERE id = ?").get(issueId) as
    | { started_at: string | null; completed_at: string | null; cancelled_at: string | null }
    | undefined;
  if (!issue || issue.started_at === null) return null;
  const began = (db.prepare("SELECT MIN(started_at) AS t FROM attempts WHERE provenance = 'recorded'").get() as { t: string | null }).t;
  if (began !== null && began <= issue.started_at) return null;
  const issueEnd = issue.completed_at ?? issue.cancelled_at ?? now;
  const to = began !== null && began < issueEnd ? began : issueEnd;
  return to > issue.started_at ? { from: issue.started_at, to, reason: "before_capture_began" } : null;
}

/**
 * `staple attempts <ref>` / `list_attempts`: the issue's attempts, oldest first (the order
 * `ordinal` counts in), every lane, each as it reads with `storedState` beside it.
 */
export function listAttempts(db: DatabaseSync, issueId: string, request: PageRequest = {}, now: string = nowIso()): TelemetryPage<QualifiedAttempt> {
  const limit = pageLimit(request.limit);
  const scope = { issueId };
  const position = request.cursor === undefined ? null : decodeKeysetCursor("attempts", scope, request.cursor);
  const rows = viewsOfIssue(db, issueId, now).filter((view) => afterPosition(attemptKey(view), position));
  const cut = cutPage(rows, limit, "attempts", scope, attemptKey);
  const page = { ...cut, items: qualifyAttempts(db, issueId, cut.items) };
  const gaps: CoverageGap[] = [];
  let from: string | null = page.items[0]?.startedAt ?? null;
  let to: string | null = page.items.length === 0 ? null : page.items.map((view) => endOfView(view)).reduce((a, b) => (a > b ? a : b));
  if (position === null) {
    const gap = beforeCaptureGap(db, issueId, now);
    if (gap !== null) {
      gaps.push(gap);
      if (from === null || gap.from < from) from = gap.from;
      if (to === null || gap.to > to) to = gap.to;
    }
  }
  // A page that speaks for no span says why, with the timing contract's codes for an issue
  // without attempts (docs/timing-semantics.md, "Missingness for the new fields"): it never
  // started, or it has a start and no attempt, which capture began too late to see or a
  // derived flip opened without one.
  const started = (db.prepare("SELECT started_at FROM issues WHERE id = ?").get(issueId) as { started_at: string | null } | undefined)?.started_at ?? null;
  return { ...page, coverage: coverage(from, to, page.items.length, gaps, started === null ? "never_started" : "no_worker_attempt") };
}

/** One entry of an attempt's `chain`: enough to read every interruption boundary at once. */
export interface ChainEntry {
  readonly id: string;
  readonly ordinal: number;
  readonly agent: string;
  readonly state: string;
  readonly outcome: string | null;
  readonly endReason: string | null;
  readonly resumesAttemptId: string | null;
  readonly startedAt: string;
  readonly endedAt: string | null;
  /**
   * `docs/timing-semantics.md`, `resumeGapSeconds`: from this attempt's end to the start of the
   * attempt that resumed it. Null when nothing has resumed it yet.
   */
  readonly resumeGapSeconds: number | null;
}

export interface AttemptDetail {
  readonly attempt: QualifiedAttempt;
  readonly transitions: TelemetryPage<AttemptTransition>;
  readonly chain: ChainEntry[];
  readonly burn: AttemptBurn;
}

const transitionKey = (transition: AttemptTransition): KeysetPosition => ({ at: transition.at, id: transition.id });

/**
 * `staple attempt <attempt-id>` / `get_attempt`: the attempt as it reads, its transitions
 * (bounded, oldest first), its chain (the attempts linked by `resumesAttemptId`, oldest
 * first) and its burn, derived from this machine's budget samples.
 */
export function attemptDetail(
  db: DatabaseSync,
  attemptId: string,
  context: { home: string; device: string | null; slug: string; now?: string } & PageRequest,
): AttemptDetail {
  const now = context.now ?? nowIso();
  const row = db.prepare("SELECT issue_id FROM attempts WHERE id = ?").get(attemptId) as { issue_id: string } | undefined;
  if (!row) throw new StapleError("not_found", `No attempt "${attemptId}" in workspace ${context.slug}. Attempt ids are the \`id\` field of an attempt.`);
  const views = viewsOfIssue(db, row.issue_id, now);
  const attempt = views.find((view) => view.id === attemptId)!;

  const limit = pageLimit(context.limit);
  const scope = { attemptId };
  const position = context.cursor === undefined ? null : decodeKeysetCursor("transitions", scope, context.cursor);
  const all = transitionsOf(db, attemptId);
  const page = cutPage(
    all.filter((transition) => afterPosition(transitionKey(transition), position)),
    limit,
    "transitions",
    scope,
    transitionKey,
  );
  const gaps: CoverageGap[] = [];
  // A reconstructed attempt was backfilled from events and has no transitions at all.
  if (attempt.provenance === "reconstructed" && position === null) {
    gaps.push({ from: attempt.startedAt, to: endOfView(attempt), reason: "before_capture_began" });
  }
  const transitions: TelemetryPage<AttemptTransition> = {
    ...page,
    coverage: coverage(
      position?.at ?? attempt.startedAt,
      page.truncated ? page.items[page.items.length - 1]!.at : [endOfView(attempt), ...page.items.map((t) => t.at)].reduce((a, b) => (a > b ? a : b)),
      page.items.length,
      gaps,
      "no_sample_yet",
    ),
  };

  const byId = new Map(views.map((view) => [view.id, view]));
  const resumeGaps = new Map(resumeGapsOf(views, inferredEndsOf(views, issueEffort(db, row.issue_id).workers)).map((gap) => [gap.attemptId, gap.resumeGapSeconds]));
  const chain = attempt.chain
    .map((id) => byId.get(id))
    .filter((view): view is AttemptView => view !== undefined)
    .map((view) => ({
      id: view.id,
      ordinal: view.ordinal,
      agent: view.agent,
      state: view.state,
      outcome: view.outcome,
      endReason: view.endReason,
      resumesAttemptId: view.resumesAttemptId,
      startedAt: view.startedAt,
      endedAt: view.endedAt,
      resumeGapSeconds: resumeGaps.get(view.id) ?? null,
    }));

  const burn = attemptBurn(context.home, attempt, {
    openedHere: openedHere(db, attempt, context.device),
    transitions: all,
    now,
  });
  return { attempt: qualifyAttempts(db, row.issue_id, [attempt])[0]!, transitions, chain, burn };
}
