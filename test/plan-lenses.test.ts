/**
 * What the lenses read from the plan (design/plan.md, "Lenses"): each record's completeness and
 * the records it waits on, a horizon's shipped count and progress, its Queue held back once
 * queued and Run offered while it holds work, and the horizon each task's work belongs to, which
 * the task list's chip, grouping and filter read.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { recordKeys, resolveDependencies } from "../src/core/plan-sections.js";
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
  plan.clock = () => new Date("2026-11-08T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
});

const horizon = (name: string) => plan.view().horizons.find((h) => h.name === name)!;
const view = (id: string) => plan.view().ideas.find((idea) => idea.id === id)!;
const finish = (identifier: string) => {
  store.checkoutIssue(identifier, "agent");
  store.updateIssue(identifier, { status: "done" }, "agent");
};

describe("the records a record waits on", () => {
  const records = [
    { id: "c2", identifier: null, title: "C2 Checkout API" },
    { id: "c3", identifier: null, title: "C3 OpenAPI + SDKs" },
    { id: "r2a", identifier: "TST-40", title: "R2 · Exercise API" },
    { id: "r2b", identifier: "TST-49", title: "R2 · Docs" },
    { id: "cap", identifier: null, title: "[CAP] Identity & Access" },
  ];

  it("names a record by its ticket number and by the keys in its title", () => {
    expect(recordKeys(records[0]!)).toEqual(["C2"]);
    expect(recordKeys(records[2]!)).toEqual(["TST-40", "R2"]);
    expect(recordKeys(records[4]!)).toEqual([]);
  });

  it("reads them from the Dependencies section and from depends-on cells naming something outside the breakdown", () => {
    const sections = {
      dependencies: ["C2 must be merged first", "TST-49 (docs)"],
      breakdown: [
        { id: "row-1", key: "3.1", title: "x", estimate: null, dependsOn: [], acceptance: "y", owner: null, notes: null },
        { id: "row-2", key: "3.6", title: "x", estimate: null, dependsOn: ["3.1", "TST-40"], acceptance: "y", owner: null, notes: null },
      ],
    };
    expect(resolveDependencies("c3", sections, records)).toEqual(["c2", "r2b", "r2a"]);
  });

  it("never names a record by a key two records share, and never itself", () => {
    expect(resolveDependencies("c3", { dependencies: ["R2", "C3 itself", "PLAN-9"], breakdown: [] }, records)).toEqual([]);
  });

  it("are on the plan's payload, beside how much of each plan is written", () => {
    const c2 = plan.capture({ title: "C2 Checkout API", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
    const c3 = plan.capture({ title: "C3 OpenAPI + SDKs", maturity: "shaped", plan: { ...READY_PLAN, dependencies: ["C2"] } }, "vp", PERSON).id;
    expect(view(c3).dependsOn).toEqual([c2]);
    expect(view(c2).dependsOn).toEqual([]);
    expect(view(c3).completeness).toEqual({ starred: 3, starredTotal: 3, filled: 4, total: 10 });
    const bare = plan.capture({ title: "Bare" }, "vp", PERSON).id;
    expect(view(bare).completeness).toEqual({ starred: 0, starredTotal: 3, filled: 0, total: 10 });
  });
});

describe("a horizon's delivery", () => {
  it("counts its shipped records and its landed members", () => {
    const now = horizon("Now").id;
    const landed = plan.capture({ title: "Landed", maturity: "shaped", plan: READY_PLAN, horizon: now }, "vp", PERSON).id;
    const open = plan.capture({ title: "Open", maturity: "shaped", plan: READY_PLAN, horizon: now }, "vp", PERSON).id;
    const a = store.createIssue({ title: "Landed work" }).identifier;
    const b = store.createIssue({ title: "Open work" }).identifier;
    plan.adopt(landed, a, "agent");
    plan.adopt(open, b, "agent");
    finish(a);
    expect(horizon("Now")).toMatchObject({ shippedCount: 1, progress: 0.5 });
    expect(view(landed).state).toBe("shipped");
    expect(horizon("Next")).toMatchObject({ shippedCount: 0, progress: null });
  });

  it("offers its run setting in every state but shipped, Queue while it holds work, and holds Queue back once it is queued", () => {
    const now = horizon("Now");
    expect(now.actions.map((action) => action.id)).toEqual(["rename", "date", "reorder", "run", "remove"]);
    const record = plan.capture({ title: "Work", maturity: "shaped", plan: READY_PLAN, horizon: now.id }, "vp", PERSON).id;
    plan.adopt(record, store.createIssue({ title: "Some work" }).identifier, "agent");
    expect(horizon("Now").actions.map((action) => [action.id, action.who, action.disabledReason])).toEqual([
      ["rename", "person", undefined],
      ["date", "person", undefined],
      ["reorder", "person", undefined],
      ["queue", "anyone", undefined],
      ["run", "person", undefined],
    ]);
    store.queue().enqueue(now.identifier, {}, "vp");
    expect(horizon("Now").actions.find((action) => action.id === "queue")?.disabledReason).toBe("It is in the queue already.");
  });
});

describe("the horizon a task's work belongs to", () => {
  it("is its own membership, derived from the plan or put there, else its nearest ancestor's, and only a horizon's", () => {
    const now = horizon("Now");
    const record = plan.capture({ title: "Epic on Now", maturity: "shaped", plan: READY_PLAN, horizon: now.id }, "vp", PERSON).id;
    const epic = plan.promote(record, "vp", PERSON).identifier!;
    const task = store.createIssue({ title: "A task under it", parent: epic });
    const sub = store.createIssue({ title: "A sub-task", parent: task.identifier });
    const loose = store.createIssue({ title: "Loose" });
    const next = horizon("Next");
    store.milestones().addMember(next.identifier, loose.identifier, {}, "vp");
    const other = store.milestones().create({ title: "Not a horizon" }, "vp") as { milestone: { identifier: string } };
    const elsewhere = store.createIssue({ title: "Elsewhere" });
    store.milestones().addMember(other.milestone.identifier, elsewhere.identifier, {}, "vp");
    const ids = [store.getIssue(epic).id, task.id, sub.id, loose.id, elsewhere.id];
    const of = plan.horizonsOf(ids);
    expect(of.get(store.getIssue(epic).id)).toMatchObject({ identifier: now.identifier, name: "Now" });
    expect(of.get(task.id)?.identifier).toBe(now.identifier);
    expect(of.get(sub.id)?.identifier).toBe(now.identifier);
    expect(of.get(loose.id)?.identifier).toBe(next.identifier);
    expect(of.has(elsewhere.id)).toBe(false);
  });

  it("is nothing when the plan is off", () => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    const off = new WorkspaceStore(db, "off", "OFF");
    const task = off.createIssue({ title: "x" });
    expect(off.plan().horizonsOf([task.id]).size).toBe(0);
  });
});
