/**
 * The R3e (STA-175) milestone scenario: one realistic workspace that every
 * milestone end-to-end case reads from, built ONCE.
 *
 * WHY A BUILDER AND NOT MORE `beforeEach` SETUP. The R3 suites each construct
 * the two or three rows their one rule needs, which is right for them and
 * useless for a verification pass: the interesting failures live where the
 * shapes overlap — an epic in one milestone whose own child is a member of
 * ANOTHER, a member that is also reached by descent, a gated epic and a blocked
 * leaf and a cancelled leaf all under the same plan. So this file writes ONE
 * workspace with all of that in it and hands back the identifiers, and both
 * `test/milestones-e2e.test.ts` and the browser-side
 * `views/milestones/milestones-e2e.test.tsx` read it.
 *
 * WHY IN-PROCESS AND NOT `staple new` × 15. A global workspace's database is at
 * `<staple home>/workspaces/<slug>.db` (`initWorkspace`), so seeding it through
 * the store API and then letting the CLI, the MCP server and the HTTP server
 * open that same FILE is the same workspace by any surface — and costs one child
 * process instead of twenty. The suites that follow spend their spawns on the
 * assertions rather than on setup.
 *
 * Test-only: nothing under `src/` imports this.
 */
import { join } from "node:path";
import { MILESTONE_KIND } from "../../src/core/milestones.js";
import { initWorkspace } from "../../src/core/workspace.js";
import type { WorkspaceStore } from "../../src/core/store.js";

/** Who seeds. A single actor keeps `addedBy` and every event's author pinnable. */
export const SCENARIO_ACTOR = "r3e-fixture";
/** The human the approval gate waits on. */
export const GATE_OWNER = "VP";

/**
 * The two dated milestones' targets, and the start the October plan carries.
 * Different targets on purpose: "sorts by plan position first, then by date"
 * only means something when the two disagree, and October is queued second.
 */
export const OCTOBER_TARGET = "2026-10-31";
export const OCTOBER_START = "2026-10-01";
export const NOVEMBER_TARGET = "2026-11-30";

/**
 * Every identifier the scenario writes, by role rather than by number, so a
 * test reads as prose and an inserted row does not renumber the assertions.
 *
 * The shape, in one picture (`>` is parentage, never membership):
 *
 *   MSC-1  R programme (epic)
 *     > MSC-2  Q: queue (epic)          ← October member 1
 *         > MSC-3  Q1: resolver         (todo)
 *         > MSC-4  Q2: surfaces         (blocked by MSC-3)   ← October member 2, nested under MSC-2
 *         > MSC-5  Q3: docs             (todo)               ← NOVEMBER member 2 (cross-epic)
 *     > MSC-6  M: milestones (epic)     ← November member 1, GATED on VP
 *         > MSC-7  M1: store            (queued behind the gate)
 *         > MSC-8  M2: view             (queued behind the gate)
 *     > MSC-9  S: cloud continuity (epic)  ← in NO milestone: the create-from-epic subject
 *         > MSC-10 S1: tunnel
 *         > MSC-11 S2: auth
 *   MSC-12 Flake under load  (cancelled, no parent)          ← October member 4
 *   MSC-13 Cloud spike       (done, no parent)               ← October member 3
 *   MSC-14 October cut  (milestone, target 2026-10-31, start 2026-10-01)  plan row 2
 *   MSC-15 November cut (milestone, target 2026-11-30)                    plan row 1
 *
 * THE OVERLAP IS THE POINT. October owns the epic MSC-2; November owns MSC-2's
 * own child MSC-5. So `nearestMilestone` has a real self-before-ancestor case,
 * the resolver has a row it reaches through one milestone while the row BELONGS
 * to another, and progress has a leaf reachable two ways.
 */
export const SCENARIO = {
  programme: "MSC-1",
  queueEpic: "MSC-2",
  q1: "MSC-3",
  q2: "MSC-4",
  q3: "MSC-5",
  milestonesEpic: "MSC-6",
  m1: "MSC-7",
  m2: "MSC-8",
  cloudEpic: "MSC-9",
  s1: "MSC-10",
  s2: "MSC-11",
  flake: "MSC-12",
  spike: "MSC-13",
  october: "MSC-14",
  november: "MSC-15",
} as const;

/** The identifier `milestone new --from-epic` will mint next, after the fifteen above. */
export const NEXT_IDENTIFIER = "MSC-16";

/** The slug and prefix `seedScenarioWorkspace` initialises. */
export const SCENARIO_WS = "mscene";
export const SCENARIO_PREFIX = "MSC";

/**
 * The subtree of an epic as a comparable value: identifier, parent, depth,
 * kind, status and unresolved blockers, in identifier order.
 *
 * This is what "creating a milestone from an epic changes nothing about the
 * epic" MEANS, so it is captured as data and compared with `toEqual` rather
 * than asserted field by field: a field that starts moving fails the diff even
 * if nobody thought to assert it.
 */
export interface HierarchySnapshot {
  identifier: string;
  parent: string | null;
  depth: number;
  kind: string;
  status: string;
  blockedBy: string[];
}

export function hierarchyOf(store: WorkspaceStore, rootRef: string): HierarchySnapshot[] {
  const root = store.getIssue(rootRef);
  const all = store.listIssues({});
  const byId = new Map(all.map((issue) => [issue.id, issue]));
  const inSubtree = (id: string): boolean => {
    let current: string | null = id;
    for (let depth = 0; current !== null && depth < 32; depth += 1) {
      if (current === root.id) return true;
      current = byId.get(current)?.parentId ?? null;
    }
    return false;
  };
  return all
    .filter((issue) => inSubtree(issue.id))
    .map((issue) => ({
      identifier: issue.identifier,
      parent: issue.parentId === null ? null : (byId.get(issue.parentId)?.identifier ?? issue.parentId),
      depth: issue.depth,
      kind: issue.kind,
      status: issue.status,
      blockedBy: store
        .unresolvedBlockersOf(issue.id)
        .map((row) => row.identifier)
        .sort(),
    }))
    .sort((a, b) => a.identifier.localeCompare(b.identifier, undefined, { numeric: true }));
}

/** Walk a leaf to `done` the way the status guards insist on, then optionally past it. */
function land(store: WorkspaceStore, ref: string, to: "done" | "cancelled"): void {
  if (to === "done") {
    store.updateIssue(ref, { assignee: SCENARIO_ACTOR }, SCENARIO_ACTOR);
    store.updateIssue(ref, { status: "in_progress" }, SCENARIO_ACTOR);
  }
  store.updateIssue(ref, { status: to }, SCENARIO_ACTOR);
}

/**
 * Write the scenario into an open, empty workspace. Exported separately from
 * `seedScenarioWorkspace` so an in-memory store can use it too — the ordering
 * rules do not need a file, only the surfaces do.
 *
 * The order of the writes is the order of the picture above; identifiers are
 * allocated by creation order, which is why `SCENARIO` can be a constant.
 */
export function buildScenario(store: WorkspaceStore): typeof SCENARIO {
  store.addKind({ id: MILESTONE_KIND, label: "Milestone" }, SCENARIO_ACTOR);

  store.createIssue({ title: "R: work orchestration", kind: "epic", createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "Q: pickup queue", kind: "epic", parent: SCENARIO.programme, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "Q1: the resolver", parent: SCENARIO.queueEpic, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "Q2: the surfaces", parent: SCENARIO.queueEpic, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "Q3: the docs", parent: SCENARIO.queueEpic, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "M: milestones", kind: "epic", parent: SCENARIO.programme, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "M1: the store", parent: SCENARIO.milestonesEpic, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "M2: the view", parent: SCENARIO.milestonesEpic, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "S: opt-in cloud continuity", kind: "epic", parent: SCENARIO.programme, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "S1: the tunnel", parent: SCENARIO.cloudEpic, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "S2: the auth handshake", parent: SCENARIO.cloudEpic, createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "Flake under full-suite load", createdBy: SCENARIO_ACTOR });
  store.createIssue({ title: "Cloud spike", createdBy: SCENARIO_ACTOR });

  // A blocker inside a member epic, and an approval gate over a whole member
  // epic: the two hard constraints the resolver must show rather than drop.
  store.setBlockedBy(SCENARIO.q2, [SCENARIO.q1], SCENARIO_ACTOR);
  store.gateIssue(SCENARIO.milestonesEpic, { owner: GATE_OWNER, comment: "R3 needs sign-off" }, SCENARIO_ACTOR);

  // One completed member and one cancelled member, so the progress denominator
  // has both a numerator and a subtraction in it.
  land(store, SCENARIO.spike, "done");
  land(store, SCENARIO.flake, "cancelled");

  const milestones = store.milestones();
  // October: FROM the queue epic, so the fixture itself exercises the create
  // path once; then the epic's own child MSC-4 nested under it, the done member
  // and the cancelled member.
  milestones.create(
    { title: "October cut", targetDate: OCTOBER_TARGET, startDate: OCTOBER_START, fromEpic: SCENARIO.queueEpic },
    SCENARIO_ACTOR,
  );
  milestones.addMember(SCENARIO.october, SCENARIO.q2, { note: "pull the surfaces forward" }, SCENARIO_ACTOR);
  milestones.addMember(SCENARIO.october, SCENARIO.spike, {}, SCENARIO_ACTOR);
  milestones.addMember(SCENARIO.october, SCENARIO.flake, {}, SCENARIO_ACTOR);

  milestones.create({ title: "November cut", targetDate: NOVEMBER_TARGET }, SCENARIO_ACTOR);
  milestones.addMember(SCENARIO.november, SCENARIO.milestonesEpic, {}, SCENARIO_ACTOR);
  // The cross-epic manual member: MSC-5's ancestor belongs to October, MSC-5
  // itself belongs to November, and neither membership moved a parent.
  milestones.addMember(SCENARIO.november, SCENARIO.q3, { note: "docs land in November" }, SCENARIO_ACTOR);

  // November first in the PLAN even though October is due sooner: a date
  // explains urgency and never reorders a plan somebody wrote by hand.
  const queue = store.queue();
  queue.enqueue(SCENARIO.november, {}, SCENARIO_ACTOR);
  queue.enqueue(SCENARIO.october, {}, SCENARIO_ACTOR);

  return SCENARIO;
}

/**
 * Create the global workspace under `home` and write the scenario into it, then
 * close the handle. `initWorkspace` is what `staple init --global` calls, so the
 * hub registration, the prefix allocation and the database are exactly what a
 * real init produces — and the caller's CLI, MCP and HTTP surfaces then open the
 * same file by slug. The caller must have set `process.env.STAPLE_HOME` first;
 * `resolveHome()` is deliberately un-memoized so that works.
 */
export function seedScenarioWorkspace(home: string, slug: string = SCENARIO_WS): string {
  const opened = initWorkspace({ global: true, slug });
  if (opened.store.prefix !== SCENARIO_PREFIX) {
    throw new Error(`expected prefix ${SCENARIO_PREFIX} for slug "${slug}", got ${opened.store.prefix}`);
  }
  try {
    buildScenario(opened.store);
  } finally {
    opened.store.db.close(); // one handle per db file, as `mcp.ts` does
  }
  return join(home, "workspaces", `${slug}.db`);
}
