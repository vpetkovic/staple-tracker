/**
 * Where plan work came from (design/plan.md, "Provenance"): a scaffolded ticket keeps the idea
 * and breakdown row it was made from, and names them in its context document; an idea captured
 * with the ticket that sparked it shows that ticket, and the ticket lists the idea. Planning off
 * hides both and keeps them.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import type { PlanPatch } from "../src/core/plan-sections.js";
import { SCAFFOLD_ORIGIN_KIND, SPARKED_ORIGIN_KIND } from "../src/core/plan-provenance.js";
import { scaffoldedFromWords, sparkedIdeaWords } from "../src/core/plan-provenance-words.js";
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
  plan.clock = () => new Date("2026-11-27T12:00:00.000Z");
  plan.enable("vp", { person: { via: "settings" } });
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
    { key: "R1", title: "First", estimate: "3h", dependsOn: [], acceptance: "a", owner: null, notes: null },
    { key: "R2", title: "Second", estimate: "2h", dependsOn: ["R1"], acceptance: "b", owner: null, notes: null },
  ],
  acceptance: ["x"],
};

/** A shaped idea scaffolded: its id, its number, and its tasks by row key. */
function scaffolded(title = "Checkout") {
  const id = plan.capture({ title, maturity: "shaped", plan: PLAN }, "vp", PERSON).id;
  const number = plan.ideaView(id).number!;
  const made = plan.scaffold(id, plan.scaffoldPreview(id).fingerprint, "agent");
  const rows = new Map(plan.detail(id).plan.breakdown.map((row) => [row.key, row.id]));
  const tasks = new Map(made.tasks.map((task) => [task.key, store.getIssue(task.existing!)]));
  return { id, number, rows, tasks, epic: store.getIssue(id) };
}

const origin = (id: string) => store.db.prepare("SELECT origin_kind, origin_id FROM issues WHERE id = ?").get(id) as { origin_kind: string; origin_id: string | null };

describe("a scaffolded ticket's provenance", () => {
  it("keeps the idea and the row it came from in its own create, and every read names them", () => {
    const { id, number, rows, tasks, epic } = scaffolded();
    expect(number).toMatch(/^I-TST-\d+$/);
    const first = tasks.get("R1")!;
    expect(origin(first.id)).toEqual({ origin_kind: SCAFFOLD_ORIGIN_KIND, origin_id: `${id}/${rows.get("R1")}` });
    const from = store.context(first.identifier).scaffoldedFrom;
    expect(from).toEqual({ ideaId: id, ideaNumber: number, identifier: epic.identifier, title: "Checkout", rowId: rows.get("R1"), rowKey: "R1", parentUnsettled: null });
    expect(scaffoldedFromWords(from!)).toBe(`from ${number} · row R1`);
    expect(store.context(tasks.get("R2")!.identifier).scaffoldedFrom?.rowKey).toBe("R2");
    // The epic the idea became is not a row's ticket.
    expect(store.context(epic.identifier).scaffoldedFrom).toBeNull();
  });

  it("names the idea number and the row in its context document", () => {
    const { number, tasks } = scaffolded();
    const body = store.getDocument(tasks.get("R2")!.id, "context").body;
    expect(body).toContain(`Scaffolded from idea ${number}, breakdown row R2, as numbered at scaffold; \`staple show\` names both as they stand now.`);
  });

  it("never writes a stand-in number into its context document: it names the row, and the read names the idea", () => {
    const id = plan.capture({ title: "Collided", maturity: "shaped", plan: PLAN }, "vp", PERSON).id;
    // Sync gave it a stand-in while another device's idea holds its number (`I-TST-1+7`).
    const standIn = `${plan.ideaView(id).number}+7`;
    store.db.prepare("UPDATE issues SET identifier = ? WHERE id = ?").run(standIn, id);
    const made = plan.scaffold(id, plan.scaffoldPreview(id).fingerprint, "agent");
    const task = store.getIssue(made.tasks.find((t) => t.key === "R1")!.existing!);
    const body = store.getDocument(task.id, "context").body;
    expect(body).not.toContain("+7");
    expect(body).toContain("Scaffolded from breakdown row R1 of the idea, as numbered at scaffold;");
    expect(store.context(task.id).scaffoldedFrom?.ideaId).toBe(id);
  });

  it("reads the row's key as the breakdown holds it now, and says when the row was removed", () => {
    const { id, number, tasks } = scaffolded();
    const breakdown = plan.detail(id).plan.breakdown;
    plan.update(id, { plan: { breakdown: breakdown.map((row) => (row.key === "R1" ? { ...row, key: "R1a", dependsOn: [] } : { ...row, dependsOn: ["R1a"] })) } }, "vp", PERSON);
    expect(store.context(tasks.get("R1")!.id).scaffoldedFrom?.rowKey).toBe("R1a");
    plan.update(id, { plan: { breakdown: plan.detail(id).plan.breakdown.filter((row) => row.key !== "R1a").map((row) => ({ ...row, dependsOn: [] })) } }, "vp", PERSON);
    const gone = store.context(tasks.get("R1")!.id).scaffoldedFrom!;
    expect(gone).toMatchObject({ ideaNumber: number, rowKey: null });
    expect(scaffoldedFromWords(gone)).toBe(`from ${number} · a removed row`);
  });

  it("keeps it when the ticket moves to another parent", () => {
    const { number, tasks } = scaffolded();
    const elsewhere = store.createIssue({ title: "Elsewhere", kind: "epic" });
    store.updateIssue(tasks.get("R1")!.id, { parent: elsewhere.identifier }, "vp");
    expect(store.context(tasks.get("R1")!.id).scaffoldedFrom).toMatchObject({ ideaNumber: number, rowKey: "R1" });
  });

  it("reads a ticket an earlier build scaffolded (no origin) from its parent's rows", () => {
    const { number, tasks } = scaffolded();
    const legacy = tasks.get("R2")!;
    store.db.prepare("UPDATE issues SET origin_kind = 'manual', origin_id = NULL WHERE id = ?").run(legacy.id);
    expect(store.context(legacy.id).scaffoldedFrom).toMatchObject({ ideaNumber: number, rowKey: "R2" });
    // A plain task under the epic is not mistaken for one.
    const plain = store.createIssue({ title: "Plain", parent: store.getIssue(legacy.parentId!).identifier });
    expect(store.context(plain.id).scaffoldedFrom).toBeNull();
  });
});

describe("an idea sparked by ticket work", () => {
  it("names the ticket on the idea, and the ticket lists every idea it sparked, in both reads", () => {
    const ticket = store.createIssue({ title: "Report screen" });
    const one = plan.capture({ title: "Bulk export", sparkedBy: ticket.identifier }, "agent");
    const two = plan.capture({ title: "Second thought", sparkedBy: ticket.id }, "agent");
    expect(origin(one.id)).toEqual({ origin_kind: SPARKED_ORIGIN_KIND, origin_id: `${ticket.id}/${one.id}` });
    const by = { identifier: ticket.identifier, title: "Report screen", status: "backlog" };
    expect(plan.detail(one.id).sparkedBy).toEqual(by);
    expect(store.context(one.id).sparkedBy).toEqual(by);
    const sparked = store.context(ticket.identifier).sparked;
    expect(sparked.map((idea) => [idea.id, idea.ideaNumber, idea.identifier, idea.maturity])).toEqual([
      [one.id, one.number, null, "raw"],
      [two.id, two.number, null, "raw"],
    ]);
    expect(sparkedIdeaWords(sparked[0]!)).toBe(`${one.number}(raw)`);
    // An idea captured without one names none.
    expect(plan.detail(plan.capture({ title: "Unsparked" }, "agent").id).sparkedBy).toBeNull();
  });

  it("keeps it once the idea becomes an epic: the epic names its spark, the ticket reads the epic's numbers", () => {
    const ticket = store.createIssue({ title: "Report screen" });
    const idea = plan.capture({ title: "Grows up", sparkedBy: ticket.identifier, maturity: "shaped", plan: PLAN }, "vp", PERSON);
    plan.scaffold(idea.id, plan.scaffoldPreview(idea.id).fingerprint, "agent");
    const epic = store.getIssue(idea.id);
    expect(store.context(epic.identifier).sparkedBy?.identifier).toBe(ticket.identifier);
    const [entry] = store.context(ticket.id).sparked;
    expect(entry).toMatchObject({ identifier: epic.identifier, ideaNumber: idea.number });
    expect(sparkedIdeaWords(entry!)).toBe(`${epic.identifier} · ${idea.number}`);
  });

  it("is refused for an idea or a milestone, and an unknown ticket is not found, before anything is written", () => {
    const other = plan.capture({ title: "Another idea" }, "agent");
    const before = store.db.prepare("SELECT COUNT(*) AS n FROM issues").get();
    expect(refusal(() => plan.capture({ title: "X", sparkedBy: other.number! }, "agent"))).toContain("is an idea, not a ticket");
    const horizon = plan.view().horizons[0]!;
    expect(refusal(() => plan.capture({ title: "Y", sparkedBy: horizon.id }, "agent"))).toContain("is a milestone, not a ticket");
    refusal(() => plan.capture({ title: "Z", sparkedBy: "TST-999" }, "agent"), "not_found");
    expect(refusal(() => plan.capture({ title: "E", sparkedBy: "  " }, "agent"))).toContain("it was empty");
    expect(store.db.prepare("SELECT COUNT(*) AS n FROM issues").get()).toEqual(before);
  });
});

describe("planning off", () => {
  it("hides the provenance on every read and keeps it for when planning is back", () => {
    const { tasks } = scaffolded();
    const ticket = store.createIssue({ title: "Report screen" });
    plan.capture({ title: "Sparked", sparkedBy: ticket.identifier }, "agent");
    const task = tasks.get("R1")!;
    store.setSetting("features.planning", false, "vp", { via: "settings" });
    expect(store.context(task.id)).toMatchObject({ scaffoldedFrom: null, sparkedBy: null, sparked: [] });
    expect(store.context(ticket.id).sparked).toEqual([]);
    expect(origin(task.id).origin_kind).toBe(SCAFFOLD_ORIGIN_KIND);
    store.setSetting("features.planning", true, "vp", { via: "settings" });
    expect(store.context(task.id).scaffoldedFrom?.rowKey).toBe("R1");
    expect(store.context(ticket.id).sparked).toHaveLength(1);
  });
});
