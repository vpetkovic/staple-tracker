import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../src/core/db.js";
import { migrateWorkspace } from "../src/core/schema.js";
import { WorkspaceStore } from "../src/core/store.js";
import { applyToDatabase } from "../src/core/cloud/apply.js";
import type { Issue } from "../src/core/types.js";
import { PLANNED_WEIGHTS, REMAINING_WEIGHTS, planGraphOf, planStructureOf, walkPlanGraph, type PlanNode } from "../src/core/plan-rollup.js";

/**
 * The certified plan (`core/plan-rollup.ts`, `docs/cli.md` "Comparing plans"): total labor,
 * estimate coverage and the critical path, audited against adversarial trees. Every tree is
 * built by real store calls: estimates, cancellations and edges go through the same mutations
 * an agent makes, so the rollup is tested against the rows the tracker actually writes.
 */

const H = 3600;
let store: WorkspaceStore;
beforeEach(() => {
  const db = openDb(":memory:");
  migrateWorkspace(db);
  store = new WorkspaceStore(db, "test", "TST");
});

const child = (parent: Issue, title: string, hours?: number): Issue =>
  store.createChild(parent.id, { title, estimatedSeconds: hours === undefined ? undefined : hours * H });
const cancel = (issue: Issue): void => void store.updateIssue(issue.id, { status: "cancelled" }, "planner");
const block = (blocked: Issue, ...blockers: Issue[]): void =>
  void store.setBlockedBy(blocked.id, blockers.map((b) => b.id), "planner");
const compareOne = (issue: Issue) => store.comparePlans([issue.identifier]).plans[0]!;
const path = (issue: Issue) => compareOne(issue).criticalPath;

describe("labor: own estimate over descendants, never both", () => {
  it("an estimated parent over estimated children is counted once, at its own estimate", () => {
    const epic = store.createIssue({ title: "Epic" });
    const mid = child(epic, "Mid", 10);
    [4, 3, 4].forEach((hours, i) => child(mid, `Leaf ${i}`, hours));
    const side = child(epic, "Side", 2);

    const plan = compareOne(epic);
    expect(plan.labor).toEqual({ seconds: 12 * H, source: "descendants", ownSeconds: null, descendantsSeconds: 12 * H });
    // The three leaves are inside Mid's unit: covered by its estimate, not gaps and not added.
    expect(plan.coverage).toMatchObject({ planned: 2, unplanned: 0, units: 2, partial: false });
    expect(store.timing(epic.id).subtreePlan).toMatchObject({ contributingCount: 2, unplannedCount: 0, totalCount: 5 });
    expect(plan.criticalPath).toMatchObject({ seconds: 10 * H, partial: false, missing: [] });
    expect(plan.criticalPath.chain.map((step) => step.ref)).toEqual([mid.identifier]);
    expect(side.identifier).toBeTruthy();
  });

  it("the named issue's own estimate is the labor, with the bottom-up figure beside it", () => {
    const epic = store.createIssue({ title: "Epic", estimatedSeconds: 6 * H });
    child(epic, "A", 4);
    child(epic, "B", 5);
    const plan = compareOne(epic);
    expect(plan.labor).toEqual({ seconds: 6 * H, source: "own", ownSeconds: 6 * H, descendantsSeconds: 9 * H });
    // The path describes the structure beneath: two parallel units, the max of them.
    expect(plan.criticalPath.seconds).toBe(5 * H);
  });

  it("a mixed, partially estimated subtree is a lower bound with every gap named", () => {
    const epic = store.createIssue({ title: "Epic" });
    const a = child(epic, "A", 2);
    const b = child(epic, "B");
    const c = child(epic, "C");
    child(c, "C1", 1);
    const c2 = child(c, "C2");
    const plan = compareOne(epic);
    expect(plan.labor.seconds).toBe(3 * H);
    expect(plan.coverage).toEqual({
      planned: 2,
      unplanned: 2,
      units: 4,
      partial: true,
      unplannedRefs: [b.identifier, c2.identifier],
      cancelled: 0,
    });
    expect(store.timing(epic.id).subtreePlan).toMatchObject({ contributingCount: 2, unplannedCount: 2 });
    expect(plan.criticalPath).toMatchObject({ seconds: 2 * H, partial: true, missing: ["unplanned_units"] });
    expect(plan.criticalPath.chain).toEqual([{ ref: a.identifier, seconds: 2 * H, status: "backlog" }]);
  });

  it("nothing planned is null with no_plan, never 0", () => {
    const epic = store.createIssue({ title: "Epic" });
    child(child(epic, "Mid"), "Leaf");
    const plan = compareOne(epic);
    expect(plan.labor).toMatchObject({ seconds: null, source: "none" });
    expect(plan.coverage).toMatchObject({ planned: 0, unplanned: 1, units: 1 });
    expect(plan.criticalPath).toMatchObject({ seconds: null, partial: true, missing: ["no_plan"] });
  });

  it("deep nesting: unestimated levels pass the plan up, an estimated level shadows everything under it", () => {
    const epic = store.createIssue({ title: "Epic" });
    let level = epic;
    const levels: Issue[] = [];
    for (let depth = 1; depth <= 12; depth++) {
      level = child(level, `L${depth}`, depth === 6 ? 3 : undefined);
      levels.push(level);
      child(level, `side ${depth}`, 1);
    }
    // Levels 1-5 are containers, each with a 1h side leaf; level 6 is a 3h unit that shadows
    // levels 7-12 and their side leaves.
    const plan = compareOne(epic);
    expect(plan.labor.seconds).toBe(5 * H + 3 * H);
    expect(plan.coverage).toMatchObject({ planned: 6, unplanned: 0 });
    expect(store.timing(epic.id).subtreePlan).toMatchObject({ contributingCount: 6, unplannedCount: 0, totalCount: 24 });
    // Level 6's own reading still shows what lies beneath it.
    expect(store.timing(levels[5]!.id).subtreePlan).toMatchObject({ estimatedSeconds: 3 * H, descendantsEstimatedSeconds: 7 * H });
  });
});

describe("done and cancelled descendants", () => {
  it("done work stays labor; a wholly cancelled subtree is no labor and no gap", () => {
    const epic = store.createIssue({ title: "Epic" });
    const done = child(epic, "Done", 2);
    store.checkoutIssue(done.id, "agent");
    store.updateIssue(done.id, { status: "done" }, "agent");
    const dropped = child(epic, "Dropped", 3);
    cancel(dropped);
    const droppedEpic = child(epic, "Dropped epic");
    const gone1 = child(droppedEpic, "gone 1");
    const gone2 = child(droppedEpic, "gone 2", 5);
    cancel(gone1);
    cancel(gone2); // derivation cancels the parent once its last child is
    expect(store.getIssue(droppedEpic.id).status).toBe("cancelled");

    const timing = store.timing(epic.id);
    expect(timing.subtreePlan).toEqual({
      estimatedSeconds: 2 * H,
      source: "descendants",
      descendantsEstimatedSeconds: 2 * H,
      contributingCount: 1,
      unplannedCount: 0,
      totalCount: 5,
    });
    // The depth-1 raw sum is unchanged: it is the literal sum of the children's own estimates.
    expect(timing.childrenEstimatedSeconds).toBe(5 * H);
    const plan = compareOne(epic);
    expect(plan.coverage).toMatchObject({ planned: 1, unplanned: 0, cancelled: 4 });
    expect(plan.criticalPath).toMatchObject({ seconds: 2 * H, partial: false });
    // The cancelled issue keeps its own reading.
    expect(store.timing(dropped.id).subtreePlan.estimatedSeconds).toBe(3 * H);
  });

  it("a cancelled parent does not hide the live work its children still carry", () => {
    // Cancelling a parent cancels none of its children: they stay open, and checkout-able.
    const epic = store.createIssue({ title: "Epic" });
    const parked = child(epic, "Parked", 10);
    const c1 = child(parked, "c1", 2);
    const c2 = child(parked, "c2");
    cancel(parked);
    store.checkoutIssue(c1.id, "agent");
    expect(store.getIssue(c1.id).status).toBe("in_progress");

    const plan = compareOne(epic);
    // Parked's own 10h drops out; c1's 2h counts and c2 is a named gap.
    expect(plan.labor).toMatchObject({ seconds: 2 * H, source: "descendants" });
    expect(plan.coverage).toEqual({ planned: 1, unplanned: 1, units: 2, partial: true, unplannedRefs: [c2.identifier], cancelled: 1 });
    expect(store.timing(epic.id).subtreePlan).toMatchObject({ contributingCount: 1, unplannedCount: 1, descendantsEstimatedSeconds: 2 * H });

    // With a live 1h sibling the figure is 3h and still partial, not a silent 1h.
    child(epic, "Q", 1);
    expect(compareOne(epic).labor.seconds).toBe(3 * H);
    expect(compareOne(epic).coverage.partial).toBe(true);
    // Named directly, the cancelled parent is what is live beneath it, not its own 10h.
    expect(compareOne(parked).labor).toMatchObject({ seconds: 2 * H, source: "descendants", ownSeconds: 10 * H });
  });

  it("a live issue under a cancelled parent keeps its dependency edges and its outside blockers", () => {
    const epic = store.createIssue({ title: "Epic" });
    const parked = child(epic, "Parked");
    const inside = child(parked, "inside", 4);
    child(parked, "other", 1);
    const after = child(epic, "After", 3);
    const outsider = store.createIssue({ title: "Outsider" });
    block(after, inside);
    block(inside, outsider);
    cancel(parked);
    const path = compareOne(epic).criticalPath;
    expect(path.seconds).toBe(7 * H);
    expect(path.chain.map((step) => step.ref)).toEqual([inside.identifier, after.identifier]);
    expect(path.crossSubtreeBlockers.map((b) => b.blocked)).toEqual([inside.identifier]);
  });

  it("an epic whose children are all cancelled is an unplanned unit, not a planned zero", () => {
    const epic = store.createIssue({ title: "Epic" });
    const shell = child(epic, "Shell");
    cancel(child(shell, "gone", 4));
    // Derivation cancels a parent whose every child is; a person reopening it is what leaves
    // a live issue with no live children.
    expect(store.getIssue(shell.id).status).toBe("cancelled");
    store.updateIssue(shell.id, { status: "todo" }, "planner");
    const plan = compareOne(epic);
    expect(plan.labor.seconds).toBeNull();
    expect(plan.coverage).toMatchObject({ planned: 0, unplanned: 1, unplannedRefs: [shell.identifier] });
    expect(store.timing(epic.id).subtreePlan).toMatchObject({ unplannedCount: 1, contributingCount: 0 });
  });
});

describe("the critical path", () => {
  function diamond() {
    const epic = store.createIssue({ title: "Epic" });
    const a = child(epic, "A container");
    const a1 = child(a, "a1", 1);
    const a2 = child(a, "a2", 2);
    const b = child(epic, "B", 3);
    const c = child(epic, "C", 4);
    const d = child(epic, "D", 1);
    return { epic, a, a1, a2, b, c, d };
  }

  it("follows cross-parent edges, and parallel branches take the max rather than adding", () => {
    const { epic, a2, b, c, d } = diamond();
    block(b, a2); // a2 (under container A) -> B: an edge across parents
    block(c, b);
    block(d, a2); // a parallel 1h branch off a2
    const plan = path(epic);
    expect(plan.seconds).toBe(9 * H);
    expect(plan.chain.map((step) => step.ref)).toEqual([a2.identifier, b.identifier, c.identifier]);
    expect(plan.chainLength).toBe(3);
    expect(plan.edgeCount).toBe(3);
    // Labor still counts every unit once: 1 + 2 + 3 + 4 + 1.
    expect(compareOne(epic).labor.seconds).toBe(11 * H);
  });

  it("a container on either end stands for every unit beneath it", () => {
    const { epic, a, a1, b } = diamond();
    block(b, a); // B waits for the whole of A: a1 and a2
    block(a1, store.createIssue({ title: "unrelated" })); // outside, listed not followed
    const plan = path(epic);
    expect(plan.seconds).toBe(5 * H); // a2 (2h) -> B (3h)
    // One edge, from A's finish to B: a container is two virtual nodes, not a unit per pair.
    expect(plan.edgeCount).toBe(1);
    expect(plan.crossSubtreeBlockers).toEqual([
      { blocked: a1.identifier, blocker: expect.any(String), blockerStatus: "backlog", resolved: false },
    ]);
    expect(plan.unresolvedCrossSubtreeBlockerCount).toBe(1);
  });

  it("an edge inside one unit, to the named issue, or between an issue and its ancestor shapes nothing", () => {
    const epic = store.createIssue({ title: "Epic" });
    const unit = child(epic, "Unit", 2);
    const inner1 = child(unit, "inner 1", 5);
    const inner2 = child(unit, "inner 2", 5);
    block(inner2, inner1); // inside Unit's shadow
    const container = child(epic, "Container");
    const leaf = child(container, "leaf", 1);
    child(container, "sibling", 1);
    block(leaf, container); // a child blocked by its own parent: not sibling -> leaf
    const other = child(epic, "Other", 1);
    block(epic, other); // the named issue itself
    const plan = path(epic);
    expect(plan.edgeCount).toBe(0);
    expect(plan.seconds).toBe(2 * H);
    expect(leaf.identifier).toBeTruthy();
  });

  it("an issue inside a unit stands for that unit on either end of an edge", () => {
    const epic = store.createIssue({ title: "Epic" });
    const unit = child(epic, "Unit", 2);
    const inner = child(unit, "inner", 7);
    const after = child(epic, "After", 3);
    block(after, inner); // After waits on work inside Unit: Unit -> After, at Unit's 2h
    const plan = path(epic);
    expect(plan).toMatchObject({ seconds: 5 * H, edgeCount: 1 });
    expect(plan.chain.map((step) => step.ref)).toEqual([unit.identifier, after.identifier]);
  });

  it("a cancelled blocker drops out of the path", () => {
    const { epic, b, c } = diamond();
    block(c, b);
    cancel(b);
    expect(path(epic)).toMatchObject({ seconds: 4 * H, edgeCount: 0 });
  });

  it("an unplanned unit on the chain is shown as unknown, and makes the path partial", () => {
    const { epic, b, c } = diamond();
    const gap = child(epic, "Gap");
    block(gap, c);
    block(b, gap);
    const plan = path(epic);
    expect(plan.chain.map((step) => [step.ref, step.seconds])).toEqual([
      [c.identifier, 4 * H],
      [gap.identifier, null],
      [b.identifier, 3 * H],
    ]);
    expect(plan).toMatchObject({ seconds: 7 * H, partial: true, missing: ["unplanned_units"] });
  });

  it("a cycle the tracker could not see (through a container) is broken and reported, never looped", () => {
    const { epic, a, a1, b } = diamond();
    block(b, a); // B waits for all of A…
    block(a1, b); // …and a1, inside A, waits for B. No direct edge cycle, so the tracker allows it.
    const plan = path(epic);
    expect(plan.cycle).toEqual([a1.identifier, b.identifier]);
    expect(plan.partial).toBe(true);
    expect(plan.missing).toContain("dependency_cycle");
    expect(plan.seconds).not.toBeNull();
  });

  it("a leaf is its own single unit", () => {
    const leaf = store.createIssue({ title: "Leaf", estimatedSeconds: 2 * H });
    const plan = compareOne(leaf);
    expect(plan.coverage).toMatchObject({ planned: 1, units: 1 });
    expect(plan.criticalPath.chain.map((step) => step.ref)).toEqual([leaf.identifier]);
    expect(store.planSummary(leaf.id)).toBeNull();
  });
});

describe("the planned path and the remaining path", () => {
  const finish = (issue: Issue): void => {
    store.checkoutIssue(issue.id, "agent");
    store.updateIssue(issue.id, { status: "done" }, "agent");
  };

  it("keep done work on the planned path and weigh it 0 on the remaining one", () => {
    const epic = store.createIssue({ title: "Epic" });
    const a = child(epic, "A", 4);
    const b = child(epic, "B", 3);
    const c = child(epic, "C", 5);
    block(b, a);
    finish(a);
    const plan = compareOne(epic);
    expect(plan.criticalPath).toMatchObject({ seconds: 7 * H, partial: false });
    expect(plan.criticalPath.chain.map((step) => step.ref)).toEqual([a.identifier, b.identifier]);
    // A is done, so what is left is the longer of B (3h) and C (5h).
    expect(plan.remainingPath).toMatchObject({ seconds: 5 * H, partial: false, missing: [], chainLength: 1 });
    expect(plan.remainingPath.chain).toEqual([{ ref: c.identifier, seconds: 5 * H, status: "backlog" }]);
  });

  it("a done unit still carries the dependency through it, and drops off the remaining chain", () => {
    const epic = store.createIssue({ title: "Epic" });
    const a = child(epic, "A", 2);
    const b = child(epic, "B", 6);
    const c = child(epic, "C", 2);
    child(epic, "D", 3);
    block(b, a);
    block(c, b);
    finish(a);
    finish(b);
    const remaining = compareOne(epic).remainingPath;
    expect(remaining.seconds).toBe(3 * H);
    expect(compareOne(epic).criticalPath.seconds).toBe(10 * H);
  });

  it("an unplanned unit that is done is no gap in what remains; every unit done remains 0", () => {
    const epic = store.createIssue({ title: "Epic" });
    const gap = child(epic, "Gap");
    const a = child(epic, "A", 2);
    finish(gap);
    let plan = compareOne(epic);
    expect(plan.criticalPath).toMatchObject({ partial: true, missing: ["unplanned_units"] });
    expect(plan.remainingPath).toMatchObject({ seconds: 2 * H, partial: false, missing: [] });
    finish(a);
    plan = compareOne(epic);
    expect(plan.remainingPath).toMatchObject({ seconds: 0, partial: false, missing: [], chain: [], chainLength: 0 });
  });

  it("remaining open work with no plan is unknown, not 0", () => {
    const epic = store.createIssue({ title: "Epic" });
    finish(child(epic, "A", 2));
    child(epic, "Open, unplanned");
    expect(compareOne(epic).remainingPath).toMatchObject({ seconds: null, partial: true, missing: ["no_plan"], chain: [] });
  });
});

describe("the path walk takes the caller's weights", () => {
  it("walks the same graph with custom weights, and the built-in weights reproduce both paths", () => {
    const epic = store.createIssue({ title: "Epic" });
    const a = child(epic, "A", 4);
    const b = child(epic, "B", 4);
    const c = child(epic, "C", 6);
    block(b, a);
    const rows = [epic, a, b, c].map((issue) => store.getIssue(issue.id));
    const nodes = new Map<string, PlanNode>(
      rows.map((row) => [
        row.id,
        { id: row.id, identifier: row.identifier, parentId: row.parentId, estimatedSeconds: row.estimatedSeconds, status: row.status, cancelled: false, done: false },
      ]),
    );
    const graph = planGraphOf(epic.id, nodes, [{ blockerId: a.id, blockedId: b.id }]);
    const summary = compareOne(epic);
    const { edgeCount: _e, cycle: _c, crossSubtreeBlockers: _x, crossSubtreeBlockerCount: _n, unresolvedCrossSubtreeBlockerCount: _u, ...planned } =
      summary.criticalPath;
    expect(walkPlanGraph(graph, PLANNED_WEIGHTS, summary.labor)).toEqual(planned);
    expect(walkPlanGraph(graph, REMAINING_WEIGHTS, summary.labor)).toEqual(summary.remainingPath);
    // A caller's own weights: C at a quarter of its estimate; the A > B chain is 8h either way.
    const custom = walkPlanGraph(graph, {
      weightOf: (unit) => (unit.id === c.id ? 1.5 * H : unit.estimatedSeconds),
      include: () => true,
    });
    expect(custom.seconds).toBe(8 * H);
    expect(custom.chain.map((step) => step.ref)).toEqual([a.identifier, b.identifier]);
    // Halving every weight halves the path over the same chain.
    const halved = walkPlanGraph(graph, { weightOf: (unit) => (unit.estimatedSeconds ?? 0) / 2, include: () => true });
    expect(halved).toMatchObject({ seconds: 4 * H, exceedsLabor: false });
    expect(halved.chain.map((step) => step.ref)).toEqual([a.identifier, b.identifier]);
  });

  it("the remaining path is recomputed over the graph, so it can leave the planned chain", () => {
    const epic = store.createIssue({ title: "Epic" });
    const a = child(epic, "A", 5);
    const b = child(epic, "B", 5);
    const d = child(epic, "D", 3);
    block(b, a);
    store.checkoutIssue(a.id, "agent");
    store.updateIssue(a.id, { status: "done" }, "agent");
    store.checkoutIssue(b.id, "agent");
    store.updateIssue(b.id, { status: "done" }, "agent");
    const plan = compareOne(epic);
    expect(plan.criticalPath.chain.map((step) => step.ref)).toEqual([a.identifier, b.identifier]);
    expect(plan.remainingPath.chain.map((step) => step.ref)).toEqual([d.identifier]);
  });
});

describe("a path against an own estimate, and a path with no plan", () => {
  it("flags a path longer than the issue's own estimate", () => {
    const epic = store.createIssue({ title: "Epic", estimatedSeconds: 4 * H });
    const a = child(epic, "a", 3);
    const b = child(epic, "b", 3);
    block(b, a);
    const plan = compareOne(epic);
    expect(plan.labor).toMatchObject({ seconds: 4 * H, source: "own" });
    expect(plan.criticalPath).toMatchObject({ seconds: 6 * H, exceedsLabor: true });
    expect(plan.remainingPath.exceedsLabor).toBe(true);
    store.setEstimate(epic.id, 8 * H, "planner");
    expect(compareOne(epic).criticalPath.exceedsLabor).toBe(false);
  });

  it("never flags a sum of descendants, which a path cannot exceed", () => {
    const epic = store.createIssue({ title: "Epic" });
    block(child(epic, "b", 3), child(epic, "a", 3));
    expect(compareOne(epic).criticalPath).toMatchObject({ seconds: 6 * H, exceedsLabor: false });
  });

  it("returns an empty chain when the path is null", () => {
    const epic = store.createIssue({ title: "Epic" });
    const x = child(epic, "x");
    block(child(epic, "y"), x);
    const plan = compareOne(epic);
    expect(plan.criticalPath).toMatchObject({ seconds: null, chain: [], chainLength: 0, missing: ["no_plan"] });
    expect(plan.remainingPath).toMatchObject({ seconds: null, chain: [], chainLength: 0 });
  });
});

describe("coverage against subtreePlan", () => {
  it("agrees for a parent with live work beneath; a parent with none is its own single unit", () => {
    const epic = store.createIssue({ title: "Epic", estimatedSeconds: 2 * H });
    const only = child(epic, "only", 1);
    cancel(only);
    // Derivation cancels the epic with its last child; reopen it as a person would.
    store.updateIssue(epic.id, { status: "todo" }, "planner");
    const plan = compareOne(epic);
    // subtreePlan counts descendants' units: none are live.
    expect(store.timing(epic.id).subtreePlan).toMatchObject({ contributingCount: 0, unplannedCount: 0, totalCount: 1 });
    // The comparison still has a plan to report: the epic itself, at its own 2h.
    expect(plan.coverage).toMatchObject({ planned: 1, unplanned: 0, units: 1, cancelled: 1 });
    expect(plan.criticalPath.chain.map((step) => step.ref)).toEqual([epic.identifier]);
  });
});

describe("performance", () => {
  it("an edge between two containers of a thousand units stays one edge", () => {
    const epic = store.createIssue({ title: "Epic" });
    const left = child(epic, "Left");
    const right = child(epic, "Right");
    for (let i = 0; i < 1000; i++) {
      child(left, `l${i}`, 1);
      child(right, `r${i}`, 1);
    }
    block(right, left);
    const plan = store.planSummary(epic.id)!;
    expect(plan.criticalPath).toMatchObject({ seconds: 2 * H, edgeCount: 1, chainLength: 2 });
    expect(plan.remainingPath.seconds).toBe(2 * H);
    expect(plan.labor.seconds).toBe(2000 * H);
  }, 120_000);

  it("the unit graph of that shape builds and walks well inside 100 ms", () => {
    // The pure step alone, so the budget measures the graph and not the timing replay or a busy
    // machine's database. Expanding every unit pair (a million edges) took about 500 ms here.
    const nodes = new Map<string, PlanNode>();
    const add = (id: string, parentId: string | null, estimatedSeconds: number | null) =>
      nodes.set(id, { id, identifier: `TST-${nodes.size + 1}`, parentId, estimatedSeconds, status: "backlog", cancelled: false, done: false });
    add("epic", null, null);
    add("left", "epic", null);
    add("right", "epic", null);
    for (let i = 0; i < 1000; i++) {
      add(`l${i}`, "left", H);
      add(`r${i}`, "right", H);
    }
    const labor = { seconds: 2000 * H, source: "descendants" as const, ownSeconds: null, descendantsSeconds: 2000 * H };
    const edges = [{ blockerId: "left", blockedId: "right" }];
    planStructureOf("epic", nodes, edges, [], labor); // warm up
    let elapsed = Infinity;
    for (let run = 0; run < 3; run++) {
      const started = performance.now();
      const result = planStructureOf("epic", nodes, edges, [], labor);
      elapsed = Math.min(elapsed, performance.now() - started);
      expect(result.criticalPath).toMatchObject({ seconds: 2 * H, edgeCount: 1 });
    }
    expect(elapsed).toBeLessThan(100);
  });
});

describe("comparing named issues", () => {
  it("returns each plan once and names the overlap instead of letting two figures be added", () => {
    const epic = store.createIssue({ title: "Epic" });
    const inner = child(epic, "Inner");
    child(inner, "x", 2);
    const other = store.createIssue({ title: "Other", estimatedSeconds: 3 * H });
    const result = store.comparePlans([epic.identifier, inner.identifier, other.identifier, epic.id]);
    expect(result.plans.map((plan) => [plan.ref, plan.labor.seconds])).toEqual([
      [epic.identifier, 2 * H],
      [inner.identifier, 2 * H],
      [other.identifier, 3 * H],
    ]);
    expect(result.overlaps).toEqual([{ ref: inner.identifier, within: epic.identifier }]);
  });

  it("refuses an empty or oversize request", () => {
    expect(() => store.comparePlans([])).toThrow(/at least one/);
    const refs = Array.from({ length: 21 }, (_, i) => store.createIssue({ title: `I${i}` }).identifier);
    expect(() => store.comparePlans(refs)).toThrow(/at most 20/);
  });
});

describe("a leaf moved between parents", () => {
  /**
   * No local verb reparents an issue: the parent is fixed at creation. The one path that writes
   * `parentId` is the sync applier, taking an issue update from another device, so that is the
   * path used here: the real applier inside `Journal.applyRemote`.
   */
  it("leaves the old parent and joins the new one, counted once", () => {
    const from = store.createIssue({ title: "From" });
    const to = store.createIssue({ title: "To" });
    child(to, "stays", 1);
    const leaf = child(from, "Moving", 3);
    const before = store.comparePlans([from.identifier, to.identifier]).plans.map((plan) => plan.labor.seconds);
    expect(before).toEqual([3 * H, 1 * H]);
    store.journal.applyRemote({ opId: "f".repeat(32), seq: 7 }, () =>
      applyToDatabase(store.db, {
        entity: "issue",
        entityId: leaf.id,
        verb: "update",
        payload: { parentId: to.id },
        actor: "agent-b",
        deviceId: "device-b",
        at: new Date().toISOString(),
        opId: "f".repeat(32),
        seq: 7,
      }),
    );
    const after = store.comparePlans([from.identifier, to.identifier]).plans;
    expect(after.map((plan) => plan.labor.seconds)).toEqual([null, 4 * H]);
    expect(after[1]!.coverage.planned).toBe(2);
  });
});

describe("the certified invariants hold on random trees", () => {
  /** A seeded generator, so a failure names its tree. */
  function rng(seed: number) {
    let state = seed;
    return () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
  }

  it.each([1, 2, 3, 4, 5, 6, 7, 8])("seed %i: units sum to the bottom-up plan; the path never exceeds it", (seed) => {
    const random = rng(seed);
    const epic = store.createIssue({ title: `Epic ${seed}` });
    const all: Issue[] = [epic];
    for (let i = 0; i < 40; i++) {
      const parent = all[Math.floor(random() * all.length)]!;
      const estimate = random() < 0.6 ? Math.ceil(random() * 8) : undefined;
      const issue = child(parent, `n${i}`, estimate);
      all.push(issue);
      if (random() < 0.1) cancel(issue);
    }
    // Edges between random pairs, whatever the tracker accepts.
    for (let i = 0; i < 25; i++) {
      const x = all[1 + Math.floor(random() * (all.length - 1))]!;
      const y = all[1 + Math.floor(random() * (all.length - 1))]!;
      try {
        store.setBlockedBy(y.id, [...store.blockersOf(y.id).map((b) => b.id), x.id], "planner");
      } catch {
        // a refused cycle or self edge: the tracker's rule, not this test's
      }
    }
    const plan = compareOne(epic);
    const subtree = store.timing(epic.id).subtreePlan;
    expect(plan.labor.descendantsSeconds).toBe(subtree.descendantsEstimatedSeconds);
    expect(plan.coverage.planned).toBe(subtree.contributingCount);
    expect(plan.coverage.unplanned).toBe(subtree.unplannedCount);
    const sum = plan.coverage.planned === 0 ? null : plan.labor.descendantsSeconds;
    // What remains is never longer than the plan, and a null path has no chain.
    if (plan.remainingPath.seconds !== null && plan.criticalPath.seconds !== null) {
      expect(plan.remainingPath.seconds).toBeLessThanOrEqual(plan.criticalPath.seconds);
    }
    if (plan.criticalPath.seconds === null) expect(plan.criticalPath.chain).toEqual([]);
    if (sum === null) expect(plan.criticalPath.seconds).toBeNull();
    else expect(plan.criticalPath.seconds!).toBeLessThanOrEqual(sum);
    // The chain is a real dependency chain, and its seconds add up to the reported length.
    const chainSum = plan.criticalPath.chain.reduce((total, step) => total + (step.seconds ?? 0), 0);
    if (plan.criticalPath.seconds !== null) expect(chainSum).toBe(plan.criticalPath.seconds);
  });
});
