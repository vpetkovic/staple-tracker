import { afterEach, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";
import { openWorkspace } from "../src/core/open.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";
let fleet: Fleet | undefined;
afterEach(() => { fleet?.close(); fleet = undefined; });

it("upgrades Later on open and synchronizes Unscheduled ideas and retained hand membership to tail and snapshot", async () => {
  const repo = "5eed0000-0000-4000-8000-0000000007a2";
  fleet = new Fleet(new FakeSyncServer({ repositoryId: repo }), repo);
  const a = fleet.machine("a");
  const person = { person: { via: "plan_view" } } as const;
  const plan = a.store.plan();
  plan.enable("Mira");
  const later = plan.createHorizon({ name: "Later" }, "Mira", person);
  const idea = plan.capture({ title: "Merchant checkout", maturity: "shaped", plan: READY_PLAN, horizon: later.id }, "Mira", person);
  const task = a.store.createIssue({ title: "Take payment" });
  plan.adopt(idea.id, task.id, "worker");
  const hand = a.store.createIssue({ title: "Hand placed" });
  a.store.milestones().addMember(later.id, hand.id, {}, "Mira");
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  a.use();
  const opened = openWorkspace(a.dbPath);
  opened.store.db.close();
  await a.sync();
  await b.sync();
  const fresh = fleet.machine("snapshot");
  await fresh.sync();
  for (const machine of [a, b, fresh]) {
    expect(machine.store.plan().view().horizons.some(h => h.id === later.id), machine.label).toBe(false);
    expect(machine.store.plan().detail(idea.id).idea.horizonId, machine.label).toBeNull();
    expect(machine.store.milestones().get(later.id).members.map(m => m.issueId), machine.label).toEqual([hand.id]);
    expect(machine.db.prepare("SELECT * FROM sync_conflicts WHERE resolved_at IS NULL").all(), machine.label).toEqual([]);
  }
});
