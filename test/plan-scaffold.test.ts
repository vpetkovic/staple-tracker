/**
 * An idea as a plan in the store (design/plan.md, "Plan sections", "Scaffold"): sections persist
 * as revisioned documents, the shaped gate holds on every way to shaped, Scaffold creates exactly
 * what its preview shows, idempotently and for nested ideas, and a plan file imports whole.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanPatch } from "../src/core/plan-sections.js";
import type { PlanStore } from "../src/core/plan-store.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { StapleError } from "../src/core/types.js";

const PERSON = { person: { via: "plan_view" } } as const;

let store: WorkspaceStore;
let plan: PlanStore;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
  plan = store.plan();
  plan.clock = () => new Date("2026-11-08T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
});

function refused(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe("validation");
    return (error as StapleError).message;
  }
  throw new Error("expected a validation refusal");
}

const PLAN: PlanPatch = {
  goal: "Checkout as a product.",
  context: "Pinned versions; one error envelope.",
  breakdown: [
    { key: "1.1", title: "Spike the provider", estimate: "3h", dependsOn: [], acceptance: "Findings written", owner: "lead", notes: null },
    { key: "1.2", title: "Versioning ADR", estimate: "2h", dependsOn: ["1.1"], acceptance: "ADR accepted", owner: null, notes: null },
    { key: "1.3", title: "Rate limits", estimate: "1.5h", dependsOn: ["1.2", "PLAN-3"], acceptance: "429 with Retry-After", owner: null, notes: "needs PLAN-3" },
  ],
  acceptance: ["A pinned client keeps working", "Every error has a type"],
  outOfScope: "Billing.",
  risks: "Review bandwidth.",
};

/** Scaffold as every surface does it: preview, then confirm with that preview's fingerprint. */
function confirm(ref: string, actor: string) {
  return plan.scaffold(ref, plan.scaffoldPreview(ref).fingerprint, actor);
}

function shaped(title: string, sections: PlanPatch = PLAN, extra: { parent?: string } = {}): string {
  return plan.capture({ title, maturity: "shaped", plan: sections, ...extra }, "vp", PERSON).id;
}

describe("plan sections", () => {
  it("persist as revisioned documents, each section written only when it changes", () => {
    const id = plan.capture({ title: "Sections", plan: { goal: "First goal" } }, "agent").id;
    plan.update(id, { plan: { goal: "Second goal", acceptance: ["one", "two"] } }, "agent");
    plan.update(id, { plan: { goal: "Second goal" } }, "agent");
    const detail = plan.detail(id);
    expect(detail.plan).toMatchObject({ goal: "Second goal", acceptance: ["one", "two"] });
    expect(store.getDocument(id, "goal").revision).toBe(2);
    expect(store.getDocument(id, "acceptance").revision).toBe(1);
  });

  it("keep the breakdown structured, and refuse two rows with one key", () => {
    const id = shaped("Structured");
    expect(plan.detail(id).plan.breakdown.map((row) => [row.key, row.dependsOn])).toEqual([
      ["1.1", []],
      ["1.2", ["1.1"]],
      ["1.3", ["1.2", "PLAN-3"]],
    ]);
    const twice = [PLAN.breakdown![0]!, PLAN.breakdown![0]!];
    expect(refused(() => plan.update(id, { plan: { breakdown: twice } }, "agent"))).toContain("share the key 1.1");
  });

  it("are an edit: a state that offers no edits refuses them", () => {
    const id = shaped("Landed");
    const work = store.createIssue({ title: "Its work" });
    plan.adopt(id, work.identifier, "agent");
    store.checkoutIssue(work.identifier, "agent");
    store.updateIssue(work.identifier, { status: "done" }, "agent");
    expect(plan.ideaView(id).state).toBe("shipped");
    expect(refused(() => plan.update(id, { plan: { goal: "Rewritten after it landed" } }, "agent"))).toContain("is shipped; it cannot be edited");
    expect(plan.detail(id).plan.goal).toBe(PLAN.goal);
  });

  it("are written by an agent, as edits are", () => {
    const id = plan.capture({ title: "Agent drafts the plan" }, "agent").id;
    expect(plan.update(id, { plan: PLAN }, "agent").id).toBe(id);
    expect(plan.detail(id).completeness).toEqual({ starred: 3, starredTotal: 3, filled: 6, total: 10 });
  });
});

describe("the shaped gate", () => {
  it("refuses shaping, from raw or exploring, until the plan has what it needs, naming it", () => {
    const raw = plan.capture({ title: "Thin" }, "agent").id;
    expect(refused(() => plan.update(raw, { maturity: "shaped" }, "vp", PERSON))).toBe(
      'The idea "Thin" cannot be marked shaped yet: it needs a goal, a task breakdown and acceptance criteria before it is shaped.',
    );
    plan.update(raw, { maturity: "exploring" }, "vp", PERSON);
    plan.update(raw, { plan: { ...PLAN, breakdown: [{ ...PLAN.breakdown![0]!, title: "" }] } }, "agent");
    expect(refused(() => plan.update(raw, { maturity: "shaped" }, "vp", PERSON))).toContain("a title on task 1.1");
    expect(plan.ideaView(raw).actions.find((action) => action.id === "shape")?.disabledReason).toContain("a title on task 1.1");
    plan.update(raw, { plan: { breakdown: PLAN.breakdown } }, "agent");
    expect(plan.update(raw, { maturity: "shaped" }, "vp", PERSON).state).toBe("shaped");
  });

  it("holds a capture straight into shaped, and a raw idea shaped in one write, to the same gate", () => {
    expect(refused(() => plan.capture({ title: "Shaped, no plan", maturity: "shaped" }, "vp", PERSON))).toContain("needs a goal");
    const raw = plan.capture({ title: "Raw to shaped" }, "agent").id;
    expect(plan.update(raw, { maturity: "shaped", plan: PLAN }, "vp", PERSON).state).toBe("shaped");
  });

  it("lets a deferred question through and holds an open one back", () => {
    const id = plan.capture({ title: "Questions", maturity: "exploring", plan: PLAN }, "vp", PERSON).id;
    plan.addQuestion(id, "Webhooks in v1?", "agent");
    expect(refused(() => plan.update(id, { maturity: "shaped" }, "vp", PERSON))).toContain("1 open question answered or deferred");
    plan.deferQuestion(id, 1, "agent");
    expect(plan.detail(id).questions).toEqual([{ text: "Webhooks in v1?", resolved: false, deferred: true }]);
    expect(plan.update(id, { maturity: "shaped" }, "vp", PERSON).state).toBe("shaped");
  });
});

describe("Scaffold", () => {
  it("creates exactly what its preview shows: the epic, and a task per row with estimate, blockers, acceptance and context", () => {
    const id = shaped("Checkout API");
    const preview = plan.scaffoldPreview(id);
    expect(preview.epic).toMatchObject({ identifier: null, kind: "epic", acceptance: PLAN.acceptance, promoted: false });
    expect(preview.tasks.map((task) => [task.title, task.estimatedSeconds, task.blockedBy, task.waitsOutside, task.acceptance, task.existing])).toEqual([
      ["1.1 Spike the provider", 10800, [], [], ["Findings written"], null],
      ["1.2 Versioning ADR", 7200, ["1.1"], [], ["ADR accepted"], null],
      ["1.3 Rate limits", 5400, ["1.2"], ["PLAN-3"], ["429 with Retry-After"], null],
    ]);
    const made = confirm(id, "agent");
    const epic = store.getIssue(id);
    expect(epic).toMatchObject({ kind: "epic", acceptanceCriteria: PLAN.acceptance });
    expect(store.getDocument(id, "plan").body).toBe(preview.epic.planDocument);
    const tasks = made.tasks.map((task) => store.getIssue(task.existing!));
    expect(tasks.map((task) => [task.title, task.estimatedSeconds, task.acceptanceCriteria, task.parentId])).toEqual(
      preview.tasks.map((task) => [task.title, task.estimatedSeconds, task.acceptance, epic.id]),
    );
    expect(store.blockersOf(tasks[1]!.id).map((blocker) => blocker.id)).toEqual([tasks[0]!.id]);
    expect(store.blockersOf(tasks[2]!.id).map((blocker) => blocker.id)).toEqual([tasks[1]!.id]);
    const context = store.getDocument(tasks[2]!.id, "context").body;
    expect(context).toBe(preview.tasks[2]!.context);
    expect(context).toContain("Part of **Checkout API**");
    expect(context).toContain("429 with Retry-After");
    expect(context).toContain("- PLAN-3 (outside this plan)");
    expect(plan.ideaView(id)).toMatchObject({ promoted: true, state: "started" });
  });

  it("is idempotent: a retry creates nothing, and rows written since are all it adds", () => {
    const id = shaped("Retry me");
    const first = confirm(id, "agent");
    const count = () => store.listIssues({}).filter((issue) => issue.parentId === id).length;
    expect(count()).toBe(3);
    const again = confirm(id, "agent");
    expect(again.tasks.map((task) => task.existing)).toEqual(first.tasks.map((task) => task.existing));
    expect(count()).toBe(3);
    plan.update(id, { plan: { breakdown: [...PLAN.breakdown!, { key: "1.4", title: "Docs", estimate: "1h", dependsOn: ["1.3"], acceptance: "Published", owner: null, notes: null }] } }, "agent");
    const more = confirm(id, "agent");
    expect(count()).toBe(4);
    expect(more.tasks.slice(0, 3).map((task) => task.existing)).toEqual(first.tasks.map((task) => task.existing));
    expect(store.blockersOf(store.getIssue(more.tasks[3]!.existing!).id).map((b) => b.id)).toEqual([store.getIssue(first.tasks[2]!.existing!).id]);
  });

  it("scaffolds a shaped sub-idea as a child epic under the epic, and leaves an unshaped one an idea", () => {
    const parent = shaped("Release GA");
    const child = shaped("Rung 2", { ...PLAN, breakdown: [{ key: "2.1", title: "Endpoints", estimate: "4h", dependsOn: [], acceptance: "Served", owner: null, notes: null }] }, { parent });
    const thinking = plan.capture({ title: "Rung 9", parent, maturity: "exploring" }, "vp", PERSON).id;
    const preview = plan.scaffoldPreview(parent);
    expect(preview.children.map((c) => c.idea.id)).toEqual([child]);
    confirm(parent, "agent");
    expect(store.getIssue(child)).toMatchObject({ kind: "epic", parentId: parent });
    expect(store.listIssues({}).filter((issue) => issue.parentId === child).map((issue) => issue.title)).toEqual(["2.1 Endpoints"]);
    expect(plan.ideaView(thinking)).toMatchObject({ promoted: false, state: "exploring" });
  });

  it("scaffolds a sub-idea before its parent; the parent's Scaffold then files that epic under its own and adds nothing twice", () => {
    const parent = shaped("Release GA");
    const child = shaped("Rung 2", { ...PLAN, breakdown: [{ key: "2.1", title: "Endpoints", estimate: "4h", dependsOn: [], acceptance: "Served", owner: null, notes: null }] }, { parent });
    expect(plan.ideaView(child).actions.find((action) => action.id === "scaffold")?.disabledReason).toBeUndefined();
    confirm(child, "agent");
    const childTask = store.listIssues({}).find((issue) => issue.parentId === child)!;
    store.checkoutIssue(childTask.identifier, "agent");
    const childEpic = store.getIssue(child);
    expect(childEpic).toMatchObject({ kind: "epic" });
    expect(store.tree().map((node) => node.issue.identifier)).toContain(childEpic.identifier);
    // The parent's own state is untouched by its sub-idea's start.
    expect(plan.ideaView(parent)).toMatchObject({ state: "shaped", promoted: false });
    const before = store.listIssues({}).length;
    confirm(parent, "agent");
    const parentEpic = store.getIssue(parent);
    expect(store.getIssue(child).parentId).toBe(parentEpic.id);
    expect(store.tree().map((node) => node.issue.identifier)).not.toContain(childEpic.identifier);
    // The parent epic reads its sub-epic as any epic does: that one is underway, so is it.
    expect(store.categoryOf(store.getIssue(parent).status)).toBe(store.categoryOf(store.getIssue(child).status));
    expect(store.categoryOf(store.getIssue(parent).status)).not.toBe(store.categoryOf(store.primaryStatusFor("unstarted")));
    // The parent's epic and its own rows only; the sub-idea's task replays.
    expect(store.listIssues({}).length - before).toBe(1 + PLAN.breakdown!.length);
    expect(store.listIssues({}).filter((issue) => issue.parentId === child).map((issue) => issue.title)).toEqual(["2.1 Endpoints"]);
  });

  it("is offered only where the lifecycle offers it: never to an idea that is not shaped", () => {
    const raw = plan.capture({ title: "Not shaped", plan: PLAN }, "agent").id;
    expect(refused(() => plan.scaffold(raw, null, "agent"))).toContain("is raw; it cannot be scaffolded");
    const linked = shaped("Linked, not scaffolded");
    plan.adopt(linked, store.createIssue({ title: "Existing work" }).identifier, "agent");
    expect(plan.ideaView(linked).actions.map((action) => action.id)).not.toContain("scaffold");
    expect(refused(() => plan.scaffold(linked, null, "agent"))).toContain("cannot be scaffolded");
  });
});

describe("import", () => {
  it("captures one idea from a plan file: its sections, questions, decisions, and the file attached", () => {
    const markdown = `# PLAN-7 — Checkout API\n\n## 1. Goal\n\nShip it.\n\n## 2. Decisions\n\n### 2.1 Dated versions\n\nYes.\n\n## 3. Task breakdown\n\n| # | Task | Est. | Depends on |\n|---|---|---|---|\n| 7.1 | Spike | 3h | — |\n| 7.2 | Build | 5h | 7.1 |\n\n## 4. Acceptance criteria\n\n- [ ] Works\n\n## 5. Open questions\n\n- [ ] Webhooks?\n`;
    const result = plan.importPlan({ name: "PLAN-7-checkout.md", markdown }, {}, "agent");
    expect(result.rows).toBe(2);
    expect(result.warnings).toEqual([]);
    expect(result.idea.idea).toMatchObject({ title: "PLAN-7 — Checkout API", state: "raw", identifier: null });
    expect(result.idea.plan.breakdown.map((row) => row.key)).toEqual(["7.1", "7.2"]);
    expect(result.idea.plan.sources).toEqual(["PLAN-7-checkout.md (attached)"]);
    expect(result.idea.questions).toEqual([{ text: "Webhooks?", resolved: false }]);
    expect(result.idea.decisions).toEqual(["Dated versions"]);
    expect(store.listFiles(result.idea.idea.id).map((file) => file.filename)).toEqual(["PLAN-7-checkout.md"]);
    // Rows without their own "done when" inherit the plan's acceptance; the open question holds shaping back.
    expect(result.idea.missingForShaped).toEqual(["1 open question answered or deferred"]);
  });
});
