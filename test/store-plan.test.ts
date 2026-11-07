/**
 * The plan layer in the store (design/plan.md): ideas and horizons as reserved kinds, the
 * guards that keep them out of the tracker, Start / Adopt / Unlink and the facts derived from
 * linked work, the baseline, and who may steer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { HORIZON_KIND, IDEA_KIND, PLAN_KINDS_MISSING_MESSAGE } from "../src/core/plan.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

const PERSON = { person: { via: "plan_view" } } as const;

function memStore(): WorkspaceStore {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  return new WorkspaceStore(db, "test", "TST");
}

let store: WorkspaceStore;
let plan: PlanStore;
beforeEach(() => {
  store = memStore();
  plan = store.plan();
  plan.clock = () => new Date("2026-11-07T12:00:00.000Z");
  plan.enable("vp");
});

function refused(fn: () => unknown, code = "validation"): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe(code);
    return error as StapleError;
  }
  throw new Error(`expected a ${code} error`);
}

function horizon(name: string): string {
  return plan.view().horizons.find((h) => h.name === name)!.id;
}

function idea(title: string, extra: Parameters<PlanStore["capture"]>[0] extends infer I ? Partial<I> : never = {}): string {
  return plan.capture({ title, ...extra }, "vp", PERSON).identifier;
}

describe("enabling", () => {
  it("adds the two kinds and seeds Now, Next and Later once", () => {
    expect(store.getKinds().map((k) => k.id)).toEqual(expect.arrayContaining([IDEA_KIND, HORIZON_KIND]));
    expect(plan.view().horizons.map((h) => h.name)).toEqual(["Now", "Next", "Later"]);
    plan.enable("vp");
    expect(plan.view().horizons).toHaveLength(3);
  });

  it("refuses every write in a workspace that has not turned planning on", () => {
    const bare = memStore().plan();
    expect(bare.view().enabled).toBe(false);
    const error = refused(() => bare.capture({ title: "x" }, "vp", PERSON));
    expect(error.message).toBe(PLAN_KINDS_MISSING_MESSAGE);
  });
});

describe("guards: an idea never enters the tracker", () => {
  it("is never queued", () => {
    const ref = idea("Queue me");
    const error = refused(() => store.queue().enqueue(ref, {}, "agent"));
    expect(error.message).toContain("cannot be queued");
    expect(store.queue().entries({ all: true })).toHaveLength(0);
  });

  it("is never checked out", () => {
    const ref = idea("Take me");
    const error = refused(() => store.checkoutIssue(ref, "agent"));
    expect(error.message).toContain("cannot be checked out");
    expect(store.getIssue(ref).checkoutAgent).toBeNull();
  });

  it("is never an effective row, so next and next_task never pick it", () => {
    const ref = idea("Pick me", { maturity: "shaped" });
    const task = store.createIssue({ title: "Real work" }).identifier;
    const rows = store.queue().effectiveQueue({ actor: "agent" }).rows;
    expect(rows.map((r) => r.identifier)).toContain(task);
    expect(rows.map((r) => r.identifier)).not.toContain(ref);
    const ideaOnly = memStore();
    ideaOnly.plan().enable("vp");
    ideaOnly.plan().capture({ title: "Alone" }, "vp", PERSON);
    expect(ideaOnly.queue().effectiveQueue({ actor: "agent" }).rows).toHaveLength(0);
  });

  it("is never counted in a non-idea parent's derived status", () => {
    const epic = store.createIssue({ title: "Epic", kind: "epic" });
    const task = store.createIssue({ title: "Only task", parent: epic.identifier });
    const stray = idea("Stray idea");
    // A shape the parent guard refuses locally but another device could still deliver.
    store.db.prepare("UPDATE issues SET parent_id = ?, depth = 1 WHERE identifier = ?").run(epic.id, stray);
    store.checkoutIssue(task.identifier, "agent");
    store.updateIssue(task.identifier, { status: "done" }, "agent");
    expect(store.categoryOf(store.getIssue(epic.identifier).status)).toBe("done");
  });

  it("is never listed in a task view by default", () => {
    const ref = idea("Hidden");
    const task = store.createIssue({ title: "Visible" }).identifier;
    const listed = store.listIssues({}).map((i) => i.identifier);
    expect(listed).toContain(task);
    expect(listed).not.toContain(ref);
    expect(store.listIssues({ kind: [IDEA_KIND] }).map((i) => i.identifier)).toEqual([ref]);
    const inbox = store.inbox();
    expect([...inbox.ready, ...inbox.queued, ...inbox.blocked].map((i) => i.identifier)).not.toContain(ref);
    expect(store.tree().map((n) => n.issue.identifier)).not.toContain(ref);
    expect(store.listIssues({}).map((i) => i.kind)).not.toContain(HORIZON_KIND);
  });

  it("keeps tracker work and plans apart in the tree, in milestones and across kinds", () => {
    const ref = idea("Parent idea");
    expect(refused(() => store.createIssue({ title: "Task under idea", parent: ref })).message).toContain("tracker work cannot be filed under it");
    const task = store.createIssue({ title: "A task" }).identifier;
    expect(refused(() => plan.capture({ title: "Idea under task", parent: task }, "vp", PERSON)).message).toContain("must be another idea");
    expect(refused(() => store.updateIssue(ref, { kind: "task" }, "vp")).message).toContain("cannot change kind");
    expect(refused(() => store.updateIssue(task, { kind: IDEA_KIND }, "vp")).message).toContain("cannot change kind");
    store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    const milestone = store.createIssue({ title: "M", kind: MILESTONE_KIND }).identifier;
    expect(refused(() => store.milestones().addMember(milestone, ref, {}, "vp")).message).toContain("cannot be added to a milestone");
    expect(refused(() => store.removeKind(IDEA_KIND, { migrateTo: "task" }, "vp")).message).toContain("still use it");
  });
});

describe("ideas and horizons", () => {
  it("nest, carry maturity and horizon independently, and read their stage", () => {
    const ga = idea("Exercise GA", { maturity: "shaped", horizon: horizon("Now") });
    const r8 = plan.capture({ title: "R8 Mobile", parent: ga, horizon: horizon("Next") }, "vp", PERSON);
    const api = idea("Programming API", { maturity: "exploring", horizon: horizon("Next") });
    const sdk = idea("SDKs", { maturity: "shaped" });
    const view = plan.view();
    const of = (identifier: string) => view.ideas.find((i) => i.identifier === identifier)!;
    expect(of(ga).stage).toBe("scheduled");
    expect(of(ga).childIds).toEqual([r8.id]);
    expect(of(r8.identifier).horizonId).toBe(horizon("Next"));
    expect(of(api).stage).toBe("scheduled");
    expect(of(api).maturity).toBe("exploring");
    expect(of(sdk).stage).toBe("shaped");
    plan.update(sdk, { maturity: "dropped" }, "vp", PERSON);
    expect(plan.ideaView(sdk).stage).toBe("dropped");
  });

  it("orders horizons by date when created, renames, dates and removes them", () => {
    const mvp = plan.createHorizon({ name: "MVP", date: "2026-12-31" }, "vp", PERSON);
    expect(plan.view().horizons.map((h) => h.name)).toEqual(["MVP", "Now", "Next", "Later"]);
    plan.updateHorizon(mvp.identifier, { name: "Now · MVP", before: null }, "vp", PERSON);
    expect(plan.view().horizons.map((h) => h.name)).toEqual(["Now", "Next", "Later", "Now · MVP"]);
    const ref = idea("On it", { horizon: mvp.id });
    plan.removeHorizon(mvp.identifier, "vp", PERSON);
    expect(plan.view().horizons.map((h) => h.name)).toEqual(["Now", "Next", "Later"]);
    expect(plan.ideaView(ref).horizonId).toBeNull();
  });

  it("keeps questions, decisions and the brief as documents on the idea", () => {
    const ref = idea("Questions");
    plan.update(ref, { brief: "What and why." }, "agent");
    plan.addQuestion(ref, "Which units?", "agent");
    plan.addQuestion(ref, "Who owns it?", "agent");
    plan.resolveQuestion(ref, 1, "agent");
    const detail = plan.addDecision(ref, "Metric only", "agent");
    expect(detail.brief).toBe("What and why.");
    expect(detail.questions).toEqual([
      { text: "Which units?", resolved: true },
      { text: "Who owns it?", resolved: false },
    ]);
    expect(detail.decisions).toEqual(["2026-11-07: Metric only"]);
  });
});

describe("Start, Adopt and Unlink", () => {
  it("Start creates an epic with the brief as its plan document and links it", () => {
    const ref = idea("Programming API", { maturity: "shaped", brief: "The brief." });
    const started = plan.start(ref, {}, "vp", PERSON);
    const epic = store.getIssue(started.epic.identifier);
    expect(epic.kind).toBe("epic");
    expect(store.getDocument(epic.id, "plan").body).toBe("The brief.");
    expect(started.idea.links).toEqual([epic.id]);
    expect(started.idea.stage).toBe("started");
  });

  it("derives progress, actual dates and shipped from linked work, rolled up to the parent", () => {
    const parent = idea("Exercise GA", { maturity: "shaped" });
    const child = plan.capture({ title: "R0", parent }, "vp", PERSON).identifier;
    const epic = store.createIssue({ title: "EPIC-40", kind: "epic" });
    const a = store.createIssue({ title: "a", parent: epic.identifier });
    const b = store.createIssue({ title: "b", parent: epic.identifier });
    plan.adopt(child, epic.identifier, "agent");
    store.checkoutIssue(a.identifier, "agent");
    store.updateIssue(a.identifier, { status: "done" }, "agent");
    const half = plan.ideaView(parent);
    expect(half.stage).toBe("started");
    expect(half.progress).toBe(0.5);
    expect(half.actual.start).toBe(store.getIssue(a.identifier).startedAt!.slice(0, 10));
    expect(half.actual.end).toBeNull();
    store.checkoutIssue(b.identifier, "agent");
    store.updateIssue(b.identifier, { status: "done" }, "agent");
    expect(plan.ideaView(child).stage).toBe("shipped");
    expect(plan.ideaView(parent).stage).toBe("shipped");
    expect(plan.ideaView(parent).actual.end).not.toBeNull();
    plan.unlink(child, epic.identifier, "agent");
    expect(plan.ideaView(parent).stage).toBe("shaped");
  });

  it("Adopt refuses a plan-kind target and is idempotent", () => {
    const ref = idea("A");
    const other = idea("B");
    expect(refused(() => plan.adopt(ref, other, "agent")).message).toContain("only tracker work can be adopted");
    const task = store.createIssue({ title: "t" }).identifier;
    plan.adopt(ref, task, "agent");
    expect(plan.adopt(ref, task, "agent").links).toHaveLength(1);
  });

  it("flags lateness against the planned target and the horizon's date", () => {
    const now = plan.createHorizon({ name: "MVP", date: "2026-11-01" }, "vp", PERSON);
    const ref = idea("Late one", { maturity: "shaped", horizon: now.id });
    expect(plan.ideaView(ref).late).toBe(true);
    expect(plan.view().horizons.find((h) => h.id === now.id)!.late).toBe(true);
    const fine = idea("On time", { plannedStart: "2026-11-01", plannedTarget: "2026-12-01" });
    expect(plan.ideaView(fine).late).toBe(false);
  });
});

describe("the baseline", () => {
  it("does not exist before the idea is started; moving the window just moves it", () => {
    const ref = idea("Rung", { plannedStart: "2026-11-01", plannedTarget: "2026-11-30" });
    plan.update(ref, { plannedTarget: "2026-12-15" }, "vp", PERSON);
    const view = plan.ideaView(ref);
    expect(view.baseline).toBeNull();
    expect(view.planned).toEqual({ start: "2026-11-01", target: "2026-12-15" });
  });

  it("keeps the first window it has once started, through any re-plan, until reset explicitly", () => {
    const ref = idea("Rung", { plannedStart: "2026-11-01", plannedTarget: "2026-11-30" });
    plan.adopt(ref, store.createIssue({ title: "work" }).identifier, "agent");
    expect(plan.ideaView(ref).baseline).toEqual({ start: "2026-11-01", target: "2026-11-30" });
    plan.update(ref, { plannedStart: "2026-11-10", plannedTarget: "2026-12-20" }, "vp", PERSON);
    plan.update(ref, { title: "Rung renamed" }, "agent");
    let view = plan.ideaView(ref);
    expect(view.planned).toEqual({ start: "2026-11-10", target: "2026-12-20" });
    expect(view.baseline).toEqual({ start: "2026-11-01", target: "2026-11-30" });
    view = plan.resetBaseline(ref, "vp", PERSON);
    expect(view.baseline).toEqual({ start: "2026-11-10", target: "2026-12-20" });
  });

  it("takes the first window given after the start when the idea started undated", () => {
    const ref = idea("Undated");
    plan.adopt(ref, store.createIssue({ title: "work" }).identifier, "agent");
    expect(plan.ideaView(ref).baseline).toBeNull();
    plan.update(ref, { plannedStart: "2026-11-02", plannedTarget: "2026-11-09" }, "vp", PERSON);
    plan.update(ref, { plannedTarget: "2026-11-20" }, "vp", PERSON);
    expect(plan.ideaView(ref).baseline).toEqual({ start: "2026-11-02", target: "2026-11-09" });
  });

  it("cannot be reset on an idea that is not started", () => {
    const ref = idea("Not started", { plannedTarget: "2026-12-01" });
    expect(refused(() => plan.resetBaseline(ref, "vp", PERSON)).message).toContain("not started");
  });
});

describe("agents capture, the person steers", () => {
  const steering = (fn: () => unknown) => {
    const error = refused(fn);
    expect(error.message).toMatch(/person's call|not shaped yet/);
    return error;
  };

  it("lets an agent capture raw ideas and do the capture-side edits", () => {
    const ref = plan.capture({ title: "Agent idea", brief: "why" }, "agent").identifier;
    expect(plan.ideaView(ref).maturity).toBe("raw");
    plan.update(ref, { title: "Agent idea, renamed", brief: "why, better" }, "agent");
    plan.addQuestion(ref, "q?", "agent");
    plan.resolveQuestion(ref, 1, "agent");
    plan.addDecision(ref, "d", "agent");
    const task = store.createIssue({ title: "t" }).identifier;
    plan.adopt(ref, task, "agent");
    plan.unlink(ref, task, "agent");
    expect(plan.detail(ref).idea.title).toBe("Agent idea, renamed");
  });

  it("refuses an agent's capture of anything but a raw, unscheduled, undated idea", () => {
    steering(() => plan.capture({ title: "x", maturity: "shaped" }, "agent"));
    steering(() => plan.capture({ title: "x", horizon: horizon("Now") }, "agent"));
    steering(() => plan.capture({ title: "x", plannedTarget: "2026-12-01" }, "agent"));
  });

  it("refuses an agent's change to maturity, horizon, parent, planned dates and order", () => {
    const ref = plan.capture({ title: "Mine" }, "agent").identifier;
    const other = plan.capture({ title: "Other" }, "agent").identifier;
    steering(() => plan.update(ref, { maturity: "exploring" }, "agent"));
    steering(() => plan.update(ref, { horizon: horizon("Now") }, "agent"));
    steering(() => plan.update(ref, { parent: other }, "agent"));
    steering(() => plan.update(ref, { plannedStart: "2026-11-01" }, "agent"));
    steering(() => plan.update(ref, { plannedTarget: "2026-11-01" }, "agent"));
    steering(() => plan.update(ref, { before: other }, "agent"));
    const view = plan.ideaView(ref);
    expect(view.maturity).toBe("raw");
    expect(view.horizonId).toBeNull();
    expect(view.planned).toEqual({ start: null, target: null });
  });

  it("refuses an agent's horizon definitions and dates", () => {
    const now = plan.view().horizons[0]!;
    steering(() => plan.createHorizon({ name: "Q2" }, "agent"));
    steering(() => plan.updateHorizon(now.identifier, { name: "Today" }, "agent"));
    steering(() => plan.updateHorizon(now.identifier, { date: "2026-12-31" }, "agent"));
    steering(() => plan.removeHorizon(now.identifier, "agent"));
    expect(plan.view().horizons.map((h) => [h.name, h.date])).toEqual([
      ["Now", null],
      ["Next", null],
      ["Later", null],
    ]);
  });

  it("refuses an agent's baseline reset", () => {
    const ref = idea("Started", { plannedTarget: "2026-12-01" });
    plan.adopt(ref, store.createIssue({ title: "w" }).identifier, "agent");
    steering(() => plan.resetBaseline(ref, "agent"));
  });

  it("lets an agent start only an idea the person marked shaped", () => {
    const raw = plan.capture({ title: "Raw" }, "agent").identifier;
    steering(() => plan.start(raw, {}, "agent"));
    expect(plan.ideaView(raw).links).toEqual([]);
    plan.update(raw, { maturity: "shaped" }, "vp", PERSON);
    expect(plan.start(raw, {}, "agent").idea.stage).toBe("started");
    const person = idea("Person starts raw");
    expect(plan.start(person, {}, "vp", PERSON).idea.stage).toBe("started");
  });
});
