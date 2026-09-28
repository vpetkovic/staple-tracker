/**
 * `staple run` — autopilot runs (`src/core/run-store.ts`).
 *
 *   run start --scope <queue|ref> [--max-tickets N] [--until T] [--ceiling P [--ceiling-account A]] [--override -m why]
 *             [--gate-owner W] [--goal-cap N]
 *   run status [<run-id>] [--all]
 *   run stop [<run-id>] [-m why]
 *   run pause|resume [<run-id>]
 *   run continue [--run <run-id>] [--outcome done|failed] [--reason R]
 *   run drive ...   (src/commands/run-drive.ts, dispatched from cli.ts: the one async verb)
 *
 * Every verb is one `RunStore` method, the same one the MCP tools call, and `--json`
 * prints the object that method returns: a run for `start`, `stop`, `pause` and
 * `resume`, `{run, decision, facts}` per run for `status`, and the take / wait / stop
 * answer for `continue` (docs/runs.md). Errors are thrown as `StapleError` and
 * formatted by the top-level catch in cli.ts like every other command's.
 */
import { parseArgs } from "node:util";
import { type ContinueAnswer, type Run, type RunGoalReport, type RunStatus, RUN_TICKET_OUTCOMES, type RunTicketOutcome, scopeLabel } from "../core/run-store.js";
import { resolveWorkspace } from "../core/workspace.js";
import { StapleError } from "../core/types.js";

const USAGE = "Use: start, status, stop, pause, resume, continue, drive (staple run --help)";

const HELP = `staple run — autopilot runs: one agent working a scope ticket after ticket
until a stop rule, run by the tracker, says otherwise.

  run start --scope <queue|ref> [--max-tickets N] [--until T] [--ceiling P [--ceiling-account A]] [--override -m why]
              start a run over the whole queue, an epic or parent (<ref>), or a
              milestone. N caps the distinct tickets it takes (a retry is not
              another); T is an ISO instant with a zone or a duration from now
              (90m, 2h, 1d); P stops it once a current rate-limit window on this
              machine reaches P% used (staple budget), over every account or only
              A. Under queue.policy strict a run follows the whole plan like any
              agent; --override -m why lets it step over the plan, each such take
              recorded as queue_overridden. One live run per actor per scope: a
              second start is refused (conflict, exit 4) naming the first.
              A milestone run is a GOAL run (below): --gate-owner W is the
              person it gates the milestone to (default VP), --goal-cap N how many
              tickets it may create itself (default 5)
  run status [<run-id>] [--all]
              a run, whether a stop rule trips now and why, and the facts behind
              it; with no id, your live runs; --all every run, any actor or state
  run stop [<run-id>] [-m why]
              stop a run (yours when no id is given): stopped_by_human, recorded
              with who and why. Stopping an ended run changes nothing
  run pause|resume [<run-id>]
              hold a live run (yours when no id is given) without ending it, and
              let it take again. A paused run answers continue with wait
  run continue [--run <run-id>] [--outcome done|failed] [--reason R]
              THE call a driver makes after each ticket: records how the last
              ticket ended (stated, else read off your ended attempt, else its
              status; a ticket you still hold is handed back to resume), runs the
              stop rules and answers one action:
                take  {ref, why, resumed}: already claimed for you, work it
                wait  {reason: paused | waiting_on_others | out_of_order,
                      retryAfterSeconds}
                stop  {reason}: a stop reason below, or no_run (you have no live
                      run). Exit 0 for all three; the loop ends on stop
              --outcome failed on a ticket you still hold also releases it. With
              no live run, your last ended run with an unsettled ticket is the
              one continued: its ticket is settled and its stop reason answered
  run drive [--run <run-id> | --scope <queue|ref> ...] --agent <claude|codex|custom>
              loop continue headless: a fresh agent session per ticket, a
              brief each, logs under .staple/runs/<run-id>/; stoppable
              mid-ticket with run stop (staple run drive --help)

Stop reasons, first match wins, stable in --json: stopped_by_human, budget
(detail.budget: tickets | time | ceiling | goal_children), failure_streak (two failed tickets in
a row), scope_gone (the scope issue was deleted or holds nothing any more),
vp_blocked (a ticket the run took is blocked on a person, or nothing is
workable and something in scope is), gate_pending (the scope issue awaits
approval, or nothing is workable and something in scope does), goal_met (a
goal run: nothing unresolved left and every criterion met; ends completed),
scope_empty (nothing unresolved left in scope; the run ends completed). A gate or a
person-owned block elsewhere in scope does not stop a run that still has work to
take. Work only others can move (claimed, blocked by a dependency, in review)
is waiting_on_others: the run waits, it does not end. Actors are compared
exactly, as claims are: "Bot" and "bot" are two actors.

Goal mode. A run over a milestone works toward the milestone's acceptance
criteria. It gates the milestone to its owner at start (and again before it
adds work), so the milestone never closes unreviewed when its last member
lands; its own gate is not a gate_pending stop. When the scope empties, every
criterion met ends goal_met with the milestone left gated. Otherwise the run
creates a goal-check ticket (a member, labelled goal-check) and takes it: the
session judges each criterion with "staple milestone criterion" and files
follow-ups for unmet ones. Every ticket the run creates counts against its cap;
past it the run stops budget (detail.budget goal_children). Each answer of a
goal run carries goal: the criteria with verdicts and evidence, the pace, the
run's tickets against its cap, and the gate.

Runs are local to this machine and never synchronized; their events
(run_started, run_stopped, run_state_changed, run_ticket_taken,
run_ticket_recorded) show in staple events --follow.

  --actor A        who acts; else $STAPLE_AGENT, else $USER
  --json           the run, {runs: [{run, decision, facts, driver}]} for status, or
                   {action, ...} for continue (docs/runs.md)`;

export function positiveInteger(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isInteger(value)) throw new StapleError("validation", `${flag} takes a whole number; got "${raw}".`);
  return value;
}

export function percentOption(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = Number(raw.trim().replace(/%$/, ""));
  if (raw.trim() === "" || !Number.isFinite(value)) throw new StapleError("validation", `${flag} takes a percentage; got "${raw}".`);
  return value;
}

/** A whole number that may be 0 (a goal cap of 0 creates nothing). */
function positiveOrZero(raw: string | undefined, flag: string): number | undefined {
  const value = positiveInteger(raw, flag);
  if (value !== undefined && value < 0) throw new StapleError("validation", `${flag} takes a whole number, 0 or more; got "${raw}".`);
  return value;
}

function budgetText(run: Run): string {
  const parts = [
    run.budget.maxTickets === null ? null : `${run.counts.taken}/${run.budget.maxTickets} tickets`,
    run.budget.until === null ? null : `until ${run.budget.until}`,
    run.budget.ceilingPercent === null ? null : `ceiling ${run.budget.ceilingPercent}%${run.budget.ceilingAccount ? ` of ${run.budget.ceilingAccount}` : ""}`,
  ].filter((part) => part !== null);
  return parts.length === 0 ? "no budget" : parts.join(", ");
}

function printRun(run: Run): void {
  console.log(`run ${run.id}  ${run.state}  ${run.actor} over ${scopeLabel(run.scope)}`);
  console.log(`  started ${run.startedAt} · ${budgetText(run)} · ${run.counts.done} done, ${run.counts.failed} failed, ${run.counts.open} open`);
  if (run.override) console.log(`  steps over the plan: ${run.override}`);
  if (run.goal) {
    const refs = run.goal.children.map((child) => child.identifier).join(", ");
    console.log(`  goal run: gated to ${run.goal.gateOwner}${run.goal.gatedAt ? ` (gate opened ${run.goal.gatedAt})` : ""} · created ${run.goal.children.length}/${run.goal.childCap}${refs ? `: ${refs}` : ""}`);
  }
  for (const ticket of run.tickets) {
    console.log(`  ${String(ticket.seq).padStart(3)}  ${ticket.identifier.padEnd(9)} ${ticket.outcome ?? "open"}${ticket.reason ? `  ${ticket.reason}` : ""}`);
  }
  if (run.stop) {
    const who = run.stop.by ? ` by ${run.stop.by}` : "";
    console.log(`  ended ${run.stop.at}: ${run.stop.reason}${who}${run.stop.note ? ` (${run.stop.note})` : ""}`);
  }
}

function printStatus(status: RunStatus): void {
  printRun(status.run);
  const driver = status.driver;
  if (driver !== null) {
    const state = driver.alive === true ? "attached" : driver.alive === false ? "gone (its process is not running)" : "on another host";
    console.log(`  driver ${driver.agent} pid ${driver.pid} on ${driver.host}: ${state}, heartbeat ${driver.heartbeatAt}${driver.ticket ? `, working ${driver.ticket}` : ""}`);
  }
  if (status.goal) printGoal(status.goal);
  if (status.facts === null) return;
  const decision = status.decision;
  console.log(
    decision.stop
      ? `  would stop: ${decision.reason} — ${decision.message}`
      : decision.goalCheck
        ? `  continues: goal check — ${decision.goalCheck.message}`
        : decision.wait
          ? `  waits: ${decision.wait.reason} — ${decision.wait.message}`
          : `  continues: ${status.facts.workable.length} workable in scope`,
  );
}

function printGoal(goal: RunGoalReport): void {
  const gate = goal.gate === null ? "no gate" : `gate ${goal.gate.state} (${goal.gate.owner}${goal.gate.ownedByRun ? ", the run's" : ""})`;
  console.log(`  goal ${goal.milestone.identifier}: ${goal.counts.met}/${goal.counts.total} criteria met · ${gate} · pace ${goal.pace.verdict}: ${goal.pace.message}`);
  for (const criterion of goal.criteria) {
    const evidence = criterion.evidence.length === 0 ? "" : ` [${criterion.evidence.map((item) => item.value).join(", ")}]`;
    console.log(`    ${String(criterion.position).padStart(2)}. ${criterion.verdict.padEnd(7)} ${criterion.text}${evidence}`);
  }
}

export function runRunCommand(rest: string[]): void {
  const { values, positionals } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      actor: { type: "string" },
      scope: { type: "string" },
      "max-tickets": { type: "string" },
      until: { type: "string" },
      ceiling: { type: "string" },
      "ceiling-account": { type: "string" },
      "gate-owner": { type: "string" },
      "goal-cap": { type: "string" },
      all: { type: "boolean" },
      message: { type: "string", short: "m" },
      run: { type: "string" },
      outcome: { type: "string" },
      reason: { type: "string" },
      override: { type: "boolean" },
    },
  });
  const [sub, id] = positionals;
  // Before the workspace is resolved: help answers in a directory with no workspace.
  if (values.help === true || sub === undefined || sub === "help") return console.log(HELP);
  if (!["start", "status", "stop", "pause", "resume", "continue"].includes(sub)) {
    throw new StapleError("validation", `Unknown run command "${sub}". ${USAGE}`);
  }
  const actor = values.actor ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
  if (sub !== "start" && (values["gate-owner"] !== undefined || values["goal-cap"] !== undefined)) {
    throw new StapleError("validation", `--gate-owner and --goal-cap apply to "run start" only, not "run ${sub}".`);
  }
  if (sub !== "continue" && (values.run !== undefined || values.outcome !== undefined || values.reason !== undefined)) {
    throw new StapleError("validation", `--run, --outcome and --reason apply to "run continue" only, not "run ${sub}".`);
  }
  if (sub !== "start" && values.override !== undefined) {
    throw new StapleError("validation", `--override applies to "run start" only, not "run ${sub}".`);
  }
  const runs = resolveWorkspace({ db: values.db, ws: values.ws }).store.runs();

  if (sub === "start") {
    if (values.scope === undefined) throw new StapleError("validation", "run start needs --scope: queue, or the reference of an epic, a parent or a milestone.");
    const run = runs.start({
      actor,
      scope: values.scope,
      maxTickets: positiveInteger(values["max-tickets"], "--max-tickets"),
      until: values.until,
      ceilingPercent: percentOption(values.ceiling, "--ceiling"),
      ceilingAccount: values["ceiling-account"],
      gateOwner: values["gate-owner"],
      goalChildCap: positiveOrZero(values["goal-cap"], "--goal-cap"),
      // `--override` alone reaches the store as an empty reason and is refused there, as on checkout.
      override: values.override === true ? (values.message ?? "") : undefined,
    });
    if (values.json) return console.log(JSON.stringify(run));
    return printRun(run);
  }

  if (sub === "status") {
    if (id !== undefined) {
      const status = runs.status(id);
      if (values.json) return console.log(JSON.stringify(status));
      return printStatus(status);
    }
    const all = runs.statuses({ actor, all: values.all === true });
    if (values.json) return console.log(JSON.stringify({ runs: all }));
    if (all.length === 0) return console.log(values.all === true ? "no runs" : `no live runs for ${actor} (--all lists every run)`);
    for (const status of all) printStatus(status);
    return;
  }

  if (sub === "continue") {
    if (id !== undefined) throw new StapleError("validation", `run continue takes the run as --run <run-id>, not "${id}".`);
    const outcome = values.outcome;
    if (outcome !== undefined && !(RUN_TICKET_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new StapleError("validation", `--outcome is done or failed; got "${outcome}".`);
    }
    const answer = runs.continue({
      // With --run the run names its actor; an --actor given too must match it.
      actor: values.run !== undefined ? (values.actor ?? null) : actor,
      run: values.run ?? null,
      outcome: outcome as RunTicketOutcome | undefined,
      reason: values.reason ?? null,
    });
    if (values.json) return console.log(JSON.stringify(answer));
    return printAnswer(answer);
  }

  if (sub === "pause" || sub === "resume") {
    const run = runs.setState(id ?? runs.liveRunOf(actor).id, sub === "pause" ? "paused" : "active", actor);
    if (values.json) return console.log(JSON.stringify(run));
    return printRun(run);
  }

  const run = runs.stop(id ?? runs.liveRunOf(actor).id, actor, values.message ?? null);
  if (values.json) return console.log(JSON.stringify(run));
  printRun(run);
}

function printAnswer(answer: ContinueAnswer): void {
  if (answer.recorded) {
    const { ref, outcome, reason, source } = answer.recorded;
    console.log(`recorded ${ref} ${outcome} (${source})${reason ? `: ${reason}` : ""}`);
  }
  if (answer.action === "take") console.log(`take     ${answer.ref} ${answer.title}\n  ${answer.why}`);
  else if (answer.action === "wait") console.log(`wait     ${answer.reason}: ${answer.message} (ask again in ${answer.retryAfterSeconds}s)`);
  else console.log(`stop     ${answer.reason}: ${answer.message}`);
  if (answer.goal) printGoal(answer.goal);
}
