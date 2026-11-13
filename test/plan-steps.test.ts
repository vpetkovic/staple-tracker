/**
 * Plan steps (design/plan.md, "Plan steps"): what each record a horizon carries still needs, and
 * who acts next. One test per row of the step table, each with its expectations written out by
 * hand; then the person releasing a waiting idea, the records that need nothing, and the order.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;

let store: WorkspaceStore;
let plan: PlanStore;
let now: string;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  plan = store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
  now = plan.view().horizons.find((h) => h.name === "Now")!.id;
});

type Capture = Parameters<PlanStore["capture"]>[0];
const capture = (title: string, extra: Partial<Capture> = {}): string => plan.capture({ title, ...extra }, "vp", PERSON).id;
const stepOf = (id: string) => plan.ideaView(id).nextStep;
const stepsOn = (horizonId: string) => plan.view().horizons.find((h) => h.id === horizonId)!.planSteps;

describe("the step table, row by row", () => {
  it("exploring with open questions: answer_questions, for the person, listing only the questions neither resolved nor deferred", () => {
    const id = capture("Checkout API", { maturity: "exploring", horizon: now });
    plan.addQuestion(id, "Which payment provider?", "agent");
    plan.addQuestion(id, "Do refunds need approval?", "agent");
    plan.addQuestion(id, "Which currencies first?", "agent");
    plan.resolveQuestion(id, 2, "agent");
    plan.deferQuestion(id, 3, "agent");
    expect(stepOf(id)).toEqual({
      ideaId: id,
      title: "Checkout API",
      parentId: null,
      parentTitle: null,
      horizonId: now,
      state: "exploring",
      need: "answer_questions",
      who: "person",
      instruction: expect.stringContaining("Never mark it shaped yourself"),
      questions: ["Which payment provider?"],
    });
  });

  it("exploring, no open question, gate not met: write_plan, for an agent, listing what the gate names", () => {
    const id = capture("Billing export", { maturity: "exploring", horizon: now, plan: { goal: "Export invoices monthly." } });
    expect(stepOf(id)).toMatchObject({ need: "write_plan", who: "agent", state: "exploring", missing: ["a task breakdown", "acceptance criteria"] });
    expect(stepOf(id)).not.toHaveProperty("questions");
  });

  it("exploring, gate met: mark_shaped, for the person", () => {
    const id = capture("Invoice search", { maturity: "exploring", horizon: now, plan: READY_PLAN });
    const step = stepOf(id)!;
    expect(step).toMatchObject({ need: "mark_shaped", who: "person", state: "exploring" });
    expect(step).not.toHaveProperty("missing");
    expect(step.instruction).toContain("ready to be marked shaped");
  });

  it("shaped, plan incomplete: fix_plan, for an agent, listing what the gate names", () => {
    const id = capture("Usage report", { maturity: "shaped", horizon: now, plan: READY_PLAN });
    plan.update(id, { plan: { acceptance: [] } }, "agent");
    expect(stepOf(id)).toMatchObject({ need: "fix_plan", who: "agent", state: "shaped", missing: ["acceptance criteria"] });
  });

  it("shaped, no own work, planned start ahead: wait, for nobody, on that date", () => {
    const id = capture("Audit trail", { maturity: "shaped", horizon: now, plan: READY_PLAN, plannedStart: "2026-12-01" });
    expect(stepOf(id)).toMatchObject({ need: "wait", who: "nobody", state: "shaped", waitingOn: { start: "2026-12-01" } });
    expect(stepOf(id)!.waitingOn).not.toHaveProperty("records");
    expect(stepOf(id)!.instruction).toContain("Never scaffold it");
  });

  it("shaped, no own work, a record it depends on unshipped: wait on that record; a dropped one holds nothing", () => {
    const ledger = capture("L1 Ledger", { maturity: "shaped", horizon: now, plan: READY_PLAN });
    const refunds = capture("Refunds", { maturity: "shaped", horizon: now, plan: { ...READY_PLAN, dependencies: ["L1"] } });
    expect(plan.ideaView(refunds).dependsOn).toEqual([ledger]);
    expect(stepOf(refunds)).toMatchObject({ need: "wait", who: "nobody", waitingOn: { records: [{ id: ledger, title: "L1 Ledger", state: "shaped" }] } });
    expect(stepOf(refunds)!.waitingOn).not.toHaveProperty("start");
    plan.update(ledger, { maturity: "dropped" }, "vp", PERSON);
    expect(stepOf(refunds)).toMatchObject({ need: "scaffold", who: "agent" });
  });

  it("shaped, no own work, its turn has come: scaffold, for an agent, re-checking the breakdown first", () => {
    const id = capture("Payment retries", { maturity: "shaped", horizon: now, plan: READY_PLAN, plannedStart: "2026-11-07" });
    const step = stepOf(id)!;
    expect(step).toMatchObject({ need: "scaffold", who: "agent", state: "shaped" });
    expect(step).not.toHaveProperty("waitingOn");
    expect(step.instruction).toMatch(/re-check the breakdown.*Scaffold.*Adopt/s);
  });

  it("raw or exploring descendants scheduled on no horizon: brainstorm, for an agent, after their parent", () => {
    const parent = capture("Reporting", { maturity: "shaped", horizon: now, plan: READY_PLAN });
    const raw = capture("Export charts", { parent });
    const exploring = capture("Scheduled emails", { parent, maturity: "exploring" });
    plan.addQuestion(exploring, "Which days?", "agent");
    expect(stepOf(raw)).toMatchObject({ need: "brainstorm", who: "agent", state: "raw", parentId: parent, parentTitle: "Reporting", horizonId: now });
    expect(stepOf(exploring)).toMatchObject({ need: "brainstorm", who: "agent", state: "exploring" });
    expect(stepsOn(now).map((step) => [step.ideaId, step.need])).toEqual([
      [parent, "scaffold"],
      [raw, "brainstorm"],
      [exploring, "brainstorm"],
    ]);
  });
});

describe("a waiting idea's turn", () => {
  it("comes when the person moves its planned start: the same idea then reads scaffold", () => {
    const id = capture("Audit trail", { maturity: "shaped", horizon: now, plan: READY_PLAN, plannedStart: "2026-12-01", plannedTarget: "2026-12-20" });
    expect(stepOf(id)!.need).toBe("wait");
    plan.update(id, { plannedStart: "2026-11-05" }, "vp", PERSON);
    expect(stepOf(id)).toMatchObject({ need: "scaffold", who: "agent" });
  });

  it("follows its parent's planned start while it has none of its own", () => {
    const parent = capture("Reporting", { maturity: "shaped", horizon: now, plan: READY_PLAN, plannedStart: "2026-12-01" });
    const child = capture("Usage report", { maturity: "shaped", parent, plan: READY_PLAN });
    expect(stepOf(child)).toMatchObject({ need: "wait", waitingOn: { start: "2026-12-01" } });
    plan.update(parent, { plannedStart: null }, "vp", PERSON);
    expect(stepOf(child)!.need).toBe("scaffold");
  });
});

describe("records that need nothing from planning", () => {
  it("an exploring idea that adopted work still asks its questions, then needs nothing", () => {
    const id = capture("Checkout API", { maturity: "exploring", horizon: now });
    plan.addQuestion(id, "Which payment provider?", "agent");
    plan.adopt(id, store.createIssue({ title: "Cart" }).identifier, "agent");
    expect(plan.ideaView(id)).toMatchObject({ state: "started", maturity: "exploring" });
    expect(stepOf(id)).toMatchObject({ need: "answer_questions", state: "started", questions: ["Which payment provider?"] });
    plan.resolveQuestion(id, 1, "agent");
    expect(stepOf(id)).toBeNull();
  });

  it("a shaped idea with its own work, a shipped one, a dropped one and an unscheduled one have none", () => {
    const started = capture("Billing export", { maturity: "shaped", horizon: now, plan: READY_PLAN });
    plan.promote(started, "vp", PERSON);
    const shipped = capture("Invoice search", { maturity: "shaped", horizon: now, plan: READY_PLAN });
    const done = store.createIssue({ title: "Search box" });
    plan.adopt(shipped, done.identifier, "agent");
    store.checkoutIssue(done.identifier, "agent");
    store.updateIssue(done.identifier, { status: "done" }, "agent");
    const dropped = capture("Old idea", { maturity: "shaped", horizon: now, plan: READY_PLAN });
    plan.update(dropped, { maturity: "dropped" }, "vp", PERSON);
    const loose = capture("Someday", { maturity: "exploring" });
    expect(plan.ideaView(shipped).state).toBe("shipped");
    for (const id of [started, shipped, loose]) expect(stepOf(id)).toBeNull();
    expect(plan.view().ideas.find((idea) => idea.id === dropped)?.nextStep ?? null).toBeNull();
    expect(stepsOn(now)).toEqual([]);
  });
});

describe("a horizon's steps", () => {
  it("list in plan order, each parent before the records beneath it, and only on the horizon that carries them", () => {
    const later = plan.view().horizons.find((h) => h.name === "Next")!.id;
    const first = capture("Checkout API", { maturity: "exploring", horizon: now });
    const parent = capture("Reporting", { maturity: "shaped", horizon: now, plan: READY_PLAN });
    const child = capture("Usage report", { maturity: "exploring", parent });
    const elsewhere = capture("Audit trail", { maturity: "shaped", horizon: later, plan: READY_PLAN });
    plan.update(first, { before: null }, "vp", PERSON);
    expect(stepsOn(now).map((step) => step.ideaId)).toEqual([parent, child, first]);
    expect(stepsOn(later).map((step) => step.ideaId)).toEqual([elsewhere]);
    expect(plan.planStepsOf(now)).toEqual(stepsOn(now));
  });
});
