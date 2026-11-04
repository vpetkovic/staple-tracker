/**
 * A milestone's goal in plain words (lib/goal-text.ts): every verdict, every reason a
 * criterion is unknown, who marked it, every pace verdict with its numbers, and the gate
 * a goal run asked for as against one a person did. The real payloads are pinned end to end
 * in detail/milestone-goal-e2e.test.tsx; this file pins every branch.
 */
import { describe, expect, it } from "vitest";
import { criterion, pace } from "@/views/milestones/fixtures";
import { shownPace,
  CRITERION_TONE,
  CRITERION_WORDS,
  PACE_TONE,
  PACE_WORDS,
  evidenceProblemText,
  gateText,
  goalRunRequester,
  goalSummary,
  markedByText,
  paceText,
  unknownCause,
  unknownText,
  unplannedText,
} from "./goal-text";
import { CRITERION_VERDICTS, PACE_VERDICTS, type EvidenceItem } from "./types";

const NOW = new Date("2026-09-28T12:00:00.000Z");

const ticket = (over: Partial<EvidenceItem> = {}): EvidenceItem => ({
  kind: "ticket",
  value: "ABC-12",
  ref: "ABC-12",
  document: null,
  status: "done",
  holds: true,
  problem: null,
  lapsed: false,
  ...over,
});

describe("a criterion's verdict", () => {
  it("has a word and a tone for every verdict the check sends", () => {
    expect(Object.keys(CRITERION_WORDS).sort()).toEqual([...CRITERION_VERDICTS].sort());
    expect(Object.keys(CRITERION_TONE).sort()).toEqual([...CRITERION_VERDICTS].sort());
    expect(CRITERION_TONE).toEqual({ met: "ok", unmet: "risk", unknown: "unknown" });
  });

  it("says why an unknown one is unknown: unmarked, reworded, evidence not done, or judged so", () => {
    expect(unknownCause(criterion({ position: 1, verdict: "met", marked: "met", why: null }))).toBeNull();
    expect(unknownCause(criterion({ position: 1 }))).toBe("unmarked");
    const reworded = criterion({
      position: 1,
      marked: "met",
      evidence: [ticket({ status: "in_review", holds: false })],
      why: 'the criterion was reworded after it was marked met (it read "Docs written")',
    });
    // Reworded wins over failing evidence, as it does in core.
    expect(unknownCause(reworded)).toBe("reworded");
    expect(unknownText(reworded)).toBe('Reworded after it was marked met, so it needs judging again. It read: "Docs written".');
    const pending = criterion({ position: 1, marked: "met", evidence: [ticket({ status: "in_review", holds: false }), ticket({ value: "x", kind: "text", ref: null })], why: "…" });
    expect(unknownCause(pending)).toBe("evidence");
    expect(unknownText(pending, (status) => (status === "in_review" ? "In review" : status))).toBe("Marked met, but its evidence does not hold yet: ABC-12 is in review, not done.");
    // Core's "no longer holds" when a piece held since the mark and has lapsed.
    const reopened = criterion({ position: 1, marked: "met", evidence: [ticket({ status: "todo", holds: false, lapsed: true })], why: "…" });
    expect(unknownText(reopened)).toBe("Marked met, but its evidence no longer holds: ABC-12 is todo, not done.");
    const judged = criterion({ position: 1, marked: "unknown", why: null });
    expect(unknownCause(judged)).toBe("judged");
    expect(unknownText(judged)).toBe("Judged unknown: the evidence so far does not settle it.");
    expect(unknownText(criterion({ position: 1 }))).toBe("Nobody has judged this yet.");
    expect(unknownText(criterion({ position: 1, verdict: "unmet", marked: "unmet", why: null }))).toBeNull();
  });

  it("words each piece of evidence that does not hold", () => {
    expect(evidenceProblemText(ticket())).toBeNull();
    expect(evidenceProblemText(ticket({ status: "todo", holds: false }))).toBe("ABC-12 is todo, not done");
    expect(evidenceProblemText(ticket({ kind: "document", value: "ABC-12:plan", document: "plan", holds: false }))).toBe('ABC-12 has no "plan" document');
    expect(evidenceProblemText(ticket({ value: "sta-999", ref: "ABC-999", status: null, holds: false }))).toBe("ABC-999 is not in this workspace");
  });

  it("says who marked it, when, and whether a run did", () => {
    expect(markedByText(criterion({ position: 1 }))).toBeNull();
    const text = markedByText(criterion({ position: 1, marked: "met", markedBy: "opus", markedAt: "2026-09-28T11:02:00.000Z", runId: "run-1" }), NOW);
    expect(text).toMatch(/^Marked met by opus on an autopilot run, \d\d:\d\d$/);
    expect(markedByText(criterion({ position: 1, marked: "unmet", markedBy: "vp", markedAt: null }), NOW)).toBe("Marked not met by vp");
  });

  it("sums the goal up", () => {
    expect(goalSummary({ met: 0, unmet: 0, unknown: 0, total: 0 })).toBe("No criteria yet: its goal is that every member lands.");
    expect(goalSummary({ met: 1, unmet: 0, unknown: 0, total: 1 })).toBe("Its one criterion is met.");
    expect(goalSummary({ met: 3, unmet: 0, unknown: 0, total: 3 })).toBe("All 3 criteria are met.");
    expect(goalSummary({ met: 1, unmet: 1, unknown: 2, total: 4 })).toBe("1 of 4 criteria met, 1 not met, 2 unknown.");
    expect(goalSummary({ met: 1, unmet: 0, unknown: 1, total: 2 })).toBe("1 of 2 criteria met, 1 unknown.");
  });
});

describe("pace against the target", () => {
  it("has a word and a tone for every verdict", () => {
    expect(Object.keys(PACE_WORDS).sort()).toEqual([...PACE_VERDICTS].sort());
    expect(Object.keys(PACE_TONE).sort()).toEqual([...PACE_VERDICTS].sort());
  });

  const leaves = { done: 3, countable: 9, percent: 33 };
  it("says each verdict with its numbers", () => {
    expect(paceText(pace({ verdict: "done", leaves: { done: 9, countable: 9, percent: 100 }, remainingSeconds: 0 }), NOW)).toBe("All of its work is done (9 of 9 tasks done).");
    expect(paceText(pace({ verdict: "no_target", targetDate: null, daysToTarget: null, leaves, remainingSeconds: 7200 }), NOW)).toBe(
      "3 of 9 tasks done; the longest chain of open work is 2h estimated. It has no target date to measure against.",
    );
    expect(paceText(pace({ verdict: "overdue", targetDate: "2026-09-26", daysToTarget: -2, leaves, remainingSeconds: null }), NOW)).toBe(
      "Its target, 26 Sept, passed 2 days ago. 3 of 9 tasks done.",
    );
    expect(paceText(pace({ verdict: "no_estimate", targetDate: "2026-10-11", daysToTarget: 13, leaves, remainingSeconds: null }), NOW)).toBe(
      "13 days to 11 Oct, but the open work has no estimate to measure, so there is no telling whether it fits. 3 of 9 tasks done.",
    );
    expect(paceText(pace({ verdict: "behind", targetDate: "2026-09-29", daysToTarget: 1, leaves, remainingSeconds: 50 * 3600, partial: true }), NOW)).toBe(
      "The longest chain of open work is at least 50h estimated: more than the time left to the end of 29 Sept, even worked around the clock. 3 of 9 tasks done.",
    );
    expect(paceText(pace({ verdict: "on_track", targetDate: "2026-10-11", daysToTarget: 13, leaves, remainingSeconds: 12 * 3600 }), NOW)).toBe(
      "The longest chain of open work is 12h estimated, 13 days to 11 Oct: it fits. 3 of 9 tasks done.",
    );
    expect(paceText(pace({ verdict: "on_track", targetDate: "2026-09-28", daysToTarget: 0, leaves, remainingSeconds: 3600 }), NOW)).toBe(
      "The longest chain of open work is 1h estimated, due today (28 Sept): it fits. 3 of 9 tasks done.",
    );
  });

  it("never says on track about open work its figure did not count", () => {
    // Nothing left by the estimate, yet 6 of 9 tasks are open: the work is not in the figure.
    const uncounted = pace({ verdict: "on_track", targetDate: "2026-10-11", daysToTarget: 13, leaves, remainingSeconds: 0 });
    expect(shownPace(uncounted, NOW).verdict).toBe("no_estimate");
    expect(paceText(uncounted, NOW)).not.toContain(": it fits");
  });

  it("names the members with no estimate, only when the figures are lower bounds", () => {
    expect(unplannedText({ partial: false, unplannedRefs: ["A-1"] })).toBeNull();
    expect(unplannedText({ partial: true, unplannedRefs: ["A-1", "A-2"] })).toBe("Not estimated yet: A-1, A-2.");
    expect(unplannedText({ partial: true, unplannedRefs: ["1", "2", "3", "4", "5", "6", "7"] })).toBe("Not estimated yet: 1, 2, 3, 4, 5 and 2 more.");
  });
});

describe("the milestone's gate", () => {
  const gate = { state: "pending" as const, owner: "VP", requestedAt: "2026-09-28T11:00:00.000Z", resolvedBy: null };
  it("tells a goal run's gate from a person's", () => {
    expect(goalRunRequester("goal-run:opus")).toBe("opus");
    expect(goalRunRequester("opus")).toBeNull();
    expect(goalRunRequester(null)).toBeNull();
    const run = gateText({ ...gate, requestedBy: "goal-run:opus" }, NOW);
    expect(run.text).toBe("Waiting for VP's approval.");
    expect(run.detail).toMatch(/^Asked for by opus's goal run, \d\d:\d\d\. It keeps the milestone from closing until VP approves; it holds none of the work\.$/);
    const person = gateText({ ...gate, requestedBy: "alice" }, NOW);
    expect(person.detail).toMatch(/^Asked for by alice, \d\d:\d\d\.$/);
  });

  it("words changes requested and approved", () => {
    expect(gateText({ ...gate, state: "changes_requested", requestedBy: "goal-run:opus" }, NOW).text).toBe("VP asked for changes.");
    expect(gateText({ ...gate, state: "approved", requestedBy: "goal-run:opus", resolvedBy: "vp" }, NOW).text).toBe("Approved by vp.");
  });
});
