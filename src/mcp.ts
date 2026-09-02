/**
 * staple MCP server (stdio) — the whole agent surface.
 *
 * Register with Claude Code:
 *   claude mcp add staple -- npx tsx <this-repo>/src/mcp.ts
 * Env: STAPLE_DB (explicit workspace file), STAPLE_WS (hub slug/prefix),
 *      STAPLE_AGENT (default agent identity — every write tool can override it
 *      per call with `actor`, and a write with neither is refused), STAPLE_HOME
 *      (hub location).
 * Without STAPLE_DB/STAPLE_WS the workspace resolves by walking up from cwd.
 * Resolution is lazy (see workspaceFor): the server starts and answers
 * tools/list from ANY directory, so a missing workspace surfaces as an
 * in-protocol not_found envelope pointing at the init tool, never as an opaque
 * connection failure. Individual calls may target another workspace with `ws`.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { initWorkspace, resolveWorkspace } from "./core/workspace.js";
import type { OpenedWorkspace } from "./core/workspace.js";
import type { WorkspaceStore } from "./core/store.js";
import { Hub, notifyHubResolvedSafe } from "./core/hub.js";
import type { CrossBlockerState } from "./core/hub.js";
import {
  COMMENT_AUTHOR_TYPES,
  COMMENT_PAGE_LIMITS,
  HUB_EVENT_PAGE_LIMITS,
  ISSUE_PAGE_LIMITS,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  StapleError,
  clampLimit,
  cursorScope,
  decodeOffsetCursor,
  decodeSeqCursor,
  encodeOffsetCursor,
  encodeSeqCursor,
  errorEnvelope,
} from "./core/types.js";
import type {
  ClaimActivity,
  Issue,
  IssueComment,
  IssueStatus,
  IssueTiming,
  PageLimits,
} from "./core/types.js";

/**
 * Agent identity, resolved per call (never captured at startup — a long-lived
 * server is shared by more than one agent). Precedence:
 *
 *   explicit `actor` > the tool's legacy alias (`agent`/`author`) > STAPLE_AGENT
 *
 * There is deliberately NO placeholder fallback: an unattributable write is
 * refused, because a log full of "agent" is worse than an error the caller can
 * fix in one retry. Read tools never call this, and neither does tools/list, so
 * the server still starts and lists tools with no STAPLE_AGENT set (H6).
 */
function requireActor(actor?: string, alias?: string): string {
  const resolved = actor?.trim() || alias?.trim() || process.env.STAPLE_AGENT?.trim();
  if (resolved) return resolved;
  throw new StapleError(
    "validation",
    'This write needs an agent identity. Pass "actor" (your agent name, e.g. "claude-code") on this call, or start the server with STAPLE_AGENT set. Writes are never attributed to a placeholder.',
  );
}

/**
 * Lazily resolved workspaces, cached two ways:
 *
 *  - byAlias: keyed by the literal `ws` argument ("" = the default, i.e.
 *    STAPLE_DB / STAPLE_WS / walk up from cwd). Keying on the alias rather than
 *    on a resolved path is what keeps the walked-up default from leaking into a
 *    ws-targeted call, and vice versa.
 *  - byPath: keyed by the resolved db file, so two aliases naming the same
 *    workspace share ONE open handle instead of racing two.
 *
 * Net cost: at most one resolveWorkspace() (one file open) per distinct alias,
 * once for the life of the process.
 */
const byAlias = new Map<string, OpenedWorkspace>();
const byPath = new Map<string, OpenedWorkspace>();

/**
 * Core's resolution errors are phrased for the CLI ("run staple init", --ws).
 * An MCP caller has no shell, so point it at the tools it actually has.
 */
function asMcpResolutionError(error: unknown, ws?: string): unknown {
  if (!(error instanceof StapleError) || error.code !== "not_found") return error;
  const cause = ws
    ? `No workspace "${ws}" is registered in the hub.`
    : "No staple workspace found at or above this server's working directory.";
  return new StapleError(
    "not_found",
    `${cause} Call the "init" tool to create one, or pass "ws" (a hub-registered workspace slug or identifier prefix) on this call. "hub_overview" lists the registered workspaces.`,
  );
}

/** Resolve (and cache) the workspace a single tool call should operate on. */
function workspaceFor(ws?: string): OpenedWorkspace {
  const alias = ws ?? "";
  const cached = byAlias.get(alias);
  if (cached) return cached;

  let opened: OpenedWorkspace;
  try {
    // STAPLE_DB pins the default workspace, but an explicit per-call ws must
    // never be silently redirected into the pinned file: a write landing in a
    // workspace other than the one named is the failure class per-call
    // targeting exists to remove. Explicit ws resolves through the hub alone.
    opened = ws
      ? resolveWorkspace({ ws })
      : resolveWorkspace({ db: process.env.STAPLE_DB, ws: process.env.STAPLE_WS });
  } catch (error) {
    throw asMcpResolutionError(error, ws);
  }

  const sameFile = byPath.get(opened.dbPath);
  if (sameFile) {
    opened.store.db.close(); // one handle per db file
    byAlias.set(alias, sameFile);
    return sameFile;
  }
  byPath.set(opened.dbPath, opened);
  byAlias.set(alias, opened);
  return opened;
}

function storeFor(ws?: string): WorkspaceStore {
  return workspaceFor(ws).store;
}

/** Drop cached handles so the next call re-resolves (a new workspace may exist). */
function resetWorkspaceCache(): void {
  for (const opened of byPath.values()) {
    try {
      opened.store.db.close();
    } catch {
      // a handle we are discarding anyway
    }
  }
  byPath.clear();
  byAlias.clear();
}

const server = new McpServer({ name: "staple", version: "0.1.0" });

/**
 * structuredContent must be a JSON object (CallToolResult uses a string record),
 * so arrays are wrapped as {items} and scalars as {value}. The text block keeps
 * the original unwrapped payload, compact — same shape as before, minus indent.
 */
function structured(payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) return { items: payload };
  if (payload !== null && typeof payload === "object") return payload as Record<string, unknown>;
  return { value: payload };
}

function ok(payload: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload) }],
    structuredContent: structured(payload),
  };
}

function fail(error: unknown) {
  const envelope = errorEnvelope(error);
  // Prose line first (existing callers grep it), machine-readable envelope below.
  const text = `ERROR(${envelope.code}): ${envelope.message}\n${JSON.stringify({ error: envelope })}`;
  return { content: [{ type: "text" as const, text }], isError: true as const };
}

type ToolResult = ReturnType<typeof ok> | ReturnType<typeof fail>;

function run(fn: () => unknown): ToolResult {
  try {
    return ok(fn());
  } catch (error) {
    return fail(error);
  }
}

function notifyHubIfResolved(store: WorkspaceStore, ref: string, status?: string) {
  if (status !== "done" && status !== "cancelled") return;
  try {
    notifyHubResolvedSafe(store.slug, store.getIssue(ref).identifier);
  } catch {
    // hub is optional at runtime
  }
}

const statusEnum = z.enum(ISSUE_STATUSES);
const priorityEnum = z.enum(ISSUE_PRIORITIES);
const refSchema = z
  .string()
  .describe("Issue reference: identifier like GAR-12, bare number, or uuid");
/** Shared by every workspace-scoped tool; the hub-wide tools deliberately omit it. */
const wsSchema = z
  .string()
  .optional()
  .describe(
    "Target workspace: hub-registered slug or identifier prefix. Defaults to the workspace discovered from the server's working directory.",
  );
const cursorSchema = z
  .string()
  .optional()
  .describe(
    "Opaque cursor from a previous page's nextCursor. Send the SAME filters back with it; a cursor from different arguments is rejected.",
  );
/**
 * Plan-time estimate, in seconds. Three-state, exactly like `assignee`: absent
 * leaves it alone, a number sets it, an explicit null clears it.
 *
 * Range and integrality are checked by the store (`assertEstimateSeconds`), not
 * duplicated here as zod constraints — one refusal sentence, spoken by one
 * place, on every surface. Zod only pins the TYPE, which is what the SDK needs
 * to validate the call shape.
 */
const estimateSchema = z
  .number()
  .nullable()
  .optional()
  .describe(
    "Plan-time estimate in SECONDS (90m = 5400, 2h = 7200). Record it when you plan, before you start — that is what makes the estimate-vs-actual comparison honest. Must be a positive whole number of seconds, at most 365d. Pass null to clear; omit to leave unchanged.",
  );
function limitSchema(limits: PageLimits) {
  return z
    .number()
    .int()
    .positive()
    .max(limits.max)
    .optional()
    .describe(`Page size (default ${limits.default}, max ${limits.max})`);
}

/**
 * Cursor plumbing for the offset-paged lists. `scopeArgs` is everything that
 * defines the result set (tool name, target workspace, filters) — a cursor is
 * only valid for the arguments it was issued for.
 */
function pageWindow(
  scopeArgs: Record<string, unknown>,
  input: { limit?: number; cursor?: string },
  limits: PageLimits,
): { scope: string; limit: number; offset: number } {
  const scope = cursorScope(scopeArgs);
  return {
    scope,
    limit: clampLimit(input.limit, limits),
    offset: input.cursor ? decodeOffsetCursor(input.cursor, scope) : 0,
  };
}

/** null exactly when there is no next page, so callers can loop on either field. */
function nextCursorFor(
  window: { scope: string; offset: number },
  consumed: number,
  hasMore: boolean,
): string | null {
  return hasMore ? encodeOffsetCursor(window.offset + consumed, window.scope) : null;
}

const pageTailShape = {
  nextCursor: z.string().nullable().describe("Pass back as cursor for the next page; null at the end"),
  hasMore: z.boolean(),
};

/**
 * The cross-workspace blocker merge the web UI does on /api/issue, so an agent
 * sees exactly what the human page shows. Every hub failure degrades to []: no
 * hub file, an identifier whose prefix is not registered, an unreadable hub.
 * A blocker whose WORKSPACE file is missing is not swallowed here — the hub
 * reports it as unresolvable/unresolved, which is the "treat as blocked" signal.
 */
function crossBlockersSafe(identifier: string): CrossBlockerState[] {
  try {
    const hub = Hub.open();
    try {
      return hub.crossBlockersOf(identifier);
    } finally {
      hub.close();
    }
  } catch {
    return [];
  }
}

/** Shared by every write tool. Required in effect: no actor and no STAPLE_AGENT is an error. */
const actorSchema = z
  .string()
  .optional()
  .describe(
    "Who is performing this write (your agent name). Falls back to the server's STAPLE_AGENT; if neither is set the call is refused rather than attributed to a placeholder.",
  );

/**
 * Output schema for tools returning an Issue. The SDK validates structuredContent
 * against this at call time and fails the call on mismatch, so the shape is pinned
 * to the Issue interface below — drift breaks typecheck, not a live tool call.
 */
const issueShape = {
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable(),
  status: statusEnum,
  statusVersion: z.number(),
  priority: priorityEnum,
  parentId: z.string().nullable(),
  depth: z.number(),
  assignee: z.string().nullable(),
  createdBy: z.string().nullable(),
  labels: z.array(z.string()),
  acceptanceCriteria: z.array(z.string()).nullable(),
  blockParentUntilDone: z.boolean(),
  unblockOwner: z.string().nullable(),
  unblockAction: z.string().nullable(),
  originKind: z.string(),
  originId: z.string().nullable(),
  idempotencyKey: z.string().nullable(),
  checkoutAgent: z.string().nullable(),
  checkoutAt: z.string().nullable(),
  blockedTransitionAt: z.string().nullable(),
  estimatedSeconds: z
    .number()
    .nullable()
    .describe("Plan-time estimate in seconds; null when none was recorded (NOT zero)"),
  startedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
};

type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Expect<T extends true> = T;
type _IssueShapeMatchesInterface = Expect<Equals<z.infer<z.ZodObject<typeof issueShape>>, Issue>>;

/**
 * Derived liveness for a held issue, so a caller can tell a working agent from
 * one that died hours ago. Null whenever nobody holds the issue. Deliberately a
 * sibling of the issue rather than a field on it — see ClaimActivity in
 * core/types.ts for why a now-relative number must not live on a cached entity.
 */
const claimShape = {
  heldBy: z.string().describe("Agent currently holding the claim"),
  checkoutAt: z.string(),
  lastActivityAt: z
    .string()
    .describe("Newest event or comment BY THE HOLDER on this issue, floored at the checkout"),
  heldSeconds: z.number().describe("Seconds since the claim was taken"),
  idleSeconds: z
    .number()
    .describe("Seconds since the holder last did anything here — the staleness signal"),
};
type _ClaimShapeMatchesInterface = Expect<
  Equals<z.infer<z.ZodObject<typeof claimShape>>, ClaimActivity>
>;

const claimField = {
  claim: z
    .object(claimShape)
    .nullable()
    .describe("Liveness of the current claim; null when the issue is not held"),
};

/**
 * Estimate vs actual. A sibling of the issue for the same reason `claim` is one:
 * these are derived at read time and must not be frozen onto an entity a client
 * will hold for a session. See `IssueTiming` in core/types.ts.
 *
 * The actual is a sum of reconstructed `in_progress` intervals, not two
 * timestamps subtracted, so blocked and parked windows cost nothing and an open
 * interval stops at the holder's last activity rather than at `now`.
 */
const timingShape = {
  estimatedSeconds: z.number().nullable().describe("Plan-time estimate; null when none recorded"),
  ownActiveSeconds: z
    .number()
    .nullable()
    .describe(
      "Seconds this issue itself was in_progress, summed over intervals, EXCLUDING intervals opened by a derived child_started flip. Usually null for an epic",
    ),
  activeSeconds: z
    .number()
    .nullable()
    .describe(
      "THE ACTUAL to compare against the estimate: ownActiveSeconds for a leaf, childrenActiveSeconds for a parent (a parent has no stopwatch), null when cancelled",
    ),
  reviewSeconds: z
    .number()
    .nullable()
    .describe(
      "Seconds spent in in_review, summed over intervals and deliberately NOT part of activeSeconds; null when never reviewed",
    ),
  approximate: z
    .boolean()
    .describe(
      "True when the event log could not be replayed and these numbers fell back to completedAt/startedAt — treat them as an estimate of an estimate",
    ),
  countedThrough: z
    .string()
    .nullable()
    .describe(
      "Instant an open interval was counted through (the holder's last activity), never now; null when nothing is accumulating — including an epic flipped by a child",
    ),
  childCount: z.number().describe("Direct children only"),
  childrenEstimatedSeconds: z
    .number()
    .nullable()
    .describe("Sum over DIRECT children that have an estimate; null when none do"),
  childrenActiveSeconds: z
    .number()
    .nullable()
    .describe(
      "Sum over DIRECT children of each child's activeSeconds, so a child that is itself a parent contributes its own aggregate; null when none contributed",
    ),
  childStatusCounts: z
    .object(
      Object.fromEntries(ISSUE_STATUSES.map((status) => [status, z.number()])) as {
        [K in IssueStatus]: z.ZodNumber;
      },
    )
    .describe("Direct children per status; every status present, zeros included"),
};
type _TimingShapeMatchesInterface = Expect<
  Equals<z.infer<z.ZodObject<typeof timingShape>>, IssueTiming>
>;

/**
 * Attached to the DETAIL surface only, never to `list_tasks`/`inbox`.
 *
 * The trimmed summary shapes exist to keep choosing a task cheap; seven
 * per-status counts on every row of a 50-issue page is bulk nobody picking work
 * reads. `estimatedSeconds` still rides along on those surfaces, because it is a
 * scalar on the entity and genuinely answers "what is a 30m task I could take".
 */
const timingField = {
  timing: z.object(timingShape).describe("Estimate vs actual for this issue, derived at read time"),
  childrenTiming: z
    .record(z.string(), z.object(timingShape))
    .describe("Estimate vs actual per DIRECT child, keyed by child IDENTIFIER (e.g. STA-42)"),
};

const inboxEntryShape = {
  ...issueShape,
  unresolvedBlockers: z.array(z.string()),
  ...claimField,
};

/** Same drift protection as issueShape, for the comment surface. */
const commentShape = {
  id: z.string(),
  issueId: z.string(),
  author: z.string(),
  authorType: z.enum(COMMENT_AUTHOR_TYPES),
  body: z.string(),
  idempotencyKey: z.string().nullable(),
  deletedAt: z.string().nullable(),
  createdAt: z.string(),
};
type _CommentShapeMatchesInterface = Expect<
  Equals<z.infer<z.ZodObject<typeof commentShape>>, IssueComment>
>;

/** The trimmed row list_tasks returns — enough to choose a task, not the whole issue. */
const taskSummaryShape = {
  identifier: z.string(),
  title: z.string(),
  status: statusEnum,
  priority: priorityEnum,
  assignee: z.string().nullable(),
  parentId: z.string().nullable(),
  /**
   * The scalar, not the whole timing object: "what is a 30m task I could take"
   * is a picking question, while rollups and per-status counts are an analysis
   * question that belongs on get_task.
   */
  estimatedSeconds: z.number().nullable(),
  ...claimField,
};

const issueRefShape = { identifier: z.string(), title: z.string(), status: statusEnum };

const documentMetaShape = {
  issueId: z.string(),
  key: z.string(),
  currentRevision: z.number(),
  title: z.string().nullable(),
  updatedAt: z.string(),
  body: z.string().optional().describe("Current revision body; only with include_documents"),
};

/** Mirrors hub.CrossBlockerState: status null + unresolvable = file not on this machine. */
const crossBlockerShape = {
  identifier: z.string(),
  workspace: z.string(),
  status: z.string().nullable(),
  resolved: z.boolean(),
  unresolvable: z.boolean(),
};
type _CrossBlockerShapeMatchesInterface = Expect<
  Equals<z.infer<z.ZodObject<typeof crossBlockerShape>>, CrossBlockerState>
>;

/**
 * Idempotent writes say so. `replayed: true` means the key had been used before
 * and this is the ORIGINAL row — the retry was absorbed, nothing was written
 * twice. Always present (false on a fresh write) so a caller can branch on it
 * without distinguishing "absent" from "false".
 */
const replayedShape = {
  replayed: z
    .boolean()
    .describe("True when an idempotency key replayed an earlier write; false when this call wrote."),
};

server.registerTool(
  "inbox",
  {
    description:
      "Ready work in pickup order (in_progress -> in_review -> todo -> backlog), dependency-aware; blocked work listed separately with its unresolved blockers. Start every session here. Paginated: ready+blocked partition ONE page of open issues, so a page can be all-ready or all-blocked.",
    inputSchema: {
      assignee: z.string().optional().describe("Filter to one assignee (e.g. your agent name)"),
      limit: limitSchema(ISSUE_PAGE_LIMITS),
      cursor: cursorSchema,
      ws: wsSchema,
    },
    outputSchema: {
      ready: z.array(z.object(inboxEntryShape)),
      blocked: z.array(z.object(inboxEntryShape)),
      ...pageTailShape,
    },
    annotations: { title: "Inbox: ready work", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ assignee, limit, cursor, ws }) =>
    run(() => {
      const window = pageWindow({ t: "inbox", ws, assignee }, { limit, cursor }, ISSUE_PAGE_LIMITS);
      const store = storeFor(ws);
      const { ready, blocked, hasMore } = store.inbox(assignee, window);
      const claims = store.claimActivityFor([...ready, ...blocked].map((i) => i.id));
      const withClaim = <T extends { id: string }>(entry: T) => ({
        ...entry,
        claim: claims.get(entry.id) ?? null,
      });
      return {
        ready: ready.map(withClaim),
        blocked: blocked.map(withClaim),
        nextCursor: nextCursorFor(window, ready.length + blocked.length, hasMore),
        hasMore,
      };
    }),
);

server.registerTool(
  "list_tasks",
  {
    description:
      "List issues in this workspace with optional filters (open issues by default), newest-relevant first. Paginated: pass nextCursor back with the SAME filters to continue.",
    inputSchema: {
      status: z.array(statusEnum).optional(),
      assignee: z.string().optional(),
      q: z.string().optional().describe("Substring match on title/identifier/description"),
      include_resolved: z.boolean().optional(),
      limit: limitSchema(ISSUE_PAGE_LIMITS),
      cursor: cursorSchema,
      ws: wsSchema,
    },
    outputSchema: { items: z.array(z.object(taskSummaryShape)), ...pageTailShape },
    annotations: { title: "List tasks", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ status, assignee, q, include_resolved, limit, cursor, ws }) =>
    run(() => {
      const window = pageWindow(
        { t: "list_tasks", ws, status, assignee, q, include_resolved },
        { limit, cursor },
        ISSUE_PAGE_LIMITS,
      );
      const store = storeFor(ws);
      const { items, hasMore } = store.listIssuesPage(
        { status, assignee, q, includeResolved: include_resolved },
        window,
      );
      // One batched liveness query for the whole page, never one per row.
      const claims = store.claimActivityFor(items.map((i) => i.id));
      return {
        items: items.map((i) => ({
          identifier: i.identifier,
          title: i.title,
          status: i.status,
          priority: i.priority,
          assignee: i.assignee,
          parentId: i.parentId,
          estimatedSeconds: i.estimatedSeconds,
          claim: claims.get(i.id) ?? null,
        })),
        nextCursor: nextCursorFor(window, items.length, hasMore),
        hasMore,
      };
    }),
);

server.registerTool(
  "get_task",
  {
    description:
      "Full context for one issue: the issue, ancestors (the why), children, blockers/dependents, latest comments, document list, and cross-workspace blockers from the hub (same view the web UI shows). Pass include_documents to inline document bodies.",
    inputSchema: {
      ref: refSchema,
      include_documents: z
        .boolean()
        .optional()
        .describe("Inline the current body of every document (default false: metadata only)"),
      ws: wsSchema,
    },
    outputSchema: {
      issue: z.object(issueShape),
      ancestors: z.array(z.object(issueShape)),
      children: z.array(z.object(issueShape)),
      blockedBy: z.array(z.object(issueRefShape)),
      blocks: z.array(z.object(issueRefShape)),
      comments: z.array(z.object(commentShape)),
      documents: z.array(z.object(documentMetaShape)),
      crossBlockers: z
        .array(z.object(crossBlockerShape))
        .describe("Cross-workspace blockers via the hub; [] when the hub is unavailable"),
      ...claimField,
      ...timingField,
    },
    annotations: { title: "Get task context", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ ref, include_documents, ws }) =>
    run(() => {
      const store = storeFor(ws);
      const context = store.context(ref, { includeDocuments: include_documents });
      return {
        ...context,
        crossBlockers: crossBlockersSafe(context.issue.identifier),
        claim: store.claimActivity(context.issue.id),
        ...store.detailTiming(context.issue.id),
      };
    }),
);

server.registerTool(
  "create_task",
  {
    description:
      "Create an issue. Defaults: status todo when assigned, backlog otherwise; medium priority. Duplicate open titles are rejected unless allow_duplicate; pass idempotency_key for safe retries (same key replays the original). Use parent for subtasks and blocked_by for dependencies.",
    inputSchema: {
      title: z.string(),
      description: z.string().optional(),
      status: statusEnum.optional(),
      priority: priorityEnum.optional(),
      parent: refSchema.optional(),
      assignee: z.string().optional(),
      labels: z.array(z.string()).optional(),
      acceptance_criteria: z.array(z.string()).max(20).optional(),
      blocked_by: z.array(refSchema).optional(),
      block_parent_until_done: z.boolean().optional(),
      estimate_seconds: estimateSchema,
      idempotency_key: z.string().optional(),
      allow_duplicate: z.boolean().optional(),
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: { ...issueShape, ...replayedShape },
    annotations: {
      title: "Create task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  (input) =>
    run(() => {
      const { issue, replayed } = storeFor(input.ws).createIssueResult({
        title: input.title,
        description: input.description,
        status: input.status,
        priority: input.priority,
        parent: input.parent,
        assignee: input.assignee,
        labels: input.labels,
        acceptanceCriteria: input.acceptance_criteria,
        blockedBy: input.blocked_by,
        blockParentUntilDone: input.block_parent_until_done,
        estimatedSeconds: input.estimate_seconds,
        idempotencyKey: input.idempotency_key,
        allowDuplicate: input.allow_duplicate,
        createdBy: requireActor(input.actor),
      });
      return { ...issue, replayed };
    }),
);

server.registerTool(
  "update_task",
  {
    description:
      "Patch an issue. Guards: in_progress needs an assignee and zero unresolved blockers; unblock_owner/unblock_action only with status blocked; pass expected_status_version for optimistic concurrency. Optional comment lands in the same transaction.",
    inputSchema: {
      ref: refSchema,
      title: z.string().optional(),
      description: z.string().optional(),
      status: statusEnum.optional(),
      priority: priorityEnum.optional(),
      assignee: z.string().nullable().optional(),
      labels: z.array(z.string()).optional(),
      unblock_owner: z.string().nullable().optional(),
      unblock_action: z.string().nullable().optional(),
      estimate_seconds: estimateSchema,
      expected_status_version: z.number().int().optional(),
      comment: z.string().optional(),
      actor: actorSchema,
      ws: wsSchema,
    },
    annotations: {
      title: "Update task",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  (input) =>
    run(() => {
      const actor = requireActor(input.actor);
      const store = storeFor(input.ws);
      const updated = store.updateIssue(
        input.ref,
        {
          title: input.title,
          description: input.description,
          status: input.status,
          priority: input.priority,
          assignee: input.assignee,
          labels: input.labels,
          unblockOwner: input.unblock_owner,
          unblockAction: input.unblock_action,
          estimatedSeconds: input.estimate_seconds,
          expectedStatusVersion: input.expected_status_version,
          comment: input.comment,
        },
        actor,
      );
      notifyHubIfResolved(store, input.ref, input.status);
      return updated;
    }),
);

server.registerTool(
  "checkout_task",
  {
    description:
      "Atomically claim an issue (forces in_progress). On conflict, pick a DIFFERENT task — never retry the same one. Re-claiming an issue you already hold is idempotent (crash recovery). Refused while blockers are unresolved. Use steal_if_idle_seconds ONLY when a human has told you to take over a task whose holder is dead.",
    inputSchema: {
      ref: refSchema,
      actor: actorSchema,
      agent: z.string().optional().describe("Legacy alias for actor (actor wins when both are sent)"),
      expected_statuses: z.array(statusEnum).optional(),
      steal_if_idle_seconds: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "Explicit takeover: also claim an issue held by ANOTHER agent when that holder's last activity (get_task/inbox `claim.idleSeconds`) is at least this old. Nothing expires claims on its own — this is the only path, and it exists for resuming work after an agent died mid-task. Refused if the holder is fresher than this, naming them and their last activity.",
        ),
      ws: wsSchema,
    },
    outputSchema: issueShape,
    /**
     * destructiveHint: TRUE since steal_if_idle_seconds exists. MCP defines the
     * hint as "may perform destructive updates" vs "only additive updates", and
     * revoking another agent's live claim is not additive. Annotations are static
     * per tool, so this one must describe the tool's worst case — a takeover.
     * Clients that gate destructive tools behind confirmation will now confirm a
     * steal, which is exactly the intended posture for a human-initiated action.
     *
     * idempotentHint stays TRUE and is still honest: repeating the identical
     * steal call finds you already holding the issue and returns via the
     * crash-recovery re-claim branch — no second event, no additional effect.
     * Destructive-but-idempotent is an ordinary combination.
     */
    annotations: {
      title: "Claim task",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ({ ref, actor, agent, expected_statuses, steal_if_idle_seconds, ws }) =>
    run(() =>
      storeFor(ws).checkoutIssue(
        ref,
        requireActor(actor, agent),
        expected_statuses as IssueStatus[] | undefined,
        { stealIfIdleSeconds: steal_if_idle_seconds },
      ),
    ),
);

server.registerTool(
  "release_task",
  {
    description:
      "Release a held issue back to todo (keeps the assignee, clears the claim). Pass if_idle_seconds to free a claim held by ANOTHER agent that has gone silent for at least that long — the explicit counterpart to checkout_task's steal.",
    inputSchema: {
      ref: refSchema,
      actor: actorSchema,
      agent: z.string().optional().describe("Legacy alias for actor (actor wins when both are sent)"),
      if_idle_seconds: z
        .number()
        .nonnegative()
        .optional()
        .describe(
          "Release only if the CURRENT holder's last activity is at least this old. Replaces the ownership check, so a caller can free a dead agent's claim without impersonating it. Refused if the holder is fresher than this, naming them and their last activity.",
        ),
      ws: wsSchema,
    },
    // destructiveHint: TRUE for the same reason as checkout_task — with
    // if_idle_seconds this tool can revoke a claim that is not the caller's.
    annotations: {
      title: "Release task",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  ({ ref, actor, agent, if_idle_seconds, ws }) =>
    run(() =>
      storeFor(ws).releaseIssue(ref, requireActor(actor, agent), {
        ifIdleSeconds: if_idle_seconds,
      }),
    ),
);

server.registerTool(
  "add_comment",
  {
    description:
      "Comment on an issue (author_type: agent|user|system). Pass idempotency_key for safe retries — the same key on the same issue replays the original comment instead of double-posting, and the reply says replayed: true.",
    inputSchema: {
      ref: refSchema,
      body: z.string(),
      actor: actorSchema,
      author: z.string().optional().describe("Legacy alias for actor (actor wins when both are sent)"),
      author_type: z.enum(["user", "agent", "system"]).optional(),
      idempotency_key: z
        .string()
        .optional()
        .describe("Retry token, unique per issue: a repeat returns the original comment"),
      ws: wsSchema,
    },
    outputSchema: { ...commentShape, ...replayedShape },
    annotations: {
      title: "Add comment",
      readOnlyHint: false,
      destructiveHint: false,
      // Not idempotent in general — only when the caller supplies idempotency_key.
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  ({ ref, body, actor, author, author_type, idempotency_key, ws }) =>
    run(() => {
      const { comment, replayed } = storeFor(ws).addCommentResult(
        ref,
        body,
        requireActor(actor, author),
        author_type ?? "agent",
        { idempotencyKey: idempotency_key },
      );
      return { ...comment, replayed };
    }),
);

server.registerTool(
  "list_comments",
  {
    description: "List comments on an issue, oldest first. Paginated: pass nextCursor back to continue.",
    inputSchema: {
      ref: refSchema,
      limit: limitSchema(COMMENT_PAGE_LIMITS),
      cursor: cursorSchema,
      ws: wsSchema,
    },
    outputSchema: { items: z.array(z.object(commentShape)), ...pageTailShape },
    annotations: { title: "List comments", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ ref, limit, cursor, ws }) =>
    run(() => {
      const window = pageWindow({ t: "list_comments", ws, ref }, { limit, cursor }, COMMENT_PAGE_LIMITS);
      const { items, hasMore } = storeFor(ws).listCommentsPage(ref, window);
      return { items, nextCursor: nextCursorFor(window, items.length, hasMore), hasMore };
    }),
);

server.registerTool(
  "set_blocked_by",
  {
    description:
      "Replace the FULL blocked-by set of an issue (empty array clears). Rejects cycles and self-blocking. Emits a blockers_resolved event when the new set is already fully resolved.",
    inputSchema: { ref: refSchema, blockers: z.array(refSchema), actor: actorSchema, ws: wsSchema },
    // Destructive: replaces the FULL set, so it can drop edges the caller never named.
    annotations: {
      title: "Replace blockers",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ({ ref, blockers, actor, ws }) =>
    run(() => storeFor(ws).setBlockedBy(ref, blockers, requireActor(actor))),
);

server.registerTool(
  "put_document",
  {
    description:
      "Create or update a keyed, revisioned document on an issue (e.g. key 'plan', 'notes'). Pass base_revision for optimistic concurrency — a stale base returns revision_conflict with the current revision; re-read and merge, don't overwrite. This replaces loose plan.md files.",
    inputSchema: {
      ref: refSchema,
      key: z.string(),
      body: z.string(),
      base_revision: z.number().int().optional(),
      change_summary: z.string().optional(),
      title: z.string().optional(),
      actor: actorSchema,
      ws: wsSchema,
    },
    // Revisions are append-only, so nothing is destroyed, but each call mints a new one.
    annotations: {
      title: "Write document",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  ({ ref, key, body, base_revision, change_summary, title, actor, ws }) =>
    run(() =>
      storeFor(ws).putDocument(ref, key, body, {
        baseRevision: base_revision,
        changeSummary: change_summary,
        title,
        author: requireActor(actor),
      }),
    ),
);

server.registerTool(
  "get_document",
  {
    description: "Read an issue document (latest revision unless one is specified).",
    inputSchema: { ref: refSchema, key: z.string(), revision: z.number().int().optional(), ws: wsSchema },
    annotations: { title: "Read document", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ ref, key, revision, ws }) => run(() => storeFor(ws).getDocument(ref, key, revision)),
);

server.registerTool(
  "events_since",
  {
    description:
      "Workspace event log after a cursor (seq). Poll at session start to learn what changed: blockers_resolved and children_complete events tell you which of your issues became workable.",
    inputSchema: {
      since: z.number().int().optional().describe("Last seq you have seen (default 0)"),
      limit: z.number().int().positive().max(500).optional(),
      ws: wsSchema,
    },
    annotations: { title: "Events since cursor", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ since, limit, ws }) => run(() => storeFor(ws).listEvents(since ?? 0, limit ?? 200)),
);

server.registerTool(
  "cross_link",
  {
    description:
      "Cross-workspace dependency via the hub: blocker_identifier blocks blocked_identifier (identifiers like GAR-12 resolve through workspace prefixes). Use for work that depends on another repo.",
    // No `ws`: this is hub-wide by construction — both sides are named by their
    // prefixed identifier and nothing here opens a workspace store. It therefore
    // also works from a directory that has no workspace at all.
    inputSchema: {
      blocker_identifier: z.string(),
      blocked_identifier: z.string(),
    },
    // INSERT OR IGNORE against a UNIQUE constraint, so re-linking is a no-op.
    annotations: {
      title: "Cross-workspace link",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ({ blocker_identifier, blocked_identifier }) =>
    run(() => {
      const hub = Hub.open();
      try {
        return hub.addCrossLink(blocker_identifier, blocked_identifier);
      } finally {
        hub.close();
      }
    }),
);

server.registerTool(
  "hub_overview",
  {
    description:
      "Holistic view across all registered workspaces: workspaces (with availability), cross-workspace links, this issue's cross blockers if ref given, and recent hub events (cross_blockers_resolved). Also the way to discover slugs/prefixes to pass as ws elsewhere.",
    // No `ws`: reporting on every registered workspace IS the point — scoping it
    // to one would defeat the tool. Reads the hub only, so no workspace needed.
    inputSchema: {
      ref: z.string().optional().describe("Optional identifier to report cross-blocker readiness for"),
      events_limit: limitSchema(HUB_EVENT_PAGE_LIMITS),
      events_cursor: cursorSchema,
    },
    annotations: { title: "Hub overview", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ ref, events_limit, events_cursor }) =>
    run(() => {
      // The hub event log has a monotonic seq, so its cursor seeks rather than
      // skips. This is a snapshot view: for continuous polling use events_since.
      const limit = clampLimit(events_limit, HUB_EVENT_PAGE_LIMITS);
      const since = events_cursor ? decodeSeqCursor(events_cursor) : 0;
      const hub = Hub.open();
      try {
        const rows = hub.listHubEvents(since, limit + 1);
        const items = rows.slice(0, limit);
        const hasMore = rows.length > limit;
        return {
          workspaces: hub.list(),
          crossLinks: hub.listCrossLinks(),
          crossBlockers: ref ? hub.crossBlockersOf(ref) : undefined,
          hubEvents: {
            items,
            nextCursor: hasMore ? encodeSeqCursor(items[items.length - 1]!.seq) : null,
            hasMore,
          },
        };
      } finally {
        hub.close();
      }
    }),
);

server.registerTool(
  "init",
  {
    description:
      "Create a staple workspace so the other tools have somewhere to write. Call this when a tool reports not_found for the workspace. Defaults to a repo workspace at <dir>/.staple/staple.db; a repository that still uses the legacy <dir>/.tasks/tasks.db layout is adopted as-is rather than forked (run `staple migrate` to move it). Pass global with a slug for a shared workspace under STAPLE_HOME instead. Returns the slug and identifier prefix — pass either as ws on later calls to target this workspace. A repo workspace also gets AGENTS.md beside the database, the working protocol for agents on this repo (worklog checkpoints, branch pointers, claim continuity): read it via guidePath before you start working. An existing guide is never overwritten.",
    inputSchema: {
      dir: z
        .string()
        .optional()
        .describe("Repo directory to initialize; defaults to the server's working directory"),
      global: z
        .boolean()
        .optional()
        .describe("Create a shared workspace under STAPLE_HOME instead of a repo .tasks dir (requires slug)"),
      slug: z
        .string()
        .optional()
        .describe("Workspace slug; defaults to the directory name, required when global"),
    },
    outputSchema: {
      slug: z.string(),
      prefix: z.string(),
      dbPath: z.string(),
      created: z.boolean().describe("false when the workspace already existed and was only re-registered"),
      guidePath: z
        .string()
        .nullable()
        .describe("Path to the AGENTS.md working protocol for this repo; null for global workspaces"),
      guideWritten: z
        .boolean()
        .describe("false when a guide was already there and was kept unchanged"),
    },
    // initWorkspace is documented idempotent: re-running an existing workspace
    // refreshes its hub registration and keeps the already-minted prefix.
    annotations: {
      title: "Initialize workspace",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ({ dir, global: isGlobal, slug }) =>
    run(() => {
      const opened = initWorkspace({ dir, global: isGlobal, slug });
      const summary = {
        slug: opened.store.slug,
        prefix: opened.store.prefix,
        dbPath: opened.dbPath,
        created: opened.created,
        guidePath: opened.guidePath,
        guideWritten: opened.guideWritten,
      };
      // Hand back a serializable summary, drop the handle init just opened, and
      // reset the caches so the next call re-resolves and can see this workspace.
      opened.store.db.close();
      resetWorkspaceCache();
      return summary;
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
const workspaceSource = process.env.STAPLE_DB
  ? `STAPLE_DB ${process.env.STAPLE_DB}`
  : process.env.STAPLE_WS
    ? `STAPLE_WS ${process.env.STAPLE_WS}`
    : `walking up from ${process.cwd()}`;
// Identity, like the workspace, is resolved per call — this only reports the default.
const agentSource = process.env.STAPLE_AGENT?.trim()
  ? `default agent "${process.env.STAPLE_AGENT.trim()}"`
  : "no STAPLE_AGENT — every write must pass actor";
console.error(
  `staple mcp ready — ${agentSource}, workspace resolved per call (${workspaceSource}); pass ws to target another, or call init if there is none`,
);
