/**
 * Core vocabulary: the statuses, priorities, and guard semantics every surface
 * — CLI, MCP, HTTP, UI — agrees on. Defined once, here.
 */
import { createHash } from "node:crypto";

/**
 * The BUILT-IN status vocabulary — the SEED, not the law (STA-140).
 *
 * Since O7a a workspace's statuses live in `workspace_statuses` and are read
 * through `WorkspaceStore.getStatuses()`. This array is what a database gets
 * seeded with, and what a surface with no database in hand (the CLI's static
 * `--help`, a type default) may fall back to. Nothing that has a store should
 * consult it: an operator who renamed `in_review` or added `needs_qa` is
 * entitled to have every surface agree with them.
 *
 * The ORDER is load-bearing and is preserved verbatim by the seed: it is the
 * board's column order, pinned by `characterize-cli-surface.test.ts`.
 *
 * `awaiting_approval` (STA-143) is a member like any other, and that is the
 * whole point of it living here rather than in a hard-coded guard: it means
 * "this parent is PARKED behind a human review gate, and everything open
 * underneath it is queued rather than pickable", and it gets that meaning from
 * its CATEGORY (`gated`), not from its id. The gate commands are the only way in
 * or out of it, but every guard that reads it — inbox partition, list rank,
 * derived rungs, resolved-ness — reads the category, exactly as it does for
 * `blocked` or `in_review`. Placed between `in_review` and `done` because that
 * is where it sits in the life of a ticket.
 */
export const ISSUE_STATUSES = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "awaiting_approval",
  "done",
  "blocked",
  "cancelled",
] as const;

/** The eight ids staple seeds. A configured workspace may have others. */
export type BuiltinIssueStatus = (typeof ISSUE_STATUSES)[number];

/**
 * A status id — a STRING, deliberately, since STA-140.
 *
 * It was a closed union of the seven built-ins, and it could not stay one: the
 * whole point of O7 is that a workspace adds its own. A union would have forced
 * every configured id through a cast at the boundary and, worse, would have
 * pushed `z.enum(ISSUE_STATUSES)` into the MCP OUTPUT schemas, where zod strips
 * what it does not recognise — a custom status would have vanished off the wire
 * silently. `BuiltinIssueStatus` above keeps the narrow type for the places that
 * genuinely mean "one of the seeded seven".
 *
 * Validation moved with the data: `WorkspaceStore.assertConfiguredStatus`.
 */
export type IssueStatus = string;

/**
 * The fixed, NON-configurable set of behaviours a status can have (STA-140).
 *
 * This is the design constraint that keeps the store honest. Statuses are data;
 * their SEMANTICS are not. Every guard, every derived parent rung, every "is this
 * finished" test and the whole inbox pickup order key off the CATEGORY, so a
 * custom status inherits a behaviour that already has tests instead of inventing
 * one nothing knows how to enforce.
 *
 *  - `unstarted` — in the backlog; workable, claimable, not started.
 *  - `ready`     — queued for pickup; workable, claimable. `release` lands here.
 *  - `active`    — work is happening. A claim can only ever be held here.
 *  - `review`    — waiting on a reviewer. Not execution: see `IssueTiming.reviewSeconds`.
 *  - `gated`     — parked awaiting an approval that is not a dependency (STA-143).
 *                  Seeded with `awaiting_approval`. Open, not workable, not
 *                  claimable, and NEVER ready in the inbox — a member of this
 *                  category is entered and left only by the gate commands
 *                  (`gate` / `approve` / `request-changes`), never by
 *                  `updateIssue`, and a parent sitting in it is immune to the
 *                  derived-parent rungs in BOTH directions. Add your own member
 *                  and it inherits all of that; nothing keys off the id.
 *  - `blocked`   — waiting on something nameable. Claimable, because taking a
 *                  blocked ticket to unblock it is how work gets unstuck.
 *  - `done`      — resolved, succeeded.
 *  - `cancelled` — resolved, abandoned.
 */
export const STATUS_CATEGORIES = [
  "unstarted",
  "ready",
  "active",
  "review",
  "gated",
  "blocked",
  "done",
  "cancelled",
] as const;
export type StatusCategory = (typeof STATUS_CATEGORIES)[number];

/** Categories whose members mean "this issue is finished, in either direction". */
export const RESOLVED_CATEGORIES: readonly StatusCategory[] = ["done", "cancelled"];

/** Categories an agent may pick work up from — the derivation's "workable band". */
export const WORKABLE_CATEGORIES: readonly StatusCategory[] = ["unstarted", "ready"];

/**
 * The rank a list sorts open-then-resolved work by, as CATEGORIES.
 *
 * For the seeded seven this reproduces the previous hardcoded
 * `CASE status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 …` exactly.
 * Configured order breaks ties WITHIN a tier, which is what makes "reorder the
 * statuses and the tree reorders" true without letting a reorder move `done`
 * above `in_progress`.
 */
export const LIST_CATEGORY_ORDER: readonly StatusCategory[] = [
  "active",
  "review",
  "gated",
  "blocked",
  "ready",
  "unstarted",
  "done",
  "cancelled",
];

/** Pickup order for the agent inbox: current work first, then reviews, then queue. */
export const INBOX_PICKUP_CATEGORY_ORDER: readonly StatusCategory[] = [
  "active",
  "review",
  "ready",
  "unstarted",
];

/**
 * What a bare `checkout` will claim from, as categories — and in this order,
 * because the order is quoted verbatim in the refusal sentence.
 */
export const CHECKOUT_EXPECTED_CATEGORY_ORDER: readonly StatusCategory[] = [
  "ready",
  "unstarted",
  "blocked",
];

/**
 * Categories the CODE writes into, so the last status in one may never be removed.
 *
 * `release` writes `ready`, `checkout` writes `active`, `done`/`cancel` write
 * theirs, the derivation's rung 4 writes `blocked` and its rung 3 writes
 * `unstarted`. `review` is absent on purpose: nothing can enter a category with
 * no members, so emptying it is a coherent configuration.
 *
 * `gated` is absent for the same reason, and it is worth being explicit about
 * why, since `gate` DOES write into it: `gateIssue` resolves its target status
 * through the CATEGORY rather than naming `awaiting_approval`, and refuses with
 * a configuration error when the category is empty. A team that does not review
 * may remove `awaiting_approval` and lose the gate command; it may not remove it
 * and keep a gate command that writes a status the workspace does not have.
 */
export const REQUIRED_STATUS_CATEGORIES: readonly StatusCategory[] = [
  "unstarted",
  "ready",
  "active",
  "blocked",
  "done",
  "cancelled",
];

/**
 * Built-in status seed rows, in seed order — what a fresh workspace starts with.
 *
 * Migration 004 writes these into the tables it creates, and `schema.ts` writes
 * them on the consolidated fresh-create path. A database that was already
 * stamped 4 or 5 before `awaiting_approval` joined this list was seeded WITHOUT
 * it, which is exactly what migration 006 exists to repair — see
 * `006-approval-gates.ts`.
 */
export const BUILTIN_STATUS_SEED: readonly { id: BuiltinIssueStatus; label: string; category: StatusCategory }[] = [
  { id: "backlog", label: "Backlog", category: "unstarted" },
  { id: "todo", label: "Todo", category: "ready" },
  { id: "in_progress", label: "In Progress", category: "active" },
  { id: "in_review", label: "In Review", category: "review" },
  { id: "awaiting_approval", label: "Awaiting Approval", category: "gated" },
  { id: "done", label: "Done", category: "done" },
  { id: "blocked", label: "Blocked", category: "blocked" },
  { id: "cancelled", label: "Cancelled", category: "cancelled" },
];

/**
 * The BUILT-IN kind vocabulary — the seed for `workspace_kinds` (STA-140).
 *
 * O1a (STA-124) adds `issues.kind` and reads the RUNTIME list through
 * `WorkspaceStore.getKinds()`; this export is what seeds it and what a surface
 * with no store may name as the default vocabulary. `DEFAULT_ISSUE_KIND` is the
 * value that column will default to.
 */
export const ISSUE_KINDS = ["epic", "task", "bug", "chore", "spike"] as const;
export type BuiltinIssueKind = (typeof ISSUE_KINDS)[number];
/** A kind id — a string for exactly the reason `IssueStatus` is one. */
export type IssueKind = string;
export const DEFAULT_ISSUE_KIND: BuiltinIssueKind = "task";

export const BUILTIN_KIND_SEED: readonly { id: BuiltinIssueKind; label: string }[] = [
  { id: "epic", label: "Epic" },
  { id: "task", label: "Task" },
  { id: "bug", label: "Bug" },
  { id: "chore", label: "Chore" },
  { id: "spike", label: "Spike" },
];

/**
 * Sort/group rank for the SEEDED kinds — the exact twin of `OPEN_STATUS_ORDER`
 * below, and used the same way.
 *
 * The per-workspace answer is `WorkspaceStore.kindOrder()`, whose INDEX is the
 * rank; this map is what a surface with no store may use instead. That surface
 * is the browser: `src/ui/app` cannot import this file (src/core is Node-only),
 * so it keeps a hand mirror, and grouping a board by kind needs a rank from
 * somewhere. A kind the operator added is absent from this map — callers sort
 * it last rather than first, on the same principle as `statusRankSql`: a value
 * nobody configured belongs at the bottom, not the top of everyone's list.
 */
export const KIND_RANK: Readonly<Record<BuiltinIssueKind, number>> = Object.freeze(
  Object.fromEntries(ISSUE_KINDS.map((kind, index) => [kind, index])) as Record<
    BuiltinIssueKind,
    number
  >,
);

/** One configured status row, in configured order. */
export interface WorkspaceStatus {
  id: string;
  label: string;
  category: StatusCategory;
  sortOrder: number;
  /** True for a row migration 004 seeded. Informational — built-ins are editable. */
  isBuiltin: boolean;
}

/** One configured kind row, in configured order. */
export interface WorkspaceKind {
  id: string;
  label: string;
  sortOrder: number;
  isBuiltin: boolean;
}

/**
 * Vocabulary ids are lowercase snake_case, and that is enforced rather than
 * suggested: they are interpolated into `IN (…)` and `CASE` SQL fragments the
 * store builds per query, they are dictionary keys on the wire, and they end up
 * in URLs. A closed character set is what makes all three safe at once.
 */
export const VOCABULARY_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

export const OPEN_STATUSES: readonly BuiltinIssueStatus[] = [
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "awaiting_approval",
  "blocked",
];
export const RESOLVED_STATUSES: readonly BuiltinIssueStatus[] = ["done", "cancelled"];

/**
 * Built-in open statuses in list rank — the server-side twin of the UI mirror's
 * `OPEN_STATUS_ORDER`, which is where this constant used to live alone. The
 * per-workspace answer is `WorkspaceStore.openStatusOrder()`; this is the seed.
 */
export const OPEN_STATUS_ORDER: readonly BuiltinIssueStatus[] = [
  "in_progress",
  "in_review",
  "awaiting_approval",
  "blocked",
  "todo",
  "backlog",
];

/**
 * Pickup order for the agent inbox: current work first, then reviews, then queue.
 *
 * `awaiting_approval` is deliberately ABSENT, and it is absent BY CATEGORY: the
 * per-workspace answer is `WorkspaceStore.inboxPickupOrder()`, which filters on
 * `INBOX_PICKUP_CATEGORY_ORDER`, and `gated` is not in it. A parked parent is
 * never picked up — that is the whole point of parking it — so it has no place
 * in a pickup order, and `store.inbox()` routes it to the `queued` bucket
 * instead. Any status an operator files under `gated` inherits that.
 */
export const INBOX_PICKUP_ORDER: readonly BuiltinIssueStatus[] = [
  "in_progress",
  "in_review",
  "todo",
  "backlog",
];

/**
 * Where a review gate is in its life (STA-143). `null` on the row means no gate
 * was ever requested, which is a different fact from `approved`.
 *
 * `pending` and `changes_requested` are both ACTIVE — see `GATE_QUEUEING_STATES`
 * in core/store.ts — and only `pending` parks the parent in `awaiting_approval`.
 */
export const GATE_STATES = ["pending", "approved", "changes_requested"] as const;
export type GateState = (typeof GATE_STATES)[number];

/**
 * The stored review gate on one issue, exposed as a SIBLING of the issue rather
 * than as fields on it — the same discipline `ClaimActivity` and
 * `WorklogSummary` follow, and for a related reason: a gate is a fact about a
 * conversation with a human, not a property of the work, and every surface that
 * renders it renders it as its own thing (a banner, a queue reason, a refusal
 * sentence) rather than as another column on the row.
 *
 * Unlike those two it IS stored, so it never goes stale between reads. What it
 * shares with them is the payload shape: `null` means "no gate", never a
 * half-populated object a caller has to inspect field by field.
 */
export interface IssueGate {
  state: GateState;
  /** Who must act. Required at `gate` time; survives approve/request-changes. */
  owner: string;
  requestedBy: string | null;
  requestedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

/**
 * The gate an issue is QUEUED BEHIND — derived, never stored, computed by
 * walking ancestors (see `WorkspaceStore.queuedByFor`). null means pickable as
 * far as gates are concerned.
 *
 * Two fields and no more on purpose: a queued row has exactly one thing to say
 * — who is waiting on whom — and every surface says it the same way,
 * "queued: STA-108/VP".
 */
export interface QueuedBy {
  /** Identifier of the nearest ancestor holding an active gate. */
  identifier: string;
  /** That gate's owner — the human who has to act before this becomes pickable. */
  owner: string;
}

/**
 * ONE ROW OF THE QUEUE A GATE IS HOLDING — the reviewer's checklist (STA-154).
 *
 * `queuedBy` answers "is THIS row queued" for any row on any page. This answers
 * the reviewer's question instead: standing at the gate, what am I actually
 * deciding about? The two are the same derivation read from opposite ends, and
 * `gateQueueOf` is written on top of `queuedByFor` so they cannot disagree.
 *
 * It is a FLAT PRE-ORDER LIST with a depth rather than a nested tree, because
 * the thing that consumes it is a checklist: a flat list maps one-to-one onto
 * rows, `depth` is the indent, and "everything under row i" is the run of
 * following rows with a greater depth. A nested shape would make the client
 * flatten it again to render it and to count an implied subtree.
 *
 * `depth` is measured over the LISTED chain, not over the real tree: a row whose
 * real parent was skipped (resolved, or a parent with nothing open under it)
 * takes the depth of the nearest ancestor that IS listed, plus one. An indent
 * under a row that is not on screen is a hole, and a checklist with a hole in it
 * is a set of decisions nobody can reason about. A direct child of the gate
 * holder is depth 1.
 */
export interface GateQueueEntry {
  id: string;
  identifier: string;
  title: string;
  status: IssueStatus;
  /** The real `parent_id`, for callers that want the true edge. */
  parentId: string | null;
  /** Indent level in the LISTED tree. Direct children of the gate holder are 1. */
  depth: number;
}

export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export const COMMENT_AUTHOR_TYPES = ["user", "agent", "system"] as const;
export type CommentAuthorType = (typeof COMMENT_AUTHOR_TYPES)[number];

/**
 * Built-in fallback for a bare checkout. The per-workspace answer is
 * `WorkspaceStore.checkoutExpectedStatuses()`, derived from
 * `CHECKOUT_EXPECTED_CATEGORY_ORDER`; this list is what that derivation produces
 * for the seeded seven, and it is kept so a caller without a store can name one.
 */
export const DEFAULT_CHECKOUT_EXPECTED: readonly BuiltinIssueStatus[] = [
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
  /**
   * What KIND of work this is — `epic`, `bug`, `spike`, whatever this workspace
   * configured (STA-124). Never null: migration 005 gave the column a DEFAULT,
   * so "no kind recorded" is not a state that exists. Every issue has always had
   * a kind; before that migration the tracker just had nowhere to write it down.
   *
   * DECLARED, not derived — and that is the whole design. A `task` that grows
   * children stays a `task` until a human says otherwise; the UI may SUGGEST
   * promoting it to an epic, but nothing recomputes this field behind their
   * back. The one and only automatic write was migration 005's one-shot
   * backfill of rows that already had children, which exists to give a
   * pre-existing backlog a sensible starting shape and never runs again.
   */
  kind: IssueKind;
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
  /**
   * The project this issue belongs to — a `Project.id` — or null for none,
   * which is what every issue that predates migration 009 reads as. At most one,
   * exactly like `parentId`; set through `ProjectStore.assign`, at create time
   * through `CreateIssueInput.project`, and cleared when the project is deleted.
   */
  projectId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- projects (migration 009) ----------

/**
 * A project is either UNMANAGED (a name and nothing else) or MANAGED, in which
 * case it points at a source: a GitHub repository link or a folder on disk.
 * The distinction is stored explicitly rather than inferred from the shape of a
 * string, because the settings a project grows later hang off it.
 */
export const PROJECT_KINDS = ["unmanaged", "managed"] as const;
export type ProjectKind = (typeof PROJECT_KINDS)[number];

export const PROJECT_SOURCE_KINDS = ["github", "local"] as const;
export type ProjectSourceKind = (typeof PROJECT_SOURCE_KINDS)[number];

export interface Project {
  /** Stable machine key; what `Issue.projectId` points at. */
  id: string;
  /** Stable human handle, derived from the name at create time and never re-derived. */
  slug: string;
  name: string;
  kind: ProjectKind;
  /** Null exactly when `kind` is `unmanaged`. */
  sourceKind: ProjectSourceKind | null;
  /** The GitHub URL or the local path; null exactly when `kind` is `unmanaged`. */
  source: string | null;
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
  /**
   * Direct children per status. Every CONFIGURED status is present, zeros
   * included — so since STA-140 the key set is the workspace's own vocabulary
   * rather than a fixed seven, which is why the type is an open record.
   */
  childStatusCounts: Record<string, number>;
  /**
   * The RECURSIVE plan for this issue's subtree (STA-192), beside — never
   * instead of — the depth-1 `childrenEstimatedSeconds` above. See `SubtreePlan`.
   */
  subtreePlan: SubtreePlan;
}

/** Where a `SubtreePlan.estimatedSeconds` came from. */
export type PlanSource = "own" | "descendants" | "none";

/**
 * The estimate rollup that survives an epic-of-epics, the way `activeSeconds`
 * already does (STA-192).
 *
 * ## The one contribution rule
 *
 * An issue CONTRIBUTES its own estimate if it recorded one, otherwise the sum
 * of its children's contributions. That is the whole rule, and it is what
 * keeps an ancestor total from counting anything twice: a parent's estimate is
 * a plan for its whole subtree, so once it has one, the estimates beneath it
 * are SHADOWED for every ancestor — they are not added on top. Where a parent
 * has none, its children's plans flow up through it unchanged, which is how a
 * mid-level epic nobody estimated still reports its children's 11h and passes
 * that 11h to its own parent.
 *
 * Both directions are exposed, because a reader who set 6h on an epic whose
 * children add up to 11h wants to see the disagreement, not have one number
 * silently win: `estimatedSeconds` is the top-down (effective) plan and
 * `descendantsEstimatedSeconds` is the bottom-up one.
 *
 * ## Null is not zero, here too
 *
 * A sum is null when NOTHING contributed, never 0 — the same convention as
 * every other nullable number on `IssueTiming`.
 */
export interface SubtreePlan {
  /**
   * THE EFFECTIVE PLAN: the one number an ancestor counts this issue as.
   * `Issue.estimatedSeconds` when recorded, otherwise
   * `descendantsEstimatedSeconds`, null when neither exists.
   */
  estimatedSeconds: number | null;
  /** Which of the two fed `estimatedSeconds`; `none` when it is null. */
  source: PlanSource;
  /**
   * BOTTOM-UP: the sum of the DIRECT children's effective plans — the recursive
   * counterpart of `childrenEstimatedSeconds`, and equal to it whenever every
   * child carries its own estimate. Null when no descendant at any depth does.
   * Present even when `source` is `own`, so a top-down plan and the work
   * beneath it can be compared.
   */
  descendantsEstimatedSeconds: number | null;
  /**
   * Descendants at ANY depth whose own estimate is a term of
   * `descendantsEstimatedSeconds`. A descendant shadowed by an estimated
   * ancestor below this issue is not counted here — and not lost: it is still
   * on that issue's own timing. Coverage is this over `totalCount`.
   */
  contributingCount: number;
  /** Descendants at any depth, whatever their status. 0 for a leaf. */
  totalCount: number;
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
  | "revision_conflict"
  /**
   * Refused because a review gate above this issue has not been resolved
   * (STA-143). Its own code rather than a `conflict` because the two tell a
   * caller to do genuinely different things: a `conflict` means somebody else
   * got there first and you should pick another task RIGHT NOW, while `gated`
   * means this work is real, unclaimed, and simply not released yet — the queue
   * moves when a human moves it, not when another agent finishes. Non-retryable
   * either way: looping on it burns turns while a person is asleep.
   */
  | "gated"
  /**
   * Refused because the pickup plan says something else comes first (STA-168,
   * `queue.policy = strict`). The third instruction in the family: `conflict`
   * means somebody beat you to it, `gated` means a person must act, and
   * `out_of_order` means the work is takeable but not YOURS TO TAKE YET —
   * `detail.expected` names what to take instead. Retrying never clears it;
   * taking the expected item does, which is why it is not retryable.
   */
  | "out_of_order";

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

/**
 * There is deliberately no `assertStatus` here any more (STA-140).
 *
 * The authority on "is this a status" is `WorkspaceStore.assertConfiguredStatus`,
 * which reads `workspace_statuses` — because the answer is a property of the
 * WORKSPACE, and a module-level checker against the seeded seven would give the
 * wrong answer for every workspace that configured its own. A second validator
 * that is right most of the time is exactly how the two drift apart.
 */
export function assertStatusCategory(value: string): asserts value is StatusCategory {
  if (!(STATUS_CATEGORIES as readonly string[]).includes(value)) {
    throw new StapleError(
      "validation",
      `Unknown status category "${value}". Valid: ${STATUS_CATEGORIES.join(", ")}. ` +
        "The category set is fixed — every behaviour in the store keys off it.",
    );
  }
}

/** Normalize and validate a vocabulary id (status or kind). Returns the id. */
export function assertVocabularyId(value: string, what: "status" | "kind"): string {
  const id = value.trim().toLowerCase();
  if (!VOCABULARY_ID_PATTERN.test(id)) {
    throw new StapleError(
      "validation",
      `"${value}" is not a usable ${what} id. Use lowercase letters, digits and underscores, ` +
        "starting with a letter, at most 32 characters (e.g. awaiting_approval).",
    );
  }
  return id;
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
