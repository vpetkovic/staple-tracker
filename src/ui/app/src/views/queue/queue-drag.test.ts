import { describe, expect, it } from "vitest";
import { dropMove, dropSlot, dropTarget } from "./queue-drag";

/** Three entry rows, 36px tall, from y = 100. */
const rows = [
  { top: 100, height: 36 },
  { top: 136, height: 36 },
  { top: 172, height: 36 },
];

describe("dragging a plan entry", () => {
  it("drops before the first row whose middle is below the pointer", () => {
    expect(dropSlot(90, rows)).toBe(0);
    expect(dropSlot(117, rows)).toBe(0);
    expect(dropSlot(119, rows)).toBe(1);
    expect(dropSlot(189, rows)).toBe(2);
    expect(dropSlot(191, rows)).toBe(3);
  });

  it("lands an entry taken from above one slot earlier, since it left a gap", () => {
    expect(dropTarget(0, 3)).toBe(2);
    expect(dropTarget(0, 1)).toBe(0);
    expect(dropTarget(2, 0)).toBe(0);
    expect(dropTarget(1, 1)).toBe(1);
  });

  it("moves the entry it picked up, found where it is now, even if the plan changed under the drag", () => {
    const at = (order: string[]) => (identifier: string) => order.indexOf(identifier);
    // Picked up second of A, B, C and dropped after the last.
    expect(dropMove("B", 3, at(["A", "B", "C"]))).toEqual({ from: 1, to: 2 });
    // Another writer put B first meanwhile: it is still B that moves, from where it is now.
    expect(dropMove("B", 3, at(["B", "A", "C"]))).toEqual({ from: 0, to: 2 });
    // Already where it was dropped: nothing to write.
    expect(dropMove("B", 3, at(["A", "C", "B"]))).toBeNull();
  });

  it("does nothing when the entry it picked up has left the plan", () => {
    expect(dropMove("B", 2, (identifier) => ["A", "C"].indexOf(identifier))).toBeNull();
  });
});
