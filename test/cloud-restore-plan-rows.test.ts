/**
 * A restore rewinds an idea's task breakdown row by row (design/plan.md, "Task breakdown rows";
 * design/sync.md, "A restore rewinds"). A row added after the backup is gone from every device
 * once the restore is read, unless the device that holds it has not sent it yet: then its own
 * unsent row stays and reaches everyone. Every device ends where a fresh one does.
 */
import { afterEach, describe, expect, it } from "vitest";
import { createBackup, restoreFromBackup, setBackupConsent } from "../src/core/cloud/backup.js";
import type { PlanPatch } from "../src/core/plan-sections.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-00000000f10b";
const PERSON = { person: { via: "plan_view" } } as const;
const PLAN: PlanPatch = { goal: "G", acceptance: ["x"], breakdown: [{ key: "1", title: "Kept", acceptance: "a" }] };

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function sync(...machines: Machine[]): Promise<void> {
  for (const machine of machines) {
    machine.use();
    await machine.sync();
  }
}

const keys = (machine: Machine, idea: string): string[] => {
  machine.use();
  return machine.store
    .plan()
    .detail(idea)
    .plan.breakdown.map((row) => row.key);
};

function addRow(machine: Machine, idea: string, key: string): void {
  machine.use();
  const plan = machine.store.plan();
  plan.update(idea, { plan: { breakdown: [...plan.detail(idea).plan.breakdown, { key, title: `Row ${key}` }] } }, machine.label);
}

describe("a restore of an idea's breakdown", () => {
  for (const unsent of [false, true]) {
    it(`${unsent ? "keeps an unsent" : "rewinds a pushed"} row added after the backup`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      const idea = a.store.plan().capture({ title: "Idea", maturity: "shaped", plan: PLAN }, "vp", PERSON).id;
      await a.sync();
      const b = fleet.machine("b");
      await sync(b);

      a.use();
      await setBackupConsent(a.home, REPO, true, { fetchImpl: server.fetch });
      const backup = await createBackup(a.home, REPO, null, { fetchImpl: server.fetch });
      addRow(a, idea, "2");
      await sync(a, b);
      expect(keys(b, idea)).toEqual(["1", "2"]);
      if (unsent) addRow(b, idea, "3");

      a.use();
      await restoreFromBackup(a.db, a.home, REPO, backup.backupId, { fetchImpl: server.fetch });
      await sync(a, b, a, b);
      const fresh = fleet.machine("fresh");
      await sync(fresh);

      const want = unsent ? ["1", "3"] : ["1"];
      for (const machine of [a, b, fresh]) expect(keys(machine, idea), machine.label).toEqual(want);
    }, 60_000);
  }
});
