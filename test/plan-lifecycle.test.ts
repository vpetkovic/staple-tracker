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
  PROMOTED_ALWAYS,
  horizonState,
  ideaLifecycleRefusal,
  ideaOffered,
  ideaState,
  maturityAction,
  type IdeaState,
} from "../src/core/plan-lifecycle.js";

describe("the idea table", () => {
  it("offers exactly the agreed actions in each state", () => {
    expect(IDEA_LIFECYCLE).toEqual({
      raw: ["edit", "ask", "decide", "explore", "shape", "drop", "reparent", "reorder"],
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
    expect(people).toEqual(["back_to_raw", "drop", "explore", "plan_dates", "reorder", "reparent", "reset_baseline", "restore", "schedule", "shape", "unshape"]);
  });

  it("offers going back to raw in no state", () => {
    for (const row of Object.values(IDEA_LIFECYCLE)) expect(row).not.toContain("back_to_raw");
  });

  it("gives a promoted record the epic's own edits in every state, on top of its row", () => {
    expect(PROMOTED_ALWAYS).toEqual(["edit", "ask", "decide"]);
    expect(ideaOffered("shipped", true)).toEqual(["adopt", "open_epic", "edit", "ask", "decide"]);
    expect(ideaOffered("started", true)).toEqual(IDEA_LIFECYCLE.started);
    expect(ideaOffered("shipped", false)).toEqual(["adopt", "open_epic"]);
  });

  it("names each maturity change by where the idea stands, and a maturity it already has as no change", () => {
    const cases: Array<[IdeaState, string, string, string | null]> = [
      ["raw", "raw", "exploring", "explore"],
      ["raw", "raw", "shaped", "shape"],
      ["raw", "raw", "raw", null],
      ["exploring", "exploring", "shaped", "shape"],
      ["exploring", "exploring", "exploring", null],
      ["exploring", "exploring", "raw", "back_to_raw"],
      ["shaped", "shaped", "exploring", "unshape"],
      ["shaped", "shaped", "shaped", null],
      ["shaped", "shaped", "dropped", "drop"],
      ["shaped", "shaped", "raw", "back_to_raw"],
      ["started", "shaped", "shaped", null],
      ["started", "shaped", "exploring", "unshape"],
      ["started", "shaped", "dropped", "drop"],
      ["shipped", "shaped", "shaped", null],
      ["dropped", "dropped", "exploring", "restore"],
      ["dropped", "dropped", "raw", "restore"],
      ["dropped", "dropped", "dropped", null],
    ];
    for (const [state, maturity, to, action] of cases) expect(maturityAction({ state, maturity }, to), `${state} (${maturity}) → ${to}`).toBe(action);
  });

  it("reads a scheduled idea as its maturity", () => {
    expect(ideaState({ stage: "scheduled", maturity: "exploring" })).toBe("exploring");
    expect(ideaState({ stage: "scheduled", maturity: "shaped" })).toBe("shaped");
    expect(ideaState({ stage: "started", maturity: "shaped" })).toBe("started");
  });

  it("refuses naming the state and what it offers", () => {
    expect(ideaLifecycleRefusal('the idea "X"', "raw", "promote").message).toBe(
      'The idea "X" is raw; it cannot be promoted. A raw idea offers: edit title and brief, ask a question, record a decision, start exploring, mark shaped, drop, move under another idea or reorder.',
    );
  });
});

describe("the horizon table", () => {
  it("offers exactly the agreed actions in each state, all but queueing the person's", () => {
    expect(HORIZON_LIFECYCLE).toEqual({
      planned: ["rename", "date", "reorder", "remove"],
      active: ["rename", "date", "reorder", "queue"],
      shipped: ["remove"],
    });
    expect(Object.entries(HORIZON_ACTIONS).filter(([, rule]) => rule.who === "anyone").map(([id]) => id)).toEqual(["queue"]);
  });

  it("is shipped once its milestone is done, active while it holds open work, planned otherwise", () => {
    expect(horizonState({ shipped: true, openWork: 3 })).toBe("shipped");
    expect(horizonState({ shipped: false, openWork: 1 })).toBe("active");
    expect(horizonState({ shipped: false, openWork: 0 })).toBe("planned");
  });
});
