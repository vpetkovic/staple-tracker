/**
 * Provider inputs for the budget-ingestion suites, shaped like the real thing.
 *
 * The status-line input is `budget/claude-statusline-2.1.281.json`: every field Claude
 * Code 2.1.281's bundled schema documents, with anonymised values (no real session id,
 * path, account or repository).
 *
 * Codex rollout lines are built here rather than copied, but their SHAPE is copied
 * from the files a codex-cli 0.149 / 0.156 install writes (`session_meta` with
 * `session_id`, `id`, `forked_from_id`, `parent_thread_id`, `cli_version`, …; an
 * `event_msg` `token_count` with `info` and `rate_limits` holding `limit_id`,
 * `primary`, `secondary`, `credits`, `plan_type`, …) and from the 0.45 alpha lines on
 * the same machine (`limit_id: null`, `resets_at: null`, windows of 299 and 10079
 * minutes, `info: null`). The timings each suite uses (copies stamped 0 to 3 ms after
 * the fork instant, a copy 13.6 s later matching a pre-fork reading, resets that jitter
 * by one second) are the ones measured in those files. Ids are invented UUIDs.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

export const STATUSLINE_FIXTURE = join(HERE, "budget", "claude-statusline-2.1.281.json");

/** The fixture's raw session id, which must never be stored. */
export const STATUSLINE_SESSION_ID = "5f0c2a4e-1b7d-4c39-9e0a-7d2b6c8f1a03";

/**
 * EVERY harness session id the budget suites ingest: the status-line fixture's, the
 * alternating-cache sessions, and each Codex rollout id. The real-home guard
 * (`test/setup/isolated-home.ts`) hashes them all, under both harness names, so a leaked
 * row from any of them is recognised even with a real clock and a bound account.
 * `budget-ingest.test.ts` fails when a budget suite uses an id missing from this list.
 */
export const FIXTURE_SESSION_IDS: readonly string[] = Object.freeze([
  STATUSLINE_SESSION_ID,
  "session-a",
  "session-b",
  "0199d643-0000-7000-8000-000000000001",
  "01a0216a-0000-7c00-8f4b-000000000001",
  "01a0216c-0000-7e20-8e9f-000000000002",
  "01a05d56-0000-7000-8000-000000000003",
  "01a05d7c-0000-7000-8000-000000000004",
  "01a0cdf0-0000-7c50-8000-000000000002",
  "01a0ce10-0000-7c50-8000-000000000001",
  "11111111-0000-7000-8000-000000000001",
  "11111111-0000-7000-8000-000000000002",
  "22222222-0000-7000-8000-000000000001",
  "22222222-0000-7000-8000-000000000002",
  "22222222-0000-7000-8000-000000000003",
  "33333333-0000-7000-8000-000000000001",
  "33333333-0000-7000-8000-000000000002",
  "44444444-0000-7000-8000-000000000001",
  "55555555-0000-7000-8000-000000000001",
  "66666666-0000-7000-8000-000000000001",
]);

/** The status-line JSON, optionally with its fields replaced. `rate_limits: undefined` drops the key. */
export function statusline(overrides: Record<string, unknown> = {}): string {
  const base = JSON.parse(readFileSync(STATUSLINE_FIXTURE, "utf8")) as Record<string, unknown>;
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return JSON.stringify(base);
}

export interface SubLimit {
  used_percent: number | null;
  window_minutes: number | null;
  resets_at: number | null;
  resets_in_seconds?: number;
}

/** A `session_meta` line as codex-cli 0.149+ writes it (the fields ingestion must ignore included). */
export function sessionMetaLine(input: { id: string; timestamp: string; forkedFromId?: string; cliVersion?: string }): string {
  const forked = input.forkedFromId !== undefined;
  return JSON.stringify({
    timestamp: input.timestamp,
    type: "session_meta",
    payload: {
      session_id: forked ? input.forkedFromId : input.id,
      id: input.id,
      ...(forked ? { forked_from_id: input.forkedFromId, parent_thread_id: input.forkedFromId } : {}),
      // `payload.timestamp` precedes the outer one by tens of milliseconds; the fork
      // instant is the OUTER timestamp.
      timestamp: new Date(Date.parse(input.timestamp) - 52).toISOString(),
      cwd: "/home/operator/work/example",
      originator: "codex_cli_rs",
      cli_version: input.cliVersion ?? "0.156.1",
      source: forked ? { subagent: { thread_spawn: { parent_thread_id: input.forkedFromId, depth: 1 } } } : "cli",
      model_provider: "openai",
      base_instructions: { text: "You are Codex. (instructions elided in this fixture)" },
      history_mode: "paginated",
      git: { commit_hash: "0000000000000000000000000000000000000000", branch: "main" },
    },
  });
}

/** An `event_msg` `token_count` line as codex-cli 0.149+ writes it. */
export function tokenCountLine(input: {
  timestamp: string;
  limitId?: string | null;
  primary: SubLimit | null;
  secondary: SubLimit | null;
  planType?: string | null;
  ordinal?: number;
}): string {
  return JSON.stringify({
    timestamp: input.timestamp,
    ordinal: input.ordinal ?? 9,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: { input_tokens: 28746, cached_input_tokens: 6912, cache_write_input_tokens: 0, output_tokens: 439, reasoning_output_tokens: 320, total_tokens: 29185 },
        last_token_usage: { input_tokens: 28746, cached_input_tokens: 6912, cache_write_input_tokens: 0, output_tokens: 439, reasoning_output_tokens: 320, total_tokens: 29185 },
        model_context_window: 258400,
      },
      rate_limits: {
        limit_id: input.limitId === undefined ? "codex" : input.limitId,
        limit_name: null,
        primary: input.primary,
        secondary: input.secondary,
        credits: { has_credits: false, unlimited: false, balance: "0" },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: input.planType === undefined ? "plus" : input.planType,
        rate_limit_reached_type: null,
      },
    },
  });
}

/** A 0.45 alpha line: no limit id, no reset, 299/10079-minute windows, `info: null`. */
export function oldTokenCountLine(timestamp: string, primaryUsed: number, secondaryUsed: number): string {
  return JSON.stringify({
    timestamp,
    ordinal: 7,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        limit_id: null,
        limit_name: null,
        primary: { used_percent: primaryUsed, window_minutes: 299, resets_at: null },
        secondary: { used_percent: secondaryUsed, window_minutes: 10079, resets_at: null },
        credits: null,
        individual_limit: null,
        spend_control_reached: null,
        plan_type: null,
        rate_limit_reached_type: null,
      },
    },
  });
}

/** A line that is neither metadata nor a token count: a prompt, which ingestion must not read. */
export function responseItemLine(timestamp: string, text: string): string {
  return JSON.stringify({ timestamp, type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
}

/**
 * Write `rollout-<stamp>-<id>.jsonl` under `<codexHome>/sessions/YYYY/MM/DD/`, the
 * layout the ancestor search walks. Returns the path.
 */
export function writeRollout(codexHome: string, id: string, startedAt: string, lines: string[]): string {
  const [date] = startedAt.split("T");
  const [y, m, d] = date!.split("-");
  const stamp = startedAt.slice(0, 19).replace(/:/g, "-");
  const path = join(codexHome, "sessions", y!, m!, d!, `rollout-${stamp}-${id}.jsonl`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
  return path;
}

/** `resets_at` as Codex writes it: Unix epoch seconds. */
export const epoch = (iso: string): number => Math.floor(Date.parse(iso) / 1000);

/** An instant `ms` milliseconds after `iso`. */
export const after = (iso: string, ms: number): string => new Date(Date.parse(iso) + ms).toISOString();
