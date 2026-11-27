/**
 * Research and proofs of concept linked to an idea (design/plan.md, "Links and breakdown rows"):
 * an exploration link is listed on the idea on its own and is nothing the idea is measured by. It
 * does not start the idea, count toward its progress or dates, or join its horizon, on the device
 * that made it and on every device that receives it by sync.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { planLinkFromValue } from "../src/core/plan-links.js";
import { listConflicts, resolveConflict } from "../src/core/cloud/conflicts.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";
import { DatabaseSync } from "node:sqlite";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";

const PERSON = { person: { via: "plan_view" } } as const;
const REPO = "5eed0000-0000-4000-8000-0000000005a8";

function refused(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

describe("migration 27", () => {
  it("reads every link made before it as delivery, and holds a purpose to the two", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const ordered = [...WORKSPACE_TARGET.migrations].sort((a, b) => a.version - b.version);
    for (const migration of ordered.filter((m) => m.version < 27)) migration.up(db);
    db.prepare("INSERT INTO issues (id, identifier, title, normalized_title, status, priority, created_at, updated_at) VALUES ('idea', 'TST-1', 'Idea', 'idea', 'backlog', 'medium', 't', 't')").run();
    db.prepare("INSERT INTO plan_links (idea_id, issue_id, linked_by, linked_at) VALUES ('idea', 'work', 'vp', 't')").run();
    ordered.find((m) => m.version === 27)!.up(db);
    expect(db.prepare("SELECT issue_id, purpose FROM plan_links").all()).toEqual([{ issue_id: "work", purpose: "delivery" }]);
    expect(() => db.prepare("UPDATE plan_links SET purpose = 'later'").run()).toThrow(/CHECK/);
    db.close();
  });
});

describe("an exploration link on one device", () => {
  let store: WorkspaceStore;
  let plan: PlanStore;
  beforeEach(() => {
    const db = openDb(":memory:");
    migrateWorkspace(db);
    store = new WorkspaceStore(db, "test", "TST");
    plan = store.plan();
    plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
    plan.enable("vp", { person: { via: "settings" } });
  });

  const now = () => plan.view().horizons.find((h) => h.name === "Now")!;
  const members = (horizonId: string) => store.milestones().get(horizonId).members.map((m) => m.identifier);
  const finish = (identifier: string) => {
    store.checkoutIssue(identifier, "agent");
    store.updateIssue(identifier, { status: "done" }, "agent");
  };
  const exploringOnNow = () =>
    plan.capture({ title: "Passkey auth", maturity: "exploring", horizon: now().id, plannedStart: "2026-11-01", plannedTarget: "2026-12-01" }, "vp", PERSON).id;

  it("lists the ticket on its own and leaves the idea exploring, unmeasured and off its horizon", () => {
    const idea = exploringOnNow();
    const before = now();
    const spike = store.createIssue({ title: "Spike: WebAuthn libraries" }).identifier;
    const view = plan.adopt(idea, spike, "agent", { purpose: "exploration" });

    expect(view).toMatchObject({ stage: "scheduled", state: "exploring", maturity: "exploring", links: [], linkCount: 0, progress: null, percent: null, baseline: null });
    expect(view.explorations.map((id) => store.getIssue(id).identifier)).toEqual([spike]);
    const detail = plan.detail(idea);
    expect(detail.linked).toEqual([]);
    expect(detail.exploration.map((link) => link.identifier)).toEqual([spike]);
    expect(members(now().id)).toEqual([]);
    expect(now()).toMatchObject({ units: before.units, state: before.state });

    // Landing the research does not ship or start the idea either.
    finish(spike);
    expect(plan.ideaView(idea)).toMatchObject({ stage: "scheduled", state: "exploring", linkCount: 0, progress: null });
    expect(members(now().id)).toEqual([]);
  });

  it("keeps research apart from delivery once real work is adopted", () => {
    const idea = exploringOnNow();
    const spike = store.createIssue({ title: "POC" }).identifier;
    const work = store.createIssue({ title: "Build passkeys" }).identifier;
    plan.adopt(idea, spike, "agent", { purpose: "exploration" });
    finish(spike);
    const view = plan.adopt(idea, work, "agent");
    expect(view).toMatchObject({ state: "started", linkCount: 1, resolvedLinks: 0, percent: 0 });
    expect(plan.detail(idea).linked.map((l) => l.identifier)).toEqual([work]);
    expect(plan.detail(idea).exploration.map((l) => l.identifier)).toEqual([spike]);
    expect(members(now().id)).toEqual([work]);
  });

  it("moves an issue between the lists when it is linked the other way", () => {
    const idea = exploringOnNow();
    const ticket = store.createIssue({ title: "Turned out to be the real work" }).identifier;
    plan.adopt(idea, ticket, "agent", { purpose: "exploration" });
    expect(plan.adopt(idea, ticket, "agent")).toMatchObject({ state: "started", explorations: [] });
    expect(members(now().id)).toEqual([ticket]);
    const back = plan.adopt(idea, ticket, "agent", { purpose: "exploration" });
    expect(back).toMatchObject({ state: "exploring", links: [] });
    expect(back.explorations).toHaveLength(1);
    expect(members(now().id)).toEqual([]);
  });

  it("unlinks research from an idea that is not started", () => {
    const idea = exploringOnNow();
    expect(plan.ideaView(idea).actions.some((a) => a.id === "unlink")).toBe(false);
    expect(plan.ideaView(idea).actions.some((a) => a.id === "unlink_research")).toBe(true);
    const spike = store.createIssue({ title: "Spike" }).identifier;
    // Nothing linked: the refusal says so first, then why work cannot be unlinked here.
    expect(refused(() => plan.unlink(idea, spike, "agent")).message).toMatch(new RegExp(`^${spike} is not linked to .*cannot be unlinked from work`));
    plan.adopt(idea, spike, "agent", { purpose: "exploration" });
    const after = plan.unlink(idea, spike, "agent");
    expect(after).toMatchObject({ state: "exploring", explorations: [] });
    expect(refused(() => plan.unlink(idea, spike, "agent")).message).toMatch(/is not linked to/);
  });

  it("lets research be removed from a shipped idea, and keeps a dropped idea that holds research from going back to raw", () => {
    const shipped = plan.capture({ title: "Shipped", maturity: "shaped", plan: READY_PLAN }, "vp", PERSON).id;
    const spike = store.createIssue({ title: "Spike" }).identifier;
    const work = store.createIssue({ title: "Work" }).identifier;
    plan.adopt(shipped, spike, "agent", { purpose: "exploration" });
    plan.adopt(shipped, work, "agent");
    finish(work);
    expect(plan.ideaView(shipped).state).toBe("shipped");
    expect(plan.unlink(shipped, spike, "agent")).toMatchObject({ state: "shipped", explorations: [] });

    const dropped = plan.capture({ title: "Dropped", maturity: "exploring" }, "vp", PERSON).id;
    const poc = store.createIssue({ title: "POC" }).identifier;
    plan.adopt(dropped, poc, "agent", { purpose: "exploration" });
    plan.update(dropped, { maturity: "dropped" }, "vp", PERSON);
    expect(refused(() => plan.update(dropped, { maturity: "raw" }, "vp", PERSON)).message).toMatch(/cannot be restored to raw while it holds linked research/);
    expect(plan.update(dropped, { maturity: "exploring" }, "vp", PERSON)).toMatchObject({ state: "exploring" });
    expect(plan.unlink(dropped, poc, "agent").explorations).toEqual([]);
  });

  it("records a relink with the purpose it moved from", () => {
    const idea = exploringOnNow();
    const ticket = store.createIssue({ title: "Ticket" }).identifier;
    plan.adopt(idea, ticket, "agent");
    plan.adopt(idea, ticket, "agent", { purpose: "exploration" });
    const payloads = (store.db.prepare("SELECT payload FROM events WHERE issue_id = ? AND kind = 'idea_linked' ORDER BY rowid").all(plan.ideaView(idea).id) as Array<{ payload: string }>).map((e) => JSON.parse(e.payload));
    expect(payloads.at(-1)).toMatchObject({ issue: ticket, purpose: "exploration", from: "delivery" });
  });

  it("refuses research on a raw idea, naming its state", () => {
    const idea = plan.capture({ title: "Raw thought" }, "agent").id;
    const spike = store.createIssue({ title: "Spike" }).identifier;
    expect(refused(() => plan.adopt(idea, spike, "agent", { purpose: "exploration" })).message).toMatch(/is raw; it cannot be linked to research/);
  });

  it("is hidden with planning off and kept for when it is back on", () => {
    const idea = exploringOnNow();
    const spike = store.createIssue({ title: "Spike" }).identifier;
    plan.adopt(idea, spike, "agent", { purpose: "exploration" });
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    expect(refused(() => plan.detail(idea)).message).toMatch(/[Pp]lanning/);
    expect(refused(() => plan.adopt(idea, spike, "agent", { purpose: "exploration" })).message).toMatch(/[Pp]lanning/);
    store.setSetting("features.planning", true, "vp", { via: "settings" });
    expect(plan.detail(idea).exploration.map((l) => l.identifier)).toEqual([spike]);
  });

  it("reads a delivery value as it always was and refuses a purpose it does not know", () => {
    expect(planLinkFromValue({ linkedBy: "a", linkedAt: "t" })).toEqual({ linkedBy: "a", linkedAt: "t" });
    expect(planLinkFromValue({ linkedBy: "a", linkedAt: "t", purpose: "exploration" })).toEqual({ linkedBy: "a", linkedAt: "t", purpose: "exploration" });
    expect(planLinkFromValue({ linkedBy: "a", linkedAt: "t", purpose: "delivery" })).toEqual({ linkedBy: "a", linkedAt: "t" });
    expect(planLinkFromValue({ linkedBy: "a", linkedAt: "t", purpose: "later" })).toBeNull();
  });
});

describe("an exploration link over sync", () => {
  let fleet: Fleet | null = null;
  afterEach(() => {
    fleet?.close();
    fleet = null;
  });

  /** What a device reads about the idea: the same on the device that linked and every device that received it. */
  function reading(machine: Machine, idea: string) {
    const plan = machine.store.plan();
    plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
    const view = plan.ideaView(idea);
    const horizon = plan.view().horizons.find((h) => h.id === view.horizonId)!;
    return {
      state: view.state,
      stage: view.stage,
      linkCount: view.linkCount,
      progress: view.progress,
      linked: plan.detail(idea).linked.map((l) => l.identifier).sort(),
      exploration: plan.detail(idea).exploration.map((l) => l.identifier).sort(),
      members: machine.store.milestones().get(horizon.id).members.map((m) => m.identifier),
      units: horizon.units,
    };
  }
  const conflicts = (machine: Machine): unknown[] => machine.db.prepare("SELECT field FROM sync_conflicts WHERE resolved_at IS NULL").all();

  async function both(a: Machine, b: Machine, rounds = 2): Promise<void> {
    for (let round = 0; round < rounds; round += 1) {
      for (const machine of [a, b]) {
        machine.use();
        await machine.sync();
      }
    }
  }

  it("carries research made before the workspace first synced, through its seed", async () => {
    const server = new FakeSyncServer({ repositoryId: REPO });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    const plan = a.store.plan();
    plan.enable("vp", { person: { via: "settings" } });
    const now = plan.view().horizons[0]!.id;
    const idea = plan.capture({ title: "Passkey auth", maturity: "exploring", horizon: now, plan: READY_PLAN }, "vp", PERSON).id;
    const x = a.store.createIssue({ title: "Spike X" }).identifier;
    const y = a.store.createIssue({ title: "Work Y" }).identifier;
    plan.adopt(idea, x, "agent", { purpose: "exploration" });
    plan.adopt(idea, y, "agent");
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    expect(reading(a, idea)).toMatchObject({ state: "started", linked: [y], exploration: [x], members: [y] });
    expect(reading(b, idea)).toEqual(reading(a, idea));
    expect(conflicts(a)).toEqual([]);
    expect(conflicts(b)).toEqual([]);
  });

  for (const fold of ["service", "tail"] as const) {
    it(`reads the same on a device that received it and a fresh one, and two devices' research merges (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      const plan = a.store.plan();
      plan.enable("vp", { person: { via: "settings" } });
      const now = plan.view().horizons[0]!.id;
      const idea = plan.capture({ title: "Passkey auth", maturity: "exploring", horizon: now, plan: READY_PLAN }, "vp", PERSON).id;
      const x = a.store.createIssue({ title: "Spike X" }).identifier;
      const y = a.store.createIssue({ title: "POC Y" }).identifier;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      // Offline on both: each links different research. Two fields, so both arrive, no conflict.
      a.use();
      a.store.plan().adopt(idea, x, "agent-a", { purpose: "exploration" });
      b.use();
      b.store.plan().adopt(idea, y, "agent-b", { purpose: "exploration" });
      await both(a, b);

      const expected = { state: "exploring", stage: "scheduled", linkCount: 0, progress: null, linked: [], exploration: [x, y].sort(), members: [] };
      expect(reading(a, idea)).toMatchObject(expected);
      expect(reading(b, idea)).toEqual(reading(a, idea));
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expect(reading(fresh, idea)).toEqual(reading(a, idea));

      // Relinked as delivery on B: every device moves it to the work list and starts the idea.
      b.use();
      b.store.plan().adopt(idea, x, "vp");
      await both(a, b);
      fresh.use();
      await fresh.sync();
      const started = { state: "started", linkCount: 1, linked: [x], exploration: [y], members: [x] };
      expect(reading(a, idea)).toMatchObject(started);
      expect(reading(b, idea)).toEqual(reading(a, idea));
      expect(reading(fresh, idea)).toEqual(reading(a, idea));
    });

    it(`converges when two devices link the same issue two ways offline: one field, a conflict the person settles (${fold} fold)`, async () => {
      const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
      fleet = new Fleet(server, REPO);
      const a = fleet.machine("a");
      const plan = a.store.plan();
      plan.enable("vp", { person: { via: "settings" } });
      const now = plan.view().horizons[0]!.id;
      const idea = plan.capture({ title: "Passkey auth", maturity: "shaped", horizon: now, plan: READY_PLAN }, "vp", PERSON).id;
      const x = a.store.createIssue({ title: "Ticket X" }).identifier;
      await a.sync();
      const b = fleet.machine("b");
      await b.sync();

      a.use();
      a.store.plan().adopt(idea, x, "agent-a", { purpose: "exploration" });
      b.use();
      b.store.plan().adopt(idea, x, "agent-b");
      await both(a, b);

      // One field, two answers: a conflict, never a silent overwrite. Each device keeps its own
      // value as the incumbent until someone picks, and the record names the link's field.
      const open = [...listConflicts(a.db).map((c) => ({ c, on: a })), ...listConflicts(b.db).map((c) => ({ c, on: b }))];
      expect(open.length).toBeGreaterThan(0);
      for (const { c } of open) expect(c.field).toMatch(/^planLink\./);
      // The person picks research: every device then reads it as research, and the idea unstarted.
      for (const { c, on } of open) {
        on.use();
        const remoteIsResearch = (c.remoteValue as { purpose?: string } | null)?.purpose === "exploration";
        resolveConflict(on.db, { id: c.id, choice: remoteIsResearch ? "remote" : "local", actor: "vp" });
      }
      await both(a, b, 3);
      const settled = { state: "shaped", linkCount: 0, linked: [], exploration: [x], members: [] };
      expect(reading(a, idea)).toMatchObject(settled);
      expect(reading(b, idea)).toEqual(reading(a, idea));
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
      const fresh = fleet.machine("fresh");
      await fresh.sync();
      expect(reading(fresh, idea)).toEqual(reading(a, idea));
    });
  }
});
