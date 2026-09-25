/**
 * `staple compare <ref> <ref> [...]`: the certified plan of each named issue side by side —
 * total labor, estimate coverage and the critical path — with no tree in the output
 * (docs/cli.md, "Comparing plans"). One store method, `WorkspaceStore.comparePlans`, which MCP
 * `compare_plans` and HTTP `/api/compare` call too, so `--json` and the tools answer one shape.
 */
import { parseArgs } from "node:util";
import type { PlanComparison, PlanSummary } from "../core/plan-rollup.js";
import { StapleError, formatDuration } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";

const HELP = `staple compare — total labor, estimate coverage and critical path of named issues

  compare <ref> [<ref> ...]   up to 20 issues; no tree is printed
              labor   every planned unit once: an issue's own estimate, else the
                      sum of its units beneath; never a parent's estimate on top
                      of its descendants'. Cancelled work is no labor
              units   planned of all units; an unplanned unit makes both labor
                      and path lower bounds (partial), never a silent 0
              path    the longest blockedBy chain inside the subtree, weighted by
                      estimate, parallel branches taking the max; blockers from
                      outside the subtree are listed, not followed

  --json      {plans: [{ref, title, kind, status, labor, coverage, criticalPath}], overlaps}`;

const CHAIN_SHOWN = 8;
const hours = (seconds: number | null): string => (seconds === null ? "unknown" : formatDuration(seconds));

/**
 * The plan in two lines, as `show` and `compare` print it: labor with coverage, then the path.
 * `show` prints them for a parent; a leaf's plan is its own estimate, already on `time`.
 */
export function planLines(plan: PlanSummary): string[] {
  const { labor, coverage, criticalPath: path } = plan;
  const source =
    labor.source === "own" && labor.descendantsSeconds !== null
      ? `own estimate; units beneath add up to ${formatDuration(labor.descendantsSeconds)}`
      : labor.source;
  const units = `${coverage.planned} of ${coverage.units} units planned`;
  const cancelled = coverage.cancelled > 0 ? ` · ${coverage.cancelled} cancelled excluded` : "";
  const unplanned =
    coverage.unplanned > 0
      ? ` · unplanned ${coverage.unplannedRefs.join(", ")}${coverage.unplanned > coverage.unplannedRefs.length ? ` (+${coverage.unplanned - coverage.unplannedRefs.length})` : ""}`
      : "";
  const shown = path.chain.slice(0, CHAIN_SHOWN).map((step) => (step.seconds === null ? `${step.ref}(?)` : step.ref));
  const more = path.chainLength > shown.length ? ` > … (+${path.chainLength - shown.length})` : "";
  const flags = [
    path.partial ? `partial: ${path.missing.join(", ")}` : null,
    path.cycle.length > 0 ? `cycle broken at ${path.cycle.join(", ")}` : null,
    path.crossSubtreeBlockerCount > 0
      ? `${path.unresolvedCrossSubtreeBlockerCount} of ${path.crossSubtreeBlockerCount} outside blockers open` +
        (path.unresolvedCrossSubtreeBlockerCount > 0
          ? ` (${path.crossSubtreeBlockers
              .filter((blocker) => !blocker.resolved)
              .map((blocker) => `${blocker.blocked} <- ${blocker.blocker}`)
              .join(", ")})`
          : "")
      : null,
  ].filter((flag): flag is string => flag !== null);
  return [
    `labor ${labor.source === "descendants" && coverage.partial ? "≥" : ""}${hours(labor.seconds)} (${source}) · ${units}${cancelled}${unplanned}`,
    `critical path ${path.seconds !== null && path.partial ? "≥" : ""}${hours(path.seconds)}${shown.length > 0 ? ` · ${shown.join(" > ")}${more}` : ""}${flags.length > 0 ? ` · ${flags.join(" · ")}` : ""}`,
  ];
}

function say(result: PlanComparison): void {
  for (const plan of result.plans) {
    console.log(`${plan.ref} · ${plan.title} (${plan.kind}, ${plan.status})`);
    for (const line of planLines(plan)) console.log(`  ${line}`);
  }
  for (const overlap of result.overlaps) {
    console.log(`note ${overlap.ref} lies inside ${overlap.within}: its labor is already part of ${overlap.within}'s, do not add them`);
  }
}

export function runCompareCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help === true) return console.log(HELP);
  if (positionals.length === 0) {
    throw new StapleError("validation", "staple compare needs at least one issue: staple compare <ref> [<ref> ...].");
  }
  const store = resolveWorkspace({ db: values.db, ws: values.ws }).store;
  const result = store.comparePlans(positionals);
  if (values.json) return console.log(JSON.stringify(result));
  say(result);
}
