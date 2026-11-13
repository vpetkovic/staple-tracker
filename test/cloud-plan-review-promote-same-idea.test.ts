/**
 * From the review: the SAME idea promoted on two devices offline. Promotion journals the identifier as
 * an `update` (a claim), so two promotions of one record are two claims by one entity. Does
 * every device end on one number with nothing open?
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const REPO = "5eed0000-0000-4000-8000-0000000001c9";
const PERSON = { person: { via: "plan_view" } } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function all(machines: Machine[], rounds = 3): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const machine of machines) {
      machine.use();
      await machine.sync();
    }
  }
}

const open = (m: Machine) =>
  m.db.prepare("SELECT entity_id, local_value, remote_value FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY entity_id").all().map((r) => ({ ...r }));
const everyIdentifier = (m: Machine) =>
  m.db.prepare("SELECT title, identifier FROM issues WHERE kind <> 'milestone' ORDER BY title").all().map((r) => `${(r as { title: string }).title}=${(r as { identifier: string }).identifier}`);

describe("the same idea promoted on two devices", () => {
  it("A's counter is behind B's because a third device created a ticket B has pulled", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp", { person: { via: "settings" } });
    const p = a.store.plan().capture({ title: "Same idea", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    const c = fleet.machine("c");
    await c.sync();
    c.use();
    c.store.createIssue({ title: "Ticket from C" });
    await c.sync();
    b.use();
    await b.sync();

    a.use();
    const onA = a.store.plan().promote(p, "vp", PERSON).identifier;
    b.use();
    const onB = b.store.plan().promote(p, "vp", PERSON).identifier;
    console.log("promoted as", { onA, onB });

    await all([a, b, c]);
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    const report = Object.fromEntries([a, b, c, fresh].map((m) => [m.label, { ids: everyIdentifier(m), open: open(m) }]));
    console.log(JSON.stringify(report, null, 1));
    const ideaIds = [a, b, c, fresh].map((m) => m.store.getIssue(p).identifier);
    expect(new Set(ideaIds).size).toBe(1);
    for (const m of [a, b, c, fresh]) expect(open(m)).toEqual([]);
  });

  it("both devices have the same counter, so both pick the same number", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp", { person: { via: "settings" } });
    const p = a.store.plan().capture({ title: "Same idea", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    a.use();
    a.store.plan().promote(p, "vp", PERSON);
    b.use();
    b.store.plan().promote(p, "vp", PERSON);
    await all([a, b]);
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    const report = Object.fromEntries([a, b, fresh].map((m) => [m.label, { ids: everyIdentifier(m), open: open(m) }]));
    console.log(JSON.stringify(report, null, 1));
    expect(new Set([a, b, fresh].map((m) => m.store.getIssue(p).identifier)).size).toBe(1);
    for (const m of [a, b, fresh]) expect(open(m)).toEqual([]);
  });
});
