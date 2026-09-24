/**
 * `staple budget` — the write side of provider budget telemetry
 * (docs/execution-telemetry.md): ingesting readings, and the operator's opt-in and
 * source bindings. Machine-level: it reads and writes the staple home, never a workspace.
 *
 *   budget ingest --source claude-statusline [--tee] [--account A] [--config-dir D]
 *   budget ingest --source codex-rollout <file> [--account A]
 *   budget ingest --source manual --account A --limit-key K --used P [--resets-at T] [--provider P]
 *   budget capture [on|off]
 *   budget bind --source claude-statusline|codex-rollout --account A [--provider P] [--config-dir D | --codex-home D]
 *   budget unbind --source claude-statusline|codex-rollout [--config-dir D | --codex-home D]
 *   budget bindings
 *
 * `ingest` calls the same `ingestBudget` the MCP tool `record_budget_sample` calls.
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

const USAGE = "Use: ingest, capture, bind, unbind, bindings (staple budget --help)";

const HELP = `staple budget — provider budget telemetry on this machine (docs/execution-telemetry.md)

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

Samples and limit windows live in this machine's hub.db and never replicate.
Ingestion reads stdin and local files only and makes no network call.`;

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
    default:
      throw new StapleError("validation", sub === undefined ? `staple budget needs a subcommand. ${USAGE}` : `Unknown budget subcommand "${sub}". ${USAGE}`);
  }
}
