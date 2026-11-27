/**
 * Maturity moves by enrichment (design/plan.md, "Maturity moves by enrichment"): a write that makes
 * a raw idea more complete moves it to exploring, whoever makes it; capture and title or brief
 * edits never do, and nothing moves an idea to shaped. An agent may propose it shaped, which the
 * person sees under Needs you and accepts with Mark shaped in one action, or dismisses. The same on
 * the device that wrote it, on one that received it by sync and on a freshly hydrated one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openDb } from "../src/core/db.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { WORKSPACE_TARGET } from "../src/core/migrations/workspace/index.js";
import { FakeSyncServer } from "./fixtures/fake-sync-server.js";
import { Fleet, type Machine } from "./fixtures/sync-machines.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;
const REPO = "5eed0000-0000-4000-8000-0000000005a9";

function refused(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

describe("migration 29", () => {
  it("adds the explored flag as NULL on every existing record, so none of them moves", () => {
    const db = new DatabaseSync(":memory:");
    db.exec("PRAGMA foreign_keys=ON");
    const ordered = [...WORKSPACE_TARGET.migrations].sort((a, b) => a.version - b.version);
    for (const migration of ordered.filter((m) => m.version < 29)) migration.up(db);
    db.prepare("INSERT INTO issues (id, identifier, title, normalized_title, status, priority, created_at, updated_at, kind, plan_maturity) VALUES ('idea', 'I-TST-1', 'Idea', 'idea', 'backlog', 'medium', 't', 't', 'idea', 'raw')").run();
    ordered.find((m) => m.version === 29)!.up(db);
    expect(db.prepare("SELECT plan_maturity, plan_explored FROM issues").all()).toEqual([{ plan_maturity: "raw", plan_explored: null }]);
    db.close();
  });
});

describe("enrichment on one device", () => {
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

  const raw = (title = "Passkey auth") => plan.capture({ title, brief: "Sign in without a password." }, "agent").id;
  /** An import: a capture that comes with its plan, questions and decisions (and its file attached). */
  const imported = (title: string) =>
    plan.importPlan(
      { name: `${title}.md`, content: `# ${title}\n\n## Goal\n\nSign in without a password.\n\n## Open questions\n\n- [ ] Which browsers?\n\n## Decisions\n\n- WebAuthn only\n` },
      {},
      "agent",
    ).idea.idea.id;
  const maturityOf = (id: string) => plan.ideaView(id).maturity;
  const stateOf = (id: string) => plan.ideaView(id).state;

  it("stays raw on capture, even with plan sections, questions and decisions, and on title and brief edits", () => {
    const captured = plan.capture({ title: "Captured", plan: READY_PLAN }, "agent").id;
    expect(maturityOf(captured)).toBe("raw");
    const fromFile = imported("Imported");
    expect(plan.detail(fromFile)).toMatchObject({ questions: [{ text: "Which browsers?" }] });
    expect(maturityOf(fromFile)).toBe("raw");
    const idea = raw();
    plan.update(idea, { title: "Passkeys", brief: "Sign in with a passkey." }, "agent");
    store.updateIssue(idea, { title: "Passkeys everywhere" }, "agent");
    store.putDocument(idea, "brief", "Rewritten brief.", { author: "agent" });
    expect(maturityOf(idea)).toBe("raw");
    expect(stateOf(idea)).toBe("raw");
  });

  const enrichments: Array<[string, (id: string, actor: string) => void]> = [
    ["a plan section", (id, actor) => plan.update(id, { plan: { goal: "Sign in without a password." } }, actor)],
    ["a breakdown row", (id, actor) => plan.update(id, { plan: { breakdown: [{ key: "1", title: "Register a passkey" }] as never } }, actor)],
    ["a question", (id, actor) => plan.addQuestion(id, "Which browsers?", actor)],
    ["a decision", (id, actor) => plan.addDecision(id, "WebAuthn only", actor)],
    ["linked research", (id, actor) => plan.adopt(id, store.createIssue({ title: "Spike: WebAuthn libraries" }).identifier, actor, { purpose: "exploration" })],
    ["a raw document write of a plan section", (id, actor) => store.putDocument(id, "risks", "Lost devices.", { author: actor })],
    ["a raw document write of the questions", (id, actor) => store.putDocument(id, "questions", "- [ ] Which browsers?\n", { author: actor })],
  ];
  for (const [what, write] of enrichments) {
    for (const actor of ["agent", "vp"]) {
      it(`moves raw to exploring on ${what}, written by ${actor}`, () => {
        const idea = raw();
        write(idea, actor);
        const view = plan.ideaView(idea);
        expect(view).toMatchObject({ maturity: "exploring", state: "exploring", stage: "exploring" });
        expect(view.actions.map((a) => a.id)).toContain("schedule");
        const event = store.db.prepare("SELECT actor, payload FROM events WHERE kind = 'idea_explored' AND issue_id = ?").all(idea) as Array<{ actor: string; payload: string }>;
        expect(event).toHaveLength(1);
        expect(event[0]!.actor).toBe(actor);
      });
    }
  }

  it("moves on answering and deferring a question that was captured with it", () => {
    const answered = imported("A");
    plan.resolveQuestion(answered, 1, "agent");
    expect(maturityOf(answered)).toBe("exploring");
    const deferred = imported("B");
    plan.deferQuestion(deferred, 1, "agent");
    expect(maturityOf(deferred)).toBe("exploring");
  });

  it("moves nothing on a plan write that changes nothing, and never moves an idea past exploring", () => {
    const idea = plan.capture({ title: "Ready", plan: READY_PLAN }, "agent").id;
    plan.update(idea, { plan: { goal: READY_PLAN.goal } }, "agent");
    expect(maturityOf(idea)).toBe("raw");
    plan.addDecision(idea, "Ship it", "agent");
    expect(maturityOf(idea)).toBe("exploring");
    plan.addDecision(idea, "Ship it again", "agent");
    expect(maturityOf(idea)).toBe("exploring");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM events WHERE kind = 'idea_explored'").get()).toEqual({ n: 1 });
  });

  it("leaves a maturity the person set in the same write, and an idea already past raw, as it is", () => {
    const shaped = raw("Shaped in one write");
    plan.update(shaped, { maturity: "shaped", plan: READY_PLAN }, "vp", PERSON);
    expect(maturityOf(shaped)).toBe("shaped");
    plan.addQuestion(shaped, "One more?", "agent");
    expect(maturityOf(shaped)).toBe("shaped");
    expect(store.db.prepare("SELECT plan_explored FROM issues WHERE id = ?").get(shaped)).toEqual({ plan_explored: null });
  });

  it("is never moved back to raw once explored, and a dropped one restores into exploring", () => {
    const idea = raw();
    plan.addQuestion(idea, "Which browsers?", "agent");
    expect(refused(() => plan.update(idea, { maturity: "raw" }, "vp", PERSON)).message).toMatch(/cannot be moved back to raw/);
    const now = plan.view().horizons[0]!.id;
    plan.update(idea, { horizon: now }, "vp", PERSON);
    plan.update(idea, { maturity: "dropped" }, "vp", PERSON);
    expect(maturityOf(idea)).toBe("dropped");
    // Restored to raw while it holds a horizon: it was explored, so it lands exploring, which holds one.
    plan.update(idea, { maturity: "raw" }, "vp", PERSON);
    expect(plan.ideaView(idea)).toMatchObject({ maturity: "exploring", horizonId: now });
    // And a restore into raw that schedules it in the same write is held to exploring, which offers it.
    plan.update(idea, { maturity: "dropped" }, "vp", PERSON);
    const next = plan.view().horizons[1]!.id;
    expect(plan.update(idea, { maturity: "raw", horizon: next }, "vp", PERSON)).toMatchObject({ maturity: "exploring", horizonId: next });
  });

  it("refuses an agent moving maturity by hand, and says enrichment and a proposal are its way", () => {
    const idea = raw();
    const error = refused(() => plan.update(idea, { maturity: "exploring" }, "agent"));
    expect(error.message).toMatch(/moves a raw idea to exploring on its own/);
    expect(error.message).toMatch(/propose it shaped/);
  });

  it("reads the same through provenance as through the plan", () => {
    const idea = raw();
    plan.addDecision(idea, "WebAuthn only", "agent");
    const spark = store.createIssue({ title: "Work" }).identifier;
    const sparked = plan.capture({ title: "Sparked", sparkedBy: spark } as never, "agent").id;
    plan.addQuestion(sparked, "Why?", "agent");
    const shown = store.getIssue(spark);
    expect(maturityOf(sparked)).toBe("exploring");
    expect(JSON.stringify(plan.ideaView(sparked).maturity)).toContain("exploring");
    expect(shown).toBeDefined();
  });

  describe("a proposal to be marked shaped", () => {
    it("is anyone's, held to the shaped gate, and shown with who proposed it and why", () => {
      const idea = raw();
      const gate = refused(() => plan.update(idea, { proposeShaped: { note: "Looks done" } }, "agent"));
      expect(gate.message).toMatch(/cannot be proposed shaped yet: it needs a goal/);
      expect(plan.ideaView(idea).shapeProposal).toBeNull();

      const view = plan.update(idea, { plan: READY_PLAN, proposeShaped: { note: "Goal, breakdown and acceptance are settled." } }, "agent");
      expect(view.maturity).toBe("exploring");
      expect(view.shapeProposal).toMatchObject({ by: "agent", note: "Goal, breakdown and acceptance are settled." });
      expect(view.actions.map((a) => a.id)).toEqual(expect.arrayContaining(["shape", "propose_shape", "dismiss_proposal"]));
      expect(view.actions.find((a) => a.id === "shape")!.disabledReason).toBeUndefined();
    });

    it("keeps the idea raw when its plan came with the capture, and never shapes it", () => {
      const idea = plan.capture({ title: "Imported", plan: READY_PLAN }, "agent").id;
      const view = plan.update(idea, { proposeShaped: {} }, "agent");
      expect(view).toMatchObject({ maturity: "raw", state: "raw", shapeProposal: { by: "agent", note: null } });
    });

    it("waits under Needs you: a scheduled record's next step is the person's Mark shaped", () => {
      const now = plan.view().horizons[0]!.id;
      const idea = plan.capture({ title: "On Now", maturity: "exploring", horizon: now, plan: { goal: "G" } }, "vp", PERSON).id;
      expect(plan.ideaView(idea).nextStep).toMatchObject({ need: "write_plan", who: "agent" });
      plan.update(idea, { plan: READY_PLAN, proposeShaped: {} }, "agent");
      expect(plan.ideaView(idea).nextStep).toMatchObject({ need: "mark_shaped", who: "person" });
      expect(plan.ideaView(idea).nextStep!.instruction).toMatch(/was proposed shaped/);
      expect(plan.view().horizons.find((h) => h.id === now)!.needsYou).toBe(1);
      // A raw descendant a horizon carries is an agent's to brainstorm, unless it was proposed.
      const sub = plan.capture({ title: "Sub", parent: idea, plan: READY_PLAN }, "agent").id;
      expect(plan.ideaView(sub).nextStep).toMatchObject({ need: "brainstorm", who: "agent" });
      plan.update(sub, { proposeShaped: {} }, "agent");
      expect(plan.ideaView(sub).nextStep).toMatchObject({ need: "mark_shaped", who: "person" });
    });

    it("is accepted by the person in one action, which clears it, and never by an agent", () => {
      const idea = raw();
      plan.update(idea, { plan: READY_PLAN, proposeShaped: {} }, "agent");
      expect(refused(() => plan.update(idea, { maturity: "shaped" }, "agent")).message).toMatch(/person's call/);
      const accepted = plan.update(idea, { maturity: "shaped" }, "vp", PERSON);
      expect(accepted).toMatchObject({ maturity: "shaped", state: "shaped", shapeProposal: null });
      // Back to exploring, the old proposal does not come back with it.
      expect(plan.update(idea, { maturity: "exploring" }, "vp", PERSON).shapeProposal).toBeNull();
    });

    it("is dismissed by the person only, and refused on a shaped record or when there is none", () => {
      const idea = raw();
      expect(refused(() => plan.update(idea, { dismissProposal: true }, "vp", PERSON)).message).toMatch(/no proposal to dismiss/);
      plan.update(idea, { plan: READY_PLAN, proposeShaped: {} }, "agent");
      expect(refused(() => plan.update(idea, { dismissProposal: true }, "agent")).message).toMatch(/person's call/);
      const dismissed = plan.update(idea, { dismissProposal: true }, "vp", PERSON);
      expect(dismissed).toMatchObject({ maturity: "exploring", shapeProposal: null });
      expect(dismissed.actions.map((a) => a.id)).not.toContain("dismiss_proposal");
      plan.update(idea, { maturity: "shaped" }, "vp", PERSON);
      expect(refused(() => plan.update(idea, { proposeShaped: {} }, "agent")).message).toMatch(/is shaped; it cannot be proposed for shaped/);
    });

    it("on a record that started while exploring, is the person's step and counts under the horizon's Needs you", () => {
      const now = plan.view().horizons[0]!.id;
      const idea = plan.capture({ title: "Started exploring", maturity: "exploring", horizon: now, plan: READY_PLAN }, "vp", PERSON).id;
      plan.adopt(idea, store.createIssue({ title: "Existing work" }).identifier, "agent");
      expect(plan.ideaView(idea)).toMatchObject({ state: "started", maturity: "exploring", nextStep: null });
      plan.update(idea, { proposeShaped: {} }, "agent");
      expect(plan.ideaView(idea).nextStep).toMatchObject({ need: "mark_shaped", who: "person" });
      expect(plan.view().horizons.find((h) => h.id === now)!.needsYou).toBe(1);
    });

    it("is settled by the delivered mark, so clearing the mark does not bring it back", () => {
      const idea = raw();
      plan.update(idea, { plan: READY_PLAN, proposeShaped: { note: "old" } }, "agent");
      plan.update(idea, { delivered: { on: "2026-11-01" } }, "vp", PERSON);
      plan.update(idea, { delivered: null }, "vp", PERSON);
      expect(plan.ideaView(idea)).toMatchObject({ maturity: "exploring", shapeProposal: null });
    });

    it("refuses proposing and dismissing in one write, and tells an agent that dismissing is the person's", () => {
      const idea = raw();
      plan.update(idea, { plan: READY_PLAN, proposeShaped: {} }, "agent");
      expect(refused(() => plan.update(idea, { proposeShaped: {}, dismissProposal: true }, "vp", PERSON)).message).toMatch(/not both/);
      expect(refused(() => plan.update(idea, { dismissProposal: true }, "agent")).message).toMatch(/Dismissing the shaped proposal of .* is the person's call/);
    });

    it("cannot be written as a raw document", () => {
      const idea = raw();
      expect(refused(() => store.putDocument(idea, "shape-proposal", "Shape it", { author: "agent" })).message).toMatch(/written by proposing it/);
    });

    it("holds Mark shaped back when the plan was emptied since, and lists it as the gate's to fix", () => {
      const idea = raw();
      plan.update(idea, { plan: READY_PLAN, proposeShaped: {} }, "agent");
      plan.update(idea, { plan: { goal: null } }, "agent");
      const view = plan.ideaView(idea);
      expect(view.shapeProposal).not.toBeNull();
      expect(view.actions.find((a) => a.id === "shape")!.disabledReason).toMatch(/goal/);
      expect(refused(() => plan.update(idea, { maturity: "shaped" }, "vp", PERSON)).message).toMatch(/cannot be marked shaped yet/);
    });
  });
});

describe("enrichment over sync", () => {
  let fleet: Fleet | null = null;
  afterEach(() => {
    fleet?.close();
    fleet = null;
  });

  function reading(machine: Machine, idea: string) {
    const plan = machine.store.plan();
    plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
    const view = plan.ideaView(idea);
    return { maturity: view.maturity, state: view.state, stage: view.stage, actions: view.actions.map((a) => a.id), proposal: view.shapeProposal?.note ?? null, step: view.nextStep?.need ?? null };
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

  async function pair(fold: "service" | "tail"): Promise<{ a: Machine; b: Machine; idea: string }> {
    const server = new FakeSyncServer({ repositoryId: REPO, ...(fold === "tail" ? { maxSnapshotFoldOps: 3 } : {}) });
    fleet = new Fleet(server, REPO);
    const a = fleet.machine("a");
    a.store.plan().enable("vp", { person: { via: "settings" } });
    const idea = a.store.plan().capture({ title: "Passkey auth" }, "agent").id;
    await a.sync();
    const b = fleet.machine("b");
    await b.sync();
    return { a, b, idea };
  }

  for (const fold of ["service", "tail"] as const) {
    it(`two devices enriching one raw idea offline both read exploring, with no conflict (${fold} fold)`, async () => {
      const { a, b, idea } = await pair(fold);
      a.use();
      a.store.plan().addQuestion(idea, "Which browsers?", "agent-a");
      b.use();
      b.store.plan().addDecision(idea, "WebAuthn only", "agent-b");
      await both(a, b);
      expect(reading(a, idea)).toMatchObject({ maturity: "exploring", state: "exploring" });
      expect(reading(b, idea)).toEqual(reading(a, idea));
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(reading(fresh, idea)).toEqual(reading(a, idea));
    });

    it(`the person's shape on one device stands over an agent's enrichment on another, with no conflict (${fold} fold)`, async () => {
      const { a, b, idea } = await pair(fold);
      // The plan is written first, so the person can shape it; the idea is exploring by then.
      a.use();
      a.store.plan().update(idea, { plan: READY_PLAN, proposeShaped: { note: "Ready" } }, "agent-a");
      await both(a, b);
      expect(reading(b, idea)).toMatchObject({ maturity: "exploring", proposal: "Ready" });

      // Offline: the person accepts on A; an agent adds a decision on B.
      a.use();
      a.store.plan().update(idea, { maturity: "shaped" }, "vp", PERSON);
      b.use();
      b.store.plan().addDecision(idea, "Keep passwords as a fallback", "agent-b");
      await both(a, b);
      expect(reading(a, idea)).toMatchObject({ maturity: "shaped", state: "shaped", proposal: null });
      expect(reading(b, idea)).toEqual(reading(a, idea));
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(reading(fresh, idea)).toEqual(reading(a, idea));
    });

    it(`a raw idea the person shapes on one device while an agent enriches it on another ends shaped everywhere (${fold} fold)`, async () => {
      const { a, b, idea } = await pair(fold);
      a.use();
      a.store.plan().update(idea, { maturity: "shaped", plan: READY_PLAN }, "vp", PERSON);
      b.use();
      b.store.plan().addQuestion(idea, "Which browsers?", "agent-b");
      b.store.plan().resolveQuestion(idea, 1, "agent-b");
      await both(a, b);
      expect(reading(a, idea)).toMatchObject({ maturity: "shaped" });
      expect(reading(b, idea)).toEqual(reading(a, idea));
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
      const fresh = fleet!.machine("fresh");
      await fresh.sync();
      expect(reading(fresh, idea)).toEqual(reading(a, idea));
    });

    it(`a drop on one device stands over an enrichment on another (${fold} fold)`, async () => {
      const { a, b, idea } = await pair(fold);
      a.use();
      a.store.plan().update(idea, { maturity: "dropped" }, "vp", PERSON);
      b.use();
      b.store.plan().update(idea, { plan: { goal: "Sign in without a password." } }, "agent-b");
      await both(a, b);
      expect(reading(a, idea)).toMatchObject({ maturity: "dropped", state: "dropped" });
      expect(reading(b, idea)).toEqual(reading(a, idea));
      expect(conflicts(a)).toEqual([]);
      expect(conflicts(b)).toEqual([]);
    });
  }
});
