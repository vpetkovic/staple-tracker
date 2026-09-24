/**
 * Execution attempts: where they open, end and change, as side effects of LOCAL mutations.
 *
 * Contract: `docs/execution-telemetry.md`, "How an attempt opens", "The resume rule", "How
 * an attempt ends", "Orphaned attempts are closed at read time", "Lifecycle" and
 * "Concurrency context".
 *
 * ## Only local mutations, never an apply
 *
 * Every rule here is called by a `WorkspaceStore` mutator inside its own journal scope, in
 * the same transaction as the mutation — like `startedAt`. Nothing in `cloud/apply.ts`
 * calls in here: a pulled operation applies under a suppressed journal scope, so an attempt
 * row an apply changed would change on the applying device alone. Attempt state reaches
 * other devices only as `attempt` and `attemptTransition` operations, with the originating
 * device's own timestamps.
 *
 * ## One scope, several operations
 *
 * The seam journals one operation per entity per scope, so a local steal journals the
 * `issue.update` it always did, an `attempt.update` for the attempt it ends, an
 * `attempt.create` for the one it opens and an `attemptTransition.create` per transition.
 * Attempts are not row-diff tables (`cloud/row-diff.ts`), so each payload is written here in
 * full: an end always carries all seven end fields.
 */
import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { readConfig } from "../../config/file.js";
import { stapleHome } from "../../config/home.js";
import { claudeBindingFor, claudeConfigDir, codexBindingFor, codexHome } from "./bindings.js";
import { DEFAULT_TELEMETRY, isKnownBinding, type KnownBinding, type TelemetryConfig } from "./config.js";
import type { Journal } from "../journal.js";
import { StapleError, nowIso } from "../types.js";
import {
  HARNESS_NAMES,
  INFERRED_INTERRUPT_REASONS,
  PAUSE_REASONS,
  REPORTED_INTERRUPT_REASONS,
  attemptByKey,
  attemptPayload,
  attemptsOfIssue,
  endOf,
  insertAttempt,
  insertTransition,
  emitTransitionEvent,
  readAttempt,
  sessionRefOf,
  storedOpenAttempts,
  transitionPayload,
  writeEnd,
  type AttemptClaim,
  type AttemptEnd,
  type AttemptHarness,
  type AttemptRecord,
  type AttemptTransition,
  type EstimateReading,
  type ProviderBinding,
} from "./attempt-records.js";
import {
  countEffectivelyOpen,
  effectivelyOpen,
  evaluateIssue,
  issueFacts,
  lastActivityOf,
  viewAttempt,
  type AttemptView,
  type IssueFacts,
} from "./attempt-derive.js";
import { ORPHAN_END_REASONS } from "../cloud/attempt-ends.js";
import { presenceCounts, refreshWorkspacePresence } from "./presence.js";

/** What an agent may self-report on an attempt-opening or claim-clearing write. */
export interface AttemptOptions {
  /** The raw harness session id; stored only as its hashed `sessionRef`. */
  readonly harnessSession?: string;
  readonly harness?: string;
  readonly harnessVersion?: string;
  readonly model?: string;
  /** The provider account (`accountRef`) this attempt spends from. */
  readonly account?: string;
  /** The attempt's idempotency key: a replay returns the original attempt. */
  readonly idempotencyKey?: string;
  /** `failed`, on the claim-clearing mutation that accompanies it. */
  readonly outcome?: string;
  readonly reason?: string;
}

/** What the store supplies. Kept narrow so this module never reaches into the store's privates. */
export interface AttemptHost {
  readonly db: DatabaseSync;
  readonly journal: Journal;
  /** `timing.subtreePlan` of the issue, read now. */
  estimateReading(issueId: string): EstimateReading;
  /** The claim's scope and fencing token as the claim payload reports them. */
  claimOf(issueId: string): AttemptClaim;
}

/** The machine-wide half of the concurrency context (`presence.ts`). */
export interface PresenceCounts {
  /** Attempts opened on this machine the index holds as open, excluding `exclude`. */
  count(exclude: string, accountRef: string | null): { all: number; account: number | null } | null;
}

/** After a committed change to an attempt this machine opened: the presence index, best effort. */
export function refreshPresence(db: DatabaseSync, home?: string): void {
  refreshWorkspacePresence(db, home);
}

const ACCOUNT_REF = /^[a-z0-9][a-z0-9-]{0,63}$/;
const ONE_LINE = /^[^\r\n]*$/;

/** The provider a harness spends from, when nothing more specific says. */
const HARNESS_PROVIDER: Readonly<Record<string, string>> = { claude_code: "anthropic", codex: "openai" };
/** This machine's telemetry config, or the default when it cannot be read. */
function telemetryConfig(): TelemetryConfig {
  try {
    return readConfig(stapleHome()).config.telemetry;
  } catch {
    return DEFAULT_TELEMETRY;
  }
}

/**
 * The binding a harness resolves to on this machine — a Claude Code binding by its config
 * directory (`CLAUDE_CONFIG_DIR`, or `~/.claude`), a Codex one by its home (`CODEX_HOME`,
 * or `~/.codex`) — by the resolution budget ingestion uses (`bindings.ts`), so an attempt
 * and a sample from the same harness name the same account.
 */
function bindingFor(config: TelemetryConfig, harness: string): KnownBinding | null {
  if (harness === "claude_code") return claudeBindingFor(config, claudeConfigDir());
  if (harness === "codex") return codexBindingFor(config, codexHome());
  return null;
}

/** Validate what an agent reported. Refused as `validation` before anything is written. */
export function assertAttemptOptions(opts: AttemptOptions | undefined): void {
  if (!opts) return;
  if (opts.harness !== undefined && !(HARNESS_NAMES as readonly string[]).includes(opts.harness)) {
    throw new StapleError("validation", `--harness must be one of ${HARNESS_NAMES.join(", ")}; got "${opts.harness}".`);
  }
  if (opts.harnessSession !== undefined) {
    if (opts.harnessSession.trim() === "") throw new StapleError("validation", "--harness-session cannot be empty.");
    if (opts.harness === undefined) {
      throw new StapleError(
        "validation",
        "--harness-session needs --harness: the session reference is hashed with the harness name, so it can be joined to budget samples from the same session.",
      );
    }
  }
  if (opts.account !== undefined && !ACCOUNT_REF.test(opts.account)) {
    throw new StapleError("validation", `--account must be a slug matching [a-z0-9][a-z0-9-]{0,63}; got "${opts.account}".`);
  }
  if (opts.outcome !== undefined && opts.outcome !== "failed") {
    throw new StapleError("validation", `--outcome takes only "failed": every other outcome follows from the mutation. Got "${opts.outcome}".`);
  }
  if (opts.outcome === "failed" && (opts.reason === undefined || opts.reason.trim() === "")) {
    throw new StapleError("validation", "--outcome failed needs --reason: only the agent can say why it could not do the work.");
  }
  if (opts.reason !== undefined && opts.outcome === undefined) {
    throw new StapleError("validation", "--reason is the reason for --outcome failed; pass both, or neither.");
  }
  if (opts.idempotencyKey !== undefined && opts.idempotencyKey.trim() === "") {
    throw new StapleError("validation", "--attempt-key cannot be empty.");
  }
}

/** True when these options carry an explicit `failed` outcome. */
export function failsAttempt(opts: AttemptOptions | undefined): boolean {
  return opts?.outcome === "failed";
}

/** The default outcome for leaving `active` into `category` (the "How an attempt ends" table). */
function outcomeForCategory(category: string | null): { outcome: string; endReason: string } {
  switch (category) {
    case "review":
      return { outcome: "completed", endReason: "review" };
    case "done":
      return { outcome: "completed", endReason: "done" };
    case "blocked":
      return { outcome: "yielded", endReason: "blocked" };
    case "cancelled":
      return { outcome: "yielded", endReason: "cancelled" };
    case "gated":
      return { outcome: "yielded", endReason: "gated" };
    default:
      return { outcome: "yielded", endReason: "returned" };
  }
}

const withAttempts = new WeakSet<DatabaseSync>();

/** Whether this database has reached migration 013. Remembered once true. */
function hasAttemptTables(db: DatabaseSync): boolean {
  if (withAttempts.has(db)) return true;
  const hit = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'attempts'").get() !== undefined;
  if (hit) withAttempts.add(db);
  return hit;
}

/** One mutation's attempt work. A fresh one per call; it holds nothing between mutations. */
export class AttemptLedger {
  /** The attempt the last mutation opened, ended or changed, for the surfaces that return it. */
  private touched: string | null = null;
  /** Whether an attempt row was written since the last {@link takeDirty}. */
  private dirty = false;

  constructor(private readonly host: AttemptHost) {}

  private get db(): DatabaseSync {
    return this.host.db;
  }

  /** This device, as the journal knows it; null on a machine that never connected. */
  private deviceId(): string | null {
    return this.host.journal.deviceIdentity();
  }

  /** The attempt the most recent write returned, as it reads. */
  result(): AttemptView | null {
    return this.touched === null ? null : viewAttempt(this.db, this.touched);
  }

  /** Forget which attempt the last command returned: a new command is starting. */
  forgetResult(): void {
    this.touched = null;
  }

  /** True once when an attempt row was written since the last call (the presence index's cue). */
  takeDirty(): boolean {
    const dirty = this.dirty;
    this.dirty = false;
    return dirty;
  }

  // ---------------------------------------------------------------- opening

  /**
   * Open an attempt as the side effect of `openedBy`. Returns the original attempt instead
   * when the idempotency key has been used on this issue before.
   */
  open(issue: { id: string; identifier: string }, agent: string, openedBy: string, opts: AttemptOptions = {}, claim?: AttemptClaim): AttemptRecord {
    if (opts.idempotencyKey !== undefined) {
      const replay = attemptByKey(this.db, issue.id, opts.idempotencyKey);
      if (replay) {
        this.touched = replay.id;
        return replay;
      }
    }
    /**
     * An issue's attempts are ordered by `startedAt`, then a random `id`, so one opened in the
     * same millisecond as the one before it — an interruption reported and re-claimed by a
     * script — starts a millisecond later, and the order is the order they happened in.
     */
    const latest = (this.db.prepare("SELECT MAX(started_at) AS at FROM attempts WHERE issue_id = ?").get(issue.id) as { at: string | null }).at;
    const now = nowIso();
    const at = latest !== null && now <= latest ? new Date(Date.parse(latest) + 1).toISOString() : now;
    const resume = this.resumeFor(issue.id);
    const missing: Record<string, string> = {};
    let harness: AttemptHarness | null = null;
    if (opts.harness !== undefined) {
      harness = {
        name: opts.harness,
        version: opts.harnessVersion ?? null,
        sessionRef: opts.harnessSession !== undefined ? sessionRefOf(opts.harness, opts.harnessSession) : null,
        model: opts.model ?? null,
        provenance: "self_reported",
      };
      if (harness.version === null) missing["harness.version"] = "not_supplied";
      if (harness.sessionRef === null) missing["harness.sessionRef"] = "not_supplied";
      if (harness.model === null) missing["harness.model"] = "not_supplied";
    } else {
      missing.harness = "not_supplied";
    }
    let providerBinding: ProviderBinding | null = null;
    if (opts.account !== undefined) {
      const bound = telemetryConfig().bindings.filter(isKnownBinding).find((binding) => binding.accountRef === opts.account);
      providerBinding = {
        provider: bound?.provider ?? (opts.harness !== undefined ? (HARNESS_PROVIDER[opts.harness] ?? null) : null),
        accountRef: opts.account,
        source: "flag",
      };
      if (providerBinding.provider === null) missing["providerBinding.provider"] = "not_supplied";
    } else if (opts.harness !== undefined) {
      const bound = bindingFor(telemetryConfig(), opts.harness);
      if (bound) providerBinding = { provider: bound.provider ?? HARNESS_PROVIDER[opts.harness] ?? null, accountRef: bound.accountRef, source: "machine_binding" };
      else missing.providerBinding = "no_binding_configured";
    } else {
      missing.providerBinding = "not_supplied";
    }
    const record: AttemptRecord = {
      id: randomUUID(),
      issueId: issue.id,
      agent,
      state: "running",
      outcome: null,
      endReason: null,
      endDetection: null,
      endedBy: null,
      openedBy,
      resumesAttemptId: resume.id,
      startedAt: at,
      endedAt: null,
      endedAtSource: null,
      deviceId: this.deviceId(),
      claim: claim ?? this.host.claimOf(issue.id),
      harness,
      providerBinding,
      estimateAtStart: this.host.estimateReading(issue.id),
      idempotencyKey: opts.idempotencyKey ?? null,
      provenance: "recorded",
      missing,
    };
    insertAttempt(this.db, record);
    this.dirty = true;
    this.host.journal.record({ entity: "attempt", entityId: record.id, verb: "create", payload: attemptPayload(record), actor: agent });
    this.transition(record, {
      kind: "attempt_started",
      at,
      actor: agent,
      detection: null,
      reason: null,
      detail: { openedBy, resumesAttemptId: resume.id, ...(resume.contested ? { resumeBasis: "contested" } : {}) },
    });
    this.touched = record.id;
    return record;
  }

  /**
   * The resume rule: if the issue's latest attempt (by `startedAt`, then `id`) has
   * effectively ended `interrupted` or `orphaned`, the new attempt names it. Evaluated by
   * the opening device and stored, so it never changes afterwards.
   */
  private resumeFor(issueId: string): { id: string | null; contested: boolean } {
    const attempts = attemptsOfIssue(this.db, issueId);
    const latest = attempts[attempts.length - 1];
    if (!latest) return { id: null, contested: false };
    const evaluation = evaluateIssue(attempts, issueFacts(this.db, issueId), "read").get(latest.id)!;
    const orphaned = latest.state !== "ended" && evaluation.orphanReason !== null;
    const interrupted = latest.state === "ended" && latest.outcome === "interrupted";
    if (!orphaned && !interrupted) return { id: null, contested: false };
    return { id: latest.id, contested: evaluation.contested };
  }

  // ----------------------------------------------------------------- ending

  /**
   * The attempts a claim-clearing mutation ends: those effectively open on this device's own
   * rows as they stood BEFORE the mutation (all five clauses, no contested skip). Normally
   * one, the claim holder's; none when the claim predates attempts.
   */
  targets(issueId: string, before: IssueFacts): AttemptRecord[] {
    return effectivelyOpen(this.db, issueId, "own", before);
  }

  /** End one attempt, journaling all seven end fields and one transition. */
  end(
    attempt: AttemptRecord,
    fields: { outcome: string; endReason: string; endDetection: string; endedBy: string | null; endedAt: string; endedAtSource: string },
    transition: { kind: "attempt_ended" | "attempt_interrupted"; actor: string | null; reason: string | null; detail?: Record<string, unknown> },
  ): void {
    const end: AttemptEnd = {
      state: "ended",
      outcome: fields.outcome,
      endReason: fields.endReason,
      endDetection: fields.endDetection,
      endedBy: fields.endedBy,
      endedAt: fields.endedAt,
      endedAtSource: fields.endedAtSource,
    };
    writeEnd(this.db, attempt.id, end);
    this.dirty = true;
    this.host.journal.record({ entity: "attempt", entityId: attempt.id, verb: "update", payload: { ...endOf(end) }, actor: transition.actor });
    this.transition(
      { ...attempt, ...end },
      {
        kind: transition.kind,
        at: nowIso(),
        actor: transition.actor,
        detection: fields.endDetection,
        reason: transition.reason,
        detail: transition.kind === "attempt_ended" ? { outcome: fields.outcome, endReason: fields.endReason, ...(transition.detail ?? {}) } : (transition.detail ?? {}),
      },
    );
    this.touched = attempt.id;
  }

  /**
   * The ending a claim-clearing mutation writes: the default row for where it goes, or the
   * agent's explicit `failed`, which overrides it.
   */
  endByMutation(
    attempt: AttemptRecord,
    base: { outcome: string; endReason: string; inferred?: boolean; interrupted?: boolean },
    actor: string | null,
    opts: AttemptOptions | undefined,
  ): void {
    const now = nowIso();
    if (failsAttempt(opts)) {
      this.end(
        attempt,
        { outcome: "failed", endReason: opts!.reason!.trim(), endDetection: actor === attempt.agent ? "reported" : "by_other", endedBy: actor, endedAt: now, endedAtSource: "mutation" },
        { kind: "attempt_ended", actor, reason: opts!.reason!.trim() },
      );
      return;
    }
    if (base.inferred) {
      this.end(
        attempt,
        {
          outcome: base.outcome,
          endReason: base.endReason,
          endDetection: "inferred",
          endedBy: actor,
          endedAt: lastActivityOf(this.db, attempt.issueId, attempt.agent, attempt.startedAt),
          endedAtSource: "last_activity",
        },
        { kind: "attempt_interrupted", actor, reason: base.endReason },
      );
      return;
    }
    this.end(
      attempt,
      { outcome: base.outcome, endReason: base.endReason, endDetection: actor !== null && actor === attempt.agent ? "reported" : "by_other", endedBy: actor, endedAt: now, endedAtSource: "mutation" },
      { kind: base.interrupted ? "attempt_interrupted" : "attempt_ended", actor, reason: base.interrupted ? base.endReason : null },
    );
  }

  // ------------------------------------------------------- the store's hooks

  /** `checkout` created a new claim. */
  checkedOut(issue: { id: string; identifier: string }, agent: string, opts?: AttemptOptions): void {
    this.open(issue, agent, "checkout", opts);
  }

  /** `checkout --steal-if-stale` took the claim from `before.checkoutAgent`. */
  stolen(issue: { id: string; identifier: string }, agent: string, before: IssueFacts, opts?: AttemptOptions): void {
    for (const attempt of this.targets(issue.id, before)) {
      this.endByMutation(attempt, { outcome: "interrupted", endReason: "claim_stolen", inferred: true }, agent, undefined);
    }
    this.open(issue, agent, "steal", opts);
  }

  /**
   * The holder re-claimed an issue it already holds (the crash-recovery path). An open
   * attempt stays open — gaining an `attempt_session_added` when the harness session
   * differs, which is NOT an interruption — and otherwise a new attempt opens, `reclaim`.
   */
  reclaimed(issue: { id: string; identifier: string }, agent: string, opts: AttemptOptions = {}): void {
    if (opts.idempotencyKey !== undefined) {
      const replay = attemptByKey(this.db, issue.id, opts.idempotencyKey);
      if (replay) {
        this.touched = replay.id;
        return;
      }
    }
    const open = effectivelyOpen(this.db, issue.id, "own").find((attempt) => attempt.agent === agent);
    if (!open) {
      this.open(issue, agent, "reclaim", opts);
      return;
    }
    this.touched = open.id;
    if (opts.harnessSession === undefined || opts.harness === undefined) return;
    const sessionRef = sessionRefOf(opts.harness, opts.harnessSession);
    if (open.harness?.sessionRef === sessionRef) return;
    this.transition(open, {
      kind: "attempt_session_added",
      at: nowIso(),
      actor: agent,
      detection: "reported",
      reason: null,
      detail: { sessionRef, harness: opts.harness, ...(opts.model !== undefined ? { model: opts.model } : {}) },
    });
  }

  /** `release`, plain or `--if-stale`. `before` is the issue as it stood. */
  released(issueId: string, before: IssueFacts, actor: string | null, stale: boolean, opts?: AttemptOptions): void {
    for (const attempt of this.targets(issueId, before)) {
      this.endByMutation(
        attempt,
        stale ? { outcome: "interrupted", endReason: "released_stale", inferred: true } : { outcome: "yielded", endReason: "released" },
        actor,
        opts,
      );
    }
  }

  /**
   * A status write moved the issue from `categoryBefore` to `categoryAfter`. Leaving
   * `active` ends the attempt by the category entered; entering it without a checkout opens
   * one with `claim.scope: "none"`, whose agent is the actor.
   */
  statusMoved(
    issue: { id: string; identifier: string },
    before: IssueFacts,
    categoryBefore: string | null,
    categoryAfter: string | null,
    actor: string | null,
    opts?: AttemptOptions,
  ): void {
    if (categoryBefore === "active" && categoryAfter !== "active") {
      for (const attempt of this.targets(issue.id, before)) this.endByMutation(attempt, outcomeForCategory(categoryAfter), actor, opts);
      return;
    }
    if (categoryBefore !== "active" && categoryAfter === "active") {
      this.open(issue, actor ?? "unknown", "status", opts, { scope: "none", fencingToken: null });
    }
  }

  // ------------------------------------------------------------- reporting

  /**
   * `staple attempt pause|resume|milestone|interrupt`: an event on the issue's open
   * attempt. `conflict` when there is none in the state the event needs, `validation` for a
   * reason the event cannot carry.
   */
  record(
    issue: { id: string; identifier: string },
    event: string,
    actor: string,
    input: { reason?: string; label?: string; commentId?: string; document?: { key: string; revision: number } },
  ): AttemptRecord {
    const open = effectivelyOpen(this.db, issue.id, "own");
    const attempt = open.find((candidate) => candidate.agent === actor) ?? (event === "interrupt" ? open[0] : undefined);
    if (!attempt) {
      const held = open[0];
      throw new StapleError(
        "conflict",
        held
          ? `${issue.identifier}'s open attempt belongs to ${held.agent}, not ${actor}: only the holder can ${event} it.`
          : `${issue.identifier} has no open attempt to ${event}. An attempt opens with a checkout or a status write into the active category.`,
        { issueId: issue.id, heldBy: held?.agent ?? null },
      );
    }
    const reason = input.reason?.trim() || undefined;
    const at = nowIso();
    const detection = actor === attempt.agent ? "reported" : "by_other";
    switch (event) {
      case "pause": {
        if (attempt.state !== "running") throw new StapleError("conflict", `${issue.identifier}'s attempt is ${attempt.state}, not running: only a running attempt pauses.`);
        if (reason === undefined || !(PAUSE_REASONS as readonly string[]).includes(reason)) {
          throw new StapleError("validation", `A pause needs --reason, one of ${PAUSE_REASONS.join(", ")}.`);
        }
        this.setState(attempt, "paused", actor);
        this.transition(attempt, { kind: "attempt_paused", at, actor, detection, reason, detail: {} });
        break;
      }
      case "resume": {
        if (attempt.state !== "paused") throw new StapleError("conflict", `${issue.identifier}'s attempt is ${attempt.state}, not paused: only a paused attempt resumes.`);
        if (reason !== undefined && !ONE_LINE.test(reason)) throw new StapleError("validation", "A resume reason is one line.");
        this.setState(attempt, "running", actor);
        this.transition(attempt, { kind: "attempt_resumed", at, actor, detection, reason: reason ?? null, detail: {} });
        break;
      }
      case "milestone": {
        if (attempt.state !== "running") throw new StapleError("conflict", `${issue.identifier}'s attempt is ${attempt.state}, not running: a milestone is recorded on a running attempt.`);
        const label = input.label?.trim();
        if (!label || !ONE_LINE.test(label)) throw new StapleError("validation", "A milestone needs a one-line label (-m).");
        const detail: Record<string, unknown> = { label };
        if (input.commentId !== undefined) {
          if (!this.db.prepare("SELECT 1 FROM comments WHERE id = ? AND issue_id = ?").get(input.commentId, issue.id)) {
            throw new StapleError("validation", `No comment ${input.commentId} on ${issue.identifier} to point the milestone at.`);
          }
          detail.commentId = input.commentId;
        }
        if (input.document !== undefined) {
          if (!this.db.prepare("SELECT 1 FROM document_revisions WHERE issue_id = ? AND key = ? AND revision = ?").get(issue.id, input.document.key, input.document.revision)) {
            throw new StapleError("validation", `No document ${input.document.key} r${input.document.revision} on ${issue.identifier} to point the milestone at.`);
          }
          detail.document = { key: input.document.key, revision: input.document.revision };
        }
        this.transition(attempt, { kind: "attempt_milestone", at, actor, detection, reason: null, detail });
        break;
      }
      case "interrupt": {
        if (reason === undefined) throw new StapleError("validation", `An interruption needs --reason, one of ${REPORTED_INTERRUPT_REASONS.join(", ")}.`);
        if ((INFERRED_INTERRUPT_REASONS as readonly string[]).includes(reason) || ORPHAN_END_REASONS.has(reason)) {
          throw new StapleError("validation", `"${reason}" is written only by the mutation it names, never reported. A report gives one of ${REPORTED_INTERRUPT_REASONS.join(", ")}.`);
        }
        if (!(REPORTED_INTERRUPT_REASONS as readonly string[]).includes(reason)) {
          throw new StapleError("validation", `An interruption's reason is one of ${REPORTED_INTERRUPT_REASONS.join(", ")}; got "${reason}".`);
        }
        this.end(
          attempt,
          { outcome: "interrupted", endReason: reason, endDetection: detection, endedBy: actor, endedAt: at, endedAtSource: "mutation" },
          { kind: "attempt_interrupted", actor, reason },
        );
        break;
      }
      default:
        throw new StapleError("validation", `Unknown attempt event "${event}": use pause, resume, milestone or interrupt.`);
    }
    this.touched = attempt.id;
    return readAttempt(this.db, attempt.id)!;
  }

  /** Pause and resume change `state` alone, and still send all seven end fields as one unit. */
  private setState(attempt: AttemptRecord, state: "running" | "paused", actor: string): void {
    const end: AttemptEnd = { ...endOf(attempt), state };
    writeEnd(this.db, attempt.id, end);
    this.dirty = true;
    this.host.journal.record({ entity: "attempt", entityId: attempt.id, verb: "update", payload: { ...endOf(end) }, actor });
  }

  // --------------------------------------------------------- the orphan end

  /**
   * Write down, once, the end of every attempt this device opened that the rule now closes.
   *
   * A derivation is not monotonic — a status recategorized out of `active` and back, a
   * restore, a conflict resolution can make the clauses stop holding — so the opening
   * device journals a stored orphan end at the start of a mutating command, when a pull on
   * a synchronized workspace last reached the head of the log, for issues whose claim pair
   * it holds no open conflict on. All five clauses, against its own rows, no contested skip.
   * An ordinary `attempt.update`: `interrupted`, the clause's reason, `inferred`, dated at the
   * attempt's last activity.
   */
  writeOrphanEnds(): number {
    // A database a store was opened on before its migrations ran (a test, a repair path).
    if (!hasAttemptTables(this.db)) return 0;
    const device = this.deviceId();
    const state = this.db
      .prepare("SELECT epoch, cursor, head_reached_cursor FROM sync_state WHERE id = 1")
      .get() as { epoch: number; cursor: string | null; head_reached_cursor: string | null } | undefined;
    const synchronized = state !== undefined && (state.cursor !== null || state.epoch > 0);
    if (synchronized && (state!.head_reached_cursor === null || state!.head_reached_cursor !== state!.cursor)) return 0;
    const mine = storedOpenAttempts(this.db).filter((attempt) => (device !== null && attempt.deviceId === device) || (attempt.deviceId === null && !synchronized));
    if (mine.length === 0) return 0;
    let written = 0;
    for (const issueId of new Set(mine.map((attempt) => attempt.issueId))) {
      const contested = this.db
        .prepare(
          `SELECT 1 FROM sync_conflicts WHERE entity = 'issue' AND entity_id = ? AND resolved_at IS NULL
             AND field IN ('checkout_agent', 'checkout_at') LIMIT 1`,
        )
        .get(issueId);
      if (contested) continue;
      const attempts = attemptsOfIssue(this.db, issueId);
      const evaluation = evaluateIssue(attempts, issueFacts(this.db, issueId), "own");
      for (const attempt of mine.filter((candidate) => candidate.issueId === issueId)) {
        const reason = evaluation.get(attempt.id)?.orphanReason ?? null;
        if (reason === null) continue;
        this.end(
          attempt,
          {
            outcome: "interrupted",
            endReason: reason,
            endDetection: "inferred",
            endedBy: null,
            endedAt: lastActivityOf(this.db, attempt.issueId, attempt.agent, attempt.startedAt),
            endedAtSource: "last_activity",
          },
          { kind: "attempt_interrupted", actor: null, reason },
        );
        written += 1;
      }
    }
    return written;
  }

  // -------------------------------------------------------------- transitions

  /**
   * One immutable transition: the row, its `attemptTransition.create`, and the local event
   * of the same name under the transition-derived key.
   */
  private transition(
    attempt: AttemptRecord,
    input: { kind: string; at: string; actor: string | null; detection: string | null; reason: string | null; detail: Record<string, unknown> },
  ): void {
    /**
     * Transitions are ordered by `at`, then `id`, and ids are random: two transitions of one
     * attempt inside one millisecond — a start and an end in a fast script — would be ordered
     * by chance. So an attempt's transitions written here are strictly increasing in `at`.
     */
    const last = (this.db.prepare("SELECT MAX(at) AS at FROM attempt_transitions WHERE attempt_id = ?").get(attempt.id) as { at: string | null }).at;
    const at = last !== null && input.at <= last ? new Date(Date.parse(last) + 1).toISOString() : input.at;
    const transition: AttemptTransition = {
      id: randomUUID(),
      attemptId: attempt.id,
      kind: input.kind,
      at,
      actor: input.actor,
      detection: input.detection,
      reason: input.reason,
      detail: input.detail,
      concurrency: this.concurrency(attempt, at),
    };
    insertTransition(this.db, transition);
    this.host.journal.record({ entity: "attemptTransition", entityId: transition.id, verb: "create", payload: transitionPayload(transition), actor: input.actor });
    emitTransitionEvent(this.db, transition, attempt.issueId);
  }

  /**
   * What else was running when a transition happened, as this machine knows it. Every count
   * includes the attempt the transition belongs to, so `1` on an account means no other
   * attempt this machine started was open on it.
   */
  private concurrency(attempt: AttemptRecord, at: string): Record<string, unknown> {
    const missing: Record<string, string> = {};
    const openInWorkspace = countEffectivelyOpen(this.db) + (attempt.state === "ended" ? 1 : 0);
    const startedHere = attempt.deviceId === this.deviceId() ? 1 : 0;
    const accountRef = attempt.providerBinding?.accountRef ?? null;
    let counts: { all: number; account: number | null } | null = null;
    try {
      counts = presenceCounts()?.count(attempt.id, accountRef) ?? null;
    } catch {
      counts = null;
    }
    let storedOpenAttemptsStartedHere: number | null = null;
    let storedOpenAttemptsOnAccountStartedHere: number | null = null;
    if (counts === null) {
      missing.storedOpenAttemptsStartedHere = "source_unavailable";
    } else {
      storedOpenAttemptsStartedHere = counts.all + startedHere;
    }
    if (accountRef === null) missing.storedOpenAttemptsOnAccountStartedHere = "no_provider_binding";
    else if (counts === null || counts.account === null) missing.storedOpenAttemptsOnAccountStartedHere = "source_unavailable";
    else storedOpenAttemptsOnAccountStartedHere = counts.account + startedHere;
    const synced = this.db.prepare("SELECT last_sync_at FROM sync_state WHERE id = 1").get() as { last_sync_at: string | null } | undefined;
    const workspaceSyncedThrough = synced?.last_sync_at ?? null;
    if (workspaceSyncedThrough === null) missing.workspaceSyncedThrough = "not_connected";
    return {
      observedAt: at,
      scope: "device",
      openAttemptsInWorkspace: openInWorkspace,
      storedOpenAttemptsStartedHere,
      storedOpenAttemptsOnAccountStartedHere,
      workspaceSyncedThrough,
      missing,
    };
  }
}

/**
 * The stored orphan ends a sync owes, written in a scope of their own (`sync.ts`, after the
 * pull). Only the orphan write is reachable from here, so the host needs nothing else.
 */
export function writeOwnOrphanEnds(db: DatabaseSync, journal: Journal): number {
  const ledger = new AttemptLedger({
    db,
    journal,
    estimateReading: () => ({ estimatedSeconds: null, source: "none" }),
    claimOf: () => ({ scope: "local", fencingToken: null }),
  });
  return journal.run(() => ledger.writeOrphanEnds());
}

/** Re-exported for the store and the surfaces. */
export { viewAttempt, type AttemptView } from "./attempt-derive.js";
export { issueFacts, type IssueFacts } from "./attempt-derive.js";
