/**
 * From the review: attacks on the promotion and derived-membership sync claims.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000001b7";
const PERSON = { person: { via: "plan_view" } } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function both(a: Machine, b: Machine, rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const machine of [a, b]) {
      machine.use();
      await machine.sync();
    }
  }
}

const openConflicts = (m: Machine) => m.db.prepare("SELECT entity, field, local_value, remote_value FROM sync_conflicts WHERE resolved_at IS NULL").all();
const members = (m: Machine, horizon: string) => m.store.milestones().get(horizon).members.map((x) => x.identifier);

describe("same idea promoted on two devices offline", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`converges on one number and opens no conflict (${fold})`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const p = a.store.plan().capture({ title: "Same idea", maturity: "shaped" }, "vp", PERSON).id;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();
      // B's counter is one ahead, so the two promotions pick different numbers.
      b.use();
      b.store.createIssue({ title: "B only" });
      a.use();
      const onA = a.store.plan().promote(p, "vp", PERSON).identifier;
      b.use();
      const onB = b.store.plan().promote(p, "vp", PERSON).identifier;
      expect(onA).not.toBe(onB);
      await both(a, b);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      const ids = [a, b, fresh].map((m) => m.store.getIssue(p).identifier);
      console.log("identifiers", ids, "conflicts", [a, b, fresh].map(openConflicts));
      expect(new Set(ids).size).toBe(1);
      for (const m of [a, b, fresh]) expect(openConflicts(m)).toEqual([]);
    });
  }
});

describe("derived membership after a pull that cancels a horizon's only work", () => {
  it("keeps the horizon on every device", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp");
    const now = a.store.plan().view().horizons[0]!.id;
    const p = a.store.plan().capture({ title: "Only work on Now", maturity: "shaped", horizon: now }, "vp", PERSON).id;
    a.store.plan().promote(p, "vp", PERSON);
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    expect(b.store.plan().view().horizons.map((h) => h.name)).toContain("Now");
    a.use();
    a.store.updateIssue(p, { status: a.store.primaryStatusFor("cancelled") }, "vp");
    await a.sync();
    b.use();
    await b.sync();
    const names = (m: Machine) => m.store.plan().view().horizons.map((h) => h.name);
    console.log("A horizons", names(a), "B horizons", names(b), "Now status", a.store.getIssue(now).status);
    expect(names(a)).toContain("Now");
    expect(names(b)).toContain("Now");
  });
});
