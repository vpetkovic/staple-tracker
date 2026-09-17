/**
 * A resolution of a plan or a milestone's members keeps who added each entry, and when, on every
 * device (`docs/sync.md`, "Conflicts are preserved, never resolved silently").
 *
 * A device with its own record open about the same list withholds the resolving `replace` from
 * the list, and closes its record by the decision that follows. That decision carried the list and
 * nothing about its entries, so the device wrote the resolver as the author of every entry, at the
 * moment of the decision — while a fresh device held each entry's own author and time.
 */
import { afterEach, describe, expect, it } from "vitest";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { differences, stateOf } from "./fixtures/synchronized-state.js";

const REPO = "5eed0000-0000-4000-8000-00000000d1e0";

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

const open = (machine: Machine) =>
  listConflicts(machine.db).filter((conflict) => conflict.resolvedAt === null && (conflict.field === "order" || conflict.field === "members"));

describe("a list resolved on one device while another holds its own record about it", () => {
  for (const what of ["queue", "milestone"] as const) {
    for (const choice of ["remote", "local", "custom"] as const) {
      it(`keeps each entry's author and time everywhere (${what}, ${choice})`, async () => {
        const server = new FakeSyncServer({ repositoryId: REPO });
        fleet = new Fleet(server, REPO);
        const a = fleet.machine("a");
        a.store.addKind({ id: "milestone", label: "Milestone" }, "a");
        const [x, y, z, w] = ["X", "Y", "Z", "W"].map((title) => a.store.createIssue({ title }));
        a.store.milestones().create({ title: "M", targetDate: "2026-12-01" }, "a");
        const m = (a.db.prepare("SELECT issue_id FROM milestone_meta").get() as { issue_id: string }).issue_id;
        await a.sync();
        const b = fleet.machine("b");
        const c = fleet.machine("c");
        await sync(b, c);

        // Three devices each put their own issue in the list, offline.
        const add = (machine: Machine, issue: string): void => {
          machine.use();
          if (what === "queue") machine.store.queue().enqueue(issue, {}, machine.label);
          else machine.store.milestones().addMember(m, issue, {}, machine.label);
        };
        add(a, x!.id);
        add(b, y!.id);
        add(c, z!.id);
        await sync(b, a, c);
        expect(open(a)).toHaveLength(1);
        expect(open(c).length).toBeGreaterThan(0);

        a.use();
        // A custom list keeps both sides' entries and adds W, which nobody had put in it.
        const custom = choice === "custom" ? { value: [x!.id, y!.id, w!.id] } : {};
        resolveConflict(a.db, { id: open(a)[0]!.id, choice, actor: "person", ...custom });
        await sync(a, c, b, a, c);
        const fresh = fleet.machine("fresh");
        await sync(fresh);

        const want = stateOf(fresh.db);
        expect([a, b, c].flatMap((machine) => differences(machine.label, want, stateOf(machine.db)))).toEqual([]);
        const table = what === "queue" ? "queue_entries" : "milestone_members";
        const authors = fresh.db.prepare(`SELECT added_by FROM ${table}`).all() as Array<{ added_by: string }>;
        expect(authors.length).toBeGreaterThan(0);
        // Nobody added an entry by deciding between two lists; W is the resolver's, by adding it.
        expect(authors.map((row) => row.added_by).filter((author) => author === "person")).toHaveLength(choice === "custom" ? 1 : 0);
      }, 60_000);
    }
  }
});
