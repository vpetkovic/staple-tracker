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
import { join } from "node:path";
import { Hub } from "../src/core/hub.js";
import { openWorkspace } from "../src/core/open.js";

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

/** One idea number names one record on every device, held as an identifier or kept by a promoted one. */
function expectEachNumberOnce(m: Machine): void {
  const held = (m.db.prepare("SELECT identifier AS n FROM issues WHERE identifier GLOB 'I-*' UNION ALL SELECT plan_idea_number AS n FROM issues WHERE plan_idea_number IS NOT NULL").all() as Array<{ n: string }>).map((r) => r.n);
  expect(new Set(held).size, held.join(", ")).toBe(held.length);
}

describe("a record promoted before its offline capture reached the other device", () => {
  for (const fold of FOLDS) {
    for (const how of ["promote", "scaffold"] as const) for (const first of ["b", "a"] as const) {
      it(`leaves the number with the earlier claim and moves the other, on every device (${how}, ${first} pushes first, ${fold} fold)`, async () => {
        const fleet = setup(fold);
        const a = fleet.machine("a");
        a.store.plan().enable("vp", { person: { via: "settings" } });
        await a.sync();
        const b = fleet.machine("b");
        await b.sync();

        a.use();
        const x = a.store.plan().capture({ title: "X on A", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
        if (how === "promote") a.store.plan().promote(x, "vp", PERSON);
        else a.store.plan().scaffold(x, a.store.plan().scaffoldPreview(x).fingerprint, "vp", PERSON);
        b.use();
        const y = b.store.plan().capture({ title: "Y on B" }, "agent").id;
        // One device's capture reaches the log first.
        if (first === "b") await b.sync();
        else {
          a.use();
          await a.sync();
        }
        await rounds([a, b], 6);
        const fresh = fleet.machine("fresh");
        await fresh.sync();
        for (const m of [a, b, fresh]) {
          m.use();
          expect(ideas(m)).toEqual(ideas(a));
          expectEachNumberOnce(m);
          // The earlier claim keeps I-TRA-1 (as identifier or kept); the later one moves, and nothing holds no number.
          expect(m.store.getIssue("I-TRA-1").id).toBe(first === "b" ? y : x);
          const kept = m.store.getIssue(x).ideaNumber!;
          expect(kept).toMatch(/^I-TRA-\d+$/);
          expect(m.store.getIssue(kept).id).toBe(x);
          expect(m.store.getIssue(m.store.getIssue(y).identifier).id).toBe(y);
          expect(m.store.getIssue(y).identifier).toMatch(first === "b" ? /^I-TRA-1$/ : /^I-TRA-\d+$/);
          if (first === "a") expect(kept).toBe("I-TRA-1");
          expect(open(m)).toEqual([]);
        }
      });
    }
  }
});

describe("a legacy idea numbered on one device while another promoted it", () => {
  for (const fold of FOLDS) {
    it(`keeps the promotion's ticket number on every device (${fold} fold)`, async () => {
      const fleet = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      const l = a.store.plan().capture({ title: "Legacy", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
      // What an earlier build left: a draft identifier, sent while planning was off.
      const draft = `~${l.replace(/-/g, "")}`;
      a.db.prepare("UPDATE issues SET identifier = ? WHERE id = ?").run(draft, l);
      a.db.prepare("UPDATE sync_outbox SET payload = json_set(payload, '$.identifier', ?) WHERE entity_id = ? AND verb = 'create'").run(draft, l);
      a.store.setSetting("features.planning", false, "vp", { via: "settings" });
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      // Planning on again on both; each numbers the legacy idea before hearing of the other, and B promotes it.
      a.use();
      a.store.plan().enable("vp", { person: { via: "settings" } });
      b.use();
      b.store.setSetting("features.planning", true, "vp", { via: "settings" });
      const ticket = b.store.plan().promote(l, "vp", PERSON).identifier!;
      expect(ticket).toMatch(/^TRA-\d+$/);
      await b.sync();
      await rounds([a, b], 6);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const m of [a, b, fresh]) {
        m.use();
        const issue = m.store.getIssue(l);
        expect(issue.identifier).toBe(ticket);
        expect(issue.kind).not.toBe("idea");
        expect(issue.ideaNumber).toMatch(/^I-TRA-\d+$/);
        expect(m.store.getIssue(ticket).id).toBe(l);
        expectEachNumberOnce(m);
        expect(open(m)).toEqual([]);
      }
    });
  }
});

describe("two devices number different sets of legacy records", () => {
  for (const fold of FOLDS) for (const first of ["b", "a"] as const) {
    it(`never leave one number on two records (${first} pushes first, ${fold} fold)`, async () => {
      const fleet = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      const p = a.store.plan().capture({ title: "P promoted", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
      a.store.plan().promote(p, "vp", PERSON);
      const l1 = a.store.plan().capture({ title: "L1" }, "vp", PERSON).id;
      // An earlier build's state: P kept no number, L1 a draft; sent with planning off.
      a.db.prepare("UPDATE issues SET plan_idea_number = NULL WHERE id = ?").run(p);
      a.db.prepare("UPDATE sync_outbox SET payload = json_remove(payload, '$.planIdeaNumber') WHERE entity_id = ?").run(p);
      const draft = `~${l1.replace(/-/g, "")}`;
      a.db.prepare("UPDATE issues SET identifier = ? WHERE id = ?").run(draft, l1);
      a.db.prepare("UPDATE sync_outbox SET payload = json_set(payload, '$.identifier', ?) WHERE entity_id = ? AND verb = 'create'").run(draft, l1);
      a.store.setSetting("features.planning", false, "vp", { via: "settings" });
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();
      // Both number offline. B alone also holds an older legacy draft, L0, which shifts every number it gives.
      a.use();
      a.db.prepare("DELETE FROM meta WHERE key = 'next_idea_number'").run();
      a.store.plan().enable("vp", { person: { via: "settings" } });
      b.use();
      b.store.setSetting("features.planning", true, "vp", { via: "settings" });
      const l0 = b.store.plan().capture({ title: "L0 on B" }, "vp", PERSON).id;
      // Put B back in the legacy state, its numbering unsent, then number all three at once.
      b.db.prepare("DELETE FROM sync_outbox WHERE actor = 'staple' AND acknowledged_seq IS NULL").run();
      b.db.prepare("UPDATE issues SET plan_idea_number = NULL WHERE id = ?").run(p);
      for (const id of [l0, l1]) b.db.prepare("UPDATE issues SET identifier = ? WHERE id = ?").run(`~${id.replace(/-/g, "")}`, id);
      b.db.prepare("UPDATE sync_outbox SET payload = json_set(payload, '$.identifier', ?) WHERE entity_id = ? AND verb = 'create'").run(`~${l0.replace(/-/g, "")}`, l0);
      b.db.prepare("UPDATE issues SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?").run(l0);
      b.db.prepare("DELETE FROM meta WHERE key = 'next_idea_number'").run();
      b.store.plan().upgradeRecords();
      expect([b.store.getIssue(l0).identifier, b.store.getIssue(p).ideaNumber, b.store.getIssue(l1).identifier]).toEqual(["I-TRA-1", "I-TRA-2", "I-TRA-3"]);
      a.use();
      // A's P lands on B's L0, and A's L1 on B's P: one number, two records, until they settle.
      expect([a.store.getIssue(p).ideaNumber, a.store.getIssue(l1).identifier]).toEqual(["I-TRA-1", "I-TRA-2"]);
      const pusher = first === "b" ? b : a;
      pusher.use();
      await pusher.sync();
      await rounds([a, b], 6);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const m of [a, b, fresh]) {
        m.use();
        expect(ideas(m)).toEqual(ideas(a));
        expectEachNumberOnce(m);
        expect(m.store.getIssue(p).ideaNumber).toMatch(/^I-TRA-\d+$/);
        expect(open(m)).toEqual([]);
      }
    });
  }
});

describe("a workspace that numbered ideas before it joined a repository", () => {
  /** B's workspace, made before it connected: an idea and a promoted record that kept a number. */
  function offlineWorkspace(fleet: Fleet, slug: string): { prepared: { home: string; dir: string }; b0: string; b1: string } {
    const prepared = fleet.prepare("b", { slug });
    process.env.STAPLE_HOME = prepared.home;
    const ws = openWorkspace(join(prepared.dir, ".staple", "staple.db"));
    ws.store.setSetting("features.planning", true, "vp", { via: "settings" });
    const b0 = ws.store.plan().capture({ title: "B0 promoted offline", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
    ws.store.plan().promote(b0, "vp", PERSON);
    const b1 = ws.store.plan().capture({ title: "B1 idea offline" }, "vp", PERSON).id;
    ws.store.db.close();
    return { prepared, b0, b1 };
  }

  async function repository(fleet: Fleet): Promise<Machine> {
    const a = fleet.machine("a");
    a.store.plan().enable("vp", { person: { via: "settings" } });
    a.store.plan().capture({ title: "A1 idea" }, "vp", PERSON);
    const a2 = a.store.plan().capture({ title: "A2 promoted", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
    a.store.plan().promote(a2, "vp", PERSON);
    await a.sync();
    return a;
  }

  for (const slug of ["tracker", "other"]) {
    it(`moves its idea numbers and kept numbers clear of the repository's, in the repository's namespace (${slug})`, async () => {
      const fleet = setup("service");
      const a = await repository(fleet);
      const { prepared, b0, b1 } = offlineWorkspace(fleet, slug);
      const b = fleet.connect("b", prepared);
      await b.sync();
      await rounds([a, b], 3);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const m of [a, b, fresh]) {
        m.use();
        expect(ideas(m)).toEqual(ideas(a));
        expectEachNumberOnce(m);
        for (const number of (m.db.prepare("SELECT identifier AS n FROM issues WHERE identifier GLOB 'I-*' UNION ALL SELECT plan_idea_number FROM issues WHERE plan_idea_number IS NOT NULL").all() as Array<{ n: string }>).map((r) => r.n)) {
          expect(number).toMatch(/^I-TRA-\d+$/);
        }
        expect(open(m)).toEqual([]);
      }
      b.use();
      // Each moved record says so, and its new number finds it.
      for (const id of [b0, b1]) {
        const issue = b.store.getIssue(id);
        expect(b.store.getIssue(issue.ideaNumber!).id).toBe(id);
        expect(b.store.listComments(id).some((comment) => comment.authorType === "system" && /idea number moved|Renumbered/.test(comment.body))).toBe(true);
      }
    });
  }
});

describe("a legacy idea promoted on one device while another numbered it and made a ticket offline", () => {
  for (const fold of FOLDS) {
    it(`keeps the epic on its ticket number, the earlier claim, and moves the later ticket (${fold} fold)`, async () => {
      const fleet = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      const l = a.store.plan().capture({ title: "Legacy", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
      const draft = `~${l.replace(/-/g, "")}`;
      a.db.prepare("UPDATE issues SET identifier = ? WHERE id = ?").run(draft, l);
      a.db.prepare("UPDATE sync_outbox SET payload = json_set(payload, '$.identifier', ?) WHERE entity_id = ? AND verb = 'create'").run(draft, l);
      a.store.setSetting("features.planning", false, "vp", { via: "settings" });
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      // A, offline: a ticket, then planning on, which numbers the legacy idea. B: planning on, and it promotes it.
      a.use();
      const task = a.store.createIssue({ title: "Task on A" });
      a.store.plan().enable("vp", { person: { via: "settings" } });
      b.use();
      b.store.setSetting("features.planning", true, "vp", { via: "settings" });
      const ticket = b.store.plan().promote(l, "vp", PERSON).identifier!;
      expect(task.identifier).toBe(ticket);
      await b.sync();
      await rounds([a, b], 6);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const m of [a, b, fresh]) {
        m.use();
        expect(m.store.getIssue(l).identifier).toBe(ticket);
        expect(m.store.getIssue(ticket).id).toBe(l);
        expect(m.store.getIssue(task.id).identifier).not.toBe(ticket);
        expectEachNumberOnce(m);
        expect(open(m)).toEqual([]);
      }
    });
  }
});

describe("two devices each number a legacy record only they hold, around one they share", () => {
  for (const fold of FOLDS) for (const first of ["a", "b"] as const) {
    it(`settle the shared record's kept number once the dust settles (${first} pushes first, ${fold} fold)`, async () => {
      const fleet = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      const p = a.store.plan().capture({ title: "P shared", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
      a.store.plan().promote(p, "vp", PERSON);
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();
      // Each device, offline: an idea of its own, then the legacy state an earlier build left, numbered in creation order.
      const legacy = (m: Machine, title: string, createdAt: string): string => {
        m.use();
        const own = m.store.plan().capture({ title }, "vp", PERSON).id;
        m.db.prepare("DELETE FROM sync_outbox WHERE acknowledged_seq IS NULL AND entity_id IN (?, ?) AND verb <> 'create'").run(own, p);
        m.db.prepare("UPDATE issues SET identifier = ?, created_at = ? WHERE id = ?").run(`~${own.replace(/-/g, "")}`, createdAt, own);
        m.db.prepare("UPDATE sync_outbox SET payload = json_set(payload, '$.identifier', ?) WHERE entity_id = ? AND verb = 'create'").run(`~${own.replace(/-/g, "")}`, own);
        m.db.prepare("UPDATE issues SET plan_idea_number = NULL WHERE id = ?").run(p);
        m.db.prepare("DELETE FROM meta WHERE key = 'next_idea_number'").run();
        m.store.plan().upgradeRecords();
        return own;
      };
      const la = legacy(a, "L_A newer", "2099-01-01T00:00:00.000Z");
      const lb = legacy(b, "L_B older", "2000-01-01T00:00:00.000Z");
      a.use();
      expect([a.store.getIssue(p).ideaNumber, a.store.getIssue(la).identifier]).toEqual(["I-TRA-1", "I-TRA-2"]);
      b.use();
      expect([b.store.getIssue(lb).identifier, b.store.getIssue(p).ideaNumber]).toEqual(["I-TRA-1", "I-TRA-2"]);

      const pusher = first === "a" ? a : b;
      pusher.use();
      await pusher.sync();
      await rounds([a, b], 8);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const m of [a, b, fresh]) {
        m.use();
        expect(ideas(m)).toEqual(ideas(a));
        expectEachNumberOnce(m);
        expect(open(m)).toEqual([]);
      }
    });
  }
});

describe("two devices each promote their own offline capture of one number", () => {
  for (const fold of FOLDS) for (const first of ["a", "b"] as const) {
    it(`leave the number with the earlier claim only (${first} pushes first, ${fold} fold)`, async () => {
      const fleet = setup(fold);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();
      a.use();
      const x = a.store.plan().capture({ title: "X on A", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
      a.store.plan().promote(x, "vp", PERSON);
      b.use();
      const y = b.store.plan().capture({ title: "Y on B", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
      b.store.plan().promote(y, "vp", PERSON);
      const pusher = first === "a" ? a : b;
      pusher.use();
      await pusher.sync();
      await rounds([a, b], 6);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const m of [a, b, fresh]) {
        m.use();
        expect(ideas(m)).toEqual(ideas(a));
        expectEachNumberOnce(m);
        // The first in the log keeps I-TRA-1; only the other moves.
        expect(m.store.getIssue("I-TRA-1").id).toBe(first === "a" ? x : y);
        expect(open(m)).toEqual([]);
      }
    });
  }
});
