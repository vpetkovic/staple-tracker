/**
 * From the review: B creates a ticket offline (takes TRA-4), A promotes idea p (takes TRA-4), B promotes
 * the same idea p (takes TRA-5). Ordinary offline work on two devices. Expect one number per
 * issue on every device, after any number of syncs, and nothing left open.
 */
import { afterEach, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000001d3";
const PERSON = { person: { via: "plan_view" } } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

const open = (m: Machine) =>
  m.db.prepare("SELECT entity_id, local_value, remote_value FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY entity_id").all().map((r) => ({ ...r }));
const ids = (m: Machine) =>
  m.db.prepare("SELECT title, identifier FROM issues WHERE kind <> 'milestone' ORDER BY title").all().map((r) => `${(r as { title: string }).title}=${(r as { identifier: string }).identifier}`);

for (const fold of ["service", "tail"] as const) {
  it(`converges (${fold} fold)`, async () => {
    const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp");
    const p = a.store.plan().capture({ title: "Same idea", maturity: "shaped" }, "vp", PERSON).id;
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    b.use();
    b.store.createIssue({ title: "B offline ticket" });
    a.use();
    a.store.plan().promote(p, "vp", PERSON);
    b.use();
    b.store.plan().promote(p, "vp", PERSON);

    for (let round = 0; round < 8; round += 1) {
      for (const m of [a, b]) {
        m.use();
        await m.sync();
      }
    }
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    const report = Object.fromEntries([a, b, fresh].map((m) => [m.label, { ids: ids(m), open: open(m) }]));
    console.log(fold, JSON.stringify(report));
    expect(ids(a)).toEqual(ids(fresh));
    expect(ids(b)).toEqual(ids(fresh));
    for (const m of [a, b, fresh]) expect(open(m)).toEqual([]);
  });
}
