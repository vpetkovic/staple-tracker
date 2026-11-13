/**
 * The tree a horizon's plan is drawn as (design/plan.md, "Presentation"), pinned with hand-written
 * expectations: which records a horizon carries, grouped parent → children, each with its own
 * state, units, questions and step; sub-ideas carried elsewhere dimmed with where they are;
 * records still being explored as reserved rows. Every number is the server's.
 */
import { describe, expect, it } from "vitest";
import type { HorizonData, IdeaData, PlanStepData } from "@/lib/plan-types";
import { percentText, planTree, stepLabel, treeHeader, type TreeRow } from "./plan-tree";

const ZERO = { done: 0, open: 0, planned: 0, total: 0 };

function idea(id: string, title: string, extra: Partial<IdeaData> = {}): IdeaData {
  return {
    id,
    identifier: null,
    promoted: false,
    kind: "idea",
    title,
    description: null,
    maturity: "shaped",
    stage: "scheduled",
    parentId: null,
    horizonId: null,
    planned: { start: null, target: null },
    baseline: null,
    rank: 0,
    links: [],
    missingLinks: [],
    linkCount: 0,
    resolvedLinks: 0,
    units: ZERO,
    unsized: false,
    own: ZERO,
    umbrella: false,
    carriedBy: null,
    progress: null,
    percent: null,
    actual: { start: null, end: null, forecastEnd: null },
    late: false,
    notStarted: false,
    delivered: null,
    childIds: [],
    openQuestions: 0,
    planIncomplete: [],
    completeness: { starred: 3, starredTotal: 3, filled: 5, total: 10 },
    dependsOn: [],
    state: "shaped",
    actions: [],
    nextStep: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

function step(ideaId: string, need: PlanStepData["need"], who: PlanStepData["who"], extra: Partial<PlanStepData> = {}): PlanStepData {
  return { ideaId, title: ideaId, parentId: null, parentTitle: null, horizonId: "now", state: "shaped", need, who, instruction: "", ...extra };
}

const HORIZONS = [
  { id: "now", name: "Now" },
  { id: "later", name: "Later" },
];

// Now carries Checkout API, an umbrella over three sub-ideas: one carried with it, one on Later,
// one scheduled nowhere (its parent is not scheduled through it in this fixture: the server says
// where each is). A record still being explored sits on Now, reserved; another waits on a date.
const checkout = idea("checkout", "Checkout API", { horizonId: "now", carriedBy: "now", umbrella: true, units: { done: 2, open: 1, planned: 3, total: 6 }, percent: 33, progress: 0.33, state: "started", stage: "started", childIds: ["cards", "refunds", "wallets", "gone"] });
const cards = idea("cards", "Card payments", { parentId: "checkout", carriedBy: "now", own: { done: 2, open: 1, planned: 0, total: 3 }, units: { done: 2, open: 1, planned: 0, total: 3 }, state: "started", stage: "started", percent: 66 });
const refunds = idea("refunds", "Refunds", { parentId: "checkout", horizonId: "later", carriedBy: "later", own: { done: 0, open: 0, planned: 3, total: 3 }, units: { done: 0, open: 0, planned: 3, total: 3 } });
const wallets = idea("wallets", "Wallets", { parentId: "checkout", carriedBy: null, maturity: "exploring", stage: "exploring", state: "exploring" });
const gone = idea("gone", "Gift cards", { parentId: "checkout", carriedBy: null, maturity: "dropped", stage: "dropped", state: "dropped" });
const billing = idea("billing", "Billing export", {
  horizonId: "now",
  carriedBy: "now",
  maturity: "exploring",
  stage: "exploring",
  state: "exploring",
  openQuestions: 2,
  nextStep: step("billing", "answer_questions", "person", { questions: ["Which format?", "Who reads it?"] }),
});
const audit = idea("audit", "Audit trail", { horizonId: "now", carriedBy: "now", own: { done: 0, open: 0, planned: 4, total: 4 }, units: { done: 0, open: 0, planned: 4, total: 4 }, nextStep: step("audit", "wait", "nobody", { waitingOn: { start: "2026-12-01" } }) });
const invoices = idea("invoices", "Invoice search", { horizonId: "now", carriedBy: "now", state: "shipped", stage: "shipped", delivered: { on: "2026-10-03", note: null }, actual: { start: null, end: "2026-10-03", forecastEnd: null }, own: { done: 1, open: 0, planned: 0, total: 1 }, units: { done: 1, open: 0, planned: 0, total: 1 }, percent: 100 });
// A sub-idea on Now whose parent sits on Later: its own row here, labelled with its parent.
const reports = idea("reports", "Reports", { horizonId: "later", carriedBy: "later", childIds: ["search"] });
const search = idea("search", "Report search", { parentId: "reports", horizonId: "now", carriedBy: "now", nextStep: step("search", "scaffold", "agent") });
// On Later only: never on Now's tree.
const ledger = idea("ledger", "Ledger", { horizonId: "later", carriedBy: "later" });

const IDEAS = [checkout, cards, refunds, wallets, gone, billing, audit, invoices, reports, search, ledger];

/** The tree as plain words: id, depth, what it is, where it is, its step. */
function shape(rows: TreeRow[], depth = 0): string[] {
  return rows.flatMap((row) => [
    `${"  ".repeat(depth)}${row.idea.id}${row.reserved ? " reserved" : ""}${row.where ? ` (${row.where})` : ""}${row.parentTitle ? ` ↳ ${row.parentTitle}` : ""}${row.step ? ` · ${row.step.label}` : ""}`,
    ...shape(row.children, depth + 1),
  ]);
}

describe("a horizon's tree", () => {
  const rows = planTree({ horizonId: "now", ideas: IDEAS, horizons: HORIZONS });

  it("groups each parent with its sub-ideas in plan order, carried elsewhere dimmed with where, dropped left out", () => {
    expect(shape(rows)).toEqual([
      "checkout",
      "  cards",
      "  refunds (on Later)",
      "  wallets reserved (unscheduled)",
      "billing reserved · needs you: 2 questions",
      "audit · starts Dec 1",
      "invoices",
      "search ↳ Reports · ready to scaffold",
    ]);
  });

  it("draws a group's rollup and a leaf's own units, both the server's", () => {
    expect(rows[0]!.units).toEqual({ done: 2, open: 1, planned: 3, total: 6 });
    expect(rows[0]!.children[0]!.units).toEqual({ done: 2, open: 1, planned: 0, total: 3 });
    // An umbrella with no sub-idea left on the tree would draw its own (none), never a sum of the page's.
    expect(planTree({ horizonId: "now", ideas: [{ ...checkout, childIds: [] }], horizons: HORIZONS })[0]!.units).toEqual(ZERO);
  });

  it("reserves a row for a record still being explored, and only for one", () => {
    expect(rows.filter((row) => row.reserved).map((row) => row.idea.id)).toEqual(["billing"]);
  });

  it("takes a sub-idea scheduled nowhere but carried through its parent as the horizon's own", () => {
    const carried = { ...wallets, carriedBy: "now", maturity: "shaped" as const, stage: "scheduled" as const, state: "shaped" as const };
    const tree = planTree({ horizonId: "now", ideas: [checkout, carried], horizons: HORIZONS });
    expect(shape(tree)).toEqual(["checkout", "  wallets"]);
  });

  it("is the same tree from the whole plan and from the records the horizon's detail carries", () => {
    const detail = [checkout, cards, refunds, wallets, billing, audit, invoices, reports, search];
    expect(planTree({ horizonId: "now", ideas: detail, horizons: HORIZONS })).toEqual(rows);
  });
});

describe("the Unscheduled column's tree", () => {
  it("holds delivery records carried by no horizon, never one still being explored", () => {
    const ready = idea("ready", "Exports", { childIds: ["sub"] });
    const sub = idea("sub", "CSV export", { parentId: "ready", horizonId: "now", carriedBy: "now" });
    const thinking = idea("thinking", "Webhooks", { maturity: "exploring", stage: "exploring", state: "exploring" });
    expect(shape(planTree({ horizonId: null, ideas: [ready, sub, thinking], horizons: HORIZONS }))).toEqual(["ready", "  sub (on Now)"]);
  });

  it("lists a shaped sub-idea of an unscheduled parent still being explored as a top row: the column never shows the parent", () => {
    const parent = idea("parent", "Webhooks", { maturity: "exploring", stage: "exploring", state: "exploring", childIds: ["child", "raw"] });
    const child = idea("child", "Webhook retries", { parentId: "parent" });
    const raw = idea("raw", "Webhook signing", { parentId: "parent", maturity: "raw", stage: "raw", state: "raw" });
    const rows = planTree({ horizonId: null, ideas: [parent, child, raw], horizons: HORIZONS });
    expect(shape(rows)).toEqual(["child ↳ Webhooks"]);
    expect(rows[0]!.parentTitle).toBe("Webhooks");
  });
});

describe("a step's short label", () => {
  it("says what the record needs, and whether it waits on the person", () => {
    expect(stepLabel(step("a", "wait", "nobody", { waitingOn: { start: "2026-12-01" } }))).toEqual({ label: "starts Dec 1", person: false });
    expect(stepLabel(step("a", "wait", "nobody", { waitingOn: { records: [{ id: "b", title: "Audit trail", state: "shaped" }] } }))).toEqual({ label: "waits on Audit trail", person: false });
    expect(stepLabel(step("a", "wait", "nobody", { waitingOn: { start: "2026-12-01", records: [{ id: "b", title: "Audit trail", state: "shaped" }, { id: "c", title: "Ledger", state: "started" }] } }))).toEqual({
      label: "starts Dec 1 · waits on Audit trail, Ledger",
      person: false,
    });
    expect(stepLabel(step("a", "scaffold", "agent"))).toEqual({ label: "ready to scaffold", person: false });
    expect(stepLabel(step("a", "answer_questions", "person", { questions: ["One?"] }))).toEqual({ label: "needs you: 1 question", person: true });
    expect(stepLabel(step("a", "write_plan", "agent"))).toEqual({ label: "plan needed", person: false });
    expect(stepLabel(step("a", "fix_plan", "agent"))).toEqual({ label: "plan needed", person: false });
    expect(stepLabel(step("a", "mark_shaped", "person"))).toEqual({ label: "ready to mark shaped", person: true });
    expect(stepLabel(step("a", "brainstorm", "agent"))).toEqual({ label: "to develop", person: false });
    expect(stepLabel(null)).toBeNull();
  });
});

describe("a horizon's header", () => {
  const horizon = { memberCount: 2, records: { leaves: 3, shipped: 1, started: 1, shaped: 0, exploring: 1, raw: 0, parentCount: 1 }, percent: 50, complete: false, needsYou: 2 } as HorizonData;

  it("prints leaf records apart from parents, the states and what needs the person, as the server counts them", () => {
    expect(treeHeader(horizon)).toEqual({ records: "3 ideas (+1 parent) · 2 members", states: "1 shipped · 1 started · 1 exploring", needsYou: "Needs you: 2" });
    expect(treeHeader({ ...horizon, needsYou: 0, records: { ...horizon.records, leaves: 0, shipped: 0, started: 0, exploring: 0, parentCount: 0 } })).toEqual({ records: "0 ideas · 2 members", states: null, needsYou: null });
  });

  it("says a whole 100 that is not complete is incomplete, as the CLI prints it", () => {
    expect(percentText(100, false)).toBe("100% incomplete");
    expect(percentText(100, true)).toBe("100%");
    expect(percentText(66, false)).toBe("66%");
    expect(percentText(null, false)).toBeNull();
  });
});
