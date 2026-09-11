/**
 * The status and kind order is the same on every device; the numbers behind it need not be.
 *
 * What travels is the order — a create appended at the end, or `@order` naming every id —
 * never a `sort_order` value. So each device holds numbers of its own making: the store
 * places an entry at the midpoint of its neighbours, the applier appends at `MAX + 1000`
 * and writes an order as multiples of 1000, the seed appends after its own maximum, and
 * migration 006 put `awaiting_approval` at `in_review + 5`. Measured on a mixed fleet: the
 * absolute values differed across devices while every displayed order matched.
 *
 * That is settled by what reads them, and every reader is relative (`docs/sync.md`, "The
 * numbers behind the order are each device's own"): `ORDER BY sort_order, id` in the store,
 * the applier, the seed and the conflict screen; the store's `insertionOrder`, which takes
 * the midpoint of two neighbours on this device; the applier's and seed's `MAX(sort_order)`,
 * which means "after the last". None compares a number with another device's. This pins
 * the consequence: with the numbers deliberately different, every device shows one order,
 * places an entry added on either the same, and lands a later reorder from any of them the
 * same.
 */
import type { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-000000000163";

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function ids(db: DatabaseSync, table: "workspace_statuses" | "workspace_kinds"): string[] {
  return (db.prepare(`SELECT id FROM ${table} ORDER BY sort_order, id`).all() as Array<{ id: string }>).map((row) => row.id);
}

function numbers(db: DatabaseSync): number[] {
  return (db.prepare("SELECT sort_order FROM workspace_kinds ORDER BY sort_order, id").all() as Array<{ sort_order: number }>).map(
    (row) => row.sort_order,
  );
}

function sameOrder(machines: readonly Machine[]): void {
  const [first, ...rest] = machines;
  for (const machine of rest) {
    expect(ids(machine.db, "workspace_statuses"), machine.label).toEqual(ids(first!.db, "workspace_statuses"));
    expect(ids(machine.db, "workspace_kinds"), machine.label).toEqual(ids(first!.db, "workspace_kinds"));
    // And what every surface lists, MCP's `get_workspace_settings` included.
    machine.use();
    expect(machine.store.getStatuses().map((status) => status.id), machine.label).toEqual(ids(first!.db, "workspace_statuses"));
  }
}

describe("the status and kind order", () => {
  it("is one order everywhere, whatever numbers each device holds, through placements and a later reorder", async () => {
    fleet = new Fleet(new FakeSyncServer({ repositoryId: REPO }), REPO);
    const a = fleet.machine("a");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    // A places by midpoint and appends after its own last; B applies A's order as multiples
    // of 1000 and appends at its maximum plus 1000.
    a.store.addStatus({ id: "qa", category: "review", label: "QA", after: "in_progress" });
    a.store.addKind({ id: "research", after: "epic" });
    await a.sync();
    a.store.addKind({ id: "zeta" });
    await a.sync();
    await b.sync();
    sameOrder([a, b]);
    // The numbers are each device's own — which is the case this test is about.
    expect(numbers(b.db)).not.toEqual(numbers(a.db));

    // B places after `qa` on its numbers, then A after `todo` on its own. Same order.
    // (Two placements made concurrently are two orders, which conflict and are both kept —
    // the ordinary rule for a whole-list value, not a question of numbers.)
    b.store.addStatus({ id: "staging", category: "review", label: "Staging", after: "qa" });
    await b.sync();
    await a.sync();
    a.store.addStatus({ id: "triage", category: "unstarted", label: "Triage", after: "todo" });
    await a.sync();
    await b.sync();
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    sameOrder([a, b, fresh]);
    expect(ids(a.db, "workspace_statuses").slice(0, 6)).toEqual(["backlog", "todo", "triage", "in_progress", "qa", "staging"]);

    // A later reorder on any device lands the same everywhere.
    const reversed = [...ids(fresh.db, "workspace_statuses")].reverse();
    fresh.use();
    fresh.store.reorderStatuses(reversed);
    await fresh.sync();
    await a.sync();
    await b.sync();
    sameOrder([fresh, a, b]);
    expect(ids(a.db, "workspace_statuses")).toEqual(reversed);
  });
});
