/**
 * The toolbar's "Show only" focus and its filter text: which ideas every lens draws, and the
 * counts the pills print. Pure, read from the payload's own flags.
 */
import { describe, expect, it } from "vitest";
import type { IdeaData, PlanData, PlanStepData } from "@/lib/plan-types";
import { focusCounts, focusPlan } from "./plan-focus";

function idea(id: string, extra: Partial<IdeaData> = {}): IdeaData {
  return {
    id,
    identifier: null,
    number: null,
    promoted: false,
    kind: "idea",
    title: `Idea ${id}`,
    description: null,
    briefLine: null,
    maturity: "shaped",
    stage: "shaped",
    parentId: null,
    horizonId: "now",
    planned: { start: null, target: null },
    baseline: null,
    rank: 0,
    links: [],
    explorations: [],
    shapeProposal: null,
    missingLinks: [],
    linkCount: 0,
    resolvedLinks: 0,
    units: { done: 0, open: 0, planned: 0, total: 0 },
    unsized: false,
    own: { done: 0, open: 0, planned: 0, total: 0 },
    umbrella: false,
    carriedBy: "now",
    nextStep: null,
    progress: null,
    percent: null,
    actual: { start: null, end: null, forecastEnd: null },
    late: false,
    notStarted: false,
    delivered: null,
    childIds: [],
    openQuestions: 0,
    planIncomplete: [],
    completeness: { starred: 0, starredTotal: 3, filled: 0, total: 10 },
    dependsOn: [], blockedBy: [], heldBy: null,
    state: "shaped",
    actions: [],
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...extra,
  };
}

const step = (who: PlanStepData["who"]): PlanStepData => ({
  ideaId: "x",
  title: "x",
  parentId: null,
  parentTitle: null,
  horizonId: "now",
  state: "exploring",
  need: "answer_questions",
  who,
  instruction: "",
  questions: ["Which?"],
});

const root = idea("root", { title: "Checkout" });
const middle = idea("middle", { parentId: "root", title: "Gift cards" });
const late = idea("late", { parentId: "middle", title: "Late leaf", late: true, state: "started" });
const shippedLate = idea("shipped-late", { title: "Landed late", late: true, state: "shipped" });
const asks = idea("asks", { title: "Asks the person", nextStep: step("person"), state: "exploring" });
const agent = idea("agent", { title: "Agent work", nextStep: step("agent") });
const idle = idea("idle", { title: "Idle scheduled", notStarted: true });
const droppedIdle = idea("dropped-idle", { title: "Dropped idle", notStarted: true, state: "dropped", maturity: "dropped" });
const loner = idea("loner", { title: "Loner" });

const ALL = [root, middle, late, shippedLate, asks, agent, idle, droppedIdle, loner];
const plan = (ideas: IdeaData[] = ALL): PlanData => ({ enabled: true, today: "2026-11-25", horizons: [], ideas });
const ids = (data: PlanData) => data.ideas.map((entry) => entry.id);

describe("the focus counts", () => {
  it("counts live ideas the person must act on, late and unshipped, and not started, from the payload's flags", () => {
    expect(focusCounts(plan())).toEqual({ you: 1, late: 1, notStarted: 1 });
  });
});

describe("narrowing the plan", () => {
  it("hands every lens the whole plan with no focus and no text", () => {
    const whole = plan();
    expect(focusPlan(whole, "all", "")).toBe(whole);
    expect(focusPlan(whole, "all", "   ")).toBe(whole);
  });

  it("finds a record by its idea number or ticket number spelled whole, in any case", () => {
    const numbered: PlanData = {
      ...plan(),
      ideas: [idea("one", { number: "I-STA-1" }), idea("twelve", { number: "I-STA-12" }), idea("epic", { number: "I-STA-3", identifier: "STA-40", promoted: true })],
    };
    expect(ids(focusPlan(numbered, "all", "i-sta-1"))).toEqual(["one"]);
    expect(ids(focusPlan(numbered, "all", "I-STA-3"))).toEqual(["epic"]);
    expect(ids(focusPlan(numbered, "all", "sta-40"))).toEqual(["epic"]);
  });

  it("keeps the ideas that match and every ancestor of each, in plan order", () => {
    expect(ids(focusPlan(plan(), "late", ""))).toEqual(["root", "middle", "late"]);
  });

  it("keeps an idea an agent proposed shaped under Needs you, whether or not a horizon carries it", () => {
    const proposed = idea("proposed", { title: "Proposed", state: "exploring", shapeProposal: { by: "agent", at: "2026-11-27T10:00:00.000Z", note: null } });
    const withIt = { ...plan(), ideas: [...plan().ideas, proposed] };
    expect(ids(focusPlan(withIt, "you", ""))).toEqual(["asks", "proposed"]);
    expect(focusCounts(withIt).you).toBe(focusCounts(plan()).you + 1);
  });

  it("reads each focus from its own flag, never a shipped late idea or a dropped one", () => {
    expect(ids(focusPlan(plan(), "you", ""))).toEqual(["asks"]);
    expect(ids(focusPlan(plan(), "notStarted", ""))).toEqual(["idle"]);
  });

  it("matches the text in a title, case aside, and keeps the match's ancestors", () => {
    expect(ids(focusPlan(plan(), "all", "LEAF"))).toEqual(["root", "middle", "late"]);
    expect(ids(focusPlan(plan(), "all", "dropped"))).toEqual(["dropped-idle"]);
  });

  it("needs both the focus and the text when both are on", () => {
    expect(ids(focusPlan(plan(), "notStarted", "idle"))).toEqual(["idle"]);
    expect(ids(focusPlan(plan(), "late", "idle"))).toEqual([]);
  });

  it("keeps the horizons and the day as they are", () => {
    const whole = { ...plan(), horizons: [{ id: "now" }] as PlanData["horizons"] };
    const narrowed = focusPlan(whole, "late", "");
    expect(narrowed.horizons).toBe(whole.horizons);
    expect(narrowed.today).toBe("2026-11-25");
  });
});
