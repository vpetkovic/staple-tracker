/**
 * `staple forecast <ref>`: the completion forecast of an issue and, apart from it, the budget
 * forecast of that work on this machine (docs/cli.md, "Forecasts"). One store method,
 * `WorkspaceStore.forecast`, which MCP `forecast` and HTTP `/api/forecast` call too, so `--json`
 * and the tools answer one shape.
 */
import { parseArgs } from "node:util";
import type { BudgetLimitForecast } from "../core/telemetry/forecast-budget.js";
import type { SimulatedSpread } from "../core/telemetry/forecast.js";
import type { ForecastReport } from "../core/telemetry/forecast-report.js";
import { StapleError, formatDuration } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";

const HELP = `staple forecast — how much work is left, and what it costs a provider limit

  forecast <ref> [--reserve P] [--account A] [--model M]
              completion  the certified plan's units beneath <ref> (a leaf is
                          its own unit), each from its calibrated duration
                          (staple calibrate --for) less the work done on it;
                          done and in-review units weigh 0 (review waits and
                          rework are not forecast); a unit with no samples,
                          no estimate or past every sample of its class is
                          unknown, never 0, and turns the sums partial
                labor     the remaining work, added
                path      the longest dependency chain of remaining work:
                          effort along the chain, not calendar time
                bands     resampled from each class's samples with a fixed
                          seed: p10 p50 p90 and a 90% band (p5-p95); achieved
                          is the lowest bounds confidence of the classes read
              budget      this machine only, never blended with completion:
                          per account and limit, the high-water remaining,
                          the reset, the pace (%/h), when it runs out, the
                          work rate (%/work-hour from attempts' measured burn)
                          and, for the remaining labor run serially from now,
                          what is left at the reset and the probability it
                          is under the reserve
  --reserve P   the protected reserve, a percent of each limit (20 or 20%);
                without it a PROVISIONAL default of 20% applies, until the
                admission policy defines one
  --account A   only this account's budget
  --model M     the model the work will run on, pinned in every unit's key

  --json      {asOf, subject, filter, snapshot, method, completion, budget}`;

const duration = (seconds: number | null): string => (seconds === null ? "unknown" : formatDuration(Math.round(seconds)));
const percent = (value: number): string => `${value.toFixed(1)}%`;
const probability = (value: number): string => `${(value * 100).toFixed(1)}%`;
const bandText = (spread: SimulatedSpread, of: (value: number) => string): string =>
  `p10–p90 ${of(spread.p10)}–${of(spread.p90)} · 90% band ${of(spread.band.lower)}–${of(spread.band.upper)}`;

function limitText(limit: BudgetLimitForecast): string[] {
  const reason = (field: string): string => {
    const code = limit.missing[field] ?? "unknown";
    const inputs = limit.missingInputs[field];
    return inputs === undefined ? code : `${code} (${inputs.join(", ")})`;
  };
  const head = [
    limit.remainingPercent === null ? `remaining ${reason("remainingPercent") === "unknown" ? limit.quality.state : reason("remainingPercent")}` : `${percent(limit.remainingPercent)} left`,
    limit.resetsAt === null ? `no reset (${reason("secondsToReset")})` : `resets ${limit.resetsAt} (in ${duration(limit.secondsToReset)})`,
    limit.stale === true ? "stale" : null,
  ].filter((part): part is string => part !== null);
  const lines = [head.join(" · ")];
  const pace = limit.pace === null ? `pace ${reason("pace")}` : `pace ${limit.pace.percentPerHour.toFixed(2)}%/h over ${limit.pace.readings} readings`;
  const exhaustion =
    limit.exhaustion === null
      ? `exhaustion ${reason("exhaustion")}`
      : limit.exhaustion.atPace === "never"
        ? "never runs out at this pace"
        : `runs out in ${duration(limit.exhaustion.seconds)} (${limit.exhaustion.atPace.replace("_", " ")})`;
  lines.push(`${pace} · ${exhaustion}`);
  const rate = limit.workRate;
  lines.push(
    rate === null
      ? `work rate ${reason("workRate")}`
      : `work rate ${rate.percentPerWorkHour.toFixed(2)}%/work-hour over ${rate.attempts} attempts (${duration(rate.workSeconds)})${rate.lowerBound ? " · at least" : ""}${rate.shared > 0 ? ` · ${rate.shared} shared` : ""}`,
  );
  if (limit.work === null) lines.push(`the work ${reason("work")}`);
  else {
    const work = limit.work;
    lines.push(
      `the work uses ${percent(work.consumedPercent.expected)} (${bandText(work.consumedPercent.simulated, percent)}) · at the reset ${percent(work.remainingAtResetPercent.expected)} left (${bandText(work.remainingAtResetPercent.simulated, percent)})${work.exhaustionProbability > 0 ? ` · P(it alone exhausts the limit first) ${probability(work.exhaustionProbability)}` : ""}${work.lowerBound ? " · burn at least" : ""}`,
    );
  }
  if (limit.reserve !== null) {
    lines.push(`P(under the ${percent(limit.reserve.percent)} reserve at the reset) ${probability(limit.reserve.breachProbability)}${limit.reserve.alreadyBelow ? " · already under it" : ""}`);
  }
  return lines;
}

function say(report: ForecastReport): void {
  const { subject, completion, budget } = report;
  console.log(`${subject.ref} · ${subject.title} (${subject.kind}, ${subject.status}) · snapshot ${report.snapshot.id} over ${report.snapshot.calibration.id}`);
  const units = completion.units;
  console.log(
    `completion  ${units.total} unit${units.total === 1 ? "" : "s"} · ${units.done} done · ${units.awaitingReview} awaiting review · ${units.forecast} to forecast, ${units.known} known` +
      (units.unknownRefs.length > 0 ? ` · unknown ${units.unknownRefs.join(", ")}` : ""),
  );
  const partial = (figure: { partial: boolean }): string => (figure.partial ? "≥" : "");
  const labor = completion.labor;
  console.log(
    `  labor     expected ${partial(labor)}${duration(labor.expectedSeconds)}` +
      (labor.simulated === null ? "" : ` · ${bandText(labor.simulated, duration)}`) +
      (labor.missing.length > 0 ? ` · ${labor.missing.join(", ")}` : "") +
      ` · plan ${duration(completion.plan.seconds)} (${completion.plan.source})`,
  );
  const path = completion.path;
  const chain = path.chain.map((step) => step.ref).slice(0, 8).join(" > ") + (path.chainLength > 8 ? ` > … (+${path.chainLength - 8})` : "");
  console.log(
    `  path      expected ${partial(path)}${duration(path.expectedSeconds)}${chain === "" ? "" : ` · ${chain}`}` +
      (path.simulated === null ? "" : ` · ${bandText(path.simulated, duration)}`) +
      (path.unresolvedCrossSubtreeBlockerCount > 0 ? ` · ${path.unresolvedCrossSubtreeBlockerCount} outside blockers open` : ""),
  );
  const confidence = completion.confidence;
  console.log(
    `  confidence ${confidence.label}${confidence.achieved === null ? "" : ` · bounds reach ${probability(confidence.achieved)} of ${probability(confidence.nominal)}`}` +
      (confidence.reasons.length > 0 ? ` · ${confidence.reasons.join(", ")}` : "") +
      (completion.warnings.length > 0 ? ` · warnings ${completion.warnings.join(", ")}` : ""),
  );
  console.log(
    `budget      this machine · reserve ${percent(budget.reserve.percent)}${budget.reserve.source === "provisional_default" ? " (provisional default, until the admission policy defines one)" : ""} · work ${partial(budget.work)}${duration(budget.work.expectedSeconds)}, serial from now`,
  );
  if (budget.accounts.length === 0) console.log(`  no account: ${budget.missing.accounts ?? "unknown"}`);
  for (const account of budget.accounts) {
    if (account.limits.length === 0) console.log(`  ${account.provider ?? "-"}/${account.accountRef}: no limit read (${account.missing.limits ?? "unknown"})`);
    for (const limit of account.limits) {
      const [first, ...rest] = limitText(limit);
      console.log(`  ${account.provider ?? "-"}/${account.accountRef} ${limit.limitKey}: ${first}`);
      for (const line of rest) console.log(`      ${line}`);
    }
  }
}

export function runForecastCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      reserve: { type: "string" },
      account: { type: "string" },
      model: { type: "string" },
    },
  });
  if (values.help === true) return console.log(HELP);
  if (positionals.length !== 1) {
    throw new StapleError("validation", `staple forecast takes one issue: staple forecast <ref>; got ${positionals.length === 0 ? "none" : `"${positionals.join(" ")}"`}.`);
  }
  const store = resolveWorkspace({ db: values.db, ws: values.ws }).store;
  const report = store.forecast({ ref: positionals[0]!, reserve: values.reserve, account: values.account, model: values.model });
  if (values.json) return console.log(JSON.stringify(report));
  say(report);
}
