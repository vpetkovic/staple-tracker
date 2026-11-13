/**
 * Plan steps are derived on each device, never sent (design/plan.md, "Plan steps"). Two devices
 * that change the facts under the steps offline, and a third that hydrates afterwards, read the
 * same steps once they have synced; reading them writes nothing to the outbox.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const REPO = "5eed0000-0000-4000-8000-0000000001c7";
const PERSON = { person: { via: "plan_view" } } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function both(a: Machine, b: Machine, rounds = 2): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const machine of [a, b]) {
      machine.use();
      await machine.sync();
    }
  }
}

const outbox = (machine: Machine): number => (machine.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n;

/** A horizon's steps as this device derives them on one fixed day, through every reader. */
function stepsOn(machine: Machine, horizonId: string) {
  machine.use();
  const plan = machine.store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  const before = outbox(machine);
  const fromPlan = plan.view().horizons.find((h) => h.id === horizonId)!.planSteps;
  expect(machine.store.milestones().get(horizonId).planSteps).toEqual(fromPlan);
  expect(plan.pickupPlanSteps({ scope: horizonId, next: null })).toEqual(fromPlan);
  // Reading them sends nothing.
  expect(outbox(machine)).toBe(before);
  return fromPlan.map((step) => [step.title, step.need, step.who, step.questions ?? null, step.waitingOn ?? null]);
}

describe("a horizon's plan steps across devices", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`read the same on two devices and a freshly hydrated one after offline changes on each (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      const plan = a.store.plan();
      plan.enable("vp", { person: { via: "settings" } });
      const now = plan.view().horizons[0]!.id;
      const checkout = plan.capture({ title: "Checkout API", maturity: "exploring", horizon: now }, "vp", PERSON).id;
      plan.addQuestion(checkout, "Which payment provider?", "agent");
      plan.addQuestion(checkout, "Do refunds need approval?", "agent");
      plan.capture({ title: "Invoice search", maturity: "shaped", horizon: now, plan: READY_PLAN }, "vp", PERSON);
      const audit = plan.capture({ title: "Audit trail", maturity: "shaped", horizon: now, plan: READY_PLAN, plannedStart: "2026-12-01" }, "vp", PERSON).id;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();
      expect(stepsOn(b, now)).toEqual(stepsOn(a, now));

      // Offline: B records an answer to one question, A releases the waiting idea early.
      b.use();
      b.store.plan().resolveQuestion(checkout, 1, "agent-b");
      a.use();
      a.store.plan().update(audit, { plannedStart: "2026-11-01" }, "vp", PERSON);
      await both(a, b);
      const fresh = fleet.machine("fresh");
      await fresh.sync();

      const expected = [
        ["Checkout API", "answer_questions", "person", ["Do refunds need approval?"], null],
        ["Invoice search", "scaffold", "agent", null, null],
        ["Audit trail", "scaffold", "agent", null, null],
      ];
      for (const machine of [a, b, fresh]) expect(stepsOn(machine, now)).toEqual(expected);
      // Nothing about them is stored: the issue rows carry no step column.
      const columns = (a.db.prepare("PRAGMA table_info(issues)").all() as Array<{ name: string }>).map((column) => column.name);
      expect(columns.filter((name) => /step/i.test(name))).toEqual([]);
    });
  }
});
