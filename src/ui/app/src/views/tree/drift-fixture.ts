/**
 * ONE BOARD, SHAPED LIKE THE COMBINATIONS THAT DRIFT — R4e (STA-190).
 *
 * R4a gave the list eight sort modes, R4b eleven filter dimensions, R4c two row cues and
 * R4d five grouping axes. Each landed with its own tests and its own two-or-three-row
 * fixture, and each of those fixtures is shaped to make ONE claim easy to read. That is the
 * right shape for a unit test and the wrong shape for this ticket: the failures STA-190
 * exists to catch are not inside any one of those features, they are at the seams —
 * sort ACROSS a grouping axis, a filter ACROSS the ghost rule, a queue cue ACROSS a
 * milestone, a collapsed epic ACROSS a rollup.
 *
 * A seam cannot be tested with a fixture built for one side of it. So there is one board
 * here and every file in this ticket reads it, which buys two things a per-test fixture
 * cannot:
 *
 *   1. AN ASSERTION IN ONE FILE CONSTRAINS THE OTHERS. `view-combinations` proves STA-7 is
 *      queued at #5 in the model; `view-a11y` proves the words "Queued" and "#5" reach a
 *      screen reader; `view-responsive` proves they survive at 400px; `polling-stability`
 *      proves a poll does not move them. Four claims about ONE row, so a change that
 *      satisfies one by breaking another fails somewhere.
 *   2. THE COMBINATIONS ARE PRESENT BY CONSTRUCTION. Every combination the ticket names is
 *      a property of this board rather than of a test that remembered to build it.
 *
 * ── WHAT IS ON THE BOARD, AND WHY EACH ROW IS HERE ────────────────────────────────────
 *
 *   STA-1  epic-order   epic, in progress            an EXPANDED epic: something live beneath
 *   STA-2  t-live       task, in progress, LIVE claim   milestone member; the queue calls it claimed
 *   STA-3  t-gate       task, awaiting_approval       the gated child, with a pending gate
 *   STA-4  t-stale      task, in progress, STALE claim   the takeover case; still `claimed`
 *   STA-9  t-done       task, done                    hidden by the default filter, counted in the rollup
 *   STA-5  epic-cold    epic, backlog                 a COLLAPSED epic: nothing active beneath it
 *   STA-6  t-cold       task, backlog                 the unqueued band
 *   STA-7  t-research   CUSTOM KIND `research`, todo     milestone member AND queued at #5
 *   STA-8  t-loner      task, todo, no parent         the one pickable row — the queue's `next`
 *
 * ── THE THREE FACTS THAT MAKE IT A DRIFT FIXTURE ──────────────────────────────────────
 *
 * MILESTONE MEMBERSHIP IS NOT THE TREE. `M-1` contains STA-2 and STA-7, which sit under
 * DIFFERENT epics, and neither epic is a member. So filtering by milestone removes both
 * parents and keeps both children — the exact shape that produces orphaned rows at depth 0
 * if the ghost rule ever stops firing, and it produces TWO ghosts rather than one, so a
 * fix that special-cases a single missing parent does not pass.
 *
 * THE QUEUE DISAGREES WITH THE TREE ORDER ON PURPOSE. The plan is STA-1, then STA-8, then
 * STA-7 — a container, a loner and a nested row, in that order — so `queue` sort produces a
 * sequence that no other mode produces and no grouping axis produces either. If a group
 * builder silently dropped the sort, the queue mode is the one where it shows.
 *
 * THE CUSTOM KIND IS NOT IN THE VOCABULARY. `research` is an id `/api/settings` has never
 * sent, which is deliberate: publishing workspace settings mutates module state that a
 * neighbouring suite would inherit, and the documented behaviour for an unknown kind — title
 * -cased label, sorted after every configured kind — is exactly what a custom kind arriving
 * before its settings payload looks like. So the fixture needs no `publishWorkspaceSettings`
 * and no `afterEach` to undo one.
 *
 * NOT imported by any app code. Vite drops it from the bundle because nothing in the module
 * graph reaches it — the same arrangement `components/task-list/fixtures.ts` and
 * `views/milestones/fixtures.ts` already have, and beside the code for the same reason: it
 * is typed against the browser app's `lib/types.ts`, which the Node-side suite cannot see.
 */
import { STALE_CLAIM_SECONDS } from "@/lib/claim";
import type {
  EffectiveQueueRow,
  InboxIssue,
  InboxRow,
  IssueRow,
  QueueEntry,
  QueueView,
} from "@/lib/types";
import type { MilestoneFacts } from "@/lib/filter-dimensions";
import { claim, issue, row } from "@/components/task-list/fixtures";

/** The instant every timestamp on the board is stated relative to. */
export const FIXTURE_NOW = "2026-09-04T12:00:00.000Z";

/** The one milestone, and the two rows in it. */
export const MILESTONE = {
  identifier: "M-1",
  title: "Release 1.0",
  members: ["STA-2", "STA-7"] as const,
};

/** The custom kind — an id the configured vocabulary has never heard of. See the header. */
export const CUSTOM_KIND = "research";

/**
 * A claim that is live, and one that is not. Both are the SERVED `idleSeconds`, never a
 * clock reading, which is what lets every test in this ticket be deterministic without
 * freezing time for the model (only the rendered date needs that).
 */
const live = claim({ heldBy: "opus-r4c", idleSeconds: 30 });
const stale = claim({ heldBy: "opus-gone", idleSeconds: STALE_CLAIM_SECONDS + 600, heldSeconds: 7200 });

/**
 * THE BOARD, in the order `/api/issues` would send it — which is deliberately NOT the order
 * any sort mode produces, so a test that accidentally asserts the input order fails.
 */
export function driftRows(): IssueRow[] {
  return [
    row({
      id: "epic-order",
      identifier: "STA-1",
      title: "Ordering and cues",
      kind: "epic",
      status: "in_progress",
      priority: "high",
      updatedAt: "2026-09-04T09:00:00.000Z",
      createdAt: "2026-09-01T09:00:00.000Z",
    }),
    row(
      {
        id: "t-live",
        identifier: "STA-2",
        title: "Join the queue onto the row",
        parentId: "epic-order",
        status: "in_progress",
        priority: "critical",
        assignee: "opus-r4c",
        checkoutAgent: "opus-r4c",
        // THREE labels, deliberately: §14's cap is two at the widest, so the wide render
        // shows two pills and a `+1` and the narrow one shows bare dots. A row with one
        // label would look identical at both widths and prove nothing.
        labels: ["ui", "queue", "tests"],
        updatedAt: "2026-09-04T11:30:00.000Z",
        createdAt: "2026-09-01T10:00:00.000Z",
      },
      live,
    ),
    row({
      id: "t-gate",
      identifier: "STA-3",
      title: "Approve the schema change",
      parentId: "epic-order",
      // `isGateParked` is `awaiting_approval` AND an active gate — both halves, always.
      // A pending gate on a `todo` row is not a parked row, it is an inconsistent payload.
      status: "awaiting_approval",
      priority: "high",
      updatedAt: "2026-09-04T08:00:00.000Z",
      createdAt: "2026-09-01T11:00:00.000Z",
    }),
    row(
      {
        id: "t-stale",
        identifier: "STA-4",
        title: "Zulu — the abandoned one",
        parentId: "epic-order",
        status: "in_progress",
        priority: "medium",
        assignee: "opus-gone",
        checkoutAgent: "opus-gone",
        updatedAt: "2026-09-04T06:00:00.000Z",
        createdAt: "2026-09-01T12:00:00.000Z",
      },
      stale,
    ),
    row({
      id: "epic-cold",
      identifier: "STA-5",
      title: "Backlog epic",
      kind: "epic",
      status: "backlog",
      priority: "low",
      updatedAt: "2026-09-03T09:00:00.000Z",
      createdAt: "2026-09-02T09:00:00.000Z",
    }),
    row({
      id: "t-cold",
      identifier: "STA-6",
      title: "Alpha — later work",
      parentId: "epic-cold",
      status: "backlog",
      priority: "low",
      // The two children of the folded epic carry estimates, so its rollup has a PLAN to
      // print beside the bar — the one element §14 drops with a utility class rather than
      // a rule in the sheet, and therefore the one the responsive test can read.
      estimatedSeconds: 3600,
      updatedAt: "2026-09-03T08:00:00.000Z",
      createdAt: "2026-09-02T10:00:00.000Z",
    }),
    row({
      id: "t-research",
      identifier: "STA-7",
      title: "Measure the poll cost",
      kind: CUSTOM_KIND,
      parentId: "epic-cold",
      status: "todo",
      priority: "medium",
      estimatedSeconds: 7200,
      updatedAt: "2026-09-03T07:00:00.000Z",
      createdAt: "2026-09-02T11:00:00.000Z",
    }),
    row({
      id: "t-loner",
      identifier: "STA-8",
      title: "Write the responsive pass",
      status: "todo",
      priority: "high",
      updatedAt: "2026-09-04T10:00:00.000Z",
      createdAt: "2026-09-02T12:00:00.000Z",
    }),
    row({
      id: "t-done",
      identifier: "STA-9",
      title: "Land the sort registry",
      parentId: "epic-order",
      status: "done",
      priority: "medium",
      updatedAt: "2026-09-02T09:00:00.000Z",
      createdAt: "2026-09-01T13:00:00.000Z",
      completedAt: "2026-09-02T09:00:00.000Z",
    }),
  ];
}

/** The milestone as the filter menu and the chip strip need it. */
export function driftMilestones(): MilestoneFacts[] {
  return [
    {
      identifier: MILESTONE.identifier,
      title: MILESTONE.title,
      memberCount: MILESTONE.members.length,
      members: [...MILESTONE.members],
    },
  ];
}

/** Milestone identifier -> title, as `TreeView` derives it from the filter context. */
export function driftMilestoneTitles(): Map<string, string> {
  return new Map([[MILESTONE.identifier, MILESTONE.title]]);
}

function entry(over: Partial<QueueEntry> & { identifier: string; planPosition: number }): QueueEntry {
  return {
    issueId: `id-${over.identifier}`,
    title: `${over.identifier} title`,
    kind: "task",
    status: "todo",
    rank: over.planPosition * 1024,
    parent: null,
    resolved: false,
    addedBy: "vp",
    addedAt: "2026-09-03T09:00:00.000Z",
    note: null,
    ...over,
  };
}

function effective(
  over: Partial<EffectiveQueueRow> & { identifier: string; position: number },
): EffectiveQueueRow {
  return {
    issueId: `id-${over.identifier}`,
    title: `${over.identifier} title`,
    kind: "task",
    status: "todo",
    planPosition: null,
    via: null,
    unqueued: false,
    eligibility: "eligible",
    reason: null,
    detail: null,
    dueAt: null,
    milestonePath: [],
    epicPath: [],
    parent: null,
    ...over,
  };
}

/**
 * `GET /api/queue` for this board.
 *
 * THE PLAN: the epic, then the loner, then the research task. THE EFFECTIVE ORDER: the
 * epic expanded in place into its three open children, then the loner, then the research
 * task, then the unqueued band. Which makes every cue state except `waiting` present on
 * one board:
 *
 *   STA-2 claimed -> in flight     STA-3 gated -> gated        STA-4 claimed -> in flight
 *   STA-8 first eligible -> PICKABLE ("next")                  STA-7 eligible -> queued #5
 *   STA-6 unqueued band -> unqueued                            STA-9 resolved -> no cue
 *   STA-1 container, own plan row -> queued, plan #1
 *   STA-5 container, NO plan row -> queued, plan #3, derived from STA-7 beneath it
 *
 * `waiting` is absent because a blocked row needs `deps`, which `/api/issues` sends and the
 * queue does not decide; `row-cues.test.ts` already pins that state directly from the
 * resolver's `blocked` eligibility, and adding a tenth row here to restate it would make
 * every count in every test one larger for no new seam.
 */
export function driftQueue(): QueueView {
  return {
    revision: 12,
    entries: [
      entry({ identifier: "STA-1", issueId: "epic-order", kind: "epic", planPosition: 1 }),
      entry({ identifier: "STA-8", issueId: "t-loner", planPosition: 2 }),
      entry({ identifier: "STA-7", issueId: "t-research", kind: CUSTOM_KIND, planPosition: 3 }),
    ],
    effective: [
      effective({
        identifier: "STA-2",
        issueId: "t-live",
        position: 1,
        planPosition: 1,
        via: "STA-1",
        epicPath: ["STA-1"],
        milestonePath: [MILESTONE.identifier],
        status: "in_progress",
        eligibility: "claimed",
        reason: "held by opus-r4c",
      }),
      effective({
        identifier: "STA-3",
        issueId: "t-gate",
        position: 2,
        planPosition: 1,
        via: "STA-1",
        epicPath: ["STA-1"],
        status: "awaiting_approval",
        eligibility: "gated",
        reason: "awaiting VP on STA-3",
      }),
      effective({
        identifier: "STA-4",
        issueId: "t-stale",
        position: 3,
        planPosition: 1,
        via: "STA-1",
        epicPath: ["STA-1"],
        status: "in_progress",
        eligibility: "claimed",
        reason: "held by opus-gone, idle 2h",
      }),
      effective({ identifier: "STA-8", issueId: "t-loner", position: 4, planPosition: 2 }),
      effective({
        identifier: "STA-7",
        issueId: "t-research",
        kind: CUSTOM_KIND,
        position: 5,
        planPosition: 3,
        epicPath: ["STA-5"],
        milestonePath: [MILESTONE.identifier],
      }),
      effective({
        identifier: "STA-6",
        issueId: "t-cold",
        position: 6,
        status: "backlog",
        unqueued: true,
        epicPath: ["STA-5"],
      }),
    ],
  };
}

/** What every row's cue should say, as the ONE table the other files assert against. */
export const EXPECTED_CUES: Readonly<
  Record<string, { state: string; position: number | null; scope: "effective" | "plan" }>
> = {
  "STA-1": { state: "queued", position: 1, scope: "plan" },
  "STA-2": { state: "in_flight", position: null, scope: "effective" },
  "STA-3": { state: "gated", position: null, scope: "effective" },
  "STA-4": { state: "in_flight", position: null, scope: "effective" },
  "STA-5": { state: "queued", position: 3, scope: "plan" },
  "STA-6": { state: "unqueued", position: null, scope: "effective" },
  "STA-7": { state: "queued", position: 5, scope: "effective" },
  "STA-8": { state: "pickable", position: 4, scope: "effective" },
};

function inboxIssue(over: Partial<InboxIssue> & { id: string; identifier: string }): InboxIssue {
  const { unresolvedBlockers = [], derivedBlockers = [], ...rest } = over;
  // `InboxIssue extends Issue`, so the entity half comes from the SHARED builder rather
  // than from a second hand-written literal that could drift from it.
  return { ...issue(rest), claim: null, unresolvedBlockers, derivedBlockers };
}

/**
 * `GET /api/inbox` for the same board — what the pickup AXIS reads. A different endpoint
 * from the queue and a different question ("what is ready" rather than "what is the plan"),
 * so it is stated separately rather than derived, exactly as the app keeps them separate.
 *
 * `ready` is the loner and the research task; the gated child goes in `queued`, which the
 * index ranks and never marks ready; nothing is blocked, so Waiting stays empty and the
 * board's five sections are Up next, In flight, Pending approval and (with resolved shown)
 * Done / Cancelled.
 */
export function driftInbox(): InboxRow[] {
  return [
    {
      workspace: "staple",
      inbox: {
        ready: [
          inboxIssue({ id: "t-loner", identifier: "STA-8", priority: "high" }),
          inboxIssue({ id: "t-research", identifier: "STA-7", kind: CUSTOM_KIND, parentId: "epic-cold" }),
          inboxIssue({ id: "t-live", identifier: "STA-2", status: "in_progress", parentId: "epic-order" }),
          inboxIssue({ id: "t-stale", identifier: "STA-4", status: "in_progress", parentId: "epic-order" }),
        ],
        queued: [inboxIssue({ id: "t-gate", identifier: "STA-3", parentId: "epic-order" })],
        blocked: [],
        hasMore: false,
      },
    },
  ];
}

/**
 * THE GATE SIBLINGS, applied to the board.
 *
 * `gate`/`queuedBy` are siblings of `issue` on the wire and the pickup axis reads them
 * through `lib/derived-queued.ts` rather than through the inbox index — that file argues
 * why at length. So the gated child has to carry one, and it is applied here rather than in
 * `driftRows` so that a test which wants the board WITHOUT a gate (the plain grouping cases)
 * can have it.
 */
export function withGate(rows: IssueRow[]): IssueRow[] {
  return rows.map((r) =>
    r.issue.id === "t-gate"
      ? {
          ...r,
          gate: {
            state: "pending",
            owner: "vp",
            requestedBy: "opus-r4c",
            requestedAt: "2026-09-04T08:00:00.000Z",
            resolvedBy: null,
            resolvedAt: null,
          },
        }
      : r,
  );
}
