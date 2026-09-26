/**
 * The operator's side of budget capture: turning it on or off and binding a harness home
 * to an account label. Everything is written to `<home>/config.json` through
 * `updateConfig`, which refuses a corrupt or newer file rather than overwriting it.
 */
import { isAbsolute, sep } from "node:path";
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
 * Every refusal of a capture or binding write carries `detail.reason`, one of these, so a
 * surface that is not the CLI (the web Settings) can say what is wrong in its own words
 * without reading the sentence, which names CLI flags and stays the CLI's.
 */
export type BindingRefusalReason =
  | "invalid_source"
  | "invalid_account"
  | "invalid_provider"
  | "invalid_path"
  | "account_required"
  | "binding_not_found"
  | "home_taken";

function refuse(code: "validation" | "not_found" | "conflict", reason: BindingRefusalReason, message: string, field: string): never {
  throw new StapleError(code, message, { reason, field });
}

/**
 * A binding source as the operator spells it (`--source` at the CLI, `source` in the UI
 * server's binding routes): `claude-statusline` or `codex-rollout`. One parser, so the two
 * surfaces accept and refuse exactly the same words. `where` names the flag or field.
 */
export function parseBindingSource(raw: unknown, where = "--source"): BindingSource {
  if (raw === "claude-statusline") return "claude_code_statusline";
  if (raw === "codex-rollout") return "codex_rollout";
  refuse(
    "validation",
    "invalid_source",
    `${where} must be claude-statusline or codex-rollout for a binding; got ${raw === undefined || raw === null ? "nothing" : JSON.stringify(raw)}.`,
    where,
  );
}

/**
 * A harness home as written in a binding: an absolute path, or one starting at `~`. A
 * relative path would be stored as typed and then mean a different folder depending on
 * where the next command runs, so it is refused (at the CLI and in the web Settings alike).
 */
export function assertHomePath(value: string, where: string): string {
  if (value === "~" || value.startsWith("~/") || value.startsWith(`~${sep}`) || isAbsolute(value)) return value;
  refuse(
    "validation",
    "invalid_path",
    `${where} must be an absolute path or start with ~ (got ${JSON.stringify(value)}); a relative path would name a different folder from wherever staple runs next.`,
    where,
  );
}

/** The account label check, with the reason a surface can map. Same rule and sentence as `assertAccountRef`. */
export function accountOf(value: string, where: string): string {
  try {
    return assertAccountRef(value, where);
  } catch (error) {
    refuse("validation", "invalid_account", (error as Error).message, where);
  }
}

function providerOf(value: string, where: string): string {
  try {
    return assertProvider(value, where);
  } catch (error) {
    refuse("validation", "invalid_provider", (error as Error).message, where);
  }
}

/** The refusal of `bind` without an account, shared by the CLI and the UI server. */
export function accountRequired(): never {
  refuse("validation", "account_required", "budget bind needs --account: the label of the account this harness home spends from.", "--account");
}

/** The home of one binding: the source and its directory flag, defaulted as `bind` defaults it. */
export interface BindingHome {
  readonly source: BindingSource;
  /** claude_code_statusline: defaults to `CLAUDE_CONFIG_DIR`, then `~/.claude`. */
  readonly configDir?: string;
  /** codex_rollout: defaults to `CODEX_HOME`, then `~/.codex`. */
  readonly codexHome?: string;
}

/**
 * The directory of a binding home. A NEW value (the home a binding is written for) must be
 * absolute or start with `~`. A LOOKUP of an existing binding (unbind, the binding an edit
 * replaces) is not checked: a binding written by an older staple with a relative folder
 * must still be removable and editable.
 */
function homeDir(request: BindingHome, env: NodeJS.ProcessEnv, mode: "new" | "lookup"): string {
  const given = request.source === "claude_code_statusline" ? request.configDir : request.codexHome;
  if (given === undefined) return request.source === "claude_code_statusline" ? claudeConfigDir(env) : codexHome(env);
  return mode === "lookup" ? given : assertHomePath(given, request.source === "claude_code_statusline" ? "--config-dir" : "--codex-home");
}

export interface BindRequest extends BindingHome {
  readonly account: string;
  readonly provider?: string;
  /**
   * The binding this one replaces, when an existing binding is edited (the web Settings'
   * Edit; `--replace-source`/`--replace-dir` at the CLI). Removed in the same config write
   * that adds the new one, and the new one takes its place in the list. Refused, with
   * nothing written, when it is no longer there (`not_found`), and when the new home is a
   * different one that ANOTHER binding already holds (`conflict`): an edit never removes a
   * binding it was not asked to.
   */
  readonly replacing?: BindingHome;
}

/** Bind a harness home to an account. Re-binding the same home replaces its binding. */
export function bindBudgetSource(home: string, request: BindRequest, env: NodeJS.ProcessEnv = process.env): BudgetConfigView {
  const accountRef = accountOf(request.account, "--account");
  const provider = providerOf(request.provider ?? SOURCE_PROVIDER[request.source], "--provider");
  const dir = homeDir(request, env, "new");
  const binding: KnownBinding =
    request.source === "claude_code_statusline"
      ? { source: "claude_code_statusline", configDir: dir, provider, accountRef }
      : { source: "codex_rollout", home: dir, provider, accountRef };
  const telemetry = readConfig(home).config.telemetry;
  let at = telemetry.bindings.length;
  let kept = telemetry.bindings;
  if (request.replacing !== undefined) {
    const old = request.replacing;
    const oldDir = homeDir(old, env, "lookup");
    at = kept.findIndex((existing) => sameHome(existing, old.source, oldDir));
    if (at === -1) {
      refuse(
        "not_found",
        "binding_not_found",
        `No ${old.source} binding for ${expandHomePath(oldDir)} to replace; nothing was changed. \`staple budget bindings\` lists them.`,
        "--replace-dir",
      );
    }
    kept = kept.filter((_, index) => index !== at);
    const taken = kept.find((existing) => sameHome(existing, binding.source, dir));
    if (taken !== undefined) {
      refuse(
        "conflict",
        "home_taken",
        `${expandHomePath(dir)} already has its own ${binding.source} binding; editing another binding onto it would remove that one. Nothing was changed. Unbind it first, or edit that binding instead.`,
        binding.source === "claude_code_statusline" ? "--config-dir" : "--codex-home",
      );
    }
  }
  const before = kept.slice(0, at).filter((existing) => !sameHome(existing, binding.source, dir));
  const after = kept.slice(at).filter((existing) => !sameHome(existing, binding.source, dir));
  return view(updateConfig(home, { telemetry: { ...telemetry, bindings: [...before, binding, ...after] } }).telemetry);
}

/** Remove the binding for a harness home. Refused when there is none, so a typo is not silent. */
export function unbindBudgetSource(home: string, request: BindingHome, env: NodeJS.ProcessEnv = process.env): BudgetConfigView {
  const dir = homeDir(request, env, "lookup");
  const key = expandHomePath(dir);
  const telemetry = readConfig(home).config.telemetry;
  const bindings = telemetry.bindings.filter((existing) => !sameHome(existing, request.source, dir));
  if (bindings.length === telemetry.bindings.length) {
    refuse("not_found", "binding_not_found", `No ${request.source} binding for ${key}. \`staple budget bindings\` lists them.`, "--source");
  }
  return view(updateConfig(home, { telemetry: { ...telemetry, bindings } }).telemetry);
}
