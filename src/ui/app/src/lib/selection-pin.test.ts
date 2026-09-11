/**
 * An open issue stays the issue it was opened as, whatever its identifier does.
 *
 * The detail pane was opened by identifier and re-fetched by it on every tick; sync can
 * move an open issue off its number (another device numbered alike and got there first),
 * and the number then names that other issue — so the pane, its action buttons and the
 * palette's commands for it all quietly became the other issue's. The selection is now
 * pinned to the issue id its identifier first loaded as, and everything that reads or
 * writes the open issue goes by that (`selectionTarget`); actions post the issue id.
 */
import { describe, expect, it } from "vitest";
import { writeTarget } from "../components/command-palette/commands";
import { pinSelection, selectionTarget, type Selection } from "./session";

describe("the open selection", () => {
  it("is pinned to the issue its ref first loaded as, and read and acted on by it from then on", () => {
    const opened: Selection = { workspace: "staple", ref: "STA-2" };
    expect(selectionTarget(opened)).toBe("STA-2");
    const pinned = pinSelection(opened, { workspace: "staple", ref: "STA-2", id: "uuid-of-bs-issue" })!;
    expect(selectionTarget(pinned)).toBe("uuid-of-bs-issue");
    // A later load of whatever STA-2 names now does not re-pin it.
    expect(pinSelection(pinned, { workspace: "staple", ref: "STA-2", id: "uuid-of-as-issue" })).toBe(pinned);
    // Nor does a load for a selection the reader has already left.
    expect(pinSelection({ workspace: "staple", ref: "STA-9" }, { workspace: "staple", ref: "STA-2", id: "x" })).toEqual({
      workspace: "staple",
      ref: "STA-9",
    });
  });

  it("aims a palette write at the pinned issue, not at whatever its number names now", () => {
    expect(writeTarget({ workspace: "staple", ref: "STA-2", id: "uuid-of-bs-issue" })).toEqual({ ws: "staple", ref: "uuid-of-bs-issue" });
    expect(writeTarget({ workspace: "staple", ref: "STA-2", id: "uuid-of-bs-issue", actor: "agent-b" })).toEqual({
      ws: "staple",
      ref: "uuid-of-bs-issue",
      actor: "agent-b",
    });
    // Before the pane has loaded it, the ref is all there is.
    expect(writeTarget({ workspace: "staple", ref: "STA-2" })).toEqual({ ws: "staple", ref: "STA-2" });
  });
});
