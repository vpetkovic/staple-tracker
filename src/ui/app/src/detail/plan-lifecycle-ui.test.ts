/**
 * The page's half of "one lifecycle table, every surface": for every state, the drawer's items,
 * the card menu's moves and the horizon's buttons are built from the offered actions alone, and
 * so agree cell for cell with the table the store enforces (`src/core/plan-lifecycle-table.ts`,
 * read here directly). The other surfaces are `test/plan-lifecycle-surfaces.test.ts`.
 */
import { describe, expect, it } from "vitest";
import {
  HORIZON_ACTIONS,
  HORIZON_LIFECYCLE,
  HORIZON_STATES,
  IDEA_ACTIONS,
  IDEA_LIFECYCLE,
  IDEA_STATES,
  maturityAction,
} from "../../../../core/plan-lifecycle-table";
import { horizonActionItems, moveOffered, planActionItems, type OfferedPlanAction } from "./plain-actions";

/** A record's actions exactly as the server sends them for a state. */
const offered = (state: (typeof IDEA_STATES)[number]): OfferedPlanAction[] =>
  IDEA_LIFECYCLE[state].map((id) => ({ id, label: IDEA_ACTIONS[id].label, who: IDEA_ACTIONS[id].who }));

const ONE_CLICK = new Set(["explore", "shape", "unshape", "drop", "restore", "promote", "reset_baseline", "open_epic"]);

describe("the page builds every plan control from the offered actions", () => {
  for (const state of IDEA_STATES) {
    it(`a ${state} idea: its buttons are exactly its one-click actions, and a move needs its action`, () => {
      const idea = { id: "i", state, maturity: state === "raw" || state === "exploring" || state === "dropped" ? state : "shaped", horizonId: null, actions: offered(state) };
      expect(planActionItems("ws", idea).map((item) => item.id)).toEqual(IDEA_LIFECYCLE[state].filter((id) => ONE_CLICK.has(id)));
      for (const maturity of ["raw", "exploring", "shaped", "dropped"]) {
        const action = maturityAction(state, maturity);
        const change = idea.maturity !== maturity;
        expect(moveOffered(idea, { maturity }), `${state} → ${maturity}`).toBe(change && action !== null && IDEA_LIFECYCLE[state].includes(action));
      }
      expect(moveOffered(idea, { horizon: "h" })).toBe(IDEA_LIFECYCLE[state].includes("schedule"));
    });
  }

  for (const state of HORIZON_STATES) {
    it(`a ${state} horizon: its buttons are exactly its one-click actions`, () => {
      const horizon = { id: "h", actions: HORIZON_LIFECYCLE[state].map((id) => ({ id, label: HORIZON_ACTIONS[id].label, who: HORIZON_ACTIONS[id].who })) };
      expect(horizonActionItems("ws", horizon).map((item) => item.id)).toEqual(HORIZON_LIFECYCLE[state].filter((id) => id === "queue" || id === "remove"));
    });
  }
});
