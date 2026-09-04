/**
 * The wire vocabulary — one mirror of src/core/types.ts plus the envelopes
 * src/ui/server.ts actually returns.
 *
 * This is a hand-kept mirror, not an import: the app builds under a DOM tsconfig
 * with `moduleResolution: bundler`, and src/core is Node-only (`node:crypto`,
 * `node:sqlite`). Pulling core in would drag Node types into the browser build.
 *
 * WAVE 2: extend this file. Do not re-declare an issue shape inside a view.
 */

/**
 * The BUILT-IN statuses — the seed, not the vocabulary.
 *
 * O7 (STA-139/140) made the status set workspace DATA: a status can be added,
 * renamed, recategorised, reordered and removed, so a status id is a string that
 * came off the wire and not a member of a compile-time union. This tuple is what
 * a fresh workspace is seeded with and what a surface with no `/api/settings`
 * answer in hand may name as a default; the live list is `lib/settings.ts`.
 *
 * `awaiting_approval` (STA-143) is one of the seeded rows, in category `gated`:
 * the issue is PARKED behind a human review gate, its open descendants are
 * queued, and nothing underneath it can be claimed until somebody approves.
 * Mirrors src/core/types.ts, including the position in the list — `board`
 * renders columns in this order.
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
/** The eight ids staple ships. */
export type BuiltinIssueStatus = (typeof ISSUE_STATUSES)[number];

/**
 * Column order on the board and the order the old page listed things in — and,
 * through `GROUP_ORDER` and the Status filter, the order statuses are enumerated
 * in EVERYWHERE.
 *
 * `awaiting_approval` sits DIRECTLY AFTER `in_review` (Q2, STA-144), which is
 * where `ISSUE_STATUSES` puts it and where the lifecycle puts it: in_review is
 * work a human is reading, awaiting_approval is work a human is deciding on, and
 * a reader scanning group headers should meet them as the pair they are. It is
 * also exactly where the server's category tiering lands it — `gated` sits
 * between `review` and `blocked` in the list rank — so this seed and
 * `configuredGroupOrder()` agree on a default workspace, which is what
 * `lib/settings.test.ts` pins.
 *
 * ── WHY THIS IS STILL THE BUILT-IN UNION, AND WHAT IT COSTS ───────────────────────────
 *
 * `src/core/types.ts` widened `IssueStatus` to `string` in O7a, and this mirror SHOULD
 * follow — a configured id is not knowable at compile time. O7b deliberately did not,
 * and the reason is mechanical rather than a preference.
 *
 * Widening it here forces exactly one edit outside this file that cannot be avoided from
 * inside it: `views/tree/TreeGrid.tsx` reads `STATUS_LABEL[group.status]`, and
 * `STATUS_LABEL` is declared `Record<IssueStatus, string>` in
 * `components/task-list/model.ts`. Widen the key and that record grows an index
 * signature, so under `noUncheckedIndexedAccess` the lookup becomes `string | undefined`
 * and the `label` prop stops accepting it. Both files belong to the O3 chain, which is
 * live on another branch this sprint; a one-token change in the middle of them buys a
 * merge conflict for a type-level improvement with no runtime effect.
 *
 * Nothing is broken by leaving it. Values arrive off the wire through `request<T>()`,
 * which casts rather than validates, so a custom status flows through every surface at
 * runtime today — and everything that has to REASON about one (`lib/settings.ts`, the
 * settings editor, `StatusIcon`, `StatusBadge`) takes `StatusId` below, which is a
 * string. What the union costs is honesty in the type, not behaviour.
 *
 * TO FINISH IT — one commit, after O3 lands, four lines:
 *   1. `export type IssueStatus = StatusId;`
 *   2. `OPEN_STATUS_ORDER` / `RESOLVED_STATUSES` are already `readonly StatusId[]`.
 *   3. `TreeGrid.tsx`: `STATUS_LABEL[group.status] ?? statusLabel(group.status)`.
 *   4. `GraphView.tsx`: key `MINIMAP_COLORS` off `statusCategory(...)`.
 */
export type IssueStatus = BuiltinIssueStatus;

/**
 * A status id AS SERVED — any string, because the vocabulary is workspace data.
 *
 * This is the type every O7 surface speaks. It is separate from `IssueStatus` only for
 * the transitional reason argued above; when that union widens, this becomes its alias
 * and every signature below is already correct.
 */
export type StatusId = string;
/** A kind id — a string for exactly the reason `StatusId` is one. */
export type KindId = string;

/**
 * Group-header order for a DEFAULT workspace. The live answer is
 * `configuredGroupOrder()` in lib/settings.ts, which is what a surface that has
 * fetched `/api/settings` must ask; this is the seed it falls back to before the
 * fetch resolves, and it is byte-identical to what `store.statusOrder()` produces
 * for a default workspace.
 *
 * Still typed `IssueStatus[]` rather than `StatusId[]`, and for the same reason the
 * union survives above: `views/tree/tree-model.ts` declares
 * `GROUP_ORDER: readonly IssueStatus[] = [...OPEN_STATUS_ORDER, ...RESOLVED_STATUSES]`,
 * so widening the element type here breaks a file O3 owns. It widens with the union,
 * in the same one commit.
 */
export const OPEN_STATUS_ORDER: readonly IssueStatus[] = [
  "in_progress",
  "in_review",
  "awaiting_approval",
  "blocked",
  "todo",
  "backlog",
];

/** Where a review gate is in its life. Mirrors `GateState` in src/core/types.ts. */
export const GATE_STATES = ["pending", "approved", "changes_requested"] as const;
export type GateState = (typeof GATE_STATES)[number];

/**
 * The review gate ON an issue (STA-143), mirroring `IssueGate` in
 * src/core/types.ts. A SIBLING of the issue on the wire for the same reason
 * `claim` is one.
 *
 * `state: "pending"` is the only one that parks the parent and queues the
 * subtree; the other two are history, kept so a surface can still say who
 * decided what and when.
 */
export interface IssueGate {
  state: GateState;
  owner: string;
  requestedBy: string | null;
  requestedAt: string;
  resolvedBy: string | null;
  resolvedAt: string | null;
}

/**
 * The gate an issue is QUEUED BEHIND, mirroring `QueuedBy` in src/core/types.ts.
 * Derived server-side by walking ancestors; the UI must never recompute it.
 *
 * Non-null means checkout is refused. `gate` and `queuedBy` are complementary
 * and at most one is ever set on a row: one says "holds a queue", the other says
 * "stands in one".
 */
export interface QueuedBy {
  identifier: string;
  owner: string;
}

export const RESOLVED_STATUSES: readonly IssueStatus[] = ["done", "cancelled"];

/**
 * The BUILT-IN issue kinds — the seed of `workspace_kinds`, O7a (STA-140).
 * Like the statuses, the live list is served; this is what it starts as.
 */
export const ISSUE_KINDS = ["epic", "task", "bug", "chore", "spike"] as const;
export type BuiltinIssueKind = (typeof ISSUE_KINDS)[number];
/** A kind id, as served. */
export type IssueKind = KindId;
export const DEFAULT_ISSUE_KIND = "task";

/**
 * Sort/group rank for the seeded kinds — what a view grouping a board or a list
 * by kind orders its buckets on (O1c). Mirror of `KIND_RANK` in core/types.ts.
 *
 * A configured kind the operator added is absent here. Sort it LAST rather than
 * first (`KIND_RANK[k] ?? ISSUE_KINDS.length`): a value this mirror has never
 * heard of belongs at the bottom of the list, not the top of everyone's board.
 */
export const KIND_RANK: Readonly<Record<string, number>> = Object.fromEntries(
  ISSUE_KINDS.map((kind, index) => [kind, index]),
);

/**
 * The eight status CATEGORIES — fixed, non-configurable, and the thing every
 * behaviour keys off (src/core/types.ts `STATUS_CATEGORIES`).
 *
 * This is the constant that makes a custom status renderable. Colour and glyph are a
 * property of the CATEGORY, never of the id, so a workspace that adds `pairing` in
 * `active` gets the in_progress half-ring and the in_progress hue without a single new
 * token — see styles/app.css and components/task-list/StatusIcon.tsx.
 *
 * `/api/settings` serves the same list back on every response; this copy is the
 * fallback for a surface rendering before that fetch resolves.
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

/** Categories that mean "finished", in either direction. */
export const RESOLVED_CATEGORIES: readonly StatusCategory[] = ["done", "cancelled"];

/**
 * The mirror of core's `VOCABULARY_ID_PATTERN`: lowercase snake_case, starting with a
 * letter, at most 32 characters.
 *
 * Ids are interpolated into `IN (…)` and `CASE` SQL fragments the store builds per query,
 * they are dictionary keys on the wire, and they end up in URLs — a closed character set
 * is what makes all three safe at once. It is mirrored here, in the leaf module with no
 * imports, so the settings editor can say what is wrong BEFORE the round trip. The store
 * still refuses independently, and its sentence is the one a refusal renders.
 */
export const VOCABULARY_ID_PATTERN = /^[a-z][a-z0-9_]{0,31}$/;

/** One configured status row, in configured order. Mirrors core `WorkspaceStatus`. */
export interface WorkspaceStatus {
  id: string;
  label: string;
  category: StatusCategory;
  sortOrder: number;
  /** True for a row staple seeded. Informational — built-ins are editable. */
  isBuiltin: boolean;
}

/** One configured kind row, in configured order. Mirrors core `WorkspaceKind`. */
export interface WorkspaceKind {
  id: string;
  label: string;
  sortOrder: number;
  isBuiltin: boolean;
}

/**
 * One edit in an ordered `/api/settings` batch — the wire mirror of core's
 * `VocabularyOp`, and the same shape MCP's `update_statuses` takes.
 *
 * A BATCH rather than a verb per request because "add `pairing` and put it after
 * `in_progress`" is one intention, and splitting it over two round trips leaves a
 * window where every list in the workspace is visibly wrong.
 */
export type VocabularyOp =
  | { op: "add"; id: string; label?: string; category?: StatusCategory; after?: string | null }
  | { op: "rename"; id: string; label: string }
  | { op: "recategorize"; id: string; category: StatusCategory }
  | { op: "reorder"; ids: string[] }
  | { op: "remove"; id: string; migrateTo?: string | null };

/**
 * What GET /api/settings answers — and what POST answers too, identically.
 *
 * The two being the SAME envelope is the point: after a write the editor re-derives
 * from the response rather than merging it into a list it fetched earlier, which is
 * where a settings screen usually stops matching what the store believes.
 */
export interface WorkspaceSettings {
  workspace: string;
  /** CONFIGURED order — what the settings editor's drag produces and paints. */
  statuses: WorkspaceStatus[];
  kinds: WorkspaceKind[];
  /**
   * GROUP-HEADER AND SORT ORDER — `store.statusOrder()`, computed server-side.
   *
   * Not the same list as `statuses` and deliberately so. It tiers by CATEGORY (active,
   * review, gated, blocked, ready, unstarted, done, cancelled) and lets the configured
   * order break ties inside a tier, which is the identical rank the store's own SQL
   * `CASE` fragment sorts rows by. A client that re-derived the tiering would be a
   * second authority on it, and the first disagreement would be a group header sitting
   * above rows sorted the other way.
   *
   * For a default workspace it is byte-identical to `[...OPEN_STATUS_ORDER,
   * ...RESOLVED_STATUSES]`, which is what makes it a drop-in for tree-model's
   * `GROUP_ORDER`.
   */
  groupOrder: StatusId[];
  /** `groupOrder` minus the resolved categories. */
  openOrder: StatusId[];
  /** The agent inbox's pickup tiers, for a surface that wants to mirror them. */
  pickupOrder: StatusId[];
  categories: StatusCategory[];
  /** Categories the code writes into: the last member of one may not be removed. */
  requiredCategories: string[];
  /**
   * How many issues still carry each id. What makes the migrate-to picker REQUIRED
   * rather than merely offered — the store still owns the refusal.
   */
  usage: { statuses: Record<string, number>; kinds: Record<string, number> };
}
export const ISSUE_PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type IssuePriority = (typeof ISSUE_PRIORITIES)[number];

export type CommentAuthorType = "user" | "agent" | "system";

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  description: string | null;
  status: IssueStatus;
  statusVersion: number;
  /** Declared kind (STA-124). Never null — the column is NOT NULL with a default. */
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
   * Plan-time estimate in seconds. STORED, unlike everything in `IssueTiming`
   * below, so it belongs on the entity — it is a fact somebody asserted, not a
   * reading off a clock.
   *
   * null means "no estimate recorded", which is NOT the same as zero. Anything
   * rendering this must say the first thing rather than draw the second.
   */
  estimatedSeconds: number | null;
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Estimate vs actual, mirroring `IssueTiming` in src/core/types.ts.
 *
 * A SIBLING of the issue on the wire, for exactly the reason `ClaimActivity` is
 * one: it is derived against the server's data at response time. The UI never
 * recomputes it and never ticks it forward locally — it re-reads it on the
 * existing fingerprint poll, the same way the claim durations are re-read.
 *
 * The actual is a sum of reconstructed `in_progress` INTERVALS, so blocked and
 * parked windows cost nothing, and an open interval is counted through the
 * holder's last activity rather than through `now`. That is why a page can now
 * say "idle" instead of "still running" about a task whose agent went quiet: the
 * server hands it the instant the clock stopped (`countedThrough`).
 *
 * Every nullable number distinguishes "not recorded" from "recorded as nothing".
 * `childrenEstimatedSeconds` is null when NO direct child carries an estimate,
 * so a parent view prints "no estimates recorded" instead of a fabricated 0 and
 * a delta computed against it.
 *
 * Rollups cover DIRECT children, and each child contributes its own headline —
 * so the totals equal the sum of the rows a parent view actually lists.
 */
export interface IssueTiming {
  /** Echo of `Issue.estimatedSeconds`; null when none was recorded. */
  estimatedSeconds: number | null;
  /**
   * Seconds this issue itself was in_progress, EXCLUDING intervals opened by a
   * derived flip of ANY rung. Usually null for an epic — nobody claims an
   * epic, they claim its children.
   */
  ownActiveSeconds: number | null;
  /**
   * The headline actual: `ownActiveSeconds` for a leaf, `childrenActiveSeconds`
   * for a parent (a parent has no independent stopwatch), null when cancelled or
   * never run.
   */
  activeSeconds: number | null;
  /** in_review time, deliberately NOT part of the actual; null when never reviewed. */
  reviewSeconds: number | null;
  /** True when the numbers fell back to the two-timestamp span — render "approx". */
  approximate: boolean;
  /**
   * The instant an open interval was counted through — never `now`. null when
   * nothing is accumulating, which is what lets the page stop saying "still
   * running" under an epic nobody is working.
   */
  countedThrough: string | null;
  /** Direct children only. 0 for a leaf. */
  childCount: number;
  childrenEstimatedSeconds: number | null;
  childrenActiveSeconds: number | null;
  /** Direct children per status; every status present, zeros included. */
  childStatusCounts: Record<IssueStatus, number>;
  /** The recursive plan for the subtree, beside the depth-1 fields above. */
  subtreePlan: SubtreePlan;
}

/** Where a `SubtreePlan.estimatedSeconds` came from. */
export type PlanSource = "own" | "descendants" | "none";

/**
 * The estimate rollup that survives an epic-of-epics, mirroring `SubtreePlan`
 * in src/core/types.ts. One rule keeps it from counting anything twice: an
 * issue contributes its own estimate if it has one, otherwise the sum of its
 * children's contributions — never both.
 */
export interface SubtreePlan {
  /** The effective (top-down) plan: own estimate if recorded, else `descendantsEstimatedSeconds`. */
  estimatedSeconds: number | null;
  source: PlanSource;
  /** The bottom-up plan: sum of the direct children's effective plans; null when no descendant has one. */
  descendantsEstimatedSeconds: number | null;
  /** Descendants at any depth whose own estimate is a term of the bottom-up sum. */
  contributingCount: number;
  /** Descendants at any depth. 0 for a leaf. */
  totalCount: number;
}

/**
 * Derived liveness for a HELD issue, mirroring `ClaimActivity` in src/core/types.ts.
 *
 * Not part of `Issue`, on either side of the wire: `heldSeconds` and `idleSeconds` are
 * readings taken against the server's clock at response time, and freezing a clock
 * reading into an entity is a lie waiting to happen. Every surface attaches it as a
 * SIBLING field, and it is null whenever nobody holds the issue.
 *
 * `lastActivityAt` is the newest of the checkout itself and anything the HOLDER did on
 * that issue afterwards. Another agent commenting on your ticket does not make you look
 * alive — which is the whole reason this number can be trusted to mean "silent".
 *
 * The UI never recomputes these. It re-reads them: see lib/claim.ts.
 */
export interface ClaimActivity {
  heldBy: string;
  checkoutAt: string;
  lastActivityAt: string;
  /** Wall-clock seconds since the claim was taken. */
  heldSeconds: number;
  /** Wall-clock seconds since the holder last did anything here. */
  idleSeconds: number;
}

/**
 * What `inbox()` adds on top of an issue.
 *
 * `claim` is attached by the server ONTO each inbox entry (it spreads the liveness in
 * beside the issue's own fields) rather than sitting beside it as it does on IssueRow.
 * The two endpoints genuinely differ in shape here; this type follows the wire.
 */
/**
 * A child that is blocking its parent, with the descriptor the CHILD was blocked
 * with (STA-98).
 *
 * A parent whose `blocked` was derived from its children deliberately carries no
 * `unblockOwner`/`unblockAction` of its own — copying them onto the parent would
 * be a second copy that goes stale the moment the child moves. So the parent
 * borrows the child's at render time, and this is what it borrows.
 */
export interface BlockingChild {
  identifier: string;
  title: string;
  unblockOwner: string | null;
  unblockAction: string | null;
}

export interface InboxIssue extends Issue {
  unresolvedBlockers: string[];
  claim: ClaimActivity | null;
  /**
   * Latest worklog, or null when nothing has been checkpointed. Spread onto the entry
   * beside `claim` because that is the shape this route has — see the note above.
   * Optional here for the same reason it is optional on `IssueRow`.
   */
  worklog?: WorklogSummary | null;
  /** Blocked open children, when this row is in the blocked bucket. */
  derivedBlockers: BlockingChild[];
  /**
   * The gate pair (STA-143). Spread onto the entry beside `claim`, following the
   * wire like everything else on this type.
   *
   * Optional HERE for the reason `worklog` is: fixtures and synthesised rows
   * have no opinion about gates, and a required field would be a pair of nulls
   * in every one of them. The SERVER always sends both.
   */
  gate?: IssueGate | null;
  queuedBy?: QueuedBy | null;
}

export interface IssueComment {
  id: string;
  issueId: string;
  author: string;
  authorType: CommentAuthorType;
  body: string;
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
  /** Only present when the server was asked for bodies. */
  body?: string;
}

/**
 * The document key agents checkpoint under, and the ONE place the app writes that
 * string down.
 *
 * A hand-kept mirror of `WORKLOG_KEY` in src/core/types.ts, for the same reason
 * everything else in this file is one: the app cannot import Node-only `src/core`.
 * If the canonical value there changes, change it here.
 *
 * Every app-side module that needs the key should import it from HERE rather than
 * declaring its own — including `lib/worklog.ts`, which STA-108's spec §5d originally
 * nominated as the owner. A second literal is the exact grep-across-files problem the
 * constant exists to prevent, and this module is pure and import-free, so a relative
 * import of it stays typecheckable from `test/` under the Node tsconfig.
 */
export const WORKLOG_KEY = "worklog";

/**
 * The server's summary of the latest worklog, mirroring `WorklogSummary` in
 * src/core/types.ts. Attached by `/api/issues` and `/api/inbox` (STA-113).
 *
 * This is NOT a second reading of claim liveness and must never be rendered as one.
 * `claim.lastActivityAt` says the holder did something; `updatedAt` says the holder
 * left a handoff. An agent who is busy and has stopped checkpointing looks live on the
 * first and stale on the second, and that gap is the entire point of the field.
 *
 * Read it, never recompute it: like the claim durations, this is a server reading
 * refreshed by the fingerprint poll, not something the page ticks locally.
 */
export interface WorklogSummary {
  /** `WORKLOG_KEY` today. A field, not an assumption — do not hardcode it in a view. */
  key: string;
  /** How many checkpoints exist, not merely whether one does. */
  revisions: number;
  /** ISO-8601. The ONE freshness reading. */
  updatedAt: string;
  /** Author of the current revision; null when the writer did not sign it. */
  author: string | null;
}

export interface IssueDocument {
  key: string;
  revision: number;
  body: string;
  title: string | null;
  author: string | null;
  createdAt: string;
}

/**
 * One entry in a document's history, as GET /api/revisions returns it (newest first).
 * Mirrors store.listDocumentRevisions().
 */
export interface DocumentRevision {
  revision: number;
  author: string | null;
  changeSummary: string | null;
  createdAt: string;
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

/** A relation as the detail endpoint returns it: identifier + enough to render a chip. */
export interface IssueRef {
  identifier: string;
  title: string;
  status: IssueStatus;
}

/** A blocker living in another workspace file, resolved through the hub. */
export interface CrossBlocker {
  identifier: string;
  workspace: string;
  /** null means the workspace file is not on this machine. */
  status: string | null;
  resolved: boolean;
  unresolvable: boolean;
}

// ---------- endpoint payloads ----------

export type UiMode = "workspace" | "hub";

export interface WorkspaceRef {
  slug: string;
  prefix: string;
}

/** GET /api/bootstrap */
export interface Bootstrap {
  mode: UiMode;
  workspaces: WorkspaceRef[];
}

/** GET /api/poll — the whole auto-refresh contract, one string. */
export interface Poll {
  fingerprint: string;
}

/**
 * A pull/merge request linked to an issue. Populated by a future git integration (V5 §9).
 *
 * There is no git integration, no column, and no endpoint that produces one of these today.
 * The type exists so the row's PR slot has a contract to be built against, and so turning
 * the badge on later is a SERVER-only change: the row renders nothing at all when the array
 * is absent or empty, which is exactly what it does now.
 */
export interface PullRequestRef {
  provider: "github" | "gitlab" | "bitbucket";
  /** Display number, e.g. 1423 for #1423. */
  number: number;
  /** Absolute URL to the PR. Opened in a new tab; never fetched by the UI. */
  url: string;
  state: "draft" | "open" | "merged" | "closed";
  /** Optional; tooltip only. */
  title?: string | null;
  /** ISO-8601. Optional; tooltip only. */
  updatedAt?: string | null;
}

/** GET /api/issues */
/**
 * What this row is waiting on, and what is waiting on it — O6 (STA-138).
 *
 * IDENTIFIERS, NOT COUNTS. They cost the same query server-side and they are what lets a
 * badge's tooltip name what it is counting without a second fetch. A count is `.length`.
 *
 * Both lists are already FILTERED to what still matters: `blockedBy` holds blockers that are
 * not resolved, `blocks` holds dependents that are still open. That filtering happens in SQL,
 * once for the page, because the alternative is every surface re-deriving "does done count"
 * and one of them eventually getting it wrong.
 *
 * Titles and statuses are deliberately absent. The badge does not need them; the Dependencies
 * dialog does, and it fetches `/api/issue` on open — which is the endpoint that already has
 * them. Putting them here would multiply the list payload to serve a dialog most rows never
 * open.
 */
export interface IssueDeps {
  /** Unresolved blockers. `[]` means nothing is in the way. */
  blockedBy: string[];
  /** Open issues this one blocks. `[]` means nothing is waiting on it. */
  blocks: string[];
}

/**
 * WHETHER AN AGENT COULD TAKE THIS ROW RIGHT NOW — R4b (STA-187), docs/queue.md "Policy".
 *
 * Five words, one per row, first match wins, mirroring the resolver's eligibility ladder:
 * `gated` and `blocked` are the hard constraints it names before anything else, `claimed`
 * is somebody else already inside the work, and what is left is takeable. `queued` is the
 * one the browser cannot derive on its own — it means "eligible, but the plan puts another
 * row first", and order is the resolver's knowledge.
 *
 * A resolved row has NO pickup state (`null`): finished work is not waiting for anything and
 * saying it is "not pickable" would file it beside work that is stuck.
 */
export const PICKUP_STATES = ["pickable", "queued", "waiting", "gated", "in_flight"] as const;
export type PickupState = (typeof PICKUP_STATES)[number];

export interface IssueRow {
  workspace: string;
  issue: Issue;
  /** Liveness of the holder, or null when the issue is not held. One batched query per workspace. */
  claim: ClaimActivity | null;
  /**
   * Latest worklog, or null when nothing has been checkpointed (STA-113). One batched
   * query per workspace, exactly like `claim`.
   *
   * A SIBLING of `issue` and not a field on it, for the reason given on `pullRequests`
   * below: a different clock than the entity.
   *
   * The SERVER always sends this field — `/api/issues` writes an explicit null rather
   * than omitting it, and `test/ui-worklog-summary.test.ts` pins that. It is optional
   * HERE for the reason §5c of the STA-108 spec gives: a caller that has no summary
   * (a fixture, a synthesised row) passes nothing, and every view is then obliged to
   * *check* the field rather than assume it — which is the same discipline that keeps
   * a missing worklog from ever rendering as a present-but-empty one.
   */
  worklog?: WorklogSummary | null;
  /**
   * Dependency edges, as a SIBLING of `issue` for the same reason `claim` is one: these are
   * relations, not fields, and freezing them onto the entity would be a copy that goes stale
   * the moment an edge moves.
   *
   * Optional on the TYPE and always present on the WIRE. Optional because three other places
   * construct an `IssueRow` (fixtures, the palette's synthesised rows, tests) and none of
   * them has an opinion about dependencies; a required field there would be six `deps: {
   * blockedBy: [], blocks: [] }` literals saying nothing.
   */
  deps?: IssueDeps;
  /**
   * Linked pull requests, newest-first. OPTIONAL and absent today — see `PullRequestRef`.
   *
   * A SIBLING of `issue` rather than a field on it, for the same reason `claim` is one:
   * this is externally sourced and refreshed on a different clock than the issue, and
   * freezing it into the entity would be a lie waiting to happen.
   */
  pullRequests?: PullRequestRef[];
  /**
   * The review gate ON this row, and the gate this row is QUEUED BEHIND
   * (STA-143). Two SIBLINGS of `issue` rather than one wrapper: they are
   * complementary facts, at most one is ever non-null, and which one it is
   * changes what the row should say completely.
   *
   * Optional on the TYPE and always present on the WIRE, for the reason `deps`
   * gives above.
   */
  gate?: IssueGate | null;
  queuedBy?: QueuedBy | null;
  /**
   * WHERE THIS ROW SITS IN THE PICKUP PLAN — R2's queue, as a READING (STA-186).
   *
   * Two fields because R4c (STA-188) has to tell two things apart on the same row and the
   * queue contract keeps them apart: `queuePosition` is the EFFECTIVE position an actionable
   * row holds in the pickup queue, `planPosition` is the plan position a CONTAINER carries.
   * A row can have both, one, or neither.
   *
   * SIBLINGS of `issue`, like `claim` and `gate`, and for the same reason: the plan is a
   * relation on a different clock, and freezing it onto the entity would be a copy that goes
   * stale the moment somebody reorders the queue.
   *
   * OPTIONAL ON THE TYPE and supplied by `/api/issues` — the same discipline `deps` and
   * `worklog` follow, so a fixture or a synthesised row need not have an opinion and every
   * consumer is obliged to check rather than assume. `null` means "not in the plan", which is
   * NOT the same as position 0, and `lib/sort-modes.ts` treats absent and null identically.
   *
   * READ ONLY, EVERYWHERE IN THE UI. `docs/queue.md` is explicit that presentation sort is
   * not the queue: the list may display and order by these numbers and may never set them.
   * The one write path is the queue's own API.
   */
  planPosition?: number | null;
  queuePosition?: number | null;
  /**
   * WHETHER THIS ROW CAN BE PICKED UP, AND WHY NOT — R4b (STA-187).
   *
   * The queue resolver's own answer, as one word. It is a SIBLING of `issue` for the reason
   * `planPosition` is one: eligibility is re-derived against the store's clock on every read
   * (a claim taken a second ago changes it), so freezing it onto the entity would be a copy
   * that is wrong within a poll.
   *
   * OPTIONAL AND ABSENT UNTIL R2c SERVES IT, which is why every reader must treat absence as
   * "unknown" rather than as "not pickable". `lib/filter-dimensions.ts` does: it prefers this
   * field and falls back to deriving four of the five states from the gate, the blockers, the
   * claim and the status when it is missing. `pickupReason` is the resolver's `detail`
   * rendered as a sentence — the blocker identifiers, the gate owner, the holder — and is
   * null whenever there is nothing to explain.
   */
  pickupState?: PickupState | null;
  pickupReason?: string | null;
}

/** GET /api/inbox */
export interface InboxRow {
  workspace: string;
  /**
   * `queued` (STA-143) is gate-held work: never `ready`, and checkout of it is
   * refused. An entry with `queuedBy` is waiting on the gate it names; an entry
   * with a pending `gate` and no `queuedBy` IS the gate.
   */
  inbox: { ready: InboxIssue[]; queued: InboxIssue[]; blocked: InboxIssue[]; hasMore: boolean };
}

/** GET /api/issue */
export interface IssueDetail {
  workspace: string;
  issue: Issue;
  ancestors: Issue[];
  children: Issue[];
  blockedBy: IssueRef[];
  blocks: IssueRef[];
  comments: IssueComment[];
  documents: IssueDocumentMeta[];
  crossBlockers: CrossBlocker[];
  claim: ClaimActivity | null;
  /** Estimate vs actual for this issue. What the Analytics tab renders. */
  timing: IssueTiming;
  /**
   * Estimate vs actual per DIRECT child, keyed by child IDENTIFIER (`STA-42`),
   * not by the internal uuid. Joins against `children` on `.identifier`.
   */
  childrenTiming: Record<string, IssueTiming>;
  /**
   * The gate pair for THIS issue (STA-143), as siblings — same argument `claim`
   * makes. At most one is ever non-null: `gate` says this issue holds a queue,
   * `queuedBy` says it stands in one.
   */
  gate: IssueGate | null;
  queuedBy: QueuedBy | null;
  /**
   * WHAT THIS GATE IS HOLDING — the review checklist (Q2/STA-144, rewritten by
   * Q5/STA-154).
   *
   * A flat PRE-ORDER list of the OPEN descendants this issue's gate still holds
   * and has not released, each carrying the `depth` the checklist indents by. Not
   * a map of direct children any more: approving a parent releases its whole
   * subtree, so a list that could not show the subtree could not show what a tick
   * does. Empty when this issue holds no active gate, which is every issue but
   * one.
   *
   * The SERVER filters it, and that is not an implementation detail: per-child
   * approval sets a release flag no client can see, and eligibility (open, and
   * not a container with nothing open underneath) is the store's rule. The
   * browser renders this list; it does not re-derive it.
   *
   * On `/api/issue` only. `/api/agent-context` is pinned byte-for-byte against
   * the MCP `get_task` tool and this is a UI affordance, so it stays on the UI's
   * own route — the same line `deps` draws on `/api/issues`.
   */
  childrenQueued: GateQueueEntry[];
}

/**
 * One row of a gate's queue, mirroring `GateQueueEntry` in src/core/types.ts.
 *
 * `depth` counts the LISTED chain, not the real tree: a row whose real parent is
 * not in the list (it was resolved, or it had nothing open underneath) is
 * re-parented onto the nearest listed ancestor. So `depth` is always safe to use
 * directly as an indent — a row is never indented under something that is not on
 * screen. Direct children of the gate holder are depth 1.
 */
export interface GateQueueEntry {
  id: string;
  identifier: string;
  title: string;
  status: IssueStatus;
  parentId: string | null;
  depth: number;
}

/**
 * GET /api/agent-context — the payload the MCP `get_task` tool returns, verbatim.
 *
 * Deliberately NOT `IssueDetail`: that adds a `workspace` key the agent never sees, and
 * this type exists precisely so the difference stays visible. Document bodies are
 * present only when the route was called with `documents=1`, mirroring get_task's
 * `include_documents`.
 */
export interface AgentContext {
  issue: Issue;
  ancestors: Issue[];
  children: Issue[];
  blockedBy: IssueRef[];
  blocks: IssueRef[];
  comments: IssueComment[];
  documents: IssueDocumentMeta[];
  crossBlockers: CrossBlocker[];
  /** get_task carries this, so the "what the agent sees" pane must show it too. */
  claim: ClaimActivity | null;
  /** So does the timing pair — both surfaces spread the same store expression. */
  timing: IssueTiming;
  childrenTiming: Record<string, IssueTiming>;
}

/** GET /api/graph */
export interface GraphNode {
  id: string;
  workspace: string;
  title: string;
  status: IssueStatus;
  /**
   * Holder liveness, IF the endpoint ever carries it. Optional because today it does
   * not: /api/graph returns id/workspace/title/status and nothing else.
   *
   * Declared anyway, and read by the canvas node (G2), because the alternative is worse.
   * A graph is exactly where "who is sitting on the thing everything else is waiting for"
   * should be visible, and wiring the badge later would mean touching the node component
   * again. With the field optional, adding `claim` to the server's graph payload is a
   * server-only change and the badge lights up on its own. Absent, nothing renders —
   * which reads identically to a healthy claim, the honest outcome when the page has no
   * liveness reading to show.
   */
  claim?: ClaimActivity | null;
  /**
   * The issue's declared kind (STA-124) — what the canvas draws its kind glyph from.
   *
   * Optional here for one reason only: BOTH producers send it (the workspace route
   * and `Hub.graph()` alike, unlike `parent` below), so absence never means "this
   * graph has no kind information" — it means the page is talking to an older
   * server. Treat a missing value as `DEFAULT_ISSUE_KIND` rather than as a hole.
   */
  kind?: IssueKind;
  /**
   * The parent ticket's IDENTIFIER (`STA-53`), not its uuid — this whole payload is
   * keyed by identifier. What epic clustering groups on (G3).
   *
   * Optional because one of the two producers does not send it: the workspace route
   * does, `Hub.graph()` does not. Absent is not an error and not a hole to paper over
   * — it means "this graph has no parent information", from which the client derives
   * no epics and draws the flat graph. That is exactly hub mode's behaviour today, so
   * the degradation is a real state rather than a fallback nobody has seen.
   */
  parent?: string | null;
}

export interface GraphEdge {
  from: string;
  to: string;
  cross: boolean;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

// ---------- write actions ----------

/**
 * Every POST /api/action body. Discriminated on `type` so a bad action is a type
 * error here rather than a 409 at runtime.
 *
 * WAVE 2 (U5/U6): adding a write means adding a member here AND a branch in
 * src/ui/server.ts's /api/action handler. Keep them in step.
 */
export type ActionPayload =
  | { type: "status"; status: IssueStatus; comment?: string }
  /**
   * Claim the issue. `stealIfIdleSeconds` (C3) turns this into an explicit TAKEOVER: the
   * store hands the claim over only if the current holder has been silent at least that
   * long, and otherwise refuses with its own sentence. Absent, this is the plain
   * checkout it always was — which is exactly what the "claim" button still sends.
   *
   * The threshold is a request, not a verdict. The store re-checks it against its own
   * clock at write time, so a holder who wakes up between the render and the click keeps
   * their work and the page shows the refusal.
   */
  | { type: "checkout"; stealIfIdleSeconds?: number }
  /**
   * Give a claim back. `ifIdleSeconds` (C3) lets a caller who is NOT the holder free a
   * claim whose holder has gone silent at least that long. Absent, only the holder may
   * release, as before.
   */
  | { type: "release"; ifIdleSeconds?: number }
  | { type: "comment"; body: string }
  | { type: "assignee"; assignee: string | null }
  /**
   * Restore an old document revision. Rides POST /api/action rather than getting its
   * own route, because at the time the server's method/Origin gate was a comparison
   * against that one literal path and a new route would have had to change it. Q2
   * (STA-144) turned that into an `isWrite` predicate for the `/api/gate` family, so
   * the constraint is gone — but this action is still one verb over one ref, which is
   * exactly the shape `/api/action` is for, and moving it would buy nothing.
   * `baseRevision` is the revision
   * the UI believed was current: if someone else wrote in between, the store answers
   * revision_conflict (409, retryable) instead of silently clobbering their work.
   */
  | { type: "doc_restore"; key: string; revision: number; baseRevision: number }
  /**
   * Create a task from the page (U5). The only action with no `ref` — there is no
   * issue yet — which is why `action()`'s target type in lib/api.ts makes `ref`
   * optional. Everything absent here is a store default: no priority means medium,
   * no parent means a root task, and status is the store's own rule (todo when
   * assigned, backlog otherwise) rather than anything the dialog decides.
   *
   * The store owns every refusal this can produce: an empty title, the tree depth
   * cap, and the normalized-title duplicate guard. The dialog renders those
   * sentences verbatim through describeRefusal() and invents none of its own.
   */
  | {
      type: "create";
      title: string;
      description?: string;
      priority?: IssuePriority;
      /**
       * The declared kind (O1b, STA-125). Absent is the WORKSPACE's default, which is
       * `store.defaultKind()` and not necessarily `task` — a workspace that removed
       * `task` from its vocabulary has a different one, and hard-coding the string here
       * would make the dialog a second authority on it.
       */
      kind?: IssueKind;
      parent?: string;
      labels?: string[];
      blockedBy?: string[];
      /**
       * Refs the NEW task should block — the inverse of `blockedBy`, added by R7
       * (STA-103) for the create form's Blocking field.
       *
       * There is no store input for this and there never was: `CreateIssueInput` has no
       * `blocking`, and neither does the CLI's `new` nor MCP's `create_task`. The
       * inverse relation is only expressible as "rewrite the OTHER issue's blocked-by
       * set", which `store.setBlockedBy` does with REPLACE semantics — so it has to be
       * read-modify-written, and the server's `create` branch does that inside the same
       * request rather than letting the UI straddle a round trip with it.
       *
       * Absent is exactly the old behaviour, which is why this is a key on `create`
       * rather than a second action type.
       */
      blocking?: string[];
    }
  /**
   * Inline property editing (U5). A partial patch: a key that is absent is left
   * alone by the store, so editing a title cannot blank the labels. `labels` is the
   * WHOLE next list, not a delta — adding or removing a chip sends the result.
   *
   * Status is not here on purpose. It has its own `status` member and its own server
   * branch, which is also the branch that fans a done/cancelled out to the hub.
   */
  /**
   * `kind` (O1b, STA-125) is TWO-STATE, not three, and that is `UpdateIssueInput`'s rule
   * carried onto the wire rather than a shortcut: `issues.kind` is NOT NULL with a
   * default, so "no kind" is not a state the tracker can represent and there is nothing
   * for a `null` to mean. Contrast `assignee`, which has its own action precisely
   * because clearing it IS a real and distinct fact.
   */
  | { type: "update"; title?: string; priority?: IssuePriority; kind?: IssueKind; labels?: string[] };

/** The error envelope every staple surface speaks. */
export interface ErrorEnvelope {
  error: string;
  message: string;
  code: string;
  detail?: Record<string, unknown>;
  retryable: boolean;
}

// ---------- milestones (R3c / STA-173) ----------

/**
 * The milestone view as every surface prints it — the mirror of `MilestoneView` in
 * `src/core/milestone-store.ts` and the JSON shape in docs/milestones.md. One shape for
 * `GET /api/milestone`, and for the result of every `POST /api/milestone/*` write, so the
 * page redraws from a write result exactly as it does from a read.
 */
export const MILESTONE_STATES = ["planned", "active", "overdue", "done", "cancelled"] as const;
export type MilestoneState = (typeof MILESTONE_STATES)[number];

export interface MilestoneSummary {
  identifier: string;
  title: string;
  status: StatusId;
  kind: KindId;
  assignee: string | null;
  targetDate: string | null;
  startDate: string | null;
  /** Derived on every read; never stored. */
  state: MilestoneState;
  /** The milestone's row in the pickup plan; null until the queue (R3d) fills it. */
  planPosition: number | null;
}

export interface MilestoneProgress {
  total: number;
  countable: number;
  counts: Record<StatusCategory, number>;
  /** `floor(done · 100 / countable)`; null when nothing is countable. */
  percent: number | null;
  complete: boolean;
}

export interface MilestoneMemberRow {
  identifier: string;
  title: string;
  kind: KindId;
  status: StatusId;
  /** 1-based, in rank order. */
  position: number;
  rank: number;
  /** The member's real parent, untouched by membership. */
  parent: string | null;
  /** The nearest ancestor that is ALSO a direct member here, so the view can indent. */
  nestedUnder: string | null;
  addedBy: string;
  addedAt: string;
  note: string | null;
}

export interface MilestoneNext {
  identifier: string;
  position: number;
}

export interface MilestoneView {
  milestone: MilestoneSummary;
  progress: MilestoneProgress;
  /** The `members_revision` CAS base every write must carry back. */
  revision: number;
  members: MilestoneMemberRow[];
  /** The next eligible row from the queue resolver; null until R3d. */
  next: MilestoneNext | null;
}

/** A `GET /api/milestones` row: the view without its members, plus how many there are. */
export type MilestoneListRow = Omit<MilestoneView, "members"> & { memberCount: number };
