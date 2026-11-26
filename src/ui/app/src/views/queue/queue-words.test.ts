import { describe, expect, it } from "vitest";
import type { IssueRow } from "@/lib/types";
import { effective, entry } from "./fixtures";
import {
  coveredBy,
  expansionLines,
  initials,
  moveAnnouncement,
  nothingPickable,
  reasonWithoutRef,
  rollUp,
  rowState,
  whyNext,
} from "./queue-words";

describe("the state column", () => {
  it("says Ready for a row an agent can take", () => {
    expect(rowState(effective({ identifier: "STA-1" }))).toEqual({ tone: "ready", words: "Ready" });
  });

  it("names the holder of a claim, with its initials, and says when it has gone quiet", () => {
    const fresh = rowState(effective({ identifier: "STA-2", eligibility: "claimed", detail: { heldBy: "dux-shell", idleSeconds: 120 } }));
    expect(fresh).toMatchObject({ tone: "active", words: "Working · dux-shell", holder: "dux-shell", initials: "DS" });
    expect(fresh.quiet).toBeUndefined();
    const quiet = rowState(effective({ identifier: "STA-2", eligibility: "claimed", detail: { heldBy: "fable", idleSeconds: 8 * 86400 + 5 } }));
    expect(quiet).toMatchObject({ words: "Working · fable · quiet 8d", quiet: "quiet 8d", initials: "F" });
  });

  it("prefers the live claim's holder and idle time over the detail", () => {
    const row = effective({
      identifier: "STA-3",
      eligibility: "claimed",
      detail: { heldBy: "old", idleSeconds: 0 },
      claim: { heldBy: "opus-a", checkoutAt: "", lastActivityAt: "", heldSeconds: 9000, idleSeconds: 7200, scope: "local", lease: null },
    });
    expect(rowState(row).words).toBe("Working · opus-a · quiet 2h");
  });

  it("names a row's blockers, or says a person is in the way when none is named", () => {
    const named = rowState(effective({ identifier: "STA-4", eligibility: "blocked", detail: { blockers: ["STA-467"], crossBlockers: [{ identifier: "FDS-9" }] } }));
    expect(named).toEqual({ tone: "waiting", words: "Waiting on STA-467, FDS-9", blockers: ["STA-467", "FDS-9"] });
    expect(rowState(effective({ identifier: "STA-5", eligibility: "blocked", detail: { blockers: [], crossBlockers: [] } }))).toEqual({
      tone: "person",
      words: "Blocked on a person",
    });
  });

  it("asks for approval on a gated row and says Done on a resolved one", () => {
    expect(rowState(effective({ identifier: "STA-6", eligibility: "gated" }))).toEqual({ tone: "person", words: "Needs your approval" });
    expect(rowState(effective({ identifier: "STA-7", eligibility: "resolved" }))).toEqual({ tone: "done", words: "Done" });
  });

  it("says In review for a row in review, and the store's own sentence for any other unavailable row", () => {
    expect(rowState(effective({ identifier: "STA-8", eligibility: "unavailable", status: "in_review" }))).toEqual({ tone: "person", words: "In review" });
    const other = effective({ identifier: "STA-9", eligibility: "unavailable", status: "in_progress", reason: "STA-9 is in_progress, which cannot be checked out." });
    expect(rowState(other)).toEqual({ tone: "waiting", words: "In progress, which cannot be checked out" });
  });

  it("calls another member's ticket theirs", () => {
    expect(rowState(effective({ identifier: "STA-10", eligibility: "assigned_to_other_member" })).words).toBe("Another member's");
  });

  it("drops the reference a store sentence opens with", () => {
    expect(reasonWithoutRef({ identifier: "EXE-1", status: "awaiting_approval", reason: "EXE-1 is awaiting_approval, which cannot be checked out." })).toBe(
      "Awaiting approval, which cannot be checked out",
    );
    expect(initials("design-lead-queue")).toBe("DL");
  });
});

describe("why the next pick is the one it is", () => {
  const next = effective({ identifier: "STA-566", position: 5 });

  it("is first in the order when nothing open is ahead of it", () => {
    expect(whyNext(next, [effective({ identifier: "STA-1", eligibility: "resolved" })], true).wide).toBe("First in the order");
  });

  it("gives its place and counts what is ahead, leaving finished rows out", () => {
    const ahead = [
      effective({ identifier: "STA-1", eligibility: "claimed" }),
      effective({ identifier: "STA-2", eligibility: "claimed" }),
      effective({ identifier: "STA-3", eligibility: "blocked" }),
      effective({ identifier: "STA-4", eligibility: "resolved" }),
    ];
    expect(whyNext(next, ahead, true)).toEqual({
      wide: "#5 in the order · ahead of it: 2 being worked on, 1 waiting",
      narrow: "#5 in the order · ahead: 2 being worked on, 1 waiting",
    });
  });

  it("says where a pick from after the plan comes from", () => {
    const after = effective({ identifier: "STA-90", unqueued: true });
    expect(whyNext(after, [], true).wide).toBe("The plan has nothing ready, so agents take this from the open work");
    expect(whyNext(after, [], false).wide).toBe("No plan, so agents take open work in list order");
  });

  it("counts what is waiting and being worked on when nothing can be picked", () => {
    const rows = [
      effective({ identifier: "A", eligibility: "blocked" }),
      effective({ identifier: "B", eligibility: "gated" }),
      effective({ identifier: "C", eligibility: "claimed" }),
      effective({ identifier: "D", eligibility: "resolved" }),
    ];
    expect(nothingPickable(rows)).toBe("2 waiting · 1 being worked on. Agents asking for work get none.");
  });
});

describe("a container's roll-up", () => {
  it("counts its tasks, then what is ready and being worked on", () => {
    const rows = [
      effective({ identifier: "A" }),
      effective({ identifier: "B" }),
      effective({ identifier: "C", eligibility: "claimed" }),
      effective({ identifier: "D", eligibility: "blocked" }),
    ];
    expect(rollUp(rows)).toBe("4 tasks · 2 ready · 1 being worked on");
    expect(rollUp(rows, true)).toBe("4 tasks · 2 ready · 1 working");
  });

  it("says what is waiting only when nothing is ready or being worked on", () => {
    const rows = [effective({ identifier: "A", eligibility: "blocked" }), effective({ identifier: "B", eligibility: "resolved" })];
    expect(rollUp(rows)).toBe("2 tasks · 1 waiting");
    expect(rollUp([effective({ identifier: "A" })])).toBe("1 task · 1 ready");
  });
});

describe("an entry the order already reached", () => {
  it("names where the order reached it and through which entry", () => {
    const view = {
      effective: [
        effective({ identifier: "EXE-96", position: 76, via: "EXE-234", epicPath: ["EXE-234"] }),
        effective({ identifier: "EXE-97", position: 77, via: null }),
      ],
    };
    expect(coveredBy(entry({ identifier: "EXE-96" }), view)).toEqual({ position: 76, via: "EXE-234", identifier: "EXE-96" });
    expect(coveredBy(entry({ identifier: "EXE-97" }), view)).toBeNull();
  });

  it("finds a container whose tasks came out of an earlier entry", () => {
    const view = { effective: [effective({ identifier: "STA-9", position: 3, via: "STA-1", epicPath: ["STA-1", "STA-5"] })] };
    expect(coveredBy(entry({ identifier: "STA-5", kind: "epic" }), view)).toEqual({ position: 3, via: "STA-1", identifier: "STA-9" });
  });
});

describe("what a container expands to", () => {
  const known = new Map<string, IssueRow>([
    ["STA-10", { workspace: "staple", issue: { identifier: "STA-10", title: "First epic", kind: "epic" }, claim: null } as unknown as IssueRow],
  ]);

  it("captions each epic between the entry and its tasks once, in effective order", () => {
    const rows = [
      effective({ identifier: "STA-11", via: "STA-1", epicPath: ["STA-1", "STA-10"] }),
      effective({ identifier: "STA-12", via: "STA-1", epicPath: ["STA-1", "STA-10"] }),
      effective({ identifier: "STA-21", via: "STA-1", epicPath: ["STA-1", "STA-20"] }),
      effective({ identifier: "STA-13", via: "STA-1", epicPath: ["STA-1", "STA-10"] }),
      effective({ identifier: "STA-2", via: "STA-1", epicPath: ["STA-1"] }),
    ];
    const lines = expansionLines(rows, "STA-1", known).map((line) => (line.kind === "caption" ? `[${line.identifier} ${line.title}]` : line.row.identifier));
    // A later row under an earlier epic repeats its caption rather than jumping the order.
    expect(lines).toEqual(["[STA-10 First epic]", "STA-11", "STA-12", "[STA-20 ]", "STA-21", "[STA-10 First epic]", "STA-13", "STA-2"]);
  });

  it("captions nothing above a queued task, whose chain sits above it", () => {
    const rows = [effective({ identifier: "STA-31", via: "STA-30", epicPath: ["STA-10"] })];
    expect(expansionLines(rows, "STA-30", known).map((line) => line.kind)).toEqual(["task"]);
  });

  it("captions an epic under a queued milestone", () => {
    const rows = [effective({ identifier: "STA-41", via: "STA-40", milestonePath: ["STA-40"], epicPath: ["STA-10"] })];
    expect(expansionLines(rows, "STA-40", known).map((line) => line.kind)).toEqual(["caption", "task"]);
  });
});

it("announces a move as a place in the plan", () => {
  expect(moveAnnouncement("STA-465", 0, 3)).toBe("STA-465 is now 1 of 3");
});
