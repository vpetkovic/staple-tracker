import { describe, expect, it } from "vitest";
import {
  blockingDescriptor,
  borrowedWaitingLine,
  needsBorrowedDescriptor,
  waitingLine,
} from "./derived-blocked";
import type { BlockingChild } from "./types";

const child = (over: Partial<BlockingChild> = {}): BlockingChild => ({
  identifier: "STA-80",
  title: "Decide the schema",
  unblockOwner: "VP",
  unblockAction: "decide the schema",
  ...over,
});

describe("needsBorrowedDescriptor", () => {
  it("is true for a blocked row with no descriptor of its own", () => {
    expect(
      needsBorrowedDescriptor({ status: "blocked", unblockOwner: null, unblockAction: null }),
    ).toBe(true);
  });

  it("is false when the row states its OWN reason — a manual block wins", () => {
    expect(
      needsBorrowedDescriptor({ status: "blocked", unblockOwner: "vlad", unblockAction: null }),
    ).toBe(false);
    expect(
      needsBorrowedDescriptor({ status: "blocked", unblockOwner: null, unblockAction: "approve" }),
    ).toBe(false);
  });

  it("is false for anything that is not blocked", () => {
    for (const status of ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"] as const) {
      expect(needsBorrowedDescriptor({ status, unblockOwner: null, unblockAction: null })).toBe(false);
    }
  });
});

describe("blockingDescriptor", () => {
  it("reads waiting on OWNER: ACTION", () => {
    expect(blockingDescriptor(child())).toBe("waiting on VP: decide the schema");
  });

  it("names the owner alone when there is no action", () => {
    expect(blockingDescriptor(child({ unblockAction: null }))).toBe("waiting on VP");
  });

  it("does not invent an owner it was not given", () => {
    expect(blockingDescriptor(child({ unblockOwner: null }))).toBe("waiting on ?: decide the schema");
  });
});

describe("borrowedWaitingLine", () => {
  it("is null when there is nothing to borrow, so the caller can fall back", () => {
    expect(borrowedWaitingLine([])).toBeNull();
  });

  it("joins several blocking children onto one compact line", () => {
    expect(
      borrowedWaitingLine([
        child(),
        child({ identifier: "STA-81", unblockOwner: "ops", unblockAction: "grant access" }),
      ]),
    ).toBe("waiting on VP: decide the schema · waiting on ops: grant access");
  });
});

/**
 * V5 (STA-111) — the sentence the tree's "Waiting" section prints under a row.
 *
 * Three sources tried in order of how specific they are. The order is the whole point: a
 * descriptor somebody TYPED about this ticket must never be overwritten by one derived
 * from its children, and a row with no prose anywhere must still say something useful
 * rather than nothing.
 */
describe("waitingLine", () => {
  const blocked = { status: "blocked" as const, unblockOwner: null, unblockAction: null };

  it("prefers the row's OWN descriptor over anything borrowed", () => {
    expect(
      waitingLine(
        { ...blocked, unblockOwner: "VP", unblockAction: "decide the schema" },
        { derivedBlockers: [child({ unblockOwner: "someone else" })], unresolvedBlockers: ["STA-4"] },
      ),
    ).toBe("waiting on VP: decide the schema");
  });

  it("names an owner with no action, without trailing punctuation", () => {
    expect(waitingLine({ ...blocked, unblockOwner: "VP" })).toBe("waiting on VP");
  });

  it("borrows the child's words for a derived-blocked parent (STA-98)", () => {
    // The parent deliberately carries no descriptor of its own — a copy would go stale the
    // instant the child moved — so the only true answer is the child's.
    expect(waitingLine(blocked, { derivedBlockers: [child()] })).toBe(
      "waiting on VP: decide the schema",
    );
  });

  it("says NOTHING for a bare dependency edge — the badge carries that now (O6)", () => {
    /**
     * This assertion is the inverse of the one it replaces, and the inversion is the whole
     * of STA-138's caption half.
     *
     * `waitingLine` used to end with `blocked by ${blockers.join(", ")}`. On the real board
     * that produced, among others, `blocked by STA-67, STA-68, STA-69, STA-70, STA-71,
     * STA-72, STA-73, STA-74, STA-75, STA-76, STA-77` — a sentence sharing the title's
     * track, ellipsized to `blocked by STA-67, STA-6…` at any real width, at which point it
     * says strictly less than the number `11` does.
     *
     * The row now renders a warning-triangle badge with that count, whose tooltip names the
     * identifiers and whose click opens the Dependencies dialog with their titles and
     * statuses. Keeping the sentence as well would be the same fact twice, and the worse
     * copy would be the one taking the space.
     */
    expect(
      waitingLine(
        { status: "todo", unblockOwner: null, unblockAction: null },
        { unresolvedBlockers: ["STA-4", "STA-5"] },
      ),
    ).toBeNull();
  });

  it("still prefers PROSE, which no badge can carry", () => {
    // The two sources above the removed one are untouched, and this is why: a count cannot
    // say "waiting on VP: decide the schema". That is exactly the line O6 keeps.
    expect(
      waitingLine(blocked, { derivedBlockers: [child()], unresolvedBlockers: ["STA-4"] }),
    ).toBe("waiting on VP: decide the schema");
    expect(waitingLine({ ...blocked, unblockOwner: "VP" }, { unresolvedBlockers: ["STA-4"] })).toBe(
      "waiting on VP",
    );
  });

  it("is null when there is genuinely nothing to say", () => {
    // A caller renders no line at all rather than "waiting on:" followed by nothing, which
    // reads as a bug in the tracker rather than as an absence of information.
    expect(waitingLine(blocked)).toBeNull();
    expect(waitingLine({ status: "todo", unblockOwner: null, unblockAction: null })).toBeNull();
  });
});
