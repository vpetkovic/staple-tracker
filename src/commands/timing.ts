/**
 * `staple timing quality`: the quality states of a filtered population's timing records and
 * their coverage over the eligible population (docs/cli.md, "Timing quality"). One store
 * method, `WorkspaceStore.timingQuality`, which MCP `timing_quality` and HTTP
 * `/api/timing/quality` call too, so `--json` and the tools answer one shape.
 */
import { parseArgs } from "node:util";
import type { TimingQualityReport } from "../core/telemetry/cohort.js";
import { StapleError, formatDuration } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";
import { limitFlag } from "./attempts.js";

const HELP = `staple timing quality — how much of a population's timing can be trusted

  timing quality [--kind K[,K]] [--parent REF] [--since T] [--exclude S[,S]]
                 [--exclude-reason R[,R]] [--limit N] [--cursor C]
              eligible   the leaves resolved done in the filter: the denominator
                         of every coverage figure (a parent's work is its
                         children's, so it is never counted twice)
              work       one state per record: exact, timing-floor (under 60s),
                         approximate, reconstructed, missing; each with reasons
              wall       exact, approximate, missing (device-local)
              ratio      work / estimate over leaves with their own estimate:
                         exact records only, and over the admitted states
  --kind      only these kinds          --parent  only issues beneath REF
  --since     resolved at or after an ISO instant, or that long ago (7d, 12h)
  --exclude   work states an analysis drops, e.g. approximate: they leave the
              listing and the admitted ratio and are counted under excluded;
              counts and coverage never change. Nothing is dropped by default,
              so timing-floor records stay listed
  --exclude-reason  drop every record carrying a reason, whatever its state:
              --exclude-reason sparse drops reconstructed records that are sparse
  --limit     records listed, default 50, at most 500; --cursor: next page

  --json      {asOf, filter, population, work, wall, ratio, excluded, items,
              truncated, nextCursor}`;

const percent = (value: number): string => `${(value * 100).toFixed(1)}%`;
const list = (raw: string | undefined): string[] | undefined =>
  raw === undefined ? undefined : raw.split(",").map((part) => part.trim()).filter((part) => part !== "");

function say(report: TimingQualityReport): void {
  const { population, work, wall, ratio, excluded } = report;
  const scope = [
    report.filter.kind ? `kind ${report.filter.kind.join(",")}` : null,
    report.filter.parent ? `beneath ${report.filter.parent}` : null,
    report.filter.since ? `resolved since ${report.filter.since}` : null,
  ].filter((part): part is string => part !== null);
  console.log(
    `${population.eligible} eligible (done leaves) of ${population.issues} issues${scope.length > 0 ? ` · ${scope.join(" · ")}` : ""}` +
      ` · not eligible: ${population.notEligible.parents} parents, ${population.notEligible.open} open, ${population.notEligible.cancelled} cancelled`,
  );
  const states = (counts: Record<string, number>, coverage: Record<string, number> | null): string =>
    Object.entries(counts)
      .map(([state, count]) => `${state} ${count}${coverage ? ` (${percent(coverage[state]!)})` : ""}`)
      .join(" · ");
  console.log(`work   ${states(work.counts, work.coverage)}`);
  const reasons = Object.entries(work.reasons).map(([reason, count]) => `${reason} ${count}`);
  if (reasons.length > 0) console.log(`       reasons: ${reasons.join(", ")}`);
  console.log(`wall   ${states(wall.counts, wall.coverage)}`);
  const aggregate = (label: string, value: TimingQualityReport["ratio"]["exact"]): string =>
    `${label} ${value.ratio === null ? "unknown" : value.ratio.toFixed(3)} over ${value.coverage.known} of ${value.coverage.total}` +
    (value.workSeconds !== null ? ` (work ${formatDuration(value.workSeconds)} / est ${formatDuration(value.estimatedSeconds!)})` : "");
  console.log(`ratio  ${aggregate("exact", ratio.exact)}`);
  console.log(`       ${aggregate(`admitted [${ratio.admitted.states.join(",")}]`, ratio.admitted)}`);
  if (excluded.count > 0) {
    const parts = [...Object.entries(excluded.counts).map(([state, count]) => `${state} ${count}`), ...Object.entries(excluded.reasons).map(([reason, count]) => `${reason} ${count}`)];
    console.log(`excluded ${excluded.count} records: ${parts.join(", ")}`);
  }
  for (const item of report.items) {
    const reasonsText = item.work.reasons.length > 0 ? ` (${item.work.reasons.join(", ")})` : "";
    const figure = item.workSeconds === null ? "work unknown" : `work ${formatDuration(item.workSeconds)}`;
    const est = item.estimatedSeconds === null ? "" : ` · est ${formatDuration(item.estimatedSeconds)}`;
    console.log(`${item.identifier.padEnd(9)} ${item.work.state.padEnd(13)} ${figure}${est}${reasonsText} · wall ${item.wall.state}  ${item.title}`);
  }
  if (report.truncated) console.log(`more: --cursor ${report.nextCursor}`);
}

export function runTimingCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      kind: { type: "string" },
      parent: { type: "string" },
      since: { type: "string" },
      exclude: { type: "string" },
      "exclude-reason": { type: "string" },
      limit: { type: "string" },
      cursor: { type: "string" },
    },
  });
  const [verb, ...extra] = positionals;
  if (values.help === true || verb === undefined) return console.log(HELP);
  if (verb !== "quality" || extra.length > 0) {
    throw new StapleError("validation", `staple timing takes one verb, quality: staple timing quality [--kind K] [--parent REF] [--since T] [--exclude S]. Got "${positionals.join(" ")}".`);
  }
  const store = resolveWorkspace({ db: values.db, ws: values.ws }).store;
  const report = store.timingQuality({
    kind: list(values.kind),
    parent: values.parent,
    since: values.since,
    exclude: list(values.exclude),
    excludeReasons: list(values["exclude-reason"]),
    limit: limitFlag(values.limit),
    cursor: values.cursor,
  });
  if (values.json) return console.log(JSON.stringify(report));
  say(report);
}
