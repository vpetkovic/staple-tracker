/**
 * The plan layer in the store (design/plan.md): ideas as a reserved kind with no ticket number,
 * horizons as milestones the plan shows as columns, membership derived from the plan, the guards
 * that keep ideas out of the tracker, Promote / Adopt / Unlink and the facts derived from linked
 * work, the baseline, and who may steer.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { formerHolders, pendingIdentifierMoves } from "../src/core/identifier-moves.js";
import { parseIdentifier } from "../src/core/ids.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { IDEA_KIND, PLAN_KINDS_MISSING_MESSAGE, isDraftIdentifier } from "../src/core/plan.js";
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

/**
 * Capture an idea as the person; answers its id, the only handle an unpromoted idea has. Shaped
 * unless told otherwise: the state that may be scheduled, dated, linked and promoted.
 */
function idea(title: string, extra: Parameters<PlanStore["capture"]>[0] extends infer I ? Partial<I> : never = {}): string {
  return plan.capture({ title, maturity: "shaped", ...extra }, "vp", PERSON).id;
}

function counter(): string {
  return (store.db.prepare("SELECT value FROM meta WHERE key = 'next_issue_number'").get() as { value: string } | undefined)?.value ?? "1";
}

/** The issue ids a milestone holds, in its order. */
function membersOf(milestone: string): string[] {
  return store.milestones().get(milestone).members.map((member) => member.issueId);
}

function finish(identifier: string): void {
  store.checkoutIssue(identifier, "agent");
  store.updateIssue(identifier, { status: "done" }, "agent");
}

describe("enabling", () => {
  it("adds the idea and milestone kinds and seeds Now, Next and Later once, as milestones", () => {
    expect(store.getKinds().map((k) => k.id)).toEqual(expect.arrayContaining([IDEA_KIND, MILESTONE_KIND]));
    const horizons = plan.view().horizons;
    expect(horizons.map((h) => h.name)).toEqual(["Now", "Next", "Later"]);
    for (const h of horizons) expect(store.getIssue(h.id).kind).toBe(MILESTONE_KIND);
    expect(store.milestones().list().map((m) => m.milestone.title)).toEqual(expect.arrayContaining(["Now", "Next", "Later"]));
    plan.enable("vp");
    expect(plan.view().horizons).toHaveLength(3);
  });

  it("refuses every write in a workspace that has not turned planning on", () => {
    const bare = memStore().plan();
    expect(bare.view().enabled).toBe(false);
    const error = refused(() => bare.capture({ title: "x" }, "vp", PERSON));
    expect(error.message).toBe(PLAN_KINDS_MISSING_MESSAGE);
  });

  it("is not turned on by milestones of its own: only a milestone the plan ranks is a horizon", () => {
    const own = memStore();
    own.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
    own.addKind({ id: IDEA_KIND, label: "Idea" }, "vp");
    own.createIssue({ title: "Release 1", kind: MILESTONE_KIND });
    expect(own.planningOn()).toBe(false);
  });
});

describe("identity: an idea holds no ticket number until it is promoted", () => {
  it("captures without consuming the counter, under an identifier that never parses as a ticket ref", () => {
    const before = counter();
    const id = idea("Numberless");
    plan.capture({ title: "Agent's numberless" }, "agent");
    store.createIssue({ title: "Raw via create", kind: IDEA_KIND, createdBy: "agent" });
    expect(counter()).toBe(before);
    const stored = store.getIssue(id).identifier;
    expect(isDraftIdentifier(stored)).toBe(true);
    expect(parseIdentifier(stored)).toBeNull();
    expect(stored).not.toMatch(/^[A-Z]+-\d+$/);
  });

  it("shows no identifier for an idea anywhere the plan answers, and names it by title in refusals", () => {
    const id = idea("Quiet one");
    expect(plan.ideaView(id).identifier).toBeNull();
    expect(plan.view().ideas.find((i) => i.id === id)!.identifier).toBeNull();
    const error = refused(() => store.queue().enqueue(id, {}, "agent"));
    expect(error.message).toMatch(/the idea "Quiet one"/i);
    expect(error.message).not.toContain("~");
  });

  it("gives each idea a distinct draft identifier", () => {
    const ids = Array.from({ length: 20 }, (_, n) => idea(`Idea ${n}`));
    const drafts = new Set(ids.map((id) => store.getIssue(id).identifier));
    expect(drafts.size).toBe(20);
  });

  it("allocates the next real number at promotion, through the tracker's own counter", () => {
    const first = store.createIssue({ title: "Before" }).identifier;
    const id = idea("Promote me", { maturity: "shaped" });
    const second = store.createIssue({ title: "Between" }).identifier;
    const promoted = plan.promote(id, "vp", PERSON);
    const n = (ref: string) => parseIdentifier(ref)!.number;
    expect(n(second)).toBe(n(first) + 1);
    expect(n(promoted.identifier!)).toBe(n(second) + 1);
    expect(store.createIssue({ title: "After" }).identifier).toBe(`TST-${n(promoted.identifier!) + 1}`);
  });

  it("turns ideas an earlier build numbered back into drafts when planning is enabled again", () => {
    const id = idea("Numbered by v1");
    // What an earlier build left: the idea took a ticket number at capture.
    store.db.prepare("UPDATE issues SET identifier = 'TST-77' WHERE id = ?").run(id);
    plan.enable("vp");
    expect(isDraftIdentifier(store.getIssue(id).identifier)).toBe(true);
    expect(store.db.prepare("SELECT 1 FROM issues WHERE identifier = 'TST-77'").get()).toBeUndefined();
    const event = store.db.prepare("SELECT payload FROM events WHERE kind = 'idea_drafted' AND issue_id = ?").get(id) as { payload: string } | undefined;
    expect(JSON.parse(event!.payload)).toEqual({ from: "TST-77" });
    // The number it gave up still names it here, as it does on every device that applies the move.
    expect(formerHolders(store.db, "TST-77").map((holder) => holder.issueId)).toEqual([id]);
    expect(store.getIssue("TST-77").id).toBe(id);
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
    expect(rows.map((r) => r.issueId)).not.toContain(ref);
    const ideaOnly = memStore();
    ideaOnly.plan().enable("vp");
    ideaOnly.plan().capture({ title: "Alone" }, "vp", PERSON);
    expect(ideaOnly.queue().effectiveQueue({ actor: "agent" }).rows).toHaveLength(0);
  });

  it("is never emitted by the resolver even when another device's plan holds it", () => {
    const ref = idea("Synced into the plan", { maturity: "shaped" });
    const epic = store.createIssue({ title: "Epic", kind: "epic" });
    const stray = idea("Stray under the epic");
    // Shapes the local guards refuse but a sync could still deliver: an idea in the queue,
    // and an idea under a queued container.
    store.db.prepare("INSERT INTO queue_entries (issue_id, rank, added_by, added_at) VALUES (?, 1024, 'other', '2026-11-01T00:00:00.000Z')").run(ref);
    store.db.prepare("UPDATE issues SET parent_id = ?, depth = 1 WHERE id = ?").run(epic.id, stray);
    store.queue().enqueue(epic.identifier, {}, "vp");
    const rows = store.queue().effectiveQueue({ actor: "agent" }).rows.map((r) => r.issueId);
    expect(rows).not.toContain(ref);
    expect(rows).not.toContain(stray);
  });

  it("is never counted in a non-idea parent's derived status", () => {
    const epic = store.createIssue({ title: "Epic", kind: "epic" });
    const task = store.createIssue({ title: "Only task", parent: epic.identifier });
    const stray = idea("Stray idea");
    // A shape the parent guard refuses locally but another device could still deliver.
    store.db.prepare("UPDATE issues SET parent_id = ?, depth = 1 WHERE id = ?").run(epic.id, stray);
    finish(task.identifier);
    expect(store.categoryOf(store.getIssue(epic.identifier).status)).toBe("done");
  });

  it("is never listed in a task view by default", () => {
    const ref = idea("Hidden");
    const task = store.createIssue({ title: "Visible" }).identifier;
    const listed = store.listIssues({}).map((i) => i.id);
    expect(listed).toContain(store.getIssue(task).id);
    expect(listed).not.toContain(ref);
    expect(store.listIssues({ kind: [IDEA_KIND] }).map((i) => i.id)).toEqual([ref]);
    const inbox = store.inbox();
    expect([...inbox.ready, ...inbox.queued, ...inbox.blocked].map((i) => i.id)).not.toContain(ref);
    expect(store.tree().map((n) => n.issue.id)).not.toContain(ref);
  });

  it("keeps tracker work and plans apart in the tree, in milestones and across kinds", () => {
    const ref = idea("Parent idea");
    expect(refused(() => store.createIssue({ title: "Task under idea", parent: ref })).message).toContain("tracker work cannot be filed under it");
    const task = store.createIssue({ title: "A task" }).identifier;
    expect(refused(() => plan.capture({ title: "Idea under task", parent: task }, "vp", PERSON)).message).toContain("must be another idea");
    expect(refused(() => store.updateIssue(ref, { kind: "task" }, "vp")).message).toContain("cannot change kind");
    expect(refused(() => store.updateIssue(task, { kind: IDEA_KIND }, "vp")).message).toContain("cannot change kind");
    const milestone = store.createIssue({ title: "M", kind: MILESTONE_KIND }).identifier;
    expect(refused(() => store.milestones().addMember(milestone, ref, {}, "vp")).message).toContain("cannot be added to a milestone");
    expect(refused(() => store.removeKind(IDEA_KIND, { migrateTo: "task" }, "vp")).message).toContain("still use it");
  });
});

describe("the tracker's own writes follow the person rule", () => {
  it("makes a milestone created through the tracker an ordinary milestone, never a column", () => {
    const made = store.createIssue({ title: "Autopilot milestone", kind: MILESTONE_KIND, createdBy: "agent" });
    expect(plan.view().horizons.map((h) => h.name)).toEqual(["Now", "Next", "Later"]);
    expect(store.updateIssue(made.identifier, { title: "Renamed by its agent" }, "agent").title).toBe("Renamed by its agent");
    store.milestones().update(made.identifier, { targetDate: "2026-12-01" }, "agent");
    expect(store.milestones().get(made.identifier).milestone.targetDate).toBe("2026-12-01");
  });

  it("makes an idea made through the tracker's create a raw, captured idea", () => {
    const made = store.createIssue({ title: "Agent idea via create_task", kind: IDEA_KIND, createdBy: "agent" });
    expect(plan.ideaView(made.id)).toMatchObject({ maturity: "raw", stage: "raw", identifier: null });
    expect(plan.ideaView(made.id).rank).toBeGreaterThan(0);
  });

  it("refuses a horizon edited through the tracker's update: name, status or anything else", () => {
    const now = plan.view().horizons[0]!;
    const ref = idea("On Now", { horizon: now.id });
    expect(refused(() => store.updateIssue(now.identifier, { title: "Renamed by agent" }, "agent")).message).toContain("the person's call");
    expect(refused(() => store.updateIssue(now.identifier, { status: "cancelled" }, "agent")).message).toContain("the person's call");
    expect(refused(() => store.updateIssue(now.identifier, { priority: "high" }, "agent")).message).toContain("the person's call");
    expect(plan.view().horizons.map((h) => h.name)).toEqual(["Now", "Next", "Later"]);
    expect(plan.ideaView(ref).horizonId).toBe(now.id);
  });

  it("refuses a horizon's dates moved through the milestone surface", () => {
    const now = plan.view().horizons[0]!;
    expect(refused(() => store.milestones().update(now.identifier, { targetDate: "2026-12-31" }, "agent")).message).toContain("the person's call");
    expect(refused(() => store.milestones().update(now.identifier, { startDate: "2026-11-01" }, "agent")).message).toContain("the person's call");
    expect(plan.view().horizons[0]!.date).toBeNull();
    plan.updateHorizon(now.id, { date: "2026-12-31" }, "vp", PERSON);
    expect(store.milestones().get(now.identifier).milestone.targetDate).toBe("2026-12-31");
  });

  it("refuses an idea's status moved through the tracker's update, and keeps its title editable", () => {
    const ref = idea("Keep me on the board");
    for (const status of ["cancelled", "done", "in_progress"]) {
      expect(refused(() => store.updateIssue(ref, { status }, "agent")).message).toContain("its status does not move");
    }
    expect(plan.view().ideas.map((i) => i.id)).toContain(ref);
    expect(store.updateIssue(ref, { title: "Renamed by an agent" }, "agent").title).toBe("Renamed by an agent");
  });

  it("refuses a gate on an idea", () => {
    const ref = idea("Gate me");
    expect(refused(() => store.gateIssue(ref, { owner: "vp" }, "agent")).message).toContain("cannot be gated");
  });
});

describe("dependencies are tracker work", () => {
  it("refuses an idea as a blocker, an idea that waits, and a create that names an idea blocker", () => {
    const ref = idea("Not a blocker");
    const task = store.createIssue({ title: "Real work" }).identifier;
    expect(refused(() => store.setBlockedBy(task, [ref], "agent")).message).toContain("cannot be a blocker");
    expect(refused(() => store.setBlockedBy(ref, [task], "agent")).message).toContain("cannot be blocked by other work");
    expect(refused(() => store.createIssue({ title: "Waits on an idea", blockedBy: [ref] })).message).toContain("cannot be a blocker");
    expect(store.blockersOf(store.getIssue(task).id)).toEqual([]);
  });
});

describe("a workspace that already had its own idea kind", () => {
  function custom(): WorkspaceStore {
    const own = memStore();
    own.addKind({ id: IDEA_KIND, label: "Idea" }, "vp");
    return own;
  }

  it("keeps every issue of that kind a numbered tracker issue while planning is off", () => {
    const own = custom();
    const mine = own.createIssue({ title: "My idea ticket", kind: IDEA_KIND });
    expect(mine.identifier).toMatch(/^TST-\d+$/);
    expect(own.planningOn()).toBe(false);
    expect(own.listIssues({}).map((i) => i.identifier)).toContain(mine.identifier);
    expect(own.tree().map((n) => n.issue.identifier)).toContain(mine.identifier);
    own.queue().enqueue(mine.identifier, {}, "vp");
    expect(own.queue().effectiveQueue({ actor: "agent" }).rows.map((r) => r.identifier)).toContain(mine.identifier);
    expect(own.checkoutIssue(mine.identifier, "agent").checkoutAgent).toBe("agent");
  });

  it("refuses to turn planning on while such issues exist, naming them, and turns on once they are re-kinded", () => {
    const own = custom();
    const mine = own.createIssue({ title: "My idea ticket", kind: IDEA_KIND });
    const error = refused(() => own.plan().enable("vp"));
    expect(error.message).toContain(mine.identifier);
    expect(own.planningOn()).toBe(false);
    own.updateIssue(mine.identifier, { kind: "task" }, "vp");
    expect(own.plan().enable("vp").enabled).toBe(true);
    expect(own.planningOn()).toBe(true);
    expect(own.getIssue(mine.identifier).kind).toBe("task");
  });
});

describe("ideas and horizons", () => {
  it("nest, carry maturity and horizon independently, and read their stage", () => {
    const ga = idea("Release GA", { maturity: "shaped", horizon: horizon("Now") });
    const r8 = plan.capture({ title: "R8 Mobile", parent: ga, horizon: horizon("Next"), maturity: "exploring" }, "vp", PERSON);
    const api = idea("Programming API", { maturity: "exploring", horizon: horizon("Next") });
    const sdk = idea("SDKs", { maturity: "shaped" });
    const view = plan.view();
    const of = (id: string) => view.ideas.find((i) => i.id === id)!;
    expect(of(ga).stage).toBe("scheduled");
    expect(of(ga).childIds).toEqual([r8.id]);
    expect(of(r8.id).horizonId).toBe(horizon("Next"));
    expect(of(api).stage).toBe("scheduled");
    expect(of(api).maturity).toBe("exploring");
    expect(of(sdk).stage).toBe("shaped");
    plan.update(sdk, { maturity: "dropped" }, "vp", PERSON);
    expect(plan.ideaView(sdk).stage).toBe("dropped");
  });

  it("orders horizons by date when created, renames, dates and removes them; a removed one is a cancelled milestone", () => {
    const mvp = plan.createHorizon({ name: "MVP", date: "2026-12-31" }, "vp", PERSON);
    expect(store.getIssue(mvp.id).kind).toBe(MILESTONE_KIND);
    expect(store.milestones().get(mvp.id).milestone.targetDate).toBe("2026-12-31");
    expect(plan.view().horizons.map((h) => h.name)).toEqual(["MVP", "Now", "Next", "Later"]);
    plan.updateHorizon(mvp.identifier, { name: "Now · MVP", before: null }, "vp", PERSON);
    expect(plan.view().horizons.map((h) => h.name)).toEqual(["Now", "Next", "Later", "Now · MVP"]);
    const ref = idea("On it", { horizon: mvp.id });
    plan.removeHorizon(mvp.identifier, "vp", PERSON);
    expect(plan.view().horizons.map((h) => h.name)).toEqual(["Now", "Next", "Later"]);
    expect(plan.ideaView(ref).horizonId).toBeNull();
    expect(store.categoryOf(store.getIssue(mvp.id).status)).toBe("cancelled");
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

describe("membership: a horizon holds its ideas' work without anyone typing it", () => {
  it("puts an idea's linked work into its horizon, moves it with the idea, and drops it when unscheduled", () => {
    const ref = idea("Scheduled", { maturity: "shaped", horizon: horizon("Now") });
    const epic = store.createIssue({ title: "Linked epic", kind: "epic" });
    plan.adopt(ref, epic.identifier, "agent");
    expect(membersOf(horizon("Now"))).toEqual([epic.id]);
    expect(store.milestones().milestoneOf(epic.identifier)).toBe(plan.view().horizons[0]!.identifier);
    plan.update(ref, { horizon: horizon("Next") }, "vp", PERSON);
    expect(membersOf(horizon("Now"))).toEqual([]);
    expect(membersOf(horizon("Next"))).toEqual([epic.id]);
    plan.update(ref, { horizon: null }, "vp", PERSON);
    expect(membersOf(horizon("Next"))).toEqual([]);
    expect(store.milestones().milestoneOf(epic.identifier)).toBeNull();
  });

  it("follows unlinking, and keeps the plan's order across ideas", () => {
    const first = idea("First", { horizon: horizon("Now") });
    const second = idea("Second", { horizon: horizon("Now") });
    const a = store.createIssue({ title: "a" });
    const b = store.createIssue({ title: "b" });
    plan.adopt(second, b.identifier, "agent");
    plan.adopt(first, a.identifier, "agent");
    expect(membersOf(horizon("Now"))).toEqual([a.id, b.id]);
    plan.update(second, { before: first }, "vp", PERSON);
    expect(membersOf(horizon("Now"))).toEqual([b.id, a.id]);
    plan.unlink(first, a.identifier, "agent");
    expect(membersOf(horizon("Now"))).toEqual([b.id]);
  });

  it("leaves a member a person put in a milestone by hand where it was put", () => {
    const later = plan.view().horizons.find((h) => h.name === "Later")!;
    const task = store.createIssue({ title: "Hand-placed" });
    store.milestones().addMember(later.identifier, task.identifier, {}, "vp");
    const ref = idea("Wants it on Now", { horizon: horizon("Now") });
    plan.adopt(ref, task.identifier, "agent");
    expect(membersOf(horizon("Now"))).toEqual([]);
    expect(membersOf(later.id)).toEqual([task.id]);
    expect(store.milestones().milestoneOf(task.identifier)).toBe(later.identifier);
  });

  it("counts a promoted idea itself, and its work, in the horizon's progress and state", () => {
    const ref = idea("Ship it", { maturity: "shaped", horizon: horizon("Now") });
    const epic = plan.promote(ref, "vp", PERSON).identifier!;
    const a = store.createIssue({ title: "a", parent: epic });
    const b = store.createIssue({ title: "b", parent: epic });
    expect(membersOf(horizon("Now"))).toEqual([ref]);
    finish(a.identifier);
    expect(store.milestones().get(horizon("Now")).progress).toMatchObject({ countable: 2, percent: 50, complete: false });
    expect(plan.view().horizons[0]).toMatchObject({ memberCount: 1, shipped: false });
    finish(b.identifier);
    expect(store.milestones().get(horizon("Now")).progress.complete).toBe(true);
    expect(store.categoryOf(store.getIssue(horizon("Now")).status)).toBe("done");
    expect(plan.view().horizons.find((h) => h.name === "Now")).toMatchObject({ shipped: true });
  });

  it("expands a queued horizon to its ideas' work", () => {
    const ref = idea("Queued through its horizon", { maturity: "shaped", horizon: horizon("Now") });
    const epic = store.createIssue({ title: "Linked", kind: "epic" });
    const task = store.createIssue({ title: "Under it", parent: epic.identifier });
    plan.adopt(ref, epic.identifier, "agent");
    store.queue().enqueue(plan.view().horizons[0]!.identifier, {}, "vp");
    const rows = store.queue().effectiveQueue({ actor: "agent" }).rows;
    // Through the horizon: queued at its position, not in the band of everything unqueued.
    expect(rows.find((r) => r.issueId === task.id)).toMatchObject({ unqueued: false, planPosition: 1 });
    expect(rows.map((r) => r.issueId)).not.toContain(ref);
  });

  it("leaves a hand-placed member out of the horizon the plan would put it in, for status as well", () => {
    const later = plan.view().horizons.find((h) => h.name === "Later")!;
    const task = store.createIssue({ title: "Hand-placed, then finished" });
    store.milestones().addMember(later.identifier, task.identifier, {}, "vp");
    const ref = idea("Wants it on Now", { horizon: horizon("Now") });
    plan.adopt(ref, task.identifier, "agent");
    finish(task.identifier);
    expect(store.categoryOf(store.getIssue(later.id).status)).toBe("done");
    expect(store.categoryOf(store.getIssue(horizon("Now")).status)).not.toBe("done");
  });

  it("never makes an idea or a milestone a derived member, whatever links them", () => {
    const ref = idea("Links odd things", { horizon: horizon("Now") });
    const plain = store.createIssue({ title: "Release train", kind: MILESTONE_KIND });
    plan.adopt(ref, plain.identifier, "agent");
    // A shape the local adopt refuses but another device could deliver: an idea linked as work.
    const other = idea("Linked as if it were work");
    store.db.prepare("INSERT INTO plan_links (idea_id, issue_id, linked_by, linked_at) VALUES (?, ?, 'other', '2026-11-01T00:00:00.000Z')").run(ref, other);
    plan.update(ref, { title: "Links odd things, renamed" }, "agent");
    expect(membersOf(horizon("Now"))).toEqual([]);
  });

  it("gives a cancelled horizon no derived members, even when an idea still points at it", () => {
    const mvp = plan.createHorizon({ name: "MVP" }, "vp", PERSON);
    const ref = idea("On MVP", { horizon: mvp.id });
    const task = store.createIssue({ title: "Its work" });
    // A horizon is removed only while it holds no work.
    expect(refused(() => plan.adopt(ref, task.identifier, "agent") && plan.removeHorizon(mvp.id, "vp", PERSON)).message).toContain("holds open work");
    expect(membersOf(mvp.id)).toEqual([task.id]);
    plan.unlink(ref, task.identifier, "agent");
    plan.removeHorizon(mvp.id, "vp", PERSON);
    // Another device scheduled the idea onto it, and linked its work, before hearing of the removal.
    store.db.prepare("UPDATE issues SET plan_horizon_id = ? WHERE id = ?").run(mvp.id, ref);
    plan.adopt(ref, task.identifier, "agent");
    expect(membersOf(mvp.id)).toEqual([]);
    expect(store.milestones().milestoneOf(task.identifier)).toBeNull();
  });

  it("re-derives a horizon's status when work joins it through the plan", () => {
    const task = store.createIssue({ title: "Already underway" });
    store.checkoutIssue(task.identifier, "agent");
    expect(store.categoryOf(store.getIssue(horizon("Now")).status)).toBe("unstarted");
    const ref = idea("Scheduled", { horizon: horizon("Now") });
    plan.adopt(ref, task.identifier, "agent");
    expect(store.categoryOf(store.getIssue(horizon("Now")).status)).not.toBe("unstarted");
  });
});

describe("a horizon's own status: only the person removes it", () => {
  const cancelled = () => store.primaryStatusFor("cancelled");
  const categoryOf = (id: string) => store.categoryOf(store.getIssue(id).status);
  const listed = () => plan.view().horizons.map((h) => h.name);

  function promotedOnNow(title = "Only work"): string {
    const ref = idea(title, { maturity: "shaped", horizon: horizon("Now") });
    return plan.promote(ref, "vp", PERSON).identifier!;
  }

  for (const rebuild of [false, true]) {
    it(`stays a column holding its work when its only work is cancelled, and derives again when it reopens (${rebuild ? "a rebuild between" : "no rebuild"})`, () => {
      const now = horizon("Now");
      const epic = promotedOnNow();
      store.checkoutIssue(epic, "agent");
      expect(categoryOf(now)).toBe("active");
      store.updateIssue(epic, { status: cancelled() }, "vp");
      expect(categoryOf(now)).toBe("unstarted");
      if (rebuild) idea("Something else");
      expect(listed()).toContain("Now");
      expect(membersOf(now)).toEqual([store.getIssue(epic).id]);
      store.updateIssue(epic, { status: "todo" }, "vp");
      store.checkoutIssue(epic, "agent");
      expect(listed()).toContain("Now");
      expect(categoryOf(now)).toBe("active");
      expect(membersOf(now)).toEqual([store.getIssue(epic).id]);
    });
  }

  it("ships on its done work and never on cancelled work", () => {
    const now = horizon("Now");
    const shipped = promotedOnNow("Shipped");
    const dropped = promotedOnNow("Dropped");
    store.updateIssue(dropped, { status: cancelled() }, "vp");
    expect(categoryOf(now)).toBe("unstarted");
    finish(shipped);
    expect(categoryOf(now)).toBe("done");
    expect(listed()).toContain("Now");
  });

  it("takes back a horizon an earlier build's derivation cancelled", () => {
    const now = horizon("Now");
    const epic = promotedOnNow();
    // What an earlier build left: the horizon cancelled by derivation, and its members dropped.
    store.db.prepare("UPDATE issues SET status = ?, derived_status = ? WHERE id = ?").run(cancelled(), cancelled(), now);
    store.db.prepare("DELETE FROM plan_members").run();
    expect(listed()).toContain("Now");
    idea("Any plan write");
    expect(membersOf(now)).toEqual([store.getIssue(epic).id]);
    expect(categoryOf(now)).toBe("unstarted");
  });

  it("refuses to remove a horizon that holds open work, naming what to move", () => {
    const now = horizon("Now");
    const nowRef = store.getIssue(now).identifier;
    const epic = promotedOnNow("Planned work");
    const error = refused(() => plan.removeHorizon(now, "vp", PERSON));
    expect(error.message).toContain(epic);
    expect(error.message).toContain("staple idea set");
    plan.update(store.getIssue(epic).id, { horizon: null }, "vp", PERSON);

    const stray = store.createIssue({ title: "Placed by hand" });
    store.milestones().addMember(now, stray.identifier, {}, "vp");
    const byHand = refused(() => plan.removeHorizon(now, "vp", PERSON));
    expect(byHand.message).toContain(`staple milestone rm ${nowRef} ${stray.identifier}`);
    expect(listed()).toContain("Now");
    expect(categoryOf(now)).not.toBe("cancelled");

    finish(stray.identifier);
    plan.removeHorizon(now, "vp", PERSON);
    expect(listed()).not.toContain("Now");
  });

  it("refuses to remove a queued horizon", () => {
    const now = horizon("Now");
    const task = store.createIssue({ title: "Queued through Now" });
    store.milestones().addMember(now, task.identifier, {}, "vp");
    store.queue().enqueue(store.getIssue(now).identifier, {}, "vp");
    finish(task.identifier);
    const error = refused(() => plan.removeHorizon(now, "vp", PERSON));
    expect(error.message).toContain(`staple queue rm ${store.getIssue(now).identifier}`);
    expect(store.queue().entries({ all: true }).map((entry) => entry.issueId)).toContain(now);
  });

  it("refuses an edit of a removed horizon before writing any of it", () => {
    const later = horizon("Later");
    plan.removeHorizon(later, "vp", PERSON);
    const error = refused(() => plan.updateHorizon(later, { name: "Someday", date: "2027-01-01" }, "vp", PERSON));
    expect(error.message).toContain("was removed");
    expect(store.getIssue(later).title).toBe("Later");
    expect(refused(() => plan.updateHorizon(horizon("Now"), { name: "Today", date: "not a day" }, "vp", PERSON)).message).toContain("YYYY-MM-DD");
    expect(store.getIssue(horizon("Now")).title).toBe("Now");
  });

  it("names kinds with the right article", () => {
    const ref = idea("Shaped", { maturity: "shaped" });
    plan.promote(ref, "vp", PERSON);
    expect(refused(() => plan.promote(ref, "vp", PERSON)).message).toContain("it is an epic in the tracker now");
  });
});

describe("Promote, Adopt and Unlink", () => {
  it("Promote turns the idea into an epic on the same record, keeping its documents and history", () => {
    const ref = idea("Programming API", { maturity: "shaped", brief: "The brief.", plannedStart: "2026-11-01", plannedTarget: "2026-12-01" });
    plan.addQuestion(ref, "Which auth?", "agent");
    store.addComment(ref, "Seen at capture", "agent", "agent");
    const promoted = plan.promote(ref, "vp", PERSON);
    expect(promoted).toMatchObject({ id: ref, promoted: true, kind: "epic", stage: "started" });
    expect(promoted.identifier).toMatch(/^TST-\d+$/);
    const epic = store.getIssue(promoted.identifier!);
    expect(epic.id).toBe(ref);
    expect(epic.kind).toBe("epic");
    expect(plan.detail(ref).brief).toBe("The brief.");
    expect(plan.detail(ref).questions).toEqual([{ text: "Which auth?", resolved: false }]);
    expect(store.listComments(ref).map((c) => c.body)).toEqual(["Seen at capture"]);
    expect(promoted.baseline).toEqual({ start: "2026-11-01", target: "2026-12-01" });
    expect(store.getIssue(ref).identifier).toBe(promoted.identifier);
  });

  it("records the move off the draft identifier, so a hub link that named the idea follows it", () => {
    const ref = idea("Linked from another workspace before promotion", { maturity: "shaped" });
    const draft = store.getIssue(ref).identifier;
    const promoted = plan.promote(ref, "vp", PERSON);
    expect(pendingIdentifierMoves(store.db)).toContainEqual(expect.objectContaining({ issueId: ref, from: draft, to: promoted.identifier }));
    expect(formerHolders(store.db, draft).map((holder) => holder.issueId)).toEqual([ref]);
  });

  it("makes a promoted idea an ordinary epic: queued, worked and closed like any other", () => {
    const ref = idea("Ordinary", { maturity: "shaped" });
    const epic = plan.promote(ref, "vp", PERSON).identifier!;
    const task = store.createIssue({ title: "Its task", parent: epic });
    store.queue().enqueue(epic, {}, "vp");
    expect(store.queue().effectiveQueue({ actor: "agent" }).rows.map((r) => r.issueId)).toContain(task.id);
    expect(store.listIssues({}).map((i) => i.identifier)).toContain(epic);
    store.updateIssue(epic, { title: "Ordinary, renamed" }, "agent");
    finish(task.identifier);
    expect(plan.ideaView(ref).stage).toBe("shipped");
  });

  it("promotes a child only under a promoted parent", () => {
    const parent = idea("Parent", { maturity: "shaped" });
    const child = plan.capture({ title: "Child", parent, maturity: "shaped" }, "vp", PERSON).id;
    expect(refused(() => plan.promote(child, "vp", PERSON)).message).toContain("not promoted yet");
    expect(plan.ideaView(child).promoted).toBe(false);
    const epic = plan.promote(parent, "vp", PERSON).identifier!;
    const promoted = plan.promote(child, "vp", PERSON);
    expect(store.getIssue(promoted.identifier!).parentId).toBe(store.getIssue(epic).id);
  });

  it("refuses to promote a dropped idea, or one already promoted", () => {
    const dropped = idea("Gone", { maturity: "dropped" });
    expect(refused(() => plan.promote(dropped, "vp", PERSON)).message).toContain("is dropped; it cannot be promoted");
    const once = idea("Once", { maturity: "shaped" });
    plan.promote(once, "vp", PERSON);
    expect(refused(() => plan.promote(once, "vp", PERSON)).message).toContain("is already promoted: it is an epic");
  });

  it("derives progress, actual dates and shipped from linked work, rolled up to the parent", () => {
    const parent = idea("Release GA", { maturity: "shaped" });
    const child = plan.capture({ title: "R0", parent, maturity: "shaped" }, "vp", PERSON).id;
    const epic = store.createIssue({ title: "EPIC-40", kind: "epic" });
    const a = store.createIssue({ title: "a", parent: epic.identifier });
    const b = store.createIssue({ title: "b", parent: epic.identifier });
    plan.adopt(child, epic.identifier, "agent");
    finish(a.identifier);
    const half = plan.ideaView(parent);
    expect(half.stage).toBe("started");
    expect(half.progress).toBe(0.5);
    expect(half.actual.start).toBe(store.getIssue(a.identifier).startedAt!.slice(0, 10));
    expect(half.actual.end).toBeNull();
    finish(b.identifier);
    expect(plan.ideaView(child).stage).toBe("shipped");
    expect(plan.ideaView(parent).stage).toBe("shipped");
    expect(plan.ideaView(parent).actual.end).not.toBeNull();
    // Shipped offers no edits: its link stays, and so does the parent's rolled-up state.
    expect(refused(() => plan.unlink(child, epic.identifier, "agent")).message).toContain("is shipped; it cannot be unlinked");
    expect(plan.ideaView(parent).stage).toBe("shipped");
  });

  describe("the actual window, on fixtures shaped like real linked work", () => {
    /** Writes the timestamps an imported or long-lived tracker holds, which no store call sets. */
    const stamp = (identifier: string, columns: { created?: string; started?: string | null; completed?: string | null; status?: string }) => {
      const sets: string[] = [];
      const values: Array<string | null> = [];
      if (columns.created !== undefined) (sets.push("created_at = ?"), values.push(columns.created));
      if (columns.started !== undefined) (sets.push("started_at = ?"), values.push(columns.started));
      if (columns.completed !== undefined) (sets.push("completed_at = ?"), values.push(columns.completed));
      if (columns.status !== undefined) (sets.push("status = ?"), values.push(columns.status));
      store.db.prepare(`UPDATE issues SET ${sets.join(", ")} WHERE identifier = ?`).run(...values, identifier);
    };

    it("starts at the first started_at anywhere under a linked epic, not when the epic was filed", () => {
      // Filed on Oct 5, first worked on Nov 3, half done: the epic carries the derived start.
      const epic = store.createIssue({ title: "Planned early, worked late", kind: "epic" }).identifier;
      const done = store.createIssue({ title: "done child", parent: epic }).identifier;
      const open = store.createIssue({ title: "open child", parent: epic }).identifier;
      stamp(epic, { created: "2026-10-05T16:17:15.000Z", started: "2026-11-03T23:19:32.000Z" });
      stamp(done, { created: "2026-10-05T16:17:27.000Z", started: "2026-11-03T23:19:32.000Z", completed: "2026-11-05T13:47:42.000Z", status: "done" });
      stamp(open, { created: "2026-10-05T16:17:40.000Z", started: null });
      const ref = idea("Rung", { plannedStart: "2026-09-15", plannedTarget: "2026-10-31" });
      plan.adopt(ref, epic, "agent");
      const view = plan.ideaView(ref);
      expect(view.actual).toMatchObject({ start: "2026-11-03", end: null });
      expect(view.progress).toBe(0.5);
      expect(view.late).toBe(true);
    });

    it("reads its children's start when the epic's own started_at is null, and ends at the last close", () => {
      const epic = store.createIssue({ title: "Never claimed itself", kind: "epic" }).identifier;
      const a = store.createIssue({ title: "a", parent: epic }).identifier;
      const b = store.createIssue({ title: "b", parent: epic }).identifier;
      stamp(epic, { created: "2026-10-01T09:00:00.000Z", started: null });
      stamp(a, { started: "2026-10-10T09:00:00.000Z", completed: "2026-10-18T17:00:00.000Z", status: "done" });
      stamp(b, { started: "2026-10-20T09:00:00.000Z", completed: null });
      const ref = idea("Rung");
      plan.adopt(ref, epic, "agent");
      expect(plan.ideaView(ref).actual).toMatchObject({ start: "2026-10-10", end: null });
      stamp(b, { completed: "2026-10-28T12:00:00.000Z", status: "done" });
      stamp(epic, { completed: "2026-10-28T12:00:00.000Z", status: "done" });
      expect(plan.ideaView(ref).actual).toMatchObject({ start: "2026-10-10", end: "2026-10-28", forecastEnd: null });
    });

    it("draws no actual window for linked work nobody has started", () => {
      const epic = store.createIssue({ title: "Filed, untouched", kind: "epic" }).identifier;
      store.createIssue({ title: "child", parent: epic });
      stamp(epic, { created: "2026-10-01T09:00:00.000Z" });
      const ref = idea("Rung");
      plan.adopt(ref, epic, "agent");
      expect(plan.ideaView(ref).actual).toEqual({ start: null, end: null, forecastEnd: null });
    });
  });

  it("keeps a link whose issue is gone: the idea stays started, the link reads missing, and it can be unlinked", () => {
    const ref = idea("Linked to something that vanishes", { maturity: "shaped" });
    const epic = store.createIssue({ title: "Rewound away", kind: "epic" });
    plan.adopt(ref, epic.identifier, "agent");
    expect(plan.ideaView(ref).stage).toBe("started");
    // A rewind removes rows outright; nothing in the plan is told.
    store.db.prepare("DELETE FROM issues WHERE id = ?").run(epic.id);
    const view = plan.ideaView(ref);
    expect(view).toMatchObject({ stage: "started", links: [epic.id], missingLinks: [epic.id] });
    expect(plan.detail(ref).linked).toEqual([expect.objectContaining({ id: epic.id, missing: true })]);
    expect(plan.unlink(ref, epic.id, "agent")).toMatchObject({ stage: "shaped", links: [], missingLinks: [] });
  });

  it("Adopt refuses an idea as the target and is idempotent", () => {
    const ref = idea("A");
    const other = idea("B");
    expect(refused(() => plan.adopt(ref, other, "agent")).message).toContain("only tracker work can be adopted");
    const task = store.createIssue({ title: "t" }).identifier;
    plan.adopt(ref, task, "agent");
    expect(plan.adopt(ref, task, "agent").links).toHaveLength(1);
  });

  it("Adopt keeps working on a promoted idea", () => {
    const ref = idea("Promoted, then more work", { maturity: "shaped", horizon: horizon("Now") });
    plan.promote(ref, "vp", PERSON);
    const extra = store.createIssue({ title: "Found later" });
    expect(plan.adopt(ref, extra.identifier, "agent").links).toEqual([extra.id]);
    expect(membersOf(horizon("Now"))).toEqual([ref, extra.id]);
  });

  it("calls linked work past its line late, and an unlinked idea past its planned start not started", () => {
    const now = plan.createHorizon({ name: "MVP", date: "2026-11-01" }, "vp", PERSON);
    const late = idea("Late one", { maturity: "shaped", horizon: now.id });
    expect(plan.ideaView(late).late).toBe(false);
    plan.adopt(late, store.createIssue({ title: "open work" }).identifier, "agent");
    expect(plan.ideaView(late).late).toBe(true);
    const waiting = idea("Waiting", { horizon: now.id, plannedStart: "2026-10-01", plannedTarget: "2026-12-01" });
    expect(plan.ideaView(waiting)).toMatchObject({ late: false, notStarted: true });
    const future = idea("Future", { plannedStart: "2026-12-01", plannedTarget: "2026-12-20" });
    expect(plan.ideaView(future)).toMatchObject({ late: false, notStarted: false });
    const underway = idea("Underway", { plannedStart: "2026-10-01", plannedTarget: "2026-12-20" });
    plan.adopt(underway, store.createIssue({ title: "its work" }).identifier, "agent");
    expect(plan.ideaView(underway)).toMatchObject({ notStarted: false });
    expect(plan.view().horizons.find((h) => h.id === now.id)).toMatchObject({ lateCount: 1, notStartedCount: 1 });
  });
});

describe("the baseline", () => {
  it("does not exist before the idea is started; moving the window just moves it", () => {
    const ref = idea("Rung", { plannedStart: "2026-11-01", plannedTarget: "2026-11-30" });
    plan.update(ref, { plannedTarget: "2026-12-15" }, "vp", PERSON);
    plan.update(ref, { plannedTarget: "2026-12-31" }, "vp", PERSON);
    const view = plan.ideaView(ref);
    expect(view.baseline).toBeNull();
    expect(view.planned).toEqual({ start: "2026-11-01", target: "2026-12-31" });
    expect(store.db.prepare("SELECT plan_baseline_start, plan_baseline_target FROM issues WHERE id = ?").get(ref)).toEqual({
      plan_baseline_start: null,
      plan_baseline_target: null,
    });
    // So the baseline is the window it has when it starts, not one it had on the way.
    plan.adopt(ref, store.createIssue({ title: "work" }).identifier, "agent");
    expect(plan.ideaView(ref).baseline).toEqual({ start: "2026-11-01", target: "2026-12-31" });
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
    expect(refused(() => plan.resetBaseline(ref, "vp", PERSON)).message).toContain("is shaped; it cannot be re-baselined");
  });
});

describe("agents capture, the person steers", () => {
  const steering = (fn: () => unknown) => {
    const error = refused(fn);
    expect(error.message).toMatch(/person's call|is raw; it cannot be/);
    return error;
  };

  it("lets an agent capture raw ideas and do the capture-side edits", () => {
    const ref = plan.capture({ title: "Agent idea", brief: "why" }, "agent").id;
    expect(plan.ideaView(ref).maturity).toBe("raw");
    plan.update(ref, { title: "Agent idea, renamed", brief: "why, better" }, "agent");
    plan.addQuestion(ref, "q?", "agent");
    plan.resolveQuestion(ref, 1, "agent");
    plan.addDecision(ref, "d", "agent");
    expect(plan.detail(ref).idea.title).toBe("Agent idea, renamed");
    // Linking work is a shaped idea's: once the person has shaped it, the agent links and unlinks.
    plan.update(ref, { maturity: "exploring" }, "vp", PERSON);
    plan.update(ref, { maturity: "shaped" }, "vp", PERSON);
    const task = store.createIssue({ title: "t" }).identifier;
    plan.adopt(ref, task, "agent");
    expect(plan.unlink(ref, task, "agent").links).toEqual([]);
  });

  it("refuses an agent's capture of anything but a raw, unscheduled, undated idea", () => {
    steering(() => plan.capture({ title: "x", maturity: "shaped" }, "agent"));
    steering(() => plan.capture({ title: "x", horizon: horizon("Now") }, "agent"));
    steering(() => plan.capture({ title: "x", plannedTarget: "2026-12-01" }, "agent"));
  });

  it("refuses an agent's change to maturity, horizon, parent, planned dates and order", () => {
    const ref = plan.capture({ title: "Mine" }, "agent").id;
    const other = plan.capture({ title: "Other" }, "agent").id;
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

  it("lets anyone promote a shaped idea and nobody promote an idea that is not shaped", () => {
    const raw = plan.capture({ title: "Raw" }, "agent").id;
    steering(() => plan.promote(raw, "agent"));
    expect(refused(() => plan.promote(raw, "vp", PERSON)).message).toContain("is raw; it cannot be promoted");
    expect(plan.ideaView(raw)).toMatchObject({ promoted: false, identifier: null });
    plan.update(raw, { maturity: "exploring" }, "vp", PERSON);
    expect(refused(() => plan.promote(raw, "vp", PERSON)).message).toContain("is exploring; it cannot be promoted");
    plan.update(raw, { maturity: "shaped" }, "vp", PERSON);
    expect(plan.promote(raw, "agent")).toMatchObject({ promoted: true, stage: "started" });
  });
});

describe("the lifecycle in the store", () => {
  it("refuses an idea placed on a horizon or dated at capture before its state offers it", () => {
    expect(refused(() => plan.capture({ title: "Raw on Now", horizon: horizon("Now") }, "vp", PERSON)).message).toContain('"Raw on Now" is raw; it cannot be scheduled');
    expect(refused(() => plan.capture({ title: "Raw, dated", plannedTarget: "2026-12-01" }, "vp", PERSON)).message).toContain("is raw; it cannot be given planned dates");
    expect(plan.capture({ title: "Exploring on Now", maturity: "exploring", horizon: horizon("Now") }, "vp", PERSON).horizonId).toBe(horizon("Now"));
  });

  it("offers no edit on a shipped idea, through the plan or through the tracker", () => {
    const ref = idea("Landed");
    const done = store.createIssue({ title: "Its work" });
    plan.adopt(ref, done.identifier, "agent");
    finish(done.identifier);
    expect(plan.ideaView(ref).state).toBe("shipped");
    expect(refused(() => plan.update(ref, { brief: "Rewritten after the fact" }, "agent")).message).toContain("is shipped; it cannot be edited");
    expect(refused(() => store.updateIssue(ref, { title: "Renamed after the fact" }, "agent")).message).toContain("is shipped; it cannot be edited");
    expect(refused(() => store.updateIssue(ref, { description: "Described after the fact" }, "agent")).message).toContain("is shipped; it cannot be edited");
  });

  it("holds back an offered action whose precondition is missing, saying why", () => {
    const promoted = idea("Promoted, nothing linked");
    plan.promote(promoted, "vp", PERSON);
    expect(plan.ideaView(promoted).actions.find((a) => a.id === "unlink")).toMatchObject({ disabledReason: "Nothing is linked to it." });
    const parent = idea("Parent, not promoted");
    const child = plan.capture({ title: "Child", parent, maturity: "shaped" }, "vp", PERSON).id;
    expect(plan.ideaView(child).actions.find((a) => a.id === "promote")?.disabledReason).toContain('Promote the idea "Parent, not promoted" first');
    expect(plan.ideaView(parent).actions.find((a) => a.id === "promote")?.disabledReason).toBeUndefined();
  });

  it("holds a write that shapes an idea and schedules it to the state the shaping leads to", () => {
    const raw = plan.capture({ title: "Shaped and scheduled at once" }, "vp", PERSON).id;
    expect(plan.update(raw, { maturity: "shaped", horizon: horizon("Now"), plannedTarget: "2026-12-01" }, "vp", PERSON)).toMatchObject({ state: "shaped", horizonId: horizon("Now") });
    const dropping = idea("Dropped and scheduled at once");
    expect(refused(() => plan.update(dropping, { maturity: "dropped", horizon: horizon("Next") }, "vp", PERSON)).message).toContain("is dropped; it cannot be scheduled");
  });

  it("counts only open work toward a horizon's state, and holds back removing a queued one", () => {
    const later = plan.view().horizons.find((h) => h.name === "Later")!;
    const task = store.createIssue({ title: "Will be cancelled" });
    store.milestones().addMember(later.identifier, task.identifier, {}, "vp");
    expect(plan.view().horizons.find((h) => h.id === later.id)!.state).toBe("active");
    store.updateIssue(task.identifier, { status: store.primaryStatusFor("cancelled") }, "vp");
    const after = plan.view().horizons.find((h) => h.id === later.id)!;
    expect(after.state).toBe("planned");
    expect(after.actions.find((a) => a.id === "remove")?.disabledReason).toBeUndefined();
    const open = store.createIssue({ title: "Open work" });
    store.milestones().addMember(later.identifier, open.identifier, {}, "vp");
    store.queue().enqueue(later.identifier, {}, "vp");
    finish(open.identifier);
    const queued = plan.view().horizons.find((h) => h.id === later.id)!;
    expect(queued.actions.find((a) => a.id === "remove")?.disabledReason).toBe("It is in the queue; take it off first.");
  });
});
