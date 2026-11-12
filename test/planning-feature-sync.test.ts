import { expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet } from "./fixtures/sync-machines.js";
it("the person flag reaches another device and changes its plan writes without deleting ideas", async () => {
  const repo = "5eed0000-0000-4000-8000-000000000462";
  const fleet = new Fleet(new FakeSyncServer({ repositoryId: repo }), repo);
  try {
    const a = fleet.machine("a");
    a.store.setSetting("features.planning", true, "Larkspur owner", { via: "settings" });
    const idea = a.store.plan().capture({ title: "Larkspur launch" }, "worker");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    expect(b.store.planningOn()).toBe(true);
    expect(b.store.plan().view().ideas.map(i => i.id)).toContain(idea.id);
    a.use();
    a.store.setSetting("features.planning", false, "Larkspur owner", { via: "settings" });
    await a.sync(); await b.sync();
    expect(b.store.getSetting("features.planning")).toBe(false);
    expect(b.store.planningOn()).toBe(false);
    expect(() => b.store.plan().capture({ title: "Hidden" }, "worker")).toThrow(/Planning is off/);
    expect(b.store.listIssues({ includeResolved: true }).some(i => i.id === idea.id)).toBe(false);
    expect(b.store.getIssue(idea.id).identifier).toMatch(/^~/);
    a.use();
    a.store.setSetting("features.planning", true, "Larkspur owner", { via: "settings" });
    await a.sync(); await b.sync();
    expect(b.store.plan().view().ideas.map(i => i.id)).toContain(idea.id);
  } finally { fleet.close(); }
});

for (const legacyFold of [false, true]) it(`concurrent first enable converges to Now and Next in fold mode ${legacyFold}`, async () => {
  const repo = "5eed0000-0000-4000-8000-000000000031";
  const server = new FakeSyncServer({ repositoryId: repo }); server.legacyFold = legacyFold;
  const fleet = new Fleet(server, repo);
  try {
    const a = fleet.machine("a"); a.store.createIssue({ title: "Larkspur seed" }); await a.sync();
    const b = fleet.machine("b"); await b.sync();
    a.use(); a.store.createIssue({ title: "Larkspur offline task" });
    b.use(); b.store.setSetting("features.planning", true, "Mira", { via: "settings" });
    a.use(); a.store.setSetting("features.planning", true, "Mira", { via: "settings" });
    await a.sync(); await b.sync(); await a.sync();
    for (const machine of [a, b]) {
      machine.use(); expect(machine.store.plan().view().horizons.map(h => h.name)).toEqual(["Now", "Next"]);
      expect(machine.store.plan().view().horizons.map(h => h.id)).toEqual(a.store.plan().view().horizons.map(h => h.id));
    }
    const c = fleet.machine("c"); await c.sync(); expect(c.store.plan().view().horizons.map(h => h.name)).toEqual(["Now", "Next"]);
  } finally { fleet.close(); }
});
