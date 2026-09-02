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
  startedAt: string | null;
  completedAt: string | null;
  cancelledAt: string | null;
  createdAt: string;
  updatedAt: string;
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
export interface InboxIssue extends Issue {
  unresolvedBlockers: string[];
  claim: ClaimActivity | null;
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

/** GET /api/issues */
export interface IssueRow {
  workspace: string;
  issue: Issue;
  /** Liveness of the holder, or null when the issue is not held. One batched query per workspace. */
  claim: ClaimActivity | null;
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
