/**
 * Idea numbers across devices (design/plan.md, "Idea numbers"). An idea holds its number as its
 * identifier, so two devices that capture offline settle like two that create tickets offline:
 * the earlier claim in the log keeps the number, the later device renumbers its own from the
 * idea counter, and nothing is left open. A promoted idea keeps its number in a synced field, so
 * a device that receives the promotion, or hydrates long after it, reads and resolves the same
 * number, and never hands it out again.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";
import { Hub } from "../src/core/hub.js";

const REPO = "5eed0000-0000-4000-8000-0000000001e4";
const PERSON = { person: { via: "plan_view" } } as const;
const FOLDS = ["service", "tail"] as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

async function rounds(machines: Machine[], count = 4): Promise<void> {
  for (let round = 0; round < count; round += 1) {
    for (const machine of machines) {
      machine.use();
      await machine.sync();
    }
  }
}

const open = (m: Machine): unknown[] => m.db.prepare("SELECT entity, field FROM sync_conflicts WHERE resolved_at IS NULL").all().map((r) => ({ ...r }));

/** Every plan record as title=identifier/kept number, in title order. */
const ideas = (m: Machine): string[] =>
  (m.db.prepare("SELECT title, identifier, plan_idea_number FROM issues WHERE plan_maturity IS NOT NULL ORDER BY title").all() as Array<{ title: string; identifier: string; plan_idea_number: string | null }>).map(
    (r) => `${r.title}=${r.identifier}/${r.plan_idea_number ?? "-"}`,
  );

function setup(fold: (typeof FOLDS)[number]): Fleet {
  const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
  fleet = new Fleet(server, REPO);
  return fleet;
}

describe("two devices capture ideas offline", () => {
  for (const fold of FOLDS) {
    it(`end on distinct numbers, the same on every device and on one that hydrates, with nothing open (${fold} fold)`, async () => {
      const fleet = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      const onA = a.store.plan().capture({ title: "A's idea" }, "agent");
      b.use();
      const onB = b.store.plan().capture({ title: "B's idea" }, "agent");
      const onB2 = b.store.plan().capture({ title: "B's second idea" }, "agent");
      // Neither has heard of the other: both minted I-TRA-1.
      expect(a.store.getIssue(onA.id).identifier).toBe("I-TRA-1");
      expect(b.store.getIssue(onB.id).identifier).toBe("I-TRA-1");
      const ticketCounter = (m: Machine) => (m.db.prepare("SELECT value FROM meta WHERE key = 'next_issue_number'").get() as { value: string } | undefined)?.value;
      const ticketsBefore = [ticketCounter(a), ticketCounter(b)];

      await rounds([a, b], 6);
      // Settling an idea's number takes the next idea number, never a ticket's.
      expect([ticketCounter(a), ticketCounter(b)]).toEqual(ticketsBefore);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const m of [a, b, fresh]) {
        m.use();
        expect(ideas(m)).toEqual(ideas(a));
        const live = (m.db.prepare("SELECT identifier FROM issues WHERE kind = 'idea'").all() as Array<{ identifier: string }>).map((r) => r.identifier);
        expect(new Set(live).size).toBe(3);
        for (const number of live) expect(number).toMatch(/^I-TRA-\d+$/);
        expect(open(m)).toEqual([]);
      }
      // Every device hands out a number past all of them.
      for (const m of [a, b, fresh]) {
        m.use();
        const next = m.store.plan().capture({ title: `After, on ${m.db === a.db ? "a" : m.db === b.db ? "b" : "fresh"}` }, "agent");
        expect(Number(m.store.getIssue(next.id).identifier.split("-")[2])).toBeGreaterThan(3);
      }
      void onB2;
    });
  }
});

describe("a promoted idea on another device", () => {
  for (const fold of FOLDS) {
    it(`keeps its number beside the ticket number, resolves by it, and the number is never handed out again (${fold} fold)`, async () => {
      const fleet = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      const first = a.store.plan().capture({ title: "Promote me", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
      a.store.plan().capture({ title: "Stays an idea" }, "vp", PERSON);
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      const promoted = a.store.plan().promote(first, "vp", PERSON);
      expect(promoted.identifier).toMatch(/^TRA-\d+$/);
      expect(promoted.number).toBe("I-TRA-1");
      await rounds([a, b], 2);
      // A device that joins after the promotion holds no alias for I-TRA-1: only the kept number.
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const m of [a, b, fresh]) {
        m.use();
        const issue = m.store.getIssue("I-TRA-1");
        expect(issue.id).toBe(first);
        expect(issue.identifier).toBe(promoted.identifier);
        expect(issue.ideaNumber).toBe("I-TRA-1");
        expect(m.store.plan().ideaView(first)).toMatchObject({ identifier: promoted.identifier, number: "I-TRA-1", promoted: true });
        expect(open(m)).toEqual([]);
      }
      fresh.use();
      expect(fresh.db.prepare("SELECT 1 FROM meta WHERE key = 'identifier_alias:I-TRA-1'").get()).toBeUndefined();
      // A search for the number finds the epic it became.
      expect(fresh.store.listIssues({ q: "i-tra-1" }).map((issue) => issue.id)).toContain(first);
      // The hub names the workspace by the number's prefix, and the workspace resolves the rest.
      const hub = Hub.openAt(fresh.home);
      try {
        const resolved = hub.resolveIdentifier("i-tra-1");
        expect(resolved.identifier).toBe("I-TRA-1");
        expect(resolved.entry.prefix).toBe("TRA");
        expect(hub.resolveIdentifier("I-TRA-2+7").identifier).toBe("I-TRA-2+7");
        expect(() => hub.resolveIdentifier("I-TRA-2+x")).toThrow(/not an identifier/);
        expect(() => hub.resolveIdentifier("I-NOPE-1")).toThrow(/No workspace with prefix NOPE/);
      } finally {
        hub.close();
      }
      // Nobody hands I-TRA-1 or I-TRA-2 out again, though no idea holds I-TRA-1 as its identifier any more.
      expect(fresh.store.getIssue(fresh.store.plan().capture({ title: "Fresh capture" }, "agent").id).identifier).toBe("I-TRA-3");
    });
  }
});
