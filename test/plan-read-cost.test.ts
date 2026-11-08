/**
 * What a plan read costs (design/plan.md, "Reads"). The page's server answers every plan write
 * with the whole plan and the record's detail, on its one event loop; a read that grows with the
 * plan and repeats per request stalls every other request. So a record's documents are read by
 * id in one statement each, never by resolving a reference, and the plan's views are derived once
 * per state of the database: a request that checks a state, writes and answers rebuilds them
 * once for the write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
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
  plan.enable("vp");
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
