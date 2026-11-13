/**
 * Plan steps at pickup (design/plan.md, "Plan steps"): tickets first, steps listed. A pickup
 * answer on a horizon carries its steps in plan order beside its ticket; with no ticket left
 * `next` is null and the steps remain. A run over such a horizon stops `planning_needed`, never
 * `scope_empty` or `goal_met`. The horizon-plan instruction reaches every ticket of a horizon
 * wherever horizon-run does, and the horizon itself.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { HORIZON_PLAN_KEY, HORIZON_RUN_KEY } from "../src/core/instructions.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { buildBrief } from "../src/core/run-brief.js";
import { evaluateStopRules, type RunFacts, type RunForRules } from "../src/core/run-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import type { PlanStep } from "../src/core/plan-steps.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;
const BOT = "bot";

let store: WorkspaceStore;
let plan: PlanStore;
let now: string;
let nowRef: string;
let next: string;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  plan = store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
  const horizons = plan.view().horizons;
  now = horizons.find((h) => h.name === "Now")!.id;
  nowRef = horizons.find((h) => h.name === "Now")!.identifier;
  next = horizons.find((h) => h.name === "Next")!.id;
});

/** Now: a ticket placed by hand, an idea with a question for the person, one to scaffold and one waiting. */
function horizonWithSteps() {
  const ledger = store.createIssue({ title: "Ledger" });
  store.milestones().addMember(now, ledger.identifier, {}, "vp");
  const checkout = plan.capture({ title: "Checkout API", maturity: "exploring", horizon: now }, "vp", PERSON).id;
  plan.addQuestion(checkout, "Which payment provider?", "agent");
  const search = plan.capture({ title: "Invoice search", maturity: "shaped", horizon: now, plan: READY_PLAN }, "vp", PERSON).id;
  const audit = plan.capture({ title: "Audit trail", maturity: "shaped", horizon: now, plan: READY_PLAN, plannedStart: "2026-12-01" }, "vp", PERSON).id;
  return { ledger: ledger.identifier, checkout, search, audit };
}

const needs = (steps: readonly PlanStep[] | undefined) => (steps ?? []).map((step) => [step.ideaId, step.need, step.who]);
const finish = (ref: string) => store.updateIssue(ref, { status: "done" }, "vp");

describe("a pickup answer on a horizon", () => {
  it("names its ticket while one is eligible, and lists its steps in plan order beside it", () => {
    const { ledger, checkout, search, audit } = horizonWithSteps();
    const answer = store.queue().effectiveQueue({ actor: BOT, scope: nowRef });
    expect(answer.next?.identifier).toBe(ledger);
    const steps = plan.pickupPlanSteps({ scope: answer.scope!.issueId, next: answer.next!.issueId });
    expect(needs(steps)).toEqual([
      [checkout, "answer_questions", "person"],
      [search, "scaffold", "agent"],
      [audit, "wait", "nobody"],
    ]);
  });

  it("with no ticket left answers next null, and its steps stay", () => {
    const { ledger, search } = horizonWithSteps();
    finish(ledger);
    const answer = store.queue().effectiveQueue({ actor: BOT, scope: nowRef });
    expect(answer.next).toBeNull();
    const steps = plan.pickupPlanSteps({ scope: answer.scope!.issueId, next: null })!;
    expect(steps.length).toBe(3);
    expect(steps.find((step) => step.who === "agent")?.ideaId).toBe(search);
  });

  it("unscoped, carries the steps of the ticket's horizon and of every queued horizon, in horizon order", () => {
    const { ledger, checkout } = horizonWithSteps();
    const later = plan.capture({ title: "Billing export", maturity: "shaped", horizon: next, plan: READY_PLAN }, "vp", PERSON).id;
    store.queue().mutate("add", { ref: ledger }, "vp");
    const answer = store.queue().effectiveQueue({ actor: BOT });
    expect(answer.next?.identifier).toBe(ledger);
    // Only Now's: the ticket is Now's, and Next is not queued.
    expect(plan.pickupPlanSteps({ scope: null, next: answer.next!.issueId })!.map((step) => step.horizonId)).toEqual([now, now, now]);
    // A horizon is queued while it holds open work.
    store.milestones().addMember(next, store.createIssue({ title: "Export job" }).identifier, {}, "vp");
    store.queue().mutate("add", { ref: plan.view().horizons.find((h) => h.id === next)!.identifier }, "vp");
    const both = plan.pickupPlanSteps({ scope: null, next: answer.next!.issueId })!;
    expect(both.map((step) => step.ideaId)).toEqual([checkout, expect.any(String), expect.any(String), later]);
    // A ticket on no horizon: the queued horizons' only.
    expect(plan.pickupPlanSteps({ scope: null, next: store.createIssue({ title: "Loose" }).id })!.map((step) => step.horizonId)).toEqual([next]);
  });

  it("never names an idea: next is a ticket or null whatever the steps say", () => {
    horizonWithSteps();
    const rows = store.queue().effectiveQueue({ actor: BOT, scope: nowRef }).rows;
    expect(rows.every((row) => store.getIssue(row.issueId).kind !== "idea")).toBe(true);
  });
});

describe("a run over a horizon with steps pending and nothing to take", () => {
  it("stops planning_needed, not goal_met, with the steps; the run ends stopped", () => {
    const { ledger, search } = horizonWithSteps();
    plan.setHorizonRun(now, { mode: "goal" }, "vp", PERSON);
    const run = store.runs().start({ actor: BOT, scope: nowRef, gateOwner: "VP" });
    const take = store.runs().continue({ actor: BOT });
    expect(take).toMatchObject({ action: "take", ref: ledger });
    expect(needs(take.action === "take" ? take.planSteps : undefined).length).toBe(3);
    finish(ledger);
    const stop = store.runs().continue({ actor: BOT, outcome: "done" });
    expect(stop).toMatchObject({ action: "stop", reason: "planning_needed" });
    const detail = (stop as { detail: { planSteps: PlanStep[]; earliestWait?: unknown } }).detail;
    expect(detail.planSteps.find((step) => step.who === "agent")?.ideaId).toBe(search);
    expect(detail).not.toHaveProperty("earliestWait");
    expect(store.runs().get(run.id).state).toBe("stopped");
  });

  it("hands a driven session the steps and the horizon-plan instruction in its brief, as information, never as its work", () => {
    const { ledger } = horizonWithSteps();
    plan.setHorizonRun(now, { mode: "goal" }, "vp", PERSON);
    const run = store.runs().start({ actor: BOT, scope: nowRef, gateOwner: "VP" });
    const take = store.runs().continue({ actor: BOT });
    if (take.action !== "take") throw new Error(`expected a take, got ${take.action}`);
    const brief = buildBrief({ ref: take.ref, title: take.title, workspace: "/scratch", db: "/scratch/x.db", runId: run.id, actor: BOT, finish: "in_review", instructions: null, ticketInstructions: take.instructions, planSteps: take.planSteps });
    expect(take.ref).toBe(ledger);
    expect(brief).toContain("## The plan steps beside this ticket");
    expect(brief).toContain("None of it is this session's work");
    expect(brief).toContain("- answer_questions · person · Checkout API\n- scaffold · agent · Invoice search\n- wait · nobody · Audit trail");
    expect(brief).toContain("### horizon-plan (");
    expect(brief).toContain("Never scaffold a waiting idea");
    const bare = buildBrief({ ref: take.ref, title: take.title, workspace: "/scratch", db: "/scratch/x.db", runId: run.id, actor: BOT, finish: "in_review", instructions: null });
    expect(bare).not.toContain("plan steps");
  });

  it("over the queue stops planning_needed, not scope_empty, and says when every step left waits", () => {
    const audit = plan.capture({ title: "Audit trail", maturity: "shaped", horizon: now, plan: READY_PLAN, plannedStart: "2026-12-01" }, "vp", PERSON).id;
    plan.capture({ title: "Refunds", maturity: "shaped", horizon: now, plan: READY_PLAN, plannedStart: "2026-11-20" }, "vp", PERSON);
    // Queued while it held a ticket, which has landed since.
    const ledger = store.createIssue({ title: "Ledger" });
    store.milestones().addMember(now, ledger.identifier, {}, "vp");
    store.queue().mutate("add", { ref: nowRef }, "vp");
    finish(ledger.identifier);
    const run = store.runs().start({ actor: BOT, scope: "queue" });
    const stop = store.runs().continue({ actor: BOT });
    expect(stop).toMatchObject({ action: "stop", reason: "planning_needed", detail: { earliestWait: "2026-11-20" } });
    expect((stop as { detail: { planSteps: PlanStep[] } }).detail.planSteps.map((step) => step.need)).toEqual(["wait", "wait"]);
    expect((stop as { detail: { planSteps: PlanStep[] } }).detail.planSteps[0]!.ideaId).toBe(audit);
    expect(store.runs().get(run.id).state).toBe("stopped");
  });

  it("ends as before once nothing is pending: the same run reads scope_empty", () => {
    const ledger = store.createIssue({ title: "Ledger" });
    store.milestones().addMember(now, ledger.identifier, {}, "vp");
    store.queue().mutate("add", { ref: nowRef }, "vp");
    finish(ledger.identifier);
    const run = store.runs().start({ actor: BOT, scope: "queue" });
    expect(store.runs().status(run.id).decision).toMatchObject({ stop: true, reason: "scope_empty" });
  });
});

describe("with planning off", () => {
  it("a run takes and ends as before: no steps on the take, scope_empty rather than planning_needed", () => {
    const { ledger } = horizonWithSteps();
    store.queue().mutate("add", { ref: ledger }, "vp");
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    expect(plan.pickupPlanSteps({ scope: nowRef, next: null })).toBeUndefined();
    const run = store.runs().start({ actor: BOT, scope: "queue" });
    const take = store.runs().continue({ actor: BOT });
    expect(take).toMatchObject({ action: "take", ref: ledger });
    expect(take).not.toHaveProperty("planSteps");
    expect(store.runs().status(run.id).facts).not.toHaveProperty("planSteps");
    finish(ledger);
    expect(store.runs().continue({ actor: BOT, outcome: "done" })).toMatchObject({ action: "stop", reason: "scope_empty", detail: {} });
    expect(store.instructions(ledger).map((entry) => entry.key)).not.toContain(HORIZON_PLAN_KEY);
  });
});

describe("the stop rules", () => {
  const run: RunForRules = { state: "active", scope: { kind: "queue" }, budget: { maxTickets: null, until: null, ceilingPercent: null, ceilingAccount: null }, tickets: [], stop: null };
  const empty: RunFacts = { now: "2026-11-07T12:00:00.000Z", workable: [], waiting: [], pendingGates: [], personBlocks: [], ceiling: null };
  const step = (need: PlanStep["need"], who: PlanStep["who"], start?: string): PlanStep => ({
    ideaId: need,
    title: need,
    parentId: null,
    parentTitle: null,
    horizonId: "h",
    state: "shaped",
    need,
    who,
    instruction: "",
    ...(start ? { waitingOn: { start } } : {}),
  });

  it("put planning_needed before goal_met and scope_empty, and after a workable ticket", () => {
    const goal = { milestone: "TST-1", counts: { met: 0, unmet: 0, unknown: 0, total: 0 }, met: true, childCap: 3, childrenCreated: 0 };
    expect(evaluateStopRules(run, { ...empty, goal })).toMatchObject({ reason: "goal_met" });
    expect(evaluateStopRules(run, empty)).toMatchObject({ reason: "scope_empty" });
    const planSteps = [step("scaffold", "agent")];
    expect(evaluateStopRules(run, { ...empty, goal, planSteps })).toMatchObject({ stop: true, reason: "planning_needed", state: "stopped", detail: { planSteps } });
    expect(evaluateStopRules(run, { ...empty, planSteps })).toMatchObject({ reason: "planning_needed" });
    expect(evaluateStopRules(run, { ...empty, planSteps, workable: [{ issueId: "t", identifier: "TST-2", held: false }] })).toEqual({ stop: false });
  });

  it("name the earliest wait when every step left waits, and null when none waits on a date", () => {
    expect(evaluateStopRules(run, { ...empty, planSteps: [step("wait", "nobody", "2026-12-01"), step("wait", "nobody", "2026-11-20")] }).detail).toMatchObject({ earliestWait: "2026-11-20" });
    expect(evaluateStopRules(run, { ...empty, planSteps: [step("wait", "nobody")] }).detail).toMatchObject({ earliestWait: null });
  });
});

describe("the horizon-plan instruction", () => {
  it("reaches every ticket wherever horizon-run does, and the horizon itself", () => {
    plan.setHorizonRun(now, { mode: "work" }, "vp", PERSON);
    plan.setHorizonRun(next, { mode: "epic" }, "vp", PERSON);
    // A ticket placed by hand, an epic and its task placed by hand, and a scaffolded idea's epic and tasks.
    const placed = store.createIssue({ title: "Ledger" });
    store.milestones().addMember(now, placed.identifier, {}, "vp");
    const epic = store.createIssue({ title: "Payments", kind: "epic" });
    const child = store.createIssue({ title: "Refund flow", parent: epic.identifier });
    store.milestones().addMember(now, epic.identifier, {}, "vp");
    const idea = plan.capture({ title: "Invoice search", maturity: "shaped", horizon: now, plan: READY_PLAN }, "vp", PERSON).id;
    plan.scaffold(idea, plan.scaffoldPreview(idea).fingerprint, "agent");
    const outside = store.createIssue({ title: "Not on a horizon" });
    const keys = (id: string) => store.instructions(id).map((entry) => entry.key);
    const everything = store.listIssues({}).map((issue) => issue.id);
    expect(everything.length).toBeGreaterThan(6);
    for (const id of [...everything, now, next]) expect([id, keys(id).includes(HORIZON_PLAN_KEY)]).toEqual([id, keys(id).includes(HORIZON_RUN_KEY)]);
    for (const id of [placed.id, epic.id, child.id, now]) expect(keys(id)).toContain(HORIZON_PLAN_KEY);
    expect(keys(outside.id)).not.toContain(HORIZON_PLAN_KEY);
    const body = store.instructions(child.id).find((entry) => entry.key === HORIZON_PLAN_KEY)!.body;
    expect(body).toContain("Tickets first");
    expect(body).toContain("first step whose who is agent");
    expect(body).toContain("Never scaffold a waiting idea");
  });

  it("reaches them with no run setting too: planning on is all it needs", () => {
    const placed = store.createIssue({ title: "Ledger" });
    store.milestones().addMember(now, placed.identifier, {}, "vp");
    expect(store.instructions(placed.id).map((entry) => entry.key)).toEqual([HORIZON_PLAN_KEY]);
  });
});
