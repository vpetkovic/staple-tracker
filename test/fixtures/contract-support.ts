/**
 * H10 contract-test harness (test-only; nothing here is imported by src/).
 *
 * The suites that use this file pin the machine-facing contracts — MCP tool
 * results, error envelopes, CLI exit codes, HTTP status/body — as readable
 * golden objects. Two rules make that possible without flaky diffs:
 *
 *  1. Volatile values are NORMALIZED, never deleted. A uuid becomes "<uuid>",
 *     an ISO-8601 instant becomes "<iso>", an opaque cursor becomes "<cursor>",
 *     a temp path becomes "<path>". A field that stops being a uuid is simply
 *     not replaced, so the golden mismatches and the test fails loudly — the
 *     FORMAT is asserted by the substitution itself.
 *  2. Everything else is pinned exactly with toEqual against a hand-written
 *     object, so an added, removed, or renamed field is a visible diff in the
 *     test rather than a silent break in a downstream agent.
 *
 * No snapshot files on purpose: the point of this ticket is that a shape change
 * shows up as a reviewable diff, and an auto-written .snap invites `-u`.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const TSX_CLI = join(REPO_ROOT, "node_modules/tsx/dist/cli.mjs");
export const MCP_ENTRY = join(REPO_ROOT, "src/mcp.ts");
export const CLI_ENTRY = join(REPO_ROOT, "src/cli.ts");

/** The agent identity every contract fixture writes as. */
export const CONTRACT_AGENT = "contract-agent";

// ---------- normalization ----------

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Full ISO-8601 with millis and a Z suffix — the format cli-json.test.ts also pins. */
export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
export const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;

export const UUID = "<uuid>";
export const ISO = "<iso>";
export const CURSOR = "<cursor>";
export const PATH = "<path>";
/**
 * Derived-seconds fields are readings taken off a real fixture's real history,
 * not stored data: a fixture that takes 1100ms instead of 900ms flips them from
 * 0 to 1. Their FORMAT is pinned (a non-negative finite number, asserted below)
 * while their value is tokenized, exactly as ISO instants are.
 */
export const SECONDS = "<seconds>";
/**
 * Keys whose numeric value is derived from the clock rather than chosen.
 *
 * STA-90 renamed the timing fields; `elapsedSeconds`/`childrenElapsedSeconds`
 * became `activeSeconds`/`childrenActiveSeconds` and gained `ownActiveSeconds`
 * and `reviewSeconds` beside them. All four belong here for the same reason the
 * originals did — and note that the clamp did NOT make them pinnable: a contract
 * fixture claims and reads within the same few milliseconds, so the open interval
 * is 0 or 1 depending on how the machine felt.
 *
 * `estimatedSeconds` deliberately stays OUT: an estimate is stored data a
 * fixture chose, so `5400` must be pinned as `5400`. Tokenizing it would hide the
 * exact bug this feature can have — a write path that stores the wrong number.
 */
const ELAPSED_SECONDS_KEYS = new Set([
  "heldSeconds",
  "idleSeconds",
  "activeSeconds",
  "ownActiveSeconds",
  "reviewSeconds",
  "childrenActiveSeconds",
]);

/**
 * Decode an opaque cursor the way a consumer never should. Used ONLY to assert
 * the wire format (base64url of {k:"o"|"s"}); the suites still pass cursors back
 * verbatim, exactly as a real caller must.
 */
export function decodeCursorForAssertion(cursor: string): { k: string } | null {
  if (!BASE64URL_RE.test(cursor) || cursor.length < 8) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (parsed && typeof parsed === "object" && typeof (parsed as { k?: unknown }).k === "string") {
      return parsed as { k: string };
    }
  } catch {
    return null;
  }
  return null;
}

function normalizeString(value: string, tempRoots: readonly string[]): string {
  if (decodeCursorForAssertion(value)) return CURSOR;
  if (UUID_RE.test(value)) return UUID;
  if (ISO_RE.test(value)) return ISO;
  if (tempRoots.some((root) => value.startsWith(root))) return PATH;
  return value;
}

/**
 * Recursively replace volatile values with their format tokens. `tempRoots` are
 * the mkdtemp roots this run owns — a path outside them is NOT normalized, so a
 * leaked absolute path from somewhere else still fails the golden.
 */
export function normalize(value: unknown, tempRoots: readonly string[] = []): unknown {
  if (typeof value === "string") return normalizeString(value, tempRoots);
  if (Array.isArray(value)) return value.map((item) => normalize(item, tempRoots));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      // Elapsed-seconds fields are tokenized by KEY (their format is a number,
      // so there is nothing in the value itself to recognise them by). The
      // format assertion is kept honest here rather than dropped: a negative or
      // non-finite reading fails instead of being normalized away.
      if (ELAPSED_SECONDS_KEYS.has(key) && typeof inner === "number") {
        out[key] = Number.isFinite(inner) && inner >= 0 ? SECONDS : `<bad-seconds:${inner}>`;
        continue;
      }
      out[key] = normalize(inner, tempRoots);
    }
    return out;
  }
  return value;
}

// ---------- golden builders ----------

/**
 * Every field of core/types.ts Issue, at its create-time default. Callers
 * override only what their fixture changed, so the golden stays readable while
 * still pinning all 29 fields: a new field in Issue is missing here and fails,
 * a removed field is extra here and fails.
 */
export function issueGolden(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID,
    identifier: "<set me>",
    title: "<set me>",
    description: null,
    status: "backlog",
    statusVersion: 0,
    // STA-124. `task` is the create-time default, and migration 005's backfill of
    // parents to `epic` ran once against pre-existing rows — it does not fire for
    // an issue created by a fixture, so even a fixture PARENT is a `task` here.
    kind: "task",
    priority: "medium",
    parentId: null,
    depth: 0,
    assignee: null,
    createdBy: CONTRACT_AGENT,
    labels: [],
    acceptanceCriteria: null,
    blockParentUntilDone: false,
    unblockOwner: null,
    unblockAction: null,
    originKind: "manual",
    originId: null,
    idempotencyKey: null,
    checkoutAgent: null,
    checkoutAt: null,
    blockedTransitionAt: null,
    // STA-81. NULL is the create-time default and the honest one: an issue
    // created without an estimate has none, which is not the same fact as zero.
    estimatedSeconds: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    createdAt: ISO,
    updatedAt: ISO,
    ...over,
  };
}

/**
 * Every field of core/types.ts IssueTiming, for an issue with no estimate, no
 * start, and no children. Callers override what their fixture actually has.
 *
 * Elapsed values are normalized to SECONDS by `normalize` (see
 * ELAPSED_SECONDS_KEYS) for the same reason claim durations are: they are
 * readings off a wall clock and cannot be pinned to a literal.
 */
export function timingGolden(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    estimatedSeconds: null,
    ownActiveSeconds: null,
    activeSeconds: null,
    reviewSeconds: null,
    approximate: false,
    countedThrough: null,
    childCount: 0,
    childrenEstimatedSeconds: null,
    childrenActiveSeconds: null,
    childStatusCounts: {
      backlog: 0,
      todo: 0,
      in_progress: 0,
      in_review: 0,
      awaiting_approval: 0,
      done: 0,
      blocked: 0,
      cancelled: 0,
    },
    ...over,
  };
}

/**
 * Every field of core/types.ts ClaimActivity, for an issue held by the contract
 * agent. `claim` is null on any issue nobody holds — pass null directly for those
 * rather than calling this.
 */
export function claimGolden(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    heldBy: CONTRACT_AGENT,
    checkoutAt: ISO,
    lastActivityAt: ISO,
    heldSeconds: SECONDS,
    idleSeconds: SECONDS,
    ...over,
  };
}

/** Every field of core/types.ts IssueComment, at its default. */
export function commentGolden(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: UUID,
    issueId: UUID,
    author: CONTRACT_AGENT,
    authorType: "agent",
    body: "<set me>",
    idempotencyKey: null,
    deletedAt: null,
    createdAt: ISO,
    ...over,
  };
}

// ---------- MCP ----------

export interface ToolCallResult {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface McpHarness {
  client: Client;
  call(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  listTools(): Promise<Array<{ name: string; annotations?: Record<string, unknown>; outputSchema?: unknown }>>;
  close(): Promise<void>;
}

/** Child env with the outer shell's workspace pinning stripped, like smoke-mcp.ts. */
export function cleanEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "STAPLE_DB" || key === "STAPLE_WS" || key === "STAPLE_AGENT") continue;
    base[key] = value;
  }
  // node:sqlite's ExperimentalWarning is runtime noise on stderr, not our output.
  base.NODE_NO_WARNINGS = "1";
  return { ...base, ...extra };
}

/**
 * Start a real staple MCP server over stdio and talk to it with the SDK client.
 * Using the SDK client (not hand-rolled JSON-RPC) buys one extra contract check
 * for free: it validates structuredContent against each tool's declared
 * outputSchema and fails the call on drift.
 */
export async function startMcpClient(options: {
  home: string;
  cwd: string;
  agent?: string;
}): Promise<McpHarness> {
  const env = cleanEnv({
    STAPLE_HOME: options.home,
    ...(options.agent ? { STAPLE_AGENT: options.agent } : {}),
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [TSX_CLI, MCP_ENTRY],
    cwd: options.cwd,
    env,
    stderr: "ignore",
  });
  const client = new Client({ name: "staple-contract", version: "0.0.0" });
  await client.connect(transport);
  return {
    client,
    async call(name, args) {
      return (await client.callTool({ name, arguments: args })) as unknown as ToolCallResult;
    },
    async listTools() {
      const result = await client.listTools();
      return result.tools as unknown as Array<{
        name: string;
        annotations?: Record<string, unknown>;
        outputSchema?: unknown;
      }>;
    },
    async close() {
      await client.close();
    },
  };
}

/** The single text block every tool returns, parsed. */
export function toolPayload(result: ToolCallResult): unknown {
  const first = result.content[0];
  if (!first || typeof first.text !== "string") throw new Error("tool result has no text block");
  return JSON.parse(first.text);
}

/**
 * mcp.ts wraps a non-object payload before putting it in structuredContent.
 * Mirrored here so a suite can prove text and structuredContent agree.
 */
export function asStructured(payload: unknown): Record<string, unknown> {
  if (Array.isArray(payload)) return { items: payload };
  if (payload !== null && typeof payload === "object") return payload as Record<string, unknown>;
  return { value: payload };
}

/**
 * The machine-readable envelope an MCP error result carries on its LAST text
 * line, under an `error` key, after a human-readable `ERROR(code): ...` line.
 */
export function mcpEnvelope(result: ToolCallResult): Record<string, unknown> {
  const first = result.content[0];
  if (!first || typeof first.text !== "string") throw new Error("error result has no text block");
  const lines = first.text.split("\n");
  const parsed = JSON.parse(lines[lines.length - 1] ?? "") as { error: Record<string, unknown> };
  return parsed.error;
}

/** The prose first line, so the "grep the ERROR( line" contract stays pinned too. */
export function mcpErrorProse(result: ToolCallResult): string {
  const first = result.content[0];
  if (!first || typeof first.text !== "string") throw new Error("error result has no text block");
  return first.text.split("\n")[0] ?? "";
}

// ---------- CLI ----------

export interface CliResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** Run the real CLI in a child process, exactly as an agent shells out to it. */
export function runCli(args: string[], env: Record<string, string>): CliResult {
  const result = spawnSync(process.execPath, [TSX_CLI, CLI_ENTRY, ...args], {
    cwd: REPO_ROOT,
    env: cleanEnv(env),
    encoding: "utf8",
  });
  return { status: result.status ?? 0, stdout: result.stdout, stderr: result.stderr };
}

/** The single-line JSON envelope `--json` writes to stderr on failure. */
export function cliEnvelope(result: CliResult): Record<string, unknown> {
  const lines = result.stderr.trim().split("\n");
  if (lines.length !== 1) {
    throw new Error(`expected a single stderr line, got ${lines.length}:\n${result.stderr}`);
  }
  return JSON.parse(lines[0] ?? "") as Record<string, unknown>;
}
