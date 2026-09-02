import { describe, expect, it } from "vitest";
import {
  blockingDescriptor,
  borrowedWaitingLine,
  needsBorrowedDescriptor,
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
