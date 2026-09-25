/**
 * `staple calibrate`: calibration cohorts over the trusted samples of a population
 * (docs/cli.md, "Calibration"). One store method, `WorkspaceStore.calibration`, which MCP
 * `calibration_cohorts` and HTTP `/api/calibration` call too, so `--json` and the tools answer
 * one shape.
 */
import { parseArgs } from "node:util";
import { ANY, DIMENSIONS, type CalibrationCohort, type CalibrationReport, type CalibrationSample, type OrderInterval } from "../core/telemetry/calibration.js";
import { StapleError, formatDuration } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";
import { limitFlag } from "./attempts.js";

const HELP = `staple calibrate — how long work of a class takes against its estimate

  calibrate [--kind K[,K]] [--priority P[,P]] [--parent REF] [--since T]
            [--include reconstructed] [--samples] [--limit N] [--cursor C]
              samples    done issues with their own estimate (no estimated
                         descendant) whose work is exact; nothing approximate,
                         under a minute or missing is ever a sample
              estimate   the first attempt's reading of the issue's own estimate
                         at start, else the current one (each sample says which)
              cohort     kind, priority, work type (label type:<x>), area
                         (label area:<x>) and model (the attempts' harness
                         model); a key with fewer than 5 samples falls back:
                         without model, without area, without work type,
                         kind, all. The path and the level read are listed
              coverage   samples over the eligible issues in the class
              snapshot   an id for the data the report came from: the same
                         data gives the same id on every device
              ranges     quantiles p10 p25 p50 p75 p90 (lower method), an
                         order-statistic interval for each, and bounds for one
                         more sample, at 90% or with the confidence reached
              tail       from 10 samples: heavy when 3+ (and 5%) sit beyond
                         3.5 robust deviations of ln(ratio); the expected
                         ratio is then clipped at the fences, and reads low
              floors     work under 60s, never samples; more floors than
                         samples (5+ of both) and a forecast reads the floor
              warnings   small_sample bounds_below_confidence
                         quantile_below_confidence fallback_used heavy_tail
                         floor_dominated floors_excluded reconstructed_only
                         no_samples
              paths      only a forecast's expected seconds add along a path;
                         quantiles and bounds do not
  --include reconstructed   add backfilled history as its own cohorts, never
              pooled with exact (records with nothing approximate about them)
  --for REF   forecast REF's duration (repeat, or a comma list): the cohort
              its key reads times its own estimate, per evidence set. An
              issue with no attempt yet matches any model
  --model M   with --for: the model the work will run on, pinned in its key
  --samples   list the samples instead of the cohorts
  --kind, --priority  only these      --parent  only issues beneath REF
  --since     resolved at or after an ISO instant, or that long ago (7d, 12h)
  --limit     rows listed, default 50, at most 500; --cursor: next page

  --json      {asOf, filter, snapshot, method, population, sets, list, items,
              forecasts, truncated, nextCursor, missing}`;

const percent = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const list = (raw: string[] | undefined): string[] | undefined =>
  raw === undefined ? undefined : raw.flatMap((value) => value.split(",")).map((part) => part.trim()).filter((part) => part !== "");
const keyText = (key: CalibrationCohort["key"]): string => DIMENSIONS.map((dimension) => `${dimension}=${key[dimension]}`).join(" ");
const classText = (key: CalibrationCohort["class"]): string => {
  const kept = DIMENSIONS.filter((dimension) => key[dimension] !== ANY).map((dimension) => `${dimension}=${key[dimension]}`);
  return kept.length === 0 ? "all" : kept.join(" ");
};

const interval = (at: OrderInterval, of: (value: number) => string): string =>
  `${of(at.lower)}–${of(at.upper)} (${percent(at.confidence)}${at.reached ? "" : ", below target"})`;
const ratioText = (value: number): string => value.toFixed(3);

function say(report: CalibrationReport): void {
  const scope = [
    report.filter.kind ? `kind ${report.filter.kind.join(",")}` : null,
    report.filter.priority ? `priority ${report.filter.priority.join(",")}` : null,
    report.filter.parent ? `beneath ${report.filter.parent}` : null,
    report.filter.since ? `resolved since ${report.filter.since}` : null,
  ].filter((part): part is string => part !== null);
  console.log(`snapshot ${report.snapshot.id}${scope.length > 0 ? ` · ${scope.join(" · ")}` : ""}`);
  console.log(`${report.population.ratio} eligible (done, own estimate) of ${report.population.issues} issues · minimum ${report.method.minSamples} samples per cohort`);
  for (const set of report.sets) {
    const excluded = Object.entries(set.excluded.counts).map(([state, count]) => `${state} ${count}`);
    console.log(
      `${set.set.padEnd(13)} ${set.samples} samples (${percent(set.coverage.fraction)} of ${set.coverage.eligible}) in ${set.cohorts} cohorts` +
        (excluded.length > 0 ? ` · not samples: ${excluded.join(", ")}` : ""),
    );
  }
  if (report.list === "samples") {
    for (const sample of report.items as CalibrationSample[]) {
      console.log(
        `${sample.set.padEnd(13)} ${sample.identifier.padEnd(9)} ratio ${sample.ratio.toFixed(3)} · work ${formatDuration(sample.workSeconds)} / est ${formatDuration(sample.estimate.seconds)} (${sample.estimate.source}) · ${keyText(sample.dimensions)}`,
      );
    }
  } else {
    for (const cohort of report.items as CalibrationCohort[]) {
      const fallback = cohort.level === 0 ? "" : ` → ${cohort.levelName} (${cohort.path.map((step) => `${step.name} ${step.samples}`).join(", ")})`;
      console.log(`${cohort.set.padEnd(13)} ${keyText(cohort.key)} · ${cohort.keySamples} own${fallback}`);
      console.log(
        `              ${classText(cohort.class)}: n ${cohort.samples} (${percent(cohort.coverage.fraction)} of ${cohort.coverage.eligible}) · ratio median ${cohort.ratio.median.toFixed(3)}, range ${cohort.ratio.min.toFixed(3)}–${cohort.ratio.max.toFixed(3)}, pooled ${cohort.ratio.pooled.toFixed(3)} · work median ${formatDuration(cohort.workSeconds.median)}${cohort.warnings.length > 0 ? ` · ${cohort.warnings.join(", ")}` : ""}`,
      );
      const { quantiles, bounds } = cohort.ratio;
      if (quantiles !== null && bounds !== null) {
        const tail = !cohort.tail.tested
          ? "tail untested"
          : `${cohort.tail.heavy ? "heavy tail" : "tail ok"} (${cohort.tail.outliers.lower + cohort.tail.outliers.upper} beyond the fences)`;
        console.log(
          `              ratio p10 ${ratioText(quantiles.p10)} p25 ${ratioText(quantiles.p25)} p50 ${ratioText(quantiles.p50)} p75 ${ratioText(quantiles.p75)} p90 ${ratioText(quantiles.p90)} · bounds ${interval(bounds, ratioText)} · expected ${ratioText(cohort.ratio.expected.value)} (${cohort.ratio.expected.method}) · ${tail}` +
            (cohort.floors.count > 0 ? ` · ${cohort.floors.count} under the floor${cohort.floors.dominated ? " (dominated)" : ""}` : ""),
        );
      }
    }
  }
  for (const forecast of report.forecasts) {
    const head = `forecast      ${forecast.identifier} ${forecast.set} · est ${forecast.estimate.seconds === null ? "-" : formatDuration(forecast.estimate.seconds)} · ${classText(forecast.cohort.class)} n ${forecast.cohort.samples}`;
    let body: string;
    if (forecast.state === "ratio") {
      const seconds = forecast.seconds!;
      body = `p50 ${formatDuration(Math.round(seconds.p50))}, p10–p90 ${formatDuration(Math.round(seconds.p10))}–${formatDuration(Math.round(seconds.p90))} · bounds ${interval(forecast.bounds!, (value) => formatDuration(Math.round(value)))} · expected ${formatDuration(Math.round(forecast.expected!.seconds))} (${forecast.expected!.method})`;
    } else if (forecast.state === "floor") body = `under the floor (${forecast.floors.seconds}s): ${forecast.floors.count} floor members, ${forecast.cohort.samples} samples`;
    else body = forecast.missing.seconds ?? forecast.state;
    console.log(`${head} → ${body}${forecast.warnings.length > 0 ? ` · ${forecast.warnings.join(", ")}` : ""}`);
  }
  for (const [field, reason] of Object.entries(report.missing)) console.log(`${field}: ${reason}`);
  if (report.truncated) console.log(`more: --cursor ${report.nextCursor}`);
}

export function runCalibrateCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      kind: { type: "string", multiple: true },
      priority: { type: "string", multiple: true },
      parent: { type: "string" },
      since: { type: "string" },
      include: { type: "string", multiple: true },
      samples: { type: "boolean" },
      limit: { type: "string" },
      cursor: { type: "string" },
      for: { type: "string", multiple: true },
      model: { type: "string" },
    },
  });
  if (values.help === true) return console.log(HELP);
  if (positionals.length > 0) {
    throw new StapleError("validation", `staple calibrate takes no positional argument; got "${positionals.join(" ")}". Filter with --kind, --priority, --parent or --since.`);
  }
  const store = resolveWorkspace({ db: values.db, ws: values.ws }).store;
  const report = store.calibration({
    kind: list(values.kind),
    priority: list(values.priority),
    parent: values.parent,
    since: values.since,
    include: list(values.include),
    list: values.samples === true ? "samples" : "cohorts",
    limit: limitFlag(values.limit),
    cursor: values.cursor,
    for: list(values.for),
    model: values.model,
  });
  if (values.json) return console.log(JSON.stringify(report));
  say(report);
}
