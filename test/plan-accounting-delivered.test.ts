/**
 * The accounting of a record delivered outside the tracker (design/plan.md, "Accounting" and
 * "Delivered outside the tracker"): it counts its rows, at least one, all done, unless it is an
 * umbrella over live sub-records, which size it. It has no member work, so it is a third source a
 * horizon adds beside its members' leaves and its scheduled records' planned rows.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { horizonAccounting, ownUnits } from "../src/core/plan-accounting.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;
const ROW = (key: string) => ({ key, title: `Row ${key}`, estimate: "2h", dependsOn: [], acceptance: "Done", owner: null, notes: null });
const THREE_ROWS = { ...READY_PLAN, breakdown: [ROW("1"), ROW("2"), ROW("3")] };

describe("a delivered record's own units", () => {
  it("is its rows, at least one, all done, none open or planned, never unsized", () => {
    expect(ownUnits({ work: null, rows: 3, liveSubRecords: false, delivered: true })).toEqual({ done: 3, open: 0, planned: 0, unsized: false });
    expect(ownUnits({ work: null, rows: 0, liveSubRecords: false, delivered: true })).toEqual({ done: 1, open: 0, planned: 0, unsized: false });
    // Not marked: its rows are planned, as before.
    expect(ownUnits({ work: null, rows: 3, liveSubRecords: false, delivered: false })).toEqual({ done: 0, open: 0, planned: 3, unsized: false });
    // Work linked since: that work sizes it, as for any record.
    expect(ownUnits({ work: { done: 1, open: 1 }, rows: 3, liveSubRecords: false, delivered: true })).toEqual({ done: 1, open: 1, planned: 0, unsized: false });
  });

  it("counts nothing of its own as an umbrella over live sub-records, which size it", () => {
    expect(ownUnits({ work: null, rows: 3, liveSubRecords: true, delivered: true })).toEqual({ done: 0, open: 0, planned: 0, unsized: false });
  });

  it("adds its done units to a horizon beside its members' leaves, as a third source", () => {
    const delivered = { state: "shipped" as const, own: ownUnits({ work: null, rows: 3, liveSubRecords: false, delivered: true }), liveSubRecords: false, holds: false, delivered: true };
    const shaped = { state: "shaped" as const, own: ownUnits({ work: null, rows: 2, liveSubRecords: false }), liveSubRecords: false, holds: true };
    const accounting = horizonAccounting({ countable: 4, counts: { done: 2 } } as never, [delivered, shaped]);
    expect(accounting.units).toEqual({ done: 5, open: 2, planned: 2, total: 9 });
    expect(accounting.records).toMatchObject({ shipped: 1, shaped: 1, leaves: 2 });
    expect(accounting.held).toBe(1);
  });
});

describe("a delivered record in the plan's views", () => {
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
  const now = () => plan.view().horizons.find((h) => h.name === "Now")!;

  it("counts on its horizon and in its parent's rollup, reads complete, and does not hold the horizon open", () => {
    const parent = plan.capture({ title: "Checkout", maturity: "exploring", horizon: now().id }, "vp", PERSON).id;
    const delivered = plan.capture({ title: "Billing export", maturity: "shaped", plan: THREE_ROWS, parent, horizon: now().id }, "vp", PERSON).id;
    plan.capture({ title: "Gift cards", maturity: "shaped", plan: READY_PLAN, parent, horizon: now().id }, "vp", PERSON);
    expect(now()).toMatchObject({ units: { done: 0, open: 0, planned: 4, total: 4 }, progress: 0 });
    plan.update(delivered, { delivered: { on: "2026-10-01" } }, "vp", PERSON);
    expect(plan.ideaView(delivered)).toMatchObject({ units: { done: 3, open: 0, planned: 0, total: 3 }, progress: 1, percent: 100 });
    expect(plan.ideaView(parent).units).toEqual({ done: 3, open: 0, planned: 1, total: 4 });
    expect(now()).toMatchObject({ units: { done: 3, open: 0, planned: 1, total: 4 }, progress: 0.75, percent: 75 });
    // The milestone view of the horizon reads the same.
    expect(store.milestones().get(now().identifier).progress).toMatchObject({ counts: { done: 0 }, delivered: 3, planned: 1, percent: 75, complete: false });
    // Only the delivered record left on a horizon: nothing holds it, and it reads complete.
    const lone = plan.createHorizon({ name: "Later", date: "2027-01-31" }, "vp", PERSON).id;
    plan.update(delivered, { delivered: null }, "vp", PERSON);
    plan.update(delivered, { parent: null, horizon: lone }, "vp", PERSON);
    plan.update(delivered, { delivered: { on: "2026-10-01" } }, "vp", PERSON);
    expect(plan.heldByPlan(lone)).toBe(false);
    // Complete: every counted unit is done. Its milestone has no member to derive a status from,
    // so closing it is the person's (design/plan.md, "Accounting").
    expect(plan.view().horizons.find((h) => h.id === lone)).toMatchObject({ units: { done: 3, open: 0, planned: 0, total: 3 }, percent: 100, complete: true });
  });

  it("with the mark cleared, its rows are planned again and it holds its horizon", () => {
    const id = plan.capture({ title: "Billing export", maturity: "shaped", plan: THREE_ROWS, horizon: now().id }, "vp", PERSON).id;
    plan.update(id, { delivered: { on: "2026-10-01" } }, "vp", PERSON);
    expect(plan.heldByPlan(now().id)).toBe(false);
    plan.update(id, { delivered: null }, "vp", PERSON);
    expect(now()).toMatchObject({ units: { done: 0, open: 0, planned: 3, total: 3 } });
    expect(plan.heldByPlan(now().id)).toBe(true);
  });
});
