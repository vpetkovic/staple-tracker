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

/** Column order on the board and the order the old page listed things in. */
export const OPEN_STATUS_ORDER: readonly IssueStatus[] = [
  "in_progress",
  "in_review",
  "blocked",
  "todo",
  "backlog",
];

export const RESOLVED_STATUSES: readonly IssueStatus[] = ["done", "cancelled"];

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
  /** Blocked open children, when this row is in the blocked bucket. */
  derivedBlockers: BlockingChild[];
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

export interface IssueRow {
  workspace: string;
  issue: Issue;
  /** Liveness of the holder, or null when the issue is not held. One batched query per workspace. */
  claim: ClaimActivity | null;
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
}

/** GET /api/inbox */
export interface InboxRow {
  workspace: string;
  inbox: { ready: InboxIssue[]; blocked: InboxIssue[]; hasMore: boolean };
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
   * own route so the server's method/Origin gate — which pins /api/action to POST and
   * everything else to GET — did not have to change. `baseRevision` is the revision
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
  | { type: "update"; title?: string; priority?: IssuePriority; labels?: string[] };

/** The error envelope every staple surface speaks. */
export interface ErrorEnvelope {
  error: string;
  message: string;
  code: string;
  detail?: Record<string, unknown>;
  retryable: boolean;
}
