/**
 * The rule behind keeping the comment box in view while a phone keyboard is up. The
 * browser half is proven by /tmp/tdx/tabs/t3.mjs; this pins the decision.
 */
import { describe, expect, it } from "vitest";
import { isClear, shouldBringBack } from "./keep-in-view";

const view = { top: 0, bottom: 420 };
const bar = { top: 351, bottom: 420 };
const tabs = { top: 60, bottom: 104 };

describe("isClear", () => {
  it("is clear when the box sits between the tab strip and the action bar", () => {
    expect(isClear({ top: 281, bottom: 339 }, view, [bar, tabs])).toBe(true);
  });

  it("is hidden when the action bar overlaps it, even by a few pixels", () => {
    expect(isClear({ top: 313, bottom: 371 }, view, [bar, tabs])).toBe(false);
  });

  it("is hidden under the sticky tab strip, or outside the visible viewport", () => {
    expect(isClear({ top: 80, bottom: 138 }, view, [bar, tabs])).toBe(false);
    expect(isClear({ top: 500, bottom: 558 }, view, [])).toBe(false);
    expect(isClear({ top: -40, bottom: 18 }, view, [])).toBe(false);
  });

  it("ignores a cover that is not on screen (zero height)", () => {
    expect(isClear({ top: 281, bottom: 339 }, view, [{ top: 300, bottom: 300 }])).toBe(true);
  });
});

describe("shouldBringBack", () => {
  it("brings back a box the reader was looking at when the keyboard hides it", () => {
    expect(shouldBringBack(true, false)).toBe(true);
  });

  it("never moves a box that is still fully visible, so typing does not jiggle the list", () => {
    expect(shouldBringBack(true, true)).toBe(false);
    expect(shouldBringBack(false, true)).toBe(false);
  });

  it("does not snap back a reader who scrolled up to read, away from the box", () => {
    expect(shouldBringBack(false, false)).toBe(false);
  });
});
