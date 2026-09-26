/**
 * The operator's side of budget capture: turning it on or off and binding a harness home
 * to an account label. Everything is written to `<home>/config.json` through
 * `updateConfig`, which refuses a corrupt or newer file rather than overwriting it.
 */
import { readConfig, updateConfig } from "../../config/file.js";
import { StapleError } from "../types.js";
import { SOURCE_PROVIDER, claudeConfigDir, codexHome, expandHomePath } from "./bindings.js";
import {
  bindingKeyParts,
  bindingProblem,
  invalidBindings,
  isKnownBinding,
  type BindingSource,
  type KnownBinding,
  type TelemetryBinding,
  type TelemetryConfig,
} from "./config.js";
import { assertAccountRef, assertProvider } from "./formats.js";

export interface BudgetConfigView {
  readonly budgetCapture: boolean;
  readonly bindings: readonly KnownBinding[];
  /** Bindings for sources this build does not know, kept as written and never matched. */
  readonly unknownBindings: number;
  /** Bindings kept as written but never matched because a field is invalid, with why. */
  readonly invalidBindings: ReadonlyArray<{ index: number; problem: string }>;
}

function view(telemetry: TelemetryConfig): BudgetConfigView {
  const known = telemetry.bindings.filter(isKnownBinding);
  return {
    budgetCapture: telemetry.budgetCapture,
    bindings: known,
    unknownBindings: telemetry.bindings.filter((b) => bindingProblem(b) === "unknown_source").length,
    invalidBindings: invalidBindings(telemetry),
  };
}

export function budgetConfig(home: string): BudgetConfigView {
  return view(readConfig(home).config.telemetry);
}

export function setBudgetCapture(home: string, enabled: boolean): BudgetConfigView {
  const telemetry = readConfig(home).config.telemetry;
  return view(updateConfig(home, { telemetry: { ...telemetry, budgetCapture: enabled } }).telemetry);
}

/**
 * Whether a stored entry is the binding for this source and directory, usable or not, so
 * re-binding a home replaces a hand-broken entry for it and unbinding removes one.
 */
function sameHome(entry: TelemetryBinding, source: BindingSource, dir: string): boolean {
  const parts = bindingKeyParts(entry);
  return parts !== null && parts.source === source && expandHomePath(parts.dir) === expandHomePath(dir);
}

/**
 * A binding source as the operator spells it (`--source` at the CLI, `source` in the UI
 * server's binding routes): `claude-statusline` or `codex-rollout`. One parser, so the two
 * surfaces accept and refuse exactly the same words.
 */
export function parseBindingSource(raw: unknown): BindingSource {
  if (raw === "claude-statusline") return "claude_code_statusline";
  if (raw === "codex-rollout") return "codex_rollout";
  throw new StapleError(
    "validation",
    `--source must be claude-statusline or codex-rollout for a binding; got ${raw === undefined || raw === null ? "nothing" : JSON.stringify(raw)}.`,
  );
}

/** The home of one binding: the source and its directory flag, defaulted as `bind` defaults it. */
export interface BindingHome {
  readonly source: BindingSource;
  /** claude_code_statusline: defaults to `CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  readonly configDir?: string;
  /** codex_rollout: defaults to `CODEX_HOME`, then `~/.codex`. */
  readonly codexHome?: string;
}

function homeDir(request: BindingHome, env: NodeJS.ProcessEnv): string {
  return request.source === "claude_code_statusline" ? (request.configDir ?? claudeConfigDir(env)) : (request.codexHome ?? codexHome(env));
}

export interface BindRequest extends BindingHome {
  readonly account: string;
  readonly provider?: string;
  /**
   * The binding this one replaces, when an existing binding is edited to a different home
   * (the web Settings' Edit). Removed in the same config write that adds the new one, and
   * the new one takes its place in the list; refused, with nothing written, when it is no
   * longer there. Without it a binding for the same home is still replaced, as always.
   */
  readonly replacing?: BindingHome;
}

/** Bind a harness home to an account. Re-binding the same home replaces its binding. */
export function bindBudgetSource(home: string, request: BindRequest, env: NodeJS.ProcessEnv = process.env): BudgetConfigView {
  const accountRef = assertAccountRef(request.account, "--account");
  const provider = assertProvider(request.provider ?? SOURCE_PROVIDER[request.source], "--provider");
  const binding: KnownBinding =
    request.source === "claude_code_statusline"
      ? { source: "claude_code_statusline", configDir: request.configDir ?? claudeConfigDir(env), provider, accountRef }
      : { source: "codex_rollout", home: request.codexHome ?? codexHome(env), provider, accountRef };
  const telemetry = readConfig(home).config.telemetry;
  const dir = binding.source === "claude_code_statusline" ? binding.configDir : binding.home;
  let at = telemetry.bindings.length;
  let kept = telemetry.bindings;
  if (request.replacing !== undefined) {
    const old = request.replacing;
    const oldDir = homeDir(old, env);
    at = kept.findIndex((existing) => sameHome(existing, old.source, oldDir));
    if (at === -1) {
      throw new StapleError("not_found", `No ${old.source} binding for ${expandHomePath(oldDir)} to replace; nothing was changed. \`staple budget bindings\` lists them.`);
    }
    kept = kept.filter((_, index) => index !== at);
  }
  const before = kept.slice(0, at).filter((existing) => !sameHome(existing, binding.source, dir));
  const after = kept.slice(at).filter((existing) => !sameHome(existing, binding.source, dir));
  return view(updateConfig(home, { telemetry: { ...telemetry, bindings: [...before, binding, ...after] } }).telemetry);
}

/** Remove the binding for a harness home. Refused when there is none, so a typo is not silent. */
export function unbindBudgetSource(home: string, request: BindingHome, env: NodeJS.ProcessEnv = process.env): BudgetConfigView {
  const dir = homeDir(request, env);
  const key = expandHomePath(dir);
  const telemetry = readConfig(home).config.telemetry;
  const bindings = telemetry.bindings.filter((existing) => !sameHome(existing, request.source, dir));
  if (bindings.length === telemetry.bindings.length) {
    throw new StapleError("not_found", `No ${request.source} binding for ${key}. \`staple budget bindings\` lists them.`);
  }
  return view(updateConfig(home, { telemetry: { ...telemetry, bindings } }).telemetry);
}
