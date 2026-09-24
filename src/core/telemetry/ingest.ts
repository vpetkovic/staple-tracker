/**
 * The one ingestion method (docs/execution-telemetry.md, "Surfaces"): `staple budget
 * ingest` and the MCP tool `record_budget_sample` both call {@link ingestBudget}, so the
 * two cannot answer differently.
 *
 * Order matters for privacy and for consent:
 *
 *   1. Budget capture must be on for a harness source (it is off by default). Nothing
 *      is read from a harness until the operator enables it.
 *   2. The account is resolved from `--account` or a machine binding BEFORE the input
 *      is parsed or a rollout is opened. With neither, the refusal names the missing
 *      binding and nothing was read or stored.
 *   3. The source parser reads only its rate-limit fields.
 *   4. Each reading goes through {@link BudgetStore.record}.
 *
 * Local only: stdin, local files and `hub.db`. No network call is made or triggered.
 */
import { join } from "node:path";
import { Hub } from "../hub.js";
import { StapleError } from "../types.js";
import { readConfig } from "../../config/file.js";
import { BudgetStore, type AttemptLink, type SampleOutcome } from "./budget-store.js";
import {
  claudeBindingFor,
  claudeConfigDir,
  codexBindingFor,
  expandHomePath,
  invalidClaudeBindingFor,
  invalidCodexBindingFor,
  resolveAccount,
  type AccountSource,
} from "./bindings.js";
import { assertAccountRef, assertProvider, type BudgetSourceKind } from "./formats.js";
import { parseClaudeStatusline } from "./sources/claude-statusline.js";
import { parseCodexRollout } from "./sources/codex-rollout.js";
import { parseManualReading } from "./sources/manual.js";
import type { ParsedItem } from "./sources/types.js";

/** The source tokens every surface spells the same way. */
export const INGEST_SOURCES = ["claude-statusline", "codex-rollout", "manual"] as const;
export type IngestSource = (typeof INGEST_SOURCES)[number];

export interface IngestRequest {
  readonly source: IngestSource;
  /** claude-statusline: the status-line JSON exactly as Claude Code sent it. */
  readonly input?: string;
  /** claude-statusline: the config directory to bind by. Defaults to `CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  readonly configDir?: string;
  /** codex-rollout: one rollout-*.jsonl file. */
  readonly file?: string;
  readonly account?: string;
  readonly provider?: string;
  /** manual: the provider's name for the limit. */
  readonly limitKey?: string;
  /** manual: percent used, 0-100 (above 100 is kept). */
  readonly used?: number | string;
  /** manual: an instant, or a duration the screen showed. */
  readonly resetsAt?: string;
}

export interface IngestResult {
  readonly source: BudgetSourceKind;
  readonly provider: string;
  readonly accountRef: string;
  readonly accountSource: AccountSource;
  /** One per reading or skipped line, in input order. */
  readonly outcomes: SampleOutcome[];
  readonly storedCount: number;
  /** Skipped readings by reason: `unchanged`, `fork_copied`, `not_reported_by_source`, `parse_error`. */
  readonly skipped: Record<string, number>;
}

/** Links a reading to an attempt. Attempts supply this; with none, nothing matches. */
export type AttemptLinker = (reading: { provider: string; accountRef: string; sessionRef: string | null }) => AttemptLink;

export interface IngestDeps {
  /** The staple home: its `config.json` and its `hub.db`. */
  readonly home: string;
  readonly now?: () => string;
  readonly env?: NodeJS.ProcessEnv;
  readonly attemptLinker?: AttemptLinker;
  /**
   * True only when the operator typed the command (the CLI). A manual reading is the
   * operator's own word, so the CLI accepts it with capture off; an agent calling the
   * MCP tool is not the operator, and is held to the opt-in like any harness source.
   */
  readonly operator?: boolean;
}

const SOURCE_KIND: Readonly<Record<IngestSource, BudgetSourceKind>> = {
  "claude-statusline": "claude_code_statusline",
  "codex-rollout": "codex_rollout",
  manual: "operator_manual",
};

const noAttempt: AttemptLinker = () => ({ reason: "no_matching_attempt" });

function requireField<T>(value: T | undefined, message: string): T {
  if (value === undefined || (typeof value === "string" && value.trim() === "")) throw new StapleError("validation", message);
  return value;
}

export function ingestBudget(request: IngestRequest, deps: IngestDeps): IngestResult {
  if (!(INGEST_SOURCES as readonly string[]).includes(request.source)) {
    throw new StapleError("validation", `Unknown budget source "${String(request.source)}". Use one of: ${INGEST_SOURCES.join(", ")}.`);
  }
  const now = deps.now ?? (() => new Date().toISOString());
  const env = deps.env ?? process.env;
  const telemetry = readConfig(deps.home).config.telemetry;
  const kind = SOURCE_KIND[request.source];

  const operatorManual = request.source === "manual" && deps.operator === true;
  if (!operatorManual && !telemetry.budgetCapture) {
    throw new StapleError(
      "validation",
      request.source === "manual"
        ? "Budget capture is off on this machine, so an agent cannot record readings. It is opt-in: the operator enables it with `staple budget capture on`, or types a reading with `staple budget ingest --source manual`."
        : "Budget capture is off on this machine, so nothing was read from the harness. It is opt-in: `staple budget capture on` enables it.",
      { reason: "capture_disabled", source: kind },
    );
  }

  const capturedAt = now();
  let account: ReturnType<typeof resolveAccount>;
  let items: ParsedItem[];
  switch (request.source) {
    case "claude-statusline": {
      const configDir = request.configDir !== undefined ? expandHomePath(request.configDir) : claudeConfigDir(env);
      account = resolveAccount({
        source: "claude_code_statusline",
        binding: claudeBindingFor(telemetry, configDir),
        account: request.account,
        provider: request.provider,
        lookedUp: configDir,
        invalidBinding: invalidClaudeBindingFor(telemetry, configDir),
      });
      items = parseClaudeStatusline(requireField(request.input, "The status-line input is empty. Pipe Claude Code's status-line JSON to stdin."), capturedAt);
      break;
    }
    case "codex-rollout": {
      const file = expandHomePath(requireField(request.file, "Name the rollout file: staple budget ingest --source codex-rollout <file>."));
      const binding = codexBindingFor(telemetry, file);
      account = resolveAccount({
        source: "codex_rollout",
        binding,
        account: request.account,
        provider: request.provider,
        lookedUp: file,
        invalidBinding: invalidCodexBindingFor(telemetry, file),
      });
      // Ancestors are read only from the bound Codex home's sessions tree.
      const sessionsRoot = binding !== null && binding.source === "codex_rollout" ? join(expandHomePath(binding.home), "sessions") : undefined;
      items = parseCodexRollout(file, { sessionsRoot });
      break;
    }
    case "manual": {
      const accountRef = requireField(request.account, "A manual reading needs --account: the label of the account the screen showed.");
      const matching = telemetry.bindings.find(
        (binding) => (binding as { accountRef?: unknown }).accountRef === accountRef && typeof (binding as { provider?: unknown }).provider === "string",
      ) as { provider: string } | undefined;
      const provider = request.provider ?? matching?.provider;
      if (provider === undefined) {
        throw new StapleError(
          "validation",
          `No provider for account "${accountRef}": pass --provider (anthropic, openai, …), or bind the account to a source first.`,
        );
      }
      account = {
        provider: assertProvider(provider, "--provider"),
        accountRef: assertAccountRef(accountRef, "--account"),
        accountSource: "flag",
      };
      items = parseManualReading(
        {
          provider: account.provider,
          limitKey: requireField(request.limitKey, "A manual reading needs --limit-key: the provider's name for the limit (five_hour, seven_day, codex.primary)."),
          used: requireField(request.used, "A manual reading needs --used: the percentage used, as the screen shows it."),
          resetsAt: request.resetsAt,
        },
        capturedAt,
      );
      break;
    }
  }

  const link = deps.attemptLinker ?? noAttempt;
  const hub = Hub.openAt(deps.home);
  try {
    const store = new BudgetStore(hub.db);
    const outcomes = items.map((item): SampleOutcome => {
      if (item.kind === "skip") return { stored: false, reason: item.reason, limitKey: item.limitKey, observedAt: item.observedAt };
      return store.record({
        reading: item.reading,
        provider: account.provider,
        accountRef: account.accountRef,
        recordedAt: now(),
        attempt: link({ provider: account.provider, accountRef: account.accountRef, sessionRef: item.reading.sessionRef }),
      });
    });
    const skipped: Record<string, number> = {};
    for (const outcome of outcomes) if (!outcome.stored) skipped[outcome.reason] = (skipped[outcome.reason] ?? 0) + 1;
    return {
      source: kind,
      provider: account.provider,
      accountRef: account.accountRef,
      accountSource: account.accountSource,
      outcomes,
      storedCount: outcomes.filter((outcome) => outcome.stored).length,
      skipped,
    };
  } finally {
    hub.close();
  }
}
