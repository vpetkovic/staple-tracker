/**
 * A misfiled ticket becomes an idea (design/plan.md, "Converting a ticket into an idea"): the same
 * record, so its comments, documents, files and history stay, and its ticket number still names it,
 * on the device that converted it, on one that receives the conversion by sync and on one that
 * hydrates after it. Refused, naming why, when it or anything under it is claimed or started.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;
const REPO = "5eed0000-0000-4000-8000-0000000005b6";

function refused(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

describe("converting a ticket on one device", () => {
  let store: WorkspaceStore;
  let plan: PlanStore;
  beforeEach(() => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    store = new WorkspaceStore(db, "test", "TST");
    plan = store.plan();
    plan.enable("vp", { person: { via: "settings" } });
  });

  const outbox = () => (store.db.prepare("SELECT COUNT(*) AS n FROM sync_outbox").get() as { n: number }).n;

  it("keeps the record, its comments, documents, files and history, and its ticket number names it", () => {
    const rung = store.createIssue({ title: "Rung work", kind: "epic" });
    const ticket = store.createIssue({ title: "Exercise structural key", description: "FXI/FXM/FXE", parent: rung.identifier, labels: ["discovery"] });
    const child = store.createIssue({ title: "Key format", parent: ticket.identifier });
    store.addComment(ticket.identifier, "found while working the rung", "agent", "agent");
    store.putDocument(ticket.identifier, "notes", "# Notes\n\nthe key shape", { author: "agent" });
    store.attachFile(ticket.identifier, { filename: "sketch.txt", bytes: new TextEncoder().encode("sketch"), author: "agent" });

    const result = plan.convertTicket(ticket.identifier, "agent");

    expect(result.converted).toEqual([
      { from: ticket.identifier, to: "I-TST-1", title: "Exercise structural key" },
      { from: child.identifier, to: "I-TST-2", title: "Key format" },
    ]);
    expect(result.detachedFrom).toBe(rung.identifier);
    expect(result.idea).toMatchObject({ id: ticket.id, number: "I-TST-1", identifier: null, maturity: "raw", stage: "raw", parentId: null });
    // The same record: everything that hangs on it is still there.
    const idea = store.getIssue(ticket.identifier);
    expect(idea).toMatchObject({ id: ticket.id, identifier: "I-TST-1", kind: "idea", ticketNumber: ticket.identifier, description: "FXI/FXM/FXE", labels: ["discovery"] });
    expect(store.listComments("I-TST-1").map((comment) => comment.body)).toContain("found while working the rung");
    expect(store.getDocument("I-TST-1", "notes").body).toContain("the key shape");
    expect(store.listFiles("I-TST-1").map((file) => file.filename)).toEqual(["sketch.txt"]);
    const kinds = store.listEvents(0, 500).filter((event) => event.issueId === ticket.id).map((event) => event.kind);
    expect(kinds).toEqual(expect.arrayContaining(["issue_created", "comment_added", "parent_changed", "ticket_converted"]));
    // Its child is its sub-idea, named by its old number too.
    expect(store.getIssue(child.identifier)).toMatchObject({ id: child.id, kind: "idea", parentId: ticket.id, ticketNumber: child.identifier });
    // It is off the board and out of pickup, and its numbers are never minted again.
    expect(store.listIssues().map((issue) => issue.id)).not.toContain(ticket.id);
    expect(store.getIssue(rung.identifier).id).toBe(rung.id);
    const next = store.createIssue({ title: "Next ticket" });
    expect(next.identifier).toBe("TST-6");
    // A search for the old number finds it.
    expect(store.listIssues({ q: ticket.identifier, includePlan: true }).map((issue) => issue.id)).toContain(ticket.id);
  });

  it("stays under a parent that is in the plan, as its sub-idea", () => {
    const shaped = plan.capture({ title: "Passkeys", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON);
    const epic = plan.promote(shaped.id, "vp");
    const ticket = store.createIssue({ title: "Misfiled under the epic", parent: epic.identifier! });
    const result = plan.convertTicket(ticket.identifier, "agent");
    expect(result.detachedFrom).toBeNull();
    expect(store.getIssue(ticket.id)).toMatchObject({ kind: "idea", parentId: shaped.id });
    expect(plan.ideaView(ticket.id)).toMatchObject({ parentId: shaped.id, maturity: "raw" });
  });

  it("is refused, naming every reason, when it or what is under it is claimed or started, and writes nothing", () => {
    const ticket = store.createIssue({ title: "Started under" });
    const started = store.createIssue({ title: "Started child", parent: ticket.identifier });
    store.checkoutIssue(started.identifier, "agent");
    const before = outbox();
    const error = refused(() => plan.convertTicket(ticket.identifier, "agent"));
    expect(error.message).toContain(`${started.identifier} "Started child" under it was started (it is in_progress)`);
    expect(error.message).toContain(`${started.identifier} "Started child" under it is checked out by agent`);
    expect(outbox()).toBe(before);
    expect(store.getIssue(ticket.identifier)).toMatchObject({ kind: "task", identifier: ticket.identifier });
  });

  it("is refused when the ticket itself is claimed, started, resolved, or holds what an idea cannot", () => {
    const claimed = store.createIssue({ title: "Claimed" });
    store.checkoutIssue(claimed.identifier, "agent");
    expect(refused(() => plan.convertTicket(claimed.identifier, "agent")).message).toMatch(/Claimed" cannot be converted into an idea: was started \(it is in_progress\); is checked out by agent\.$/);

    const done = store.createIssue({ title: "Done" });
    store.updateIssue(done.identifier, { status: "done" }, "vp");
    expect(refused(() => plan.convertTicket(done.identifier, "agent")).message).toContain("is done");

    const released = store.createIssue({ title: "Released" });
    store.checkoutIssue(released.identifier, "agent");
    store.releaseIssue(released.identifier, "agent");
    expect(refused(() => plan.convertTicket(released.identifier, "agent")).message).toContain("was started on");

    const blocker = store.createIssue({ title: "Blocker" });
    const waiting = store.createIssue({ title: "Waiting", blockedBy: [blocker.identifier] });
    expect(refused(() => plan.convertTicket(waiting.identifier, "agent")).message).toContain(`waits on ${blocker.identifier}`);
    expect(refused(() => plan.convertTicket(blocker.identifier, "agent")).message).toContain(`blocks ${waiting.identifier}`);

    const queued = store.createIssue({ title: "Queued" });
    store.queue().enqueue(queued.identifier, {}, "vp");
    expect(refused(() => plan.convertTicket(queued.identifier, "agent")).message).toContain("is in the pickup queue");

    const exploring = plan.capture({ title: "Exploring", maturity: "exploring" }, "vp", PERSON);
    const research = store.createIssue({ title: "Research" });
    plan.adopt(exploring.id, research.identifier, "agent", { purpose: "exploration" });
    expect(refused(() => plan.convertTicket(research.identifier, "agent")).message).toContain("is linked to the idea \"Exploring\" (I-TST-1)");

    expect(refused(() => plan.convertTicket(exploring.id, "agent")).message).toContain("is already part of the plan");

    // A review gate parks a parent; it is refused for that, not as started work.
    const gated = store.createIssue({ title: "Gated", kind: "epic" });
    store.createIssue({ title: "Gated child", parent: gated.identifier });
    store.gateIssue(gated.identifier, { owner: "VP" }, "agent");
    const gate = refused(() => plan.convertTicket(gated.identifier, "agent")).message;
    expect(gate).toContain("is parked behind a review gate");
    expect(gate).not.toContain("was started");
  });

  it("is hidden with planning off, with nothing deleted, on the number it left too", () => {
    const ticket = store.createIssue({ title: "Misfiled" });
    plan.convertTicket(ticket.identifier, "agent");
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    expect(() => store.getIssue(ticket.identifier)).toThrow(/No issue matches/);
    expect(store.listIssues({ q: ticket.identifier }).map((issue) => issue.id)).not.toContain(ticket.id);
    expect(refused(() => plan.convertTicket(store.createIssue({ title: "Another" }).identifier, "agent")).message).toContain("Planning is off");
    store.setSetting("features.planning", true, "vp", { via: "settings" });
    expect(store.getIssue(ticket.identifier)).toMatchObject({ id: ticket.id, kind: "idea", ticketNumber: ticket.identifier });
  });
});

describe("a conversion across devices", () => {
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
  const record = (m: Machine, id: string) =>
    m.db.prepare("SELECT identifier, kind, plan_maturity, plan_rank, plan_ticket_number, parent_id FROM issues WHERE id = ?").get(id) as Record<string, unknown>;

  for (const fold of FOLDS) {
    it(`reads the same on the device that made it, one that received it, and one that hydrated after it (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      const ticket = a.store.createIssue({ title: "Misfiled discovery" });
      const child = a.store.createIssue({ title: "Its part", parent: ticket.identifier });
      a.store.addComment(ticket.identifier, "context", "agent", "agent");
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      a.store.plan().convertTicket(ticket.identifier, "agent");
      await rounds([a, b]);
      const fresh = fleet.machine("fresh");
      await fresh.sync();

      for (const m of [a, b, fresh]) {
        m.use();
        expect(record(m, ticket.id)).toEqual(record(a, ticket.id));
        expect(record(m, ticket.id)).toMatchObject({ kind: "idea", plan_maturity: "raw", plan_ticket_number: ticket.identifier });
        expect(m.store.getIssue(ticket.identifier).id).toBe(ticket.id);
        expect(m.store.getIssue(child.identifier)).toMatchObject({ id: child.id, kind: "idea", parentId: ticket.id });
        expect(m.store.listComments(ticket.id).map((comment) => comment.body)).toContain("context");
        expect(open(m)).toEqual([]);
      }
      // A device that only hydrated never mints the old numbers again.
      fresh.use();
      const minted = fresh.store.createIssue({ title: "Fresh work" });
      expect([ticket.identifier, child.identifier]).not.toContain(minted.identifier);
    });

    it(`converges when two devices convert one ticket and its subtree offline, with nothing to answer (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      a.store.plan().enable("vp", { person: { via: "settings" } });
      const ticket = a.store.createIssue({ title: "Twice misfiled" });
      const child = a.store.createIssue({ title: "Its child", parent: ticket.identifier });
      const grandchild = a.store.createIssue({ title: "Its grandchild", parent: child.identifier });
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      a.store.plan().capture({ title: "A's own idea" }, "agent");
      a.store.plan().convertTicket(ticket.identifier, "agent");
      b.use();
      b.store.plan().convertTicket(ticket.identifier, "agent");
      await rounds([a, b], 6);
      const fresh = fleet.machine("fresh");
      await fresh.sync();

      for (const m of [a, b, fresh]) {
        m.use();
        // The subtree too: each device minted its own numbers for it, and every device ends on one set.
        for (const converted of [ticket, child, grandchild]) {
          expect(record(m, converted.id)).toEqual(record(a, converted.id));
          expect(m.store.getIssue(converted.identifier).id).toBe(converted.id);
        }
        expect(open(m)).toEqual([]);
      }
      const numbers = (m: Machine) => (m.db.prepare("SELECT identifier FROM issues WHERE kind = 'idea' ORDER BY identifier").all() as Array<{ identifier: string }>).map((r) => r.identifier);
      expect(new Set(numbers(a)).size).toBe(4);
      expect(numbers(b)).toEqual(numbers(a));
      expect(numbers(fresh)).toEqual(numbers(a));
    });
  }
});
