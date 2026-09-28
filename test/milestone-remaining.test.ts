/**
 * A milestone's REMAINING work, from its estimates: the view's `remaining`, which the
 * Milestones page turns into a projected due date.
 *
 * The figure is the SUM over the milestone's open tasks (not done, not cancelled) of each
 * estimate scaled by its class's calibrated ratio — the unit figure `staple forecast` and
 * `calibrate --for` publish. It is not the critical path the goal's pace reads: two
 * independent tasks of 4h and 2h are 6h of work left, even though the longest chain is 4h.
 *
 * The recipe is forecast-surfaces.test.ts's: five exact samples worked 20–60 minutes against
 * 2 hours (area:ui, high), a pooled ratio of 0.35.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MilestoneCreateResult } from "../src/core/milestone-store.js";
import { MILESTONE_KIND } from "../src/core/milestones.js";
import { setClock } from "../src/core/types.js";
import { initWorkspace } from "../src/core/workspace.js";

type Store = ReturnType<typeof initWorkspace>["store"];

let home: string;
let store: Store;
const refs: Record<string, string> = {};

beforeAll(() => {
  home = mkdtempSync(join(tmpdir(), "staple-milestone-remaining-"));
  process.env.STAPLE_HOME = home;
  store = initWorkspace({ global: true, slug: "remaining" }).store;
  const T0 = Date.parse("2026-09-01T09:00:00.000Z");
  let clock = T0;
  const at = (minutes: number): void => void (clock = T0 + minutes * 60_000);
  setClock(() => clock);
  store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, "vp");
  const epic = store.createIssue({ title: "Work", kind: "epic" });
  let t = 0;
  for (const minutes of [20, 30, 40, 60, 60]) {
    at(t);
    const issue = store.createIssue({ title: `sample ${minutes}m`, parent: epic.id, estimatedSeconds: 7200, labels: ["area:ui"], priority: "high" });
    store.checkoutIssue(issue.id, "w", undefined, {});
    for (let m = t + 10; m < t + minutes; m += 10) (at(m), store.addComment(issue.id, "progress", "w", "agent"));
    at(t + minutes);
    store.updateIssue(issue.id, { status: "done" }, "w");
    t += minutes + 1;
  }
  at(t);
  // Open work, independent of each other: 4h and 2h. C has no estimate; D is cancelled.
  const a = store.createIssue({ title: "A", parent: epic.id, estimatedSeconds: 14400, labels: ["area:ui"], priority: "high" });
  const b = store.createIssue({ title: "B", parent: epic.id, estimatedSeconds: 7200, labels: ["area:ui"], priority: "high" });
  const c = store.createIssue({ title: "C", parent: epic.id, labels: ["area:ui"], priority: "high" });
  const d = store.createIssue({ title: "D", parent: epic.id, estimatedSeconds: 10800, labels: ["area:ui"], priority: "high" });
  store.updateIssue(d.id, { status: "cancelled" }, "w");
  const milestone = store.milestones().create({ title: "Release" }, "vp") as MilestoneCreateResult;
  store.milestones().addMember(milestone.milestone.id, epic.id, {}, "vp");
  Object.assign(refs, { epic: epic.identifier, a: a.identifier, b: b.identifier, c: c.identifier, milestone: milestone.milestone.identifier });
});

afterAll(() => {
  setClock(null);
  store?.db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("a milestone's remaining work", () => {
  it("sums its open tasks' estimates, and scales each the way a forecast scales a unit", () => {
    const view = store.milestones().get(refs.milestone!);
    // A and B carry estimates; C does not; D is cancelled and the samples are done.
    expect(view.remaining).toMatchObject({ estimated: 2, unestimated: 1, estimateSeconds: 6 * 3600 });
    // 0.35 × 4h + 0.35 × 2h = 7560 s: each unit's own calibrated figure, summed.
    expect(view.remaining.forecastSeconds).toBeCloseTo(7560, 6);
    const durations = store.calibratedDurations([refs.a!, refs.b!]);
    const units = [...durations.values()].reduce((sum, d) => sum + (d.seconds ?? 0), 0);
    expect(view.remaining.forecastSeconds).toBeCloseTo(units, 9);
  });

  it("is the sum of the work, not the critical path the goal's pace reads", () => {
    const view = store.milestones().get(refs.milestone!);
    // The pace reads the longest chain of the plan's own estimates: A alone, 4h.
    expect(view.goal.pace.remainingSeconds).toBe(4 * 3600);
    expect(view.remaining.forecastSeconds).toBeCloseTo(7560, 6);
  });

  it("comes with the list read too, so a card needs no second request", () => {
    const row = store.milestones().list().find((r) => r.milestone.identifier === refs.milestone)!;
    expect(row.remaining).toEqual(store.milestones().get(refs.milestone!).remaining);
  });

  it("falls back to the estimate itself for a class with no samples to scale by", () => {
    const lone = store.createIssue({ title: "unsampled", estimatedSeconds: 3600, labels: ["area:docs"], priority: "low", kind: "chore" });
    expect(store.calibratedDurations([lone.id]).get(lone.id)).toEqual({ estimateSeconds: 3600, seconds: expect.any(Number) });
  });
});
