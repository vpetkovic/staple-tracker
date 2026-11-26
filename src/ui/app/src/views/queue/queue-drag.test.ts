import { describe, expect, it } from "vitest";
import { dropSlot, dropTarget } from "./queue-drag";

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
});
