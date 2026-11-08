/**
 * A plan that passes the shaped gate (design/plan.md, "Plan sections"): a goal, one task with
 * acceptance, and acceptance criteria. Tests that only need an idea to BE shaped capture it with
 * this; tests about the gate itself build their own.
 */
import type { PlanSections } from "../../src/core/plan-sections.js";

export const READY_PLAN: Partial<PlanSections> = {
  goal: "Ship the smallest useful slice.",
  breakdown: [{ key: "1", title: "Build it", estimate: "2h", dependsOn: [], acceptance: "It works end to end", owner: null, notes: null }],
  acceptance: ["It works end to end"],
};
