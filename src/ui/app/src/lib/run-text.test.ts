/**
 * The plain words for autopilot runs (lib/run-text.ts). Every stop and wait reason the tracker
 * can send has words, and every detail core puts on a stop (which budget, which tickets, whose
 * approval) reaches the sentence. The real payloads are pinned end to end in
 * components/autopilot/autopilot-e2e.test.tsx; this file pins every branch.
 */
import { describe, expect, it } from "vitest";
import {
  DRIVER_ACTOR,
  STOP_REASON_WORDS,
  WAIT_REASON_WORDS,
  bannerLine,
  driverText,
  durationText,
  endedStateText,
  failureReasonText,
  liveStateText,
  nextText,
  progress,
  stopReasonText,
  stopRuleText,
  stoppedByText,
  ticketOutcomeText,
  waitReasonText,
} from "./run-text";
import { RUN_STOP_REASONS, RUN_WAIT_REASONS, type Run, type RunEntry, type RunTicket } from "./types";

const NOW = new Date("2026-09-28T12:00:00.000Z");

const ticket = (over: Partial<RunTicket> = {}): RunTicket => ({
  seq: 1,
  issueId: "i-1",
  identifier: "ABC-1",
  takenAt: "2026-09-28T11:00:00.000Z",
  outcome: null,
  reason: null,
  attemptId: null,
  recordedAt: null,
  ...over,
});

const run = (over: Partial<Run> = {}): Run => ({
  id: "run-1",
  actor: "opus",
  scope: { kind: "issue", issueId: "e-1", identifier: "ABC-10" },
  state: "active",
  budget: { maxTickets: null, until: null, ceilingPercent: null, ceilingAccount: null },
  override: null,
  tickets: [],
  counts: { taken: 0, done: 0, failed: 0, open: 0 },
  stop: null,
  startedAt: "2026-09-28T11:00:00.000Z",
  updatedAt: "2026-09-28T11:00:00.000Z",
  endedAt: null,
  ...over,
});

const facts = (workable: string[] = [], waiting: string[] = []): NonNullable<RunEntry["facts"]> => ({
  now: NOW.toISOString(),
  workable: workable.map((id) => ({ issueId: id, identifier: id.toUpperCase(), held: false })),
  waiting: waiting.map((id) => ({ issueId: id, identifier: id.toUpperCase(), eligibility: "claimed", reason: null })),
  pendingGates: [],
  personBlocks: [],
  ceiling: null,
  scopeGone: null,
});

describe("the stop reasons", () => {
  it("has words for every reason the tracker sends, and none it does not", () => {
    expect(Object.keys(STOP_REASON_WORDS).sort()).toEqual([...RUN_STOP_REASONS].sort());
    expect(Object.keys(WAIT_REASON_WORDS).sort()).toEqual([...RUN_WAIT_REASONS].sort());
    for (const reason of RUN_STOP_REASONS) {
      const text = stopReasonText({ reason, detail: {} });
      expect(text, reason).not.toBe(reason);
      expect(text, reason).not.toContain("_");
    }
  });

  it("names the person who stopped it, and the driver's main-line stop as what it is", () => {
    expect(stopReasonText({ reason: "stopped_by_human", detail: {}, by: "vp", note: null })).toBe("Stopped by vp");
    expect(stopReasonText({ reason: "stopped_by_human", detail: {}, by: null, note: null })).toBe("Stopped by a person");
    expect(
      stopReasonText({ reason: "stopped_by_human", detail: {}, by: DRIVER_ACTOR, note: "touched_main_line: the session on ABC-3 moved master" }),
    ).toBe("Stopped by its driver: a session changed master or main");
    // The driver stopping for another reason is still the driver, by name.
    expect(stopReasonText({ reason: "stopped_by_human", detail: {}, by: DRIVER_ACTOR, note: "other" })).toBe(`Stopped by ${DRIVER_ACTOR}`);
  });

  it("says which budget ran out", () => {
    expect(stopReasonText({ reason: "budget", detail: { budget: "tickets", maxTickets: 1, taken: 1 } })).toBe("Reached its limit of 1 ticket");
    expect(stopReasonText({ reason: "budget", detail: { budget: "tickets", maxTickets: 5, taken: 5 } })).toBe("Reached its limit of 5 tickets");
    expect(stopReasonText({ reason: "budget", detail: { budget: "time" } })).toBe("Its time ran out");
    expect(stopReasonText({ reason: "budget", detail: { budget: "ceiling", ceilingPercent: 80 } })).toBe("Usage reached its 80% limit");
    expect(stopReasonText({ reason: "budget", detail: {} })).toBe("Reached its limit");
  });

  it("names the tickets, the owner and the approvals the detail carries", () => {
    expect(stopReasonText({ reason: "failure_streak", detail: { tickets: ["ABC-1", "ABC-2"], limit: 2 } })).toBe("ABC-1 and ABC-2 both failed in a row");
    expect(stopReasonText({ reason: "failure_streak", detail: { tickets: ["ABC-1", "ABC-1"], limit: 2 } })).toBe("ABC-1 failed twice in a row");
    expect(stopReasonText({ reason: "vp_blocked", detail: { blocks: [{ identifier: "ABC-4", owner: "vp" }] } })).toBe("ABC-4 is waiting on vp");
    expect(stopReasonText({ reason: "gate_pending", detail: { gates: [{ identifier: "ABC-10", owner: "vp" }] } })).toBe("ABC-10 is waiting for approval");
    expect(stopReasonText({ reason: "gate_pending", detail: { gates: [{ identifier: "A-1" }, { identifier: "A-2" }, { identifier: "A-3" }] } })).toBe(
      "A-1, A-2 and A-3 are waiting for approval",
    );
    expect(stopReasonText({ reason: "scope_gone", detail: { why: "deleted" } })).toBe("What it was working on no longer exists");
    expect(stopReasonText({ reason: "scope_empty", detail: {} })).toBe("Finished: nothing left to do");
  });
});

describe("the wait reasons", () => {
  it("words each, naming what it waits on", () => {
    expect(waitReasonText({ reason: "paused" })).toBe("Paused");
    expect(waitReasonText({ reason: "out_of_order", detail: {} })).toBe("Waiting: earlier work in the plan comes first");
    expect(waitReasonText({ reason: "waiting_on_others", detail: { rows: [{ identifier: "ABC-2" }, { identifier: "ABC-3" }] } })).toBe("Waiting on ABC-2 and ABC-3");
    expect(
      waitReasonText({ reason: "waiting_on_others", detail: { rows: ["A", "B", "C", "D", "E"].map((identifier) => ({ identifier })) } }),
    ).toBe("Waiting on A, B and C and 2 more");
    expect(waitReasonText({ reason: "waiting_on_others", detail: { rows: [] } })).toBe("Waiting on work others hold");
  });
});

describe("a ticket's outcome", () => {
  it("words the driver's failure codes and passes the tracker's own sentence through", () => {
    expect(ticketOutcomeText(ticket())).toBe("In progress");
    expect(ticketOutcomeText(ticket({ outcome: "done" }))).toBe("Done");
    expect(ticketOutcomeText(ticket({ outcome: "failed" }))).toBe("Failed");
    expect(failureReasonText("session exited 137")).toBe("the agent session ended with an error (exit 137)");
    expect(failureReasonText("timed out: 30m")).toBe("the agent session ran out of time");
    expect(failureReasonText("no_review: no review comment")).toBe("it finished without a review");
    expect(failureReasonText("touched_main_line: moved master")).toBe("the session changed master or main");
    expect(failureReasonText("stopped_by_human: vp")).toBe("the run was stopped while it was being worked");
    expect(failureReasonText("ABC-1 left opus's hands unfinished: todo.")).toBe("ABC-1 left opus's hands unfinished: todo.");
  });
});

describe("the banner", () => {
  it("counts done over done plus what is left, a done ticket still in review once", () => {
    const r = run({ tickets: [ticket({ issueId: "a", outcome: "done" }), ticket({ seq: 2, issueId: "b" })] });
    // `a` is done but in review (waiting); `b` is held (workable); `c` is left.
    expect(progress(r, facts(["b", "c"], ["a"]))).toEqual({ done: 1, total: 3 });
    expect(progress(r, null)).toBeNull();
  });

  it("points at the ticket being worked, else the next one", () => {
    expect(nextText(run({ tickets: [ticket({ identifier: "ABC-3" })] }), facts(["x"]))).toBe("working ABC-3");
    expect(nextText(run(), facts(["abc-7"]))).toBe("next ABC-7");
    expect(nextText(run(), facts())).toBeNull();
  });

  it("says what would stop it, nearest rule first, or that the tracker will stop it", () => {
    expect(stopRuleText(run(), { stop: false }, NOW)).toBe("stops when nothing is left");
    expect(
      stopRuleText(
        run({ budget: { maxTickets: 5, until: "2026-09-28T18:00:00.000Z", ceilingPercent: 80, ceilingAccount: null }, tickets: [ticket()] }),
        { stop: false },
        NOW,
      ),
    ).toMatch(/^stops after 5 tickets \(1 taken\), stops at \d\d:\d\d, stops at 80% usage$/);
    expect(stopRuleText(run(), { stop: true, reason: "gate_pending", state: "stopped", detail: { gates: [{ identifier: "ABC-10" }] }, message: "" }, NOW)).toBe(
      "will stop: abc-10 is waiting for approval",
    );
  });

  it("is one line: Autopilot · scope · n/m done · next · stop rule", () => {
    const entry = { run: run({ budget: { maxTickets: 3, until: null, ceilingPercent: null, ceilingAccount: null } }), decision: { stop: false as const }, facts: facts(["abc-2", "abc-3"]) };
    expect(bannerLine(entry, NOW)).toBe("Autopilot · ABC-10 · 0/2 done · next ABC-2 · stops after 3 tickets (0 taken)");
    expect(bannerLine({ ...entry, run: run({ scope: { kind: "queue" } }) }, NOW)).toBe("Autopilot · Queue · 0/2 done · next ABC-2 · stops when nothing is left");
  });
});

describe("state, driver and history words", () => {
  it("a live run is working, paused, waiting or about to stop", () => {
    expect(liveStateText({ run: run(), decision: { stop: false } })).toEqual({ text: "Working", tone: "ok" });
    expect(liveStateText({ run: run({ state: "paused" }), decision: { stop: false } })).toEqual({ text: "Paused", tone: "tight" });
    expect(liveStateText({ run: run(), decision: { stop: false, wait: { reason: "out_of_order", detail: {}, message: "" } } }).tone).toBe("tight");
    expect(liveStateText({ run: run(), decision: { stop: true, reason: "budget", state: "stopped", detail: {}, message: "" } })).toEqual({ text: "Stopping", tone: "risk" });
  });

  it("an ended run: finished is fine, two failures and a main-line stop are not", () => {
    const at = "2026-09-28T11:30:00.000Z";
    expect(endedStateText(run({ state: "completed", stop: { reason: "scope_empty", detail: {}, by: null, note: null, at } })).tone).toBe("ok");
    expect(endedStateText(run({ state: "stopped", stop: { reason: "failure_streak", detail: {}, by: null, note: null, at } })).tone).toBe("risk");
    expect(endedStateText(run({ state: "stopped", stop: { reason: "stopped_by_human", detail: {}, by: DRIVER_ACTOR, note: "touched_main_line: x", at } })).tone).toBe("risk");
    expect(endedStateText(run({ state: "stopped", stop: { reason: "stopped_by_human", detail: {}, by: "vp", note: null, at } }))).toEqual({ text: "Stopped by vp", tone: "unknown" });
    expect(stoppedByText(run({ state: "stopped", stop: { reason: "stopped_by_human", detail: {}, by: "vp", note: null, at } }))).toBe("Stopped by vp.");
    expect(stoppedByText(run({ state: "stopped", stop: { reason: "budget", detail: {}, by: null, note: null, at } }))).toBe("A stop rule ended it.");
    expect(stoppedByText(run({ state: "completed", stop: { reason: "scope_empty", detail: {}, by: null, note: null, at } }))).toBe("It finished on its own.");
  });

  it("the driver: attached, gone, elsewhere or absent", () => {
    const driver = { pid: 1, host: "mac", agent: "claude", startedAt: "", heartbeatAt: "", ticket: null, sessionPid: null, logDir: "" };
    expect(driverText(null)).toBe("No driver attached");
    expect(driverText({ ...driver, alive: true })).toBe("Driver attached (claude)");
    expect(driverText({ ...driver, alive: false })).toBe("Driver stopped responding");
    expect(driverText({ ...driver, alive: null })).toBe("Driver on mac");
  });

  it("durations, compact", () => {
    const from = "2026-09-28T10:00:00.000Z";
    expect(durationText(from, "2026-09-28T10:00:40.000Z")).toBe("40s");
    expect(durationText(from, "2026-09-28T10:12:00.000Z")).toBe("12m");
    expect(durationText(from, "2026-09-28T11:20:00.000Z")).toBe("1h 20m");
    expect(durationText(from, "2026-09-28T12:00:00.000Z")).toBe("2h");
    expect(durationText(from, "2026-09-30T13:00:00.000Z")).toBe("2d 3h");
    expect(durationText(from, null, NOW)).toBe("2h");
  });
});
