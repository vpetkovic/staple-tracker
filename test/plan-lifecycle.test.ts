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
  DELIVERED_MARKED,
  PROMOTED_ALWAYS,
  UNSHAPED_STARTED,
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
      exploring: ["edit", "ask", "decide", "shape", "drop", "schedule", "plan_dates", "reparent", "reorder", "adopt", "mark_delivered"],
      shaped: ["edit", "ask", "decide", "unshape", "drop", "schedule", "plan_dates", "reparent", "reorder", "promote", "scaffold", "adopt", "mark_delivered"],
      started: ["edit", "ask", "decide", "schedule", "plan_dates", "reorder", "scaffold", "adopt", "unlink", "reset_baseline", "open_epic"],
      shipped: ["adopt", "open_epic"],
      dropped: ["restore"],
    });
  });

  it("makes steering the person's and the rest anyone's", () => {
    const people = Object.entries(IDEA_ACTIONS)
      .filter(([, rule]) => rule.who === "person")
      .map(([id]) => id)
      .sort();
    expect(people).toEqual(["back_to_raw", "clear_delivered", "drop", "explore", "mark_delivered", "plan_dates", "reorder", "reparent", "reset_baseline", "restore", "schedule", "shape", "unshape"]);
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

  it("lets work be linked from exploring on, never while raw", () => {
    expect(IDEA_LIFECYCLE.raw).not.toContain("adopt");
    for (const state of ["exploring", "shaped", "started", "shipped"] as const) expect(IDEA_LIFECYCLE[state], state).toContain("adopt");
  });

  it("gives a record that started while still exploring Mark shaped on top of the started row, and nothing else", () => {
    expect(UNSHAPED_STARTED).toEqual(["shape"]);
    expect(ideaOffered("started", false, "exploring")).toEqual([...IDEA_LIFECYCLE.started, "shape"]);
    expect(ideaOffered("started", false, "shaped")).toEqual(IDEA_LIFECYCLE.started);
    expect(ideaOffered("shipped", false, "exploring")).toEqual(IDEA_LIFECYCLE.shipped);
    expect(ideaOffered("exploring", false, "exploring")).toEqual(IDEA_LIFECYCLE.exploring);
    expect(ideaLifecycleRefusal('the idea "X"', "started", "drop", false, "exploring").message).toContain("reset baseline to the plan or mark shaped.");
  });

  it("lets the person mark an exploring or shaped idea delivered outside the tracker, and gives a marked record its edits and the clear", () => {
    for (const state of ["exploring", "shaped"] as const) expect(IDEA_LIFECYCLE[state], state).toContain("mark_delivered");
    for (const state of ["raw", "started", "shipped", "dropped"] as const) expect(IDEA_LIFECYCLE[state], state).not.toContain("mark_delivered");
    for (const row of Object.values(IDEA_LIFECYCLE)) expect(row).not.toContain("clear_delivered");
    expect(DELIVERED_MARKED).toEqual(["edit", "ask", "decide", "clear_delivered"]);
    expect(ideaOffered("shipped", false, "shaped", true)).toEqual(["adopt", "open_epic", "edit", "ask", "decide", "clear_delivered"]);
    expect(ideaOffered("started", false, "exploring", true)).toEqual([...IDEA_LIFECYCLE.started, "shape", "clear_delivered"]);
    expect(ideaOffered("shipped", false, "shaped", false)).toEqual(IDEA_LIFECYCLE.shipped);
    expect(ideaLifecycleRefusal('the idea "X"', "shipped", "schedule", false, "shaped", true).message).toBe(
      'The idea "X" is shipped; it cannot be scheduled. A shipped idea offers: adopt existing work, edit title and brief, ask a question, record a decision or clear the delivered mark.',
    );
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
      ["started", "exploring", "shaped", "shape"],
      ["started", "exploring", "exploring", null],
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
      planned: ["rename", "date", "reorder", "run", "remove"],
      active: ["rename", "date", "reorder", "queue", "run"],
      shipped: ["remove"],
    });
    // Queueing is the queue's own, as a task's is; how agents run a horizon is a setting, the person's.
    expect(Object.entries(HORIZON_ACTIONS).filter(([, rule]) => rule.who === "anyone").map(([id]) => id)).toEqual(["queue"]);
  });

  it("is shipped once its milestone is done, active while it holds open work, planned otherwise", () => {
    expect(horizonState({ shipped: true, openWork: 3 })).toBe("shipped");
    expect(horizonState({ shipped: false, openWork: 1 })).toBe("active");
    expect(horizonState({ shipped: false, openWork: 0 })).toBe("planned");
  });
});
