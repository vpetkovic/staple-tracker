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
import type { VocabularyOp, WorkspaceStore } from "./core/store.js";
import { MILESTONE_STATES } from "./core/milestones.js";
import { KIND_APPEARANCE_SOURCES, type KindWithAppearance } from "./core/kind-appearance.js";
import { Hub, notifyHubResolvedSafe } from "./core/hub.js";
import type { CrossBlockerState } from "./core/hub.js";
import {
  COMMENT_AUTHOR_TYPES,
  COMMENT_PAGE_LIMITS,
  GATE_STATES,
  HUB_EVENT_PAGE_LIMITS,
  ISSUE_PAGE_LIMITS,
  ISSUE_KINDS,
  ISSUE_PRIORITIES,
  ISSUE_STATUSES,
  STATUS_CATEGORIES,
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
  IssueGate,
  IssueStatus,
  IssueTiming,
  PageLimits,
  QueuedBy,
  WorkspaceKind,
  WorkspaceStatus,
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
  // Category, not the two literals (STA-140): a workspace that renamed `done` to
  // `shipped` must still wake its cross-workspace dependents.
  if (!status || !store.isResolvedStatus(status)) return;
  try {
    notifyHubResolvedSafe(store.slug, store.getIssue(ref).identifier);
  } catch {
    // hub is optional at runtime
  }
}

/**
 * A status id — `z.string()`, not `z.enum`, since STA-140.
 *
 * The vocabulary is per-workspace data now, and a single MCP server answers for
 * several workspaces, so there is no one enum it could be. On INPUT the store
 * validates against the calling workspace's own list and refuses with a sentence
 * that names the valid ids (`list_statuses` returns the same list). On OUTPUT the
 * widening is not a nicety but a correctness fix: zod strips what an enum does
 * not recognise, so a custom status would have vanished off the wire silently.
 *
 * The built-ins are named in the description so a client with no `list_statuses`
 * call behind it still has somewhere to start.
 */
const statusEnum = z
  .string()
  .describe(
    `Status id, configurable per workspace. Built-in: ${ISSUE_STATUSES.join(", ")}. ` +
      "Call list_statuses for this workspace's actual set.",
  );
/**
 * Kind id — `z.string()` for exactly the reason `statusEnum` above is one, and
 * it is a correctness fix rather than a nicety: a `z.enum` STRIPS what it does
 * not recognise, so an operator who ran `staple kinds add milestone` would watch
 * that kind vanish off the wire in silence on every read. The built-in seed is
 * named in the description so a client with no `list_kinds` call behind it still
 * has somewhere to start.
 */
const kindSchema = z
  .string()
  .describe(
    `Kind id, configurable per workspace. Built-in: ${ISSUE_KINDS.join(", ")}. ` +
      "Call list_kinds for this workspace's actual set.",
  );
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
  kind: kindSchema,
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
      "Seconds this issue itself was in_progress, summed over intervals, EXCLUDING intervals opened by any derived flip (a parent status derived from its children). Usually null for an epic",
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
  /**
   * A RECORD, not a fixed seven-key object, since STA-140: the key set is the
   * workspace's configured vocabulary. For a default workspace the emitted keys
   * and their order are byte-identical to what the fixed object produced — only
   * the schema widened, so no existing consumer sees a different payload.
   */
  childStatusCounts: z
    .record(z.string(), z.number())
    .describe(
      "Direct children per status; every CONFIGURED status present, zeros included (see list_statuses)",
    ),
  /**
   * STA-192: the recursive plan, BESIDE the depth-1 childrenEstimatedSeconds
   * rather than instead of it. See `SubtreePlan` in core/types.ts for the one
   * contribution rule that keeps it from counting anything twice.
   */
  subtreePlan: z
    .object({
      estimatedSeconds: z
        .number()
        .nullable()
        .describe(
          "THE EFFECTIVE PLAN an ancestor counts this issue as: the own estimate when recorded, otherwise descendantsEstimatedSeconds; null when neither exists",
        ),
      source: z
        .enum(["own", "descendants", "none"])
        .describe("Which of the two fed estimatedSeconds; none when it is null"),
      descendantsEstimatedSeconds: z
        .number()
        .nullable()
        .describe(
          "BOTTOM-UP: sum of the DIRECT children's effective plans, the recursive counterpart of childrenEstimatedSeconds; null when no descendant at any depth has an estimate. Present even when an own estimate wins, so the two can be compared",
        ),
      contributingCount: z
        .number()
        .describe(
          "Descendants at any depth whose own estimate is a term of descendantsEstimatedSeconds; a descendant shadowed by an estimated ancestor beneath this issue is not counted",
        ),
      totalCount: z.number().describe("Descendants at any depth, whatever their status; 0 for a leaf"),
    })
    .describe(
      "Recursive, non-double-counting plan for the subtree: an issue contributes its own estimate if it has one, otherwise its children's contributions — never both",
    ),
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

/**
 * The review gate ON this issue (STA-143). A sibling of the issue for the same
 * reason `claim` is one — see `IssueGate` in core/types.ts.
 *
 * Present on every issue-bearing surface, resolved or not: "VP approved this an
 * hour ago" is exactly what a caller re-reading a ticket needs, and a gate that
 * disappeared the moment it was answered would leave no trace of the review.
 */
const gateShape = {
  state: z.enum(GATE_STATES).describe("pending = parked and queueing; approved / changes_requested = resolved"),
  owner: z.string().describe("The human who must act (or did)"),
  requestedBy: z.string().nullable(),
  requestedAt: z.string(),
  resolvedBy: z.string().nullable(),
  resolvedAt: z.string().nullable(),
};
type _GateShapeMatchesInterface = Expect<Equals<z.infer<z.ZodObject<typeof gateShape>>, IssueGate>>;

/** The gate this issue is QUEUED BEHIND — derived by walking ancestors, never stored. */
const queuedByShape = {
  identifier: z.string().describe("The nearest ancestor holding an unresolved gate"),
  owner: z.string().describe("Who must approve before this becomes pickable"),
};
type _QueuedByShapeMatchesInterface = Expect<
  Equals<z.infer<z.ZodObject<typeof queuedByShape>>, QueuedBy>
>;

/**
 * The pair, together, on every surface that carries either.
 *
 * They are complementary and a caller needs both to act: `gate` says "this row
 * is holding a queue", `queuedBy` says "this row is standing in one". At most
 * one is ever non-null for a given row, but which one it is changes the advice
 * completely — chase the owner, or wait for the row above you.
 */
const gateFields = {
  gate: z
    .object(gateShape)
    .nullable()
    .describe("The review gate on THIS issue; null when none was ever requested"),
  queuedBy: z
    .object(queuedByShape)
    .nullable()
    .describe(
      "The gate this issue is queued behind. NON-NULL means checkout_task will be refused with code `gated` — a human has to approve; retrying and waiting are equally useless.",
    ),
};

const inboxEntryShape = {
  ...issueShape,
  unresolvedBlockers: z.array(z.string()),
  ...claimField,
  ...gateFields,
  /**
   * The pickup queue's two numbers (STA-168). `position` is where the shared
   * resolver put this row in EFFECTIVE order — the number `next_task` and an
   * `out_of_order` refusal speak — and is null for a container, which is never a
   * pickup target. `planPosition` is where a human put it in the plan, or the
   * queued container it came from; null for unqueued work.
   */
  position: z.number().nullable(),
  planPosition: z.number().nullable(),
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
  kind: kindSchema,
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
  // On the picking surface for the same reason `claim` is: "can I take this"
  // is the question list_tasks exists to answer, and a queued row is one an
  // agent must not even try.
  ...gateFields,
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
      "Ready work in pickup order (in_progress -> in_review -> todo -> backlog), dependency-aware. Three buckets: `ready` (take one of these), `queued` (a HUMAN must approve a gate above it — checkout_task is refused with code `gated`, and retrying or waiting will not help), and `blocked` (waiting on other WORK, with its unresolved blockers). Start every session here. Paginated: the three buckets partition ONE page of open issues, so a page can be entirely one of them.",
    inputSchema: {
      assignee: z.string().optional().describe("Filter to one assignee (e.g. your agent name)"),
      limit: limitSchema(ISSUE_PAGE_LIMITS),
      cursor: cursorSchema,
      ws: wsSchema,
    },
    outputSchema: {
      ready: z.array(z.object(inboxEntryShape)),
      queued: z
        .array(z.object(inboxEntryShape))
        .describe(
          "Gate-held work: entries with `queuedBy` are waiting on the gate it names; an entry with a pending `gate` and no `queuedBy` IS the gate. Never ready.",
        ),
      blocked: z.array(z.object(inboxEntryShape)),
      ...pageTailShape,
    },
    annotations: { title: "Inbox: ready work", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ assignee, limit, cursor, ws }) =>
    run(() => {
      const window = pageWindow({ t: "inbox", ws, assignee }, { limit, cursor }, ISSUE_PAGE_LIMITS);
      const store = storeFor(ws);
      const { ready, queued, blocked, hasMore } = store.inbox(assignee, window);
      const claims = store.claimActivityFor([...ready, ...queued, ...blocked].map((i) => i.id));
      // `gate`/`queuedBy` already ride on the entries — store.inbox() computes
      // them as part of the bucketing decision, so there is nothing to re-derive
      // here and no way for the bucket and the field to disagree.
      const withClaim = <T extends { id: string }>(entry: T) => ({
        ...entry,
        claim: claims.get(entry.id) ?? null,
      });
      return {
        ready: ready.map(withClaim),
        queued: queued.map(withClaim),
        blocked: blocked.map(withClaim),
        nextCursor: nextCursorFor(
          window,
          ready.length + queued.length + blocked.length,
          hasMore,
        ),
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
      kind: z.array(kindSchema).optional().describe("Restrict to these kinds, e.g. [\"epic\"]"),
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
  ({ status, kind, assignee, q, include_resolved, limit, cursor, ws }) =>
    run(() => {
      const window = pageWindow(
        { t: "list_tasks", ws, status, kind, assignee, q, include_resolved },
        { limit, cursor },
        ISSUE_PAGE_LIMITS,
      );
      const store = storeFor(ws);
      const { items, hasMore } = store.listIssuesPage(
        { status, kind, assignee, q, includeResolved: include_resolved },
        window,
      );
      // One batched query per fact for the whole page, never one per row.
      const ids = items.map((i) => i.id);
      const claims = store.claimActivityFor(ids);
      const gates = store.gateFor(ids);
      const queued = store.queuedByFor(ids);
      return {
        items: items.map((i) => ({
          identifier: i.identifier,
          title: i.title,
          status: i.status,
          kind: i.kind,
          priority: i.priority,
          assignee: i.assignee,
          parentId: i.parentId,
          estimatedSeconds: i.estimatedSeconds,
          claim: claims.get(i.id) ?? null,
          gate: gates.get(i.id) ?? null,
          queuedBy: queued.get(i.id) ?? null,
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
      ...gateFields,
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
        /*
         * NO `kindAppearance` HERE, unlike `staple show --json` (R5e, STA-185).
         *
         * Not an oversight and not a disagreement about what an agent needs: this
         * payload is held byte-equal to /api/agent-context by the test below, and the
         * pane's whole claim is that it shows exactly what an agent receives. A field
         * added here alone would break that claim, and the appearance an agent would
         * use it for is already one `list_kinds` call away — a record about the KIND,
         * fetched once, not repeated on every issue payload.
         */
        // Expression-for-expression identical to the /api/agent-context handler
        // in src/ui/server.ts — test/ui-agent-context.test.ts asserts deep
        // equality between the two, so these two lines must be added in both
        // places or in neither.
        gate: store.gate(context.issue.id),
        queuedBy: store.queuedBy(context.issue.id),
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
      kind: kindSchema.optional().describe("Declared kind; defaults to task."),
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
        kind: input.kind,
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
      kind: kindSchema.optional().describe("Re-declare the kind. Omit to leave unchanged."),
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
          kind: input.kind,
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
      "Atomically claim an issue (forces in_progress). On conflict, pick a DIFFERENT task — never retry the same one. Re-claiming an issue you already hold is idempotent (crash recovery). Refused while blockers are unresolved. Under queue.policy = strict, claiming a row that is LATER in the pickup queue than an eligible one is refused with `out_of_order` and `detail.expected` names what to take instead — retrying never clears that, taking the named issue does. Use steal_if_idle_seconds ONLY when a human has told you to take over a task whose holder is dead.",
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
      override_reason: z
        .string()
        .optional()
        .describe(
          "HUMAN OVERRIDE — do not send this on your own initiative. Takes a row out of turn under queue.policy = strict, recording who did it and why in a `queue_overridden` event. The reason is mandatory (an empty one is refused), it skips ONLY the out_of_order check, and it never bypasses a blocker, a gate or a live claim. If you hit out_of_order, take `detail.expected[0]` instead and let a human decide to override.",
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
  ({ ref, actor, agent, expected_statuses, steal_if_idle_seconds, override_reason, ws }) =>
    run(() =>
      storeFor(ws).checkoutIssue(
        ref,
        requireActor(actor, agent),
        expected_statuses as IssueStatus[] | undefined,
        { stealIfIdleSeconds: steal_if_idle_seconds, overrideReason: override_reason },
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

/**
 * The three gate verbs (STA-143).
 *
 * All three return the PARENT issue plus its gate, rather than a bespoke result
 * object, so a caller can treat them exactly like `update_task` — one issue in
 * hand afterwards, no new shape to learn.
 */
server.registerTool(
  "gate_task",
  {
    description:
      "Park a PARENT behind a human review gate. It moves to awaiting_approval, its claim is cleared (nobody is working it), and every open descendant becomes QUEUED: they leave the inbox `ready` bucket and checkout_task on them is refused with code `gated`. Only OPEN work is queued — done and cancelled issues are never queued, and neither is a parent that has nothing open left underneath it, because there is nothing there to release. Refused on an issue with no children (use status in_review for a leaf awaiting a human) and while a gate is already pending. Re-gating after request_changes is how you resubmit for a second read.",
    inputSchema: {
      ref: refSchema,
      owner: z
        .string()
        .describe("The human who must approve. Required — a gate with nobody to chase is a dead end."),
      comment: z.string().optional().describe("Optional note stored as a comment on the issue"),
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: { ...issueShape, gate: z.object(gateShape).nullable() },
    /**
     * destructiveHint: TRUE. Gating clears the parent's claim and takes an
     * entire subtree out of circulation — the opposite of an additive update,
     * and exactly the kind of thing a client should be able to confirm first.
     * idempotentHint: FALSE, because the second call is refused rather than
     * absorbed: a pending gate belongs to the reviewer reading it.
     */
    annotations: {
      title: "Gate task for approval",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  ({ ref, owner, comment, actor, ws }) =>
    run(() => {
      const store = storeFor(ws);
      const issue = store.gateIssue(ref, { owner, comment }, requireActor(actor));
      return { ...issue, gate: store.gate(issue.id) };
    }),
);

server.registerTool(
  "approve_task",
  {
    description:
      "Approve a gate. With no `children`: the gate is resolved, the whole subtree is released, and the parent's status is re-derived from its children. With `children`: only those refs (and everything underneath them) are released, and the parent STAYS parked with the gate still pending — granular approval, for letting one thread proceed without ending the review. Refused when there is no unresolved gate; a `changes_requested` gate can be approved, which is one of the two ways that queue ends.",
    inputSchema: {
      ref: refSchema,
      children: z
        .array(refSchema)
        .optional()
        .describe(
          "Release ONLY these (must be descendants of ref) and leave the parent parked. Omit to approve the whole gate.",
        ),
      comment: z.string().optional().describe("Optional note stored as a comment on the issue"),
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: { ...issueShape, gate: z.object(gateShape).nullable() },
    /**
     * destructiveHint: FALSE — approving only ever widens what may be worked on,
     * which is as additive as this server gets. idempotentHint: FALSE, since a
     * second whole-gate approve is refused rather than absorbed.
     */
    annotations: {
      title: "Approve gate",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  ({ ref, children, comment, actor, ws }) =>
    run(() => {
      const store = storeFor(ws);
      const issue = store.approveGate(ref, { children, comment }, requireActor(actor));
      return { ...issue, gate: store.gate(issue.id) };
    }),
);

server.registerTool(
  "request_changes",
  {
    description:
      "Send a gated parent back. Posts your note as a comment on `ref`, returns it to todo for the next agent, and keeps the queued children parked until you approve. Pickable by anyone afterwards, with no automatic re-checkout: 'changes requested' is not 'released', so the queue holds until an approve_task or a fresh gate_task cycle. The note is required. (Surfaced to humans as 'Send back'; the tool name is unchanged.)",
    inputSchema: {
      ref: refSchema,
      comment: z
        .string()
        .describe(
          "Your note to the next agent. Stored as a real comment on the issue. Required — approve instead if there is nothing to say.",
        ),
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: { ...issueShape, gate: z.object(gateShape).nullable() },
    // destructiveHint: TRUE — it revokes the parent's claim and keeps a subtree
    // out of circulation.
    annotations: {
      title: "Send back with note",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  ({ ref, comment, actor, ws }) =>
    run(() => {
      const store = storeFor(ws);
      const issue = store.requestChanges(ref, { comment }, requireActor(actor));
      return { ...issue, gate: store.gate(issue.id) };
    }),
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

/**
 * ---------------------------------------------------------------- vocabulary
 *
 * The workspace's statuses and kinds are DATA (STA-140), so an agent has to be
 * able to read them before it sets one, and a human's agent has to be able to
 * change them without a shell. Four tools: two reads, two ordered write batches.
 */
const statusRowShape = {
  id: z.string(),
  label: z.string(),
  category: z.enum(STATUS_CATEGORIES).describe("Fixed behaviour class; NOT configurable"),
  sortOrder: z.number(),
  isBuiltin: z.boolean().describe("True for a row staple seeded. Informational — built-ins are editable."),
};
type _StatusRowMatchesInterface = Expect<
  Equals<z.infer<z.ZodObject<typeof statusRowShape>>, WorkspaceStatus>
>;

const kindRowShape = {
  id: z.string(),
  label: z.string(),
  sortOrder: z.number(),
  isBuiltin: z.boolean(),
};
type _KindRowMatchesInterface = Expect<
  Equals<z.infer<z.ZodObject<typeof kindRowShape>>, WorkspaceKind>
>;

/**
 * A kind's resolved appearance (R5a, STA-181), the same record `staple kinds
 * ls --json` and `/api/settings` serve. No colour field, on purpose: hue is a
 * status-category property and a kind glyph is monochrome.
 */
const kindAppearanceShape = z.object({
  source: z
    .enum(KIND_APPEARANCE_SOURCES)
    .describe('Where the web icon comes from; "none" means the built-in mark'),
  value: z.string().describe('A canonical Lucide key, an emoji, or "" for none'),
  label: z.string().describe("Accessible name — the kind label unless the operator set one"),
  fallback: z.string().describe("What a terminal prints instead of the icon"),
});
const kindWithAppearanceShape = { ...kindRowShape, appearance: kindAppearanceShape };
type _KindWithAppearanceMatchesInterface = Expect<
  Equals<z.infer<z.ZodObject<typeof kindWithAppearanceShape>>, KindWithAppearance>
>;

/**
 * One registered workspace setting with its provenance (R6d, STA-179) — the
 * registry's `SettingValueView`, which `/api/settings` serves under `values`
 * and `staple settings get` prints, so every surface answers the same object.
 */
const settingValueShape = {
  key: z.string(),
  scope: z.enum(["workspace", "global"]),
  value: z.unknown().optional().describe("Absent when redacted"),
  source: z.enum(["default", "workspace", "config"]).describe("Where the effective value came from"),
  version: z.number(),
  redacted: z.literal(true).optional(),
};

/**
 * One op. A BATCH rather than a tool per verb because "add awaiting_approval and
 * put it after in_review" is a single intention, and splitting it over two calls
 * leaves a window where every board in the workspace is visibly wrong. Applied
 * in order, in one transaction: all of it lands or none of it does.
 */
const vocabularyOpSchema = z
  .object({
    op: z.enum(["add", "rename", "recategorize", "reorder", "remove"]),
    id: z.string().optional().describe("Target id; required for every op except reorder"),
    label: z.string().optional().describe("Display label. Required for rename; derived from the id on add."),
    category: z
      .enum(STATUS_CATEGORIES)
      .optional()
      .describe("Statuses only. Required for add; the behaviour the status inherits."),
    after: z
      .string()
      .nullable()
      .optional()
      .describe("add only: place directly after this id. Omit or null to append."),
    ids: z.array(z.string()).optional().describe("reorder only: EVERY id, in the order you want."),
    migrateTo: z
      .string()
      .nullable()
      .optional()
      .describe("remove only: move every issue that still carries this id onto that one. Required when any do."),
  })
  .describe("One vocabulary edit; ops apply in order, in a single transaction");

/** zod's optional-everything shape, narrowed to what the store's union demands. */
function toVocabularyOp(raw: z.infer<typeof vocabularyOpSchema>): VocabularyOp {
  const need = (value: string | undefined, field: string): string => {
    if (value === undefined || value.trim() === "") {
      throw new StapleError("validation", `"${raw.op}" needs "${field}"`);
    }
    return value;
  };
  switch (raw.op) {
    case "add":
      return { op: "add", id: need(raw.id, "id"), label: raw.label, category: raw.category, after: raw.after };
    case "rename":
      return { op: "rename", id: need(raw.id, "id"), label: need(raw.label, "label") };
    case "recategorize":
      return { op: "recategorize", id: need(raw.id, "id"), category: need(raw.category, "category") };
    case "reorder":
      if (!raw.ids) throw new StapleError("validation", '"reorder" needs "ids"');
      return { op: "reorder", ids: raw.ids };
    case "remove":
      return { op: "remove", id: need(raw.id, "id"), migrateTo: raw.migrateTo };
  }
}

server.registerTool(
  "list_statuses",
  {
    description:
      "This workspace's status vocabulary, in configured order — the order the board, tree and group headers use. Every status carries a CATEGORY from a fixed set (unstarted, ready, active, review, gated, blocked, done, cancelled) and ALL behaviour keys off that category, never off the id: checkout claims from ready/unstarted/blocked, a claim only ever sits in active, done/cancelled mean resolved. Read this before setting a status you did not get from a task.",
    inputSchema: { ws: wsSchema },
    outputSchema: { statuses: z.array(z.object(statusRowShape)) },
    annotations: { title: "List statuses", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ ws }) => run(() => ({ statuses: storeFor(ws).getStatuses() })),
);

server.registerTool(
  "list_kinds",
  {
    description:
      "This workspace's issue-kind vocabulary (epic, task, bug, chore, spike by default), in configured order, each with its resolved appearance (icon source and value, accessible label, terminal fallback). Kinds are a label for what a ticket IS; unlike statuses they carry no behaviour.",
    inputSchema: { ws: wsSchema },
    outputSchema: { kinds: z.array(z.object(kindWithAppearanceShape)) },
    annotations: { title: "List kinds", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ ws }) => run(() => ({ kinds: storeFor(ws).getKindsWithAppearance() })),
);

server.registerTool(
  "update_statuses",
  {
    description:
      "Change the status vocabulary: add, rename, recategorize, reorder, remove. Ops apply IN ORDER in one transaction. Removing a status that issues still carry requires migrateTo, and removing the last status of a category staple writes into (unstarted, ready, active, blocked, done, cancelled) is refused outright. Returns the full new list. This reorders every board and tree in the workspace — do it because a human asked.",
    inputSchema: { ops: z.array(vocabularyOpSchema).min(1), actor: z.string().optional(), ws: wsSchema },
    outputSchema: { statuses: z.array(z.object(statusRowShape)) },
    annotations: {
      title: "Update statuses",
      readOnlyHint: false,
      // Removal rewrites the status of every issue that carried it.
      destructiveHint: true,
      // add/remove of the same id are not; a reorder of the same list is. Say no.
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  ({ ops, actor, ws }) =>
    run(() => ({
      statuses: storeFor(ws).applyStatusOps(ops.map(toVocabularyOp), requireActor(actor)),
    })),
);

server.registerTool(
  "update_kinds",
  {
    description:
      "Change the issue-kind vocabulary: add, rename, reorder, remove. Same batch semantics as update_statuses; recategorize is not valid here because kinds have no category. Removing a kind issues still carry requires migrateTo. Returns the full new list.",
    inputSchema: { ops: z.array(vocabularyOpSchema).min(1), actor: z.string().optional(), ws: wsSchema },
    outputSchema: { kinds: z.array(z.object(kindRowShape)) },
    annotations: {
      title: "Update kinds",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: false,
    },
  },
  ({ ops, actor, ws }) =>
    run(() => ({ kinds: storeFor(ws).applyKindOps(ops.map(toVocabularyOp), requireActor(actor)) })),
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

// ---------- milestones (docs/milestones.md, STA-172) ----------

/**
 * One shape for every milestone tool, and the same one the CLI prints under
 * `--json` and the UI server answers: the milestone half (its issue fields plus
 * dates and derived state), the count-each-leaf-once progress, the members
 * revision (the CAS base), and the members in rank order. `planPosition` and
 * `next` are the queue's two fields on it and R3d (STA-174) fills them: the
 * milestone's own row in the pickup plan, and the first eligible effective row
 * that reports the milestone in its `milestonePath`.
 */
const milestoneSummaryShape = {
  identifier: z.string(),
  title: z.string(),
  status: statusEnum,
  kind: kindSchema,
  assignee: z.string().nullable(),
  targetDate: z.string().nullable().describe("YYYY-MM-DD, due by the END of that UTC day"),
  startDate: z.string().nullable(),
  state: z.enum(MILESTONE_STATES).describe("Derived on every read: done | cancelled | overdue | active | planned"),
  planPosition: z.number().nullable().describe("The milestone's own row in the pickup plan; null when it is not queued"),
};
const milestoneMemberShape = {
  identifier: z.string(),
  title: z.string(),
  kind: kindSchema,
  status: statusEnum,
  position: z.number().describe("1-based, in rank order"),
  rank: z.number().describe("The sparse encoding behind position; never type it"),
  parent: z.string().nullable().describe("The member's real parent, untouched by membership"),
  nestedUnder: z.string().nullable().describe("The nearest ancestor that is also a direct member here"),
  addedBy: z.string(),
  addedAt: z.string(),
  note: z.string().nullable(),
};
const milestoneProgressShape = {
  total: z.number(),
  countable: z.number().describe("total minus cancelled leaves — the denominator"),
  counts: z.record(z.string(), z.number()),
  percent: z.number().nullable().describe("floor(done·100/countable); null when nothing is countable"),
  complete: z.boolean(),
};
const milestoneViewShape = {
  milestone: z.object(milestoneSummaryShape),
  progress: z.object(milestoneProgressShape),
  revision: z.number().describe("The members revision; pass it back as base_revision to reorder safely"),
  members: z.array(z.object(milestoneMemberShape)),
  next: z
    .object({ identifier: z.string(), position: z.number() })
    .nullable()
    .describe("The first eligible row of the effective queue planned under this milestone; null when nothing under it is takeable"),
};
const milestoneRefSchema = z.string().describe("The milestone's reference (an issue of the `milestone` kind)");
const dateSchema = z
  .string()
  .nullable()
  .optional()
  .describe("YYYY-MM-DD (a UTC calendar day); null clears it; omit to leave it alone");
const memberPositionShape = {
  before: refSchema.optional().describe("Place it before this member"),
  after: refSchema.optional().describe("Place it after this member"),
  at: z.number().int().min(1).optional().describe("1-based position"),
};
const baseRevisionSchema = z
  .number()
  .int()
  .optional()
  .describe("The `revision` you last read; a stale base is refused with revision_conflict and the order stands");
const milestoneWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

server.registerTool(
  "list_milestones",
  {
    description:
      "Every open milestone with its dates, derived state, progress and members revision, sorted by plan position, then target date, then identifier. Milestones are issues of the reserved `milestone` kind; a workspace without that kind refuses with validation naming the `kinds add` that enables it.",
    inputSchema: {
      all: z.boolean().optional().describe("Include done and cancelled milestones"),
      ws: wsSchema,
    },
    outputSchema: {
      items: z.array(
        z.object({
          milestone: z.object(milestoneSummaryShape),
          progress: z.object(milestoneProgressShape),
          revision: z.number(),
          memberCount: z.number(),
          next: z.object({ identifier: z.string(), position: z.number() }).nullable(),
        }),
      ),
    },
    annotations: { title: "List milestones", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ all, ws }) => run(() => storeFor(ws).milestones().list({ all })),
);

server.registerTool(
  "get_milestone",
  {
    description:
      "One milestone: dates, derived state, count-each-leaf-once progress, the members revision and every member in rank order with its real parent and `nestedUnder`. A non-milestone reference is refused with validation naming its kind; an unknown one is not_found.",
    inputSchema: { ref: milestoneRefSchema, ws: wsSchema },
    outputSchema: milestoneViewShape,
    annotations: { title: "Get milestone", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ ref, ws }) => run(() => storeFor(ws).milestones().get(ref)),
);

server.registerTool(
  "create_milestone",
  {
    description:
      "Create a milestone, optionally from an epic: the epic becomes the ONE member and its children come along by descent — nothing is re-parented, ever. With preview: true nothing is written and the exact plan comes back as {preview, milestone: {title, targetDate, startDate}, members: [{identifier, position}], hierarchyChanges: []}; the commit returns the same milestone view every other milestone tool does, plus hierarchyChanges: []. Title defaults to the epic's.",
    inputSchema: {
      title: z.string().optional(),
      description: z.string().optional(),
      target_date: dateSchema,
      start_date: dateSchema,
      from_epic: refSchema.optional().describe("The epic to plan; it becomes the one member"),
      preview: z.boolean().optional().describe("Return the plan and write nothing"),
      actor: actorSchema,
      ws: wsSchema,
    },
    annotations: { title: "Create milestone", ...milestoneWriteAnnotations },
  },
  ({ title, description, target_date, start_date, from_epic, preview, actor, ws }) =>
    run(() =>
      storeFor(ws)
        .milestones()
        .create(
          { title, description, targetDate: target_date, startDate: start_date, fromEpic: from_epic, preview },
          requireActor(actor),
        ),
    ),
);

server.registerTool(
  "update_milestone",
  {
    description:
      "Set a milestone's target and/or start date (YYYY-MM-DD, UTC calendar days; null clears one). The start may not be after the target. Title, description, assignee and status are edited with update_task like any issue.",
    inputSchema: { ref: milestoneRefSchema, target_date: dateSchema, start_date: dateSchema, actor: actorSchema, ws: wsSchema },
    outputSchema: milestoneViewShape,
    annotations: { title: "Update milestone dates", readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  ({ ref, target_date, start_date, actor, ws }) =>
    run(() => storeFor(ws).milestones().update(ref, { targetDate: target_date, startDate: start_date }, requireActor(actor))),
);

server.registerTool(
  "add_milestone_member",
  {
    description:
      "Add an epic or task to a milestone at a position (before/after another member, at a 1-based position, or appended). Membership never changes the issue's parent, blockers, status or claim. An issue is a direct member of at most one milestone: adding it to a second is refused naming the first (use move_milestone_member). A present member with no position is an idempotent replay (`replayed: true`); with a position it is a move.",
    inputSchema: {
      milestone: milestoneRefSchema,
      ref: refSchema,
      ...memberPositionShape,
      base_revision: baseRevisionSchema,
      note: z.string().optional(),
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: { ...milestoneViewShape, replayed: z.boolean() },
    annotations: { title: "Add milestone member", ...milestoneWriteAnnotations },
  },
  ({ milestone, ref, before, after, at, base_revision, note, actor, ws }) =>
    run(() =>
      storeFor(ws)
        .milestones()
        .addMember(milestone, ref, { before, after, at, baseRevision: base_revision, note }, requireActor(actor)),
    ),
);

server.registerTool(
  "remove_milestone_member",
  {
    description:
      "Remove a member from a milestone. The member itself is untouched; the other members keep their ranks. A non-member is not_found.",
    inputSchema: { milestone: milestoneRefSchema, ref: refSchema, base_revision: baseRevisionSchema, actor: actorSchema, ws: wsSchema },
    outputSchema: milestoneViewShape,
    annotations: { title: "Remove milestone member", ...milestoneWriteAnnotations },
  },
  ({ milestone, ref, base_revision, actor, ws }) =>
    run(() => storeFor(ws).milestones().removeMember(milestone, ref, { baseRevision: base_revision }, requireActor(actor))),
);

server.registerTool(
  "move_milestone_member",
  {
    description:
      "Move a member within its milestone (before/after/at) or to another milestone (`to`, optionally positioned). Returns the milestone it ended up in. base_revision is checked against the destination for `to`, else the member's own milestone.",
    inputSchema: {
      ref: refSchema,
      ...memberPositionShape,
      to: milestoneRefSchema.optional().describe("Move it into this milestone instead"),
      base_revision: baseRevisionSchema,
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: milestoneViewShape,
    annotations: { title: "Move milestone member", ...milestoneWriteAnnotations },
  },
  ({ ref, before, after, at, to, base_revision, actor, ws }) =>
    run(() => storeFor(ws).milestones().moveMember(ref, { before, after, at, to, baseRevision: base_revision }, requireActor(actor))),
);

server.registerTool(
  "reorder_milestone_members",
  {
    description:
      "Replace a milestone's member order with the given list — every member, once, in the new order — atomically, bumping the revision once. Pass base_revision from your last read so a concurrent edit is refused rather than overwritten.",
    inputSchema: {
      milestone: milestoneRefSchema,
      order: z.array(refSchema).describe("Every member, in the new order"),
      base_revision: baseRevisionSchema,
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: milestoneViewShape,
    annotations: { title: "Reorder milestone members", ...milestoneWriteAnnotations },
  },
  ({ milestone, order, base_revision, actor, ws }) =>
    run(() => storeFor(ws).milestones().reorderMembers(milestone, order, { baseRevision: base_revision }, requireActor(actor))),
);

/**
 * Registered workspace settings (R6d, STA-179). `get_setting` / `set_setting`
 * are the MCP face of `staple settings get|set` and of `/api/settings` `values`:
 * all three answer the store's `SettingValueView`, so an agent, a shell and the
 * page never disagree about a value or where it came from. A global key is
 * refused by the store with the sentence naming `staple config set`.
 */
server.registerTool(
  "get_setting",
  {
    description:
      "The effective value of ONE registered workspace setting with its provenance: source is default (nothing stored) or workspace (a human or agent set it). Keys are namespaced category.name — queue.policy (advisory | strict, default advisory) says whether the pickup queue is advisory or refuses an out-of-order checkout; kinds.default is the kind a new task gets. A global machine preference is not readable here.",
    inputSchema: { key: z.string().describe("Setting key, e.g. queue.policy"), ws: wsSchema },
    outputSchema: settingValueShape,
    annotations: { title: "Get setting", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ key, ws }) => run(() => storeFor(ws).settingValue(key)),
);

server.registerTool(
  "set_setting",
  {
    description:
      "Write ONE registered workspace setting. The value is validated against the registry's schema (queue.policy takes advisory or strict) and the change is logged with actor, previous and new value. Answers the new effective value with source workspace. Changing queue.policy to strict changes what every agent's checkout is allowed to do — do it because a human asked.",
    inputSchema: {
      key: z.string().describe("Setting key, e.g. queue.policy"),
      value: z.union([z.string(), z.number(), z.boolean()]).describe("The typed value the setting's schema expects"),
      actor: z.string().optional(),
      ws: wsSchema,
    },
    outputSchema: settingValueShape,
    annotations: {
      title: "Set setting",
      readOnlyHint: false,
      destructiveHint: false,
      // The same key and value twice leaves the workspace as it was.
      idempotentHint: true,
      openWorldHint: false,
    },
  },
  ({ key, value, actor, ws }) => run(() => storeFor(ws).setSetting(key, value, requireActor(actor))),
);

/**
 * ────────────────────────────────────────────────────────────────────────────
 * THE PICKUP QUEUE — R2c (STA-168), docs/queue.md "Operations, by surface".
 *
 * Seven tools over ONE service. Every mutation calls `QueueStore.mutate`, the
 * same method `staple queue` and `/api/queue/*` call, and every one of them
 * answers the SAME `{revision, entries, effective}` the CLI prints under
 * `--json` — so an agent, a shell and the page can never disagree about the
 * plan or about the order it resolves to.
 * ────────────────────────────────────────────────────────────────────────────
 */
const queueEntryShape = {
  issueId: z.string(),
  identifier: z.string(),
  title: z.string(),
  kind: kindSchema,
  status: statusEnum,
  planPosition: z.number().describe("1-based position in the plan, resolved rows included"),
  rank: z.number(),
  parent: z.string().nullable(),
  resolved: z.boolean(),
  addedBy: z.string(),
  addedAt: z.string(),
  note: z.string().nullable(),
};

const effectiveRowShape = {
  issueId: z.string(),
  identifier: z.string(),
  title: z.string(),
  kind: kindSchema,
  status: statusEnum,
  position: z.number().describe("1-based position in EFFECTIVE order — what checkout enforces under strict"),
  planPosition: z.number().nullable().describe("The plan row this came from; null in the unqueued band"),
  via: z.string().nullable().describe("The queued container this row was expanded out of"),
  unqueued: z.boolean().describe("True for a row after the last plan row: still work, just later"),
  eligibility: z
    .enum(["resolved", "gated", "blocked", "claimed", "eligible"])
    .describe("First rule that matches: resolved, gated, blocked, claimed, else eligible. Only `eligible` is takeable."),
  reason: z.string().nullable(),
  detail: z.record(z.string(), z.unknown()).nullable(),
  dueAt: z.string().nullable().describe("The milestone target date this row inherits; explains urgency, never reorders"),
  milestonePath: z
    .array(z.string())
    .describe("The milestone this row is planned under — its own membership, else the nearest ancestor's; empty when none"),
  epicPath: z.array(z.string()).describe("The row's ancestor epics, outermost first; empty for a top-level row"),
  parent: z.string().nullable(),
};

const queueViewShape = {
  revision: z.number().describe("The `base_revision` a mutation is checked against"),
  entries: z.array(z.object(queueEntryShape)).describe("PLAN order: what a human wrote, containers included"),
  effective: z.array(z.object(effectiveRowShape)).describe("EFFECTIVE order: what an agent receives"),
};

const queueWriteAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

server.registerTool(
  "list_queue",
  {
    description:
      "The pickup plan and the effective agent order it resolves to, at one revision. `entries` is PLAN order — what a human queued, containers and milestones included. `effective` is what agents actually receive: every container expanded depth-first to its open leaf work, then the unqueued band in presentation sort, every row classified resolved | gated | blocked | claimed | eligible with a reason. Resolved entries are hidden unless `all`.",
    inputSchema: {
      all: z.boolean().optional().describe("Include done and cancelled plan entries"),
      actor: z.string().optional().describe("Whose view: a row held by somebody ELSE is `claimed`"),
      ws: wsSchema,
    },
    outputSchema: queueViewShape,
    annotations: { title: "List queue", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ all, actor, ws }) => run(() => storeFor(ws).queue().view({ all, actor })),
);

server.registerTool(
  "next_task",
  {
    description:
      "The ONE row you should take next and everything it stepped over. `next` is the first eligible row in effective order for you; `skipped` lists what came before it with why (resolved, gated, blocked, claimed). Under queue.policy = strict this is exactly what checkout_task will let you claim — call it before claiming and you will never see out_of_order.",
    inputSchema: { actor: z.string().optional().describe("Whose view (defaults to unattributed)"), ws: wsSchema },
    outputSchema: {
      revision: z.number(),
      next: z.object(effectiveRowShape).nullable(),
      skipped: z.array(z.object(effectiveRowShape)),
    },
    annotations: { title: "Next task", readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  },
  ({ actor, ws }) =>
    run(() => {
      const { revision, next, skipped } = storeFor(ws).queue().effectiveQueue({ actor });
      return { revision, next, skipped };
    }),
);

server.registerTool(
  "enqueue_task",
  {
    description:
      "Put an issue in the plan at a position, or append it. Queueing an epic or a milestone is how a human says \"this whole thing next\" — a container is never picked up itself, it expands to its open leaf work. An issue already in the plan with no position is an idempotent replay (`replayed: true`, nothing written); with a position it is a move. A foreign workspace's identifier is refused with validation. Reordering the plan is a HUMAN's job — do not reorder work you were told to do.",
    inputSchema: {
      ref: refSchema,
      ...memberPositionShape,
      base_revision: baseRevisionSchema,
      note: z.string().optional(),
      all: z.boolean().optional(),
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: { ...queueViewShape, replayed: z.boolean() },
    annotations: { title: "Enqueue task", ...queueWriteAnnotations, idempotentHint: true },
  },
  ({ ref, before, after, at, base_revision, note, all, actor, ws }) =>
    run(() =>
      storeFor(ws)
        .queue()
        .mutate("add", { ref, before, after, at, baseRevision: base_revision, note, all }, requireActor(actor)),
    ),
);

server.registerTool(
  "dequeue_task",
  {
    description:
      "Take an issue out of the plan. The issue itself is untouched and the other entries keep their positions; an issue that is not in the plan is not_found. Removing a resolved entry is what `prune_queue` does in bulk.",
    inputSchema: { ref: refSchema, base_revision: baseRevisionSchema, all: z.boolean().optional(), actor: actorSchema, ws: wsSchema },
    outputSchema: queueViewShape,
    annotations: { title: "Dequeue task", ...queueWriteAnnotations },
  },
  ({ ref, base_revision, all, actor, ws }) =>
    run(() => storeFor(ws).queue().mutate("rm", { ref, baseRevision: base_revision, all }, requireActor(actor))),
);

server.registerTool(
  "move_queue_entry",
  {
    description:
      "Move one entry to a new plan position (before/after another entry, or at a 1-based position). Exactly one of before/after/at is required. The entry keeps its original attribution — moving a row does not make you its author.",
    inputSchema: {
      ref: refSchema,
      ...memberPositionShape,
      base_revision: baseRevisionSchema,
      all: z.boolean().optional(),
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: queueViewShape,
    annotations: { title: "Move queue entry", ...queueWriteAnnotations },
  },
  ({ ref, before, after, at, base_revision, all, actor, ws }) =>
    run(() =>
      storeFor(ws)
        .queue()
        .mutate("mv", { ref, before, after, at, baseRevision: base_revision, all }, requireActor(actor)),
    ),
);

server.registerTool(
  "reorder_queue",
  {
    description:
      "Replace the whole plan order with the given list — every entry, once, in the new order — atomically, bumping the revision once. A partial list is refused by name rather than interpreted. Pass base_revision from your last read so a concurrent edit is refused rather than overwritten.",
    inputSchema: {
      order: z.array(refSchema).describe("Every queue entry, in the new order"),
      base_revision: baseRevisionSchema,
      all: z.boolean().optional(),
      actor: actorSchema,
      ws: wsSchema,
    },
    outputSchema: queueViewShape,
    annotations: { title: "Reorder queue", ...queueWriteAnnotations },
  },
  ({ order, base_revision, all, actor, ws }) =>
    run(() => storeFor(ws).queue().mutate("reorder", { order, baseRevision: base_revision, all }, requireActor(actor))),
);

server.registerTool(
  "prune_queue",
  {
    description:
      "Drop every done or cancelled entry from the plan in one transaction, emitting one dequeue event per row. Until this runs, a reopened issue resumes its old plan position; after it runs that issue is unqueued. Pruning an already-clean plan changes nothing.",
    inputSchema: { base_revision: baseRevisionSchema, all: z.boolean().optional(), actor: actorSchema, ws: wsSchema },
    outputSchema: queueViewShape,
    annotations: { title: "Prune queue", ...queueWriteAnnotations, idempotentHint: true },
  },
  ({ base_revision, all, actor, ws }) =>
    run(() => storeFor(ws).queue().mutate("prune", { baseRevision: base_revision, all }, requireActor(actor))),
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
