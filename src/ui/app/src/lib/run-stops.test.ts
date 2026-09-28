/**
 * The run-stopped notice (lib/run-stops.ts): which reference each stop hands to a person,
 * that a notice is one per stop however often the same runs are read, that "seen" survives
 * a reload, and that a first visit is not flooded with history. The real payloads are pinned
 * end to end in detail/milestone-goal-e2e.test.tsx.
 */
import { describe, expect, it } from "vitest";
import {
  STOP_SEEN_KEY,
  attentionLabel,
  loadStopSeen,
  pendingStopNotices,
  saveStopSeen,
  stopAttention,
  stopNotice,
  prunedSeen,
  withBaseline,
  withSeen,
} from "./run-stops";
import { RUN_STOP_REASONS, type Run, type RunStop, type RunStopReason } from "./types";

const at = "2026-09-28T11:30:00.000Z";

const run = (over: Partial<Run> = {}): Run => ({
  id: "run-1",
  actor: "opus",
  scope: { kind: "milestone", issueId: "m-1", identifier: "ABC-332" },
  state: "stopped",
  budget: { maxTickets: null, until: null, ceilingPercent: null, ceilingAccount: null },
  goal: null,
  override: null,
  tickets: [],
  counts: { taken: 0, done: 0, failed: 0, open: 0 },
  stop: null,
  startedAt: "2026-09-28T11:00:00.000Z",
  updatedAt: at,
  endedAt: at,
  ...over,
});

const stopped = (reason: RunStopReason, detail: Record<string, unknown> = {}, over: Partial<RunStop> = {}, runOver: Partial<Run> = {}): Run =>
  run({ state: reason === "goal_met" || reason === "scope_empty" ? "completed" : "stopped", stop: { reason, detail, by: null, note: null, at, ...over }, ...runOver });

describe("the reference a stop hands to a person", () => {
  it("names one for every reason, and the one that needs them", () => {
    expect(stopAttention(stopped("goal_met", { milestone: "ABC-332" }))).toEqual({ ref: "ABC-332", action: "review" });
    expect(stopAttention(stopped("budget", { budget: "goal_children", milestone: "ABC-332", childCap: 5 }))).toEqual({ ref: "ABC-332", action: "review" });
    expect(stopAttention(stopped("gate_pending", { gates: [{ identifier: "ABC-340", owner: "VP" }] }))).toEqual({ ref: "ABC-340", action: "review" });
    expect(stopAttention(stopped("vp_blocked", { blocks: [{ identifier: "ABC-341", owner: "VP" }] }))).toEqual({ ref: "ABC-341", action: "unblock" });
    // Two failures: the LAST one that failed.
    expect(stopAttention(stopped("failure_streak", { tickets: ["ABC-342", "ABC-343"], limit: 2 }))).toEqual({ ref: "ABC-343", action: "open" });
    expect(stopAttention(stopped("touched_main_line", { ticket: "ABC-344", moves: ["master"] }))).toEqual({ ref: "ABC-344", action: "open" });
    expect(stopAttention(stopped("scope_gone", { why: "it holds nothing" }))).toEqual({ ref: "ABC-332", action: "open" });
    expect(stopAttention(stopped("budget", { budget: "tickets", maxTickets: 3 }))).toEqual({ ref: "ABC-332", action: "open" });
    expect(stopAttention(stopped("stopped_by_human", {}, { by: "vp" }))).toEqual({ ref: "ABC-332", action: "open" });
    expect(stopAttention(stopped("scope_empty"))).toEqual({ ref: "ABC-332", action: "open" });
    for (const reason of RUN_STOP_REASONS) expect(stopAttention(stopped(reason)), reason).not.toBeNull();
  });

  it("names nothing it cannot open: the queue, a deleted scope, a live run", () => {
    expect(stopAttention(stopped("scope_empty", {}, {}, { scope: { kind: "queue" } }))).toBeNull();
    expect(stopAttention(stopped("scope_gone", { why: "deleted" }, {}, { scope: { kind: "issue", issueId: "x", identifier: null } }))).toBeNull();
    expect(stopAttention(run({ state: "active" }))).toBeNull();
    // A detail without the ref falls back to the scope.
    expect(stopAttention(stopped("failure_streak", {}))).toEqual({ ref: "ABC-332", action: "open" });
  });

  it("words the link", () => {
    expect(attentionLabel({ ref: "ABC-332", action: "review" })).toBe("Review ABC-332");
    expect(attentionLabel({ ref: "ABC-341", action: "unblock" })).toBe("Unblock ABC-341");
    expect(attentionLabel({ ref: "ABC-343", action: "open" })).toBe("Open ABC-343");
  });
});

describe("a notice", () => {
  it("is the run's end in the history's words, finished or stopped", () => {
    expect(stopNotice({ workspace: "staple", run: stopped("goal_met", { milestone: "ABC-332" }) })).toMatchObject({
      key: "staple/run-1",
      title: "Autopilot finished · ABC-332",
      reason: "Goal met: ABC-332 is waiting for approval",
      tone: "ok",
      attention: { ref: "ABC-332", action: "review" },
    });
    expect(stopNotice({ workspace: "staple", run: stopped("failure_streak", { tickets: ["ABC-9", "ABC-9"] }, {}, { scope: { kind: "queue" } }) })).toMatchObject({
      title: "Autopilot stopped · the queue",
      reason: "ABC-9 failed twice in a row",
      tone: "risk",
    });
    expect(stopNotice({ workspace: "staple", run: run({ state: "active" }) })).toBeNull();
  });

  const entries = [
    { workspace: "staple", run: stopped("goal_met", { milestone: "ABC-332" }, {}, { id: "a", endedAt: "2026-09-28T11:40:00.000Z" }) },
    { workspace: "staple", run: stopped("failure_streak", { tickets: ["ABC-1"] }, {}, { id: "b", endedAt: "2026-09-28T11:50:00.000Z" }) },
    { workspace: "staple", run: run({ id: "live", state: "active" }) },
    { workspace: "staple", run: stopped("scope_empty", {}, {}, { id: "old", endedAt: "2026-09-27T09:00:00.000Z" }) },
  ];
  const since = "2026-09-28T00:00:00.000Z";

  it("fires once per stop: newest first, none for live runs or stops before this browser kept count", () => {
    const first = pendingStopNotices(entries, { since, seen: [] });
    expect(first.map((notice) => notice.runId)).toEqual(["b", "a"]);
    // The next poll reads the same runs: the same notices, no second copy.
    expect(pendingStopNotices([...entries], { since, seen: [] })).toEqual(first);
    // Seen is gone for good; the other stays.
    expect(pendingStopNotices(entries, { since, seen: ["staple/b"] }).map((notice) => notice.runId)).toEqual(["a"]);
    // Keyed by workspace too: the same run id in another workspace is another stop.
    expect(pendingStopNotices([{ ...entries[0]!, workspace: "other" }], { since, seen: ["staple/a"] })).toHaveLength(1);
  });
});

describe("what this browser has seen", () => {
  const memory = () => {
    const map = new Map<string, string>();
    return { getItem: (key: string) => map.get(key) ?? null, setItem: (key: string, value: string) => void map.set(key, value), map };
  };
  const SERVER = "2026-09-28T12:00:00.000Z";

  it("starts counting at the first read of the SERVER's clock, and keeps that moment across reloads", () => {
    const storage = memory();
    const first = loadStopSeen(storage);
    // Before the server has answered, the count has not started: nothing is news yet.
    expect(first).toEqual({ since: null, seen: [] });
    expect(pendingStopNotices([{ workspace: "staple", run: stopped("goal_met") }], first)).toEqual([]);
    const started = withBaseline(first, SERVER);
    expect(started.since).toBe(SERVER);
    // A later read of the clock does not move it.
    expect(withBaseline(started, "2026-09-28T13:00:00.000Z")).toBe(started);
    expect(withBaseline(first, null)).toBe(first);
    saveStopSeen(storage, withSeen(started, ["staple/a"]));
    expect(JSON.parse(storage.map.get(STOP_SEEN_KEY)!)).toEqual({ since: SERVER, seen: ["staple/a"] });
    expect(loadStopSeen(storage)).toEqual({ since: SERVER, seen: ["staple/a"] });
  });

  it("reads a corrupt value or no storage as a first visit", () => {
    const storage = memory();
    storage.setItem(STOP_SEEN_KEY, "{not json");
    expect(loadStopSeen(storage)).toEqual({ since: null, seen: [] });
    storage.setItem(STOP_SEEN_KEY, JSON.stringify({ since: "never", seen: [] }));
    expect(loadStopSeen(storage).since).toBeNull();
    expect(loadStopSeen(null)).toEqual({ since: null, seen: [] });
  });

  it("adds once, and prunes only the keys of runs the server no longer serves in the workspaces it read", () => {
    expect(withSeen(withSeen({ since: "x", seen: [] }, ["a", "b"]), ["a"]).seen).toEqual(["b", "a"]);
    const state = { since: SERVER, seen: ["staple/gone", "staple/run-1", "other/r"] };
    const served = [{ workspace: "staple", run: stopped("scope_empty") }];
    // staple/gone dropped off the served list; other/ is a workspace this read did not cover.
    expect(prunedSeen(state, served).seen).toEqual(["staple/run-1", "other/r"]);
    // Nothing read yet (the first load): nothing is judged.
    expect(prunedSeen(state, [])).toBe(state);
    expect(prunedSeen({ since: SERVER, seen: ["staple/run-1"] }, served).seen).toEqual(["staple/run-1"]);
  });
});
