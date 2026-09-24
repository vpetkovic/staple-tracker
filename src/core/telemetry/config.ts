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
 * Pure: no file I/O here, so `config/file.ts` can validate through it without a cycle.
 * A binding for a source this build does not know, and any key this build does not know,
 * is preserved verbatim, the same forward-compatibility rule the rest of config.json
 * follows. Such a binding is never used for matching.
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

/** A binding as stored: a known one, or one from a newer build kept as it was written. */
export type TelemetryBinding = KnownBinding | Readonly<Record<string, unknown>>;

export interface TelemetryConfig {
  readonly budgetCapture: boolean;
  readonly bindings: readonly TelemetryBinding[];
  /** Keys a newer build wrote inside `telemetry`, kept for the next write. */
  readonly [key: string]: unknown;
}

export const DEFAULT_TELEMETRY: TelemetryConfig = Object.freeze({ budgetCapture: false, bindings: Object.freeze([]) });

export function isKnownBinding(binding: TelemetryBinding): binding is KnownBinding {
  return (BINDING_SOURCES as readonly unknown[]).includes((binding as { source?: unknown }).source);
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new StapleError("validation", `${where}: "${key}" must be a non-empty string`);
  }
  return value;
}

function validateBinding(value: unknown, where: string): TelemetryBinding {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StapleError("validation", `${where} must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const source = record.source;
  if (typeof source !== "string" || source === "") {
    throw new StapleError("validation", `${where}: "source" must be a non-empty string`);
  }
  if (!(BINDING_SOURCES as readonly string[]).includes(source)) return { ...record };
  const accountRef = requireString(record, "accountRef", where);
  if (!ACCOUNT_REF_PATTERN.test(accountRef)) {
    throw new StapleError("validation", `${where}: "accountRef" must match ${ACCOUNT_REF_PATTERN.source} (got "${accountRef}")`);
  }
  const provider = requireString(record, "provider", where);
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new StapleError("validation", `${where}: "provider" must be a lowercase provider slug (got "${provider}")`);
  }
  if (source === "claude_code_statusline") requireString(record, "configDir", where);
  else requireString(record, "home", where);
  return { ...record };
}

/** Validate a stored `telemetry` value at the read or write boundary. */
export function validateTelemetryConfig(value: unknown, where: string): TelemetryConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StapleError("validation", `${where}: "telemetry" must be a JSON object`);
  }
  const record = value as Record<string, unknown>;
  const budgetCapture = record.budgetCapture ?? false;
  if (typeof budgetCapture !== "boolean") {
    throw new StapleError("validation", `${where}: "telemetry.budgetCapture" must be true or false`);
  }
  const rawBindings = record.bindings ?? [];
  if (!Array.isArray(rawBindings)) {
    throw new StapleError("validation", `${where}: "telemetry.bindings" must be an array`);
  }
  const bindings = rawBindings.map((binding, index) => validateBinding(binding, `${where}: telemetry.bindings[${index}]`));
  return { ...record, budgetCapture, bindings };
}
