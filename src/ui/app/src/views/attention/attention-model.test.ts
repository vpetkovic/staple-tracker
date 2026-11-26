/**
 * The Attention model's behaviour that is not about rendering: which stop notice a row stands
 * for, so opening or dismissing a stopped run's row settles the notice of the same run.
 */
import { describe, expect, it } from "vitest";
import { pendingStopNotices, stopKey, withSeen } from "@/lib/run-stops";
import type { AttentionRow, RunEntry } from "@/lib/types";
import { rowStopKey } from "./attention-model";

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
