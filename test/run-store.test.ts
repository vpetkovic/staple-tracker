import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { describeSchema, runMigrations } from "../src/core/migrations/runner.js";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { bindJournal } from "../src/core/journal.js";
import { writeStoredRepositoryId } from "../src/core/repo-identity.js";
import {
  evaluateStopRules,
  RunStore,
  type BudgetReader,
  type RunFacts,
  type RunForRules,
} from "../src/core/run-store.js";
import type { BudgetView } from "../src/core/telemetry/read-budget.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError, setClock } from "../src/core/types.js";
import { FIXTURES, withFixture } from "./fixtures/schema/support.js";

/**
 * Autopilot runs: the record, the one-live-run rule, the events, and every stop rule
 * tripped through a real store over real migrations. The pure-function block at the end
 * pins the order the rules are read in.
 */

const BOT = "bot";

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
let runs: RunStore;
beforeEach(() => {
  store = memStore();
  runs = store.runs();
});
afterEach(() => setClock(null));

function refused(fn: () => unknown, code: string): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe(code);
    return error as StapleError;
  }
  throw new Error(`expected a ${code} error`);
}

function issue(title: string, input: Record<string, unknown> = {}): string {
  return store.createIssue({ title, ...input }).identifier;
}

/** An epic with two open children: the smallest scope a run can work. */
function epicWithTwo(): { epic: string; a: string; b: string } {
  const epic = issue("Epic", { kind: "epic" });
  return { epic, a: issue("A", { parent: epic }), b: issue("B", { parent: epic }) };
}

function events(kind: string): Array<Record<string, unknown>> {
  return store
    .listEvents(0, 1000)
    .filter((event) => event.kind === kind)
    .map((event) => ({ ...event.payload, actor: event.actor, issueId: event.issueId }));
}

function decisionOf(runId: string) {
  return runs.status(runId).decision;
}

// ------------------------------------------------------------------ migration

describe("workspace migration 015", () => {
  it("walks a real old workspace file through 14 to 15, adding the two run tables and nothing else", () => {
    withFixture(FIXTURES.workspaceV6, (path) => {
      const db = openDb(path);
      try {
        const upTo14 = { ...WORKSPACE_TARGET, migrations: WORKSPACE_TARGET.migrations.filter((m) => m.version <= 14) };
        runMigrations(db, upTo14);
        const objects = (): string[] =>
          (db.prepare("SELECT type || ':' || name AS n FROM sqlite_master ORDER BY n").all() as Array<{ n: string }>).map((row) => row.n);
        const before = objects();
        expect(describeSchema(db, WORKSPACE_TARGET).pending).toEqual([15]);
        runMigrations(db, WORKSPACE_TARGET);
        expect(describeSchema(db, WORKSPACE_TARGET).current).toBe(15);
        expect(objects().filter((name) => !before.includes(name))).toEqual([
          "index:runs_live_scope_uq",
          "index:runs_started_idx",
          "index:sqlite_autoindex_run_tickets_1",
          "index:sqlite_autoindex_runs_1",
          "table:run_tickets",
          "table:runs",
        ]);
        // And the upgraded file is a working one: a run starts on it.
        const upgraded = new WorkspaceStore(db, "fixture", "FIX");
        expect(upgraded.runs().start({ actor: BOT, scope: "queue" }).state).toBe("active");
      } finally {
        db.close();
      }
    });
  });

  it("backs the one-live-run rule with the partial unique index, not only with a read", () => {
    const { epic } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    const insert = () =>
      store.db
        .prepare(`INSERT INTO runs (id, actor, scope_kind, scope_key, state, started_at, updated_at) VALUES ('x', ?, 'issue', ?, 'paused', 'now', 'now')`)
        .run(BOT, run.scope.kind === "queue" ? "queue" : run.scope.issueId);
    expect(insert).toThrow(/UNIQUE/);
  });
});

// ------------------------------------------------------------------ the record

describe("run start", () => {
  it("records actor, scope, budget and state, and emits run_started with no issue", () => {
    const { epic } = epicWithTwo();
    setClock(() => Date.parse("2026-09-28T10:00:00.000Z"));
    const run = runs.start({ actor: BOT, scope: epic, maxTickets: 3, until: "2h", ceilingPercent: 90, ceilingAccount: "acct" });
    expect(run).toMatchObject({
      actor: BOT,
      scope: { kind: "issue", identifier: epic },
      state: "active",
      budget: { maxTickets: 3, until: "2026-09-28T12:00:00.000Z", ceilingPercent: 90, ceilingAccount: "acct" },
      tickets: [],
      counts: { taken: 0, done: 0, failed: 0, open: 0 },
      stop: null,
      endedAt: null,
    });
    expect(events("run_started")).toEqual([
      expect.objectContaining({ runId: run.id, actor: BOT, issueId: null, scope: expect.objectContaining({ kind: "issue", identifier: epic }) }),
    ]);
  });

  it("takes the queue, an epic or parent, and a milestone as scope", () => {
    const { epic } = epicWithTwo();
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = issue("October", { kind: MILESTONE_KIND });
    expect(runs.start({ actor: BOT, scope: "queue" }).scope).toEqual({ kind: "queue" });
    expect(runs.start({ actor: BOT, scope: epic }).scope).toMatchObject({ kind: "issue", identifier: epic });
    expect(runs.start({ actor: BOT, scope: milestone }).scope).toMatchObject({ kind: "milestone", identifier: milestone });
  });

  it("refuses a leaf, a resolved scope, an unknown ref and a malformed budget", () => {
    const { epic, a } = epicWithTwo();
    expect(refused(() => runs.start({ actor: BOT, scope: a }), "validation").message).toMatch(/no children/);
    expect(refused(() => runs.start({ actor: BOT, scope: "TST-999" }), "not_found")).toBeTruthy();
    refused(() => runs.start({ actor: BOT, scope: epic, maxTickets: 0 }), "validation");
    refused(() => runs.start({ actor: BOT, scope: epic, until: "tomorrow" }), "validation");
    refused(() => runs.start({ actor: BOT, scope: epic, until: "2000-01-01T00:00:00Z" }), "validation");
    refused(() => runs.start({ actor: BOT, scope: epic, ceilingPercent: 101 }), "validation");
    refused(() => runs.start({ actor: BOT, scope: epic, ceilingAccount: "acct" }), "validation");
    store.updateIssue(epic, { status: "cancelled" }, "vp");
    expect(refused(() => runs.start({ actor: BOT, scope: epic }), "validation").message).toMatch(/nothing to do/);
    expect(store.listEvents(0, 1000).some((event) => event.kind === "run_started")).toBe(false);
  });

  it("refuses a second live run for the same actor and scope, naming the first", () => {
    const { epic } = epicWithTwo();
    const first = runs.start({ actor: BOT, scope: epic });
    const error = refused(() => runs.start({ actor: BOT, scope: epic }), "conflict");
    expect(error.message).toContain(first.id);
    expect(error.detail).toMatchObject({ runId: first.id, state: "active" });
    // A paused run still owns its scope.
    runs.setState(first.id, "paused", BOT);
    expect(refused(() => runs.start({ actor: BOT, scope: epic }), "conflict").detail).toMatchObject({ runId: first.id, state: "paused" });
    // Another actor, or another scope, is a different run.
    expect(runs.start({ actor: "other", scope: epic }).state).toBe("active");
    expect(runs.start({ actor: BOT, scope: "queue" }).state).toBe("active");
    // Once it ended, the scope is free again.
    runs.stop(first.id, "vp");
    expect(runs.start({ actor: BOT, scope: epic }).id).not.toBe(first.id);
  });
});

describe("run stop", () => {
  it("records stopped_by_human with who and why, once", () => {
    const { epic } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    const stopped = runs.stop(run.id, "vp", "  going to bed  ");
    expect(stopped).toMatchObject({ state: "stopped", stop: { reason: "stopped_by_human", by: "vp", note: "going to bed", detail: {} } });
    expect(stopped.endedAt).not.toBeNull();
    // A second press changes nothing and emits nothing.
    expect(runs.stop(run.id, "someone-else", "again")).toEqual(stopped);
    expect(events("run_stopped")).toEqual([
      expect.objectContaining({ runId: run.id, reason: "stopped_by_human", by: "vp", note: "going to bed", from: "active", state: "stopped", actor: "vp", issueId: null }),
    ]);
  });

  it("finds the actor's one live run, and refuses to guess between several", () => {
    const { epic } = epicWithTwo();
    refused(() => runs.liveRunOf(BOT), "not_found");
    const one = runs.start({ actor: BOT, scope: epic });
    expect(runs.liveRunOf(BOT).id).toBe(one.id);
    const two = runs.start({ actor: BOT, scope: "queue" });
    const error = refused(() => runs.liveRunOf(BOT), "validation");
    expect(error.message).toContain(one.id);
    expect(error.message).toContain(two.id);
  });

  it("resolves a run by an 8-character prefix and refuses a shorter one", () => {
    const run = runs.start({ actor: BOT, scope: "queue" });
    expect(runs.get(run.id.slice(0, 8)).id).toBe(run.id);
    refused(() => runs.get(run.id.slice(0, 7)), "not_found");
  });

  it("emits run_state_changed on pause and resume, and nothing for a no-op", () => {
    const run = runs.start({ actor: BOT, scope: "queue" });
    runs.setState(run.id, "paused", "vp");
    runs.setState(run.id, "paused", "vp");
    runs.setState(run.id, "active", "vp");
    expect(events("run_state_changed").map((event) => `${event.from}->${event.to}`)).toEqual(["active->paused", "paused->active"]);
    runs.stop(run.id, "vp");
    refused(() => runs.setState(run.id, "active", "vp"), "conflict");
  });
});

describe("tickets", () => {
  it("records a taken ticket and its stated outcome, and emits both", () => {
    const { epic, a } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    runs.recordTicketTaken(run.id, a);
    // Taking the open ticket again is a replay.
    expect(runs.recordTicketTaken(run.id, a).counts).toEqual({ taken: 1, done: 0, failed: 0, open: 1 });
    const after = runs.recordTicketOutcome(run.id, a, "failed", "tests red");
    expect(after.tickets).toEqual([expect.objectContaining({ seq: 1, identifier: a, outcome: "failed", reason: "tests red", attemptId: null })]);
    expect(events("run_ticket_taken")).toHaveLength(1);
    expect(events("run_ticket_recorded")).toEqual([expect.objectContaining({ runId: run.id, identifier: a, outcome: "failed" })]);
  });

  it("refuses a ticket outside the scope, the scope itself, and a stopped run", () => {
    const { epic } = epicWithTwo();
    const outside = issue("Elsewhere");
    const run = runs.start({ actor: BOT, scope: epic });
    refused(() => runs.recordTicketTaken(run.id, outside), "validation");
    refused(() => runs.recordTicketTaken(run.id, epic), "validation");
    refused(() => runs.recordTicketOutcome(run.id, outside, "done"), "not_found");
    runs.stop(run.id, "vp");
    refused(() => runs.recordTicketTaken(run.id, outside), "conflict");
  });

  it("reads the outcome off the actor's ended attempt when none is stated", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    runs.recordTicketTaken(run.id, a);
    store.checkoutIssue(a, BOT);
    // Still running: nothing to read, so it asks for the outcome.
    expect(refused(() => runs.recordTicketOutcome(run.id, a), "validation").message).toMatch(/has not ended/);
    store.releaseIssue(a, BOT, { attempt: { outcome: "failed", reason: "cannot reproduce" } });
    const failed = runs.recordTicketOutcome(run.id, a);
    expect(failed.tickets[0]).toMatchObject({ outcome: "failed", reason: "cannot reproduce" });
    expect(failed.tickets[0]!.attemptId).not.toBeNull();

    runs.recordTicketTaken(run.id, b);
    store.checkoutIssue(b, BOT);
    store.updateIssue(b, { status: "done" }, BOT);
    expect(runs.recordTicketOutcome(run.id, b).tickets[1]).toMatchObject({ outcome: "done", reason: null });
  });

  it("does not read a yielded attempt as an outcome", () => {
    const { epic, a } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    runs.recordTicketTaken(run.id, a);
    store.checkoutIssue(a, BOT);
    store.releaseIssue(a, BOT);
    expect(refused(() => runs.recordTicketOutcome(run.id, a), "validation").message).toMatch(/ended yielded/);
  });
});

// ------------------------------------------------------------------ run continue

describe("run continue", () => {
  const cont = (input: Parameters<RunStore["continue"]>[0] = {}) => runs.continue({ actor: BOT, ...input });
  const holder = (ref: string) => store.getIssue(ref).checkoutAgent;

  it("answers stop no_run, with no run, when the actor has no live run", () => {
    expect(cont()).toEqual({ action: "stop", reason: "no_run", detail: { actor: BOT }, message: expect.any(String), recorded: null, run: null });
    const { epic } = epicWithTwo();
    runs.stop(runs.start({ actor: BOT, scope: epic }).id, "vp");
    expect(cont()).toMatchObject({ action: "stop", reason: "no_run" });
  });

  it("takes the scoped queue's next row, claimed for the actor in the same call, and records it as taken", () => {
    const { epic, a } = epicWithTwo();
    issue("Outside the epic");
    const run = runs.start({ actor: BOT, scope: epic });
    const answer = cont();
    expect(answer).toMatchObject({ action: "take", ref: a, title: "A", resumed: false, recorded: null, why: expect.stringContaining(a) });
    expect(holder(a)).toBe(BOT);
    expect(store.getIssue(a).status).toBe("in_progress");
    expect(answer.run!.tickets).toEqual([expect.objectContaining({ identifier: a, outcome: null })]);
    expect(events("run_ticket_taken")).toEqual([expect.objectContaining({ runId: run.id, identifier: a, seq: 1 })]);
    expect(events("checkout")).toEqual([expect.objectContaining({ identifier: a, actor: BOT })]);
  });

  it("hands a ticket the actor still holds back to resume it, taking nothing new, and past the ticket budget", () => {
    const { epic, a } = epicWithTwo();
    runs.start({ actor: BOT, scope: epic, maxTickets: 1 });
    cont();
    const again = cont();
    expect(again).toMatchObject({ action: "take", ref: a, resumed: true, recorded: null });
    expect(again.run!.counts).toEqual({ taken: 1, done: 0, failed: 0, open: 1 });
    expect(events("run_ticket_taken")).toHaveLength(1);
    // Finished, the one-ticket budget is spent.
    store.updateIssue(a, { status: "in_review" }, BOT);
    expect(cont()).toMatchObject({ action: "stop", reason: "budget", detail: { budget: "tickets" }, recorded: { ref: a, outcome: "done", source: "attempt" }, run: { state: "stopped" } });
  });

  it("records the previous ticket off the actor's ended attempt, then takes the next", () => {
    const { epic, a, b } = epicWithTwo();
    runs.start({ actor: BOT, scope: epic });
    cont();
    store.updateIssue(a, { status: "in_review" }, BOT);
    const answer = cont();
    expect(answer).toMatchObject({ action: "take", ref: b, recorded: { ref: a, outcome: "done", reason: null, source: "attempt" } });
    expect(answer.run!.tickets.map((ticket) => [ticket.identifier, ticket.outcome])).toEqual([
      [a, "done"],
      [b, null],
    ]);
    expect(answer.run!.tickets[0]!.attemptId).not.toBeNull();
  });

  it("an attempt that failed is failed; a stated outcome wins over the attempt", () => {
    const { epic, a } = epicWithTwo();
    runs.start({ actor: BOT, scope: epic });
    cont();
    store.releaseIssue(a, BOT, { attempt: { outcome: "failed", reason: "flaky rig" } });
    expect(cont()).toMatchObject({ action: "take", ref: a, recorded: { ref: a, outcome: "failed", reason: "flaky rig", source: "attempt" } });
    // Its attempt now reads completed; the caller's word is what counts.
    store.updateIssue(a, { status: "in_review" }, BOT);
    expect(cont({ outcome: "failed", reason: "reviewer says no" })).toMatchObject({
      action: "stop",
      reason: "failure_streak",
      recorded: { ref: a, outcome: "failed", reason: "reviewer says no", source: "stated" },
    });
  });

  it("without an attempt, reads the ticket's status: handed on is done, anything else is failed with why", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    // Taken on the record but never checked out by the actor: no attempt of theirs to read.
    runs.recordTicketTaken(run.id, a);
    store.updateIssue(a, { status: "in_review" }, "vp");
    expect(cont()).toMatchObject({ action: "take", ref: b, recorded: { ref: a, outcome: "done", source: "status" } });
    // Released with no outcome said: it left the actor's hands unfinished.
    store.releaseIssue(b, BOT);
    const answer = cont();
    expect(answer.recorded).toMatchObject({ ref: b, outcome: "failed", source: "status", reason: expect.stringMatching(/unfinished.*yielded \(released\)/) });
  });

  it("--outcome failed on a ticket still held releases it, ending the attempt failed; --outcome done on one is refused", () => {
    const { epic, a } = epicWithTwo();
    runs.start({ actor: BOT, scope: epic });
    cont();
    expect(refused(() => cont({ outcome: "done" }), "validation").message).toMatch(/still in_progress/);
    const answer = cont({ outcome: "failed", reason: "session crashed" });
    expect(answer.recorded).toEqual({ ref: a, outcome: "failed", reason: "session crashed", source: "stated" });
    const attempt = store.db.prepare("SELECT outcome, end_reason FROM attempts WHERE agent = ? AND state = 'ended'").get(BOT) as { outcome: string; end_reason: string };
    expect(attempt).toEqual({ outcome: "failed", end_reason: "session crashed" });
    // Released, it is the queue's first row again, so the run retries it.
    expect(answer).toMatchObject({ action: "take", ref: a, resumed: false });
    expect(holder(a)).toBe(BOT);
  });

  it("failure_streak: two failures in a row end the run stopped, and the next call answers the same stop", () => {
    const { epic } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    cont();
    cont({ outcome: "failed", reason: "one" });
    const stop = cont({ outcome: "failed", reason: "two" });
    expect(stop).toMatchObject({ action: "stop", reason: "failure_streak", run: { state: "stopped", stop: { reason: "failure_streak", by: null } } });
    expect(events("run_stopped")).toEqual([expect.objectContaining({ runId: run.id, reason: "failure_streak" })]);
    // The loop's exit is stable: asking again answers the stop, by id or by actor.
    expect(cont({ run: run.id, actor: null })).toMatchObject({ action: "stop", reason: "failure_streak" });
    expect(cont()).toMatchObject({ action: "stop", reason: "no_run" });
  });

  it("scope_empty ends the run completed once nothing unresolved is left", () => {
    const { epic, a, b } = epicWithTwo();
    runs.start({ actor: BOT, scope: epic });
    cont();
    store.updateIssue(a, { status: "done" }, BOT);
    cont();
    store.updateIssue(b, { status: "done" }, BOT);
    expect(cont()).toMatchObject({ action: "stop", reason: "scope_empty", recorded: { ref: b, outcome: "done" }, run: { state: "completed", counts: { taken: 2, done: 2 } } });
  });

  it("waits, and stays live, while the only work left is somebody else's", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    store.checkoutIssue(a, "other");
    store.setBlockedBy(b, [a], "vp");
    const answer = cont();
    expect(answer).toMatchObject({ action: "wait", reason: "waiting_on_others", retryAfterSeconds: 60, run: { state: "active" } });
    expect(runs.get(run.id).state).toBe("active");
    expect(events("run_stopped")).toEqual([]);
  });

  it("a paused run answers wait and takes nothing, but still records a finished ticket; resume takes again", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    cont();
    store.updateIssue(a, { status: "in_review" }, BOT);
    runs.setState(run.id, "paused", "vp");
    const waiting = cont();
    expect(waiting).toMatchObject({ action: "wait", reason: "paused", recorded: { ref: a, outcome: "done" }, run: { state: "paused", counts: { taken: 1, open: 0 } } });
    expect(holder(b)).toBeNull();
    runs.setState(run.id, "active", "vp");
    expect(cont()).toMatchObject({ action: "take", ref: b });
  });

  it("finishes the actor's own held work in scope before claiming more", () => {
    const { epic, b } = epicWithTwo();
    store.checkoutIssue(b, BOT);
    runs.start({ actor: BOT, scope: epic });
    expect(cont()).toMatchObject({ action: "take", ref: b, resumed: false, why: expect.stringContaining("already held by you") });
  });

  it("gate_pending and vp_blocked end the run through continue", () => {
    const { epic, a } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    store.gateIssue(epic, { owner: "VP" }, "vp");
    expect(cont()).toMatchObject({ action: "stop", reason: "gate_pending", run: { id: run.id, state: "stopped" } });

    const second = issue("Second epic", { kind: "epic" });
    const c = issue("C", { parent: second });
    issue("D", { parent: second });
    runs.start({ actor: BOT, scope: second });
    expect(cont()).toMatchObject({ action: "take", ref: c });
    store.updateIssue(c, { status: "blocked", unblockOwner: "VP", unblockAction: "pick one" }, BOT);
    // Blocked on a person, the ticket is a failure of this run AND the reason it stops.
    expect(cont()).toMatchObject({ action: "stop", reason: "vp_blocked", recorded: { ref: c, outcome: "failed" }, detail: { blocks: [expect.objectContaining({ identifier: c })] } });
    expect(store.getIssue(a).checkoutAgent).toBeNull();
  });

  it("two runs over one scope never take the same row", () => {
    const { epic, a, b } = epicWithTwo();
    runs.start({ actor: BOT, scope: epic });
    runs.start({ actor: "bot-2", scope: epic });
    expect(cont()).toMatchObject({ action: "take", ref: a });
    expect(runs.continue({ actor: "bot-2" })).toMatchObject({ action: "take", ref: b });
    expect(runs.continue({ actor: "bot-3" })).toMatchObject({ action: "stop", reason: "no_run" });
  });

  it("only the run's actor continues it, and several live runs need a run id", () => {
    const { epic } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    refused(() => runs.continue({ actor: "intruder", run: run.id }), "validation");
    runs.start({ actor: BOT, scope: "queue" });
    refused(() => cont(), "validation");
    expect(runs.continue({ run: run.id })).toMatchObject({ action: "take" });
  });

  it("under queue.policy strict, follows the whole plan: a scope alone waits out_of_order, it never jumps the queue", () => {
    const { epic, a } = epicWithTwo();
    const queued = issue("Queued elsewhere");
    store.queue().mutate("add", { ref: queued }, "vp");
    store.setSetting("queue.policy", "strict", "vp");
    // A plain checkout is refused, and so is a run's take: the scope is no licence.
    expect(refused(() => store.checkoutIssue(a, "someone"), "out_of_order").detail).toMatchObject({ expected: [queued] });
    const run = runs.start({ actor: BOT, scope: epic });
    const answer = cont();
    expect(answer).toMatchObject({ action: "wait", reason: "out_of_order", detail: { policy: "strict", expected: [queued] }, retryAfterSeconds: 60, run: { state: "active", counts: { taken: 0 } } });
    expect(holder(a)).toBeNull();
    expect(events("queue_overridden")).toEqual([]);
    // Once the plan's head is taken, the run's next row is in order again.
    store.checkoutIssue(queued, "someone");
    expect(cont()).toMatchObject({ action: "take", ref: a, run: { id: run.id } });
    expect(events("queue_overridden")).toEqual([]);
  });

  it("under queue.policy strict, a run started with an override takes out of order, recording queue_overridden as checkout --override does", () => {
    const { epic, a } = epicWithTwo();
    const queued = issue("Queued elsewhere");
    store.queue().mutate("add", { ref: queued }, "vp");
    store.setSetting("queue.policy", "strict", "vp");
    refused(() => runs.start({ actor: BOT, scope: epic, override: "  " }), "validation");
    const run = runs.start({ actor: BOT, scope: epic, override: "VP wants the epic first" });
    expect(run.override).toBe("VP wants the epic first");
    const answer = cont();
    expect(answer).toMatchObject({ action: "take", ref: a, why: expect.stringContaining("VP wants the epic first") });
    expect(holder(a)).toBe(BOT);
    // The same event shape a human's checkout --override writes.
    const [overridden] = events("queue_overridden");
    const b = issue("Plain override target");
    store.checkoutIssue(b, "human", undefined, { overrideReason: "because" });
    const human = events("queue_overridden")[1]!;
    expect(Object.keys(overridden!).sort()).toEqual(Object.keys(human).sort());
    expect(overridden).toMatchObject({ identifier: a, reason: "VP wants the epic first", policy: "strict", expected: [queued], actor: BOT });
    // A resume is mid-flight work, not a pickup: no second override.
    expect(cont()).toMatchObject({ action: "take", ref: a, resumed: true });
    expect(events("queue_overridden")).toHaveLength(2);
  });

  it("with no live run, settles the ticket of the actor's last ended run and answers why it ended", () => {
    const { epic, a } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    cont();
    runs.stop(run.id, "vp", "enough");
    // Still held and nothing stated: nothing to record, but the driver hears the real stop.
    expect(cont()).toMatchObject({ action: "stop", reason: "stopped_by_human", recorded: null, run: { id: run.id } });
    const answer = cont({ outcome: "failed", reason: "stopped mid-ticket" });
    expect(answer).toMatchObject({ action: "stop", reason: "stopped_by_human", recorded: { ref: a, outcome: "failed", reason: "stopped mid-ticket", source: "stated" } });
    expect(holder(a)).toBeNull();
    // Settled, there is nothing left to continue.
    expect(cont()).toMatchObject({ action: "stop", reason: "no_run" });
  });

  it("scope_gone: a scope that lost every child stops the run, releases its held ticket, and never breaks status", () => {
    const parent = issue("Plain parent");
    const kid = issue("Only child", { parent });
    const run = runs.start({ actor: BOT, scope: parent });
    const other = runs.start({ actor: BOT, scope: "queue" });
    expect(runs.continue({ actor: BOT, run: run.id })).toMatchObject({ action: "take", ref: kid });
    // No verb re-parents; a restore (cloud rewind) or an applied sync is how a parent loses
    // its children or disappears, so the row is moved the way those write it.
    const kidId = store.getIssue(kid).id;
    store.db.prepare("UPDATE issues SET parent_id = NULL WHERE id = ?").run(kidId);
    // Reading never throws, for this run or for a listing of every run.
    expect(runs.status(run.id).decision).toMatchObject({ stop: true, reason: "scope_gone", state: "stopped" });
    expect(runs.statuses({ all: true })).toHaveLength(2);
    const answer = runs.continue({ actor: BOT, run: run.id });
    expect(answer).toMatchObject({ action: "stop", reason: "scope_gone", recorded: { ref: kid, outcome: "failed", source: "stated" }, run: { state: "stopped" } });
    expect(holder(kid)).toBeNull();
    expect(other.state).toBe("active");
  });

  it("scope_gone: a deleted scope issue, and a stated failure on its ticket still lands", () => {
    const epic = issue("Doomed epic", { kind: "epic" });
    const kid = issue("Doomed child", { parent: epic });
    const run = runs.start({ actor: BOT, scope: epic });
    cont();
    // As a restore removes a row: the child is detached, the epic is gone.
    const epicId = store.getIssue(epic).id;
    store.db.prepare("UPDATE issues SET parent_id = NULL WHERE parent_id = ?").run(epicId);
    store.db.prepare("DELETE FROM issues WHERE id = ?").run(epicId);
    const answer = cont({ outcome: "failed", reason: "epic deleted" });
    expect(answer).toMatchObject({ action: "stop", reason: "scope_gone", recorded: { ref: kid, outcome: "failed", reason: "epic deleted" }, run: { id: run.id, state: "stopped" } });
    expect(holder(kid)).toBeNull();
  });

  it("an epic that emptied under a held ticket: the ticket is failed and released, not resumed out of scope", () => {
    const epic = issue("Emptied epic", { kind: "epic" });
    const kid = issue("Moved-out child", { parent: epic });
    runs.start({ actor: BOT, scope: epic });
    expect(cont()).toMatchObject({ action: "take", ref: kid });
    store.db.prepare("UPDATE issues SET parent_id = NULL WHERE id = ?").run(store.getIssue(kid).id);
    // An epic is a scope whatever it holds: empty, not gone.
    const answer = cont();
    expect(answer).toMatchObject({
      action: "stop",
      reason: "scope_empty",
      recorded: { ref: kid, outcome: "failed", source: "stated", reason: expect.stringContaining("no longer inside") },
      run: { state: "completed" },
    });
    expect(holder(kid)).toBeNull();
  });

  it("one actor's two live runs never both take the same held ticket", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = issue("Shared milestone", { kind: MILESTONE_KIND });
    const { epic, a, b } = epicWithTwo();
    store.milestones().addMember(milestone, epic, {}, "vp");
    const byEpic = runs.start({ actor: BOT, scope: epic });
    const byMilestone = runs.start({ actor: BOT, scope: milestone });
    expect(runs.continue({ actor: BOT, run: byEpic.id })).toMatchObject({ action: "take", ref: a });
    // a is the epic run's open ticket: the milestone run takes b, not a again.
    expect(runs.continue({ actor: BOT, run: byMilestone.id })).toMatchObject({ action: "take", ref: b });
    expect(runs.get(byMilestone.id).tickets.map((ticket) => ticket.identifier)).toEqual([b]);
  });

  it("a retried ticket is one ticket against --max-tickets", () => {
    const { epic, a, b } = epicWithTwo();
    runs.start({ actor: BOT, scope: epic, maxTickets: 2 });
    cont();
    // Failed and retaken: two rows, one ticket.
    expect(cont({ outcome: "failed", reason: "first try" })).toMatchObject({ action: "take", ref: a });
    store.updateIssue(a, { status: "in_review" }, BOT);
    const second = cont();
    expect(second).toMatchObject({ action: "take", ref: b });
    store.updateIssue(b, { status: "in_review" }, BOT);
    expect(cont()).toMatchObject({ action: "stop", reason: "budget", detail: { budget: "tickets", maxTickets: 2, taken: 2 }, run: { counts: { taken: 3 } } });
  });
});

// ------------------------------------------------------------------ every stop rule, tripped

describe("stop rules over a real store", () => {
  it("a live run with work left continues", () => {
    const { epic } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    const status = runs.status(run.id);
    expect(status.decision).toEqual({ stop: false });
    expect(status.facts!.workable.map((row) => row.identifier)).toHaveLength(2);
  });

  it("scope_empty: nothing left under the epic ends the run completed", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    store.updateIssue(a, { status: "done" }, "vp");
    expect(decisionOf(run.id)).toEqual({ stop: false });
    store.updateIssue(b, { status: "done" }, "vp");
    // The epic itself is now a leaf the queue would offer; a run never works its own scope issue.
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "scope_empty", state: "completed" });
  });

  it("scope_empty: the scope issue is never its own work, even held by the run's actor", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    // The actor holds the epic itself (coordinating it), so once its children are done it
    // stays open, and the queue offers it as a leaf the actor holds.
    store.checkoutIssue(epic, BOT);
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    expect(store.queue().effectiveQueue({ actor: BOT }).rows.map((row) => `${row.identifier}:${row.eligibility}`)).toEqual([`${epic}:claimed`]);
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "scope_empty" });
  });

  it("scope_empty: a milestone's members and their descendants are the scope", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = issue("October", { kind: MILESTONE_KIND });
    const { epic, a, b } = epicWithTwo();
    const outside = issue("Not in the milestone");
    store.milestones().addMember(milestone, epic, {}, "vp");
    const run = runs.start({ actor: BOT, scope: milestone });
    expect(runs.status(run.id).facts!.workable.map((row) => row.identifier).sort()).toEqual([a, b].sort());
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "scope_empty" });
    // The queue scope still sees the outside row.
    expect(runs.status(runs.start({ actor: BOT, scope: "queue" }).id).facts!.workable.map((row) => row.identifier)).toContain(outside);
  });

  it("a row the actor already holds keeps the scope from reading empty", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    store.updateIssue(b, { status: "done" }, "vp");
    store.checkoutIssue(a, BOT);
    expect(decisionOf(run.id)).toEqual({ stop: false });
    // Somebody else's claim is not this run's work, and not an empty scope either: it waits.
    const other = runs.start({ actor: "other", scope: epic });
    expect(decisionOf(other.id)).toEqual({
      stop: false,
      wait: { reason: "waiting_on_others", detail: { rows: [{ identifier: a, eligibility: "claimed", reason: expect.stringContaining(BOT) }] }, message: expect.any(String) },
    });
  });

  it("waiting_on_others, never scope_empty, while unresolved work in scope is claimed, blocked by a dependency or in review", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    const queueRun = runs.start({ actor: BOT, scope: "queue" });
    store.checkoutIssue(a, "other");
    store.setBlockedBy(b, [a], "vp");
    const reasons = (id: string) => {
      const decision = decisionOf(id);
      expect(decision.stop).toBe(false);
      return decision.stop ? [] : ((decision.wait?.detail.rows ?? []) as Array<{ identifier: string; eligibility: string }>).map((row) => `${row.identifier}:${row.eligibility}`);
    };
    expect(reasons(run.id)).toEqual([`${a}:claimed`, `${b}:blocked`]);
    // The queue run sees the epic's rows too; the epic itself is a container, not a row.
    expect(reasons(queueRun.id)).toEqual([`${a}:claimed`, `${b}:blocked`]);
    store.updateIssue(a, { status: "in_review" }, "other");
    expect(reasons(run.id)).toEqual([`${a}:unavailable`, `${b}:blocked`]);
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "scope_empty", state: "completed" });
  });

  it("gate_pending: nothing workable and a gate pending in scope", () => {
    const epic = issue("Epic", { kind: "epic" });
    const parent = issue("Parent", { parent: epic });
    issue("Leaf under the gate", { parent });
    const run = runs.start({ actor: BOT, scope: epic });
    expect(decisionOf(run.id)).toEqual({ stop: false });
    store.gateIssue(parent, { owner: "VP" }, "vp");
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "gate_pending", state: "stopped", detail: { gates: [expect.objectContaining({ identifier: parent, owner: "VP" })] } });
  });

  it("gate_pending: the scope issue itself awaiting approval stops the run while work remains", () => {
    const { epic } = epicWithTwo();
    const other = issue("Other work");
    const run = runs.start({ actor: BOT, scope: "queue" });
    const epicRun = runs.start({ actor: BOT, scope: epic });
    store.gateIssue(epic, { owner: "VP" }, "vp");
    expect(decisionOf(epicRun.id)).toMatchObject({ stop: true, reason: "gate_pending", detail: { gates: [expect.objectContaining({ identifier: epic })] } });
    // A gate elsewhere in a scope that still has work does not stop it.
    expect(runs.status(run.id).facts!.workable.map((row) => row.identifier)).toEqual([other]);
    expect(decisionOf(run.id)).toEqual({ stop: false });
  });

  it("gate_pending: a milestone awaiting approval stops the run while its members still have work", () => {
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = issue("October", { kind: MILESTONE_KIND });
    // A child of the milestone is what makes it gateable; its member epic is not under the gate.
    issue("Goal check", { parent: milestone });
    const { epic } = epicWithTwo();
    store.milestones().addMember(milestone, epic, {}, "vp");
    const run = runs.start({ actor: BOT, scope: milestone });
    store.gateIssue(milestone, { owner: "VP" }, BOT);
    expect(runs.status(run.id).facts!.workable).toHaveLength(2);
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "gate_pending", detail: { gates: [expect.objectContaining({ identifier: milestone, owner: "VP" })] } });
  });

  it("vp_blocked: nothing workable and a person-owned block in scope", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "blocked", unblockOwner: "VP", unblockAction: "decide the API" }, "vp");
    expect(decisionOf(run.id)).toMatchObject({
      stop: true,
      reason: "vp_blocked",
      detail: { blocks: [{ identifier: b, owner: "VP", action: "decide the API", issueId: expect.any(String) }] },
    });
  });

  it("vp_blocked: a ticket the run took blocked on a person stops it even with work left", () => {
    const { epic, a } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    runs.recordTicketTaken(run.id, a);
    store.updateIssue(a, { status: "blocked", unblockOwner: "VP" }, BOT);
    expect(runs.status(run.id).facts!.workable).toHaveLength(1);
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "vp_blocked", detail: { blocks: [expect.objectContaining({ identifier: a })] } });
  });

  it("a person-owned block elsewhere does not stop a run with work left, and a dependency block is not person-owned", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    store.updateIssue(a, { status: "blocked", unblockOwner: "VP" }, "vp");
    expect(decisionOf(run.id)).toEqual({ stop: false });
    const blocker = issue("Outside blocker");
    store.setBlockedBy(b, [blocker], "vp");
    store.updateIssue(a, { status: "todo" }, "vp");
    store.updateIssue(a, { status: "done" }, "vp");
    // b waits on a dependency nobody here owns: the run waits too, it neither stops nor completes.
    expect(decisionOf(run.id)).toMatchObject({ stop: false, wait: { reason: "waiting_on_others", detail: { rows: [expect.objectContaining({ identifier: b, eligibility: "blocked" })] } } });
  });

  it("failure_streak: two failed tickets in a row, and a done in between resets it", () => {
    const epic = issue("Epic", { kind: "epic" });
    const [a, b, c, d] = ["A", "B", "C", "D"].map((title) => issue(title, { parent: epic }));
    issue("E", { parent: epic });
    const run = runs.start({ actor: BOT, scope: epic });
    const take = (ref: string, outcome: "done" | "failed") => {
      runs.recordTicketTaken(run.id, ref);
      runs.recordTicketOutcome(run.id, ref, outcome);
    };
    take(a!, "failed");
    expect(decisionOf(run.id)).toEqual({ stop: false });
    take(b!, "done");
    take(c!, "failed");
    expect(decisionOf(run.id)).toEqual({ stop: false });
    take(d!, "failed");
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "failure_streak", detail: { tickets: [c, d], limit: 2 } });
  });

  it("budget tickets: the run took its --max-tickets", () => {
    const { epic, a } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic, maxTickets: 1 });
    expect(decisionOf(run.id)).toEqual({ stop: false });
    runs.recordTicketTaken(run.id, a);
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "budget", detail: { budget: "tickets", maxTickets: 1, taken: 1 } });
  });

  it("budget time: --until has passed", () => {
    const { epic } = epicWithTwo();
    let now = Date.parse("2026-09-28T10:00:00.000Z");
    setClock(() => now);
    const run = runs.start({ actor: BOT, scope: epic, until: "30m" });
    now += 29 * 60_000;
    expect(decisionOf(run.id)).toEqual({ stop: false });
    now += 60_000;
    expect(decisionOf(run.id)).toMatchObject({ stop: true, reason: "budget", detail: { budget: "time", until: "2026-09-28T10:30:00.000Z" } });
  });

  it("budget ceiling: a current window at or over the ceiling, never an unknown one", () => {
    const { epic } = epicWithTwo();
    let used: number | null = 80;
    let status = "current";
    const queried: Array<string | undefined> = [];
    const reader: BudgetReader = (query) => {
      queried.push(query.account);
      return budgetView([
        { accountRef: "acct", limits: [{ limitKey: "five_hour", status, highWaterPercent: used }, { limitKey: "weekly", status: "current", highWaterPercent: 40 }] },
      ]);
    };
    const withBudget = new RunStore(store, reader);
    const run = withBudget.start({ actor: BOT, scope: epic, ceilingPercent: 90, ceilingAccount: "acct" });
    expect(withBudget.status(run.id).decision).toEqual({ stop: false });
    expect(withBudget.status(run.id).facts!.ceiling).toEqual({ usedPercent: 80, accountRef: "acct", limitKey: "five_hour", missing: null });
    used = 90;
    expect(withBudget.status(run.id).decision).toMatchObject({ stop: true, reason: "budget", detail: { budget: "ceiling", usedPercent: 90, ceilingPercent: 90, accountRef: "acct", limitKey: "five_hour" } });
    // An elapsed window is not a current reading: the weekly limit is what is left.
    status = "elapsed";
    expect(withBudget.status(run.id).facts!.ceiling).toMatchObject({ usedPercent: 40, limitKey: "weekly" });
    expect(withBudget.status(run.id).decision).toEqual({ stop: false });
    used = null;
    status = "current";
    expect(withBudget.status(run.id).decision).toEqual({ stop: false });
    expect(queried.every((account) => account === "acct")).toBe(true);
  });

  it("budget ceiling: an unreadable budget is unknown, not a trip", () => {
    const { epic } = epicWithTwo();
    const withBudget = new RunStore(store, () => {
      throw new StapleError("validation", "unknown account");
    });
    const run = withBudget.start({ actor: BOT, scope: epic, ceilingPercent: 50 });
    expect(withBudget.status(run.id).facts!.ceiling).toEqual({ usedPercent: null, accountRef: null, limitKey: null, missing: "validation" });
    expect(withBudget.status(run.id).decision).toEqual({ stop: false });
  });

  it("stopped_by_human: a stopped run answers the reason it ended with and reads no facts", () => {
    const { epic } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    runs.stop(run.id, "vp", "enough");
    const status = runs.status(run.id);
    expect(status.facts).toBeNull();
    expect(status.decision).toMatchObject({ stop: true, reason: "stopped_by_human", state: "stopped" });
  });

  it("finish records a tripped rule as the run's end, with no human behind it", () => {
    const { epic, a, b } = epicWithTwo();
    const run = runs.start({ actor: BOT, scope: epic });
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    const decision = decisionOf(run.id);
    if (!decision.stop) throw new Error("expected a stop");
    const ended = runs.finish(run.id, decision);
    expect(ended).toMatchObject({ state: "completed", stop: { reason: "scope_empty", by: null } });
    expect(events("run_stopped")).toEqual([expect.objectContaining({ reason: "scope_empty", state: "completed", by: null, actor: BOT })]);
    expect(runs.statuses({ actor: BOT })).toEqual([]);
    expect(runs.statuses({ all: true }).map((entry) => entry.run.id)).toEqual([run.id]);
  });

  it("never journals: a run leaves no outbox row on a device that journals", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    writeStoredRepositoryId(db, "0e77fa01-1111-4222-8333-444455556666");
    bindJournal(db, "device-alpha");
    const armed = new WorkspaceStore(db, "test", "TST");
    const outbox = (): number => (db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n;
    const epic = armed.createIssue({ title: "Epic", kind: "epic" }).identifier;
    const a = armed.createIssue({ title: "A", parent: epic }).identifier;
    armed.createIssue({ title: "B", parent: epic });
    // The control: this device does journal an ordinary write.
    expect(outbox()).toBeGreaterThan(0);
    const before = outbox();
    const run = armed.runs().start({ actor: BOT, scope: epic, maxTickets: 2 });
    armed.runs().recordTicketTaken(run.id, a);
    armed.runs().recordTicketOutcome(run.id, a, "failed", "red");
    armed.runs().setState(run.id, "paused", BOT);
    armed.runs().stop(run.id, "vp", "enough");
    expect(outbox()).toBe(before);
    expect(armed.listEvents(0, 1000).filter((event) => event.kind.startsWith("run_"))).toHaveLength(5);
  });
});

// ------------------------------------------------------------------ the pure function

function budgetView(accounts: Array<{ accountRef: string; limits: Array<{ limitKey: string; status: string; highWaterPercent: number | null }> }>): BudgetView {
  return {
    asOf: "2026-09-28T10:00:00.000Z",
    budgetCapture: true,
    reserve: { percent: 20, source: "provisional_default", note: null },
    pressureRule: {} as BudgetView["pressureRule"],
    accounts: accounts.map((account) => ({
      provider: "anthropic",
      accountRef: account.accountRef,
      bound: true,
      missing: {},
      limits: account.limits.map((limit) => ({ ...limit }) as unknown as BudgetView["accounts"][number]["limits"][number]),
    })),
  } as BudgetView;
}

const NOW = "2026-09-28T10:00:00.000Z";

function baseRun(over: Partial<RunForRules> = {}): RunForRules {
  return {
    state: "active",
    scope: { kind: "issue", issueId: "root", identifier: "TST-1" },
    budget: { maxTickets: null, until: null, ceilingPercent: null, ceilingAccount: null },
    tickets: [],
    stop: null,
    ...over,
  };
}

function baseFacts(over: Partial<RunFacts> = {}): RunFacts {
  return { now: NOW, workable: [{ issueId: "w", identifier: "TST-9", held: false }], waiting: [], pendingGates: [], personBlocks: [], ceiling: null, ...over };
}

const ticket = (issueId: string, outcome: "done" | "failed" | null) => ({
  seq: 0,
  issueId,
  identifier: issueId.toUpperCase(),
  takenAt: NOW,
  outcome,
  reason: null,
  attemptId: null,
  recordedAt: outcome === null ? null : NOW,
});

describe("evaluateStopRules", () => {
  it("reads the rules in their documented order", () => {
    // Everything trips at once: the budget wins over the streak, the streak over a block,
    // a block on the run's own ticket over the root gate, the root gate over emptiness.
    const everything = baseRun({
      budget: { maxTickets: 2, until: "2026-09-28T09:00:00.000Z", ceilingPercent: 50, ceilingAccount: null },
      tickets: [ticket("a", "failed"), ticket("b", "failed")],
    });
    const facts = baseFacts({
      workable: [],
      pendingGates: [{ issueId: "root", identifier: "TST-1", owner: "VP" }],
      personBlocks: [{ issueId: "b", identifier: "B", owner: "VP", action: null }],
      ceiling: { usedPercent: 60, accountRef: "a", limitKey: "k", missing: null },
      scopeGone: "TST-1 was deleted",
    });
    const order: string[] = [];
    let run = everything;
    let current = facts;
    for (let i = 0; i < 8; i += 1) {
      const decision = evaluateStopRules(run, current);
      if (!decision.stop) break;
      const key = decision.reason === "budget" ? `budget:${(decision.detail as { budget: string }).budget}` : decision.reason;
      order.push(key);
      // Clear exactly what tripped, and read again.
      if (key === "budget:tickets") run = { ...run, budget: { ...run.budget, maxTickets: null } };
      else if (key === "budget:time") run = { ...run, budget: { ...run.budget, until: null } };
      else if (key === "budget:ceiling") run = { ...run, budget: { ...run.budget, ceilingPercent: null } };
      else if (key === "failure_streak") run = { ...run, tickets: [ticket("a", "done"), ticket("b", "failed")] };
      else if (key === "scope_gone") current = { ...current, scopeGone: null };
      else if (key === "vp_blocked" && current.personBlocks.length > 0) current = { ...current, personBlocks: [] };
      else if (key === "gate_pending") current = { ...current, pendingGates: [] };
      else break;
    }
    expect(order).toEqual(["budget:tickets", "budget:time", "budget:ceiling", "failure_streak", "scope_gone", "vp_blocked", "gate_pending", "scope_empty"]);
  });

  it("when nothing is workable, a gate is named before a person-owned block", () => {
    const decision = evaluateStopRules(
      baseRun({ scope: { kind: "queue" } }),
      baseFacts({
        workable: [],
        pendingGates: [{ issueId: "g", identifier: "TST-4", owner: "VP" }],
        personBlocks: [{ issueId: "p", identifier: "TST-5", owner: "VP", action: null }],
      }),
    );
    expect(decision).toMatchObject({ stop: true, reason: "gate_pending" });
  });

  it("an open ticket does not count toward the failure streak, and one failure is not a streak", () => {
    expect(evaluateStopRules(baseRun({ tickets: [ticket("a", "failed"), ticket("b", null)] }), baseFacts())).toEqual({ stop: false });
    expect(evaluateStopRules(baseRun({ tickets: [ticket("a", "failed"), ticket("b", "failed"), ticket("c", null)] }), baseFacts())).toMatchObject({ reason: "failure_streak" });
  });

  it("a ceiling reading below the ceiling, or none at all, does not trip", () => {
    const run = baseRun({ budget: { maxTickets: null, until: null, ceilingPercent: 90, ceilingAccount: null } });
    expect(evaluateStopRules(run, baseFacts({ ceiling: { usedPercent: 89.9, accountRef: "a", limitKey: "k", missing: null } }))).toEqual({ stop: false });
    expect(evaluateStopRules(run, baseFacts({ ceiling: { usedPercent: null, accountRef: null, limitKey: null, missing: "no_current_reading" } }))).toEqual({ stop: false });
  });

  it("a paused run is not stopped by pausing, and an ended run answers its recorded reason", () => {
    expect(evaluateStopRules(baseRun({ state: "paused" }), baseFacts())).toEqual({ stop: false });
    const ended = baseRun({ state: "completed", stop: { reason: "scope_empty", detail: {}, by: null, note: null, at: NOW } });
    expect(evaluateStopRules(ended, baseFacts())).toMatchObject({ stop: true, reason: "scope_empty", state: "completed" });
  });
});
