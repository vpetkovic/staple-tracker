/**
 * The Attention model's behaviour that is not about rendering: which stop notice a row stands
 * for, so opening or dismissing a stopped run's row settles the notice of the same run.
 */
import { describe, expect, it } from "vitest";
import { pendingStopNotices, stopKey, withSeen } from "@/lib/run-stops";
import type { AttentionRow, RunEntry } from "@/lib/types";
import { afterRowLeft, inboxOrder, rowStopKey } from "./attention-model";

const RUN_ID = "cfe86469-75c5-465b-ae80-c5d4f9510448";

const stoppedRow: Pick<AttentionRow, "kind" | "workspace" | "runId"> = { kind: "run_stopped", workspace: "app", runId: RUN_ID };

/** The ended run the row is about, as /api/runs serves it (only the fields the notices read). */
const stoppedEntry = {
  workspace: "app",
  run: {
    id: RUN_ID,
    state: "stopped",
    scope: { kind: "queue" },
    stop: { reason: "failure_streak", detail: { tickets: ["APP-3", "APP-3"], limit: 2 }, by: null, note: null, at: "2026-11-26T10:00:00.000Z" },
    endedAt: "2026-11-26T10:00:00.000Z",
  },
} as unknown as RunEntry;

describe("rowStopKey", () => {
  it("names the stop notice of the run a stopped-run row is about", () => {
    expect(rowStopKey(stoppedRow)).toBe(stopKey(stoppedEntry));
  });

  it("marking it seen takes that run's notice off the page", () => {
    const seen = { since: "2026-11-26T09:00:00.000Z", seen: [] };
    expect(pendingStopNotices([stoppedEntry], seen).map((notice) => notice.runId)).toEqual([RUN_ID]);
    expect(pendingStopNotices([stoppedEntry], withSeen(seen, [rowStopKey(stoppedRow)!]))).toEqual([]);
  });

  it("is null for every other row, and for a stopped run row that names no run", () => {
    expect(rowStopKey({ kind: "gate_pending", workspace: "app", runId: null })).toBeNull();
    expect(rowStopKey({ kind: "cloud_conflict", workspace: "app", runId: null })).toBeNull();
    expect(rowStopKey({ kind: "run_stopped", workspace: "app", runId: null })).toBeNull();
  });
});

describe("the Inbox's order for the drawer", () => {
  const at = (ref: string, workspace = "app") => ({ workspace, ref });

  it("lists each ticket once, in row order, leaving out rows that name none", () => {
    expect(
      inboxOrder([
        { workspace: "app", ref: "APP-1" },
        { workspace: "app", ref: null },
        { workspace: "web", ref: "APP-1" },
        { workspace: "app", ref: "APP-2" },
        { workspace: "app", ref: "APP-1" },
      ]),
    ).toEqual([at("APP-1"), at("APP-1", "web"), at("APP-2")]);
  });

  const row = (ref: string, kind = "gate_pending", workspace = "app") => ({ key: `${workspace}/${kind}/${ref}`, workspace, ref });

  it("moves the open ticket to the next row still listed when its row leaves, else the one before", () => {
    const before = [row("APP-1"), row("APP-2"), row("APP-3"), row("APP-4")];
    // APP-2 approved: the next one.
    expect(afterRowLeft(before, [row("APP-1"), row("APP-3"), row("APP-4")], at("APP-2"))).toEqual(at("APP-3"));
    // APP-2 and APP-3 both left in one read: the next one still listed.
    expect(afterRowLeft(before, [row("APP-1"), row("APP-4")], at("APP-2"))).toEqual(at("APP-4"));
    // The last one left: the one before it.
    expect(afterRowLeft(before, [row("APP-1"), row("APP-2"), row("APP-3")], at("APP-4"))).toEqual(at("APP-3"));
  });

  it("moves on when the row leaves though the ticket is listed again for another reason (an approved gate now in review)", () => {
    const before = [row("APP-1"), row("APP-2"), row("APP-3", "in_review")];
    const after = [row("APP-2"), row("APP-3", "in_review"), row("APP-1", "in_review")];
    expect(afterRowLeft(before, after, at("APP-1"))).toEqual(at("APP-2"));
  });

  it("does nothing when the row is still listed, was never listed, nothing is open, or nothing else is left", () => {
    const before = [row("APP-1"), row("APP-2")];
    expect(afterRowLeft(before, before, at("APP-1"))).toBeNull();
    expect(afterRowLeft(before, [row("APP-2")], at("APP-9"))).toBeNull();
    expect(afterRowLeft(before, [row("APP-2")], null)).toBeNull();
    expect(afterRowLeft(before, [], at("APP-1"))).toBeNull();
    // Only the ticket's own new row is left: nowhere else to go.
    expect(afterRowLeft(before, [row("APP-1", "in_review")], at("APP-1"))).toBeNull();
    // Same ref, another workspace: not the open ticket.
    expect(afterRowLeft(before, [row("APP-2")], at("APP-1", "web"))).toBeNull();
  });
});
