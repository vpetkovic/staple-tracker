/**
 * A record's own lifecycle state against its rollup (design/plan.md, "Lifecycle" and "Derived,
 * never stored"), on fixtures with sub-ideas and promoted records: the state comes only from the
 * record's own maturity, promotion and links, and its sub-ideas' work is a rollup it displays.
 * Also every write on an idea's documents and files, held to the same table as `update_idea`.
 *
 * The expected rows here are written out, not read from the table, so a table that drifted from
 * the rules would fail here even where the cross-surface walk (which reads the table) agrees.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";
import { READY_PLAN } from "./fixtures/plan-ready.js";

const PERSON = { person: { via: "plan_view" } } as const;

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

function refused(fn: () => unknown): StapleError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    return error as StapleError;
  }
  throw new Error("expected a refusal");
}

// Every record carries a plan that passes the shaped gate, so shaping measures the lifecycle alone.
const idea = (title: string, maturity = "shaped", parent?: string) => plan.capture({ title, maturity, plan: READY_PLAN, ...(parent ? { parent } : {}) }, "vp", PERSON).id;
const horizon = (name: string) => plan.view().horizons.find((h) => h.name === name)!.id;
const actionsOf = (id: string) => plan.ideaView(id).actions.map((action) => action.id);
const finish = (identifier: string) => {
  store.checkoutIssue(identifier, "agent");
  store.updateIssue(identifier, { status: "done" }, "agent");
};
/** A child with linked work, open or landed. */
function childWithWork(parent: string, done: boolean): { child: string; work: string } {
  const child = idea("Child with work", "shaped", parent);
  const work = store.createIssue({ title: "The child's work" }).identifier;
  plan.adopt(child, work, "agent");
  if (done) finish(work);
  return { child, work };
}

const RAW = ["edit", "ask", "decide", "explore", "shape", "drop", "reparent", "reorder"];
const EXPLORING = ["edit", "ask", "decide", "shape", "drop", "schedule", "plan_dates", "reparent", "reorder", "adopt", "mark_delivered"];
const SHAPED = ["edit", "ask", "decide", "unshape", "drop", "schedule", "plan_dates", "reparent", "reorder", "promote", "scaffold", "adopt", "mark_delivered"];

describe("a parent's own state is its own; its sub-ideas' work is a rollup", () => {
  it("keeps a raw parent raw while a sub-idea's work is underway: never schedulable, still refinable", () => {
    const parent = idea("Raw parent", "raw");
    childWithWork(parent, false);
    const view = plan.ideaView(parent);
    expect(view).toMatchObject({ state: "raw", stage: "raw", linkCount: 1, progress: 0 });
    expect(actionsOf(parent)).toEqual(RAW);
    expect(refused(() => plan.update(parent, { horizon: horizon("Now") }, "vp", PERSON)).message).toContain("is raw; it cannot be scheduled");
    expect(plan.update(parent, { maturity: "exploring" }, "vp", PERSON).state).toBe("exploring");
    expect(actionsOf(parent)).toEqual(EXPLORING);
  });

  it("lets the parent be shaped and promoted, and its shaped sibling promoted, with no 'promote the parent first'", () => {
    const parent = idea("Parent", "exploring");
    childWithWork(parent, false);
    const sibling = idea("Shaped sibling", "shaped", parent);
    expect(plan.ideaView(sibling).actions.find((a) => a.id === "promote")).toEqual({ id: "promote", label: "Promote to epic", who: "anyone" });
    const promotedSibling = plan.promote(sibling, "agent");
    expect(promotedSibling).toMatchObject({ promoted: true, kind: "epic", state: "started" });
    expect(plan.ideaView(parent).state).toBe("exploring");
    expect(plan.update(parent, { maturity: "shaped" }, "vp", PERSON).state).toBe("shaped");
    expect(actionsOf(parent)).toEqual(SHAPED);
    expect(plan.promote(parent, "vp", PERSON)).toMatchObject({ promoted: true, state: "started" });
  });

  it("keeps a raw parent raw, and answerable, after a sub-idea's work lands", () => {
    const parent = idea("Raw parent", "raw");
    const { child } = childWithWork(parent, true);
    expect(plan.ideaView(child).state).toBe("shipped");
    const view = plan.ideaView(parent);
    expect(view).toMatchObject({ state: "raw", progress: 1, resolvedLinks: 1 });
    expect(view.actual.end).not.toBeNull();
    expect(plan.addQuestion(parent, "What next?", "agent").questions).toEqual([{ text: "What next?", resolved: false }]);
    expect(plan.update(parent, { brief: "Still thinking" }, "agent").state).toBe("raw");
  });

  it("keeps a dropped parent dropped, restorable, and leaves its sub-ideas' states alone", () => {
    const parent = idea("Parent", "shaped");
    const { child } = childWithWork(parent, false);
    const thinking = idea("Unstarted sub-idea", "exploring", parent);
    plan.update(parent, { maturity: "dropped" }, "vp", PERSON);
    expect(plan.ideaView(parent)).toMatchObject({ state: "dropped", stage: "dropped" });
    expect(actionsOf(parent)).toEqual(["restore"]);
    expect(plan.ideaView(child).state).toBe("started");
    expect(plan.ideaView(thinking).state).toBe("exploring");
    expect(plan.update(parent, { maturity: "exploring" }, "vp", PERSON).state).toBe("exploring");
    expect(plan.ideaView(child).state).toBe("started");
  });

  it("keeps no baseline for a parent that has not started itself", () => {
    const parent = plan.capture({ title: "Dated parent", maturity: "exploring", plannedStart: "2026-11-01", plannedTarget: "2026-12-01" }, "vp", PERSON).id;
    childWithWork(parent, false);
    expect(plan.ideaView(parent).baseline).toBeNull();
    expect(store.db.prepare("SELECT plan_baseline_start AS s FROM issues WHERE id = ?").get(parent)).toEqual({ s: null });
  });

  it("rolls a sub-idea's late work up to the parent's display, not its state", () => {
    const mvp = plan.createHorizon({ name: "MVP", date: "2026-11-01" }, "vp", PERSON);
    const parent = plan.capture({ title: "Parent on MVP", maturity: "exploring", horizon: mvp.id }, "vp", PERSON).id;
    childWithWork(parent, false);
    expect(plan.ideaView(parent)).toMatchObject({ state: "exploring", late: true });
  });

  it("lets a sub-idea adopt work on its own, leaving the parent's state and offers alone", () => {
    const parent = idea("Shaped parent", "shaped");
    const { child } = childWithWork(parent, false);
    expect(plan.ideaView(child).state).toBe("started");
    expect(plan.ideaView(parent).state).toBe("shaped");
    expect(actionsOf(parent)).toEqual(SHAPED);
    expect(plan.ideaView(parent).actions.every((a) => a.disabledReason === undefined)).toBe(true);
  });
});

describe("a sub-idea promotes on its own; the parent's promotion re-parents its epics", () => {
  it("files a sub-idea's epic at the top of the tracker until its parent is promoted, then under the parent's epic", () => {
    const parent = idea("Parent idea", "shaped");
    const child = idea("Child idea", "shaped", parent);
    const epic = plan.promote(child, "vp", PERSON).identifier!;
    const task = store.createIssue({ title: "The child's first task", parent: epic });
    store.checkoutIssue(task.identifier, "agent");
    expect(plan.ideaView(parent)).toMatchObject({ state: "shaped", promoted: false });
    const roots = store.tree().map((node) => node.issue.identifier);
    expect(roots).toContain(epic);
    const parentEpic = plan.promote(parent, "vp", PERSON).identifier!;
    expect(store.getIssue(epic).parentId).toBe(store.getIssue(parentEpic).id);
    const tree = store.tree();
    expect(tree.map((node) => node.issue.identifier)).not.toContain(epic);
    const parentNode = tree.find((node) => node.issue.identifier === parentEpic)!;
    expect((parentNode.children as Array<{ issue: { identifier: string } }>).map((node) => node.issue.identifier)).toEqual([epic]);
    // The parent's epic now reads its children as any epic does: the child is underway, so is it.
    expect(store.categoryOf(store.getIssue(parentEpic).status)).toBe(store.categoryOf(store.getIssue(epic).status));
    expect(store.categoryOf(store.getIssue(epic).status)).not.toBe(store.categoryOf(store.primaryStatusFor("unstarted")));
  });

  it("files a sub-idea promoted under an already-promoted parent as the parent's child", () => {
    const parent = idea("Parent", "shaped");
    const parentEpic = plan.promote(parent, "vp", PERSON).identifier!;
    const child = idea("Later child", "shaped", parent);
    const epic = plan.promote(child, "vp", PERSON).identifier!;
    expect(store.getIssue(epic).parentId).toBe(store.getIssue(parentEpic).id);
  });
});

describe("a promoted record is an ordinary epic", () => {
  function shippedEpic(): string {
    const ref = idea("Promoted and landed", "shaped");
    const epic = plan.promote(ref, "vp", PERSON).identifier!;
    const task = store.createIssue({ title: "Its only task", parent: epic }).identifier;
    finish(task);
    expect(plan.ideaView(ref).state).toBe("shipped");
    return ref;
  }

  it("takes title and brief edits once shipped, on the plan and on the tracker alike", () => {
    const ref = shippedEpic();
    expect(actionsOf(ref)).toEqual(["adopt", "open_epic", "edit", "ask", "decide"]);
    expect(plan.update(ref, { title: "Renamed on the plan" }, "agent").title).toBe("Renamed on the plan");
    expect(store.updateIssue(ref, { title: "Renamed on the tracker" }, "agent").title).toBe("Renamed on the tracker");
    expect(plan.update(ref, { brief: "Written after it landed" }, "agent").state).toBe("shipped");
    expect(store.putDocument(ref, "notes", "An epic's notes", { author: "agent" }).revision).toBe(1);
  });

  it("still refuses its steering in a shipped state", () => {
    const ref = shippedEpic();
    expect(refused(() => plan.update(ref, { horizon: horizon("Now") }, "vp", PERSON)).message).toContain("is shipped; it cannot be scheduled");
  });
});

describe("a maturity that does not change is a no-op", () => {
  it("accepts shaped → shaped on a started record and writes nothing", () => {
    const ref = idea("Started", "shaped");
    plan.adopt(ref, store.createIssue({ title: "work" }).identifier, "agent");
    const before = store.getIssue(ref).updatedAt;
    expect(plan.update(ref, { maturity: "shaped" }, "vp", PERSON).state).toBe("started");
    expect(store.getIssue(ref).updatedAt).toBe(before);
  });

  it("refuses going back to raw in words that say so", () => {
    const ref = idea("Exploring", "exploring");
    expect(refused(() => plan.update(ref, { maturity: "raw" }, "vp", PERSON)).message).toMatch(/^The idea "Exploring" is exploring; it cannot be moved back to raw\. An exploring idea offers: /);
  });
});

describe("an idea's documents and files are its edit", () => {
  function shipped(): string {
    const ref = idea("Landed idea", "shaped");
    plan.update(ref, { brief: "v1" }, "agent");
    plan.update(ref, { brief: "v2" }, "agent");
    const work = store.createIssue({ title: "Its work" }).identifier;
    plan.adopt(ref, work, "agent");
    store.attachFile(ref, { filename: "note.txt", bytes: new TextEncoder().encode("evidence"), author: "agent" });
    finish(work);
    expect(plan.ideaView(ref).state).toBe("shipped");
    return ref;
  }
  const lifecycle = (fn: () => unknown, state: string) => expect(refused(fn).message).toContain(`is ${state}; it cannot be edited`);

  it("refuses any document write or restore on a shipped idea, whatever the key", () => {
    const ref = shipped();
    lifecycle(() => store.putDocument(ref, "brief", "rewritten", { author: "agent" }), "shipped");
    lifecycle(() => store.putDocument(ref, "questions", "- [ ] late\n", { author: "agent" }), "shipped");
    lifecycle(() => store.putDocument(ref, "risks", "a plan section stage C adds", { author: "agent" }), "shipped");
    lifecycle(() => store.restoreDocumentRevision(ref, "brief", 1, "vp"), "shipped");
    expect(store.getDocument(ref, "brief").body).toBe("v2");
  });

  it("refuses files added to or removed from a shipped idea", () => {
    const ref = shipped();
    lifecycle(() => store.attachFile(ref, { filename: "late.txt", bytes: new TextEncoder().encode("late"), author: "agent" }), "shipped");
    const file = store.listFiles(ref)[0]!;
    lifecycle(() => store.removeFile(file.id, "agent"), "shipped");
    expect(store.listFiles(ref)).toHaveLength(1);
  });

  it("refuses document writes on a dropped idea, and takes them again once it is restored", () => {
    const ref = idea("Dropped idea", "exploring");
    plan.update(ref, { maturity: "dropped" }, "vp", PERSON);
    lifecycle(() => store.putDocument(ref, "brief", "an agent's rewrite", { author: "agent" }), "dropped");
    plan.update(ref, { maturity: "exploring" }, "vp", PERSON);
    expect(store.putDocument(ref, "brief", "after the restore", { author: "agent" }).revision).toBe(1);
  });

  it("takes documents and files on an idea whose state offers editing", () => {
    const ref = idea("Raw idea", "raw");
    expect(store.putDocument(ref, "context", "Why it matters", { author: "agent" }).revision).toBe(1);
    expect(store.attachFile(ref, { filename: "sketch.txt", bytes: new TextEncoder().encode("sketch"), author: "agent" }).filename).toBe("sketch.txt");
  });
});

describe("an exploring idea adopts work", () => {
  const STARTED = ["edit", "ask", "decide", "schedule", "plan_dates", "reorder", "adopt", "unlink", "reset_baseline"];

  it("links existing work while exploring and reads started, its maturity still exploring and still the person's to shape", () => {
    const ref = idea("Billing export", "exploring");
    const work = store.createIssue({ title: "Export endpoint" });
    expect(plan.adopt(ref, work.identifier, "agent")).toMatchObject({ maturity: "exploring", stage: "started", state: "started", links: [work.id] });
    // The started row, and Mark shaped on top of it: the maturity is still the person's to move.
    expect(actionsOf(ref)).toEqual([...STARTED, "shape"]);
    plan.addQuestion(ref, "Which formats?", "agent");
    expect(plan.ideaView(ref).actions.find((action) => action.id === "shape")?.disabledReason).toContain("1 open question answered or deferred");
    plan.deferQuestion(ref, 1, "agent");
    expect(refused(() => plan.update(ref, { maturity: "shaped" }, "agent")).message).toContain("the person's call");
    expect(plan.update(ref, { maturity: "shaped" }, "vp", PERSON)).toMatchObject({ maturity: "shaped", state: "started" });
    expect(actionsOf(ref)).toEqual(STARTED);
  });

  it("never links work to a raw idea, naming the state", () => {
    const ref = idea("Half a thought", "raw");
    const error = refused(() => plan.adopt(ref, store.createIssue({ title: "Some work" }).identifier, "agent"));
    expect(error.message).toContain("is raw; it cannot be linked to work");
    expect(plan.ideaView(ref)).toMatchObject({ state: "raw", links: [] });
  });

  it("puts its work in its horizon and keeps its baseline as a shaped idea's would, and stays out of the tracker", () => {
    const now = horizon("Now");
    const ref = plan.capture({ title: "Reserved slot", maturity: "exploring", horizon: now, plannedStart: "2026-11-01", plannedTarget: "2026-11-30" }, "vp", PERSON).id;
    const work = store.createIssue({ title: "Its first ticket" });
    plan.adopt(ref, work.identifier, "agent");
    expect(store.milestones().get(now).members.map((member) => member.issueId)).toEqual([work.id]);
    expect(plan.ideaView(ref).baseline).toEqual({ start: "2026-11-01", target: "2026-11-30" });
    plan.update(ref, { plannedTarget: "2026-12-15" }, "vp", PERSON);
    expect(plan.ideaView(ref).baseline).toEqual({ start: "2026-11-01", target: "2026-11-30" });
    expect(refused(() => store.queue().enqueue(ref, {}, "agent")).message).toContain("cannot be queued");
    expect(refused(() => store.checkoutIssue(ref, "agent")).message).toContain("cannot be checked out");
    expect(store.listIssues({}).map((issue) => issue.id)).not.toContain(ref);
  });
});
