/**
 * The lifecycle table itself, pinned (design/plan.md, "Lifecycle"). The cross-surface walk
 * (`plan-lifecycle-surfaces.test.ts`) proves every surface agrees with the table; this proves the
 * table says what was decided, so a changed cell is a failing test here before it is anywhere.
 */
import { describe, expect, it } from "vitest";
import {
  HORIZON_ACTIONS,
  HORIZON_LIFECYCLE,
  IDEA_ACTIONS,
  IDEA_LIFECYCLE,
  horizonState,
  ideaLifecycleRefusal,
  ideaState,
  maturityAction,
} from "../src/core/plan-lifecycle.js";

describe("the idea table", () => {
  it("offers exactly the agreed actions in each state", () => {
    expect(IDEA_LIFECYCLE).toEqual({
      raw: ["edit", "ask", "decide", "explore", "drop", "reparent", "reorder"],
      exploring: ["edit", "ask", "decide", "shape", "drop", "schedule", "plan_dates", "reparent", "reorder"],
      shaped: ["edit", "ask", "decide", "unshape", "drop", "schedule", "plan_dates", "reparent", "reorder", "promote", "adopt"],
      started: ["edit", "ask", "decide", "schedule", "plan_dates", "reorder", "adopt", "unlink", "reset_baseline", "open_epic"],
      shipped: ["adopt", "open_epic"],
      dropped: ["restore"],
    });
  });

  it("makes steering the person's and the rest anyone's", () => {
    const people = Object.entries(IDEA_ACTIONS)
      .filter(([, rule]) => rule.who === "person")
      .map(([id]) => id)
      .sort();
    expect(people).toEqual(["drop", "explore", "plan_dates", "reorder", "reparent", "reset_baseline", "restore", "schedule", "shape", "unshape"]);
  });

  it("names each maturity change by where the idea stands", () => {
    const cases: Array<[Parameters<typeof maturityAction>[0], string, string | null]> = [
      ["raw", "exploring", "explore"],
      ["raw", "shaped", "shape"],
      ["raw", "raw", null],
      ["exploring", "shaped", "shape"],
      ["exploring", "exploring", null],
      ["shaped", "exploring", "unshape"],
      ["shaped", "shaped", null],
      ["shaped", "dropped", "drop"],
      ["started", "exploring", "explore"],
      ["started", "dropped", "drop"],
      ["dropped", "exploring", "restore"],
      ["dropped", "raw", "restore"],
      ["dropped", "dropped", null],
    ];
    for (const [from, to, action] of cases) expect(maturityAction(from, to), `${from} → ${to}`).toBe(action);
  });

  it("reads a scheduled idea as its maturity", () => {
    expect(ideaState({ stage: "scheduled", maturity: "exploring" })).toBe("exploring");
    expect(ideaState({ stage: "scheduled", maturity: "shaped" })).toBe("shaped");
    expect(ideaState({ stage: "started", maturity: "shaped" })).toBe("started");
  });

  it("refuses naming the state and what it offers", () => {
    expect(ideaLifecycleRefusal('the idea "X"', "raw", "promote").message).toBe(
      'The idea "X" is raw; it cannot be promoted. A raw idea offers: edit title and brief, ask a question, record a decision, start exploring, drop, move under another idea or reorder.',
    );
  });
});

describe("the horizon table", () => {
  it("offers exactly the agreed actions in each state, all but queueing the person's", () => {
    expect(HORIZON_LIFECYCLE).toEqual({
      planned: ["rename", "date", "reorder", "remove"],
      active: ["rename", "date", "reorder", "queue"],
      shipped: [],
    });
    expect(Object.entries(HORIZON_ACTIONS).filter(([, rule]) => rule.who === "anyone").map(([id]) => id)).toEqual(["queue"]);
  });

  it("is shipped once its milestone is done, active while it holds work, planned before", () => {
    expect(horizonState({ shipped: true, memberCount: 3 })).toBe("shipped");
    expect(horizonState({ shipped: false, memberCount: 1 })).toBe("active");
    expect(horizonState({ shipped: false, memberCount: 0 })).toBe("planned");
  });
});
