/**
 * `staple attempts <ref>` and `staple attempt <attempt-id>`: the attempt read surfaces
 * (docs/execution-telemetry.md, "Surfaces"). Each is one store method —
 * `WorkspaceStore.listAttempts` and `WorkspaceStore.getAttempt` — that MCP `list_attempts`
 * and `get_attempt` call too, so `--json` and the tools answer one shape.
 */
import { parseArgs } from "node:util";
import type { AttemptView } from "../core/telemetry/attempt-derive.js";
import type { AttemptDetail } from "../core/telemetry/read-attempts.js";
import type { TelemetryPage } from "../core/telemetry/read-page.js";
import { StapleError } from "../core/types.js";
import { resolveWorkspace } from "../core/workspace.js";

const HELP = `staple attempts — the execution attempts on one issue, oldest first

  attempts <ref> [--limit N] [--cursor C]
              every attempt, each as it reads now (an attempt whose claim was moved
              by a path that ran no side effect reads as orphaned, with storedState
              beside it); --limit defaults to 50, at most 500; --cursor is the
              nextCursor of the previous page
  attempt <attempt-id> [--limit N] [--cursor C]
              one attempt: its transitions (bounded as above), its chain and its
              burn from this machine's budget samples

  --json      {items, truncated, nextCursor, coverage}`;

/**
 * `--limit` as a number. Only a value that is no number at all is refused here; whether it is
 * a positive integer is the read's own check (`pageLimit`), so the CLI and MCP refuse
 * `1.5` with one message.
 */
export function limitFlag(raw: string | undefined): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || Number.isNaN(value)) throw new StapleError("validation", `--limit must be a positive integer (max 500); got "${raw}".`);
  return value;
}

const clock = (seconds: number): string => {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  return `${Math.floor(seconds / 3600)}h${String(Math.floor((seconds % 3600) / 60)).padStart(2, "0")}m`;
};

/** One line per attempt, as `show` and `attempts` print it. */
export function attemptLine(view: AttemptView & { readonly quality?: { readonly state: string; readonly reasons: readonly string[] } }): string {
  const end = view.state === "ended" ? ` ${view.outcome ?? "ended"}${view.endReason ? ` (${view.endReason})` : ""}` : ` ${view.state}`;
  const stored = view.storedState !== view.state ? ` [stored ${view.storedState}]` : "";
  const idle = view.idleSeconds !== null ? ` · idle ${clock(view.idleSeconds)}` : "";
  const resumes = view.resumesAttemptId ? " · resumes" : "";
  // The effort figure's quality, only when it is not exact: an exact attempt reads as it always did.
  const quality = view.quality && view.quality.state !== "exact" ? ` · ${view.quality.state}${view.quality.reasons.length > 0 ? ` (${view.quality.reasons.join(", ")})` : ""}` : "";
  return `#${view.ordinal} ${view.agent}${end}${stored} · ran ${clock(view.activeSeconds)}${idle}${resumes}${view.contested ? " · contested" : ""}${quality}  ${view.id}`;
}

function sayPage(page: TelemetryPage<AttemptView>): void {
  if (page.items.length === 0) console.log("no attempts");
  for (const view of page.items) console.log(attemptLine(view));
  for (const gap of page.coverage.gaps) console.log(`  gap ${gap.from} -> ${gap.to} (${gap.reason})`);
  if (page.truncated) console.log(`more: --cursor ${page.nextCursor}`);
}

function sayDetail(detail: AttemptDetail): void {
  const view = detail.attempt;
  console.log(`${view.identifier ?? view.issueId} attempt ${attemptLine(view)}`);
  console.log(`  started ${view.startedAt}${view.endedAt ? `  ended ${view.endedAt}` : view.endedAtBound ? `  ended by ${view.endedAtBound} (not observed)` : ""}`);
  if (detail.chain.length > 1) console.log(`  chain ${detail.chain.map((entry) => `#${entry.ordinal} ${entry.outcome ?? entry.state}`).join(" -> ")}`);
  for (const transition of detail.transitions.items) {
    console.log(`  ${transition.at} ${transition.kind}${transition.reason ? ` (${transition.reason})` : ""}${transition.actor ? ` by ${transition.actor}` : ""}`);
  }
  if (detail.transitions.truncated) console.log(`  more transitions: --cursor ${detail.transitions.nextCursor}`);
  const burn = detail.burn;
  if (burn.limits.length === 0) console.log(`  burn unknown (${Object.values(burn.missing)[0] ?? "no readings"})`);
  for (const limit of burn.limits) {
    // A lower bound reads as one: usage before the first reading inside the attempt was not seen.
    const value =
      limit.burnPercent === null
        ? `unknown (${Object.values(limit.missing)[0] ?? "no readings"})`
        : `${limit.lowerBound ? "≥" : ""}${limit.burnPercent}%${limit.partial ? " (partial)" : ""}`;
    const attribution = burn.attribution ?? (limit.burnPercent === null ? null : `attribution unknown (${burn.missing.attribution ?? "input_missing"})`);
    console.log(`  burn ${limit.limitKey.padEnd(18)} ${value}${attribution ? ` · ${attribution}` : ""}`);
  }
}

/** `staple attempt <attempt-id>`, from `runAttemptCommand` when the first word is no verb. */
export function showAttempt(values: { db?: string; ws?: string; json?: boolean; limit?: string; cursor?: string }, attemptId: string): void {
  const store = resolveWorkspace({ db: values.db, ws: values.ws }).store;
  const detail = store.getAttempt(attemptId, { limit: limitFlag(values.limit), cursor: values.cursor });
  if (values.json) return console.log(JSON.stringify(detail));
  sayDetail(detail);
}

export function runAttemptsCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      limit: { type: "string" },
      cursor: { type: "string" },
    },
  });
  const [ref] = positionals;
  if (values.help === true) return console.log(HELP);
  if (ref === undefined) throw new StapleError("validation", "staple attempts needs the issue: staple attempts <ref>.");
  const store = resolveWorkspace({ db: values.db, ws: values.ws }).store;
  const page = store.listAttempts(ref, { limit: limitFlag(values.limit), cursor: values.cursor });
  if (values.json) return console.log(JSON.stringify(page));
  sayPage(page);
}
