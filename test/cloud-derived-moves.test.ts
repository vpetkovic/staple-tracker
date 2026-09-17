/**
 * What a status move writes, it writes on every device — a derived move of an ancestor, a
 * gate and a checkout included.
 *
 * A child moved into review moves its epic into review too (a derived rung), and the store
 * wrote the epic's status, `status_version`, `updated_at` and timestamps in one row update
 * but journaled only `{ status, derived }`. Measured on real data: two epics whose
 * `status_version` and `updated_at` differed between the device that moved the child and
 * every other device, although `docs/sync.md` lists both as synchronized. Every
 * status-moving write now journals the columns it changed.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000172";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function row(db: DatabaseSync, id: string): unknown {
  return db
    .prepare(
      `SELECT status, status_version, updated_at, started_at, completed_at, cancelled_at, checkout_agent, checkout_at,
              gate_state, gate_owner, gate_requested_at, gate_resolved_at
         FROM issues WHERE id = ?`,
    )
    .get(id);
}

function same(machines: readonly Machine[], ids: readonly string[]): void {
  const [first, ...rest] = machines;
  for (const machine of rest) {
    for (const id of ids) expect(row(machine.db, id), `${machine.label} ${id}`).toEqual(row(first!.db, id));
  }
}

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 3));

describe("a status move", () => {
  it("writes the same columns on every device, a derived move of an ancestor included", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    const epic = a.store.createIssue({ title: "The epic", kind: "epic" });
    const child = a.store.createIssue({ title: "Its child", parent: epic.identifier });
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    await tick();
    b.use();
    b.store.updateIssue(child.id, { status: "in_review" }, "agent-b");
    expect((row(b.db, epic.id) as { status: string }).status).toBe("in_review");
    await b.sync();
    await a.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    same([b, a, fresh], [epic.id, child.id]);

    // A checkout, a gate and its approval move a status too.
    await tick();
    a.use();
    const other = a.store.createIssue({ title: "Checked out" });
    a.store.checkoutIssue(other.id, "agent-a");
    await tick();
    a.store.gateIssue(epic.id, { owner: "VP" }, "agent-a");
    await a.sync();
    await b.sync();
    await fresh.sync();
    same([a, b, fresh], [epic.id, child.id, other.id]);
    await tick();
    a.store.approveGate(epic.id, {}, "VP");
    await a.sync();
    await b.sync();
    await fresh.sync();
    same([a, b, fresh], [epic.id, child.id, other.id]);
  });
});
