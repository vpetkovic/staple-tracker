/**
 * What a horizon counts (design/plan.md, "Accounting"): done, open and planned work items, where
 * a planned item is a breakdown row of a scheduled idea with no tickets yet; an idea with nothing
 * to count is unsized, never zero work; leaf records are what the counts print; and a horizon is
 * never shipped while a scheduled, non-dropped record is not. One derivation, read by the plan
 * and by the milestone view of the same horizon.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { BreakdownRow } from "../src/core/plan-sections.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;

let store: WorkspaceStore;
let plan: PlanStore;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  plan = store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
});

function horizon(name: string): string {
  return plan.view().horizons.find((h) => h.name === name)!.id;
}

function rows(count: number): Array<Omit<BreakdownRow, "id">> {
  return Array.from({ length: count }, (_, at) => ({ key: String(at + 1), title: `Step ${at + 1}`, estimate: "2h", dependsOn: [], acceptance: "It works", owner: null, notes: null }));
}

function idea(title: string, extra: Parameters<PlanStore["capture"]>[0] extends infer I ? Partial<I> : never = {}): string {
  return plan.capture({ title, maturity: "shaped", plan: READY_PLAN, ...extra }, "vp", PERSON).id;
}

function finish(identifier: string): void {
  store.checkoutIssue(identifier, "agent");
  store.updateIssue(identifier, { status: "done" }, "agent");
}

const categoryOf = (id: string) => store.categoryOf(store.getIssue(id).status);
const horizonView = (name: string) => plan.view().horizons.find((h) => h.name === name)!;

/**
 * Now holds: a promoted epic with three tasks (two done), a task placed by hand (done), a shaped
 * idea with three rows and no tickets, and an umbrella idea whose sub-ideas are a shaped idea with
 * two rows and an exploring idea with nothing written yet.
 */
function mixedHorizon() {
  const now = horizon("Now");
  // Dated, so the Milestones list carries it too.
  plan.updateHorizon(now, { date: "2026-12-18" }, "vp", PERSON);
  const checkout = idea("Checkout API", { horizon: now });
  const epic = plan.promote(checkout, "vp", PERSON).identifier!;
  const tasks = ["Cart", "Payment", "Receipt"].map((title) => store.createIssue({ title, parent: epic }).identifier);
  finish(tasks[0]!);
  finish(tasks[1]!);
  const byHand = store.createIssue({ title: "Billing export" });
  store.milestones().addMember(now, byHand.identifier, {}, "vp");
  finish(byHand.identifier);
  const search = idea("Invoice search", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(3) } });
  const reporting = plan.capture({ title: "Reporting", maturity: "exploring", horizon: now }, "vp", PERSON).id;
  const usage = idea("Usage report", { horizon: now, parent: reporting, plan: { ...READY_PLAN, breakdown: rows(2) } });
  const audit = plan.capture({ title: "Audit trail", maturity: "exploring", horizon: now, parent: reporting }, "vp", PERSON).id;
  return { now, checkout, epic, tasks, search, reporting, usage, audit };
}

describe("a horizon's units", () => {
  it("counts its tickets' leaves done and open, and its ideas' breakdown rows as planned", () => {
    const { now } = mixedHorizon();
    const view = horizonView("Now");
    expect(view.units).toEqual({ done: 3, open: 1, planned: 5, total: 9 });
    expect(view.progress).toBeCloseTo(3 / 9);
    expect(store.milestones().get(now).progress).toMatchObject({ countable: 4, planned: 5, unsized: 1, percent: 33, complete: false });
  });

  it("reports an idea with neither work nor rows nor sub-ideas as unsized, never as zero work", () => {
    const { audit } = mixedHorizon();
    expect(horizonView("Now").unsizedCount).toBe(1);
    expect(plan.ideaView(audit)).toMatchObject({ unsized: true, units: { planned: 0, total: 0 } });
    // An umbrella over sub-ideas is not unsized: its sub-ideas carry its size.
    expect(plan.ideaView(plan.view().ideas.find((i) => i.title === "Reporting")!.id).unsized).toBe(false);
  });

  it("prints leaf records by state and counts the parent apart from its children", () => {
    mixedHorizon();
    const view = horizonView("Now");
    expect(view.records).toEqual({ leaves: 4, shipped: 0, started: 1, shaped: 2, exploring: 1, parentCount: 1 });
    // ideaCount keeps its meaning: every non-dropped record on the horizon, the parent included.
    expect(view.ideaCount).toBe(5);
  });

  it("reads the same percentage on the plan and on the milestone view", () => {
    const { now } = mixedHorizon();
    const fromPlan = horizonView("Now");
    const fromMilestone = store.milestones().get(now).progress;
    expect(Math.floor(fromPlan.progress! * 100)).toBe(fromMilestone.percent);
    const listed = store.milestones().list({ all: true }).find((row) => row.milestone.id === now)!;
    expect(listed.progress).toEqual(fromMilestone);
  });

  it("leaves a plain milestone's progress exactly as it was", () => {
    mixedHorizon();
    const plain = store.createIssue({ title: "Release train", kind: "milestone" });
    const task = store.createIssue({ title: "Ship notes" });
    store.milestones().addMember(plain.identifier, task.identifier, {}, "vp");
    expect(store.milestones().get(plain.identifier).progress).toEqual({
      total: 1,
      countable: 1,
      counts: expect.objectContaining({ done: 0 }),
      percent: 0,
      complete: false,
    });
    expect(Object.keys(store.milestones().get(plain.identifier).progress).sort()).toEqual(["complete", "countable", "counts", "percent", "total"]);
  });

  it("is absent with planning off: the milestone view counts ticket leaves only, as before", () => {
    const { now } = mixedHorizon();
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    const progress = store.milestones().get(now).progress;
    expect(Object.keys(progress).sort()).toEqual(["complete", "countable", "counts", "percent", "total"]);
    expect(progress).toMatchObject({ countable: 4, percent: 75 });
  });
});

describe("a parent's rollup", () => {
  it("counts its sub-ideas' planned rows beside their tickets", () => {
    const payments = plan.capture({ title: "Payments", maturity: "exploring" }, "vp", PERSON).id;
    const vault = idea("Card vault", { parent: payments });
    const task = store.createIssue({ title: "Store tokens" });
    plan.adopt(vault, task.identifier, "agent");
    finish(task.identifier);
    idea("Refunds", { parent: payments, plan: { ...READY_PLAN, breakdown: rows(3) } });
    const parent = plan.ideaView(payments);
    expect(parent.units).toMatchObject({ done: 1, open: 0, planned: 3, total: 4 });
    expect(parent.progress).toBeCloseTo(0.25);
  });
});

describe("a parent whose breakdown names its sub-ideas", () => {
  it("counts its sub-ideas' rows once, not its own beside them, on the horizon and in its rollup", () => {
    const now = horizon("Now");
    const parent = idea("Payments", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(2) } });
    idea("Card vault", { horizon: now, parent, plan: { ...READY_PLAN, breakdown: rows(3) } });
    idea("Refunds", { horizon: now, parent, plan: { ...READY_PLAN, breakdown: rows(4) } });
    expect(horizonView("Now")).toMatchObject({ units: { done: 0, open: 0, planned: 7, total: 7 }, unsizedCount: 0, records: { leaves: 2, shaped: 2, parentCount: 1 } });
    expect(plan.ideaView(parent)).toMatchObject({ unsized: false, units: { planned: 7, total: 7 } });
  });

  it("counts its own rows again once its sub-ideas are dropped", () => {
    const now = horizon("Now");
    const parent = idea("Payments", { horizon: now, plan: { ...READY_PLAN, breakdown: rows(2) } });
    const child = idea("Card vault", { horizon: now, parent, plan: { ...READY_PLAN, breakdown: rows(3) } });
    plan.update(child, { maturity: "dropped" }, "vp", PERSON);
    expect(horizonView("Now")).toMatchObject({ units: { planned: 2, total: 2 }, records: { leaves: 1, parentCount: 0 } });
  });
});

describe("a horizon is not shipped while a scheduled idea is not", () => {
  it("stays open when its last open ticket closes and an idea on it has no work yet", () => {
    const { now, tasks } = mixedHorizon();
    finish(tasks[2]!);
    expect(categoryOf(now)).not.toBe("done");
    expect(horizonView("Now")).toMatchObject({ shipped: false, units: { done: 4, open: 0, planned: 5, total: 9 } });
    expect(horizonView("Now").state).not.toBe("shipped");
    expect(store.milestones().list().map((row) => row.milestone.id)).toContain(now);
  });

  it("stays open over an unsized idea alone", () => {
    const now = horizon("Now");
    const epic = plan.promote(idea("Checkout API", { horizon: now }), "vp", PERSON).identifier!;
    plan.capture({ title: "Audit trail", maturity: "exploring", horizon: now }, "vp", PERSON);
    finish(epic);
    expect(categoryOf(now)).not.toBe("done");
    expect(horizonView("Now").shipped).toBe(false);
  });

  it("holds in both flag states: protection keys on what the records are", () => {
    const { now, tasks } = mixedHorizon();
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    finish(tasks[2]!);
    expect(categoryOf(now)).not.toBe("done");
  });

  it("ships when the ideas still holding it are dropped or moved off it", () => {
    const { now, tasks, search, usage, audit, reporting } = mixedHorizon();
    finish(tasks[2]!);
    expect(categoryOf(now)).not.toBe("done");
    plan.update(search, { horizon: null }, "vp", PERSON);
    plan.update(usage, { maturity: "dropped" }, "vp", PERSON);
    plan.update(audit, { maturity: "dropped" }, "vp", PERSON);
    expect(categoryOf(now)).not.toBe("done");
    plan.update(reporting, { horizon: null }, "vp", PERSON);
    expect(categoryOf(now)).toBe("done");
    expect(horizonView("Now")).toMatchObject({ shipped: true, state: "shipped" });
  });

  it("reopens a shipped horizon when the person schedules an unshipped idea onto it", () => {
    const now = horizon("Now");
    const epic = plan.promote(idea("Checkout API", { horizon: now }), "vp", PERSON).identifier!;
    finish(epic);
    expect(categoryOf(now)).toBe("done");
    idea("Invoice search", { horizon: now });
    expect(categoryOf(now)).not.toBe("done");
    expect(horizonView("Now").shipped).toBe(false);
  });
});
