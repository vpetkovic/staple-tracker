/**
 * `staple run drive`: the headless driver. It loops {@link RunStore.continue} in-process and,
 * for every `take`, launches a FRESH headless agent session on that ticket, waits for it,
 * and reports how it ended on the next `continue`. The tracker decides; the driver only
 * does what the answer says (docs/runs.md, "run drive").
 *
 * ## Providers are rows
 *
 * {@link DRIVE_PROVIDERS} holds one row per agent CLI with a headless mode: the executable,
 * its arguments with `{placeholder}`s, how a model is chosen, and environment it must not
 * inherit. Adding a provider is a row. `custom` is a shell command template with the same
 * placeholders ({@link PLACEHOLDERS}), each substituted shell-quoted.
 *
 * ## One session, one process group
 *
 * A session is spawned detached, so it leads its own process group, and everything it
 * starts (tool shells, sub-agents) is signalled with it: TERM, then KILL after a grace. The
 * driver polls the run while the session works. A run that ENDS (somebody ran `run stop`,
 * or a budget ran out on the clock) kills the session; a run that is PAUSED lets the
 * session finish, since pausing is not stopping. A killed session's ticket is stated
 * `failed` with the reason, which releases the claim and ends its attempt, so the ticket
 * goes back to the queue instead of staying held by a session that no longer exists.
 *
 * ## Outcomes
 *
 *   killed by a stop         failed, `stopped_by_human: …` (or the stop reason)
 *   driver interrupted       nothing: the session is ended, the ticket stays held and
 *                            the next driver's continue hands it back (resumed)
 *   past --ticket-timeout    failed, `timed out after …`
 *   non-zero exit            failed, `session exited N`
 *   exit 0, still held       failed: the session ended without handing the ticket on
 *   exit 0, no review        failed, `no_review`: the brief's review comment is missing
 *   exit 0, handed on        nothing stated: the tracker reads the ended attempt or the
 *                            status (review or done is done) and records it
 *
 * ## No git
 *
 * The driver spawns exactly one kind of process, the provider's session, and runs no
 * version control of its own. The brief (`run-brief.ts`) tells the session to leave its
 * work on a branch and never to land it on the main line.
 */
import { spawn } from "node:child_process";
import { closeSync, openSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { clearDriver, ensureRunDirectory, readDriver, writeDriver, type DriverRecord } from "./run-attachment.js";
import { buildBrief, type DriveFinish } from "./run-brief.js";
import type { ContinueAnswer, RunStore, RunTicketOutcome } from "./run-store.js";
import type { WorkspaceStore } from "./store.js";
import { StapleError, nowIso } from "./types.js";

/** A headless agent CLI, as data. */
export interface DriveProvider {
  /** The executable, looked up on PATH. */
  file: string;
  /** Its arguments; each `{placeholder}` is replaced by its value, unquoted (no shell). */
  args: readonly string[];
  /** Appended when `--model` is given. */
  modelArgs: readonly string[];
  /** Appended only with `--full-access`: the CLI's own "ask nobody, allow everything" switch. */
  fullAccessArgs: readonly string[];
  /** Variables the session must not inherit. */
  unsetEnv: readonly string[];
  /** One line for `run drive --help`. */
  summary: string;
}

/**
 * The built-in providers. Each runs one prompt to completion headless, and by default
 * with NO permission flag of its own: a session gets exactly what that CLI is configured
 * to allow (Claude Code's settings files, Codex's config.toml), the same as any session
 * you would open there yourself. The driver never widens that on its own. A session that
 * needs a permission it does not have ends without handing its ticket on, which is
 * recorded failed, and two in a row stop the run. `--full-access` appends each row's
 * `fullAccessArgs` for one run, when a person asks for it.
 */
export const DRIVE_PROVIDERS: Readonly<Record<string, DriveProvider>> = {
  claude: {
    file: "claude",
    args: ["-p", "{brief}", "--output-format", "json", "--no-session-persistence"],
    modelArgs: ["--model", "{model}"],
    fullAccessArgs: ["--permission-mode", "bypassPermissions"],
    // Set inside a Claude Code session; a nested headless session must start as its own.
    unsetEnv: ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT"],
    summary: "claude -p <brief> --output-format json (permissions: your Claude Code settings)",
  },
  codex: {
    file: "codex",
    args: ["exec", "--color", "never", "-C", "{workspace}", "{brief}"],
    modelArgs: ["-m", "{model}"],
    // Codex's workspace-write sandbox keeps .git read-only, so only full access can branch.
    fullAccessArgs: ["--dangerously-bypass-approvals-and-sandbox"],
    unsetEnv: [],
    summary: "codex exec -C <workspace> <brief> (permissions: your Codex config)",
  },
};

/** The placeholders a provider row or a `--command` template may use. */
export const PLACEHOLDERS = ["ref", "title", "brief", "brief_file", "workspace", "db", "run", "actor", "model", "log_dir"] as const;
export type Placeholder = (typeof PLACEHOLDERS)[number];
export type PlaceholderValues = Record<Placeholder, string>;

/** What the driver runs for one session. */
export interface SessionCommand {
  file: string;
  args: string[];
  /** A copy-pasteable shell line for the same command (the brief as `"$(cat <brief_file>)"`). */
  display: string;
  unsetEnv: readonly string[];
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\-./:=@%+,]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function substitute(template: string, values: PlaceholderValues, quote: (value: string) => string): string {
  return template.replace(/\{([a-z_]+)\}/g, (whole, name: string) =>
    (PLACEHOLDERS as readonly string[]).includes(name) ? quote(values[name as Placeholder]) : whole,
  );
}

/**
 * The command for one session: a provider row with its placeholders filled, or a custom
 * template run by `/bin/sh -c` with every value shell-quoted.
 */
export function sessionCommand(
  agent: string,
  template: string | null,
  values: PlaceholderValues,
  options: { fullAccess?: boolean } = {},
): SessionCommand {
  const briefShown = { ...values, brief: `$(cat ${shellQuote(values.brief_file)})` };
  if (agent === "custom") {
    if (template === null || template.trim() === "") throw new StapleError("validation", "--agent custom needs --command \"<template>\".");
    if (options.fullAccess === true) {
      throw new StapleError("validation", "--full-access applies to the built-in providers; a --command template states its own permissions.");
    }
    const line = substitute(template, values, shellQuote);
    const shown = substitute(template, briefShown, (value) => (value === briefShown.brief ? `"${value}"` : shellQuote(value)));
    return { file: "/bin/sh", args: ["-c", line], display: shown, unsetEnv: [] };
  }
  const provider = DRIVE_PROVIDERS[agent];
  if (provider === undefined) {
    throw new StapleError("validation", `Unknown --agent "${agent}". Use ${[...Object.keys(DRIVE_PROVIDERS), "custom"].join(", ")}.`);
  }
  if (template !== null) throw new StapleError("validation", `--command applies to --agent custom only, not "${agent}".`);
  const raw = [
    ...provider.args,
    ...(options.fullAccess === true ? provider.fullAccessArgs : []),
    ...(values.model === "" ? [] : provider.modelArgs),
  ];
  const args = raw.map((arg) => substitute(arg, values, (value) => value));
  const shown = raw.map((arg) => (arg === "{brief}" ? `"${briefShown.brief}"` : shellQuote(substitute(arg, values, (value) => value))));
  return { file: provider.file, args, display: [provider.file, ...shown].join(" "), unsetEnv: provider.unsetEnv };
}

/** How one session ended. */
export interface SessionResult {
  ended: "exited" | "timeout" | "stopped" | "interrupted";
  exitCode: number | null;
  signal: string | null;
  seconds: number;
  /** For `stopped`: the reason the run ended with. */
  stopReason: string | null;
}

/** What the driver reports as it goes: one JSON line each under `--json`. */
export type DriveEvent =
  | { event: "attached"; runId: string; pid: number; host: string; agent: string; logDir: string }
  | { event: "take"; ref: string; title: string; resumed: boolean; why: string; recorded: ContinueAnswer["recorded"] }
  | { event: "session_started"; ref: string; pid: number; command: string; brief: string; stdout: string; stderr: string }
  | { event: "session_ended"; ref: string; ended: SessionResult["ended"]; exitCode: number | null; signal: string | null; seconds: number; outcome: RunTicketOutcome | null; reason: string | null }
  | { event: "wait"; reason: string; message: string; retryAfterSeconds: number; recorded: ContinueAnswer["recorded"] }
  | { event: "stop"; reason: string; message: string; detail: Record<string, unknown>; recorded: ContinueAnswer["recorded"] };

export interface DriveOptions {
  store: WorkspaceStore;
  runs: RunStore;
  dbFile: string;
  runId: string;
  agent: string;
  command: string | null;
  model: string | null;
  /** Append each provider's full-access switch (`--full-access`); off by default. */
  fullAccess: boolean;
  finish: DriveFinish;
  cwd: string;
  instructions: string | null;
  /** Kill a session after this long; null for no limit. */
  ticketTimeoutMs: number | null;
  /** Overrides the answer's retryAfterSeconds on a wait. */
  retryAfterSeconds: number | null;
  /** How often the run is read (and the heartbeat written) while a session works or the driver waits. */
  pollMs: number;
  /** Between TERM and KILL. */
  killGraceMs: number;
  /** The environment sessions inherit, before the driver's own variables. */
  env: NodeJS.ProcessEnv;
  /** Aborted when the driver itself is interrupted (SIGINT, SIGTERM). */
  signal?: AbortSignal;
  report: (event: DriveEvent) => void;
}

export interface DriveResult {
  /** The last answer: always a stop, unless the driver was interrupted. */
  answer: ContinueAnswer;
  interrupted: boolean;
  sessions: number;
}

/**
 * Refuse a second driver on a run that has one alive on this host: two drivers would
 * each take tickets and launch sessions into the same checkout.
 */
export function assertNoLiveDriver(dbFile: string, runId: string): void {
  const driver = readDriver(dbFile, runId);
  if (driver !== null && driver.alive === true && driver.pid !== process.pid) {
    throw new StapleError("conflict", `Run ${runId} already has a driver: pid ${driver.pid} on ${driver.host}, heartbeat ${driver.heartbeatAt}. Stop it first (staple run stop ${runId}).`, {
      runId,
      driver,
    });
  }
}

/**
 * Drive a run until `continue` answers `stop`. Resolves with the stop answer; rejects only
 * on a driver error (the store refusing, the provider not found on PATH, the disk).
 */
export async function drive(options: DriveOptions): Promise<DriveResult> {
  const { runs, store, dbFile, runId } = options;
  assertNoLiveDriver(dbFile, runId);
  const logDir = ensureRunDirectory(dbFile, runId);
  const record: DriverRecord = {
    pid: process.pid,
    host: hostname(),
    agent: options.agent,
    startedAt: nowIso(),
    heartbeatAt: nowIso(),
    ticket: null,
    sessionPid: null,
    logDir,
  };
  const beat = (change: Partial<DriverRecord> = {}): void => {
    Object.assign(record, change, { heartbeatAt: nowIso() });
    writeDriver(dbFile, runId, record);
  };
  beat();
  options.report({ event: "attached", runId, pid: record.pid, host: record.host, agent: options.agent, logDir });

  let sessions = 0;
  let stated: { outcome?: RunTicketOutcome; reason?: string } = {};
  try {
    for (;;) {
      const answer = runs.continue({ run: runId, outcome: stated.outcome, reason: stated.reason ?? null });
      stated = {};
      if (answer.action === "stop") {
        options.report({ event: "stop", reason: answer.reason, message: answer.message, detail: answer.detail, recorded: answer.recorded });
        return { answer, interrupted: false, sessions };
      }
      if (options.signal?.aborted) return { answer, interrupted: true, sessions };
      if (answer.action === "wait") {
        const seconds = options.retryAfterSeconds ?? answer.retryAfterSeconds;
        options.report({ event: "wait", reason: answer.reason, message: answer.message, retryAfterSeconds: seconds, recorded: answer.recorded });
        await waitWhileLive(options, seconds * 1000, beat);
        if (options.signal?.aborted) return { answer, interrupted: true, sessions };
        continue;
      }

      options.report({ event: "take", ref: answer.ref, title: answer.title, resumed: answer.resumed, why: answer.why, recorded: answer.recorded });
      sessions += 1;
      const seq = answer.run.tickets.at(-1)?.seq ?? sessions;
      const stem = join(logDir, `${String(seq).padStart(3, "0")}-${answer.ref}${answer.resumed ? `-resumed-${sessions}` : ""}`);
      const values: PlaceholderValues = {
        ref: answer.ref,
        title: answer.title,
        brief: buildBrief({
          ref: answer.ref,
          title: answer.title,
          workspace: options.cwd,
          db: dbFile,
          runId,
          actor: answer.run.actor,
          finish: options.finish,
          instructions: options.instructions,
          goal: answer.goal,
          goalCheck: answer.run.goal?.children.some((child) => child.identifier === answer.ref && child.purpose === "goal_check") ?? false,
        }),
        brief_file: `${stem}.brief.md`,
        workspace: options.cwd,
        db: dbFile,
        run: runId,
        actor: answer.run.actor,
        model: options.model ?? "",
        log_dir: logDir,
      };
      writeFileSync(values.brief_file, values.brief);
      const command = sessionCommand(options.agent, options.command, values, { fullAccess: options.fullAccess });
      const env: NodeJS.ProcessEnv = { ...options.env, STAPLE_AGENT: answer.run.actor, STAPLE_DB: dbFile, STAPLE_RUN: runId, STAPLE_RUN_TICKET: answer.ref };
      for (const name of command.unsetEnv) delete env[name];

      const sessionStartedAt = nowIso();
      const result = await runSession(options, command, env, { stdout: `${stem}.stdout.log`, stderr: `${stem}.stderr.log`, ref: answer.ref, brief: values.brief_file }, beat);
      stated = outcomeOf(store, answer.run.actor, answer.ref, result, options.ticketTimeoutMs, sessionStartedAt);
      options.report({
        event: "session_ended",
        ref: answer.ref,
        ended: result.ended,
        exitCode: result.exitCode,
        signal: result.signal,
        seconds: result.seconds,
        outcome: stated.outcome ?? null,
        reason: stated.reason ?? null,
      });
      beat({ ticket: null, sessionPid: null });
      // Nothing is recorded: the ticket stays held, and the next driver's continue hands it back (resumed).
      if (result.ended === "interrupted") return { answer, interrupted: true, sessions };
    }
  } finally {
    clearDriver(dbFile, runId);
  }
}

/**
 * What the next `continue` states about the session's ticket. Nothing, when the session
 * exited cleanly and the ticket left its hands: the tracker reads that off the attempt or
 * the status.
 */
function outcomeOf(
  store: WorkspaceStore,
  actor: string,
  ref: string,
  result: SessionResult,
  timeoutMs: number | null,
  sessionStartedAt: string,
): { outcome?: RunTicketOutcome; reason?: string } {
  if (result.ended === "stopped") return { outcome: "failed", reason: `${result.stopReason ?? "stopped_by_human"}: the driver ended the session after ${result.seconds}s` };
  if (result.ended === "interrupted") return {};
  if (result.ended === "timeout") return { outcome: "failed", reason: `timed out: the session ran past ${Math.round((timeoutMs ?? 0) / 1000)}s and was ended` };
  if (result.exitCode !== 0) {
    return { outcome: "failed", reason: `session exited ${result.exitCode ?? `on ${result.signal ?? "a signal"}`}` };
  }
  const issue = store.getIssue(ref);
  if (issue.checkoutAgent === actor && store.isActiveStatus(issue.status)) {
    return { outcome: "failed", reason: `session exited 0 but left ${ref} ${issue.status} and still held` };
  }
  /**
   * The brief's review step is the one part of it the tracker can check: a session that
   * handed its ticket on without recording its review (`review: ...`) did not finish the
   * job it was given, whatever state it left the ticket in. Green gates are not evidence.
   */
  const reviewed = store
    .listComments(ref, 1000)
    // Anyone's: the brief lets the session hand the review to a separate reviewer.
    .some((comment) => comment.createdAt >= sessionStartedAt && /^\s*review:/i.test(comment.body));
  if (!reviewed) {
    return { outcome: "failed", reason: `no_review: the session handed ${ref} on without a "review: ..." comment` };
  }
  return {};
}

/** Sleep up to `ms`, reading the run each poll: an ended run cuts the wait short (the next continue says why). */
async function waitWhileLive(options: DriveOptions, ms: number, beat: () => void): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (options.signal?.aborted || !isLive(options.runs, options.runId)) return;
    await sleep(Math.min(options.pollMs, until - Date.now()), options.signal);
    beat();
  }
}

function isLive(runs: RunStore, runId: string): boolean {
  const state = runs.get(runId).state;
  return state === "active" || state === "paused";
}

/**
 * `unref`: for a sleep raced against the session's exit, which must not hold the process
 * open for the rest of its timer once the race is decided. A sleep that IS the wait keeps
 * its reference, or the process would exit in the middle of it.
 */
function sleep(ms: number, signal?: AbortSignal, unref = false): Promise<void> {
  return new Promise((resolve) => {
    if (ms <= 0 || signal?.aborted) return resolve();
    const timer = setTimeout(done, ms);
    if (unref) timer.unref();
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Run one session to its end: spawned detached (its own process group) with stdout and
 * stderr to the run's log files, the run polled every `pollMs`. An ended run, the ticket
 * timeout or the driver's own interruption kills the whole group.
 */
async function runSession(
  options: DriveOptions,
  command: SessionCommand,
  env: NodeJS.ProcessEnv,
  files: { stdout: string; stderr: string; ref: string; brief: string },
  beat: (change?: Partial<DriverRecord>) => void,
): Promise<SessionResult> {
  const out = openSync(files.stdout, "a");
  const err = openSync(files.stderr, "a");
  const started = Date.now();
  let child;
  try {
    child = spawn(command.file, command.args, { cwd: options.cwd, env, detached: true, stdio: ["ignore", out, err] });
  } finally {
    closeSync(out);
    closeSync(err);
  }
  const exited = new Promise<{ code: number | null; signal: string | null }>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
  // A missing executable is a driver error, not a failed ticket: nothing ran.
  const spawned = await Promise.race([exited.then(() => "exited" as const), new Promise<"spawned">((resolve) => child.once("spawn", () => resolve("spawned")))]).catch(
    (error: NodeJS.ErrnoException) => {
      throw new StapleError("validation", `Could not start the ${options.agent} session (${command.file}): ${error.message}.`, { command: command.display });
    },
  );
  const pid = child.pid!;
  options.report({ event: "session_started", ref: files.ref, pid, command: command.display, brief: files.brief, stdout: files.stdout, stderr: files.stderr });
  beat({ ticket: files.ref, sessionPid: pid });

  let ended: SessionResult["ended"] = "exited";
  let stopReason: string | null = null;
  let finished: { code: number | null; signal: string | null } | null = null;
  void exited.then((value) => (finished = value), () => undefined);
  if (spawned !== "exited") {
    while (finished === null) {
      await Promise.race([exited, sleep(options.pollMs, options.signal, true)]).catch(() => undefined);
      if (finished !== null) break;
      beat();
      if (options.signal?.aborted) ended = "interrupted";
      else if (options.ticketTimeoutMs !== null && Date.now() - started >= options.ticketTimeoutMs) ended = "timeout";
      else {
        const run = options.runs.get(options.runId);
        if (run.state !== "active" && run.state !== "paused") {
          ended = "stopped";
          stopReason = run.stop?.reason ?? null;
        }
      }
      if (ended !== "exited") {
        await killGroup(pid, exited, options.killGraceMs);
        break;
      }
    }
  }
  const result = await exited;
  return { ended, exitCode: result.code, signal: result.signal, seconds: Math.round((Date.now() - started) / 1000), stopReason };
}

/** TERM the session's process group, then KILL it if it outlives the grace. */
async function killGroup(pid: number, exited: Promise<unknown>, graceMs: number): Promise<void> {
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      process.kill(-pid, signal);
    } catch {
      /* the group is already gone */
    }
  };
  signalGroup("SIGTERM");
  await Promise.race([exited.then(() => undefined, () => undefined), sleep(graceMs, undefined, true)]);
  // Whether or not the leader went on TERM: anything it left behind in its group goes too.
  signalGroup("SIGKILL");
}
