import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { MILESTONE_KIND, type MilestoneProgress } from "../src/core/milestones.js";
import {
  goalCounts,
  goalPace,
  isGoalMet,
  judgeCriterion,
  parseEvidence,
  type CriterionMark,
  type EvidenceItem,
  type MemberPlan,
} from "../src/core/milestone-goal.js";
import { buildBrief } from "../src/core/run-brief.js";
import { RunStore, type ContinueAnswer } from "../src/core/run-store.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError, setClock } from "../src/core/types.js";

/**
 * Milestone goal mode: a milestone's description and criteria, the goal check (each
 * criterion judged by an agent, weighed by the tracker), the pace against the target date,
 * gating a milestone, and a run over a milestone working toward its goal through a real
 * store over real migrations, including the race the goal gate exists for: the last member
 * landing while the run works.
 */

const BOT = "bot";
const NOW = "2026-10-01T12:00:00.000Z";

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
let runs: RunStore;
beforeEach(() => {
  store = memStore();
  store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
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

/** A milestone with criteria and two task members. */
function goalMilestone(criteria: string[] = ["Docs written", "Tests pass"]): { m: string; a: string; b: string } {
  const m = store.milestones().create({ title: "October", acceptanceCriteria: criteria }, "vp");
  if (m.preview) throw new Error("unreachable");
  const a = issue("A");
  const b = issue("B");
  store.milestones().addMember(m.milestone.identifier, a, {}, "vp");
  store.milestones().addMember(m.milestone.identifier, b, {}, "vp");
  return { m: m.milestone.identifier, a, b };
}

function cont(outcome?: "done" | "failed"): ContinueAnswer {
  return runs.continue({ actor: BOT, ...(outcome ? { outcome } : {}) });
}

const status = (ref: string) => store.getIssue(ref).status;
const gateOf = (ref: string) => store.gate(ref);

// ------------------------------------------------------------------ pure

describe("evidence and verdicts", () => {
  it("parses a ticket, a document on a ticket, and free text", () => {
    expect(parseEvidence(" tst-12 ")).toEqual({ kind: "ticket", value: "tst-12", ref: "TST-12", document: null });
    expect(parseEvidence("TST-12:plan")).toEqual({ kind: "document", value: "TST-12:plan", ref: "TST-12", document: "plan" });
    expect(parseEvidence("the README says so")).toMatchObject({ kind: "text", ref: null });
  });

  const mark = (over: Partial<CriterionMark> = {}): CriterionMark => ({
    position: 1,
    criterion: "Docs written",
    verdict: "met",
    evidence: ["TST-2"],
    note: null,
    markedBy: BOT,
    runId: null,
    markedAt: NOW,
    ...over,
  });
  const holds: EvidenceItem = { kind: "ticket", value: "TST-2", ref: "TST-2", document: null, status: "done", holds: true, problem: null };
  const fails: EvidenceItem = { ...holds, status: "in_review", holds: false, problem: "TST-2 is in_review, not done" };

  it("unknown unless a mark stands: unmarked, reworded, or met on evidence that no longer holds", () => {
    expect(judgeCriterion(1, "Docs written", null, [])).toMatchObject({ verdict: "unknown", marked: null, why: "not marked yet" });
    expect(judgeCriterion(1, "Docs written and linked", mark(), [holds])).toMatchObject({ verdict: "unknown", marked: "met", why: expect.stringContaining("reworded") });
    expect(judgeCriterion(1, "Docs written", mark(), [fails])).toMatchObject({ verdict: "unknown", marked: "met", why: expect.stringContaining("TST-2 is in_review") });
    expect(judgeCriterion(1, "Docs written", mark(), [holds])).toMatchObject({ verdict: "met", why: null });
    // Unmet stands whatever its evidence says: evidence is what a met verdict rests on.
    expect(judgeCriterion(1, "Docs written", mark({ verdict: "unmet" }), [fails])).toMatchObject({ verdict: "unmet" });
  });

  it("a goal is met when every criterion is, and a goal with none has nothing left to show", () => {
    const met = judgeCriterion(1, "Docs written", mark(), [holds]);
    const unknown = judgeCriterion(2, "Tests pass", null, []);
    expect(goalCounts([met, unknown])).toEqual({ met: 1, unmet: 0, unknown: 1, total: 2 });
    expect(isGoalMet(goalCounts([met, unknown]))).toBe(false);
    expect(isGoalMet(goalCounts([met]))).toBe(true);
    expect(isGoalMet(goalCounts([]))).toBe(true);
  });
});

describe("pace against the target date", () => {
  const progress = (done: number, countable: number): MilestoneProgress => ({
    total: countable,
    countable,
    counts: { unstarted: countable - done, ready: 0, active: 0, review: 0, gated: 0, blocked: 0, done, cancelled: 0 },
    percent: countable === 0 ? null : Math.floor((done * 100) / countable),
    complete: countable > 0 && done === countable,
  });
  const plan = (over: Partial<MemberPlan>): MemberPlan => ({ ref: "TST-2", resolved: false, laborSeconds: 3600, remainingSeconds: 3600, partial: false, unplannedRefs: [], ...over });

  it("reads done, no target, overdue, no estimate, behind and on track, first match wins", () => {
    const at = (targetDate: string | null, plans: MemberPlan[], done = 0) => goalPace({ targetDate, now: NOW, progress: progress(done, 2), plans });
    expect(at("2026-09-01", [plan({ resolved: true })], 2).verdict).toBe("done");
    expect(at(null, [plan({})]).verdict).toBe("no_target");
    expect(at("2026-09-30", [plan({})])).toMatchObject({ verdict: "overdue", daysToTarget: -1 });
    expect(at("2026-10-05", [plan({ laborSeconds: null, remainingSeconds: null, partial: true })]).verdict).toBe("no_estimate");
    // 12 hours are left to the end of the target day; 20 hours of work are not.
    expect(at("2026-10-01", [plan({ remainingSeconds: 20 * 3600 })])).toMatchObject({ verdict: "behind", daysToTarget: 0 });
    expect(at("2026-10-01", [plan({ remainingSeconds: 10 * 3600 })])).toMatchObject({ verdict: "on_track", remainingSeconds: 36_000 });
  });

  it("adds the members' plans, a landed member leaves nothing remaining, and an unplanned open one makes it partial", () => {
    const pace = goalPace({
      targetDate: "2026-10-10",
      now: NOW,
      progress: progress(1, 3),
      plans: [
        plan({ ref: "TST-2", resolved: true, laborSeconds: 7200, remainingSeconds: 0 }),
        plan({ ref: "TST-3", laborSeconds: 3600, remainingSeconds: 3600 }),
        plan({ ref: "TST-4", laborSeconds: null, remainingSeconds: null, partial: true, unplannedRefs: ["TST-4"] }),
      ],
    });
    expect(pace).toMatchObject({ laborSeconds: 10_800, remainingSeconds: 3600, partial: true, unplannedRefs: ["TST-4"], leaves: { done: 1, countable: 3 }, daysToTarget: 9 });
    expect(pace.message).toContain("1h+");
    // A landed member that was never estimated owes nothing: it does not make the rest partial.
    const landedUnplanned = goalPace({
      targetDate: "2026-10-10",
      now: NOW,
      progress: progress(1, 2),
      plans: [plan({ ref: "TST-2", resolved: true, laborSeconds: null, remainingSeconds: null, partial: true, unplannedRefs: ["TST-2"] }), plan({ ref: "TST-3" })],
    });
    expect(landedUnplanned).toMatchObject({ remainingSeconds: 3600, partial: false, unplannedRefs: [], verdict: "on_track" });
  });
});

// ------------------------------------------------------------------ milestone store

describe("a milestone's description and criteria", () => {
  it("new and set take them; the view carries them; set clears them", () => {
    const created = store.milestones().create({ title: "October", description: "  Ship the goal  ", acceptanceCriteria: [" a ", "", "b"] }, "vp");
    if (created.preview) throw new Error("unreachable");
    const m = created.milestone.identifier;
    expect(created.milestone).toMatchObject({ description: "Ship the goal", acceptanceCriteria: ["a", "b"] });
    // They are the issue's own fields, so every issue surface shows them too.
    expect(store.getIssue(m)).toMatchObject({ description: "Ship the goal", acceptanceCriteria: ["a", "b"] });
    const set = store.milestones().update(m, { acceptanceCriteria: ["c"] }, "vp");
    expect(set.milestone).toMatchObject({ description: "Ship the goal", acceptanceCriteria: ["c"], targetDate: null });
    const cleared = store.milestones().update(m, { description: null, acceptanceCriteria: [] }, "vp");
    expect(cleared.milestone).toMatchObject({ description: null, acceptanceCriteria: [] });
    // A dates-only set leaves the goal alone.
    store.milestones().update(m, { acceptanceCriteria: ["d"] }, "vp");
    expect(store.milestones().update(m, { targetDate: "2026-10-31" }, "vp").milestone).toMatchObject({ acceptanceCriteria: ["d"], targetDate: "2026-10-31" });
  });
});

describe("gating a milestone", () => {
  it("accepts a milestone with members and holds its close; the members stay workable", () => {
    const { m, a, b } = goalMilestone();
    store.gateIssue(m, { owner: "VP" }, "vp");
    expect(gateOf(m)).toMatchObject({ state: "pending", owner: "VP" });
    // Nothing is queued through membership: both members are still the queue's to hand out.
    expect(store.queue().effectiveQueue({ actor: BOT, scope: m }).rows.map((row) => [row.identifier, row.eligibility])).toEqual([
      [a, "eligible"],
      [b, "eligible"],
    ]);
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    // The gate is what keeps the landed milestone open for its review…
    expect(store.categoryOf(status(m))).toBe("gated");
    // …and approving it lets it land where its members say.
    store.approveGate(m, {}, "VP");
    expect(status(m)).toBe("done");
  });

  it("refuses a milestone with nothing in it, naming what to do", () => {
    const created = store.milestones().create({ title: "Empty" }, "vp");
    if (created.preview) throw new Error("unreachable");
    expect(refused(() => store.gateIssue(created.milestone.identifier, { owner: "VP" }, "vp"), "validation").message).toContain("no members and no children");
    // A leaf is still refused as before.
    expect(refused(() => store.gateIssue(issue("Leaf"), { owner: "VP" }, "vp"), "validation").message).toContain("no children, so there is nothing to queue");
  });
});

describe("milestone criterion: judging one criterion", () => {
  it("records a verdict with evidence, and the check weighs the evidence every time it reads it", () => {
    const { m, a } = goalMilestone();
    let view = store.milestones().markCriterion(m, 1, { verdict: "met", evidence: [a, "the README"] }, BOT);
    // A cited ticket that is not done does not show what it shows yet.
    expect(view.goal.criteria[0]).toMatchObject({ verdict: "unknown", marked: "met", why: expect.stringContaining(`${a} is backlog, not done`) });
    store.updateIssue(a, { status: "done" }, "vp");
    view = store.milestones().get(m);
    expect(view.goal.criteria[0]).toMatchObject({ verdict: "met", markedBy: BOT, evidence: [expect.objectContaining({ kind: "ticket", ref: a, holds: true }), expect.objectContaining({ kind: "text" })] });
    expect(view.goal).toMatchObject({ counts: { met: 1, unmet: 0, unknown: 1, total: 2 }, met: false });
    // Reworded after it was judged: the verdict was about other words.
    view = store.milestones().update(m, { acceptanceCriteria: ["Docs written and linked", "Tests pass"] }, "vp");
    expect(view.goal.criteria[0]).toMatchObject({ verdict: "unknown", why: expect.stringContaining("reworded") });
  });

  it("cites a document by ticket:key and refuses what it cannot find", () => {
    const { m, a } = goalMilestone();
    store.putDocument(a, "plan", "the plan", { author: BOT });
    expect(store.milestones().markCriterion(m, 2, { verdict: "met", evidence: [`${a}:plan`] }, BOT).goal.criteria[1]).toMatchObject({ verdict: "met" });
    expect(refused(() => store.milestones().markCriterion(m, 2, { verdict: "met", evidence: [`${a}:nope`] }, BOT), "not_found").message).toContain('no document "nope"');
    expect(refused(() => store.milestones().markCriterion(m, 2, { verdict: "met", evidence: ["TST-999"] }, BOT), "not_found").message).toContain("TST-999");
    expect(refused(() => store.milestones().markCriterion(m, 2, { verdict: "met", evidence: ["ZZZ-1"] }, BOT), "validation").message).toContain("ZZZ");
  });

  it("refuses a met verdict without evidence, a position out of range, a milestone without criteria, and a follow-up without a goal run", () => {
    const { m } = goalMilestone();
    expect(refused(() => store.milestones().markCriterion(m, 1, { verdict: "met" }, BOT), "validation").message).toContain("needs evidence");
    expect(refused(() => store.milestones().markCriterion(m, 3, { verdict: "unknown" }, BOT), "validation").message).toContain("criteria 1 to 2");
    expect(refused(() => store.milestones().markCriterion(m, 1, { verdict: "met", evidence: ["x"], followUp: { title: "More" } }, BOT), "validation").message).toContain("unmet");
    expect(refused(() => store.milestones().markCriterion(m, 1, { verdict: "unmet", followUp: { title: "More" } }, BOT), "validation").message).toContain("goal run");
    const bare = store.milestones().create({ title: "Bare" }, "vp");
    if (bare.preview) throw new Error("unreachable");
    expect(refused(() => store.milestones().markCriterion(bare.milestone.identifier, 1, { verdict: "unknown" }, BOT), "validation").message).toContain("no acceptance criteria");
  });

  it("the view's pace reads the members' certified plans", () => {
    const { m, a, b } = goalMilestone();
    store.setEstimate(a, 3600, "vp");
    store.setEstimate(b, 7200, "vp");
    store.milestones().update(m, { targetDate: "2026-10-03" }, "vp");
    setClock(() => Date.parse(NOW));
    store.updateIssue(a, { status: "done" }, "vp");
    expect(store.milestones().get(m).goal.pace).toMatchObject({ laborSeconds: 10_800, remainingSeconds: 7200, partial: false, daysToTarget: 2, verdict: "on_track", leaves: { done: 1, countable: 2 } });
  });
});

// ------------------------------------------------------------------ goal runs

describe("a run over a milestone is a goal run", () => {
  it("needs a person to gate to: --gate-owner, else the milestone's assignee", () => {
    const { m } = goalMilestone();
    expect(refused(() => runs.start({ actor: BOT, scope: m }), "validation").message).toContain("--gate-owner");
    store.updateIssue(m, { assignee: "VP" }, "vp");
    expect(runs.start({ actor: BOT, scope: m }).goal).toMatchObject({ gateOwner: "VP", childCap: 5, children: [] });
  });

  it("refuses goal settings on any other scope, and a negative cap", () => {
    const epic = issue("Epic", { kind: "epic" });
    issue("Child", { parent: epic });
    expect(refused(() => runs.start({ actor: BOT, scope: epic, gateOwner: "VP" }), "validation").message).toContain("milestone --scope");
    expect(refused(() => runs.start({ actor: BOT, scope: "queue", goalChildCap: 2 }), "validation").message).toContain("milestone --scope");
    const { m } = goalMilestone();
    expect(refused(() => runs.start({ actor: BOT, scope: m, gateOwner: "VP", goalChildCap: -1 }), "validation").message).toContain("--goal-cap");
    expect(runs.start({ actor: BOT, scope: epic }).goal).toBeNull();
  });

  it("gates the milestone at start, and its own gate is not a gate_pending stop", () => {
    const { m, a } = goalMilestone();
    const run = runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    expect(gateOf(m)).toMatchObject({ state: "pending", owner: "VP", requestedBy: BOT });
    expect(run.goal!.gatedAt).toBe(gateOf(m)!.requestedAt);
    expect(runs.status(run.id).facts!.pendingGates).toEqual([]);
    const take = cont();
    expect(take).toMatchObject({ action: "take", ref: a });
    expect(take.goal).toMatchObject({ milestone: { identifier: m }, counts: { total: 2, unknown: 2 }, gate: { state: "pending", ownedByRun: true }, children: { cap: 5, created: 0, left: 5 } });
  });

  it("THE RACE: the last member landing, by the run or by anyone else, never closes the milestone unreviewed", () => {
    const { m, a, b } = goalMilestone();
    runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    expect(cont()).toMatchObject({ action: "take", ref: a });
    // Somebody else lands the other member while the run is still on its ticket…
    store.checkoutIssue(b, "someone-else");
    store.updateIssue(b, { status: "done" }, "someone-else");
    // …and the run lands the last one.
    store.updateIssue(a, { status: "done" }, BOT);
    expect(store.categoryOf(status(m))).toBe("gated");
    expect(gateOf(m)).toMatchObject({ state: "pending" });
  });

  it("the same landing without a goal run closes the milestone: the gate is what holds it", () => {
    const { m, a, b } = goalMilestone();
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    expect(status(m)).toBe("done");
  });

  it("scope empty short of the goal: creates a goal-check ticket, attributed to the run, and takes it", () => {
    const { m, a, b } = goalMilestone();
    const run = runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    expect(runs.status(run.id).decision).toMatchObject({ stop: false, goalCheck: { counts: { met: 0, total: 2 } } });
    const take = cont();
    if (take.action !== "take") throw new Error(`expected a take, got ${take.action}`);
    const ticket = store.getIssue(take.ref);
    expect(ticket).toMatchObject({ title: "Goal check: October", createdBy: BOT, originKind: "run", originId: `${run.id}/1`, labels: ["goal-check"], checkoutAgent: BOT });
    expect(ticket.description).toContain(`staple milestone criterion ${m} <n> --met`);
    expect(store.milestones().milestoneOf(take.ref)).toBe(m);
    expect(take.run.goal!.children).toEqual([{ identifier: take.ref, title: "Goal check: October", status: ticket.status, purpose: "goal_check" }]);
    expect(take.goal!.children).toEqual({ cap: 5, created: 1, left: 4, refs: [take.ref] });
    // The session's brief says it is the goal check, how to mark, and to close it itself.
    const brief = buildBrief({ ref: take.ref, title: take.title, workspace: "/w", db: "/w/db", runId: run.id, actor: BOT, finish: "in_review", instructions: null, goal: take.goal, goalCheck: true });
    expect(brief).toContain(`is the goal check of ${m}`);
    expect(brief).toContain("--follow-up");
    expect(brief).toContain(`staple done ${take.ref} --json`);
    expect(brief).not.toContain(`staple status ${take.ref} in_review`);
  });

  it("follow-ups are attributed to the run and capped; past the cap the run stops budget goal_children", () => {
    const { m, a, b } = goalMilestone();
    const run = runs.start({ actor: BOT, scope: m, gateOwner: "VP", goalChildCap: 2 });
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    const check = cont();
    if (check.action !== "take") throw new Error("expected the goal check");
    const view = store.milestones().markCriterion(m, 2, { verdict: "unmet", evidence: ["no tests"], followUp: { title: "Write the tests" } }, BOT);
    const followUp = view.goal.criteria[1]!.evidence.at(-1)!.ref!;
    expect(store.getIssue(followUp)).toMatchObject({ originKind: "run", originId: `${run.id}/2`, labels: ["goal-follow-up"], createdBy: BOT, acceptanceCriteria: ["Tests pass"] });
    expect(view.goal.criteria[1]).toMatchObject({ verdict: "unmet", runId: run.id });
    expect(refused(() => store.milestones().markCriterion(m, 1, { verdict: "unmet", followUp: { title: "More docs" } }, BOT), "validation").message).toContain("cap of 2");
    store.updateIssue(check.ref, { status: "done" }, BOT);
    expect(cont()).toMatchObject({ action: "take", ref: followUp });
    store.updateIssue(followUp, { status: "done" }, BOT);
    // Still not met, and no room for another goal check.
    const stop = cont();
    expect(stop).toMatchObject({ action: "stop", reason: "budget", detail: { budget: "goal_children", childCap: 2, created: 2 }, run: { state: "stopped" } });
    expect(stop.goal!.gate).toMatchObject({ state: "pending", ownedByRun: true });
    expect(store.categoryOf(status(m))).toBe("gated");
  });

  it("every criterion met: stops goal_met, completed, the milestone left gated to its owner; approval lands it", () => {
    const { m, a, b } = goalMilestone();
    const run = runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    store.milestones().markCriterion(m, 1, { verdict: "met", evidence: [a] }, BOT);
    store.milestones().markCriterion(m, 2, { verdict: "met", evidence: [b] }, BOT);
    const stop = cont();
    expect(stop).toMatchObject({ action: "stop", reason: "goal_met", detail: { milestone: m, counts: { met: 2, total: 2 } }, run: { id: run.id, state: "completed", stop: { reason: "goal_met" } } });
    expect(stop.goal).toMatchObject({ met: true, gate: { state: "pending", owner: "VP", ownedByRun: true } });
    expect(store.categoryOf(status(m))).toBe("gated");
    store.approveGate(m, {}, "VP");
    expect(status(m)).toBe("done");
  });

  it("a person's changes_requested holds the close while the run works, and goal_met gates it again", () => {
    const { m, a, b } = goalMilestone(["Docs written"]);
    runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    store.requestChanges(m, { comment: "not yet" }, "VP");
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    // Still open: the objection holds the close.
    expect(store.isResolvedStatus(status(m))).toBe(false);
    store.milestones().markCriterion(m, 1, { verdict: "met", evidence: [a] }, BOT);
    expect(cont()).toMatchObject({ action: "stop", reason: "goal_met", goal: { gate: { state: "pending", ownedByRun: true } } });
    expect(gateOf(m)).toMatchObject({ state: "pending", requestedBy: BOT });
  });

  it("an approved gate is history: the run gates again before it adds a member", () => {
    const { m, a, b } = goalMilestone();
    runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    store.approveGate(m, {}, "VP");
    expect(gateOf(m)).toMatchObject({ state: "approved" });
    store.updateIssue(a, { status: "done" }, "vp");
    // Approved means reviewed, so the milestone may land on its own now; one member is left.
    store.updateIssue(b, { status: "done" }, "vp");
    expect(status(m)).toBe("done");
    // A milestone a person let land is their decision: the run ends as any run does.
    expect(cont()).toMatchObject({ action: "stop", reason: "scope_empty" });
  });

  it("a goal-check ticket re-gates an approved milestone before it joins, so it cannot be the one that closes it", () => {
    const { m, a, b } = goalMilestone();
    const run = runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    store.updateIssue(a, { status: "done" }, "vp");
    store.approveGate(m, {}, "VP");
    store.updateIssue(b, { status: "done" }, "vp");
    // Approved with every member landed: it closed. Reopen it by hand to the band, as a person might.
    store.updateIssue(m, { status: "backlog" }, "vp");
    const take = cont();
    expect(take).toMatchObject({ action: "take", goal: { gate: { state: "pending", ownedByRun: true } } });
    expect(runs.get(run.id).goal!.gatedAt).toBe(gateOf(m)!.requestedAt);
  });

  it("with the run's other rules: a goal check the strict plan refuses waits out_of_order and is created once", () => {
    const { m, a, b } = goalMilestone();
    const run = runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    store.updateIssue(a, { status: "done" }, "vp");
    store.updateIssue(b, { status: "done" }, "vp");
    const queued = issue("Queued elsewhere");
    store.queue().mutate("add", { ref: queued }, "vp");
    store.setSetting("queue.policy", "strict", "vp");
    const first = cont();
    expect(first).toMatchObject({ action: "wait", reason: "out_of_order", goal: { children: { created: 1, left: 4 } } });
    expect(first.run!.goal!.children).toHaveLength(1);
    // Asked again: the same ticket is offered, as ordinary work, and no second one is made.
    expect(cont()).toMatchObject({ action: "wait", reason: "out_of_order" });
    expect(runs.get(run.id).goal!.children).toHaveLength(1);
    store.setSetting("queue.policy", "advisory", "vp");
    expect(cont()).toMatchObject({ action: "take", ref: first.run!.goal!.children[0]!.identifier });
  });

  it("with the run's other rules: a milestone that is no longer one reads scope_gone with no goal, and never throws", () => {
    const { m, a, b } = goalMilestone();
    const run = runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    for (const member of [a, b]) store.milestones().removeMember(m, member, {}, "vp");
    store.updateIssue(m, { kind: "task" }, "vp");
    expect(runs.status(run.id)).toMatchObject({ decision: { stop: true, reason: "scope_gone" } });
    expect(cont()).toMatchObject({ action: "stop", reason: "scope_gone", run: { state: "stopped" } });
    // The scope is a task now: there is no goal to read, and reading it does not throw.
    expect(runs.status(run.id).goal).toBeNull();
  });

  it("the goal check's brief asks for the review the driver checks", () => {
    const brief = buildBrief({ ref: "TST-9", title: "Goal check: October", workspace: "/w", db: "/w/db", runId: "r", actor: BOT, finish: "in_review", instructions: null, goal: null, goalCheck: true });
    // No goal section without a goal, but the finish still closes it.
    expect(brief).toContain("staple done TST-9 --json");
    const { m } = goalMilestone();
    runs.start({ actor: BOT, scope: m, gateOwner: "VP" });
    const goal = runs.goalReport(runs.liveRunOf(BOT));
    const withGoal = buildBrief({ ref: "TST-9", title: "Goal check: October", workspace: "/w", db: "/w/db", runId: "r", actor: BOT, finish: "in_review", instructions: null, goal, goalCheck: true });
    expect(withGoal).toContain('staple comment TST-9 "review: ..."');
    expect(withGoal).toContain("a goal check included");
  });
});
