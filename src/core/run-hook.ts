/**
 * Interactive adapters for autopilot runs (design/runs.md, "Interactive sessions: stop
 * hooks"): a session a person is already in keeps working a run's tickets because its
 * agent CLI asks `staple run hook <provider>` whenever the agent is about to end its turn.
 *
 * The hook is a thin translation of {@link RunStore.continue}: the tracker decides, the
 * provider's hook contract only carries the answer. Everything here is provider-neutral;
 * each provider's stdin payload and stdout contract live in `run-hook-providers.ts`.
 *
 * ## Binding: which session drives which run
 *
 * A hook fires for EVERY session of the CLI it is installed in, so it acts only for a
 * session that was explicitly bound to a run (`staple run hook bind`, which reads the
 * session id the CLI exports to its tool shells). The binding is a small file in the staple
 * home, `run-sessions/<provider>-<session>.json`, naming the run and its workspace
 * database: the session may `cd` into a worktree the workspace cannot be found from, and a
 * file needs no migration (runs are machine-local already). A CLI that exports no session
 * id to its shells gets a pending binding instead, claimed by its next stop in the same
 * directory ({@link claimPending}). One run, one session: a second binding is refused. An
 * unbound session is never touched. So is a session `run drive` started (it sets `STAPLE_RUN_TICKET`), and a run a
 * live driver is attached to: two adapters must never work one run.
 *
 * ## The decision, in order
 *
 *   1. The run's current ticket is still held by its actor in an active status: block,
 *      telling the agent to finish it (or state the failure). Nothing is recorded.
 *   2. It was handed on without a `review: ...` comment since it was taken: block, asking
 *      for the review. The rule `run drive` enforces (no_review), reached the interactive
 *      way: a person's session is asked to do it rather than failed for skipping it.
 *   3. Otherwise `continue` answers: `take` blocks with the next ticket (already claimed);
 *      `wait` lets the session stop with a message (a wait can last hours, and holding a
 *      session in a loop burns its turn budget for nothing); `stop` lets it stop, prints the
 *      reason, and removes the binding.
 *
 * ## Never trap the person
 *
 * Every provider has a loop signal (Claude Code's `stop_hook_active`: this stop follows a
 * continuation a stop hook caused). While it is set, the same reminder (the same kind on the
 * same ticket) is given at most {@link DEFAULT_MAX_REPEATS} times in a row, and at most
 * {@link DEFAULT_MAX_BLOCKS} continuations are asked for in a row; past either the session
 * is let go with a message, and the run stays as it is. A fresh prompt from the person
 * resets both. `staple run stop` (or the UI's Stop) ends the run, and the next hook lets the
 * session stop. Any error inside the hook lets the session stop too: the adapter maps every
 * failure to "allow", never to its provider's blocking exit code.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync } from "node:fs";
import { join, sep } from "node:path";
import { stapleHome } from "../config/home.js";
import { writeFileAtomic } from "../config/atomic.js";
import { databaseFile, readDriver } from "./run-attachment.js";
import type { ContinueAnswer, Run, RunStore } from "./run-store.js";
import { shellQuote } from "./run-driver.js";
import type { WorkspaceStore } from "./store.js";
import { StapleError, nowIso } from "./types.js";

/** The same reminder, in a row, before the session is let go. */
export const DEFAULT_MAX_REPEATS = 2;
/** Continuations asked for in a row (one prompt from the person) before the session is let go. */
export const DEFAULT_MAX_BLOCKS = 20;

/** A session bound to a run: `<staple home>/run-sessions/<provider>-<session>.json`. */
export interface SessionBinding {
  provider: string;
  session: string;
  runId: string;
  /** The workspace database the run lives in. */
  db: string;
  actor: string;
  boundAt: string;
  /** The loop guard's memory: the reminders given since the person last prompted. */
  streak: HookStreak;
}

export interface HookStreak {
  /** What the last block was about: `<why>:<ref>`; null when the last answer was not a block. */
  key: string | null;
  /** How many times in a row that same block was given. */
  repeats: number;
  /** How many blocks in a row, whatever they were about. */
  blocks: number;
}

const FRESH_STREAK: HookStreak = { key: null, repeats: 0, blocks: 0 };

/** Why the hook let the session stop. */
export type HookAllowWhy =
  | "unbound"
  | "driven_session"
  | "subagent"
  | "driver_attached"
  | "run_gone"
  | "waiting"
  | "stopped"
  | "repeat_guard"
  | "block_guard"
  | "error";

/** Why the hook kept the session going. */
export type HookBlockWhy = "unfinished" | "no_review" | "take";

/**
 * What a stop hook answers, provider-neutral. `message` on an allow is for the person
 * (shown by the provider where it can); `reason` on a block is for the agent.
 */
export type HookVerdict =
  | { action: "allow"; why: HookAllowWhy; message: string | null }
  | { action: "block"; why: HookBlockWhy; ref: string; reason: string };

/** What a provider's payload says, reduced to what the decision reads. */
export interface StopEvent {
  /** The provider's session id; null when the payload carries none. */
  session: string | null;
  /** The session's working directory (its project root), where the payload says; claims a pending binding. */
  cwd: string | null;
  /** This stop follows a continuation a stop hook caused (the provider's loop signal). */
  continuing: boolean;
  /** The event fired inside a sub-agent, not the session the person is in. */
  subagent: boolean;
}

export interface HookLimits {
  maxRepeats: number;
  maxBlocks: number;
}

// ---------------------------------------------------------------- bindings

export function sessionsDirectory(): string {
  return join(stapleHome(), "run-sessions");
}

/** A provider's session id as a file name: anything outside `[A-Za-z0-9._-]` becomes `_`. */
export function bindingPath(provider: string, session: string): string {
  return join(sessionsDirectory(), `${safeName(provider)}-${safeName(session)}.json`);
}

export function readBinding(provider: string, session: string): SessionBinding | null {
  const path = bindingPath(provider, session);
  if (!existsSync(path)) return null;
  try {
    const binding = JSON.parse(readFileSync(path, "utf8")) as SessionBinding;
    // Another session's file under a colliding sanitised name is not this session's.
    if (binding.session !== session || binding.provider !== provider) return null;
    return { ...binding, streak: binding.streak ?? { ...FRESH_STREAK } };
  } catch {
    return null;
  }
}

function writeBinding(binding: SessionBinding): void {
  writeFileAtomic(bindingPath(binding.provider, binding.session), `${JSON.stringify(binding, null, 2)}\n`);
}

function bindingFiles(): Array<{ path: string; value: Record<string, unknown> }> {
  const dir = sessionsDirectory();
  if (!existsSync(dir)) return [];
  const files: Array<{ path: string; value: Record<string, unknown> }> = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    try {
      files.push({ path: join(dir, name), value: JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<string, unknown> });
    } catch {
      /* not a binding */
    }
  }
  return files;
}

/** The sessions bound to `runId`, any provider. */
export function sessionsOfRun(runId: string): SessionBinding[] {
  return bindingFiles()
    .map((file) => file.value)
    .filter((value) => value.runId === runId && typeof value.session === "string") as unknown as SessionBinding[];
}

/** The unexpired pending bindings for `runId`. */
function pendingOfRun(runId: string, now = new Date()): PendingBinding[] {
  return bindingFiles()
    .map((file) => file.value)
    .filter((value) => value.runId === runId && typeof value.session !== "string" && typeof value.expiresAt === "string" && Date.parse(value.expiresAt) > now.getTime()) as unknown as PendingBinding[];
}

/**
 * One run, one session: refused (`conflict`) when another session is bound to the run, or a
 * pending binding made elsewhere waits for one. `except` is the binding being replaced.
 */
function assertRunFree(run: Run, except: { provider: string; session?: string; pendingFile?: string }): void {
  const other = sessionsOfRun(run.id).find((binding) => !(binding.provider === except.provider && binding.session === except.session));
  const pending = pendingOfRun(run.id).find((binding) => pendingPath(binding.provider, binding.cwd) !== except.pendingFile);
  if (other === undefined && pending === undefined) return;
  const holder = other !== undefined ? `${other.provider} session ${other.session}` : `a pending ${pending!.provider} binding in ${pending!.cwd}`;
  throw new StapleError("conflict", `Run ${run.id} is already bound to ${holder}; one run is worked by one session. To move it, first: staple run hook unbind --run ${run.id}`, {
    runId: run.id,
    boundTo: other !== undefined ? { provider: other.provider, session: other.session } : { provider: pending!.provider, cwd: pending!.cwd },
  });
}

/** Remove every binding of `runId`, pending ones included; how many there were. */
export function unbindRun(runId: string): number {
  let removed = 0;
  for (const file of bindingFiles()) {
    if (file.value.runId !== runId) continue;
    rmSync(file.path, { force: true });
    removed += 1;
  }
  return removed;
}

/** True when a binding was there to remove. */
export function unbindPending(provider: string, cwd: string): boolean {
  const path = pendingPath(provider, physical(cwd));
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** True when a binding was there to remove. */
export function unbindSession(provider: string, session: string): boolean {
  const path = bindingPath(provider, session);
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

/** The workspace database of a run that may be bound: live, and not being driven. */
function bindableDb(store: WorkspaceStore, run: Run): string {
  if (run.state !== "active" && run.state !== "paused") {
    throw new StapleError("conflict", `Run ${run.id} has ended (${run.stop?.reason ?? run.state}); only a live run can be bound.`, { runId: run.id, state: run.state });
  }
  const dbFile = databaseFile(store.db);
  if (dbFile === null) throw new StapleError("validation", "An in-memory workspace cannot be bound to a session.");
  const driver = readDriver(dbFile, run.id);
  if (driver !== null && driver.alive !== false) {
    throw new StapleError("conflict", `Run ${run.id} is being driven by staple run drive (pid ${driver.pid} on ${driver.host}); a session cannot work it too.`, {
      runId: run.id,
      driver: { pid: driver.pid, host: driver.host },
    });
  }
  return dbFile;
}

/**
 * Bind a provider's session to a live run: from now on that session's stop hook works the
 * run. Refused for an ended run and for a run a live `run drive` is attached to (the driver
 * owns its tickets). Rebinding a session to another run replaces its binding.
 */
export function bindSession(input: { store: WorkspaceStore; run: Run; provider: string; session: string }): SessionBinding {
  const db = bindableDb(input.store, input.run);
  const session = input.session.trim();
  if (session === "") throw new StapleError("validation", "The session id is empty.");
  assertRunFree(input.run, { provider: input.provider, session });
  mkdirSync(sessionsDirectory(), { recursive: true });
  const binding: SessionBinding = { provider: input.provider, session, runId: input.run.id, db, actor: input.run.actor, boundAt: nowIso(), streak: { ...FRESH_STREAK } };
  writeBinding(binding);
  return binding;
}

// ---------------------------------------------------------------- pending bindings

/** How long a pending binding waits for its session's first stop. */
export const PENDING_BINDING_TTL_SECONDS = 600;

/**
 * A binding waiting for its session. Most CLIs document no variable that tells a shell
 * command its session id, so `bind` without one records the directory it ran in, and the
 * first stop hook of that provider whose session works in that directory (or below it)
 * claims it: the agent that ran `bind` ends its turn next, so that stop is almost always
 * its own. `--session <id>` binds exactly, and is the way to be sure.
 */
export interface PendingBinding {
  provider: string;
  cwd: string;
  runId: string;
  db: string;
  actor: string;
  boundAt: string;
  expiresAt: string;
}

function physical(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

function safeName(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function pendingPath(provider: string, cwd: string): string {
  return join(sessionsDirectory(), `${safeName(provider)}-pending-${createHash("sha256").update(cwd).digest("hex").slice(0, 16)}.json`);
}

export function bindPending(input: { store: WorkspaceStore; run: Run; provider: string; cwd: string; now?: Date }): PendingBinding & { file: string } {
  const db = bindableDb(input.store, input.run);
  const now = input.now ?? new Date();
  const cwd = physical(input.cwd);
  assertRunFree(input.run, { provider: input.provider, pendingFile: pendingPath(input.provider, cwd) });
  const pending: PendingBinding = {
    provider: input.provider,
    cwd,
    runId: input.run.id,
    db,
    actor: input.run.actor,
    boundAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + PENDING_BINDING_TTL_SECONDS * 1000).toISOString(),
  };
  mkdirSync(sessionsDirectory(), { recursive: true });
  const file = pendingPath(input.provider, cwd);
  writeFileAtomic(file, `${JSON.stringify(pending, null, 2)}\n`);
  return { ...pending, file };
}

/**
 * Turn a pending binding made in `cwd`, or in a directory above it, into this session's
 * binding: the session works where `bind` ran or below it, never above it. A run another
 * session is already bound to is not claimed. The claim is a rename, so of two sessions stopping at once exactly
 * one gets it. An expired pending binding is removed, never claimed.
 */
export function claimPending(provider: string, session: string, cwd: string, now = new Date()): SessionBinding | null {
  const dir = sessionsDirectory();
  if (!existsSync(dir)) return null;
  const root = physical(cwd);
  const prefix = `${safeName(provider)}-pending-`;
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(prefix) || !name.endsWith(".json")) continue;
    const path = join(dir, name);
    let pending: PendingBinding;
    try {
      pending = JSON.parse(readFileSync(path, "utf8")) as PendingBinding;
    } catch {
      continue;
    }
    if (pending.provider !== provider) continue;
    if (Date.parse(pending.expiresAt) <= now.getTime()) {
      rmSync(path, { force: true });
      continue;
    }
    // The session works where bind ran, or below it; never above it (a session in $HOME is
    // not the one that ran bind in a project).
    if (root !== pending.cwd && !root.startsWith(pending.cwd.endsWith(sep) ? pending.cwd : `${pending.cwd}${sep}`)) continue;
    // A run another session already works is not claimed by a second one.
    if (sessionsOfRun(pending.runId).some((other) => !(other.provider === provider && other.session === session))) continue;
    const claimed = `${path}.claimed-${process.pid}`;
    try {
      renameSync(path, claimed);
    } catch {
      continue; // another session claimed it first
    }
    rmSync(claimed, { force: true });
    const binding: SessionBinding = { provider, session, runId: pending.runId, db: pending.db, actor: pending.actor, boundAt: nowIso(), streak: { ...FRESH_STREAK } };
    writeBinding(binding);
    return binding;
  }
  return null;
}

// ---------------------------------------------------------------- the decision

/**
 * The provider-neutral stop decision for one hook call. Reads the binding, opens nothing
 * itself (the caller opens `binding.db`), and writes the streak back or removes the
 * binding as the verdict requires.
 */
export function decideStop(input: {
  event: StopEvent;
  binding: SessionBinding;
  store: WorkspaceStore;
  runs: RunStore;
  limits: HookLimits;
}): HookVerdict {
  const { event, binding, store, runs, limits } = input;
  const streak: HookStreak = event.continuing ? { ...binding.streak } : { ...FRESH_STREAK };
  const allow = (why: HookAllowWhy, message: string | null, unbind = false): HookVerdict => {
    if (unbind) unbindSession(binding.provider, binding.session);
    else writeBinding({ ...binding, streak: { ...FRESH_STREAK } });
    return { action: "allow", why, message };
  };
  /** Past `--max-blocks` continuations in a row, whatever they were for, the session may stop. */
  const blockLimitReached = (): HookVerdict | null =>
    event.continuing && streak.blocks >= limits.maxBlocks
      ? allow(
          "block_guard",
          `staple autopilot: letting the session stop after ${limits.maxBlocks} continuations in a row. Run ${short(binding.runId)} is still live; prompt the agent to carry on, or end it: staple run stop ${short(binding.runId)}.`,
        )
      : null;
  /** A block, unless the loop guards say enough: the same one too often, or too many of any kind. */
  const block = (why: HookBlockWhy, ref: string, reason: string): HookVerdict => {
    const limited = blockLimitReached();
    if (limited !== null) return limited;
    const key = `${why}:${ref}`;
    const repeats = event.continuing && streak.key === key ? streak.repeats + 1 : 1;
    if (why !== "take" && repeats > limits.maxRepeats) {
      return allow(
        "repeat_guard",
        `staple autopilot: letting the session stop after ${limits.maxRepeats} reminders in a row about ${ref} (${why}). Run ${short(binding.runId)} is still live. Prompt the agent to carry on, or end the run: staple run stop ${short(binding.runId)}.`,
      );
    }
    writeBinding({ ...binding, streak: { key, repeats, blocks: streak.blocks + 1 } });
    return { action: "block", why, ref, reason };
  };

  let run: Run;
  try {
    run = runs.get(binding.runId);
  } catch {
    return allow("run_gone", `staple autopilot: run ${short(binding.runId)} is not in ${binding.db} any more; this session is no longer bound to it.`, true);
  }
  const live = run.state === "active" || run.state === "paused";
  if (live) {
    const driver = readDriver(binding.db, run.id);
    if (driver !== null && driver.alive !== false) return { action: "allow", why: "driver_attached", message: null };
  }

  const current = live ? run.tickets.find((ticket) => ticket.outcome === null) : undefined;
  if (current !== undefined) {
    const issue = currentIssue(store, current.issueId);
    if (issue !== null) {
      const ref = issue.identifier;
      const as = actorPrefix(run.actor, binding.db);
      if (issue.checkoutAgent === run.actor && store.isActiveStatus(issue.status)) {
        return block("unfinished", ref, unfinishedReason({ ref, title: issue.title, status: issue.status, run, as }));
      }
      const category = store.categoryOf(issue.status);
      const handedOn = category === "done" || category === "review" || category === "gated";
      if (handedOn && !reviewedSince(store, issue.id, current.takenAt)) {
        return block("no_review", ref, noReviewReason({ ref, status: issue.status, as }));
      }
    }
  }

  // Read again BEFORE continue (block() reads it too): a take the session will not be given
  // the turn for is never claimed.
  const limited = blockLimitReached();
  if (limited !== null) return limited;

  const answer = runs.continue({ run: run.id });
  if (answer.action === "take") {
    return block("take", answer.ref, takeReason({ answer, db: binding.db }));
  }
  if (answer.action === "wait") {
    return allow(
      "waiting",
      `staple autopilot: run ${short(answer.run.id)} waits (${answer.reason}): ${answer.message} Nothing was taken, so the session may stop. Ask again with "staple run continue --run ${short(answer.run.id)}", or end the run with "staple run stop ${short(answer.run.id)}".`,
    );
  }
  const recorded = answer.recorded ? ` Recorded ${answer.recorded.ref} ${answer.recorded.outcome}${answer.recorded.reason ? ` (${answer.recorded.reason})` : ""}.` : "";
  const stop = answer.run?.stop ?? null;
  const who = stop?.by ? ` Stopped by ${stop.by}${stop.note ? `: ${stop.note}` : ""}.` : "";
  return allow("stopped", `staple autopilot: run ${short(answer.run?.id ?? run.id)} ended: ${answer.reason}. ${answer.message}${who}${recorded}`, true);
}

/** Apply every guard that needs no workspace, then {@link decideStop}. What each provider adapter calls. */
export function stopHook(input: {
  provider: string;
  event: StopEvent;
  limits: HookLimits;
  env: NodeJS.ProcessEnv;
  open: (db: string) => { store: WorkspaceStore; runs: RunStore };
}): HookVerdict {
  const { event } = input;
  // A session run drive started works one ticket and exits; the driver asks continue, not it.
  if ((input.env.STAPLE_RUN_TICKET ?? "") !== "") return { action: "allow", why: "driven_session", message: null };
  if (event.subagent) return { action: "allow", why: "subagent", message: null };
  if (event.session === null) return { action: "allow", why: "unbound", message: null };
  const binding = readBinding(input.provider, event.session) ?? (event.cwd === null ? null : claimPending(input.provider, event.session, event.cwd));
  if (binding === null) return { action: "allow", why: "unbound", message: null };
  if (!existsSync(binding.db)) {
    unbindSession(input.provider, event.session);
    return { action: "allow", why: "run_gone", message: `staple autopilot: the workspace ${binding.db} of run ${short(binding.runId)} is gone; this session is no longer bound to it.` };
  }
  const { store, runs } = input.open(binding.db);
  return decideStop({ event, binding, store, runs, limits: input.limits });
}

// ---------------------------------------------------------------- reading the store

function currentIssue(store: WorkspaceStore, issueId: string): ReturnType<WorkspaceStore["getIssue"]> | null {
  try {
    return store.getIssue(issueId);
  } catch {
    return null;
  }
}

/**
 * A `review: ...` comment on the issue since `since`, by anyone: a separate reviewer may
 * post it. The same test `run drive` applies to a finished session (design/runs.md).
 */
export function reviewedSince(store: WorkspaceStore, issueId: string, since: string): boolean {
  const bodies = store.db
    .prepare("SELECT body FROM comments WHERE issue_id = ? AND deleted_at IS NULL AND created_at >= ?")
    .all(issueId, since) as Array<{ body: string }>;
  return bodies.some((comment) => /^\s*review:/i.test(comment.body));
}

// ---------------------------------------------------------------- what the agent is told

function short(runId: string): string {
  return runId.slice(0, 8);
}

/** The environment every staple command of the session needs, so it acts as the run's actor on the run's workspace. */
function actorPrefix(actor: string, db: string): string {
  return `STAPLE_AGENT=${shellQuote(actor)} STAPLE_DB=${shellQuote(db)}`;
}

function unfinishedReason(input: { ref: string; title: string; status: string; run: Run; as: string }): string {
  const { ref, run } = input;
  return `staple autopilot: ${ref} "${input.title}" is still checked out to ${run.actor} and ${input.status}: finish it before you stop. Run every staple command as the run's actor, on its workspace: ${input.as} staple ...
- Finish: run its gates, review the change adversarially and record it (staple comment ${ref} "review: ..."), comment the evidence, then hand it on: staple status ${ref} in_review --json
- Cannot finish: comment exactly why, then staple run continue --run ${short(run.id)} --outcome failed --reason "<why>" --json, and do what it answers.
- The person asked you to stop the autopilot: staple run stop ${short(run.id)} -m "<why>" --json
Never merge to master or main.`;
}

function noReviewReason(input: { ref: string; status: string; as: string }): string {
  const { ref, as } = input;
  return `staple autopilot: ${ref} is ${input.status} but has no review since the run took it. Before the run moves on, review the change as a skeptic whose job is to find where it fails ${ref}'s acceptance criteria: reproduce, do not read (a separate reviewer sub-agent if you can start one). Fix what it finds, then record it: ${as} staple comment ${ref} "review: <findings and what you did about each>". Then end your turn.`;
}

function takeReason(input: { answer: Extract<ContinueAnswer, { action: "take" }>; db: string }): string {
  const { answer } = input;
  const { ref, run } = answer;
  const as = actorPrefix(run.actor, input.db);
  const goalCheck = run.goal?.children.some((child) => child.identifier === ref && child.purpose === "goal_check") === true;
  const milestone = answer.goal?.milestone.identifier ?? null;
  const lines = [
    `staple autopilot: next ticket ${ref} "${answer.title}". It is already checked out to ${run.actor} for you: do not check it out again.`,
    answer.resumed ? `Resuming: ${ref} was left unfinished. Read its comments, plan and worklog first and carry on from there; an earlier review does not count.` : answer.why,
    `Run every staple command as the run's actor, on its workspace: ${as} staple ...`,
  ];
  if (goalCheck && milestone !== null) {
    lines.push(
      `This is the goal check of milestone ${milestone}: change no code. Judge each criterion that is not met against the evidence, and record each verdict: staple milestone criterion ${milestone} <n> --met --evidence <ticket|ticket:doc|text>, or --unmet --evidence "<what is missing>" --follow-up "<title of the work that meets it>". Review your verdicts adversarially, comment "review: ...", then close it: staple done ${ref} --json.`,
    );
  } else {
    lines.push(
      `1. Read it: staple show ${ref} --json. Its acceptance criteria are the definition of done.`,
      `2. Comment a branch pointer, store a plan (staple doc ${ref} plan --put <file>) and keep a worklog. Work on a branch; never merge to master or main, never push to them.`,
      `3. Run the repository's gates and read the counts. Green gates are not evidence on their own.`,
      `4. Review adversarially before you hand it on (a separate reviewer sub-agent if you can), fix what it finds, and record it: staple comment ${ref} "review: ...".`,
      `5. Comment the evidence, then: staple status ${ref} in_review --json.`,
    );
    if (milestone !== null) lines.push(`This run's goal is milestone ${milestone}: when your work is evidence that one of its criteria is met, mark it (staple milestone criterion ${milestone} <n> --met --evidence ${ref}). Mark only what your work shows.`);
  }
  lines.push(
    `If you cannot finish, comment why, then staple run continue --run ${short(run.id)} --outcome failed --reason "<why>" --json and do what it answers.`,
    `When it is handed on, end your turn: this hook asks the tracker for the next ticket. The person can end the run at any time with staple run stop ${short(run.id)}.`,
  );
  return lines.join("\n");
}
