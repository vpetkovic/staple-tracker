/**
 * The plan layer synchronizes as fields of the `issue` entity (design/plan.md, "Storage"):
 * no new entity, so no protocol change. One machine plans, another pulls the tail, a third
 * hydrates from the snapshot, and all three read the same plan: the same records, the same
 * horizon membership (derived on each device, never sent), and the same ticket numbers for
 * ideas promoted on two devices at once.
 */
import { afterEach, describe, expect, it } from "vitest";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { formerHolders } from "../src/core/identifier-moves.js";

const REPO = "5eed0000-0000-4000-8000-0000000001a2";
const PERSON = { person: { via: "plan_view" } } as const;

let fleet: Fleet | null = null;
afterEach(() => {
  fleet?.close();
  fleet = null;
});

function planOf(machine: Machine): unknown {
  const plan = machine.store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  const view = plan.view();
  return {
    enabled: view.enabled,
    horizons: view.horizons.map((h) => [h.identifier, h.name, h.date, h.rank, h.status]),
    members: membership(machine),
    ideas: view.ideas.map((i) => ({
      id: i.id,
      identifier: i.identifier,
      maturity: i.maturity,
      stage: i.stage,
      horizon: view.horizons.find((h) => h.id === i.horizonId)?.identifier ?? null,
      parent: i.parentId,
      planned: i.planned,
      baseline: i.baseline,
      links: i.links.map((id) => machine.store.getIssue(id).identifier),
    })),
  };
}

/** Each horizon's members as this device derives them: horizon name to member identifiers, in order. */
function membership(machine: Machine): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const h of machine.store.plan().view().horizons) out[h.name] = machine.store.milestones().get(h.id).members.map((m) => m.identifier);
  return out;
}

async function both(a: Machine, b: Machine, rounds = 2): Promise<void> {
  for (let round = 0; round < rounds; round += 1) {
    for (const machine of [a, b]) {
      machine.use();
      await machine.sync();
    }
  }
}

const openConflicts = (machine: Machine): unknown[] => machine.db.prepare("SELECT entity, field FROM sync_conflicts WHERE resolved_at IS NULL").all();

describe("links merge across devices: one field per link", () => {
  const linked = (machine: Machine, idea: string): string[] =>
    machine.store
      .plan()
      .ideaView(idea)
      .links.map((id) => machine.store.getIssue(id).identifier)
      .sort();
  const conflicts = (machine: Machine): unknown[] => machine.db.prepare("SELECT field FROM sync_conflicts WHERE resolved_at IS NULL").all();

  for (const fold of ["service", "tail"] as const) {
    it(`keeps both of two adopts made offline on two devices (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const idea = a.store.plan().capture({ title: "Idea", maturity: "shaped" }, "vp", PERSON).id;
      const x = a.store.createIssue({ title: "Epic X", kind: "epic" }).identifier;
      const y = a.store.createIssue({ title: "Epic Y", kind: "epic" }).identifier;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      a.store.plan().adopt(idea, x, "agent-a");
      b.use();
      b.store.plan().adopt(idea, y, "agent-b");
      await both(a, b);

      expect(linked(a, idea)).toEqual([x, y].sort());
      expect(linked(b, idea)).toEqual([x, y].sort());
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expect(linked(fresh, idea)).toEqual([x, y].sort());
    });
  }

  it("converges when one device unlinks while another adopts", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp");
    const idea = a.store.plan().capture({ title: "Idea", maturity: "shaped" }, "vp", PERSON).id;
    const x = a.store.createIssue({ title: "Epic X", kind: "epic" }).identifier;
    const y = a.store.createIssue({ title: "Epic Y", kind: "epic" }).identifier;
    a.store.plan().adopt(idea, x, "vp");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();

    a.use();
    a.store.plan().unlink(idea, x, "agent-a");
    b.use();
    b.store.plan().adopt(idea, y, "agent-b");
    await both(a, b);

    expect(linked(a, idea)).toEqual([y]);
    expect(linked(b, idea)).toEqual([y]);
    expect(conflicts(a)).toEqual([]);
    expect(conflicts(b)).toEqual([]);
    const fresh = fleet.machine("fresh");
    await fresh.sync();
    expect(linked(fresh, idea)).toEqual([y]);
  });
});

describe("the plan synchronizes with no new entity", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`reads the same on every device (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      const plan = a.store.plan();
      plan.enable("vp");
      const now = plan.view().horizons[0]!;
      const ga = plan.capture({ title: "Exercise GA", maturity: "shaped", horizon: now.id, plannedStart: "2026-10-01", plannedTarget: "2026-12-31" }, "vp", PERSON);
      plan.capture({ title: "R8 Mobile", parent: ga.id, maturity: "exploring" }, "vp", PERSON);
      const epic = a.store.createIssue({ title: "EPIC-40", kind: "epic" });
      plan.adopt(ga.id, epic.identifier, "agent");
      plan.update(ga.id, { plannedTarget: "2027-01-31" }, "vp", PERSON);
      plan.createHorizon({ name: "MVP", date: "2026-12-31" }, "vp", PERSON);
      await a.sync();

      const b = fleet.machine("b");
      await b.sync();
      expect(planOf(b)).toEqual(planOf(a));

      b.use();
      b.store.plan().update(ga.id, { maturity: "exploring" }, "vp", PERSON);
      await b.sync();
      a.use();
      await a.sync();
      expect(planOf(a)).toEqual(planOf(b));

      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expect(planOf(fresh)).toEqual(planOf(a));
      const shown = planOf(fresh) as { members: Record<string, string[]>; ideas: Array<{ id: string; baseline: unknown; planned: unknown }> };
      expect(shown.members.Now).toEqual([epic.identifier]);
      const gaFresh = shown.ideas.find((i) => i.id === ga.id)!;
      expect(gaFresh.baseline).toEqual({ start: "2026-10-01", target: "2026-12-31" });
      expect(gaFresh.planned).toEqual({ start: "2026-10-01", target: "2027-01-31" });
    });
  }
});

describe("membership is derived on every device, so moves made offline never conflict", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`converges when two devices move, adopt and unschedule offline (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      const plan = a.store.plan();
      plan.enable("vp");
      const [now, next, later] = plan.view().horizons.map((h) => h.id) as [string, string, string];
      const first = plan.capture({ title: "First", maturity: "shaped", horizon: now }, "vp", PERSON).id;
      const second = plan.capture({ title: "Second", maturity: "shaped", horizon: next }, "vp", PERSON).id;
      const third = plan.capture({ title: "Third", maturity: "shaped", horizon: later }, "vp", PERSON).id;
      const x = a.store.createIssue({ title: "Epic X", kind: "epic" }).identifier;
      const y = a.store.createIssue({ title: "Epic Y", kind: "epic" }).identifier;
      const z = a.store.createIssue({ title: "Epic Z", kind: "epic" }).identifier;
      plan.adopt(first, x, "vp");
      plan.adopt(third, z, "vp");
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();
      expect(membership(b)).toEqual({ Now: [x], Next: [], Later: [z] });

      // Offline on both: A moves First to Next and unschedules Third; B adopts Y onto Second
      // and moves Second to Now. Each change is one idea's field, and they do not overlap.
      a.use();
      a.store.plan().update(first, { horizon: next }, "vp", PERSON);
      a.store.plan().update(third, { horizon: null }, "vp", PERSON);
      b.use();
      b.store.plan().adopt(second, y, "agent-b");
      b.store.plan().update(second, { horizon: now }, "vp", PERSON);
      await both(a, b);

      const expected = { Now: [y], Next: [x], Later: [] };
      expect(membership(a)).toEqual(expected);
      expect(membership(b)).toEqual(expected);
      expect(openConflicts(a)).toEqual([]);
      expect(openConflicts(b)).toEqual([]);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expect(membership(fresh)).toEqual(expected);
      expect(planOf(fresh)).toEqual(planOf(a));
      // Nothing about membership was sent: no operation names the derived table.
      expect(server.ops.some((op) => JSON.stringify(op).includes("plan_members"))).toBe(false);
    });
  }
});

describe("promotion takes a real number once, even on two devices offline", () => {
  for (const fold of ["service", "tail"] as const) {
    it(`gives two ideas promoted at once two distinct numbers, with no draft and no conflict left (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const now = a.store.plan().view().horizons[0]!.id;
      const p = a.store.plan().capture({ title: "Promoted on A", maturity: "shaped", horizon: now }, "vp", PERSON).id;
      const q = a.store.plan().capture({ title: "Promoted on B", maturity: "shaped", horizon: now }, "vp", PERSON).id;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      const onA = a.store.plan().promote(p, "vp", PERSON).identifier!;
      b.use();
      const onB = b.store.plan().promote(q, "agent-b").identifier!;
      // Offline, both took the same next number.
      expect(onA).toBe(onB);
      await both(a, b, 3);

      const fresh = fleet.machine("fresh");
      await fresh.sync();
      const numbers = (machine: Machine) => [p, q].map((id) => machine.store.getIssue(id).identifier);
      const [pa, qa] = numbers(a);
      expect(pa).not.toBe(qa);
      for (const machine of [a, b, fresh]) {
        expect(numbers(machine)).toEqual([pa, qa]);
        for (const identifier of numbers(machine)) expect(identifier).toMatch(/^[A-Z]+-\d+$/);
        expect(openConflicts(machine)).toEqual([]);
        expect(machine.store.plan().view().ideas.filter((i) => i.promoted).map((i) => i.id).sort()).toEqual([p, q].sort());
        expect(membership(machine).Now).toEqual(expect.arrayContaining([pa, qa]));
      }
      // The counter is clear of both everywhere: the next ticket takes neither.
      for (const machine of [a, b]) {
        machine.use();
        const next = machine.store.createIssue({ title: `After on ${machine === a ? "a" : "b"}` }).identifier;
        expect([pa, qa]).not.toContain(next);
      }
    });
  }

  it("never leaves a promoted idea on a third device without a number while the loser settles", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp");
    const p = a.store.plan().capture({ title: "Promoted on A", maturity: "shaped" }, "vp", PERSON).id;
    const q = a.store.plan().capture({ title: "Promoted on B", maturity: "shaped" }, "vp", PERSON).id;
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    const c = fleet.machine("c");
    await c.sync();

    a.use();
    const number = a.store.plan().promote(p, "vp", PERSON).identifier!;
    b.use();
    b.store.plan().promote(q, "vp", PERSON);
    a.use();
    await a.sync();
    // B sends its later claim and learns it lost. Its settlement is held back: every send after
    // that pull fails, as on a device that goes offline again straight after.
    const route = (r: string) => Array.prototype.push.call(server.calls, r);
    server.calls.push = (...routes: string[]) => {
      for (const r of routes) {
        if (r.startsWith("GET ") && r.includes("/ops")) server.failNext = { route: "POST /v1/repos/:id/ops", times: 100, status: 503, code: "unavailable" };
        route(r);
      }
      return server.calls.length;
    };
    b.use();
    await b.sync({ attempts: 1 }).catch(() => undefined);
    server.calls.push = (...routes: string[]) => Array.prototype.push.apply(server.calls, routes);
    server.failNext = null;
    expect(b.store.getIssue(q).identifier).not.toBe(number);

    // C reads both claims from the tail before the settlement: the later one takes a stand-in.
    c.use();
    await c.sync();
    expect(c.store.getIssue(p).identifier).toBe(number);
    const waiting = c.store.getIssue(q).identifier;
    expect(waiting.startsWith(`${number}+`)).toBe(true);
    expect(openConflicts(c)).toEqual([{ entity: "issue", field: "identifier" }]);

    b.use();
    await b.sync();
    c.use();
    await c.sync();
    const settled = c.store.getIssue(q).identifier;
    expect(settled).toMatch(/^[A-Z]+-\d+$/);
    expect(settled).not.toBe(number);
    expect(settled).toBe(b.store.getIssue(q).identifier);
    expect(openConflicts(c)).toEqual([]);
  });
});

describe("a horizon's status over sync", () => {
  const category = (machine: Machine, id: string) => machine.store.categoryOf(machine.store.getIssue(id).status);
  const names = (machine: Machine) => machine.store.plan().view().horizons.map((h) => h.name);

  for (const fold of ["service", "tail"] as const) {
    it(`keeps a horizon whose only work is cancelled, and derives it again everywhere when the work reopens (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const now = a.store.plan().view().horizons[0]!.id;
      const p = a.store.plan().capture({ title: "Only work on Now", maturity: "shaped", horizon: now }, "vp", PERSON).id;
      a.store.plan().promote(p, "vp", PERSON);
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      a.store.updateIssue(p, { status: a.store.primaryStatusFor("cancelled") }, "vp");
      await both(a, b);
      for (const machine of [a, b]) {
        expect(names(machine)).toContain("Now");
        expect(category(machine, now)).toBe("unstarted");
        expect(membership(machine).Now).toEqual([machine.store.getIssue(p).identifier]);
      }

      b.use();
      b.store.updateIssue(p, { status: "todo" }, "vp");
      b.store.checkoutIssue(p, "agent-b");
      await both(a, b);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const machine of [a, b, fresh]) {
        expect(names(machine)).toContain("Now");
        expect(category(machine, now)).toBe("active");
        expect(openConflicts(machine)).toEqual([]);
      }
    });

    it(`re-derives each horizon from the membership two offline moves leave, on every device (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp");
      const [now, next] = a.store.plan().view().horizons.map((h) => h.id);
      const p = a.store.plan().capture({ title: "Underway", maturity: "shaped", horizon: now }, "vp", PERSON).id;
      const q = a.store.plan().capture({ title: "Not started", maturity: "shaped", horizon: next }, "vp", PERSON).id;
      a.store.plan().promote(p, "vp", PERSON);
      a.store.plan().promote(q, "vp", PERSON);
      a.store.checkoutIssue(p, "agent");
      expect(category(a, now!)).toBe("active");
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      // Offline: A takes the work underway off Now, B puts the unstarted work on it.
      a.use();
      a.store.plan().update(p, { horizon: next }, "vp", PERSON);
      b.use();
      b.store.plan().update(q, { horizon: now }, "vp", PERSON);
      // Each derived from its own half: neither saw Now hold only work nobody started.
      expect(category(a, now!)).toBe("active");
      expect(category(b, now!)).toBe("active");

      await both(a, b, 3);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      for (const machine of [a, b, fresh]) {
        expect(membership(machine).Now).toEqual([machine.store.getIssue(q).identifier]);
        expect(category(machine, now!)).toBe("unstarted");
        expect(category(machine, next!)).toBe("active");
        expect(openConflicts(machine)).toEqual([]);
      }
    });
  }
});

describe("an idea an earlier build numbered", () => {
  it("is drafted on every device, and its old number names it on every device", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp");
    const p = a.store.plan().capture({ title: "Numbered by an earlier build" }, "vp", PERSON).id;
    // What an earlier build sent: the idea took a ticket number at capture.
    a.db.prepare("UPDATE issues SET identifier = 'TRA-77' WHERE id = ?").run(p);
    a.db.prepare("UPDATE sync_outbox SET payload = json_set(payload, '$.identifier', 'TRA-77') WHERE entity_id = ? AND verb = 'create'").run(p);
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    expect(b.store.getIssue(p).identifier).toBe("TRA-77");

    a.use();
    a.store.plan().enable("vp");
    await both(a, b);
    for (const machine of [a, b]) {
      expect(machine.store.getIssue(p).identifier.startsWith("~")).toBe(true);
      expect(formerHolders(machine.db, "TRA-77").map((holder) => holder.issueId)).toEqual([p]);
      expect(machine.store.getIssue("TRA-77").id).toBe(p);
    }
  });
});
