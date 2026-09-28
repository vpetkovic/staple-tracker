/**
 * `staple run drive`: the headless driver (`src/core/run-driver.ts`, docs/runs.md).
 *
 *   run drive [--run <id> | --scope <queue|ref> [start options]] --agent <claude|codex|custom>
 *             [--command "<template>"] [--model M] [--full-access] [--finish in_review|done]
 *             [--ticket-timeout D] [--retry-after S] [--poll S] [--instructions <file>]
 *             [--cwd <dir>] [--forget-stale-session] [--dry-run]
 *
 * The one async verb of `staple run`: it lives for as long as the run, so its failures are
 * reported by `settle()` rather than the synchronous top-level catch. It has no MCP twin:
 * an MCP call answers and returns, and a driver is a process that owns child sessions for
 * hours. `run_status` shows an attached driver, and `stop_run` stops it.
 */
import { readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { DRIVE_PROVIDERS, PLACEHOLDERS, type DriveEvent, assertNoLiveDriver, drive, sessionCommand } from "../core/run-driver.js";
import { buildBrief, type DriveFinish } from "../core/run-brief.js";
import { runDirectory } from "../core/run-attachment.js";
import type { Run } from "../core/run-store.js";
import { parseRelativeSeconds } from "../core/telemetry/formats.js";
import { resolveWorkspace } from "../core/workspace.js";
import { StapleError } from "../core/types.js";
import { settle } from "./cloud.js";
import { percentOption, positiveInteger } from "./run.js";

export const DRIVE_HELP = `staple run drive — work a run headless: a FRESH agent session per ticket.

  run drive [--run <id> | --scope <queue|ref> [--max-tickets N] [--until T] [--ceiling P [--ceiling-account A]]
            [--gate-owner W] [--goal-cap N]] --agent <${[...Object.keys(DRIVE_PROVIDERS), "custom"].join("|")}> [--command "<template>"] [--model M]
            [--full-access] [--finish in_review|done] [--ticket-timeout D] [--retry-after S] [--poll S]
            [--instructions F] [--cwd DIR] [--forget-stale-session] [--dry-run] [--json]

Loops "run continue" in this process. On take, it writes a brief for the ticket
and launches one headless session with it, waits for the session, and states
how it ended on the next continue; on wait it sleeps and asks again; on stop it
prints the reason and exits 0. Non-zero only for a driver error.

  --run <id>          drive this run; else --scope starts one (with the start
                      options of "run start"); else your one live run
  --agent A           ${Object.entries(DRIVE_PROVIDERS)
    .map(([name, row]) => `${name}: ${row.summary}`)
    .join("\n                      ")}
                      custom: --command, run by /bin/sh with placeholders
                      ${PLACEHOLDERS.map((name) => `{${name}}`).join(" ")}
                      substituted shell-quoted
  --model M           the provider's model flag (e.g. haiku); {model} in a template
  --full-access       give sessions the provider's allow-everything switch for
                      this run (claude: --permission-mode bypassPermissions;
                      codex: --dangerously-bypass-approvals-and-sandbox). Off by
                      default: sessions get what the provider is configured to
                      allow, as any session you open there would
  --finish F          where the brief tells a session to move its ticket:
                      in_review (default; a person closes it) or done
  --ticket-timeout D  end a session after D (90m, 2h); the ticket fails
  --retry-after S     seconds to sleep on a wait, above 0 (default: the answer's)
  --poll S            seconds between reads of the run while a session works (5)
  --instructions F    append this file to every brief (gates, conventions)
  --cwd DIR           where sessions run (default: the workspace's directory)
  --dry-run           start nothing, claim nothing: print the command and the
                      brief the next ticket would get
  --forget-stale-session
                      a driver that died left its session's process group
                      running: go on without ending it. Without this the
                      driver refuses, naming the group; it never kills a
                      process it cannot prove is its own (pids are reused)

Each session runs in its own process group with STAPLE_AGENT (the run's actor),
STAPLE_DB (this workspace) and STAPLE_RUN set, and logs to
<.staple>/runs/<run-id>/ (git-ignored), printed at start. "staple run stop"
from anywhere ends the session within one poll: its ticket is recorded failed
(stopped_by_human) and released, and the driver exits. A pause lets the
session finish and then waits. Outcome: exit 0 with the ticket moved on is
read by the tracker (review or done counts as done); a non-zero exit, a
timeout, exit 0 with the ticket still held, or a ticket handed on without
its "review: ..." comment (no_review) is failed, with the reason.

The driver lands nothing on master and runs no version control itself; the
brief tells each session to leave its work on a branch (autopilot/<ref>, each
off the last: a stack) for a person to take in.

  --json              one JSON object per line: attached, take, session_started,
                      session_ended, wait, stop`;

function seconds(raw: string | undefined, flag: string): number | null {
  if (raw === undefined) return null;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0) throw new StapleError("validation", `${flag} takes a number of seconds; got "${raw}".`);
  return value;
}

function duration(raw: string | undefined, flag: string): number | null {
  if (raw === undefined) return null;
  const value = parseRelativeSeconds(raw) ?? (/^\d+$/.test(raw.trim()) ? Number(raw) : null);
  if (value === null || value <= 0) throw new StapleError("validation", `${flag} takes a duration (90s, 30m, 2h); got "${raw}".`);
  return value;
}

/** A workspace at `<dir>/.staple/staple.db` (or the legacy `.tasks/`) is worked in `<dir>`. */
function workspaceDirectory(dbFile: string): string {
  const parent = dirname(dbFile);
  return [".staple", ".tasks"].includes(basename(parent)) ? dirname(parent) : process.cwd();
}

export function runDriveCommand(rest: string[]): void {
  const { values } = parseArgs({
    args: rest,
    options: {
      db: { type: "string" },
      ws: { type: "string" },
      json: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      actor: { type: "string" },
      run: { type: "string" },
      scope: { type: "string" },
      "max-tickets": { type: "string" },
      until: { type: "string" },
      ceiling: { type: "string" },
      "ceiling-account": { type: "string" },
      "gate-owner": { type: "string" },
      "goal-cap": { type: "string" },
      agent: { type: "string" },
      command: { type: "string" },
      model: { type: "string" },
      "full-access": { type: "boolean" },
      finish: { type: "string" },
      "ticket-timeout": { type: "string" },
      "retry-after": { type: "string" },
      poll: { type: "string" },
      instructions: { type: "string" },
      cwd: { type: "string" },
      "dry-run": { type: "boolean" },
      "forget-stale-session": { type: "boolean" },
    },
  });
  if (values.help === true) return console.log(DRIVE_HELP);
  const json = values.json === true;

  if (values.agent === undefined) throw new StapleError("validation", `run drive needs --agent: ${[...Object.keys(DRIVE_PROVIDERS), "custom"].join(", ")}.`);
  const finish = (values.finish ?? "in_review") as DriveFinish;
  if (finish !== "in_review" && finish !== "done") throw new StapleError("validation", `--finish is in_review or done; got "${values.finish}".`);
  if (values.run !== undefined && values.scope !== undefined) throw new StapleError("validation", "Give --run <id> to drive a run, or --scope to start one, not both.");
  const startOptions = ["max-tickets", "until", "ceiling", "ceiling-account", "gate-owner", "goal-cap"] as const;
  if (values.scope === undefined && startOptions.some((flag) => values[flag] !== undefined)) {
    throw new StapleError("validation", "--max-tickets, --until, --ceiling, --gate-owner and --goal-cap start a run; they need --scope.");
  }
  const timeout = duration(values["ticket-timeout"], "--ticket-timeout");
  const retryAfter = seconds(values["retry-after"], "--retry-after");
  // Zero would ask again in a tight loop, starving everything else the process does.
  if (retryAfter !== null && retryAfter <= 0) throw new StapleError("validation", `--retry-after takes a number of seconds above 0; got "${values["retry-after"]}".`);
  const poll = seconds(values.poll, "--poll") ?? 5;
  if (poll <= 0) throw new StapleError("validation", `--poll takes a number of seconds above 0; got "${values.poll}".`);
  const instructions = values.instructions === undefined ? null : readFileSync(values.instructions, "utf8");
  const command = values.command ?? null;
  // Refuse a bad provider or template before a run is started or a ticket claimed.
  const probe = Object.fromEntries(PLACEHOLDERS.map((name) => [name, `{${name}}`])) as Parameters<typeof sessionCommand>[2];
  const fullAccess = values["full-access"] === true;
  sessionCommand(values.agent, command, probe, { fullAccess });

  const actor = values.actor ?? process.env.STAPLE_AGENT ?? process.env.USER ?? "user";
  const opened = resolveWorkspace({ db: values.db, ws: values.ws });
  const dbFile = resolve(opened.dbPath);
  const { store } = opened;
  const runs = store.runs();
  const cwd = resolve(values.cwd ?? workspaceDirectory(dbFile));

  // What --scope starts, read once: the dry run previews exactly this and refuses what start refuses.
  const startInput =
    values.scope === undefined
      ? null
      : {
          actor,
          scope: values.scope,
          maxTickets: positiveInteger(values["max-tickets"], "--max-tickets"),
          until: values.until,
          ceilingPercent: percentOption(values.ceiling, "--ceiling"),
          ceilingAccount: values["ceiling-account"],
          gateOwner: values["gate-owner"],
          goalChildCap: positiveInteger(values["goal-cap"], "--goal-cap"),
        };

  if (values["dry-run"] === true) return dryRun();

  let run: Run;
  if (startInput !== null) {
    run = runs.start(startInput);
  } else {
    run = values.run !== undefined ? runs.get(values.run) : runs.liveRunOf(actor);
    if (values.actor !== undefined && values.actor !== run.actor) {
      throw new StapleError("validation", `Run ${run.id} is ${run.actor}'s, not ${values.actor}'s; only its actor drives it.`, { runId: run.id, actor: run.actor });
    }
  }
  assertNoLiveDriver(dbFile, run.id);

  /**
   * The handler stays installed for the driver's whole life: the first SIGINT or SIGTERM
   * ends the session (TERM, then KILL after the grace) and the driver; a second one KILLs
   * the session at once. Were it removed after the first, the second would take Node's
   * default action and kill the driver mid-grace, leaving the session running.
   */
  const controller = new AbortController();
  const force = new AbortController();
  const interrupt = (): void => (controller.signal.aborted ? force.abort() : controller.abort());
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  settle(
    (async () => {
      try {
        const result = await drive({
          store,
          runs,
          dbFile,
          runId: run.id,
          agent: values.agent!,
          command,
          model: values.model ?? null,
          fullAccess,
          finish,
          cwd,
          instructions,
          ticketTimeoutMs: timeout === null ? null : timeout * 1000,
          retryAfterSeconds: retryAfter,
          pollMs: poll * 1000,
          killGraceMs: 5000,
          env: process.env,
          signal: controller.signal,
          force: force.signal,
          forgetStaleSession: values["forget-stale-session"] === true,
          report: (event) => (json ? console.log(JSON.stringify(event)) : printEvent(event)),
        });
        if (result.interrupted) {
          if (!json) {
            console.log(
              `interrupted: the session was ended and its ticket left held; run ${run.id} is still ${runs.get(run.id).state}. ` +
                `staple run drive --run ${run.id} resumes it, staple run stop ${run.id} ends it`,
            );
          }
          process.exitCode = 130;
        }
      } finally {
        process.off("SIGINT", interrupt);
        process.off("SIGTERM", interrupt);
      }
    })(),
    json,
  );

  function dryRun(): void {
    // First, as start would: a bad option, or a live run of the actor's over the scope, is refused.
    const preview = startInput === null ? null : runs.previewStart(startInput);
    const existing = values.scope === undefined ? (values.run !== undefined ? runs.get(values.run) : runs.liveRunOf(actor)) : null;
    let next: { ref: string; title: string } | null = null;
    if (existing !== null) {
      const facts = runs.status(existing.id).facts;
      const pick = facts?.workable[0];
      if (pick) next = { ref: pick.identifier, title: store.getIssue(pick.issueId).title };
    } else {
      const row = store.queue().effectiveQueue({ actor, scope: values.scope === "queue" ? null : values.scope }).next;
      if (row) next = { ref: row.identifier, title: row.title };
    }
    const runId = existing?.id ?? "<new run>";
    const logDir = runDirectory(dbFile, runId);
    const ref = next?.ref ?? "<ref>";
    const brief = buildBrief({ ref, title: next?.title ?? "<title>", workspace: cwd, db: dbFile, runId, actor: existing?.actor ?? actor, finish, instructions, goal: existing ? runs.goalReport(existing) : (preview?.goal ?? null) });
    const briefFile = `${logDir}/001-${ref}.brief.md`;
    const shown = sessionCommand(values.agent!, command, {
      ref,
      title: next?.title ?? "<title>",
      brief,
      brief_file: briefFile,
      workspace: cwd,
      db: dbFile,
      run: runId,
      actor: existing?.actor ?? actor,
      model: values.model ?? "",
      log_dir: logDir,
    }, { fullAccess });
    const env = { STAPLE_AGENT: existing?.actor ?? actor, STAPLE_DB: dbFile, STAPLE_RUN: runId, STAPLE_RUN_TICKET: ref };
    if (json) {
      console.log(JSON.stringify({ dryRun: true, run: runId, next, cwd, env, unsetEnv: shown.unsetEnv, file: shown.file, args: shown.args, command: shown.display, briefFile, brief }));
      return;
    }
    console.log(`dry run: nothing started, nothing claimed`);
    console.log(`run      ${runId}${next ? `; next ticket ${next.ref} ${next.title}` : "; no ticket is takeable now"}`);
    console.log(`cwd      ${cwd}`);
    console.log(`env      ${Object.entries(env).map(([key, value]) => `${key}=${value}`).join(" ")}${shown.unsetEnv.length ? ` (unset ${shown.unsetEnv.join(" ")})` : ""}`);
    console.log(`command  ${shown.display}`);
    console.log(`brief    ${briefFile}\n\n${brief}`);
  }
}

function printEvent(event: DriveEvent): void {
  switch (event.event) {
    case "attached":
      return console.log(`driving run ${event.runId} with ${event.agent} (pid ${event.pid} on ${event.host})\nlogs     ${event.logDir}`);
    case "stale_session_forgotten":
      return console.log(`going on past process group ${event.pid}, left by a dead driver (pid ${event.driverPid})${event.ticket ? ` on ${event.ticket}` : ""}: not ended (--forget-stale-session)`);
    case "main_line_unguarded":
      return console.error(`warning  the main line is not guarded: ${event.reason}`);
    case "main_line_moved":
      return console.log(`STOPPING ${event.ref}'s session moved the main line (${event.moves.join(", ")}): recorded failed, run stopped for a person to look`);
    case "take":
      if (event.recorded) console.log(`recorded ${event.recorded.ref} ${event.recorded.outcome}${event.recorded.reason ? `: ${event.recorded.reason}` : ""}`);
      return console.log(`take     ${event.ref} ${event.title}${event.resumed ? " (resumed)" : ""}`);
    case "session_started":
      return console.log(`session  pid ${event.pid}: ${event.command.length > 160 ? `${event.command.slice(0, 157)}...` : event.command}\n         stdout ${event.stdout}\n         stderr ${event.stderr}`);
    case "session_ended": {
      const how = event.ended === "exited" ? `exited ${event.exitCode ?? event.signal}` : event.ended;
      return console.log(`ended    ${event.ref} ${how} after ${event.seconds}s${event.outcome ? ` -> ${event.outcome}: ${event.reason}` : " -> the tracker reads the outcome"}`);
    }
    case "wait":
      if (event.recorded) console.log(`recorded ${event.recorded.ref} ${event.recorded.outcome}${event.recorded.reason ? `: ${event.recorded.reason}` : ""}`);
      return console.log(`wait     ${event.reason}: ${event.message} (again in ${event.retryAfterSeconds}s)`);
    case "stop":
      if (event.recorded) console.log(`recorded ${event.recorded.ref} ${event.recorded.outcome}${event.recorded.reason ? `: ${event.recorded.reason}` : ""}`);
      return console.log(`stop     ${event.reason}: ${event.message}`);
  }
}
