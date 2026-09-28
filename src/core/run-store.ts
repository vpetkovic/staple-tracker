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
 *                     `--max-tickets` distinct tickets; retrying one is not another),
 *                     `time` (`--until` has passed) or `ceiling` (a current rate-limit
 *                     window's high-water use reached `--ceiling`)
 *   failure_streak    the last two recorded outcomes are both `failed`
 *   scope_gone        the scope no longer resolves: its issue was deleted, or it no
 *                     longer holds anything (a parent that lost every child)
 *   vp_blocked        a ticket this run took is blocked on a named person
 *                     (`unblockOwner`), or nothing in scope is workable and something in
 *                     it is
 *   gate_pending      the scope issue itself holds a pending review gate, or nothing in
 *                     scope is workable and something in it holds one
 *   scope_empty       nothing unresolved is left in scope at all
 *
 * `scope_empty` ends the run `completed`; every other reason ends it `stopped`.
 *
 * "Workable" is the pickup queue's own answer (`QueueStore.effectiveQueue` with the run's
 * scope): a row inside the scope that is `eligible`, or that the run's actor already
 * holds. The scope's own issue is never workable: a run works what is under the
 * container, not the container. "Inside the scope" has one definition, the queue's
 * (`QueueStore.scopeMembership`).
 *
 * ## Waiting is not stopping
 *
 * When nothing is workable, no gate or person-owned block explains it, but unresolved rows
 * remain in scope (claimed by another agent, blocked by a dependency, in review, in a
 * status nobody can check out), the scope is not empty: somebody else is moving it. The
 * rules then answer `{stop: false, wait}` with reason `waiting_on_others` and the rows,
 * and the run stays live. This is the queue's own contract: a null `next` with unresolved
 * rows skipped is stuck, not empty.
 *
 * A gate or a person-owned block elsewhere in the scope does not stop a run that still has
 * workable rows. The queue already steps over them; stopping on them would let one parked
 * row halt every run over the whole queue.
 *
 * ## One write path
 *
 * `run continue` ({@link RunStore.continue}) is the only way a surface or an adapter
 * records a ticket taken or finished. {@link RunStore.recordTicketTaken} and
 * {@link RunStore.recordTicketOutcome} stay public as the low-level record for tests and
 * for repairing a run by hand; no CLI verb or MCP tool exposes them, and an adapter that
 * called them would bypass the claim and the stop rules.
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
import { databaseFile, type DriverAttachment, readDriver } from "./run-attachment.js";
import type { WorkspaceStore } from "./store.js";
import { normalizeInstant, parseRelativeSeconds } from "./telemetry/formats.js";
import { readBudget, type BudgetView } from "./telemetry/read-budget.js";
import { StapleError, nowIso } from "./types.js";

export const RUN_STATES = ["active", "paused", "stopped", "completed"] as const;
export type RunState = (typeof RUN_STATES)[number];

/** A live run owns its scope: a second run for the same actor and scope is refused. */
export const LIVE_RUN_STATES: readonly RunState[] = ["active", "paused"];

/** The stop reasons, in evaluation order. A public JSON contract: never rename one. */
export const RUN_STOP_REASONS = [
  "stopped_by_human",
  "budget",
  "failure_streak",
  "scope_gone",
  "vp_blocked",
  "gate_pending",
  "scope_empty",
] as const;
export type RunStopReason = (typeof RUN_STOP_REASONS)[number];

/**
 * Why a live run takes nothing right now without ending: a public JSON contract, like the
 * stop reasons. `paused` is a person's pause (`run pause`); `waiting_on_others` is the
 * rules' answer when the scope still holds unresolved work nobody lets this run take;
 * `out_of_order` is `queue.policy = strict` refusing the run's next row because an
 * eligible row earlier in the pickup plan lies outside its scope, and the run was not
 * started with an override.
 */
export const RUN_WAIT_REASONS = ["paused", "waiting_on_others", "out_of_order"] as const;
export type RunWaitReason = (typeof RUN_WAIT_REASONS)[number];

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
  /**
   * Why a person let this run step over the pickup plan (`run start --override -m`), or
   * null: under `queue.policy = strict` each out-of-order take is then an override checkout
   * recorded as `queue_overridden`; without one such a take waits (`out_of_order`).
   */
  override: string | null;
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
  /** Rows in scope the run could take (`held: false`) or the actor already holds (`held: true`), in scoped order. */
  workable: Array<{ issueId: string; identifier: string; held: boolean }>;
  /** Unresolved rows in scope the run cannot take, with the queue's eligibility and reason. */
  waiting: Array<{ issueId: string; identifier: string; eligibility: string; reason: string | null }>;
  /** Unresolved issues in scope (the scope issue included) holding a pending review gate. */
  pendingGates: Array<{ issueId: string; identifier: string; owner: string | null }>;
  /** Unresolved issues in scope blocked on a named person. */
  personBlocks: Array<{ issueId: string; identifier: string; owner: string; action: string | null }>;
  /** Null when the run has no ceiling. */
  ceiling: RunCeilingFact | null;
  /**
   * Why the scope can no longer be resolved (its issue was deleted, or it no longer holds
   * anything: a parent that lost every child), or null. Nothing is inside a gone scope.
   */
  scopeGone?: string | null;
}

/** The highest current-window use the ceiling is read against, or why it is unknown. */
export interface RunCeilingFact {
  usedPercent: number | null;
  accountRef: string | null;
  limitKey: string | null;
  /** Why `usedPercent` is null: `no_current_reading`, or the budget read's refusal. */
  missing: string | null;
}

/** Why a live run takes nothing now, without ending. */
export interface RunWait {
  reason: RunWaitReason;
  detail: Record<string, unknown>;
  message: string;
}

export type StopDecision =
  | { stop: false; wait?: RunWait }
  | { stop: true; reason: RunStopReason; state: "stopped" | "completed"; detail: Record<string, unknown>; message: string };

/**
 * What `run status` answers per run: the run, the stop decision now, the facts behind it
 * (null once ended), and the `staple run drive` process attached to it, if any
 * (`run-attachment.ts`; null when no driver is attached).
 */
export interface RunStatus {
  run: Run;
  decision: StopDecision;
  facts: RunFacts | null;
  driver: DriverAttachment | null;
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

  // Distinct tickets: retrying a ticket the run already took (after a failure) is not a
  // second ticket against the budget.
  const taken = new Set(run.tickets.map((ticket) => ticket.issueId)).size;
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

  if (facts.scopeGone) {
    return stop("scope_gone", { why: facts.scopeGone }, `The run's scope ${run.scope.kind === "queue" ? "" : `${run.scope.identifier ?? run.scope.issueId} `}can no longer be worked: ${facts.scopeGone}`);
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
  if (facts.waiting.length > 0) {
    const rows = facts.waiting.map(({ identifier, eligibility, reason }) => ({ identifier, eligibility, reason }));
    return {
      stop: false,
      wait: {
        reason: "waiting_on_others",
        detail: { rows },
        message: `Nothing in scope is workable for this run now; ${rows.map((row) => `${row.identifier} (${row.eligibility})`).join(", ")} still open.`,
      },
    };
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
  override_reason: string | null;
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
  /**
   * A person's reason for letting the run step over the pickup plan: under
   * `queue.policy = strict` each out-of-order take is an override checkout with it.
   */
  override?: string;
}

/** The previous ticket's outcome as one `continue` call recorded it; null when it recorded none. */
export interface ContinueRecorded {
  ref: string;
  outcome: RunTicketOutcome;
  reason: string | null;
  /** How the outcome was known: `stated`, read off the actor's ended `attempt`, or from the ticket's `status`. */
  source: "stated" | "attempt" | "status";
}

/** `no_run` is the one stop reason that ends no run: the actor has none live. */
export const CONTINUE_STOP_REASONS = [...RUN_STOP_REASONS, "no_run"] as const;
export type ContinueStopReason = (typeof CONTINUE_STOP_REASONS)[number];

/** What a caller waits for before asking again after a `wait` answer. */
export const CONTINUE_RETRY_AFTER_SECONDS = 60;

/**
 * THE answer `run continue` / `continue_run` gives a driver: a public JSON contract
 * (docs/runs.md). Exactly one of three actions.
 */
export type ContinueAnswer =
  | {
      action: "take";
      ref: string;
      issueId: string;
      title: string;
      why: string;
      /** True when this is the run's current ticket handed back (still held, no outcome yet). */
      resumed: boolean;
      recorded: ContinueRecorded | null;
      run: Run;
    }
  | {
      action: "wait";
      reason: RunWaitReason;
      detail: Record<string, unknown>;
      message: string;
      retryAfterSeconds: number;
      recorded: ContinueRecorded | null;
      run: Run;
    }
  | {
      action: "stop";
      reason: ContinueStopReason;
      detail: Record<string, unknown>;
      message: string;
      recorded: ContinueRecorded | null;
      /** Null only for `no_run`. */
      run: Run | null;
    };

export interface ContinueInput {
  /** Whose run; with `run` given it must be that run's actor when stated. */
  actor?: string | null;
  /** A run id or prefix; without it, the actor's one live run. */
  run?: string | null;
  /** The previous ticket's outcome, when the caller knows it. */
  outcome?: RunTicketOutcome;
  reason?: string | null;
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
    const driver = readDriver(databaseFile(this.db), run.id);
    if (!isLive(run.state)) {
      return { run, decision: evaluateStopRules(run, { now, workable: [], waiting: [], pendingGates: [], personBlocks: [], ceiling: null }), facts: null, driver };
    }
    const facts = this.facts(run, now);
    return { run, decision: evaluateStopRules(run, facts), facts, driver };
  }

  /**
   * The facts {@link evaluateStopRules} reads, gathered from the store.
   *
   * The scope is the queue's: the whole workspace for `queue`, else exactly the rows
   * `queue next --scope` answers with and the issues `QueueStore.scopeMembership` holds
   * (for gates and blocks, which sit on containers too), plus the scope issue itself for
   * a gate on it. One definition of "inside", so the run and the pickup answer never
   * disagree about what a run may take.
   */
  facts(run: Run, now = nowIso()): RunFacts {
    const rootId = run.scope.kind === "queue" ? null : run.scope.issueId;
    const ceiling = run.budget.ceilingPercent === null ? null : this.ceilingFact(run.budget.ceilingAccount, now);
    const queue = this.store.queue();
    let membership: ReturnType<typeof queue.scopeMembership> | null = null;
    if (rootId !== null) {
      /**
       * A scope that no longer resolves (its issue deleted, or a parent that lost every
       * child) holds nothing. That is a fact the rules stop on (`scope_gone`), never an
       * error: a status listing or a driver's continue must not fail because of it.
       */
      try {
        membership = queue.scopeMembership(rootId);
      } catch (error) {
        if (!(error instanceof StapleError) || (error.code !== "not_found" && error.code !== "validation")) throw error;
        return { now, workable: [], waiting: [], pendingGates: [], personBlocks: [], ceiling, scopeGone: error.message };
      }
    }
    const inScope = (issueId: string): boolean => membership === null || issueId === rootId || membership.contains(issueId);
    // A ticket another live run of the same actor is working is that run's, not this one's.
    const elsewhere = new Set(
      (this.db
        .prepare(
          `SELECT t.issue_id FROM run_tickets t JOIN runs r ON r.id = t.run_id
            WHERE r.actor = ? AND r.id <> ? AND t.outcome IS NULL AND r.state IN (${LIVE_RUN_STATES.map(() => "?").join(", ")})`,
        )
        .all(run.actor, run.id, ...LIVE_RUN_STATES) as Array<{ issue_id: string }>).map((row) => row.issue_id),
    );

    const workable: RunFacts["workable"] = [];
    const waiting: RunFacts["waiting"] = [];
    for (const row of queue.effectiveQueue({ actor: run.actor, scope: rootId }).rows) {
      if (row.issueId === rootId || row.eligibility === "resolved") continue;
      const held = row.eligibility === "claimed" && row.detail?.heldBy === run.actor && !elsewhere.has(row.issueId);
      if (row.eligibility === "eligible" || held) workable.push({ issueId: row.issueId, identifier: row.identifier, held });
      else waiting.push({ issueId: row.issueId, identifier: row.identifier, eligibility: row.eligibility, reason: row.reason });
    }

    const unresolved = (this.db
      .prepare("SELECT id, identifier, status, gate_state, gate_owner, unblock_owner, unblock_action FROM issues ORDER BY identifier")
      .all() as Array<{ id: string; identifier: string; status: string; gate_state: string | null; gate_owner: string | null; unblock_owner: string | null; unblock_action: string | null }>)
      .filter((row) => inScope(row.id) && !this.store.isResolvedStatus(row.status));
    const pendingGates = unresolved
      .filter((row) => row.gate_state === "pending")
      .map((row) => ({ issueId: row.id, identifier: row.identifier, owner: row.gate_owner }));
    const personBlocks = unresolved
      .filter((row) => this.store.categoryOf(row.status) === "blocked" && (row.unblock_owner ?? "").trim() !== "")
      .map((row) => ({ issueId: row.id, identifier: row.identifier, owner: row.unblock_owner!, action: row.unblock_action }));

    return { now, workable, waiting, pendingGates, personBlocks, ceiling, scopeGone: null };
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
    // As on checkout: an override is a person's decision, so it always carries a reason.
    const override = input.override === undefined ? null : input.override.trim();
    if (override === "") {
      throw new StapleError("validation", "An override needs a reason. Pass a non-empty reason (CLI `run start --override -m \"<why>\"`, MCP `override_reason`).");
    }
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
          `INSERT INTO runs (id, actor, scope_kind, scope_key, scope_issue_id, state, max_tickets, until_at, ceiling_percent, ceiling_account, override_reason, started_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, actor, scope.kind, key, scope.kind === "queue" ? null : scope.issueId, budget.maxTickets, budget.until, budget.ceilingPercent, budget.ceilingAccount, override, now, now);
      this.emit("run_started", actor, { runId: id, actor, scope: scopeJson(scope), budget, override });
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
   * `run continue`: THE decision point every provider calls after finishing, or failing,
   * a ticket. One transaction, so two drivers asking at once are serialized and never
   * both take the same row. In order:
   *
   *  1. Resolve the run: `run`, else the actor's one live run. With none live, the
   *     actor's most recently ended run that still has an unsettled ticket (stopped by a
   *     person or a budget mid-ticket), so the ticket is settled and the driver hears why
   *     the run ended. With neither, `{action: "stop", reason: "no_run"}`, not an error: a
   *     driver's loop has one exit, the stop answer. Several live runs without `run` are
   *     refused (validation): name one.
   *  2. Record the current ticket (the run's last open one), in any run state, by
   *     {@link settleCurrent}. A ticket the actor still holds, with no outcome stated, is
   *     not finished: it is RESUMED below rather than recorded.
   *  3. Ended run: answer `stop` with the reason it ended with. Paused run: answer `wait`
   *     (`paused`) and change nothing else: pausing is not stopping, and the run resumes
   *     where it was on `run resume`.
   *  4. Evaluate the stop rules. A trip ends the run (`finish`) and answers `stop`; a wait
   *     answers `wait` (`waiting_on_others`) and leaves the run live. Before that, a ticket
   *     the actor is still working that is no longer inside the scope (the scope is gone,
   *     or the ticket left it) is failed and released rather than resumed.
   *  5. Take, in this order: the current ticket if it is resumed; another row in scope the
   *     actor already holds (finish your own work before claiming more); else the scoped
   *     queue's `next`. The take IS the claim: `checkoutIssue` runs in this same
   *     transaction, so a take is a held ticket or nothing. Under `queue.policy = strict`
   *     the checkout's order guard reads the WHOLE plan, as for any agent: a scope is not
   *     a licence to jump the queue. A run started with an override (`run start --override
   *     -m <why>`) retakes a refused row as an override checkout with that reason, recorded
   *     as `queue_overridden` exactly as `checkout --override` records it; a run without
   *     one answers `wait` (`out_of_order`, with the refusal's detail).
   *
   * On a resume the ticket budget is not read: `--max-tickets` caps what a run TAKES, and
   * handing back the ticket it is still working takes nothing. Every other rule applies.
   */
  continue(input: ContinueInput): ContinueAnswer {
    if (input.outcome !== undefined && !(RUN_TICKET_OUTCOMES as readonly string[]).includes(input.outcome)) {
      throw new StapleError("validation", `A ticket's outcome is done or failed; got "${String(input.outcome)}".`);
    }
    const actor = input.actor?.trim() ? input.actor.trim() : null;
    if (input.run == null && actor === null) throw new StapleError("validation", "run continue needs an actor (--actor or STAPLE_AGENT) or a run id (--run).");
    return this.store.journaled(() => {
      let row: RunRow;
      if (input.run != null) {
        row = this.requireRow(input.run);
        if (actor !== null && actor !== row.actor) {
          throw new StapleError("validation", `Run ${row.id} is ${row.actor}'s, not ${actor}'s; only its actor continues it.`, { runId: row.id, actor: row.actor });
        }
      } else if (this.list({ actor }).length > 0) {
        row = this.requireRow(this.liveRunOf(actor!).id);
      } else {
        const unsettled = this.db
          .prepare(
            `SELECT * FROM runs r WHERE r.actor = ? AND r.state NOT IN (${LIVE_RUN_STATES.map(() => "?").join(", ")})
               AND EXISTS (SELECT 1 FROM run_tickets t WHERE t.run_id = r.id AND t.outcome IS NULL)
             ORDER BY r.ended_at DESC, r.updated_at DESC, r.id DESC LIMIT 1`,
          )
          .get(actor, ...LIVE_RUN_STATES) as unknown as RunRow | undefined;
        if (!unsettled) {
          return {
            action: "stop",
            reason: "no_run",
            detail: { actor },
            message: `${actor} has no active or paused run (staple run start --scope <queue|ref>).`,
            recorded: null,
            run: null,
          };
        }
        row = unsettled;
      }

      let { recorded, resume } = this.settleCurrent(row, input.outcome, input.reason ?? null);
      let run = this.get(row.id);

      if (!isLive(run.state)) {
        const ended = run.stop!;
        return { action: "stop", reason: ended.reason, detail: ended.detail, message: `The run already ended (${ended.reason}).`, recorded, run };
      }
      if (run.state === "paused") {
        return {
          action: "wait",
          reason: "paused",
          detail: {},
          message: `Run ${run.id} is paused; it takes nothing until it is resumed (staple run resume ${run.id}).`,
          retryAfterSeconds: CONTINUE_RETRY_AFTER_SECONDS,
          recorded,
          run,
        };
      }

      const now = nowIso();
      const facts = this.facts(run, now);
      /**
       * A ticket the actor is still working that is no longer inside the scope (its scope is
       * gone, or it was moved out) is not this run's to resume, and must not stay claimed by a
       * run that will never come back to it: it fails and is released, on the record.
       */
      if (resume !== null && run.scope.kind !== "queue") {
        const rootId = run.scope.issueId;
        const outside = facts.scopeGone ? true : !this.store.queue().scopeMembership(rootId).contains(resume.issueId);
        if (outside) {
          const why = `${resume.identifier} is no longer inside ${scopeLabel(run.scope)}${facts.scopeGone ? `: ${facts.scopeGone}` : "."}`;
          ({ recorded } = this.settleCurrent(row, "failed", why));
          resume = null;
          run = this.get(row.id);
        }
      }
      const rulesRun = resume === null ? run : { ...run, budget: { ...run.budget, maxTickets: null } };
      const decision = evaluateStopRules(rulesRun, facts);
      if (decision.stop) {
        run = this.finish(run.id, decision);
        return { action: "stop", reason: decision.reason, detail: decision.detail, message: decision.message, recorded, run };
      }
      if (decision.wait) {
        return { action: "wait", ...decision.wait, retryAfterSeconds: CONTINUE_RETRY_AFTER_SECONDS, recorded, run };
      }

      const held = facts.workable.find((entry) => entry.held);
      const pick = resume ?? held ?? facts.workable.find((entry) => !entry.held)!;
      let why =
        resume !== null
          ? `${pick.identifier} is this run's current ticket and you still hold it: carry on with it.`
          : pick.held
            ? `${pick.identifier} is in scope and already held by you: finish it before taking more.`
            : `${pick.identifier} is next in ${scopeLabel(run.scope)} by the pickup queue's order.`;
      let issue;
      try {
        issue = this.store.checkoutIssue(pick.issueId, run.actor);
      } catch (error) {
        if (!(error instanceof StapleError) || error.code !== "out_of_order") throw error;
        if (run.override === null) {
          return {
            action: "wait",
            reason: "out_of_order",
            detail: error.detail ?? {},
            message: `${error.message} This run follows the plan: queue its scope ahead, or start it with --override -m <why>.`,
            retryAfterSeconds: CONTINUE_RETRY_AFTER_SECONDS,
            recorded,
            run,
          };
        }
        // The refused checkout wrote nothing (its savepoint rolled back): take it again, on the record.
        issue = this.store.checkoutIssue(pick.issueId, run.actor, undefined, { overrideReason: run.override });
        why = `${why} It steps over the plan by this run's override: ${run.override}`;
      }
      this.writeTaken(row, issue.id, issue.identifier);
      return { action: "take", ref: issue.identifier, issueId: issue.id, title: issue.title, why, resumed: resume !== null, recorded, run: this.get(row.id) };
    });
  }

  /**
   * Settle the run's current ticket (its last open one) before anything is decided.
   *
   *  - An outcome stated by the caller wins. `failed` on a ticket the actor still holds
   *    also releases the claim, ending its attempt `failed` with the reason, so a dead
   *    session's ticket goes back to the queue instead of staying held. `done` on a
   *    ticket the actor still holds is refused: move it first (review or done).
   *  - Nothing stated and the actor still holds it, in an active status: not finished.
   *    Nothing is recorded and the ticket is returned to be resumed.
   *  - Else the actor's attempt that ended on it after the take: `completed` is done,
   *    `failed` is failed.
   *  - Else the ticket's status: done, review or gated means the work was handed on
   *    (done); anything else means it left the actor's hands unfinished (failed, with
   *    why). Counting that as a failure is the safe direction: two in a row stop the run
   *    for a person to look.
   */
  private settleCurrent(
    row: RunRow,
    stated: RunTicketOutcome | undefined,
    statedReason: string | null,
  ): { recorded: ContinueRecorded | null; resume: RunFacts["workable"][number] | null } {
    const ticket = this.db
      .prepare("SELECT * FROM run_tickets WHERE run_id = ? AND outcome IS NULL ORDER BY seq DESC LIMIT 1")
      .get(row.id) as unknown as TicketRow | undefined;
    if (!ticket) return { recorded: null, resume: null };
    const issue = this.db.prepare("SELECT id, identifier, status, checkout_agent FROM issues WHERE id = ?").get(ticket.issue_id) as
      | { id: string; identifier: string; status: string; checkout_agent: string | null }
      | undefined;
    const ref = issue?.identifier ?? ticket.identifier;
    const stillHeld = issue !== undefined && issue.checkout_agent === row.actor && this.store.isActiveStatus(issue.status);
    const reasonText = statedReason?.trim() ? statedReason.trim() : null;
    const record = (outcome: RunTicketOutcome, reason: string | null, source: ContinueRecorded["source"], attemptId: string | null = null) => {
      this.writeOutcome(row, ticket, outcome, reason, attemptId);
      return { recorded: { ref, outcome, reason, source }, resume: null };
    };

    if (stated !== undefined) {
      if (stillHeld && stated === "done") {
        throw new StapleError(
          "validation",
          `${ref} is still ${issue!.status} and held by ${row.actor}; move it to review or done before recording it done (staple status ${ref} in_review).`,
          { runId: row.id, identifier: ref, status: issue!.status },
        );
      }
      if (stillHeld && stated === "failed") {
        const why = reasonText ?? "the run's driver reported the ticket failed";
        this.store.releaseIssue(issue!.id, row.actor, { attempt: { outcome: "failed", reason: why } });
        return record("failed", why, "stated");
      }
      return record(stated, reasonText, "stated");
    }
    if (stillHeld && isLive(row.state)) {
      return { recorded: null, resume: { issueId: issue!.id, identifier: issue!.identifier, held: true } };
    }
    if (stillHeld) return { recorded: null, resume: null };

    const attempt = this.db
      .prepare(
        `SELECT id, outcome, end_reason FROM attempts
          WHERE issue_id = ? AND agent = ? AND role = 'worker' AND state = 'ended' AND ended_at >= ?
          ORDER BY ended_at DESC, id DESC LIMIT 1`,
      )
      .get(ticket.issue_id, row.actor, ticket.taken_at) as { id: string; outcome: string | null; end_reason: string | null } | undefined;
    if (attempt?.outcome === "completed") return record("done", null, "attempt", attempt.id);
    if (attempt?.outcome === "failed") return record("failed", attempt.end_reason, "attempt", attempt.id);

    if (issue === undefined) return record("failed", `${ref} no longer exists here.`, "status");
    const category = this.store.categoryOf(issue.status);
    if (category === "done" || category === "review" || category === "gated") return record("done", null, "status");
    const ended = attempt ? `, its attempt ended ${attempt.outcome ?? "without an outcome"}${attempt.end_reason ? ` (${attempt.end_reason})` : ""}` : "";
    const holder = issue.checkout_agent && issue.checkout_agent !== row.actor ? `, now held by ${issue.checkout_agent}` : "";
    return record("failed", `${ref} left ${row.actor}'s hands unfinished: ${issue.status}${holder}${ended}.`, "status");
  }

  /**
   * LOW-LEVEL, not an adapter API (module comment, "One write path"): `continue` takes and
   * claims in one step. Record that the run took a ticket. The run must be active and the issue inside its
   * scope. Taking a ticket the run already holds open is a replay and writes nothing.
   */
  recordTicketTaken(ref: string, issueRef: string): Run {
    return this.store.journaled(() => {
      const row = this.requireRow(ref);
      if (row.state !== "active") {
        throw new StapleError("conflict", `Run ${row.id} is ${row.state}; it takes no tickets.`, { runId: row.id, state: row.state });
      }
      const issue = this.store.getIssue(issueRef);
      const scopeId = row.scope_issue_id;
      if (scopeId !== null && (issue.id === scopeId || !this.store.queue().scopeMembership(scopeId).contains(issue.id))) {
        throw new StapleError("validation", `${issue.identifier} is not work inside ${scopeLabel(this.scopeOf(row))}.`, { identifier: issue.identifier, runId: row.id });
      }
      this.writeTaken(row, issue.id, issue.identifier);
      return this.get(row.id);
    });
  }

  /** Append a taken ticket, unless the run already holds it open (a replay writes nothing). */
  private writeTaken(row: RunRow, issueId: string, identifier: string): boolean {
    const open = this.db.prepare("SELECT seq FROM run_tickets WHERE run_id = ? AND issue_id = ? AND outcome IS NULL").get(row.id, issueId);
    if (open) return false;
    const seq = ((this.db.prepare("SELECT MAX(seq) AS seq FROM run_tickets WHERE run_id = ?").get(row.id) as { seq: number | null }).seq ?? 0) + 1;
    const now = nowIso();
    this.db.prepare("INSERT INTO run_tickets (run_id, seq, issue_id, identifier, taken_at) VALUES (?, ?, ?, ?, ?)").run(row.id, seq, issueId, identifier, now);
    this.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(now, row.id);
    this.emit("run_ticket_taken", row.actor, { runId: row.id, actor: row.actor, identifier, seq });
    return true;
  }

  /**
   * LOW-LEVEL, not an adapter API (module comment, "One write path"): `continue` settles
   * the current ticket itself. Record the outcome of the ticket the run took on
   * `issueRef`: `done` or `failed`.
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
      this.writeOutcome(row, ticket, resolved, why, attemptId);
      return this.get(row.id);
    });
  }

  private writeOutcome(row: RunRow, ticket: TicketRow, outcome: RunTicketOutcome, reason: string | null, attemptId: string | null): void {
    const now = nowIso();
    this.db
      .prepare("UPDATE run_tickets SET outcome = ?, reason = ?, attempt_id = ?, recorded_at = ? WHERE run_id = ? AND seq = ?")
      .run(outcome, reason, attemptId, now, row.id, ticket.seq);
    this.db.prepare("UPDATE runs SET updated_at = ? WHERE id = ?").run(now, row.id);
    this.emit("run_ticket_recorded", row.actor, { runId: row.id, actor: row.actor, identifier: ticket.identifier, seq: ticket.seq, outcome, reason });
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
      override: row.override_reason,
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
