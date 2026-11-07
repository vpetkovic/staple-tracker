/**
 * The plan layer synchronizes as fields of the `issue` entity (design/plan.md, "Storage"):
 * no new entity, so no protocol change. One machine plans, another pulls the tail, a third
 * hydrates from the snapshot, and all three read the same plan.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000001a2";
const PERSON = { person: { via: "plan_view" } } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function planOf(machine: Machine): unknown {
  const plan = machine.store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  const view = plan.view();
  return {
    enabled: view.enabled,
    horizons: view.horizons.map((h) => [h.identifier, h.name, h.date, h.rank]),
    ideas: view.ideas.map((i) => ({
      identifier: i.identifier,
      maturity: i.maturity,
      stage: i.stage,
      horizon: view.horizons.find((h) => h.id === i.horizonId)?.identifier ?? null,
      parent: view.ideas.find((p) => p.id === i.parentId)?.identifier ?? null,
      planned: i.planned,
      baseline: i.baseline,
      links: i.links.map((id) => machine.store.getIssue(id).identifier),
    })),
  };
}

describe("links merge across devices: one field per link", () => {
  async function both(a: Machine, b: Machine): Promise<void> {
    for (let round = 0; round < 2; round += 1) {
      for (const machine of [a, b]) {
        machine.use();
        await machine.sync();
      }
    }
  }
  const linked = (machine: Machine, idea: string): string[] =>
    machine.store
      .plan()
      .ideaView(idea)
      .links.map((id) => machine.store.getIssue(id).identifier)
      .sort();
  const conflicts = (machine: Machine): unknown[] => machine.db.prepare("SELECT field FROM sync_conflicts WHERE resolved_at IS NULL").all();

  for (const fold of ["service", "tail"] as const) {
    it(`keeps both of two adopts made offline on two devices (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const idea = a.store.plan().capture({ title: "Idea", maturity: "shaped" }, "vp", PERSON).identifier;
      const x = a.store.createIssue({ title: "Epic X", kind: "epic" }).identifier;
      const y = a.store.createIssue({ title: "Epic Y", kind: "epic" }).identifier;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      a.store.plan().adopt(idea, x, "agent-a");
      b.use();
      b.store.plan().adopt(idea, y, "agent-b");
      await both(a, b);

      expect(linked(a, idea)).toEqual([x, y].sort());
      expect(linked(b, idea)).toEqual([x, y].sort());
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expect(linked(fresh, idea)).toEqual([x, y].sort());
    });
  }

  it("converges when one device unlinks while another adopts", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp");
    const idea = a.store.plan().capture({ title: "Idea", maturity: "shaped" }, "vp", PERSON).identifier;
    const x = a.store.createIssue({ title: "Epic X", kind: "epic" }).identifier;
    const y = a.store.createIssue({ title: "Epic Y", kind: "epic" }).identifier;
    a.store.plan().adopt(idea, x, "vp");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    a.use();
    a.store.plan().unlink(idea, x, "agent-a");
    b.use();
    b.store.plan().adopt(idea, y, "agent-b");
    await both(a, b);

    expect(linked(a, idea)).toEqual([y]);
    expect(linked(b, idea)).toEqual([y]);
    expect(conflicts(a)).toEqual([]);
    expect(conflicts(b)).toEqual([]);
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    expect(linked(fresh, idea)).toEqual([y]);
  });
});

describe("the plan synchronizes with no new entity", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`reads the same on every device (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      const plan = a.store.plan();
      plan.enable("vp");
      const now = plan.view().horizons[0]!;
      const ga = plan.capture({ title: "Exercise GA", maturity: "shaped", horizon: now.id, plannedStart: "2026-10-01", plannedTarget: "2026-12-31" }, "vp", PERSON);
      plan.capture({ title: "R8 Mobile", parent: ga.identifier, maturity: "exploring" }, "vp", PERSON);
      const epic = a.store.createIssue({ title: "EPIC-40", kind: "epic" });
      plan.adopt(ga.identifier, epic.identifier, "agent");
      plan.update(ga.identifier, { plannedTarget: "2027-01-31" }, "vp", PERSON);
      plan.createHorizon({ name: "MVP", date: "2026-12-31" }, "vp", PERSON);
      await a.sync();

      const b = fleet.machine("b");
      await b.sync();
      expect(planOf(b)).toEqual(planOf(a));

      b.use();
      b.store.plan().update(ga.identifier, { maturity: "exploring" }, "vp", PERSON);
      await b.sync();
      a.use();
      await a.sync();
      expect(planOf(a)).toEqual(planOf(b));

      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expect(planOf(fresh)).toEqual(planOf(a));
      const shown = planOf(fresh) as { ideas: Array<{ identifier: string; baseline: unknown; planned: unknown }> };
      const gaFresh = shown.ideas.find((i) => i.identifier === ga.identifier)!;
      expect(gaFresh.baseline).toEqual({ start: "2026-10-01", target: "2026-12-31" });
      expect(gaFresh.planned).toEqual({ start: "2026-10-01", target: "2027-01-31" });
    });
  }
});
