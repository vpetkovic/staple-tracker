/**
 * What a plan read costs (design/plan.md, "Reads"). The page's server answers every plan write
 * with the whole plan and the record's detail, on its one event loop; a read that grows with the
 * plan and repeats per request stalls every other request. So a record's documents are read by
 * id in one statement each, never by resolving a reference, and the plan's views are derived once
 * per state of the database: a request that checks a state, writes and answers rebuilds them
 * once for the write.
 */
import { StatementSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db.js";
import { Journal } from "../src/core/journal.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore, rederivePlanMilestonesAfterPull } from "../src/core/store.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;

let store: WorkspaceStore;
let plan: PlanStore;
let ids: string[];
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  plan = store.plan();
  plan.clock = () => new Date("2026-11-08T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
  ids = ["raw", "exploring", "shaped", "shaped"].map((maturity, at) => plan.capture({ title: `Idea ${at}`, maturity, brief: "b", plan: READY_PLAN }, "vp", PERSON).id);
});

const builds = () => vi.spyOn(plan as unknown as { buildIdeaViews: () => unknown }, "buildIdeaViews");

describe("a plan read", () => {
  it("never resolves a reference to read a record's documents", () => {
    const resolved = vi.spyOn(store, "listDocuments");
    plan.view();
    for (const id of ids) plan.detail(id);
    expect(resolved).not.toHaveBeenCalled();
  });

  it("derives the plan once per state of the database, however many reads ask", () => {
    const spy = builds();
    plan.view();
    plan.view();
    for (const id of ids) plan.ideaView(id);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(1);
  });

  it("derives it once more for a write, as the server answers it: check, write, plan, detail", () => {
    const spy = builds();
    plan.update(ids[2]!, { title: "Renamed" }, "vp", PERSON);
    plan.view();
    plan.detail(ids[2]!);
    expect(spy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(plan.ideaView(ids[2]!).title).toBe("Renamed");
  });

  it("reads a change written outside the plan layer, and the day it is read on", () => {
    plan.view();
    store.db.exec(`UPDATE issues SET title = 'Changed elsewhere' WHERE id = '${ids[0]}'`);
    expect(plan.ideaView(ids[0]!).title).toBe("Changed elsewhere");
    const spy = builds();
    plan.clock = () => new Date("2026-11-09T12:00:00.000Z");
    expect(plan.view().today).toBe("2026-11-09");
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

/** SQLite statements `run` executes: what a read costs on the server's one event loop. */
function statements(run: () => unknown): number {
  const spies = (["get", "all", "run", "iterate"] as const).map((method) => vi.spyOn(StatementSync.prototype, method));
  try {
    run();
    return spies.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

/**
 * A plan of `records` ideas on Next, each with breakdown rows and an adopted ticket, `extra` more
 * horizons, and on Now one ticket and one idea: what the reads below are measured over.
 */
function world(records: number, extra: number) {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  const target = new WorkspaceStore(db, "test", "TST");
  const layer = target.plan();
  layer.clock = () => new Date("2026-11-08T12:00:00.000Z");
  layer.enable("vp", { person: { via: "settings" } });
  const [now, next] = layer.view().horizons.map((h) => h.id);
  for (let at = 0; at < extra; at += 1) layer.createHorizon({ name: `Later ${at + 1}` }, "vp", PERSON);
  const ticket = target.createIssue({ title: "Ledger" });
  target.milestones().addMember(now!, ticket.identifier, {}, "vp");
  layer.capture({ title: "Invoice search", maturity: "shaped", plan: READY_PLAN, horizon: now }, "vp", PERSON);
  for (let at = 0; at < records; at += 1) {
    const id = layer.capture({ title: `Billing export ${at}`, maturity: "shaped", plan: READY_PLAN, horizon: next }, "vp", PERSON).id;
    layer.adopt(id, target.createIssue({ title: `Export task ${at}` }).identifier, "vp");
  }
  return { db, store: target, plan: layer, now: now! };
}

/** The same reads, against the same database, from a store that has derived nothing yet. */
const cold = (db: ReturnType<typeof openDb>) => new WorkspaceStore(db, "test", "TST");

describe("what the plan's accounting and hold cost", () => {
  it("adds nothing to a warm plan read, per record or per horizon", () => {
    const cost = (records: number, extra: number) => {
      const w = world(records, extra);
      w.plan.view();
      return statements(() => w.plan.view());
    };
    const base = cost(4, 0);
    expect(cost(16, 0)).toBe(base);
    // Each horizon's own reads (its members, open work, gate and queue entry), as before: none for its accounting.
    expect((cost(4, 2) - base) / 2).toBeLessThanOrEqual(16);
  });

  it("costs a pull that changed nothing a constant, whatever the plan holds", () => {
    const cost = (records: number, extra: number) => {
      const w = world(records, extra);
      rederivePlanMilestonesAfterPull(w.db, []);
      return statements(() => rederivePlanMilestonesAfterPull(w.db, []));
    };
    const base = cost(4, 0);
    expect(base).toBeLessThanOrEqual(16);
    expect(cost(16, 0)).toBe(base);
    expect(cost(4, 2)).toBe(base);
    // And it opens no mutation: nothing to journal, nothing to send.
    const w = world(4, 0);
    rederivePlanMilestonesAfterPull(w.db, []);
    const mutations = vi.spyOn(Journal.prototype, "run");
    rederivePlanMilestonesAfterPull(w.db, []);
    expect(mutations).not.toHaveBeenCalled();
    mutations.mockRestore();
  });

  it("costs a horizon's milestone view what a plain milestone's costs, and a constant more", () => {
    /** A horizon's milestone view, and a plain milestone's over as many members, each from a store that derived nothing. */
    const cost = (records: number, extra: number) => {
      const w = world(records, extra);
      const horizon = statements(() => cold(w.db).milestones().get(w.now));
      const plain = w.store.createIssue({ title: "Release train", kind: "milestone" });
      for (const title of ["Ledger mirror", "Search mirror"]) w.store.milestones().addMember(plain.identifier, w.store.createIssue({ title }).identifier, {}, "vp");
      return { horizon, plain: statements(() => cold(w.db).milestones().get(plain.id)) };
    };
    const base = cost(4, 0);
    // Whatever the queue's own read costs per record and per horizon, any milestone pays it; the plan adds none.
    const records = cost(16, 0);
    expect(records.horizon - base.horizon).toBe(records.plain - base.plain);
    const horizons = cost(4, 2);
    expect(horizons.horizon - base.horizon).toBe(horizons.plain - base.plain);
    expect(Math.abs(base.horizon - base.plain)).toBeLessThanOrEqual(25);
  });
});
