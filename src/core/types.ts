/**
 * Core vocabulary: the statuses, priorities, and guard semantics every surface
 * — CLI, MCP, HTTP, UI — agrees on. Defined once, here.
 */
import { createHash } from "node:crypto";

export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "blocked",
  "cancelled",
] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const OPEN_STATUSES: readonly IssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "blocked",
];
export const RESOLVED_STATUSES: readonly IssueStatus[] = ["done", "cancelled"];

/** Pickup order for the agent inbox: current work first, then reviews, then queue. */
export const INBOX_PICKUP_ORDER: readonly IssueStatus[] = [
  "in_progress",
  "in_review",
  "todo",
  "backlog",
];

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const COMMENT_AUTHOR_TYPES = ["user", "agent", "system"] as const;
export type CommentAuthorType = (typeof COMMENT_AUTHOR_TYPES)[number];

export const DEFAULT_CHECKOUT_EXPECTED: readonly IssueStatus[] = [
  "todo",
  "backlog",
  "blocked",
];

export const MAX_TREE_DEPTH = 100;
export const MAX_CHILDREN_PER_DECOMPOSITION = 25;

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  statusVersion: number;
  priority: IssuePriority;
  parentId: string | null;
  depth: number;
  assignee: string | null;
  createdBy: string | null;
  labels: string[];
  acceptanceCriteria: string[] | null;
  blockParentUntilDone: boolean;
  unblockOwner: string | null;
  unblockAction: string | null;
  originKind: string;
  originId: string | null;
  idempotencyKey: string | null;
  checkoutAgent: string | null;
  checkoutAt: string | null;
  blockedTransitionAt: string | null;
  /**
   * Plan-time guess, in whole seconds. STORED, unlike everything in
   * `IssueTiming` below — it is a fact somebody asserted, not a reading off a
   * clock, so it belongs on the entity exactly like `priority` does.
   *
   * null means "no estimate recorded", which is deliberately NOT the same fact
   * as zero: a surface comparing plan against actual has to be able to say the
   * plan is missing rather than invent a 0 and report an infinite overrun.
   */
  estimatedSeconds: number | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Derived liveness for a HELD issue — never stored, always computed against the
 * clock at read time. Deliberately NOT part of `Issue`: idleSeconds/heldSeconds
 * are now-relative, and freezing a clock reading into a cached, serialized entity
 * is a lie waiting to happen. Surfaces attach it as a sibling field.
 *
 * `lastActivityAt` is the newest of: the checkout itself, and any event or
 * comment authored BY THE HOLDER on that issue. Only the holder's own traffic
 * counts — another agent commenting on your ticket does not make you look alive.
 */
export interface ClaimActivity {
  /** The agent currently holding the claim (issues.checkout_agent). */
  heldBy: string;
  checkoutAt: string;
  lastActivityAt: string;
  /** Wall-clock seconds since the claim was taken ("held for"). */
  heldSeconds: number;
  /** Wall-clock seconds since the holder last did anything here ("silent for"). */
  idleSeconds: number;
}

/**
 * Estimate vs actual for one issue — the analytics payload, and a SIBLING of the
 * issue for exactly the reason `ClaimActivity` above is one.
 *
 * ## What "actual" means here — STA-90 replaced the answer
 *
 * The first version (STA-81) subtracted two timestamps: `now - startedAt` while
 * live, `completedAt - startedAt` when done. That shape has three defects and
 * they all point the same way — it over-reports:
 *
 *  1. `started_at` is never cleared, so a task that went `in_progress -> blocked
 *     -> in_progress` was billed for the blocked week in between.
 *  2. An epic that STA-79 auto-flipped to `in_progress` because a child started
 *     ran its own stopwatch forever, with nobody working the epic itself.
 *  3. Anything `in_progress` counted to `now`, so a task whose agent died on
 *     Friday was still "running" on Monday, several days deep into its estimate.
 *
 * So `activeSeconds` is now the sum of reconstructed `in_progress` INTERVALS,
 * replayed from the event log (see `WorkspaceStore.timingFor`). Blocked and
 * parked windows fall out for free because they are simply not intervals, and an
 * open interval is clamped to the holder's last activity rather than to `now`:
 * when agents stop, the clock stops.
 *
 * ## Why none of this lives on `Issue`
 *
 * The struct is still derived at read time, for every status, and still must not
 * become a column. The clamp made the numbers far more stable than they were —
 * a silent holder's `activeSeconds` no longer moves between reads — but "stable
 * right now" is not "immutable": the holder's next comment extends the open
 * interval, and a later transition closes it somewhere else entirely. An `Issue`
 * is precisely the thing callers cache, pipe to a file, and hand to an MCP client
 * that keeps it for a session, and ONE FIELD CANNOT HAVE TWO STORAGE
 * DISCIPLINES — a value trustworthy-when-frozen for some statuses and stale for
 * others forces every consumer to check the status before believing it.
 *
 * ## Why `estimatedSeconds` is echoed here
 *
 * It is a COPY of `Issue.estimatedSeconds`, read from the same row in the same
 * query — not a derivation, and incapable of drifting from it. It is duplicated
 * so this object is self-contained: the analytics surface renders a per-child
 * table from one map keyed by child id, instead of zipping a timing map against
 * a separate issue list to recover half of each row.
 *
 * ## Null is not zero
 *
 * Every nullable number here distinguishes "not recorded" from "recorded as
 * nothing". `childrenEstimatedSeconds` is null when NO child carries an
 * estimate, so a parent view can print "no estimates recorded" instead of a
 * fabricated 0 and a delta computed against it.
 */
export interface IssueTiming {
  /** Echo of the stored `Issue.estimatedSeconds`; null when none was recorded. */
  estimatedSeconds: number | null;
  /**
   * Seconds this issue itself was `in_progress`, summed over reconstructed
   * intervals — EXCLUDING intervals opened by ANY derived flip (a parent status
   * derived from its children carries a `derived` marker, whichever rung fired).
   *
   * Usually null (never ran) or 0-ish for an epic: nobody claims an epic, they
   * claim its children, and the flip that made the epic look busy was a report
   * about its children, not work on the epic. Exposed beside `activeSeconds` so
   * a surface can say "this parent's number is an aggregation" rather than the
   * store having to guess what the reader wanted.
   *
   * This is a pure MEASUREMENT — it reports what ran, for any status including
   * `cancelled`. `activeSeconds` below is the COMPARABLE actual and applies the
   * judgement about what may be weighed against a plan.
   */
  ownActiveSeconds: number | null;
  /**
   * THE HEADLINE ACTUAL, and the one field a surface should print as "ran".
   *
   *  - `cancelled`               -> null, whatever ran
   *  - leaf (`childCount === 0`) -> `ownActiveSeconds`
   *  - parent                    -> `childrenActiveSeconds`, the aggregation
   *
   * A parent has no independent stopwatch by construction. It keeps its own
   * `estimatedSeconds` — a parent can be somebody's child and carry a plan — and
   * that estimate is compared against the aggregate, which is the comparison
   * anyone actually wants ("we planned the epic at 8h, its children cost 5h").
   *
   * `cancelled` is null on purpose even when `ownActiveSeconds` proves it ran:
   * an abandoned attempt is not an "actual" you can weigh a plan against, and
   * because the rollup sums this field rather than the measurement, a cancelled
   * child drops out of its parent's total for free — no second rule, and the
   * on-screen table still equals its own total.
   */
  activeSeconds: number | null;
  /**
   * Seconds spent in `in_review`, summed over intervals, kept OUT of
   * `activeSeconds`.
   *
   * The decision (STA-90): review is not execution. This feature exists to
   * answer "what did agentic execution cost against the human plan", and a task
   * that sat two days waiting on a human reviewer did not take two days to
   * build. Folding it in would make every reviewed task look slower to execute
   * than it was, and dropping it entirely would hide a real and frequently
   * enormous queue. Separate bucket, surfaced only when nonzero.
   *
   * null when the issue was never in review — not 0, which would claim an
   * instant review that never happened.
   */
  reviewSeconds: number | null;
  /**
   * True when the event log could not be replayed and the numbers above fell
   * back to the old two-timestamp span.
   *
   * Reachable for imported or foreign databases, and for rows hand-edited out of
   * agreement with their own history. Surfaces render it as "approx" — a number
   * whose provenance is weaker must say so rather than sit in the same column
   * looking identical to a reconstructed one.
   *
   * Contagious upward: a parent aggregating an approximate child is approximate.
   */
  approximate: boolean;
  /**
   * The instant an OPEN, CONTRIBUTING interval was counted through — the
   * holder's `lastActivityAt`, or the newest event on the issue when
   * `in_progress` was set with no checkout behind it. NEVER `now`.
   *
   * null means nothing is accumulating: either no interval is open, or the only
   * open interval is a derived flip that this issue does not get to count. That
   * null is what finally lets a surface stop printing "still running" under an
   * epic nobody is working.
   *
   * When it is set, `now - countedThrough` is how long the clock has been
   * frozen, which is the honest thing to show beside a live figure.
   */
  countedThrough: string | null;
  /** Direct children only. 0 for a leaf. */
  childCount: number;
  /**
   * Sum over DIRECT children that carry an estimate; null when none do.
   *
   * Strictly depth-1, unlike `childrenActiveSeconds` below, and the asymmetry is
   * deliberate: a parent's estimate is a plan for its whole subtree, so adding it
   * to its children's estimates double-counts the plan. An actual has no such
   * problem — a parent has no own actual to double-count.
   */
  childrenEstimatedSeconds: number | null;
  /**
   * Sum over DIRECT children of each child's HEADLINE `activeSeconds`; null when
   * no child contributed one.
   *
   * Because it sums the headline, a child that is itself a parent contributes
   * its own aggregate. That keeps two things true at once: the on-screen table
   * still adds up (every row shows the number that was summed), and an
   * epic-of-epics reports its grandchildren's work instead of zero.
   *
   * `cancelled` children contribute nothing, without needing a rule here: their
   * own `activeSeconds` is already null.
   */
  childrenActiveSeconds: number | null;
  /** Direct children per status. Every status is present, zeros included. */
  childStatusCounts: Record<IssueStatus, number>;
}

/**
 * One year. An estimate is a plan-time guess about a unit of work, so a value
 * past this is a mistyped unit (`2h` fat-fingered into seconds, a millisecond
 * figure pasted in) rather than an intention — and a single bad row poisons
 * every rollup it lands in. Refusing at the door is cheaper than explaining a
 * nonsense epic total later.
 */
export const MAX_ESTIMATE_SECONDS = 365 * 86400;

/**
 * Estimates are positive whole seconds. Zero is refused rather than accepted as
 * a clear: "estimated at nothing" and "no estimate" are different claims, and
 * every surface has an explicit way to say the second one (`--no-estimate`, or
 * an explicit null).
 */
export function assertEstimateSeconds(value: number): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new StapleError(
      "validation",
      `estimate must be a positive whole number of seconds (got ${value}); clear it explicitly instead of passing 0`,
    );
  }
  if (value > MAX_ESTIMATE_SECONDS) {
    throw new StapleError(
      "validation",
      `estimate must be at most ${MAX_ESTIMATE_SECONDS} seconds (365d); ${value} looks like a mistyped unit`,
    );
  }
  return value;
}

/**
 * Human-readable age used inside the staleness guard sentences: 45s / 3m / 2h / 5d.
 * Floored, single unit — this is prose for a refusal message, not a duration type.
 */
export function formatAgo(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0s"; // never "NaNd" to a human
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

/**
 * Durations for estimate-vs-actual prose: `45s`, `20m`, `3h10m`, `2d4h`.
 *
 * Distinct from `formatAgo` on purpose, and the two are NOT interchangeable.
 * `formatAgo` answers "how long ago", where a single floored unit is the honest
 * resolution — nobody needs "silent for 3h10m", and pretending to that precision
 * about an idleness threshold would invite reading it as exact. This one answers
 * "how long did it take", where the second unit is the whole point: `2h` and
 * `2h55m` are the difference between hitting an estimate and blowing it, and
 * flooring them to the same string erases the comparison the feature exists for.
 *
 * At most two units, largest first, trailing zero unit dropped (`2h` not `2h0m`).
 */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds)) return "0s"; // never "NaNd" to a human
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) {
    const rest = s % 60;
    return rest ? `${Math.floor(s / 60)}m${rest}s` : `${Math.floor(s / 60)}m`;
  }
  if (s < 86400) {
    const rest = Math.floor((s % 3600) / 60);
    return rest ? `${Math.floor(s / 3600)}h${rest}m` : `${Math.floor(s / 3600)}h`;
  }
  const rest = Math.floor((s % 86400) / 3600);
  return rest ? `${Math.floor(s / 86400)}d${rest}h` : `${Math.floor(s / 86400)}d`;
}

/**
 * The one staleness refusal sentence, shared by checkout-steal and
 * release-if-stale so the two can never drift. Both end in the same directive on
 * purpose: the caller wanted this task, the holder is demonstrably alive, and the
 * correct move is to go do something else.
 */
export function claimGuardMessage(verb: "Checkout" | "Release", claim: ClaimActivity): string {
  return `${verb} refused: held by ${claim.heldBy}, active ${formatAgo(claim.idleSeconds)} ago. Pick a different task.`;
}

export interface IssueComment {
  id: string;
  issueId: string;
  author: string;
  authorType: CommentAuthorType;
  body: string;
  /** Retry token, unique per issue: a repeat replays this comment (see store.addCommentResult). */
  idempotencyKey: string | null;
  deletedAt: string | null;
  createdAt: string;
}

export interface IssueDocumentMeta {
  issueId: string;
  key: string;
  currentRevision: number;
  title: string | null;
  updatedAt: string;
}

/**
 * The document key an agent checkpoints under, per the worklog protocol in
 * `.tasks/AGENTS.md` ("checkpoint as you go") — and the ONLY place that string is
 * written down on the server side.
 *
 * It is a constant rather than a literal because document keys are genuinely
 * free-form (`/^[a-z0-9._-]{1,64}$/`, store.putDocument) and nothing in the schema
 * privileges this one: STA-97 keeps its own spec under `row-spec`. Centralising it
 * is what makes "let the workspace configure its worklog key" a one-line change
 * instead of a grep across the store, the server and four UI surfaces.
 *
 * MIRRORED, deliberately not imported, in `src/ui/app/src/lib/types.ts` — the browser
 * app builds under a DOM tsconfig and cannot pull in Node-only `src/core`. If you
 * change this value, change it there too; `WorklogSummary.key` is a field precisely so
 * that no rendering code has to hardcode the answer.
 */
export const WORKLOG_KEY = "worklog";

/**
 * The one server-side definition of "latest worklog" (STA-113), and a SIBLING of the
 * issue for the same reason `ClaimActivity` is one: it is a different clock. A worklog's
 * `updatedAt` answers a strictly narrower question than a claim's `lastActivityAt` —
 * "when did the holder last leave a handoff", not "is the holder alive" — and the two
 * come apart in exactly the case that matters, an agent who is busy and has stopped
 * checkpointing. Callers must never treat one as evidence of the other.
 *
 * Produced only by `store.worklogSummaryFor`, so the row cue, the Overview panel and the
 * handoff filter cannot disagree about which revision is current or how old it is.
 */
export interface WorklogSummary {
  /** `WORKLOG_KEY` today. A field, not an assumption, so this can generalise. */
  key: string;
  /** `documents.current_revision` — how many checkpoints, not just whether there is one. */
  revisions: number;
  /** `documents.updated_at`, ISO-8601. The ONE freshness reading; never recomputed client-side. */
  updatedAt: string;
  /** Author of the CURRENT revision, null when the writer did not sign it. */
  author: string | null;
}

export interface StapleEvent {
  seq: number;
  kind: string;
  issueId: string | null;
  actor: string | null;
  payload: Record<string, unknown>;
  dedupKey: string | null;
  createdAt: string;
}

export interface RelationEdge {
  blockerId: string;
  blockedId: string;
  type: "blocks";
}

export type StapleErrorCode =
  | "validation"
  | "not_found"
  | "conflict"
  | "cycle"
  | "duplicate"
  | "revision_conflict";

export class StapleError extends Error {
  readonly code: StapleErrorCode;
  readonly detail?: Record<string, unknown>;
  constructor(code: StapleErrorCode, message: string, detail?: Record<string, unknown>) {
    super(message);
    this.name = "StapleError";
    this.code = code;
    this.detail = detail;
  }
}

/**
 * Retry contract. Only revision_conflict is worth retrying: put_document tells
 * the caller to re-read and merge, which is a retry with new input. A checkout
 * conflict is NOT retryable — pick a different task. Unknown (non-StapleError)
 * failures are NOT retryable either: a caller honoring the bit must never be
 * told to loop on a deterministic failure it can't classify.
 */
const RETRYABLE_ERROR_CODES: readonly StapleErrorCode[] = ["revision_conflict"];

export interface ErrorEnvelope {
  code: StapleErrorCode | "unknown";
  message: string;
  detail?: Record<string, unknown>;
  retryable: boolean;
}

/** Single source of truth for error shape across MCP, the UI server, and the CLI. */
export function errorEnvelope(error: unknown): ErrorEnvelope {
  if (error instanceof StapleError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.detail ? { detail: error.detail } : {}),
      retryable: RETRYABLE_ERROR_CODES.includes(error.code),
    };
  }
  return {
    code: "unknown",
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

// ---------- pagination ----------

/**
 * Every paginated surface answers the same shape. `nextCursor` is null exactly
 * when `hasMore` is false, so a caller can loop on either without special cases.
 */
export interface Page<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface PageLimits {
  readonly default: number;
  readonly max: number;
}

export const ISSUE_PAGE_LIMITS: PageLimits = { default: 50, max: 200 };
/** Keeps list_comments' existing default and ceiling — narrowing them would break callers. */
export const COMMENT_PAGE_LIMITS: PageLimits = { default: 100, max: 500 };
export const HUB_EVENT_PAGE_LIMITS: PageLimits = { default: 50, max: 500 };

export function clampLimit(limit: number | undefined, limits: PageLimits): number {
  if (limit === undefined) return limits.default;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new StapleError("validation", `limit must be a positive integer (max ${limits.max})`);
  }
  return Math.min(Math.floor(limit), limits.max);
}

/**
 * Cursors are opaque base64url JSON — pass them back verbatim, never parse them.
 * Two kinds:
 *
 *  - offset ({k:"o"}) for lists ordered by a computed rank (list_tasks orders by
 *    two CASE expressions before created_at, so there is no stable key to seek
 *    on). `q` fingerprints the non-pagination arguments, so replaying a cursor
 *    against different filters is a loud validation error rather than a silently
 *    wrong page.
 *  - seq ({k:"s"}) for the hub event log, which does have a monotonic key.
 *
 * Being opaque is the point: this can become keyset pagination later without
 * touching a single caller.
 */
type CursorPayload = { k: "o"; o: number; q: string } | { k: "s"; s: number };

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    if (parsed?.k === "o" && Number.isInteger(parsed.o) && parsed.o >= 0) return parsed;
    if (parsed?.k === "s" && Number.isInteger(parsed.s) && parsed.s >= 0) return parsed;
  } catch {
    // fall through to the one error message below
  }
  throw new StapleError("validation", "Cursor is not a cursor this server issued. Drop it and start from the first page.");
}

/** Stable fingerprint of the arguments a cursor was issued for. */
export function cursorScope(scope: unknown): string {
  return createHash("sha256").update(JSON.stringify(scope ?? null)).digest("hex").slice(0, 12);
}

export function encodeOffsetCursor(offset: number, scope: string): string {
  return encodeCursor({ k: "o", o: offset, q: scope });
}

export function decodeOffsetCursor(cursor: string, scope: string): number {
  const payload = decodeCursor(cursor);
  if (payload.k !== "o") {
    throw new StapleError("validation", "Cursor belongs to a different kind of list.");
  }
  if (payload.q !== scope) {
    throw new StapleError(
      "validation",
      "Cursor was issued for different arguments. Re-run the first page with these arguments, or reuse the arguments the cursor came from.",
    );
  }
  return payload.o;
}

export function encodeSeqCursor(seq: number): string {
  return encodeCursor({ k: "s", s: seq });
}

export function decodeSeqCursor(cursor: string): number {
  const payload = decodeCursor(cursor);
  if (payload.k !== "s") {
    throw new StapleError("validation", "Cursor belongs to a different kind of list.");
  }
  return payload.s;
}

export function assertStatus(value: string): asserts value is IssueStatus {
  if (!(ISSUE_STATUSES as readonly string[]).includes(value)) {
    throw new StapleError("validation", `Unknown status "${value}". Valid: ${ISSUE_STATUSES.join(", ")}`);
  }
}

export function assertPriority(value: string): asserts value is IssuePriority {
  if (!(ISSUE_PRIORITIES as readonly string[]).includes(value)) {
    throw new StapleError("validation", `Unknown priority "${value}". Valid: ${ISSUE_PRIORITIES.join(", ")}`);
  }
}

/** Duplicate-guard normalization: lowercase, trim, collapse inner whitespace. */
export function normalizeTitle(title: string): string {
  return title.trim().toLowerCase().replace(/\s+/g, " ");
}

export function nowIso(): string {
  return new Date().toISOString();
}
