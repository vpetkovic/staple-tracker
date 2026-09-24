/**
 * Which account a reading belongs to (docs/execution-telemetry.md, "Source bindings
 * produce the account").
 *
 * The status-line JSON has no account field and a rollout line has only a plan name, so
 * the account never comes from the input. It comes from a machine-local binding keyed by
 * the harness's own home: `CLAUDE_CONFIG_DIR` (or `~/.claude`) for Claude Code, which is
 * how one machine runs two Claude accounts, and the Codex home that contains the rollout
 * file (`CODEX_HOME`, or `~/.codex`). `--account` overrides the binding. With neither,
 * ingestion is refused with `validation` naming the missing binding, and nothing is
 * stored under a guessed account.
 */
import { existsSync, realpathSync } from "node:fs";
import { userHome } from "../../config/home.js";
import { join, resolve, sep } from "node:path";
import { StapleError } from "../types.js";
import {
  bindingKeyParts,
  invalidBindings,
  isKnownBinding,
  type BindingSource,
  type KnownBinding,
  type TelemetryConfig,
} from "./config.js";
import { assertAccountRef, assertProvider } from "./formats.js";

/** The provider a source reports for when neither a binding nor a flag names one. */
export const SOURCE_PROVIDER: Readonly<Record<BindingSource, string>> = {
  claude_code_statusline: "anthropic",
  codex_rollout: "openai",
};

/** How the account was decided, mirroring an attempt's `providerBinding.source`. */
export type AccountSource = "flag" | "machine_binding";

export interface ResolvedAccount {
  readonly provider: string;
  readonly accountRef: string;
  readonly accountSource: AccountSource;
}

/** `~` and `~/…` expanded against the OS home, then made absolute. */
export function expandHomePath(path: string): string {
  const expanded = path === "~" ? userHome() : path.startsWith(`~${sep}`) || path.startsWith("~/") ? join(userHome(), path.slice(2)) : path;
  return resolve(expanded);
}

/** A path with symlinks resolved when it exists, so `/var` and `/private/var` agree. */
function canonical(path: string): string {
  const absolute = expandHomePath(path);
  try {
    return existsSync(absolute) ? realpathSync(absolute) : absolute;
  } catch {
    return absolute;
  }
}

/** The Claude Code config directory a status-line process inherits. */
export function claudeConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CLAUDE_CONFIG_DIR;
  return fromEnv !== undefined && fromEnv !== "" ? expandHomePath(fromEnv) : join(userHome(), ".claude");
}

/** The Codex home a binding defaults to. */
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env.CODEX_HOME;
  return fromEnv !== undefined && fromEnv !== "" ? expandHomePath(fromEnv) : join(userHome(), ".codex");
}

function knownBindings(config: TelemetryConfig, source: BindingSource): KnownBinding[] {
  return config.bindings.filter(isKnownBinding).filter((binding) => binding.source === source);
}

/** The binding for a Claude Code config directory, if one is configured. */
export function claudeBindingFor(config: TelemetryConfig, configDir: string): KnownBinding | null {
  const target = canonical(configDir);
  return (
    knownBindings(config, "claude_code_statusline").find(
      (binding) => binding.source === "claude_code_statusline" && canonical(binding.configDir) === target,
    ) ?? null
  );
}

/** The binding whose Codex home contains the file; the deepest home wins. */
export function codexBindingFor(config: TelemetryConfig, file: string): KnownBinding | null {
  const target = canonical(file);
  let best: { binding: KnownBinding; depth: number } | null = null;
  for (const binding of knownBindings(config, "codex_rollout")) {
    if (binding.source !== "codex_rollout") continue;
    const home = canonical(binding.home);
    if (target === home || target.startsWith(home.endsWith(sep) ? home : `${home}${sep}`)) {
      if (best === null || home.length > best.depth) best = { binding, depth: home.length };
    }
  }
  return best?.binding ?? null;
}

/** The kept-but-unusable entry naming this Claude config directory, if any. */
export function invalidClaudeBindingFor(config: TelemetryConfig, configDir: string): { index: number; problem: string } | null {
  const target = canonical(configDir);
  for (const { index, problem } of invalidBindings(config)) {
    const parts = bindingKeyParts(config.bindings[index]);
    if (parts?.source === "claude_code_statusline" && canonical(parts.dir) === target) return { index, problem };
  }
  return null;
}

/** The kept-but-unusable entry whose Codex home contains the file, if any. */
export function invalidCodexBindingFor(config: TelemetryConfig, file: string): { index: number; problem: string } | null {
  const target = canonical(file);
  for (const { index, problem } of invalidBindings(config)) {
    const parts = bindingKeyParts(config.bindings[index]);
    if (parts?.source !== "codex_rollout") continue;
    const home = canonical(parts.dir);
    if (target === home || target.startsWith(home.endsWith(sep) ? home : `${home}${sep}`)) return { index, problem };
  }
  return null;
}

/**
 * Decide the account for one ingestion. `--account` wins over the binding, and the
 * provider comes from `--provider`, then the binding, then the source's own provider.
 */
export function resolveAccount(input: {
  readonly source: BindingSource;
  readonly binding: KnownBinding | null;
  readonly account?: string;
  readonly provider?: string;
  /** What the refusal names: the config directory or the rollout file that found no binding. */
  readonly lookedUp: string;
  /** A stored entry for this home that is kept but unusable, so the refusal can point at it. */
  readonly invalidBinding?: { readonly index: number; readonly problem: string } | null;
}): ResolvedAccount {
  const provider = assertProvider(input.provider ?? input.binding?.provider ?? SOURCE_PROVIDER[input.source], "--provider");
  if (input.account !== undefined) {
    return { provider, accountRef: assertAccountRef(input.account, "--account"), accountSource: "flag" };
  }
  if (input.binding !== null) {
    return { provider, accountRef: input.binding.accountRef, accountSource: "machine_binding" };
  }
  const key = input.source === "claude_code_statusline" ? `config directory ${input.lookedUp}` : `a Codex home containing ${input.lookedUp}`;
  const flag = input.source === "claude_code_statusline" ? "--config-dir" : "--codex-home";
  const bind = `\`staple budget bind --source ${input.source === "claude_code_statusline" ? "claude-statusline" : "codex-rollout"} --account <label> [${flag} <dir>]\``;
  const invalid = input.invalidBinding ?? null;
  throw new StapleError(
    "validation",
    invalid !== null
      ? `No usable ${input.source} binding matches ${key}: telemetry.bindings[${invalid.index}] names it but ${invalid.problem}, ` +
          `so it is kept and not used, and nothing was stored under a guessed account. Re-bind with ${bind} to replace it, or pass --account.`
      : `No ${input.source} binding matches ${key}, and no --account was passed, so nothing was stored under a guessed account. ` +
          `Bind it once with ${bind}, or pass --account.`,
    {
      reason: "no_binding_configured",
      source: input.source,
      lookedUp: input.lookedUp,
      ...(invalid !== null ? { invalidBinding: invalid } : {}),
    },
  );
}
