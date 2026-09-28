/**
 * Autopilot runs in the store: one agent working a scope (the whole queue, an epic or
 * parent, or a milestone) ticket after ticket until a stop rule says otherwise.
 *
 * THE TRACKER DECIDES, NEVER THE PROMPT. Whether a run may take another ticket is
 * {@link evaluateStopRules}: a pure function of the run and a set of facts read off the
 * store ({@link RunStore.facts}). Every surface that answers "may I continue" calls it, so
 * an agent cannot talk itself past a stop.
 *
 * ## The reason codes are a public contract
 *
 * `run status --json`, `run_status` and the next ticket's `run continue` all carry them,
 * so they are never renamed. First match wins, in this order:
 *
 *   stopped_by_human  somebody ran `run stop` (the run records who, and why)
 *   budget            a budget ran out: `detail.budget` is `tickets` (the run took its
 *                     `--max-tickets`), `time` (`--until` has passed) or `ceiling` (a
 *                     current rate-limit window's high-water use reached `--ceiling`)
 *   failure_streak    the last two recorded outcomes are both `failed`
 *   vp_blocked        a ticket this run took is blocked on a named person
 *                     (`unblockOwner`), or nothing in scope is workable and something in
 *                     it is
 *   gate_pending      the scope issue itself holds a pending review gate, or nothing in
 *                     scope is workable and something in it holds one
 *   scope_empty       nothing in scope is workable, and nothing is waiting on a person
 *
 * `scope_empty` ends the run `completed`; every other reason ends it `stopped`.
 *
 * "Workable" is the pickup queue's own answer (`QueueStore.effectiveQueue`): a row inside
 * the scope that is `eligible`, or that the run's actor already holds. The scope's own
 * issue is never workable: a run works what is under the container, not the container.
 *
 * A gate or a person-owned block elsewhere in the scope does not stop a run that still has
 * workable rows. The queue already steps over them; stopping on them would let one parked
 * row halt every run over the whole queue.
 *
 * ## Machine-local, never journaled
 *
 * A run is which agent on which machine is looping, and nothing about that is repository
 * state: another device sees the claims, statuses and attempts the run's tickets produce,
 * which replicate as they always did. So `runs` and `run_tickets` (workspace migration 015)
 * are not sync entities, no mutation here declares a journal intent, and the run events
 * name no issue, so the journal never re-emits them. Writes still run inside
 * `store.journaled()`, because an event must be written inside a transaction.
 */
import type { DatabaseSync } from "node:sqlite";
import { stapleHome } from "../config/home.js";
import { insertEvent } from "./event-log.js";
import { newId } from "./ids.js";
import { MILESTONE_KIND } from "./milestones.js";
import type { WorkspaceStore } from "./store.js";
import { normalizeInstant, parseRelativeSeconds } from "./telemetry/formats.js";
import { readBudget, type BudgetView } from "./telemetry/read-budget.js";
import { MAX_TREE_DEPTH, StapleError, nowIso } from "./types.js";

export const RUN_STATES = ["active", "paused", "stopped", "completed"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** A live run owns its scope: a second run for the same actor and scope is refused. */
export const LIVE_RUN_STATES: readonly RunState[] = ["active", "paused"];

/** The stop reasons, in evaluation order. A public JSON contract: never rename one. */
export const RUN_STOP_REASONS = [
  "stopped_by_human",
  "budget",
  "failure_streak",
  "vp_blocked",
  "gate_pending",
  "scope_empty",
] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

/** Which budget ran out, in `detail.budget` of a `budget` stop. */
export type RunBudgetKind = "tickets" | "time" | "ceiling";

export const RUN_TICKET_OUTCOMES = ["done", "failed"] as const;
export type RunTicketOutcome = (typeof RUN_TICKET_OUTCOMES)[number];

/** Consecutive failed outcomes that stop a run. */
export const FAILURE_STREAK_LIMIT = 2;

export type RunScopeKind = "queue" | "issue" | "milestone";

/** What a run works. `issue` is an epic or any parent; `identifier` is resolved on every read. */
export type RunScope =
  | { kind: "queue" }
  | { kind: "issue" | "milestone"; issueId: string; identifier: string | null };

export interface RunTicket {
  seq: number;
  issueId: string;
  /** The identifier when the run took it. */
  identifier: string;
  takenAt: string;
  /** Null while the ticket is still being worked. */
  outcome: RunTicketOutcome | null;
  reason: string | null;
  /** The attempt the outcome was read from, when it was derived rather than stated. */
  attemptId: string | null;
  recordedAt: string | null;
}

export interface RunBudget {
  maxTickets: number | null;
  /** The instant after which the run takes nothing more. */
  until: string | null;
  /** A current window's high-water use, in percent, at which the run stops. */
  ceilingPercent: number | null;
  /** The account the ceiling reads; null means every account on this machine. */
  ceilingAccount: string | null;
}

export interface RunStop {
  reason: RunStopReason;
  detail: Record<string, unknown>;
  /** Who stopped it; null when a stop rule did. */
  by: string | null;
  note: string | null;
  at: string;
}

export interface Run {
  id: string;
  actor: string;
  scope: RunScope;
  state: RunState;
  budget: RunBudget;
  tickets: RunTicket[];
  counts: { taken: number; done: number; failed: number; open: number };
  /** Null while the run is live. */
  stop: RunStop | null;
  startedAt: string;
  updatedAt: string;
  endedAt: string | null;
}

/** Facts about the scope and the budget, read off the store at one instant. */
export interface RunFacts {
  now: string;
  /** Rows in scope the run could take or already holds, in effective order. */
  workable: Array<{ issueId: string; identifier: string }>;
  /** Unresolved issues in scope (the scope issue included) holding a pending review gate. */
  pendingGates: Array<{ issueId: string; identifier: string; owner: string | null }>;
  /** Unresolved issues in scope blocked on a named person. */
  personBlocks: Array<{ issueId: string; identifier: string; owner: string; action: string | null }>;
  /** Null when the run has no ceiling. */
  ceiling: RunCeilingFact | null;
}

/** The highest current-window use the ceiling is read against, or why it is unknown. */
export interface RunCeilingFact {
  usedPercent: number | null;
  accountRef: string | null;
  limitKey: string | null;
  /** Why `usedPercent` is null: `no_current_reading`, or the budget read's refusal. */
  missing: string | null;
}

export type StopDecision =
  | { stop: false }
  | { stop: true; reason: RunStopReason; state: "stopped" | "completed"; detail: Record<string, unknown>; message: string };

/** What `run status` answers per run: the run, the stop decision now, and the facts behind it (null once ended). */
export interface RunStatus {
  run: Run;
  decision: StopDecision;
  facts: RunFacts | null;
}

/** What `evaluateStopRules` reads of a run. */
export type RunForRules = Pick<Run, "state" | "scope" | "budget" | "tickets" | "stop">;

/**
 * THE stop rules, as a pure function: same run, same facts, same answer. See the module
 * comment for the order and the meaning of each code.
 *
 * A run that has already ended answers the reason it ended with. A paused run is not
 * stopped: pausing is not a stop rule, and whether a paused run waits is the caller's call.
 */
export function evaluateStopRules(run: RunForRules, facts: RunFacts): StopDecision {
  const stop = (reason: RunStopReason, detail: Record<string, unknown>, message: string): StopDecision => ({
    stop: true,
    reason,
    state: reason === "scope_empty" ? "completed" : "stopped",
    detail,
    message,
  });

  if (run.state === "stopped" || run.state === "completed") {
    const ended = run.stop ?? { reason: "stopped_by_human" as const, detail: {}, by: null, note: null, at: facts.now };
    return {
      stop: true,
      reason: ended.reason,
      state: run.state,
      detail: ended.detail,
      message: `The run already ended (${ended.reason}).`,
    };
  }

  const taken = run.tickets.length;
  const { maxTickets, until, ceilingPercent } = run.budget;
  if (maxTickets !== null && taken >= maxTickets) {
    return stop("budget", { budget: "tickets", maxTickets, taken }, `The run took ${taken} of its ${maxTickets} ticket(s).`);
  }
  if (until !== null && Date.parse(facts.now) >= Date.parse(until)) {
    return stop("budget", { budget: "time", until, now: facts.now }, `The run's time ran out at ${until}.`);
  }
  const used = facts.ceiling?.usedPercent ?? null;
  if (ceilingPercent !== null && used !== null && used >= ceilingPercent) {
    const accountRef = facts.ceiling?.accountRef ?? null;
    const limitKey = facts.ceiling?.limitKey ?? null;
    const which = [accountRef, limitKey].filter((part) => part !== null).join(" ") || "A rate limit";
    return stop(
      "budget",
      { budget: "ceiling", ceilingPercent, usedPercent: used, accountRef, limitKey },
      `${which} is at ${used}% used, at or over the run's ${ceilingPercent}% ceiling.`,
    );
  }

  const recorded = run.tickets.filter((ticket) => ticket.outcome !== null);
  const streak = recorded.slice(-FAILURE_STREAK_LIMIT);
  if (streak.length === FAILURE_STREAK_LIMIT && streak.every((ticket) => ticket.outcome === "failed")) {
    const refs = streak.map((ticket) => ticket.identifier);
    return stop("failure_streak", { tickets: refs, limit: FAILURE_STREAK_LIMIT }, `${refs.join(" and ")} both failed in a row.`);
  }

  const takenIds = new Set(run.tickets.map((ticket) => ticket.issueId));
  const ownBlock = facts.personBlocks.find((block) => takenIds.has(block.issueId));
  if (ownBlock) {
    return stop("vp_blocked", { blocks: [ownBlock] }, `${ownBlock.identifier}, which this run took, is blocked on ${ownBlock.owner}.`);
  }
  const rootId = run.scope.kind === "queue" ? null : run.scope.issueId;
  const rootGate = rootId === null ? undefined : facts.pendingGates.find((gate) => gate.issueId === rootId);
  if (rootGate) {
    return stop("gate_pending", { gates: [rootGate] }, `${rootGate.identifier} is awaiting approval${rootGate.owner ? ` by ${rootGate.owner}` : ""}.`);
  }

  if (facts.workable.length > 0) return { stop: false };
  if (facts.pendingGates.length > 0) {
    return stop("gate_pending", { gates: facts.pendingGates }, `Nothing in scope is workable: ${facts.pendingGates.map((gate) => gate.identifier).join(", ")} awaiting approval.`);
  }
  if (facts.personBlocks.length > 0) {
    return stop(
      "vp_blocked",
      { blocks: facts.personBlocks },
      `Nothing in scope is workable: ${facts.personBlocks.map((block) => `${block.identifier} (${block.owner})`).join(", ")} blocked on a person.`,
    );
  }
  return stop("scope_empty", {}, "Nothing in scope is left to take.");
}

// ---------------------------------------------------------------- storage

interface RunRow {
  id: string;
  actor: string;
  scope_kind: string;
  scope_key: string;
  scope_issue_id: string | null;
  state: string;
  max_tickets: number | null;
  until_at: string | null;
  ceiling_percent: number | null;
  ceiling_account: string | null;
  stop_reason: string | null;
  stop_detail: string;
  stopped_by: string | null;
  stop_note: string | null;
  started_at: string;
  updated_at: string;
  ended_at: string | null;
}

interface TicketRow {
  seq: number;
  issue_id: string;
  identifier: string;
  taken_at: string;
  outcome: string | null;
  reason: string | null;
  attempt_id: string | null;
  recorded_at: string | null;
}

export interface StartRunInput {
  actor: string;
  /** `queue`, or the reference of an epic, a parent or a milestone. */
  scope: string;
  maxTickets?: number;
  /** An ISO instant with a zone, or a duration from now (`90m`, `2h`, `1d`). */
  until?: string;
  ceilingPercent?: number;
  ceilingAccount?: string;
}

/** Reads this machine's budget; injected by tests, `readBudget` over the staple home otherwise. */
export type BudgetReader = (query: { account?: string; now: string }) => BudgetView;

/** The shortest run-id prefix a caller may type. */
const RUN_ID_PREFIX_MIN = 8;

export class RunStore {
  constructor(
    private readonly store: WorkspaceStore,
    private readonly budget: BudgetReader = (query) => readBudget(stapleHome(), query),
  ) {}

  private get db(): DatabaseSync {
    return this.store.db;
  }

  // ---------- reads ----------

  /** One run by its id or an unambiguous prefix of at least eight characters. */
  get(ref: string): Run {
    return this.toRun(this.requireRow(ref));
  }

  /** The actor's live runs, or with `all` every run of every actor, newest first. */
  list(options: { actor?: string | null; all?: boolean } = {}): Run[] {
    const rows =
      options.all === true
        ? (this.db.prepare("SELECT * FROM runs ORDER BY started_at DESC, id DESC").all() as unknown as RunRow[])
        : (this.db
            .prepare(`SELECT * FROM runs WHERE actor = ? AND state IN (${LIVE_RUN_STATES.map(() => "?").join(", ")}) ORDER BY started_at DESC, id DESC`)
            .all(options.actor ?? "", ...LIVE_RUN_STATES) as unknown as RunRow[]);
    return rows.map((row) => this.toRun(row));
  }

  /**
   * The run a command without a run id means: the actor's one live run. None is
   * `not_found`; more than one (different scopes) is refused naming them.
   */
  liveRunOf(actor: string): Run {
    const live = this.list({ actor });
    if (live.length === 1) return live[0]!;
    if (live.length === 0) throw new StapleError("not_found", `${actor} has no active or paused run. Name one by id (staple run status --all lists every run).`, { actor });
    throw new StapleError(
      "validation",
      `${actor} has ${live.length} live runs; name one: ${live.map((run) => `${run.id} (${scopeLabel(run.scope)})`).join(", ")}.`,
      { actor, runs: live.map((run) => run.id) },
    );
  }

  /**
   * The run, the facts at this instant and what the stop rules make of them: what `run
   * status` answers. Writes nothing, so a stop rule that trips here does not end the run;
   * the caller that acts on the decision does (`finish`). An ended run reads no facts and
   * answers the reason it ended with.
   */
  status(ref: string, now = nowIso()): RunStatus {
    return this.statusOf(this.get(ref), now);
  }

  /** {@link status} for every run {@link list} returns. */
  statuses(options: { actor?: string | null; all?: boolean } = {}, now = nowIso()): RunStatus[] {
    return this.list(options).map((run) => this.statusOf(run, now));
  }

  private statusOf(run: Run, now: string): RunStatus {
    if (!isLive(run.state)) {
      return { run, decision: evaluateStopRules(run, { now, workable: [], pendingGates: [], personBlocks: [], ceiling: null }), facts: null };
    }
    const facts = this.facts(run, now);
    return { run, decision: evaluateStopRules(run, facts), facts };
  }

  /**
   * The facts {@link evaluateStopRules} reads, gathered from the store.
   *
   * The scope is the issue set a run may work: the whole workspace for `queue`; the scope
   * issue and its descendants for an epic or parent; the milestone, its members and their
   * descendants for a milestone (the same membership-then-hierarchy reach the queue
   * expands a milestone by).
   */
  facts(run: Run, now = nowIso()): RunFacts {
    const scope = this.scopeIds(run.scope);
    const inScope = (issueId: string): boolean => scope === null || scope.has(issueId);
    const rootId = run.scope.kind === "queue" ? null : run.scope.issueId;

    const workable = this.store
      .queue()
      .effectiveQueue({ actor: run.actor })
      .rows.filter((row) => row.issueId !== rootId && inScope(row.issueId))
      .filter((row) => row.eligibility === "eligible" || (row.eligibility === "claimed" && row.detail?.heldBy === run.actor))
      .map((row) => ({ issueId: row.issueId, identifier: row.identifier }));

    const open = (this.db
      .prepare("SELECT id, identifier, status, gate_state, gate_owner, unblock_owner, unblock_action FROM issues ORDER BY identifier")
      .all() as Array<{ id: string; identifier: string; status: string; gate_state: string | null; gate_owner: string | null; unblock_owner: string | null; unblock_action: string | null }>)
      .filter((row) => inScope(row.id) && !this.store.isResolvedStatus(row.status));
    const pendingGates = open
      .filter((row) => row.gate_state === "pending")
      .map((row) => ({ issueId: row.id, identifier: row.identifier, owner: row.gate_owner }));
    const personBlocks = open
      .filter((row) => this.store.categoryOf(row.status) === "blocked" && (row.unblock_owner ?? "").trim() !== "")
      .map((row) => ({ issueId: row.id, identifier: row.identifier, owner: row.unblock_owner!, action: row.unblock_action }));

    return { now, workable, pendingGates, personBlocks, ceiling: run.budget.ceilingPercent === null ? null : this.ceilingFact(run.budget.ceilingAccount, now) };
  }

  /**
   * The highest high-water use across the current windows the ceiling reads. An unknown
   * reading is reported as unknown with its reason and never trips the ceiling: no
   * reading is not a reading of 0, and not one of 100 either.
   */
  private ceilingFact(account: string | null, now: string): RunCeilingFact {
    let view: BudgetView;
    try {
      view = this.budget({ ...(account !== null ? { account } : {}), now });
    } catch (error) {
      const code = error instanceof StapleError ? error.code : "budget_unreadable";
      return { usedPercent: null, accountRef: account, limitKey: null, missing: code };
    }
    let best: RunCeilingFact | null = null;
    for (const entry of view.accounts) {
      for (const limit of entry.limits) {
        if (limit.status !== "current" || limit.highWaterPercent === null) continue;
        if (best === null || limit.highWaterPercent > best.usedPercent!) {
          best = { usedPercent: limit.highWaterPercent, accountRef: entry.accountRef, limitKey: limit.limitKey, missing: null };
        }
      }
    }
    return best ?? { usedPercent: null, accountRef: account, limitKey: null, missing: "no_current_reading" };
  }

  // ---------- writes ----------

  /**
   * Start a run. Refused with `conflict`, naming the run, while the actor already has a
   * live run over the same scope; the partial unique index `runs_live_scope_uq` is what
   * makes that hold under two racing starts.
   */
  start(input: StartRunInput): Run {
    const actor = input.actor.trim();
    if (actor === "") throw new StapleError("validation", "A run needs an actor: pass --actor or set STAPLE_AGENT.");
    const now = nowIso();
    const budget = this.parseBudget(input, now);
    return this.store.journaled(() => {
      const scope = this.resolveScope(input.scope);
      const key = scope.kind === "queue" ? "queue" : scope.issueId;
      const live = this.db
        .prepare(`SELECT * FROM runs WHERE actor = ? AND scope_key = ? AND state IN (${LIVE_RUN_STATES.map(() => "?").join(", ")})`)
        .get(actor, key, ...LIVE_RUN_STATES) as unknown as RunRow | undefined;
      if (live) {
        throw new StapleError(
          "conflict",
          `${actor} already has a live run over ${scopeLabel(scope)}: ${live.id} (${live.state}, started ${live.started_at}). Stop it first (staple run stop ${live.id}).`,
          { runId: live.id, state: live.state, actor, scope: scopeJson(scope) },
        );
      }
      const id = newId();
      this.db
        .prepare(
          `INSERT INTO runs (id, actor, scope_kind, scope_key, scope_issue_id, state, max_tickets, until_at, ceiling_percent, ceiling_account, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, actor, scope.kind, key, scope.kind === "queue" ? null : scope.issueId, budget.maxTickets, budget.until, budget.ceilingPercent, budget.ceilingAccount, now, now);
      this.emit("run_started", actor, { runId: id, actor, scope: scopeJson(scope), budget });
      return this.get(id);
    });
  }

  /**
   * A person stops a run: `stopped_by_human`, with who and why. Stopping a run that has
   * already ended changes nothing and answers the run as it stands, so a second press of
   * a Stop button is harmless.
   */
  stop(ref: string, by: string, note: string | null = null): Run {
    return this.store.journaled(() => {
      const row = this.requireRow(ref);
      if (!isLive(row.state)) return this.toRun(row);
      const cleanNote = note?.trim() ? note.trim() : null;
      this.end(row, { reason: "stopped_by_human", state: "stopped", detail: {}, by, note: cleanNote });
      return this.get(row.id);
    });
  }

  /**
   * End a live run because a stop rule tripped (what `run continue` calls with the
   * decision it evaluated). The run records the reason and its detail; nobody stopped it.
   */
  finish(ref: string, decision: Extract<StopDecision, { stop: true }>): Run {
    return this.store.journaled(() => {
      const row = this.requireRow(ref);
      if (!isLive(row.state)) return this.toRun(row);
      this.end(row, { reason: decision.reason, state: decision.state, detail: decision.detail, by: null, note: null });
      return this.get(row.id);
    });
  }

  /** Pause a live run, or resume a paused one. Same state is a no-op without an event. */
  setState(ref: string, state: "active" | "paused", by: string): Run {
    return this.store.journaled(() => {
      const row = this.requireRow(ref);
      if (!isLive(row.state)) {
        throw new StapleError("conflict", `Run ${row.id} already ${row.state} (${row.stop_reason ?? "no reason"}); start a new one.`, { runId: row.id, state: row.state });
      }
      if (row.state === state) return this.toRun(row);
      const now = nowIso();
      this.db.prepare("UPDATE runs SET state = ?, updated_at = ? WHERE id = ?").run(state, now, row.id);
      this.emit("run_state_changed", by, { runId: row.id, actor: row.actor, from: row.state, to: state, by });
      return this.get(row.id);
    });
  }

  /**
   * Record that the run took a ticket. The run must be active and the issue inside its
   * scope. Taking a ticket the run already holds open is a replay and writes nothing.
   */
  recordTicketTaken(ref: string, issueRef: string): Run {
    return this.store.journaled(() => {
      const row = this.requireRow(ref);
      if (row.state !== "active") {
        throw new StapleError("conflict", `Run ${row.id} is ${row.state}; it takes no tickets.`, { runId: row.id, state: row.state });
      }
      const issue = this.store.getIssue(issueRef);
      const scope = this.scopeIds(this.scopeOf(row));
      if ((scope !== null && !scope.has(issue.id)) || issue.id === row.scope_issue_id) {
        throw new StapleError("validation", `${issue.identifier} is not work inside ${scopeLabel(this.scopeOf(row))}.`, { identifier: issue.identifier, runId: row.id });
      }
      const open = this.db.prepare("SELECT seq FROM run_tickets WHERE run_id = ? AND issue_id = ? AND outcome IS NULL").get(row.id, issue.id);
      if (open) return this.toRun(row);
      const seq = ((this.db.prepare("SELECT MAX(seq) AS seq FROM run_tickets WHERE run_id = ?").get(row.id) as { seq: number | null }).seq ?? 0) + 1;
      const now = nowIso();
      this.db
        .prepare("INSERT INTO run_tickets (run_id, seq, issue_id, identifier, taken_at) VALUES (?, ?, ?, ?, ?)")
        .run(row.id, seq, issue.id, issue.identifier, now);
      this.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(now, row.id);
      this.emit("run_ticket_taken", row.actor, { runId: row.id, actor: row.actor, identifier: issue.identifier, seq });
      return this.get(row.id);
    });
  }

  /**
   * Record the outcome of the ticket the run took on `issueRef`: `done` or `failed`.
   *
   * Without an outcome it is read from the execution attempt the run's actor ended on that
   * issue after taking it: `failed` (`--outcome failed`) is failed and `completed` is done.
   * Any other ending (yielded, interrupted) or no ended attempt says nothing about success
   * and is refused, asking for the outcome to be stated.
   */
  recordTicketOutcome(ref: string, issueRef: string, outcome?: RunTicketOutcome, reason?: string | null): Run {
    if (outcome !== undefined && !(RUN_TICKET_OUTCOMES as readonly string[]).includes(outcome)) {
      throw new StapleError("validation", `A ticket's outcome is done or failed; got "${String(outcome)}".`);
    }
    return this.store.journaled(() => {
      const row = this.requireRow(ref);
      const issue = this.store.getIssue(issueRef);
      const ticket = this.db
        .prepare("SELECT * FROM run_tickets WHERE run_id = ? AND issue_id = ? AND outcome IS NULL ORDER BY seq DESC LIMIT 1")
        .get(row.id, issue.id) as unknown as TicketRow | undefined;
      if (!ticket) {
        throw new StapleError("not_found", `Run ${row.id} has no open ticket on ${issue.identifier}.`, { runId: row.id, identifier: issue.identifier });
      }
      let resolved = outcome ?? null;
      let why = reason?.trim() ? reason.trim() : null;
      let attemptId: string | null = null;
      if (resolved === null) {
        const attempt = this.db
          .prepare(
            `SELECT id, outcome, end_reason FROM attempts
              WHERE issue_id = ? AND agent = ? AND role = 'worker' AND state = 'ended' AND ended_at >= ?
              ORDER BY ended_at DESC, id DESC LIMIT 1`,
          )
          .get(issue.id, row.actor, ticket.taken_at) as { id: string; outcome: string | null; end_reason: string | null } | undefined;
        resolved = attempt?.outcome === "failed" ? "failed" : attempt?.outcome === "completed" ? "done" : null;
        if (resolved === null) {
          throw new StapleError(
            "validation",
            `No outcome to read for ${issue.identifier}: ${row.actor}'s attempt on it ${attempt ? `ended ${attempt.outcome ?? "without an outcome"}` : "has not ended"}. State it: done or failed.`,
            { runId: row.id, identifier: issue.identifier, attemptId: attempt?.id ?? null },
          );
        }
        attemptId = attempt!.id;
        why ??= resolved === "failed" ? attempt!.end_reason : null;
      }
      const now = nowIso();
      this.db
        .prepare("UPDATE run_tickets SET outcome = ?, reason = ?, attempt_id = ?, recorded_at = ? WHERE run_id = ? AND seq = ?")
        .run(resolved, why, attemptId, now, row.id, ticket.seq);
      this.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(now, row.id);
      this.emit("run_ticket_recorded", row.actor, { runId: row.id, actor: row.actor, identifier: ticket.identifier, seq: ticket.seq, outcome: resolved, reason: why });
      return this.get(row.id);
    });
  }

  // ---------- internals ----------

  private end(row: RunRow, stop: { reason: RunStopReason; state: "stopped" | "completed"; detail: Record<string, unknown>; by: string | null; note: string | null }): void {
    const now = nowIso();
    this.db
      .prepare("UPDATE runs SET state = ?, stop_reason = ?, stop_detail = ?, stopped_by = ?, stop_note = ?, updated_at = ?, ended_at = ? WHERE id = ?")
      .run(stop.state, stop.reason, JSON.stringify(stop.detail), stop.by, stop.note, now, now, row.id);
    this.emit("run_stopped", stop.by ?? row.actor, {
      runId: row.id,
      actor: row.actor,
      from: row.state,
      state: stop.state,
      reason: stop.reason,
      detail: stop.detail,
      by: stop.by,
      note: stop.note,
    });
  }

  /** Run events name no issue: a run is not a fact about one issue, and nothing re-emits them. */
  private emit(kind: string, actor: string, payload: Record<string, unknown>): void {
    insertEvent(this.db, { kind, issueId: null, actor, payload });
  }

  private parseBudget(input: StartRunInput, now: string): RunBudget {
    const maxTickets = input.maxTickets ?? null;
    if (maxTickets !== null && (!Number.isInteger(maxTickets) || maxTickets < 1)) {
      throw new StapleError("validation", `--max-tickets is a whole number of at least 1; got ${maxTickets}.`);
    }
    let until: string | null = null;
    if (input.until !== undefined) {
      const seconds = parseRelativeSeconds(input.until);
      until = seconds !== null ? new Date(Date.parse(now) + seconds * 1000).toISOString() : normalizeInstant(input.until.trim());
      if (until === null) {
        throw new StapleError("validation", `--until takes an ISO-8601 instant with a zone (2026-09-28T18:00:00Z) or a duration from now (90m, 2h, 1d); got "${input.until}".`);
      }
      if (Date.parse(until) <= Date.parse(now)) throw new StapleError("validation", `--until ${until} is not in the future.`);
    }
    const ceilingPercent = input.ceilingPercent ?? null;
    if (ceilingPercent !== null && (!Number.isFinite(ceilingPercent) || ceilingPercent <= 0 || ceilingPercent > 100)) {
      throw new StapleError("validation", `--ceiling is a used percentage above 0 and at most 100; got ${ceilingPercent}.`);
    }
    const ceilingAccount = input.ceilingAccount?.trim() ? input.ceilingAccount.trim() : null;
    if (ceilingAccount !== null && ceilingPercent === null) {
      throw new StapleError("validation", "--ceiling-account names the account --ceiling reads; pass --ceiling too.");
    }
    return { maxTickets, until, ceilingPercent, ceilingAccount };
  }

  /**
   * `queue`, or an issue that can hold work: a milestone, or an epic or parent with at
   * least one child. A leaf is refused (check it out instead) and so is a resolved scope,
   * whose goal is already met.
   */
  private resolveScope(raw: string): RunScope {
    const text = raw.trim();
    if (text === "") throw new StapleError("validation", "--scope is queue or the reference of an epic, a parent or a milestone.");
    if (text.toLowerCase() === "queue") return { kind: "queue" };
    const issue = this.store.getIssue(text);
    if (this.store.isResolvedStatus(issue.status)) {
      throw new StapleError("validation", `${issue.identifier} is ${issue.status}; a run over it would have nothing to do.`, { identifier: issue.identifier, status: issue.status });
    }
    if (issue.kind === MILESTONE_KIND) return { kind: "milestone", issueId: issue.id, identifier: issue.identifier };
    const child = this.db.prepare("SELECT 1 AS hit FROM issues WHERE parent_id = ? LIMIT 1").get(issue.id);
    if (!child) {
      throw new StapleError(
        "validation",
        `${issue.identifier} has no children, so there is nothing to run over; check it out instead (staple checkout ${issue.identifier}).`,
        { identifier: issue.identifier },
      );
    }
    return { kind: "issue", issueId: issue.id, identifier: issue.identifier };
  }

  /** The issue ids inside a scope, or null for the whole workspace. */
  private scopeIds(scope: RunScope): Set<string> | null {
    if (scope.kind === "queue") return null;
    const seeds = [scope.issueId];
    if (scope.kind === "milestone") {
      const members = this.db.prepare("SELECT issue_id FROM milestone_members WHERE milestone_id = ?").all(scope.issueId) as Array<{ issue_id: string }>;
      seeds.push(...members.map((member) => member.issue_id));
    }
    const ids = new Set<string>();
    const descendants = this.db.prepare(
      `WITH RECURSIVE sub(id, depth) AS (
         SELECT ?, 0
         UNION SELECT i.id, sub.depth + 1 FROM issues i JOIN sub ON i.parent_id = sub.id WHERE sub.depth < ?
       ) SELECT id FROM sub`,
    );
    for (const seed of seeds) {
      for (const row of descendants.all(seed, MAX_TREE_DEPTH) as Array<{ id: string }>) ids.add(row.id);
    }
    return ids;
  }

  private requireRow(ref: string): RunRow {
    const text = ref.trim();
    const exact = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(text) as unknown as RunRow | undefined;
    if (exact) return exact;
    if (text.length < RUN_ID_PREFIX_MIN) {
      throw new StapleError("not_found", `No run has the id "${text}"; a run id prefix needs at least ${RUN_ID_PREFIX_MIN} characters.`, { runId: text });
    }
    const hits = this.db.prepare("SELECT * FROM runs WHERE substr(id, 1, ?) = ? LIMIT 2").all(text.length, text) as unknown as RunRow[];
    if (hits.length === 1) return hits[0]!;
    if (hits.length === 0) throw new StapleError("not_found", `No run matches "${text}".`, { runId: text });
    throw new StapleError("validation", `"${text}" names more than one run; type more of the id.`, { runId: text });
  }

  private scopeOf(row: RunRow): RunScope {
    if (row.scope_kind === "queue" || row.scope_issue_id === null) return { kind: "queue" };
    const identifier = (this.db.prepare("SELECT identifier FROM issues WHERE id = ?").get(row.scope_issue_id) as { identifier: string } | undefined)?.identifier ?? null;
    return { kind: row.scope_kind === "milestone" ? "milestone" : "issue", issueId: row.scope_issue_id, identifier };
  }

  private toRun(row: RunRow): Run {
    const tickets = (this.db.prepare("SELECT * FROM run_tickets WHERE run_id = ? ORDER BY seq").all(row.id) as unknown as TicketRow[]).map(
      (ticket): RunTicket => ({
        seq: ticket.seq,
        issueId: ticket.issue_id,
        identifier: ticket.identifier,
        takenAt: ticket.taken_at,
        outcome: ticket.outcome as RunTicketOutcome | null,
        reason: ticket.reason,
        attemptId: ticket.attempt_id,
        recordedAt: ticket.recorded_at,
      }),
    );
    return {
      id: row.id,
      actor: row.actor,
      scope: this.scopeOf(row),
      state: row.state as RunState,
      budget: { maxTickets: row.max_tickets, until: row.until_at, ceilingPercent: row.ceiling_percent, ceilingAccount: row.ceiling_account },
      tickets,
      counts: {
        taken: tickets.length,
        done: tickets.filter((ticket) => ticket.outcome === "done").length,
        failed: tickets.filter((ticket) => ticket.outcome === "failed").length,
        open: tickets.filter((ticket) => ticket.outcome === null).length,
      },
      stop:
        row.stop_reason === null
          ? null
          : { reason: row.stop_reason as RunStopReason, detail: JSON.parse(row.stop_detail) as Record<string, unknown>, by: row.stopped_by, note: row.stop_note, at: row.ended_at ?? row.updated_at },
      startedAt: row.started_at,
      updatedAt: row.updated_at,
      endedAt: row.ended_at,
    };
  }
}

function isLive(state: string): boolean {
  return (LIVE_RUN_STATES as readonly string[]).includes(state);
}

/** The scope as events carry it. */
function scopeJson(scope: RunScope): Record<string, unknown> {
  return scope.kind === "queue" ? { kind: "queue" } : { kind: scope.kind, issueId: scope.issueId, identifier: scope.identifier };
}

/** `the queue`, `issue ABC-12`, `milestone ABC-40`: the scope in a sentence. */
export function scopeLabel(scope: RunScope): string {
  if (scope.kind === "queue") return "the queue";
  return `${scope.kind === "milestone" ? "milestone" : "issue"} ${scope.identifier ?? scope.issueId}`;
}
