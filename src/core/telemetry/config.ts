/**
 * The `telemetry` field of `<home>/config.json` (docs/execution-telemetry.md, "Source
 * bindings produce the account").
 *
 *   "telemetry": {
 *     "budgetCapture": false,
 *     "bindings": [
 *       { "source": "claude_code_statusline", "configDir": "~/.claude", "provider": "anthropic", "accountRef": "personal-max" },
 *       { "source": "codex_rollout", "home": "~/.codex", "provider": "openai", "accountRef": "codex-plus" }
 *     ]
 *   }
 *
 * Machine-local by construction: the staple home never replicates. Budget capture is
 * opt-in and defaults to off, so nothing is read from a harness until the operator turns
 * it on. A binding names the account a harness's readings belong to, because neither
 * automated source says which account it measures.
 *
 * ## One bad binding never takes the rest of the configuration with it
 *
 * `bindings` entries are kept exactly as written and judged one by one. A binding that is
 * USABLE (a known source with valid fields) is matched. Any other entry is preserved and
 * never matched: one for a source a newer build knows, or one somebody hand-edited into
 * an invalid shape (`"accountRef": "Personal-Max"`). The latter is reported by `staple
 * doctor` and `staple budget bindings`. Refusing the whole file instead would break
 * `staple config` and `config set`, the very commands that could repair it.
 *
 * Only the two structural facts are enforced at the read boundary: `telemetry` is an
 * object, `budgetCapture` a boolean and `bindings` an array.
 *
 * Pure: no file I/O here, so `config/file.ts` can validate through it without a cycle.
 */
import { StapleError } from "../types.js";
import { ACCOUNT_REF_PATTERN, PROVIDER_PATTERN } from "./formats.js";

export const BINDING_SOURCES = ["claude_code_statusline", "codex_rollout"] as const;
export type BindingSource = (typeof BINDING_SOURCES)[number];

export interface ClaudeStatuslineBinding {
  readonly source: "claude_code_statusline";
  /** The Claude Code config directory (`CLAUDE_CONFIG_DIR`, or `~/.claude`). `~` is expanded at use. */
  readonly configDir: string;
  readonly provider: string;
  readonly accountRef: string;
}

export interface CodexRolloutBinding {
  readonly source: "codex_rollout";
  /** The Codex home (`CODEX_HOME`, or `~/.codex`). A rollout belongs to the binding whose home contains it. */
  readonly home: string;
  readonly provider: string;
  readonly accountRef: string;
}

export type KnownBinding = ClaudeStatuslineBinding | CodexRolloutBinding;

/** A binding as stored: whatever the file holds, kept verbatim. */
export type TelemetryBinding = unknown;

export interface TelemetryConfig {
  readonly budgetCapture: boolean;
  readonly bindings: readonly TelemetryBinding[];
  /** Keys a newer build wrote inside `telemetry`, kept for the next write. */
  readonly [key: string]: unknown;
}

export const DEFAULT_TELEMETRY: TelemetryConfig = Object.freeze({ budgetCapture: false, bindings: Object.freeze([]) });

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Why a stored binding cannot be used, or null when it can. A binding for a source this
 * build does not know is not a problem, only not ours: it reads `unknown_source`.
 */
export function bindingProblem(binding: TelemetryBinding): string | null {
  const record = asRecord(binding);
  if (record === null) return "is not a JSON object";
  const source = record.source;
  if (typeof source !== "string" || source === "") return 'has no "source"';
  if (!(BINDING_SOURCES as readonly string[]).includes(source)) return "unknown_source";
  const dirKey = source === "claude_code_statusline" ? "configDir" : "home";
  const dir = record[dirKey];
  if (typeof dir !== "string" || dir.trim() === "") return `has no "${dirKey}"`;
  const accountRef = record.accountRef;
  if (typeof accountRef !== "string" || !ACCOUNT_REF_PATTERN.test(accountRef)) {
    return `has "accountRef" ${JSON.stringify(accountRef)}, which is not a label (${ACCOUNT_REF_PATTERN.source})`;
  }
  const provider = record.provider;
  if (typeof provider !== "string" || !PROVIDER_PATTERN.test(provider)) {
    return `has "provider" ${JSON.stringify(provider)}, which is not a lowercase provider slug`;
  }
  return null;
}

/** A binding this build can match on. */
export function isKnownBinding(binding: TelemetryBinding): binding is KnownBinding {
  return bindingProblem(binding) === null;
}

/** The stored entries that are neither usable nor from a newer build, with why. */
export function invalidBindings(config: TelemetryConfig): Array<{ index: number; problem: string }> {
  return config.bindings.flatMap((binding, index) => {
    const problem = bindingProblem(binding);
    return problem === null || problem === "unknown_source" ? [] : [{ index, problem }];
  });
}

/** The source and directory a stored entry names, when it names both, usable or not. */
export function bindingKeyParts(binding: TelemetryBinding): { source: string; dir: string } | null {
  const record = asRecord(binding);
  if (record === null || typeof record.source !== "string") return null;
  const dir = record.source === "claude_code_statusline" ? record.configDir : record.source === "codex_rollout" ? record.home : undefined;
  return typeof dir === "string" && dir.trim() !== "" ? { source: record.source, dir } : null;
}

/** Validate a stored `telemetry` value at the read or write boundary. */
export function validateTelemetryConfig(value: unknown, where: string): TelemetryConfig {
  const record = asRecord(value);
  if (record === null) {
    throw new StapleError("validation", `${where}: "telemetry" must be a JSON object`);
  }
  const budgetCapture = record.budgetCapture ?? false;
  if (typeof budgetCapture !== "boolean") {
    throw new StapleError("validation", `${where}: "telemetry.budgetCapture" must be true or false`);
  }
  const bindings = record.bindings ?? [];
  if (!Array.isArray(bindings)) {
    throw new StapleError("validation", `${where}: "telemetry.bindings" must be an array`);
  }
  return { ...record, budgetCapture, bindings: [...bindings] };
}
