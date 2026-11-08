/**
 * One idea promoted on two devices that have not heard from each other (design/plan.md, "Ticket
 * numbers"). Both promotions write the identifier of the same record, so the record ends on one
 * number on every device, a device that hydrates later reads the same number, no number names
 * two records anywhere, and nothing is left open for a person.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";

const REPO = "5eed0000-0000-4000-8000-0000000001d3";
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

const open = (m: Machine): unknown[] =>
  m.db.prepare("SELECT entity, entity_id, field, local_value, remote_value FROM sync_conflicts WHERE resolved_at IS NULL ORDER BY entity_id").all().map((r) => ({ ...r }));

/** Every issue outside the plan's columns, as title=identifier, in title order. */
const numbers = (m: Machine): string[] =>
  (m.db.prepare("SELECT title, identifier FROM issues WHERE kind <> 'milestone' ORDER BY title").all() as Array<{ title: string; identifier: string }>).map(
    (r) => `${r.title}=${r.identifier}`,
  );

function expectOneNumberingEverywhere(machines: Machine[]): void {
  const [first, ...rest] = machines;
  for (const m of rest) expect(numbers(m)).toEqual(numbers(first!));
  for (const m of machines) {
    const live = numbers(m).map((entry) => entry.split("=")[1]!);
    expect(new Set(live).size).toBe(live.length);
    for (const identifier of live) expect(identifier).toMatch(/^[A-Z]+-\d+$/);
    expect(open(m)).toEqual([]);
  }
}

function setup(fold: (typeof FOLDS)[number]): { server: FakeSyncServer; fleet: Fleet } {
  const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
  fleet = new Fleet(server, REPO);
  return { server, fleet };
}

describe("one idea promoted on two devices offline", () => {
  for (const fold of FOLDS) {
    it(`ends on one number when one device also made a ticket offline (${fold} fold)`, async () => {
      const { server, fleet } = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const p = a.store.plan().capture({ title: "Same idea", maturity: "shaped" }, "vp", PERSON).id;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      b.use();
      b.store.createIssue({ title: "B offline ticket" });
      a.use();
      const onA = a.store.plan().promote(p, "vp", PERSON).identifier;
      b.use();
      const onB = b.store.plan().promote(p, "vp", PERSON).identifier;
      // B's ticket took the number A's promotion took, so B's promotion took the next one.
      expect(onA).not.toBe(onB);

      await rounds([a, b], 8);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expectOneNumberingEverywhere([a, b, fresh]);
      // The promotion that lost displaced nobody: B's ticket keeps the number it was made with,
      // and no device had to renumber anything.
      expect(numbers(fresh)).toEqual([`B offline ticket=${onA}`, `Same idea=${onB}`]);
      expect(server.ops.filter((op) => op.verb === "renumber")).toEqual([]);
      // The counter is clear of every number everywhere.
      for (const m of [a, b]) {
        m.use();
        const next = m.store.createIssue({ title: `Next on ${m.label}` }).identifier;
        expect(numbers(m).filter((entry) => entry.endsWith(`=${next}`))).toHaveLength(1);
      }
    });

    it(`ends on one number when a third device moved one counter ahead (${fold} fold)`, async () => {
      const { fleet } = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const p = a.store.plan().capture({ title: "Same idea", maturity: "shaped" }, "vp", PERSON).id;
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
      expect(onA).not.toBe(onB);

      await rounds([a, b, c]);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expectOneNumberingEverywhere([a, b, c, fresh]);
    });

    it(`ends on one number when both devices took the same one (${fold} fold)`, async () => {
      const { fleet } = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const p = a.store.plan().capture({ title: "Same idea", maturity: "shaped" }, "vp", PERSON).id;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();
      a.use();
      const onA = a.store.plan().promote(p, "vp", PERSON).identifier;
      b.use();
      const onB = b.store.plan().promote(p, "vp", PERSON).identifier;
      expect(onA).toBe(onB);
      await rounds([a, b]);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expectOneNumberingEverywhere([a, b, fresh]);
    });

    it(`ends on one number whichever device sends first (${fold} fold)`, async () => {
      const { fleet } = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const p = a.store.plan().capture({ title: "Same idea", maturity: "shaped" }, "vp", PERSON).id;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      b.use();
      b.store.createIssue({ title: "B offline ticket" });
      b.store.plan().promote(p, "vp", PERSON);
      a.use();
      a.store.plan().promote(p, "vp", PERSON);
      // B's ticket and later promotion reach the log before A's promotion.
      await rounds([b, a], 8);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expectOneNumberingEverywhere([a, b, fresh]);
    });
  }
});
