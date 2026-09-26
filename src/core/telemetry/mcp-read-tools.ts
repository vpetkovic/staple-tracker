/**
 * The MCP half of the telemetry read surfaces (docs/execution-telemetry.md, "Surfaces"):
 * `list_attempts`, `get_attempt`, `get_budget` and `list_budget_samples`. Each calls the
 * same method the CLI does — `WorkspaceStore.listAttempts` / `getAttempt`, `readBudget` /
 * `listBudgetSamples` — so `--json` and the tool answer one shape.
 *
 * The two attempt tools act on ONE workspace and take `ws` like every other workspace tool,
 * resolved by `src/mcp.ts`'s own `storeFor`. The two budget tools read this machine's
 * `hub.db`, not a workspace, and take no `ws`, like `record_budget_sample`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z, type ZodTypeAny } from "zod";
import { stapleHome } from "../../config/home.js";
import type { WorkspaceStore } from "../store.js";
import { listBudgetSamples, readBudget } from "./read-budget.js";

type Run = (fn: () => unknown) => { content: Array<{ type: "text"; text: string }>; isError?: true };

// A number, not an integer schema: a fractional or negative limit is refused by the read
// itself, with the same validation envelope the CLI prints, not by the protocol layer.
const limit = z.number().optional().describe("Page size: a positive integer, default 50, at most 500 (a larger value is clamped).");
const cursor = z
  .string()
  .optional()
  .describe("Opaque cursor from the previous page's nextCursor, with the same other arguments. Stable when rows are added between pages.");

const coverageShape = z
  .object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    itemCount: z.number(),
    gaps: z.array(z.object({ from: z.string(), to: z.string(), reason: z.string() })),
    missing: z.record(z.string(), z.string()).describe("Why from or to is null; empty when both have a value."),
  })
  .describe("The span this page speaks for, and the spans in it nobody was capturing (reason from the missingness table).");

const pageShape = {
  items: z.array(z.record(z.string(), z.unknown())),
  truncated: z.boolean().describe("Stated, never inferred: true when more rows follow this page."),
  nextCursor: z.string().nullable().describe("Pass back as cursor for the next page; null exactly when truncated is false."),
  coverage: coverageShape,
};

const READ = { readOnlyHint: true, idempotentHint: true, openWorldHint: false } as const;

export function registerTelemetryReadTools(
  server: McpServer,
  helpers: { run: Run; storeFor: (ws?: string) => WorkspaceStore; wsSchema: ZodTypeAny; refSchema: ZodTypeAny },
): void {
  const { run, storeFor, wsSchema, refSchema } = helpers;

  server.registerTool(
    "list_attempts",
    {
      description:
        "The execution attempts on one issue, oldest first (docs/execution-telemetry.md): each one agent's tenure, as it reads now. `state`, `outcome` and `endReason` are the effective values: an attempt whose claim was cleared or moved by a path that ran no side effect reads as ended/orphaned with `storedState` showing what the row holds. Bounded: {items, truncated, nextCursor, coverage}; coverage.gaps names spans before capture began. Same payload as `staple attempts <ref> --json`.",
      inputSchema: { ref: refSchema, limit, cursor, ws: wsSchema },
      outputSchema: pageShape,
      annotations: { title: "List attempts", ...READ },
    },
    ({ ref, limit: size, cursor: position, ws }: { ref: string; limit?: number; cursor?: string; ws?: string }) =>
      run(() => storeFor(ws).listAttempts(ref, { limit: size, cursor: position })),
  );

  server.registerTool(
    "get_attempt",
    {
      description:
        "One execution attempt by its id (the `id` of an attempt from list_attempts, get_task or a write's `attempt`): the attempt as it reads, its transitions (bounded, oldest first; limit and cursor page them), its `chain` (the attempts linked by resumesAttemptId, oldest first: every interruption boundary of one piece of work) and its `burn`: per limit of its provider account, the high-water usage delta over the attempt from THIS machine's budget samples, with `attribution` sole_known or shared (null with a reason when a concurrency count is unknown); `lowerBound` true means the burn is at least that much. A window with no reading inside the attempt counts as unknown (stale). Burn is null with a reason in `missing` when it cannot be known (no_provider_binding, not_on_this_device, no_sample_yet, source_unavailable, sliding_window), never 0. Same payload as `staple attempt <id> --json`.",
      inputSchema: { attempt_id: z.string().describe("The attempt's id (a UUID)."), limit, cursor, ws: wsSchema },
      outputSchema: {
        attempt: z.record(z.string(), z.unknown()),
        transitions: z.object(pageShape),
        chain: z.array(z.record(z.string(), z.unknown())),
        burn: z.record(z.string(), z.unknown()),
      },
      annotations: { title: "Get attempt", ...READ },
    },
    ({ attempt_id, limit: size, cursor: position, ws }: { attempt_id: string; limit?: number; cursor?: string; ws?: string }) =>
      run(() => storeFor(ws).getAttempt(attempt_id, { limit: size, cursor: position }, stapleHome())),
  );

  server.registerTool(
    "get_budget",
    {
      description:
        "Provider budget on THIS machine (docs/execution-telemetry.md): per account (those with readings and those a source binding names), each limit's current window with its latest sample, `status`, the high-water `remainingPercent` (the conservative figure) and `missing`. An unknown value is null with a reason (no_sample_yet, source_unavailable, window_elapsed, reset_not_reported, sliding_window), never 0. `stale` is true when the latest reading's value is over 10 minutes old (judged on observedAt, as history's gaps are). Each limit's `pressure` (PROVISIONAL until the admission policy defines it): MEASURED `observed` pace (%/hour of wall clock) and `lastReadingAgeSeconds`; FORECAST `sustainablePercentPerHour` = (remaining − reserve) / hours to reset, `ratio` = observed / sustainable, `state` unsafe at 1 or over (or at the reserve already) else within, `exhaustion` and `reserveReach` at the pace, and `safeConcurrency` always null (policy_not_defined). Budget data is machine-local and never synchronizes. Same payload as `staple budget --json`.",
      inputSchema: {
        account: z.string().optional().describe("Only this account label."),
        reserve: z.union([z.string(), z.number()]).optional().describe("The reserve pressure protects, a percent of each limit (20 or \"20%\"); a provisional default otherwise, said on `reserve.source`."),
      },
      outputSchema: {
        asOf: z.string(),
        budgetCapture: z.boolean(),
        reserve: z.record(z.string(), z.unknown()),
        pressureRule: z.record(z.string(), z.unknown()),
        accounts: z.array(z.record(z.string(), z.unknown())),
      },
      annotations: { title: "Get budget", ...READ },
    },
    ({ account, reserve }: { account?: string; reserve?: string | number }) => run(() => readBudget(stapleHome(), { account, reserve })),
  );

  server.registerTool(
    "list_budget_samples",
    {
      description:
        "One account's budget readings on THIS machine, oldest first by observedAt, each with a derived `regression` flag (below the window's earlier high-water). Bounded: {items, truncated, nextCursor, coverage}; coverage.gaps lists spans with no reading and no heartbeat (capture was not running), so 'saw no change' is told apart from 'nobody was looking'. Same payload as `staple budget history --json`.",
      inputSchema: {
        account: z.string().describe("The account label."),
        since: z.string().optional().describe("An ISO-8601 instant, or a duration meaning that long ago (2h, 3d)."),
        limit,
        cursor,
      },
      outputSchema: pageShape,
      annotations: { title: "List budget samples", ...READ },
    },
    ({ account, since, limit: size, cursor: position }: { account: string; since?: string; limit?: number; cursor?: string }) =>
      run(() => listBudgetSamples(stapleHome(), { account, since, limit: size, cursor: position })),
  );
}
