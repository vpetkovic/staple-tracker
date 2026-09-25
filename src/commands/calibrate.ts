/**
 * `staple calibrate`: calibration cohorts over the trusted samples of a population
 * (docs/cli.md, "Calibration"). One store method, `WorkspaceStore.calibration`, which MCP
 * `calibration_cohorts` and HTTP `/api/calibration` call too, so `--json` and the tools answer
 * one shape.
 */
import { parseArgs } from "node:util";
import { ANY, DIMENSIONS, type CalibrationCohort, type CalibrationReport, type CalibrationSample } from "../core/telemetry/calibration.js";
import { StapleError, formatDuration } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";
import { limitFlag } from "./attempts.js";

const HELP = `staple calibrate — how long work of a class takes against its estimate

  calibrate [--kind K[,K]] [--priority P[,P]] [--parent REF] [--since T]
            [--include reconstructed] [--samples] [--limit N] [--cursor C]
              samples    done issues with their own estimate (no estimated
                         descendant) whose work is exact; nothing approximate,
                         under a minute or missing is ever a sample
              estimate   the first worker attempt's estimate at start, else the
                         current one (each sample says which)
              cohort     kind, priority, work type (label type:<x>), area
                         (label area:<x>) and model (the attempts' harness
                         model); a key with fewer than 5 samples falls back:
                         without model, without area, without work type,
                         kind, all. The path and the level read are listed
              coverage   samples over the eligible issues in the class
              snapshot   an id for the data the report came from: the same
                         data gives the same id on every device
  --include reconstructed   add backfilled history as its own cohorts, never
              pooled with exact (records with nothing approximate about them)
  --samples   list the samples instead of the cohorts
  --kind, --priority  only these      --parent  only issues beneath REF
  --since     resolved at or after an ISO instant, or that long ago (7d, 12h)
  --limit     rows listed, default 50, at most 500; --cursor: next page

  --json      {asOf, filter, snapshot, method, population, sets, list, items,
              truncated, nextCursor, missing}`;

const percent = (value: number | null): string => (value === null ? "-" : `${(value * 100).toFixed(1)}%`);
const list = (raw: string[] | undefined): string[] | undefined =>
  raw === undefined ? undefined : raw.flatMap((value) => value.split(",")).map((part) => part.trim()).filter((part) => part !== "");
const keyText = (key: CalibrationCohort["key"]): string => DIMENSIONS.map((dimension) => `${dimension}=${key[dimension]}`).join(" ");
const classText = (key: CalibrationCohort["class"]): string => {
  const kept = DIMENSIONS.filter((dimension) => key[dimension] !== ANY).map((dimension) => `${dimension}=${key[dimension]}`);
  return kept.length === 0 ? "all" : kept.join(" ");
};

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
        `              ${classText(cohort.class)}: n ${cohort.samples} (${percent(cohort.coverage.fraction)} of ${cohort.coverage.eligible}) · ratio median ${cohort.ratio.median.toFixed(3)}, pooled ${cohort.ratio.pooled.toFixed(3)} · work median ${formatDuration(cohort.workSeconds.median)}${cohort.warnings.length > 0 ? ` · ${cohort.warnings.join(", ")}` : ""}`,
      );
    }
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
  });
  if (values.json) return console.log(JSON.stringify(report));
  say(report);
}
