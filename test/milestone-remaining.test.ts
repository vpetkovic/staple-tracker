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
/** The instant the fixture ends at: every read is taken as of then, as a forecast's is. */
let asOf = "";

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
  // Open work, independent of each other: A (4h) and B (2h) not started; R (2h) handed over
  // for review, which forecast weighs as nothing left; S (3h) started 30 minutes ago; C with
  // no estimate; D cancelled.
  const a = store.createIssue({ title: "A", parent: epic.id, estimatedSeconds: 14400, labels: ["area:ui"], priority: "high" });
  const b = store.createIssue({ title: "B", parent: epic.id, estimatedSeconds: 7200, labels: ["area:ui"], priority: "high" });
  const r = store.createIssue({ title: "R", parent: epic.id, estimatedSeconds: 7200, labels: ["area:ui"], priority: "high" });
  store.updateIssue(r.id, { status: "in_review" }, "w");
  const started = store.createIssue({ title: "S", parent: epic.id, estimatedSeconds: 10800, labels: ["area:ui"], priority: "high" });
  store.checkoutIssue(started.id, "w", undefined, {});
  for (let m = t + 10; m <= t + 30; m += 10) (at(m), store.addComment(started.id, "progress", "w", "agent"));
  const c = store.createIssue({ title: "C", parent: epic.id, labels: ["area:ui"], priority: "high" });
  const d = store.createIssue({ title: "D", parent: epic.id, estimatedSeconds: 10800, labels: ["area:ui"], priority: "high" });
  store.updateIssue(d.id, { status: "cancelled" }, "w");
  asOf = new Date(clock).toISOString();
  const milestone = store.milestones().create({ title: "Release" }, "vp") as MilestoneCreateResult;
  store.milestones().addMember(milestone.milestone.id, epic.id, {}, "vp");
  Object.assign(refs, { epic: epic.identifier, a: a.identifier, b: b.identifier, r: r.identifier, s: started.identifier, c: c.identifier, milestone: milestone.milestone.identifier });
});

afterAll(() => {
  setClock(null);
  store?.db.close();
  rmSync(home, { recursive: true, force: true });
});

describe("a milestone's remaining work", () => {
  it("is the labor `staple forecast` reads for the same tasks, unit for unit", () => {
    setClock(() => Date.parse(asOf));
    try {
      const view = store.milestones().get(refs.milestone!);
      const forecast = store.forecast({ ref: refs.epic! }, asOf);
      // The epic holds exactly the milestone's tasks, so the two sums are over the same units.
      expect(view.remaining.forecastSeconds).toBeCloseTo(forecast.completion.labor.expectedSeconds!, 6);
      const byRef = new Map(forecast.completion.units.items.map((item) => [item.ref, item]));
      const units = store.remainingForecasts([refs.a!, refs.b!, refs.r!, refs.s!, refs.c!], asOf);
      const by = (ref: string) => units.get(store.getIssue(ref).id)!;
      // Not started: the estimate scaled, 0.35 × 4h. In review: nothing left. Started: the
      // conditional remainder, not the whole duration. No estimate: unknown.
      expect(by(refs.a!).seconds).toBeCloseTo(byRef.get(refs.a!)!.expected!.remainingSeconds, 9);
      expect(by(refs.a!).seconds).toBeCloseTo(5040, 6);
      expect(by(refs.r!).seconds).toBe(0);
      expect(by(refs.s!).seconds).toBeCloseTo(byRef.get(refs.s!)!.expected!.remainingSeconds, 9);
      expect(by(refs.s!).seconds).toBeLessThan(0.35 * 10800);
      expect(by(refs.c!).seconds).toBeNull();
      expect(view.remaining).toMatchObject({ estimated: 4, unestimated: 1, unknown: 1, estimateSeconds: (4 + 2 + 2 + 3) * 3600 });
    } finally {
      setClock(null);
    }
  });

  it("is the sum of the work, not the critical path the goal's pace reads", () => {
    const view = store.milestones().get(refs.milestone!);
    // The pace reads the longest chain of the plan's own estimates: one task alone.
    expect(view.goal.pace.remainingSeconds).toBeLessThan(view.remaining.estimateSeconds!);
  });

  it("comes with the list read too, so a card needs no second request", () => {
    const row = store.milestones().list().find((r) => r.milestone.identifier === refs.milestone)!;
    expect(row.remaining).toEqual(store.milestones().get(refs.milestone!).remaining);
  });

  it("rebuilds the calibration population when finished work changes it, and only then", () => {
    const before = store.remainingForecasts([refs.a!], asOf).get(store.getIssue(refs.a!).id)!.seconds!;
    // Work on open tasks leaves the population alone: same figure.
    store.addComment(refs.b!, "still going", "w", "agent");
    expect(store.remainingForecasts([refs.a!], asOf).get(store.getIssue(refs.a!).id)!.seconds).toBe(before);
    // A sixth sample, finished at 4× its estimate, moves the class's ratio: a new figure.
    let clock = Date.parse(asOf);
    setClock(() => clock);
    try {
      const sample = store.createIssue({ title: "slow sample", estimatedSeconds: 600, labels: ["area:ui"], priority: "high" });
      store.checkoutIssue(sample.id, "w", undefined, {});
      for (let m = 10; m <= 40; m += 10) (clock += 10 * 60_000, store.addComment(sample.id, "progress", "w", "agent"));
      store.updateIssue(sample.id, { status: "done" }, "w");
    } finally {
      setClock(null);
    }
    expect(store.remainingForecasts([refs.a!], asOf).get(store.getIssue(refs.a!).id)!.seconds).not.toBe(before);
  });
});

describe("a milestone's closedAt", () => {
  it("is set while it is closed and null once it is reopened, whatever stamps the issue keeps", () => {
    const m = store.milestones().create({ title: "Reopened" }, "vp") as MilestoneCreateResult;
    const id = m.milestone.id;
    store.updateIssue(id, { status: "cancelled" }, "vp");
    const cancelled = store.milestones().get(id).milestone;
    expect(cancelled.closedAt).toBe(store.getIssue(id).cancelledAt);
    expect(cancelled.closedAt).not.toBeNull();
    store.updateIssue(id, { status: "backlog" }, "vp");
    // The store keeps the old cancelledAt after a reopen; the milestone is open, so no closedAt.
    expect(store.getIssue(id).cancelledAt).not.toBeNull();
    expect(store.milestones().get(id).milestone.closedAt).toBeNull();
    expect(store.milestones().list({ all: true }).find((r) => r.milestone.id === id)!.milestone.closedAt).toBeNull();
    store.updateIssue(id, { status: "done" }, "vp");
    expect(store.milestones().get(id).milestone.closedAt).toBe(store.getIssue(id).completedAt);
  });
});
