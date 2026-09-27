import { describe, expect, it } from "vitest";
import { plainRowRefusal, rowStatusChoices, rowWriteTarget } from "./row-status";

const refusal = (message: string, code = "validation") => ({ message, code, blockers: [], retryable: false, fromServer: true });

describe("row status choices", () => {
  const vocabulary = [
    { id: "backlog", label: "Backlog", category: "unstarted" as const },
    { id: "in_progress", label: "In Progress", category: "active" as const },
    { id: "awaiting_approval", label: "Awaiting Approval", category: "gated" as const },
    { id: "done", label: "Done", category: "done" as const },
  ];

  it("keeps the configured order, checks the current status and does not offer it again", () => {
    const choices = rowStatusChoices(vocabulary, "in_progress");
    expect(choices.map((c) => c.id)).toEqual(["backlog", "in_progress", "done"]);
    expect(choices.map((c) => c.disabled)).toEqual([false, true, false]);
  });

  it("shows a gated status only when the task is already in it", () => {
    expect(rowStatusChoices(vocabulary, "awaiting_approval").map((c) => c.id)).toContain("awaiting_approval");
  });

  it("writes to the row's workspace", () => {
    expect(rowWriteTarget({ workspace: "exercises-api", issue: { id: "abc" } })).toEqual({ ws: "exercises-api", ref: "abc" });
  });
});

describe("plain refusal words", () => {
  const to = { label: "In Progress" };
  it("names blockers, gates and conflicts without the store's vocabulary", () => {
    expect(plainRowRefusal(refusal("Cannot start: unresolved blockers STA-61, STA-62"), to).sentence).toBe(
      "Can't move this to In Progress yet: it is waiting on STA-61, STA-62 to finish.",
    );
    expect(plainRowRefusal(refusal("STA-9 is parked behind a review gate awaiting VP; resolve it with ..."), to).sentence).toBe(
      "This is waiting for approval from VP, so its status can't change until then.",
    );
    expect(plainRowRefusal(refusal("stale", "revision_conflict"), to).sentence).toBe("Someone else changed this task a moment ago. Try again.");
  });

  it("passes an unknown refusal through after a plain lead-in", () => {
    expect(plainRowRefusal(refusal("Something new went wrong."), to)).toEqual({
      sentence: "Can't move this to In Progress: something new went wrong.",
      needsAssignee: false,
    });
  });
});
