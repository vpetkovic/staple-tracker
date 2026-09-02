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

  it("falls back to the bare blocker identifiers, the only thing a dependency edge has", () => {
    // The most common blocked row there is: `todo`, no prose anywhere, one unresolved
    // dependency. "blocked by STA-4" is still a fact the reader can act on.
    expect(
      waitingLine(
        { status: "todo", unblockOwner: null, unblockAction: null },
        { unresolvedBlockers: ["STA-4", "STA-5"] },
      ),
    ).toBe("blocked by STA-4, STA-5");
  });

  it("prefers a borrowed descriptor over bare identifiers, because prose beats a list", () => {
    expect(
      waitingLine(blocked, { derivedBlockers: [child()], unresolvedBlockers: ["STA-4"] }),
    ).toBe("waiting on VP: decide the schema");
  });

  it("is null when there is genuinely nothing to say", () => {
    // A caller renders no line at all rather than "waiting on:" followed by nothing, which
    // reads as a bug in the tracker rather than as an absence of information.
    expect(waitingLine(blocked)).toBeNull();
    expect(waitingLine({ status: "todo", unblockOwner: null, unblockAction: null })).toBeNull();
  });
});
