/**
 * The MCP half of budget ingestion: `record_budget_sample` calls the same
 * `ingestBudget` as `staple budget ingest`, with the same source tokens, so the two
 * surfaces answer one shape (docs/execution-telemetry.md, "One shape on every surface").
 *
 * Registered from `src/mcp.ts` with that file's own `run` wrapper, so success and the
 * error envelope are formatted exactly as every other tool's.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { stapleHome } from "../../config/home.js";
import { attemptLinkerFor } from "./attempt-link.js";
import { INGEST_SOURCES, ingestBudget } from "./ingest.js";

type Run = (fn: () => unknown) => { content: Array<{ type: "text"; text: string }>; isError?: true };

const outcomeShape = z
  .object({
    stored: z.boolean(),
    sample: z.record(z.unknown()).optional(),
    reason: z.string().optional(),
    limitKey: z.string().nullable().optional(),
    observedAt: z.string().nullable().optional(),
  })
  .passthrough();

export function registerBudgetTools(server: McpServer, helpers: { run: Run }): void {
  server.registerTool(
    "record_budget_sample",
    {
      description:
        "Record provider usage readings on THIS machine (docs/execution-telemetry.md). source='claude-statusline' takes the status-line JSON Claude Code sent (input) and binds it by config_dir (default CLAUDE_CONFIG_DIR, then ~/.claude); 'codex-rollout' reads one rollout file (file), skipping fork-copied history; 'manual' records a reading read off /usage or /status (account, limit_key, used, optional resets_at as an instant or a duration like 3h, optional provider). Every source here, manual included, needs budget capture switched on by the operator (`staple budget capture on`, off by default), and every source needs an account: a machine binding (`staple budget bind`) or account. Without one the call is refused and nothing is stored under a guessed account. Percentages are stored as reported, never inferred; an unknown value is null with a reason in `missing`, never 0. Returns one outcome per reading: the stored sample, or {stored:false, reason} with reason unchanged, fork_copied, not_reported_by_source or parse_error. Samples stay in this machine's hub.db and never replicate; no network request is made.",
      inputSchema: {
        source: z.enum(INGEST_SOURCES),
        input: z.string().optional().describe("claude-statusline: the status-line JSON, verbatim"),
        config_dir: z.string().optional().describe("claude-statusline: the Claude Code config directory to bind by"),
        file: z.string().optional().describe("codex-rollout: path to one rollout-*.jsonl"),
        account: z.string().optional().describe("the account label; overrides the machine binding"),
        provider: z.string().optional().describe("provider slug, e.g. anthropic, openai"),
        limit_key: z.string().optional().describe("manual: the provider's name for the limit (five_hour, seven_day, codex.primary)"),
        used: z.number().optional().describe("manual: percent used on a 0-100 scale, as shown (above 100 is kept)"),
        resets_at: z.string().optional().describe("manual: an ISO instant, or a duration such as 3h converted at capture"),
      },
      outputSchema: {
        source: z.string(),
        provider: z.string(),
        accountRef: z.string(),
        accountSource: z.string(),
        outcomes: z.array(outcomeShape),
        storedCount: z.number(),
        skipped: z.record(z.number()),
      },
      annotations: {
        title: "Record budget sample",
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    ({ source, input, config_dir, file, account, provider, limit_key, used, resets_at }) =>
      helpers.run(() =>
        ingestBudget(
          { source, input, configDir: config_dir, file, account, provider, limitKey: limit_key, used, resetsAt: resets_at },
          { home: stapleHome(), attemptLinker: attemptLinkerFor(stapleHome()) },
        ),
      ),
  );
}
