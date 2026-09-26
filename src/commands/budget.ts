/**
 * `staple budget` — provider budget telemetry (docs/execution-telemetry.md): ingesting
 * readings, the operator's opt-in and source bindings, and reading them back.
 * Machine-level: it reads and writes the staple home, never a workspace.
 *
 *   budget [--account A]                   each account's current windows (get_budget)
 *   budget history --account A [--since T] [--limit N] [--cursor C]   (list_budget_samples)
 *   budget ingest --source claude-statusline [--tee] [--account A] [--config-dir D]
 *   budget ingest --source codex-rollout <file> [--account A]
 *   budget ingest --source manual --account A --limit-key K --used P [--resets-at T] [--provider P]
 *   budget capture [on|off]
 *   budget bind --source claude-statusline|codex-rollout --account A [--provider P] [--config-dir D | --codex-home D]
 *   budget unbind --source claude-statusline|codex-rollout [--config-dir D | --codex-home D]
 *   budget bindings
 *   budget setup [--claude-account A] [--codex-account B] [--claude-config-dir D] [--codex-home D]
 *                [--no-statusline] [--no-watcher] [--interval MIN] [--yes]
 *   budget unsetup [--yes]
 *   budget status
 *   budget collect [--max-files N] [--quiet]
 *
 * `ingest` calls the same `ingestBudget` the MCP tool `record_budget_sample` calls; the
 * two reads call `readBudget` and `listBudgetSamples`, as `get_budget` and
 * `list_budget_samples` do. setup, unsetup, status and collect call the collection
 * service (`core/telemetry/collection/service.ts`), as the UI server's
 * `/api/budget/collection` routes do.
 */
import { readSync, writeSync } from "node:fs";
import { parseArgs } from "node:util";
import { stapleHome } from "../config/home.js";
import { StapleError } from "../core/types.js";
import {
  bindBudgetSource,
  budgetConfig,
  setBudgetCapture,
  unbindBudgetSource,
  type BudgetConfigView,
} from "../core/telemetry/budget-config.js";
import type { BindingSource } from "../core/telemetry/config.js";
import { INGEST_SOURCES, ingestBudget, type IngestResult, type IngestSource } from "../core/telemetry/ingest.js";
import { attemptLinkerFor } from "../core/telemetry/attempt-link.js";
import { listBudgetSamples, readBudget, type BudgetView, type HistorySample } from "../core/telemetry/read-budget.js";
import {
  applyBudgetSetup,
  applyBudgetUnsetup,
  budgetCollectionStatus,
  collectBudget,
  planBudgetSetup,
  planBudgetUnsetup,
  type CollectionOutcome,
  type CollectionPlan,
  type CollectionStatus,
} from "../core/telemetry/collection/service.js";
import type { CollectResult } from "../core/telemetry/collection/codex-collect.js";
import type { TelemetryPage } from "../core/telemetry/read-page.js";
import { limitFlag } from "./attempts.js";

const USAGE = "Use: history, ingest, capture, bind, unbind, bindings, setup, unsetup, status, collect (staple budget --help)";

const HELP = `staple budget — provider budget telemetry on this machine (docs/execution-telemetry.md)

  budget [--account A]                  each account's limits: the current window, its
              latest reading, the high-water remaining percent and status. Unknown is
              shown as unknown with its reason, never as 0
  budget history --account A [--since T] [--limit N] [--cursor C]
              one account's readings, oldest first; T is an instant or a duration
              (2h = two hours ago); --limit defaults to 50, at most 500; gaps where
              capture was not running are listed
  budget ingest --source claude-statusline [--tee] [--account A] [--config-dir D]
              read one Claude Code status-line JSON from stdin; --tee writes the input
              back to stdout byte for byte, so staple can sit in front of the
              status-line command you already use:  staple budget ingest
              --source claude-statusline --tee | your-statusline-command
  budget ingest --source codex-rollout <file> [--account A]
              one ~/.codex/sessions rollout; fork-copied history is skipped and a
              replay stores nothing twice
  budget ingest --source manual --account A --limit-key K --used P [--resets-at T] [--provider P]
              a reading typed from /usage or /status; T is an instant or what the
              screen shows as a duration (3h), converted at capture
  budget capture [on|off]               budget capture is opt-in and off by default
  budget bind --source claude-statusline|codex-rollout --account A [--provider P]
              [--config-dir D | --codex-home D]
              name the account a harness home spends from (CLAUDE_CONFIG_DIR or
              ~/.claude; CODEX_HOME or ~/.codex). Without a binding or --account,
              ingestion is refused and nothing is stored under a guessed account
  budget unbind --source S [--config-dir D | --codex-home D]
  budget bindings                       capture state and every binding

Automatic collection (one explicit consent; nothing changes without --yes)
  budget setup [--claude-account A] [--codex-account B] [--claude-config-dir D]
              [--codex-home D] [--no-statusline] [--no-watcher] [--interval MIN] [--yes]
              capture on, the two bindings, a status-line wrapper in front of the
              Claude statusLine command you already have (settings.json backed up
              first), and a launch agent that runs budget collect every MIN minutes
              (default 5; macOS; elsewhere it prints a cron line). Without --yes it
              prints what it would change and changes nothing. Re-running is a no-op
  budget unsetup [--yes]                reverse exactly what setup changed: the
              original statusLine command back byte for byte, the agent unloaded
              and deleted, capture and bindings back to what they were before
  budget status                         capture, each source's newest reading and
              its age, the wrapper and the watcher (loaded? last run, last error)
              and every problem found
  budget collect [--max-files N] [--quiet]
              ingest the Codex rollouts that are new or have grown since the last
              run (newest first, at most N, default 100); what the watcher runs

Samples and limit windows live in this machine's hub.db and never replicate.
Ingestion reads stdin and local files only and makes no network call.`;

const MARK: Record<string, string> = { change: "+", unchanged: "=", skip: "-", refuse: "!" };

function sayPlan(plan: CollectionPlan): void {
  for (const step of plan.steps) console.log(`  ${MARK[step.action]} ${step.part.padEnd(15)} ${step.summary}`);
}

function planText(plan: CollectionPlan): string {
  return plan.steps.map((step) => `  ${MARK[step.action]} ${step.part.padEnd(15)} ${step.summary}`).join("\n");
}

function sayOutcome(outcome: CollectionOutcome): void {
  if (outcome.applied.length === 0) console.log(`${outcome.plan.action}: nothing to change`);
  else console.log(`${outcome.plan.action}: ${outcome.applied.length} change(s) made`);
  sayPlan(outcome.plan);
  const problems = outcome.status.problems;
  if (problems.length > 0) console.log(`problems: ${problems.map((problem) => problem.code).join(", ")} (staple budget status)`);
}

const age = (seconds: number | null): string => {
  if (seconds === null) return "never";
  if (seconds < 90) return `${seconds}s ago`;
  if (seconds < 5400) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 172_800) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86_400)}d ago`;
};

function sayStatus(status: CollectionStatus): void {
  console.log(`capture    ${status.budgetCapture ? "on" : "off"}${status.setup.recorded ? `  (set up ${status.setup.setupAt})` : ""}`);
  if (status.sources.length === 0) console.log("sources    none bound");
  for (const source of status.sources) {
    const last = source.lastReading === null ? "no reading yet" : `last reading ${source.lastReading.observedAt} (stored ${age(source.lastReading.ageSeconds)})`;
    console.log(`  ${source.source.padEnd(23)} ${source.accountRef.padEnd(16)} ${last}`);
  }
  for (const line of status.statusline) console.log(`statusline ${line.state.padEnd(14)} ${line.settingsPath}`);
  const w = status.watcher;
  if (w.supported) {
    console.log(`watcher    ${w.installed ? "installed" : "not installed"}, ${w.loaded ? "loaded" : "not loaded"}${w.intervalMinutes !== null ? `, every ${w.intervalMinutes} min` : ""}`);
  } else console.log(`watcher    no launch agent on ${status.platform}; schedule: ${w.cronLine}`);
  if (w.lastRun !== null) {
    const run = w.lastRun;
    console.log(`  last run ${run.at} (${age(w.lastRunAgeSeconds)}): ${run.skippedReason ?? `${run.ingested} read, ${run.storedCount} stored, ${run.deferred} deferred, ${run.errors.length} error(s)`}`);
  } else console.log("  last run never");
  if (w.lastError !== null) console.log(`  last error ${w.lastError.at}: ${w.lastError.message}`);
  if (status.problems.length === 0) console.log("problems   none");
  for (const problem of status.problems) console.log(`  ! ${problem.code}: ${problem.message}`);
}

function sayCollect(result: CollectResult): void {
  if (result.skippedReason !== null) {
    console.log(`collect: nothing read (${result.skippedReason === "capture_disabled" ? "budget capture is off" : "no codex-rollout binding"})`);
    return;
  }
  console.log(`collect: ${result.scanned} rollout(s) seen, ${result.changed} new or grown, ${result.ingested} read, ${result.storedCount} reading(s) stored, ${result.deferred} left for the next run`);
  for (const error of result.errors) console.log(`  ! ${error.file}: ${error.message}`);
}

function positiveNumber(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value)) throw new StapleError("validation", `${flag} takes a number; got "${raw}".`);
  return value;
}

const PARK = new Int32Array(new SharedArrayBuffer(4));

/** Read fd 0 to EOF as bytes, so a passthrough is byte for byte (no decode, no re-encode). */
function readStdinBytes(fd = 0): Buffer {
  const chunks: Buffer[] = [];
  const chunk = Buffer.alloc(64 * 1024);
  for (;;) {
    let read = 0;
    try {
      read = readSync(fd, chunk, 0, chunk.length, null);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EAGAIN") {
        Atomics.wait(PARK, 0, 0, 20);
        continue;
      }
      if (code === "EOF") break;
      throw error;
    }
    if (read === 0) break;
    chunks.push(Buffer.from(chunk.subarray(0, read)));
  }
  return Buffer.concat(chunks);
}

/** Write every byte to fd 1, parking on a non-blocking pipe that is momentarily full. */
function writeAllBytes(bytes: Buffer, fd = 1): void {
  let offset = 0;
  while (offset < bytes.length) {
    try {
      offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EAGAIN") {
        Atomics.wait(PARK, 0, 0, 5);
        continue;
      }
      throw error;
    }
  }
}

/**
 * Whether to echo stdin before argv is parsed: any spelling of `--tee` (`--tee`,
 * `--tee=true`, even a malformed `--tee=`), unless `--source` names a source that takes
 * no stdin. That combination is refused below without reading stdin at all, so a caller
 * that never closes stdin is not left blocked.
 */
function preParseTee(argv: readonly string[]): boolean {
  if (!argv.some((arg) => arg === "--tee" || arg.startsWith("--tee="))) return false;
  let source: string | undefined;
  argv.forEach((arg, i) => {
    if (arg === "--source") source = argv[i + 1];
    else if (arg.startsWith("--source=")) source = arg.slice("--source=".length);
  });
  return source === undefined || source === "claude-statusline";
}

function bindingSourceOf(raw: string | undefined): BindingSource {
  if (raw === "claude-statusline") return "claude_code_statusline";
  if (raw === "codex-rollout") return "codex_rollout";
  throw new StapleError("validation", `--source must be claude-statusline or codex-rollout for a binding; got ${raw === undefined ? "nothing" : `"${raw}"`}.`);
}

function sayIngest(result: IngestResult): void {
  const skipped = Object.entries(result.skipped)
    .map(([reason, count]) => `${reason} ${count}`)
    .join(", ");
  console.log(
    `${result.accountRef} (${result.provider}, ${result.accountSource === "flag" ? "--account" : "bound"}): stored ${result.storedCount}` +
      (skipped === "" ? "" : `, skipped ${skipped}`),
  );
  for (const outcome of result.outcomes) {
    if (!outcome.stored) continue;
    const s = outcome.sample;
    const reset = s.resetsAt === null ? "no reset reported" : `resets ${s.resetsAt}`;
    console.log(`  ${s.limitKey.padEnd(22)} ${String(s.usedPercent).padStart(5)}% used  ${reset}${s.heartbeat ? "  (heartbeat)" : ""}`);
  }
}

const percent = (value: number | null, reason: string | undefined): string => (value === null ? `unknown (${reason ?? "no reading"})` : `${value}%`);

function sayBudget(view: BudgetView): void {
  if (view.accounts.length === 0) console.log(`no accounts (capture ${view.budgetCapture ? "on" : "off"}; staple budget bind names one)`);
  for (const account of view.accounts) {
    console.log(`${account.accountRef}${account.provider ? ` (${account.provider})` : ""}${account.limits.length === 0 ? `  ${account.missing.limits ?? "no readings"}` : ""}`);
    for (const limit of account.limits) {
      const reset = limit.window?.resetsAt ? ` resets ${limit.window.resetsAt}` : "";
      const stale = limit.stale ? "  (stale)" : "";
      console.log(`  ${limit.limitKey.padEnd(22)} ${(limit.status ?? "-").padEnd(8)} remaining ${percent(limit.remainingPercent, limit.missing.remainingPercent)}${reset}${stale}`);
    }
  }
}

function sayHistory(page: TelemetryPage<HistorySample>): void {
  if (page.items.length === 0) console.log("no readings");
  for (const s of page.items) {
    console.log(`${s.observedAt}  ${s.limitKey.padEnd(22)} ${String(s.usedPercent).padStart(5)}% used${s.heartbeat ? "  (heartbeat)" : ""}${s.regression ? "  (regression)" : ""}`);
  }
  for (const gap of page.coverage.gaps) console.log(`  gap ${gap.from} -> ${gap.to} (${gap.reason})`);
  if (page.truncated) console.log(`more: --cursor ${page.nextCursor}`);
}

function sayConfig(view: BudgetConfigView): void {
  console.log(`capture  ${view.budgetCapture ? "on" : "off"}`);
  if (view.bindings.length === 0) console.log("bindings none");
  for (const binding of view.bindings) {
    const where = binding.source === "claude_code_statusline" ? binding.configDir : binding.home;
    console.log(`  ${binding.source.padEnd(23)} ${where}  ->  ${binding.accountRef} (${binding.provider})`);
  }
  if (view.unknownBindings > 0) console.log(`  (${view.unknownBindings} binding(s) from a newer staple, kept and not used)`);
  for (const invalid of view.invalidBindings) {
    console.log(`  ! bindings[${invalid.index}] ${invalid.problem}; kept, NOT used. Re-bind that home to replace it.`);
  }
}

/**
 * Without --yes: a plan with nothing to change is printed and exits 0; one that would
 * change something is the refusal `staple install` gives, with the plan as its detail, so
 * a --json caller reads the plan off the error path. Nothing has been written either way.
 */
function refuseWithoutYes(plan: CollectionPlan, json: boolean): void {
  if (plan.changes === 0 && plan.refusals === 0) {
    if (json) console.log(JSON.stringify({ plan, applied: [] }));
    else {
      console.log(`${plan.action}: nothing to change`);
      sayPlan(plan);
    }
    return;
  }
  if (plan.refusals > 0) {
    throw new StapleError("validation", `budget ${plan.action} is refused; nothing was changed.\n${planText(plan)}`, { reason: "plan_refused", plan });
  }
  throw new StapleError(
    "validation",
    `Refusing to ${plan.action === "setup" ? "set up budget collection" : "undo budget collection"} without --yes. Nothing was changed. The plan:\n${planText(plan)}\nRe-run with --yes to apply it.`,
    { reason: "consent_required", plan },
  );
}

export function runBudgetCommand(argv: string[]): void {
  // Through FIRST, before argv is even parsed: a typo in the flags must not blank the
  // operator's status line. Only the refusal that follows goes to stderr.
  const teeBytes = preParseTee(argv) ? readStdinBytes() : null;
  if (teeBytes !== null) writeAllBytes(teeBytes);
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      help: { type: "boolean" },
      source: { type: "string" },
      tee: { type: "boolean" },
      account: { type: "string" },
      provider: { type: "string" },
      "config-dir": { type: "string" },
      "codex-home": { type: "string" },
      "limit-key": { type: "string" },
      used: { type: "string" },
      "resets-at": { type: "string" },
      since: { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
      "claude-account": { type: "string" },
      "codex-account": { type: "string" },
      "claude-config-dir": { type: "string" },
      "no-statusline": { type: "boolean" },
      "no-watcher": { type: "boolean" },
      interval: { type: "string" },
      "max-files": { type: "string" },
      yes: { type: "boolean" },
      quiet: { type: "boolean" },
    },
  });
  const [sub, ...args] = positionals;
  const json = values.json === true;
  const home = stapleHome();
  const print = (value: unknown, human: () => void): void => {
    if (json) console.log(JSON.stringify(value));
    else human();
  };

  if (values.help === true || sub === "help") {
    console.log(HELP);
    return;
  }

  switch (sub) {
    case undefined: {
      const view = readBudget(home, { account: values.account });
      print(view, () => sayBudget(view));
      return;
    }
    case "history": {
      if (values.account === undefined) throw new StapleError("validation", "budget history needs --account: the label of the account to read.");
      const page = listBudgetSamples(home, { account: values.account, since: values.since, limit: limitFlag(values.limit), cursor: values.cursor });
      print(page, () => sayHistory(page));
      return;
    }
    case "ingest": {
      const source = values.source as IngestSource | undefined;
      if (source === undefined || !(INGEST_SOURCES as readonly string[]).includes(source)) {
        throw new StapleError("validation", `--source must be one of ${INGEST_SOURCES.join(", ")}.`);
      }
      if (values.tee === true && source !== "claude-statusline") {
        throw new StapleError("validation", "--tee passes a status line through; it applies to --source claude-statusline only.");
      }
      const input = source === "claude-statusline" ? (teeBytes ?? readStdinBytes()).toString("utf8") : undefined;
      const result = ingestBudget(
        {
          source,
          input,
          configDir: values["config-dir"],
          file: source === "codex-rollout" ? args[0] : undefined,
          account: values.account,
          provider: values.provider,
          limitKey: values["limit-key"],
          used: values.used,
          resetsAt: values["resets-at"],
        },
        // Each reading names the one open attempt from its session on this machine, if there is one.
        { home, operator: true, attemptLinker: attemptLinkerFor(home) },
      );
      // With --tee, stdout belongs to the status line and carries nothing else.
      if (values.tee !== true) print(result, () => sayIngest(result));
      return;
    }
    case "capture": {
      const [state] = args;
      if (state === undefined) {
        const view = budgetConfig(home);
        print({ budgetCapture: view.budgetCapture }, () => console.log(`capture  ${view.budgetCapture ? "on" : "off"}`));
        return;
      }
      if (state !== "on" && state !== "off") throw new StapleError("validation", `budget capture takes on or off; got "${state}".`);
      const view = setBudgetCapture(home, state === "on");
      print(view, () => sayConfig(view));
      return;
    }
    case "bind": {
      if (values.account === undefined) throw new StapleError("validation", "budget bind needs --account: the label of the account this harness home spends from.");
      const view = bindBudgetSource(home, {
        source: bindingSourceOf(values.source),
        account: values.account,
        provider: values.provider,
        configDir: values["config-dir"],
        codexHome: values["codex-home"],
      });
      print(view, () => sayConfig(view));
      return;
    }
    case "unbind": {
      const view = unbindBudgetSource(home, {
        source: bindingSourceOf(values.source),
        configDir: values["config-dir"],
        codexHome: values["codex-home"],
      });
      print(view, () => sayConfig(view));
      return;
    }
    case "bindings": {
      const view = budgetConfig(home);
      print(view, () => sayConfig(view));
      return;
    }
    case "setup": {
      const options = {
        claudeAccount: values["claude-account"],
        codexAccount: values["codex-account"],
        claudeConfigDir: values["claude-config-dir"],
        codexHome: values["codex-home"],
        statusline: values["no-statusline"] !== true,
        watcher: values["no-watcher"] !== true,
        intervalMinutes: positiveNumber(values.interval, "--interval"),
      };
      const deps = { home, attemptLinker: attemptLinkerFor(home) };
      if (values.yes !== true) {
        const plan = planBudgetSetup(options, deps);
        refuseWithoutYes(plan, json);
        return;
      }
      const outcome = applyBudgetSetup(options, deps);
      print(outcome, () => sayOutcome(outcome));
      return;
    }
    case "unsetup": {
      const deps = { home };
      if (values.yes !== true) {
        refuseWithoutYes(planBudgetUnsetup(deps), json);
        return;
      }
      const outcome = applyBudgetUnsetup(deps);
      print(outcome, () => sayOutcome(outcome));
      return;
    }
    case "status": {
      const status = budgetCollectionStatus({ home });
      print(status, () => sayStatus(status));
      return;
    }
    case "collect": {
      const result = collectBudget({ maxFiles: positiveNumber(values["max-files"], "--max-files") }, { home, attemptLinker: attemptLinkerFor(home) });
      if (values.quiet === true) {
        // The watcher's own log line is written by collect; stderr carries only failures.
        for (const error of result.errors) console.error(`budget collect: ${error.file}: ${error.message}`);
        return;
      }
      print(result, () => sayCollect(result));
      return;
    }
    default:
      throw new StapleError("validation", `Unknown budget subcommand "${sub}". ${USAGE}`);
  }
}
