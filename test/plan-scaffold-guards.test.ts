/**
 * What holds Scaffold to the plan it shows (design/plan.md, "Scaffold"): the shaped gate read
 * again at confirm, a confirm tied to the preview it names, rows that inherit the plan's
 * acceptance, blockers it adds and never removes, row identity that survives a renamed key, and
 * plan writes checked whole on the way in.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanPatch } from "../src/core/plan-sections.js";
import { INHERITED_ACCEPTANCE_LABEL, scaffoldTaskId, type PlanStore } from "../src/core/plan-store.js";
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
  plan.enable("vp");
});

function refusal(fn: () => unknown, code = "validation"): string {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(StapleError);
    expect((error as StapleError).code).toBe(code);
    return (error as StapleError).message;
  }
  throw new Error("expected a refusal");
}

const PLAN: PlanPatch = {
  goal: "G",
  breakdown: [
    { key: "1.1", title: "A", estimate: "3h", dependsOn: [], acceptance: "a", owner: null, notes: null },
    { key: "1.2", title: "B", estimate: "2h", dependsOn: ["1.1"], acceptance: "b", owner: null, notes: null },
  ],
  acceptance: ["x"],
};
const shaped = (title: string, sections: PlanPatch = PLAN) => plan.capture({ title, maturity: "shaped", plan: sections }, "vp", PERSON).id;
const confirm = (id: string, actor = "agent") => plan.scaffold(id, plan.scaffoldPreview(id).fingerprint, actor);
const children = (id: string) => store.listIssues({}).filter((issue) => issue.parentId === id);

describe("a shaped plan edited since it was shaped", () => {
  const hollowings: Array<[string, (id: string) => void, string]> = [
    ["its goal cleared by an agent", (id) => plan.update(id, { plan: { goal: null } }, "agent"), "a goal"],
    ["its breakdown emptied", (id) => plan.update(id, { plan: { breakdown: [] } }, "agent"), "a task breakdown"],
    ["its acceptance criteria cleared", (id) => plan.update(id, { plan: { acceptance: [] } }, "agent"), "acceptance criteria"],
    ["an open question added", (id) => plan.addQuestion(id, "Is this right?", "agent"), "1 open question answered or deferred"],
    [
      "a deferred question opened again",
      (id) => {
        plan.deferQuestion(id, 1, "agent", false);
      },
      "1 open question answered or deferred",
    ],
    ["its goal restored to an empty revision", (id) => store.restoreDocumentRevision(id, "goal", 2, "agent"), "a goal"],
    ["a row waiting on a key it does not hold", (id) => plan.update(id, { plan: { breakdown: [...PLAN.breakdown!, { key: "1.3", title: "C", dependsOn: ["1.9"] }] } }, "agent"), "1.9 is not in the breakdown"],
  ];

  for (const [what, hollow, missing] of hollowings) {
    it(`stays shaped, says what it lacks, and holds Scaffold and Promote back: ${what}`, () => {
      const id = plan.capture({ title: what, plan: PLAN }, "agent").id;
      // A goal history with an empty revision (r2) to restore, and a question left open on purpose.
      plan.update(id, { plan: { goal: null } }, "agent");
      plan.update(id, { plan: { goal: "G" } }, "agent");
      plan.addQuestion(id, "Later?", "agent");
      plan.deferQuestion(id, 1, "agent");
      plan.update(id, { maturity: "shaped" }, "vp", PERSON);
      hollow(id);
      const view = plan.ideaView(id);
      expect(view).toMatchObject({ maturity: "shaped", state: "shaped" });
      expect(view.planIncomplete.join("; ")).toContain(missing);
      for (const action of ["scaffold", "promote"]) expect(view.actions.find((offered) => offered.id === action)?.disabledReason).toContain("Plan incomplete");
      const preview = plan.scaffoldPreview(id);
      expect(preview.problems.join("; ")).toContain(missing);
      expect(refusal(() => plan.scaffold(id, preview.fingerprint, "agent"))).toContain("its plan is incomplete, so it cannot be scaffolded");
      expect(refusal(() => plan.promote(id, "vp", PERSON))).toContain("its plan is incomplete, so it cannot be promoted");
      expect(store.getIssue(id).kind).toBe("idea");
      expect(children(id)).toEqual([]);
    });
  }

  it("refuses a breakdown written as anything but rows, on the raw document path too", () => {
    const id = shaped("Raw document");
    expect(refusal(() => store.putDocument(id, "breakdown", "| 1 | not json |", { author: "agent" }))).toContain("structured rows, not a document");
    expect(refusal(() => store.putDocument(id, "acceptance", "Just prose, no items", { author: "agent" }))).toContain('one "- item" per line');
    expect(refusal(() => store.putDocument(id, "questions", "Who pays?", { author: "agent" }))).toContain("a checklist");
    expect(refusal(() => plan.update(id, { plan: { breakdown: "oops" as never } }, "agent"))).toContain("plan.breakdown must be a list of rows");
    expect(plan.detail(id).plan.breakdown).toHaveLength(2);
  });

  it("refuses any plan payload of the wrong shape, by name, writing nothing", () => {
    const id = shaped("Payloads");
    for (const [patch, message] of [
      [{ acceptance: "one criterion" }, "plan.acceptance must be a list of text"],
      [{ goal: 7 }, "plan.goal must be text or null"],
      [{ breakdown: [{ key: "1", title: "t", dependsOn: 3 }] }, "dependsOn must be a list of keys"],
      [{ breakdown: [{}] }, "needs a key or a title"],
      [{ shiny: "x" }, "Unknown plan section: shiny"],
    ] as const) {
      expect(refusal(() => plan.update(id, { plan: patch as never }, "agent"))).toContain(message);
    }
    expect(plan.detail(id).plan).toMatchObject({ goal: "G", acceptance: ["x"] });
  });
});

describe("import into shaped", () => {
  it("is held to the gate over everything it writes, open questions included, and writes nothing when refused", () => {
    const markdown = "# Imp\n\n## Goal\n\ng\n\n## Task breakdown\n\n| # | Task |\n|---|---|\n| 1.1 | Do |\n\n## Acceptance criteria\n\n- ok\n\n## Open questions\n\n- [ ] Who pays?\n";
    const before = store.listIssues({}).length;
    expect(refusal(() => plan.importPlan({ name: "imp.md", markdown }, { maturity: "shaped" }, "vp", PERSON))).toContain("1 open question answered or deferred");
    expect(store.listIssues({}).length).toBe(before);
    const deferred = plan.importPlan({ name: "imp.md", markdown: markdown.replace("- [ ] Who pays?", "- [~] Who pays?") }, { maturity: "shaped" }, "vp", PERSON);
    expect(deferred.idea.idea.state).toBe("shaped");
  });

  it("attaches the source file, byte for byte", () => {
    const markdown = "# Attached\n\n## Goal\n\ng\n";
    const result = plan.importPlan({ name: "attached.md", markdown }, {}, "agent");
    const files = store.listFiles(result.idea.idea.id);
    expect(files.map((file) => [file.filename, file.size])).toEqual([["attached.md", Buffer.byteLength(markdown)]]);
    expect(result.idea.plan.sources).toEqual(["attached.md (attached)"]);
  });
});

describe("the confirm", () => {
  it("is refused without a preview's fingerprint, and when the plan changed since the preview", () => {
    const id = shaped("Stale");
    expect(refusal(() => plan.scaffold(id, null, "agent"))).toContain("Preview");
    const preview = plan.scaffoldPreview(id);
    plan.update(id, { plan: { breakdown: [{ key: "9", title: "Something else" }] } }, "agent");
    expect(refusal(() => plan.scaffold(id, preview.fingerprint, "agent"), "revision_conflict")).toContain("the plan changed since the preview");
    expect(children(id)).toEqual([]);
    const fresh = plan.scaffoldPreview(id);
    expect(plan.scaffold(id, fresh.fingerprint, "agent").tasks.map((task) => task.title)).toEqual(["9 Something else"]);
  });

  it("names exactly what the preview shows: the same plan answers the same fingerprint", () => {
    const id = shaped("Stable");
    expect(plan.scaffoldPreview(id).fingerprint).toBe(plan.scaffoldPreview(id).fingerprint);
  });

  it("previews only where the state offers Scaffold: a raw idea and a plain task are refused, as their confirm is", () => {
    const raw = plan.capture({ title: "Raw", plan: PLAN }, "agent").id;
    expect(refusal(() => plan.scaffoldPreview(raw))).toContain("is raw; it cannot be scaffolded");
    const task = store.createIssue({ title: "plain" });
    expect(refusal(() => plan.scaffoldPreview(task.identifier))).toContain("is not part of the plan");
  });
});

describe("a row without its own done-when", () => {
  it("passes the gate, and its task takes the plan's acceptance, labelled and said to be inherited", () => {
    const id = shaped("Inherits", { ...PLAN, acceptance: ["Pinned clients keep working", "Every error has a type"], breakdown: [{ key: "1", title: "No done-when", estimate: "1h" }] });
    const preview = plan.scaffoldPreview(id);
    expect(preview.tasks[0]).toMatchObject({ acceptance: ["Pinned clients keep working", "Every error has a type"], acceptanceInherited: true });
    const made = store.getIssue(plan.scaffold(id, preview.fingerprint, "agent").tasks[0]!.existing!);
    expect(made.acceptanceCriteria).toEqual(["Pinned clients keep working", "Every error has a type"]);
    expect(made.labels).toEqual([INHERITED_ACCEPTANCE_LABEL]);
    expect(store.getDocument(made.id, "context").body).toContain("## Done when (inherited)");
  });

  it("shows an estimate that is not a duration on the preview's task, and leaves the task without one", () => {
    const id = shaped("Vague", { ...PLAN, breakdown: [{ key: "1", title: "Soon", estimate: "a while", acceptance: "a" }] });
    const preview = plan.scaffoldPreview(id);
    expect(preview.tasks[0]).toMatchObject({ estimatedSeconds: null, estimateWarning: 'the estimate "a while" is not a duration (write 3h, 30m, 2d or 1w)' });
    expect(preview.warnings).toEqual(['task 1: the estimate "a while" is not a duration (write 3h, 30m, 2d or 1w)']);
  });

  it("keeps its own done-when, unlabelled, when it has one", () => {
    const id = shaped("Own");
    const made = store.getIssue(confirm(id).tasks[0]!.existing!);
    expect(made).toMatchObject({ acceptanceCriteria: ["a"], labels: [] });
  });
});

describe("Scaffold again", () => {
  it("adds the blockers depends-on names and never removes one a person set", () => {
    const id = shaped("Blockers");
    const first = confirm(id, "vp");
    const [a, b] = first.tasks.map((task) => store.getIssue(task.existing!));
    const outside = store.createIssue({ title: "Outside blocker" });
    store.setBlockedBy(b!.id, [outside.id], "vp");
    plan.update(id, { plan: { breakdown: [...PLAN.breakdown!, { key: "1.3", title: "C", acceptance: "c" }] } }, "vp", PERSON);
    confirm(id, "vp");
    expect(store.blockersOf(b!.id).map((blocker) => blocker.id).sort()).toEqual([a!.id, outside.id].sort());
  });

  it("keeps a row's task when its key is renamed: the row, not its key, names the task", () => {
    const id = shaped("Rename");
    const first = confirm(id);
    const rows = plan.detail(id).plan.breakdown.map((row) => (row.key === "1.1" ? { ...row, key: "1.1a" } : { ...row, dependsOn: ["1.1a"] }));
    plan.update(id, { plan: { breakdown: rows } }, "agent");
    const again = confirm(id);
    expect(children(id)).toHaveLength(2);
    expect(again.tasks.map((task) => task.existing)).toEqual(first.tasks.map((task) => task.existing));
    expect(again.tasks.map((task) => task.blockedBy)).toEqual([[], ["1.1a"]]);
  });

  it("names each task by the idea and its row, so every device makes the same one", () => {
    const id = shaped("Identity");
    const made = confirm(id);
    const rows = plan.detail(id).plan.breakdown;
    expect(made.tasks.map((task) => store.getIssue(task.existing!).id)).toEqual(rows.map((row) => scaffoldTaskId(id, row.id)));
  });
});

describe("a depends-on cycle", () => {
  it("is named in the gate and the preview, and nothing is created", () => {
    const id = plan.capture({ title: "Cycle", maturity: "exploring", plan: { ...PLAN, breakdown: [{ key: "1", title: "A", dependsOn: ["2"] }, { key: "2", title: "B", dependsOn: ["1"] }] } }, "vp", PERSON).id;
    expect(refusal(() => plan.update(id, { maturity: "shaped" }, "vp", PERSON))).toContain("no depends-on cycle (1 → 2 → 1)");
  });
});

describe("the breakdown on one device", () => {
  it("refuses a save made against a breakdown that changed since it was read", () => {
    const id = shaped("Stale editor");
    const read = plan.detail(id);
    plan.update(id, { plan: { breakdown: [...read.plan.breakdown, { key: "1.3", title: "Added in another tab" }] }, breakdownBase: read.breakdownRevision }, "agent");
    const stale = read.plan.breakdown.map((row) => (row.key === "1.1" ? { ...row, title: "Edited in the first tab" } : row));
    expect(refusal(() => plan.update(id, { plan: { breakdown: stale }, breakdownBase: read.breakdownRevision }, "agent"), "revision_conflict")).toContain("changed since it was read");
    expect(plan.detail(id).plan.breakdown.map((row) => row.title)).toEqual(["A", "B", "Added in another tab"]);
  });

  it("writes only the rows that changed, so an edit to one row leaves the others as they were", () => {
    const id = shaped("One row");
    const rows = plan.detail(id).plan.breakdown;
    const before = store.db.prepare("SELECT row_id, body, rank FROM plan_rows WHERE idea_id = ? ORDER BY rank").all(id) as Array<{ row_id: string; body: string; rank: number }>;
    plan.update(id, { plan: { breakdown: rows.map((row) => (row.key === "1.2" ? { ...row, title: "B, edited" } : row)) } }, "agent");
    const after = store.db.prepare("SELECT row_id, body, rank FROM plan_rows WHERE idea_id = ? ORDER BY rank").all(id) as Array<{ row_id: string; body: string; rank: number }>;
    expect(after[0]).toEqual(before[0]);
    expect(after[1]!.row_id).toBe(before[1]!.row_id);
    expect(JSON.parse(after[1]!.body).title).toBe("B, edited");
  });
});
