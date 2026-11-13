/**
 * The delivered-outside-the-tracker mark across devices (design/plan.md, "Delivered outside the
 * tracker"): the day travels as the `planDeliveredOn` issue field and the note as the
 * `delivered-note` document, so a tail device and a freshly hydrated one read the same shipped
 * record, under both folds, and a clear reaches them the same way.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const REPO = "5eed0000-0000-4000-8000-0000000001d5";
const PERSON = { person: { via: "plan_view" } } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

/** What a device reads of the record: its state, its mark and the horizon's shipped count. */
function readOf(machine: Machine, id: string): unknown {
  machine.use();
  const plan = machine.store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  const view = plan.ideaView(id);
  return {
    state: view.state,
    stage: view.stage,
    identifier: view.identifier,
    delivered: view.delivered,
    late: view.late,
    actualEnd: view.actual.end,
    actions: view.actions.map((action) => action.id),
    shipped: plan.view().horizons.find((h) => h.id === view.horizonId)?.shippedCount ?? null,
    members: machine.db.prepare("SELECT COUNT(*) AS n FROM plan_members WHERE issue_id = ?").get(id),
  };
}

describe("a mark delivered outside the tracker across devices", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`reads shipped with its day and note on a tail device and a fresh one, and clears on both (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      const plan = a.store.plan();
      plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
      plan.enable("vp", { person: { via: "settings" } });
      const now = plan.view().horizons[0]!.id;
      const id = plan.capture({ title: "Billing export", maturity: "shaped", plan: READY_PLAN, horizon: now, plannedTarget: "2026-10-01" }, "vp", PERSON).id;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      plan.update(id, { delivered: { on: "2026-10-05", note: "Shipped by the platform team." } }, "vp", PERSON);
      await a.sync();
      await b.sync();
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      const marked = readOf(a, id);
      expect(marked).toMatchObject({
        state: "shipped",
        identifier: null,
        delivered: { on: "2026-10-05", note: "Shipped by the platform team." },
        late: true,
        actualEnd: "2026-10-05",
        shipped: 1,
        members: { n: 0 },
      });
      expect(readOf(b, id), "tail").toEqual(marked);
      expect(readOf(fresh, id), "fresh").toEqual(marked);

      a.use();
      plan.update(id, { delivered: null }, "vp", PERSON);
      await a.sync();
      await b.sync();
      const later = fleet.machine("later");
      await later.sync();
      const cleared = readOf(a, id);
      expect(cleared).toMatchObject({ state: "shaped", delivered: null, shipped: 0 });
      expect(readOf(b, id), "tail").toEqual(cleared);
      expect(readOf(later, id), "fresh").toEqual(cleared);
    });
  }
});
