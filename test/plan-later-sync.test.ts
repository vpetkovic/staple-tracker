import { afterEach, expect, it, vi } from "vitest";
import { PlanStore } from "../src/core/plan-store.js";
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
  plan.enable("Mira", { person: { via: "settings" } });
  const later = plan.createHorizon({ name: "Later" }, "Mira", person);
  const idea = plan.capture({ title: "Merchant checkout", maturity: "shaped", plan: READY_PLAN, horizon: later.id }, "Mira", person);
  const task = a.store.createIssue({ title: "Take payment" });
  plan.adopt(idea.id, task.id, "worker");
  const hand = a.store.createIssue({ title: "Hand placed" });
  a.store.milestones().addMember(later.id, hand.id, {}, "Mira");
  // Simulate the old build publishing its Later column before this upgrade exists.
  const oldBuild = vi.spyOn(PlanStore.prototype, "migrateLegacyLater").mockImplementation(() => {});
  await a.sync();
  const b = fleet.machine("b");
  await b.sync();
  oldBuild.mockRestore();
  expect(b.store.plan().view().horizons.some(h => h.id === later.id)).toBe(true);
  a.use();
  const previousDevice = process.env.STAPLE_DEVICE_ID;
  process.env.STAPLE_DEVICE_ID = a.deviceId;
  try { const opened = openWorkspace(a.dbPath); opened.store.db.close(); }
  finally { if (previousDevice) process.env.STAPLE_DEVICE_ID = previousDevice; else delete process.env.STAPLE_DEVICE_ID; }
  expect(a.store.plan().view().horizons.some(h => h.id === later.id)).toBe(false);
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
