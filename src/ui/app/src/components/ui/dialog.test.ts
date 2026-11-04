/**
 * The dialog's close button is a real target everywhere: 32px on a desk, 44px on a phone and
 * under a finger, with the one focus ring. (Radix portals do not render in a string render,
 * so the recipe itself is what is pinned.)
 */
import { describe, expect, it } from "vitest";
import { DIALOG_CLOSE_CLASS } from "./dialog";

describe("the dialog close button", () => {
  it("is 32px on a desk, 44px on a phone and under a finger, with the focus ring", () => {
    const classes = DIALOG_CLOSE_CLASS.split(/\s+/);
    expect(classes).toContain("size-8");
    expect(classes).toContain("max-md:size-11");
    expect(classes).toContain("pointer-coarse:size-11");
    expect(classes).toContain("focus-ring");
  });
});
