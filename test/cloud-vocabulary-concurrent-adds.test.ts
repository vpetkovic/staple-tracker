/**
 * WV1 (B2). Two devices add a status — and a kind — offline, then synchronize. The order is the
 * log's: every device, the two writers included, and a fresh one hold the entries in the order
 * their creates reached the log. The device whose create landed second used to keep its entry
 * where it had put it, ahead of the other's, for good — a locally chosen place surviving the
 * acknowledgement (`docs/sync.md`, "Vocabulary order").
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-0000000019c1";

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

const statuses = (machine: Machine): string[] =>
  (machine.db.prepare("SELECT id FROM workspace_statuses ORDER BY sort_order, id").all() as Array<{ id: string }>).map((row) => row.id);
const kinds = (machine: Machine): string[] =>
  (machine.db.prepare("SELECT id FROM workspace_kinds ORDER BY sort_order, id").all() as Array<{ id: string }>).map((row) => row.id);

describe("statuses and kinds two devices add offline", () => {
  for (const first of ["x1", "x2"] as const) {
    it(`are in the log's order on both writers and a fresh device (${first} reaches the log first)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO });
      fleet = new Fleet(server, REPO);
      const x1 = fleet.machine("x1");
      const x2 = fleet.machine("x2");
      await sync(x1, x2);
      x1.use();
      x1.store.addStatus({ id: "s_a", category: "review", label: "A" }, "x1");
      x1.store.addKind({ id: "k_a", label: "KA" }, "x1");
      x2.use();
      x2.store.addStatus({ id: "s_b", category: "review", label: "B" }, "x2");
      x2.store.addKind({ id: "k_b", label: "KB" }, "x2");
      const [lead, follow] = first === "x1" ? [x1, x2] : [x2, x1];
      await sync(lead, follow, lead, follow);
      const fresh = fleet.machine("fresh");
      await sync(fresh);

      const [early, late] = first === "x1" ? ["a", "b"] : ["b", "a"];
      for (const machine of [x1, x2, fresh]) {
        expect(statuses(machine).slice(-2), `${machine.label} statuses`).toEqual([`s_${early}`, `s_${late}`]);
        expect(kinds(machine).slice(-2), `${machine.label} kinds`).toEqual([`k_${early}`, `k_${late}`]);
      }
      const want = stateOf(fresh.db);
      expect([x1, x2].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
    }, 60_000);
  }
});
