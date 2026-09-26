/**
 * Automatic budget collection after ONE explicit consent (docs/execution-telemetry.md,
 * "Automatic collection").
 *
 * One method per action, each with a typed result, called by `staple budget
 * setup|unsetup|status|collect` and by the UI server's `/api/budget/collection` routes:
 *
 *   - {@link planBudgetSetup}: what setup would change. Reads only.
 *   - {@link applyBudgetSetup}: capture on, the two bindings, the Claude status-line
 *     wrapper and the Codex watcher, each only when it is not already so.
 *   - {@link planBudgetUnsetup} / {@link applyBudgetUnsetup}: reverse exactly what setup
 *     did, from the record setup keeps (`telemetry/collection.json` in the staple home).
 *     Capture and a binding go back to what they were BEFORE setup, and only while they
 *     still hold what setup wrote: a later change by hand is left alone.
 *   - {@link budgetCollectionStatus}: capture, bindings, each source's newest reading,
 *     the wrapper and watcher state, and the problems among them.
 *   - {@link collectBudget}: one watcher run (`codex-collect.ts`).
 *
 * The consent is the call itself: nothing here is reached without `--yes` at the CLI or
 * `consent: true` in the request body. Everything is machine-local (the staple home, the
 * Claude config directory, `~/Library/LaunchAgents`) and nothing makes a network call.
 */
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic } from "../../../config/atomic.js";
import { readConfig } from "../../../config/file.js";
import { userHome as osUserHome } from "../../../config/home.js";
import { defaultBinDir, launcherPath } from "../../../install/launcher.js";
import { StapleError } from "../../types.js";
import { bindBudgetSource, budgetConfig, setBudgetCapture, unbindBudgetSource } from "../budget-config.js";
import { SOURCE_PROVIDER, claudeConfigDir, codexHome, expandHomePath } from "../bindings.js";
import { isKnownBinding, type BindingSource, type KnownBinding, type TelemetryConfig } from "../config.js";
import { assertAccountRef } from "../formats.js";
import type { AttemptLinker } from "../ingest.js";
import { lastReadingsBySource, type SourceLastReading } from "../read-budget.js";
import { collectCodexRollouts, readCursor, type CollectResult, type CollectRunSummary } from "./codex-collect.js";
import {
  DEFAULT_INTERVAL_MINUTES,
  agentLoaded,
  agentPlist,
  agentPlistPath,
  cronLine,
  installAgent,
  plistIntervalMinutes,
  realLaunchctl,
  uninstallAgent,
  type LaunchctlRunner,
} from "./launchd.js";
import {
  installStatusline,
  planStatuslineInstall,
  planStatuslineRemoval,
  readSettingsState,
  settingsPathFor,
  uninstallStatusline,
  type StatuslineInstall,
} from "./statusline.js";

// ------------------------------------------------------------------ dependencies

export interface CollectionDeps {
  /** The staple home: `config.json`, `hub.db`, and the collection's own state. */
  readonly home: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly now?: () => string;
  /** The OS user's home, for `~/Library/LaunchAgents` and the agent's `HOME`. */
  readonly userHome?: string;
  readonly launchAgentsDir?: string;
  readonly launchctl?: LaunchctlRunner;
  readonly uid?: number;
  /** The installed staple launcher; null when there is none. Defaults to `~/.local/bin/staple` when it exists. */
  readonly staple?: string | null;
  readonly nodePath?: string;
  readonly attemptLinker?: AttemptLinker;
}

interface Resolved {
  readonly home: string;
  readonly env: NodeJS.ProcessEnv;
  readonly platform: NodeJS.Platform;
  readonly now: () => string;
  readonly userHome: string;
  readonly plistPath: string;
  readonly launchctl: LaunchctlRunner;
  readonly uid: number;
  readonly staple: string | null;
  readonly nodePath: string;
  readonly attemptLinker?: AttemptLinker;
}

function resolveDeps(deps: CollectionDeps): Resolved {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const home = deps.userHome ?? osUserHome();
  let staple = deps.staple;
  if (staple === undefined) {
    const installed = launcherPath(defaultBinDir({ home, platform, env }), { platform });
    staple = existsSync(installed) ? installed : null;
  }
  return {
    home: deps.home,
    env,
    platform,
    now: deps.now ?? (() => new Date().toISOString()),
    userHome: home,
    plistPath: agentPlistPath(deps.launchAgentsDir ?? join(home, "Library", "LaunchAgents")),
    launchctl: deps.launchctl ?? realLaunchctl,
    uid: deps.uid ?? (typeof process.getuid === "function" ? process.getuid() : 0),
    staple,
    nodePath: deps.nodePath ?? process.execPath,
    attemptLinker: deps.attemptLinker,
  };
}

const agentLogPath = (home: string): string => join(home, "logs", "budget-collect.agent.log");
const backupDir = (home: string): string => join(home, "backups", "claude-settings");

// ------------------------------------------------------------------ the setup record

export interface BindingChange {
  readonly source: BindingSource;
  readonly dir: string;
  /** The binding for this home before the first setup, or null when there was none. */
  readonly before: KnownBinding | null;
  readonly after: KnownBinding;
}

export interface SetupRecord {
  readonly version: 1;
  readonly setupAt: string;
  /** Set when setup turned capture on: what it was before. */
  readonly capture: { readonly before: boolean } | null;
  readonly bindings: readonly BindingChange[];
  readonly statusline: StatuslineInstall | null;
  readonly watcher: { readonly plistPath: string; readonly intervalMinutes: number; readonly installedAt: string } | null;
}

export function setupRecordPath(home: string): string {
  return join(home, "telemetry", "collection.json");
}

export function readSetupRecord(home: string): SetupRecord | null {
  const path = setupRecordPath(home);
  if (!existsSync(path)) return null;
  let parsed: SetupRecord;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as SetupRecord;
  } catch (error) {
    throw new StapleError("validation", `${path} is not valid JSON (${(error as Error).message}); staple will not guess what setup changed. Move it aside to continue.`);
  }
  if (parsed?.version !== 1) {
    throw new StapleError("validation", `${path} has version ${JSON.stringify(parsed?.version)}, which this staple does not read; a newer staple wrote it.`);
  }
  return parsed;
}

function writeSetupRecord(home: string, record: SetupRecord): void {
  mkdirSync(join(home, "telemetry"), { recursive: true, mode: 0o700 });
  writeFileAtomic(setupRecordPath(home), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
}

// ------------------------------------------------------------------ plans

export type StepPart = "capture" | "claude_binding" | "codex_binding" | "statusline" | "watcher" | "record";
/** `change`: will be done. `unchanged`: already so. `skip`: not done, with why. `refuse`: blocks the whole action. */
export type StepAction = "change" | "unchanged" | "skip" | "refuse";

export interface PlanStep {
  readonly part: StepPart;
  readonly action: StepAction;
  readonly summary: string;
  /** The file the step writes, when it writes one outside the staple home. */
  readonly path: string | null;
  /** What the step acts on: the harness home of a binding, the Claude config directory of a wrapper. */
  readonly target?: string;
}

export interface CollectionPlan {
  readonly action: "setup" | "unsetup";
  readonly steps: readonly PlanStep[];
  readonly changes: number;
  readonly refusals: number;
  readonly platform: NodeJS.Platform;
}

export interface SetupOptions {
  readonly claudeAccount?: string;
  readonly codexAccount?: string;
  readonly claudeConfigDir?: string;
  readonly codexHome?: string;
  /** False: leave the Claude status line alone. */
  readonly statusline?: boolean;
  /** False: install no watcher. */
  readonly watcher?: boolean;
  readonly intervalMinutes?: number;
}

function plan(action: CollectionPlan["action"], platform: NodeJS.Platform, steps: PlanStep[]): CollectionPlan {
  return {
    action,
    steps,
    changes: steps.filter((step) => step.action === "change").length,
    refusals: steps.filter((step) => step.action === "refuse").length,
    platform,
  };
}

function bindingFor(telemetry: TelemetryConfig, source: BindingSource, dir: string): KnownBinding | null {
  const key = expandHomePath(dir);
  return (
    telemetry.bindings
      .filter(isKnownBinding)
      .find((binding) => binding.source === source && expandHomePath(binding.source === "claude_code_statusline" ? binding.configDir : binding.home) === key) ?? null
  );
}

function intervalOf(options: SetupOptions): number {
  const minutes = options.intervalMinutes ?? DEFAULT_INTERVAL_MINUTES;
  if (!Number.isFinite(minutes) || minutes < 1 || minutes > 1440) {
    throw new StapleError("validation", `The watcher interval must be 1 to 1440 minutes; got ${String(options.intervalMinutes)}.`);
  }
  return minutes;
}

interface SetupTargets {
  readonly claudeDir: string;
  readonly codexDir: string;
  readonly claudeAccount: string | null;
  readonly codexAccount: string | null;
  readonly intervalMinutes: number;
}

function setupTargets(options: SetupOptions, r: Resolved, telemetry: TelemetryConfig): SetupTargets {
  const claudeDir = options.claudeConfigDir !== undefined ? expandHomePath(options.claudeConfigDir) : claudeConfigDir(r.env);
  const codexDir = options.codexHome !== undefined ? expandHomePath(options.codexHome) : codexHome(r.env);
  const claudeAccount =
    options.claudeAccount !== undefined ? assertAccountRef(options.claudeAccount, "--claude-account") : (bindingFor(telemetry, "claude_code_statusline", claudeDir)?.accountRef ?? null);
  const codexAccount = options.codexAccount !== undefined ? assertAccountRef(options.codexAccount, "--codex-account") : (bindingFor(telemetry, "codex_rollout", codexDir)?.accountRef ?? null);
  if (claudeAccount === null && codexAccount === null) {
    throw new StapleError(
      "validation",
      `Nothing to set up: no account is named and neither ${claudeDir} nor ${codexDir} is bound. Pass --claude-account and/or --codex-account: the label of the account each harness spends from.`,
      { reason: "no_account" },
    );
  }
  return { claudeDir, codexDir, claudeAccount, codexAccount, intervalMinutes: intervalOf(options) };
}

function agentPlistFor(r: Resolved, intervalMinutes: number): string {
  return agentPlist({
    staple: r.staple!,
    nodePath: r.nodePath,
    userHome: r.userHome,
    stapleHomeEnv: r.env.STAPLE_HOME !== undefined && r.env.STAPLE_HOME !== "" ? r.home : null,
    intervalMinutes,
    logPath: agentLogPath(r.home),
  });
}

function watcherStep(r: Resolved, intervalMinutes: number): PlanStep {
  if (r.platform !== "darwin") {
    return {
      part: "watcher",
      action: "skip",
      summary: `No launch agent on ${r.platform}. Schedule the collector yourself, e.g. with crontab -e: ${cronLine(r.staple ?? "staple", intervalMinutes)}`,
      path: null,
    };
  }
  if (r.staple === null) {
    return {
      part: "watcher",
      action: "skip",
      summary: "No installed staple launcher (~/.local/bin/staple) for the agent to run; `staple install --yes` first, then re-run setup.",
      path: null,
    };
  }
  const wanted = agentPlistFor(r, intervalMinutes);
  const present = existsSync(r.plistPath);
  const same = present && readFileSync(r.plistPath, "utf8") === wanted;
  if (same && agentLoaded({ uid: r.uid, launchctl: r.launchctl, plistPath: r.plistPath })) {
    return { part: "watcher", action: "unchanged", summary: `The Codex watcher runs every ${intervalMinutes} min (${r.plistPath}).`, path: r.plistPath };
  }
  return {
    part: "watcher",
    action: "change",
    summary: `${present ? "Rewrite and reload" : "Install and load"} a launch agent that runs \`${r.staple} budget collect\` every ${intervalMinutes} min, logging to ${agentLogPath(r.home)}.`,
    path: r.plistPath,
  };
}

/** What `setup` would change, and nothing else. */
export function planBudgetSetup(options: SetupOptions, deps: CollectionDeps): CollectionPlan {
  const r = resolveDeps(deps);
  const telemetry = readConfig(r.home).config.telemetry;
  const t = setupTargets(options, r, telemetry);
  const steps: PlanStep[] = [];
  steps.push(
    telemetry.budgetCapture
      ? { part: "capture", action: "unchanged", summary: "Budget capture is already on.", path: null }
      : { part: "capture", action: "change", summary: "Turn budget capture on (`telemetry.budgetCapture` in config.json).", path: null },
  );

  const bindingStep = (part: "claude_binding" | "codex_binding", source: BindingSource, dir: string, account: string | null, flag: string): void => {
    if (account === null) {
      steps.push({ part, action: "skip", summary: `No account for ${dir}: pass ${flag} to collect from it.`, path: null, target: dir });
      return;
    }
    const existing = bindingFor(telemetry, source, dir);
    if (existing?.accountRef === account) steps.push({ part, action: "unchanged", summary: `${dir} is bound to ${account}.`, path: null, target: dir });
    else {
      steps.push({
        part,
        action: "change",
        summary: `Bind ${dir} to ${account} (${SOURCE_PROVIDER[source]})${existing !== null ? `, replacing ${existing.accountRef}` : ""}.`,
        path: null,
        target: dir,
      });
    }
  };

  bindingStep("claude_binding", "claude_code_statusline", t.claudeDir, t.claudeAccount, "--claude-account");
  if (options.statusline === false) steps.push({ part: "statusline", action: "skip", summary: "--no-statusline: the Claude status line is left alone.", path: null });
  else if (t.claudeAccount === null) steps.push({ part: "statusline", action: "skip", summary: "No Claude account, so no status-line wrapper.", path: null });
  else {
    const status = planStatuslineInstall({ configDir: t.claudeDir, staple: r.staple ?? "staple" });
    const action: StepAction = status.action === "install" ? "change" : status.action === "refuse" ? "refuse" : "unchanged";
    const backup = status.action === "install" && existsSync(status.settingsPath) ? ` A copy is kept in ${backupDir(r.home)} first.` : "";
    const current = status.currentCommand !== null && status.action === "install" ? ` Wrapped command: ${status.currentCommand}` : "";
    steps.push({ part: "statusline", action, summary: `${status.reason}${backup}${current}`, path: status.settingsPath, target: t.claudeDir });
  }

  bindingStep("codex_binding", "codex_rollout", t.codexDir, t.codexAccount, "--codex-account");
  if (options.watcher === false) steps.push({ part: "watcher", action: "skip", summary: "--no-watcher: no Codex watcher is installed; `staple budget collect` still runs by hand.", path: null });
  else if (t.codexAccount === null) steps.push({ part: "watcher", action: "skip", summary: "No Codex account, so no watcher.", path: null });
  else steps.push(watcherStep(r, t.intervalMinutes));
  return plan("setup", r.platform, steps);
}

export interface CollectionOutcome {
  readonly plan: CollectionPlan;
  /** The steps that were carried out, in order. */
  readonly applied: readonly PlanStep[];
  readonly status: CollectionStatus;
}

function refuseWith(result: CollectionPlan): never {
  const refused = result.steps.filter((step) => step.action === "refuse");
  throw new StapleError("validation", `${result.action} refused, nothing was changed: ${refused.map((step) => step.summary).join(" ")}`, {
    reason: "plan_refused",
    plan: result,
  });
}

/** Carry out setup. Refused, with nothing changed, when any step of the plan is. */
export function applyBudgetSetup(options: SetupOptions, deps: CollectionDeps): CollectionOutcome {
  const r = resolveDeps(deps);
  const result = planBudgetSetup(options, deps);
  if (result.refusals > 0) refuseWith(result);
  const telemetry = readConfig(r.home).config.telemetry;
  const t = setupTargets(options, r, telemetry);
  const previous = readSetupRecord(r.home);
  let record: SetupRecord = previous ?? { version: 1, setupAt: r.now(), capture: null, bindings: [], statusline: null, watcher: null };
  const save = (next: SetupRecord): void => {
    record = next;
    writeSetupRecord(r.home, record);
  };
  const applied: PlanStep[] = [];

  for (const step of result.steps) {
    if (step.action !== "change") continue;
    switch (step.part) {
      case "capture": {
        setBudgetCapture(r.home, true);
        save({ ...record, capture: record.capture ?? { before: false } });
        break;
      }
      case "claude_binding":
      case "codex_binding": {
        const source: BindingSource = step.part === "claude_binding" ? "claude_code_statusline" : "codex_rollout";
        const dir = source === "claude_code_statusline" ? t.claudeDir : t.codexDir;
        const account = (source === "claude_code_statusline" ? t.claudeAccount : t.codexAccount)!;
        const before = bindingFor(readConfig(r.home).config.telemetry, source, dir);
        const view = bindBudgetSource(r.home, { source, account, configDir: source === "claude_code_statusline" ? dir : undefined, codexHome: source === "codex_rollout" ? dir : undefined }, r.env);
        const after = view.bindings.find((binding) => binding.source === source && expandHomePath(binding.source === "claude_code_statusline" ? binding.configDir : binding.home) === dir)!;
        const earlier = record.bindings.find((change) => change.source === source && change.dir === dir);
        save({
          ...record,
          bindings: [...record.bindings.filter((change) => change !== earlier), { source, dir, before: earlier !== undefined ? earlier.before : before, after }],
        });
        break;
      }
      case "statusline": {
        const installed = installStatusline({ configDir: t.claudeDir, staple: r.staple ?? "staple", backupDir: backupDir(r.home), now: r.now() });
        if (installed !== null) save({ ...record, statusline: installed });
        break;
      }
      case "watcher": {
        installAgent({ plistPath: r.plistPath, plist: agentPlistFor(r, t.intervalMinutes), uid: r.uid, launchctl: r.launchctl });
        save({ ...record, watcher: { plistPath: r.plistPath, intervalMinutes: t.intervalMinutes, installedAt: r.now() } });
        break;
      }
      case "record":
        break;
    }
    applied.push(step);
  }
  return { plan: result, applied, status: budgetCollectionStatus(deps) };
}

function sameBinding(a: KnownBinding | null, b: KnownBinding | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** The Claude config directories unsetup looks in: the recorded one, every bound one, and the default. */
function claudeDirsToCheck(r: Resolved, record: SetupRecord | null, telemetry: TelemetryConfig): string[] {
  const dirs = [
    ...(record?.statusline ? [record.statusline.configDir] : []),
    ...telemetry.bindings.filter(isKnownBinding).flatMap((binding) => (binding.source === "claude_code_statusline" ? [expandHomePath(binding.configDir)] : [])),
    claudeConfigDir(r.env),
  ];
  return dirs.filter((dir, i) => dirs.indexOf(dir) === i);
}

/** What `unsetup` would change, and nothing else. */
export function planBudgetUnsetup(deps: CollectionDeps): CollectionPlan {
  const r = resolveDeps(deps);
  const telemetry = readConfig(r.home).config.telemetry;
  const record = readSetupRecord(r.home);
  const steps: PlanStep[] = [];

  const wrapperSteps = claudeDirsToCheck(r, record, telemetry).flatMap((dir): PlanStep[] => {
    const removal = planStatuslineRemoval({ configDir: dir, record: record?.statusline?.configDir === dir ? record.statusline : null });
    if (removal.action === "not_installed") return [];
    return [
      {
        part: "statusline",
        action: removal.action === "refuse" ? "refuse" : "change",
        summary: removal.action === "restore" ? `Restore the original status-line command: ${removal.restoredCommand}` : removal.reason,
        path: removal.settingsPath,
        target: dir,
      },
    ];
  });
  steps.push(...(wrapperSteps.length > 0 ? wrapperSteps : [{ part: "statusline" as const, action: "unchanged" as const, summary: "No staple status-line wrapper is installed.", path: null }]));

  if (r.platform === "darwin" && (existsSync(r.plistPath) || agentLoaded({ uid: r.uid, launchctl: r.launchctl, plistPath: r.plistPath }))) {
    steps.push({ part: "watcher", action: "change", summary: `Unload and delete the Codex watcher (${r.plistPath}).`, path: r.plistPath });
  } else steps.push({ part: "watcher", action: "unchanged", summary: "No Codex watcher is installed.", path: null });

  if (record === null) {
    steps.push({
      part: "record",
      action: "skip",
      summary: "No setup record, so capture and bindings are left as they are (`staple budget capture off`, `staple budget unbind` change them).",
      path: null,
    });
    return plan("unsetup", r.platform, steps);
  }
  for (const change of record.bindings) {
    const part = change.source === "claude_code_statusline" ? "claude_binding" : "codex_binding";
    const current = bindingFor(telemetry, change.source, change.dir);
    if (!sameBinding(current, change.after)) {
      steps.push({ part, action: "skip", summary: `${change.dir} was re-bound after setup; left as it is.`, path: null, target: change.dir });
    } else if (change.before === null) {
      steps.push({ part, action: "change", summary: `Unbind ${change.dir} (it had no binding before setup).`, path: null, target: change.dir });
    } else {
      steps.push({ part, action: "change", summary: `Bind ${change.dir} back to ${change.before.accountRef}, as before setup.`, path: null, target: change.dir });
    }
  }
  if (record.capture?.before === false && telemetry.budgetCapture) {
    steps.push({ part: "capture", action: "change", summary: "Turn budget capture off, as it was before setup. Readings already stored are kept.", path: null });
  } else {
    steps.push({ part: "capture", action: "unchanged", summary: `Budget capture stays ${telemetry.budgetCapture ? "on" : "off"}${record.capture === null ? " (setup did not change it)" : ""}.`, path: null });
  }
  steps.push({ part: "record", action: "change", summary: `Delete the setup record ${setupRecordPath(r.home)}.`, path: null });
  return plan("unsetup", r.platform, steps);
}

/** Reverse setup. Refused, with nothing changed, when any step of the plan is. */
export function applyBudgetUnsetup(deps: CollectionDeps): CollectionOutcome {
  const r = resolveDeps(deps);
  const result = planBudgetUnsetup(deps);
  if (result.refusals > 0) refuseWith(result);
  const record = readSetupRecord(r.home);
  const applied: PlanStep[] = [];
  for (const step of result.steps) {
    if (step.action !== "change") continue;
    switch (step.part) {
      case "statusline": {
        const dir = step.target!;
        uninstallStatusline({ configDir: dir, record: record?.statusline?.configDir === dir ? record.statusline : null, backupDir: backupDir(r.home), now: r.now() });
        break;
      }
      case "watcher":
        uninstallAgent({ plistPath: r.plistPath, uid: r.uid, launchctl: r.launchctl });
        break;
      case "claude_binding":
      case "codex_binding": {
        const source: BindingSource = step.part === "claude_binding" ? "claude_code_statusline" : "codex_rollout";
        const change = record!.bindings.find((candidate) => candidate.source === source && candidate.dir === step.target)!;
        const dirFlag = source === "claude_code_statusline" ? { configDir: change.dir } : { codexHome: change.dir };
        if (change.before === null) unbindBudgetSource(r.home, { source, ...dirFlag }, r.env);
        else bindBudgetSource(r.home, { source, account: change.before.accountRef, provider: change.before.provider, ...dirFlag }, r.env);
        break;
      }
      case "capture":
        setBudgetCapture(r.home, false);
        break;
      case "record":
        rmSync(setupRecordPath(r.home), { force: true });
        break;
    }
    applied.push(step);
  }
  return { plan: result, applied, status: budgetCollectionStatus(deps) };
}

// ------------------------------------------------------------------ status

export type StatuslineState = "installed" | "hand_wrapped" | "not_installed" | "missing_file" | "invalid_json" | "unsupported";

export interface CollectionProblem {
  readonly code: string;
  readonly message: string;
}

export interface SourceStatus {
  readonly source: BindingSource;
  readonly dir: string;
  readonly provider: string;
  readonly accountRef: string;
  readonly lastReading: (Pick<SourceLastReading, "observedAt" | "recordedAt" | "sampleCount"> & { readonly ageSeconds: number }) | null;
}

export interface StatuslineStatus {
  readonly configDir: string;
  readonly settingsPath: string;
  readonly state: StatuslineState;
  /** True when setup's record says it installed a wrapper here. */
  readonly recorded: boolean;
  readonly backupPath: string | null;
}

export interface WatcherStatus {
  /** A launch agent exists only on macOS. */
  readonly supported: boolean;
  readonly plistPath: string | null;
  readonly installed: boolean;
  /** Null where there is no launchd. */
  readonly loaded: boolean | null;
  readonly intervalMinutes: number | null;
  readonly lastRun: CollectRunSummary | null;
  readonly lastRunAgeSeconds: number | null;
  readonly lastError: { readonly at: string; readonly message: string } | null;
  readonly logPath: string;
  /** The schedule to add by hand where there is no agent. */
  readonly cronLine: string | null;
}

export interface CollectionStatus {
  readonly budgetCapture: boolean;
  readonly platform: NodeJS.Platform;
  readonly bindings: readonly KnownBinding[];
  readonly sources: readonly SourceStatus[];
  readonly statusline: readonly StatuslineStatus[];
  readonly watcher: WatcherStatus;
  readonly setup: { readonly recorded: boolean; readonly setupAt: string | null; readonly path: string };
  readonly problems: readonly CollectionProblem[];
}

const ageSeconds = (now: string, then: string): number => Math.max(0, Math.round((Date.parse(now) - Date.parse(then)) / 1000));

export function budgetCollectionStatus(deps: CollectionDeps): CollectionStatus {
  const r = resolveDeps(deps);
  const now = r.now();
  const config = budgetConfig(r.home);
  let record: SetupRecord | null = null;
  const problems: CollectionProblem[] = [];
  try {
    record = readSetupRecord(r.home);
  } catch (error) {
    problems.push({ code: "setup_record_unreadable", message: (error as Error).message });
  }
  if (!config.budgetCapture) problems.push({ code: "capture_off", message: "Budget capture is off; nothing is collected (`staple budget setup` or `staple budget capture on`)." });
  if (config.bindings.length === 0) problems.push({ code: "no_binding", message: "No harness home is bound to an account; readings have nowhere to go." });
  for (const invalid of config.invalidBindings) problems.push({ code: "invalid_binding", message: `telemetry.bindings[${invalid.index}] ${invalid.problem}; kept, not used.` });

  const readings = lastReadingsBySource(r.home);
  const sources = config.bindings.map((binding): SourceStatus => {
    const found = readings.find((row) => row.provider === binding.provider && row.accountRef === binding.accountRef && row.sourceKind === binding.source);
    const dir = expandHomePath(binding.source === "claude_code_statusline" ? binding.configDir : binding.home);
    if (found === undefined && config.budgetCapture) {
      problems.push({ code: "no_reading", message: `No ${binding.source} reading for ${binding.accountRef} yet (${dir}).` });
    }
    return {
      source: binding.source,
      dir,
      provider: binding.provider,
      accountRef: binding.accountRef,
      lastReading: found === undefined ? null : { observedAt: found.observedAt, recordedAt: found.recordedAt, sampleCount: found.sampleCount, ageSeconds: ageSeconds(now, found.recordedAt) },
    };
  });

  const telemetry = readConfig(r.home).config.telemetry;
  const statusline = claudeDirsToCheck(r, record, telemetry)
    .map((configDir): StatuslineStatus => {
      const settingsPath = settingsPathFor(configDir);
      const state = readSettingsState(settingsPath);
      const mapped: StatuslineState =
        state.state === "command"
          ? state.kind === "staple"
            ? "installed"
            : state.kind === "hand_wrapped"
              ? "hand_wrapped"
              : "not_installed"
          : state.state === "no_statusline" || state.state === "not_an_object"
            ? "not_installed"
            : state.state;
      const recorded = record?.statusline?.configDir === configDir;
      return { configDir, settingsPath, state: mapped, recorded, backupPath: recorded ? record!.statusline!.backupPath : null };
    })
    .filter((entry) => entry.recorded || entry.state !== "missing_file" || config.bindings.some((b) => b.source === "claude_code_statusline" && expandHomePath(b.configDir) === entry.configDir));
  for (const entry of statusline) {
    const bound = config.bindings.some((b) => b.source === "claude_code_statusline" && expandHomePath(b.configDir) === entry.configDir);
    if (entry.recorded && entry.state !== "installed") {
      problems.push({ code: "statusline_removed", message: `staple's status-line wrapper was installed in ${entry.settingsPath} but the file no longer holds it (${entry.state}).` });
    } else if (entry.state === "invalid_json") {
      problems.push({ code: "statusline_invalid_json", message: `${entry.settingsPath} is not valid JSON.` });
    } else if (bound && entry.state !== "installed" && entry.state !== "hand_wrapped") {
      problems.push({ code: "statusline_not_installed", message: `${entry.configDir} is bound but its status line records nothing (\`staple budget setup\` installs the wrapper).` });
    }
  }

  const cursor = readCursor(r.home);
  const supported = r.platform === "darwin";
  const installed = supported && existsSync(r.plistPath);
  const loaded = supported ? agentLoaded({ uid: r.uid, launchctl: r.launchctl, plistPath: r.plistPath }) : null;
  const intervalMinutes = installed ? plistIntervalMinutes(r.plistPath) : (record?.watcher?.intervalMinutes ?? null);
  const lastRunAgeSeconds = cursor.lastRun === null ? null : ageSeconds(now, cursor.lastRun.at);
  const watcher: WatcherStatus = {
    supported,
    plistPath: supported ? r.plistPath : null,
    installed,
    loaded,
    intervalMinutes,
    lastRun: cursor.lastRun,
    lastRunAgeSeconds,
    lastError: cursor.lastError,
    logPath: join(r.home, "logs", "budget-collect.log"),
    cronLine: supported ? null : cronLine(r.staple ?? "staple", intervalMinutes ?? DEFAULT_INTERVAL_MINUTES),
  };
  const codexBound = config.bindings.some((binding) => binding.source === "codex_rollout");
  if (installed && loaded === false) problems.push({ code: "watcher_not_loaded", message: `${r.plistPath} exists but launchd has not loaded it (\`staple budget setup --yes\` reloads it).` });
  if (supported && !installed && loaded === true) problems.push({ code: "watcher_orphaned", message: "The watcher is loaded but its plist is gone; `staple budget unsetup --yes` unloads it." });
  if (supported && codexBound && !installed) problems.push({ code: "watcher_not_installed", message: "A Codex home is bound but no watcher collects its rollouts (`staple budget setup` installs one)." });
  if (installed && intervalMinutes !== null && lastRunAgeSeconds !== null && lastRunAgeSeconds > intervalMinutes * 60 * 3 + 60) {
    problems.push({ code: "watcher_stale", message: `The watcher last ran ${Math.round(lastRunAgeSeconds / 60)} min ago, for an interval of ${intervalMinutes} min; see ${agentLogPath(r.home)}.` });
  }
  if (cursor.lastError !== null) problems.push({ code: "collect_error", message: `Last collect (${cursor.lastError.at}): ${cursor.lastError.message}` });

  return {
    budgetCapture: config.budgetCapture,
    platform: r.platform,
    bindings: config.bindings,
    sources,
    statusline,
    watcher,
    setup: { recorded: record !== null, setupAt: record?.setupAt ?? null, path: setupRecordPath(r.home) },
    problems,
  };
}

// ------------------------------------------------------------------ collect

/** One watcher run: the new and grown Codex rollouts, bounded. */
export function collectBudget(options: { maxFiles?: number }, deps: CollectionDeps): CollectResult {
  const r = resolveDeps(deps);
  if (options.maxFiles !== undefined && (!Number.isInteger(options.maxFiles) || options.maxFiles < 1 || options.maxFiles > 10_000)) {
    throw new StapleError("validation", `--max-files must be a whole number from 1 to 10000; got ${String(options.maxFiles)}.`);
  }
  return collectCodexRollouts(r.home, { maxFiles: options.maxFiles, now: r.now, attemptLinker: r.attemptLinker, rotate: [agentLogPath(r.home)] });
}
