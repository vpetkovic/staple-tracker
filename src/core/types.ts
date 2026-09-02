/**
 * Core vocabulary — cloned from Paperclip's ticket model (MIT,
 * github.com/paperclipai/paperclip): same statuses, priorities, and guard
 * semantics, so agents trained on one feel at home in the other.
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
 * Human-readable age used inside the staleness guard sentences: 45s / 3m / 2h / 5d.
 * Floored, single unit — this is prose for a refusal message, not a duration type.
 */
export function formatAgo(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
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
