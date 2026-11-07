# The plan layer: ideas, horizons and the timeline

The contract behind the Plan view, for people working on staple. The user guide is [docs/plan.md](../docs/plan.md).

Tickets are for doing. The plan layer is for deciding what to do and when, without putting
undecided work in the task list. It has three things:

- an **idea**, which has a *maturity* (`raw`, `exploring`, `shaped`, or `dropped`), a brief,
  open questions, decisions, an optional parent idea, and an optional planned window;
- a **horizon**, an ordered bucket such as Now, Next or Later, which may carry a date and so
  become a release line;
- **links** from an idea to tracker work, made by **Start** (create an epic) or **Adopt**
  (link an existing issue). This is the only door from the plan into the tracker.

Maturity and horizon are independent. "Shaped, no horizon" is a feature whose timing is open;
"exploring, on Next" is a reserved slot whose scope is open. Both are valid.

The pure rules live in `src/core/plan.ts`; the store half is `src/core/plan-store.ts`
(`store.plan()`); the surfaces are `src/commands/plan.ts` (CLI), the plan tools in
`src/mcp.ts`, the `/api/plan` routes in `src/ui/server.ts` and `src/ui/app/src/views/plan/`.

## Identity: issues of two reserved kinds

An idea **is an issue** of the reserved kind `idea`, and a horizon is an issue of the reserved
kind `horizon`, exactly as a milestone is an issue of the kind `milestone`
([milestones.md](milestones.md#identity-an-issue-of-the-milestone-kind)). Title, description,
parent, documents, comments, events and sync come from the issue. Together they are the
*plan kinds* (`PLAN_KINDS`, `isPlanKind`).

A horizon is an issue rather than a `setting:*` value because each horizon then changes on its
own: renaming one and dating another on two devices are two field writes on two entities, not
two whole-list writes on one setting where the later one wins. Its name is the issue's title.
Issues are never deleted, so removing a horizon moves it to the workspace's cancelled status
and unschedules its ideas; a cancelled horizon is not listed.

**Turning planning on.** `staple plan enable` (and "Turn on planning" in the web UI) adds the
two kinds when they are missing and seeds Now, Next and Later when no horizon exists. Without
both kinds every plan write is refused with `validation` naming that command
(`PLAN_KINDS_MISSING_MESSAGE`). Unlike `milestone`, enabling also seeds rows: a plan without
horizons has no Horizons lens to drag into, and the seeding happens only on the explicit
request.

## Storage: eight columns on `issues`, no new entity

What an issue cannot already say lives in eight nullable `issues` columns added by workspace
migration **020** (`020-plan-fields.ts`). They are meaningful on the plan kinds only and NULL
on every other row.

| column | on | meaning |
|---|---|---|
| `plan_maturity` | idea | `raw`, `exploring`, `shaped` or `dropped` |
| `plan_horizon_id` | idea | the horizon it is scheduled into, or NULL |
| `plan_start`, `plan_target` | idea | the planned window, `YYYY-MM-DD` |
| `plan_target` | horizon | the horizon's date, or NULL |
| `plan_baseline_start`, `plan_baseline_target` | idea | the window kept when it was started |
| `plan_rank` | both | order of horizons, and of ideas in a column |
| `plan_links` | idea | JSON array of linked issue ids |

The brief, open questions and decisions are documents on the idea (`brief`, `questions`,
`decisions`), so they are revisioned and synchronize as documents already do.

**Why no protocol bump and no Worker change.** A new *entity* needs a protocol integer
([sync.md](sync.md#protocol-evolution)): attempts took 3 and attachments 4. These are new
*fields* on the existing `issue` entity, which is additive within a protocol version:

- they are listed in `ISSUE_FIELDS`, so the row diff journals them, the applier writes them,
  the seed and snapshot carry them, and conflict detection compares them, all through the
  generic issue path with no plan-specific code in `cloud/`;
- the Worker validates only entity names, verbs and that a payload is an object
  (`worker/src/envelope.ts`); it stores and folds payload fields verbatim, as it already does
  for `derivedStatus` (migration 017) and the revision's `instructions` (migration 019);
- a device that has not migrated refuses a page stamped schema 20 with `schema_ahead` rather
  than dropping the fields.

The plan fields are left out of an issue's *create* while they are null (`PLAN_ISSUE_FIELDS`,
`nullOmittedOnInsert`), so a task's create carries exactly the fields it carried before; an
absent key on a create reads as NULL, the column default.

**Why not the other shapes.** `relations` replicates only `blocks` sets (the relation applier
and its `blockedBy` payload), so a new relation type would not travel without new sync code.
`milestone_meta` has a hand-written applier, seed and conflict path per field; the issue path
is generic. Links as a JSON field mean two devices linking different work to one idea offline
is a field conflict, preserved and shown like any other ([sync.md](sync.md#conflicts-are-preserved-never-resolved-silently)),
not a silent merge; linking is rare enough that this is the right trade for v1.

`test/cloud-plan-sync.test.ts` plans on one machine, pulls it on a second, edits there, and
hydrates a third from the snapshot, under both the service fold and the tail fold, and the
plan reads the same on all three. Every `PlanStore` mutation is also in
`test/sync-mutation-convergence.test.ts`, which compares every synchronized column on the
writer, a tail device and a fresh device.

## Guards: a plan never enters the tracker

| guard | where | pinned by (`test/store-plan.test.ts`) |
|---|---|---|
| never queued: `enqueue` refuses with `validation` | `QueueStore.enqueue` | *is never queued* |
| never checked out: refused with `validation` | `WorkspaceStore.checkoutIssue` | *is never checked out* |
| never an effective row, so never `queue next` or `next_task` | `QueueStore.nodes` | *is never emitted by the resolver even when another device's plan holds it* |
| never counted by a non-plan parent's derived status; plans derive nothing | `derivationInputRows` | *is never counted in a non-idea parent's derived status* |
| never listed by `listIssues` (Tasks, board, inbox, `list_tasks`) unless asked by kind | `issuesQuery` | *is never listed in a task view by default* |
| never in the tree | `WorkspaceStore.tree` | same |
| an idea's parent is an idea; a horizon has none; tracker work never sits under a plan | `assertPlanParent` in `createIssue` | *keeps tracker work and plans apart…* |
| no re-kind across the plan boundary, in either direction | `assertPlanRekind` in `updateIssue` | same |
| never a milestone member | `MilestoneStore.addMember` | same |
| the kinds go only when nothing uses them | `removeKind` | same |

Every guard was checked by removing it and running the suite: each removal fails the test
named above. The resolver, derivation and listing guards hold even for shapes the local
guards refuse but another device could deliver (an idea in `queue_entries`, an idea under a
task), which is why those tests write the shape directly.

## Who steers: agents capture, the person decides

An agent may capture raw ideas (title, brief, parent), edit titles and briefs, add and resolve
questions, add decisions, and adopt or unlink work. Maturity, horizon assignment, parent,
planned dates, order, horizon definitions and dates, and the baseline are the person's.

The distinction is the one the tracker already uses for gate decisions: a write carries a
`PersonDecision` or it does not (the view decisions `approve_gate_from_view` and `request_changes_from_view` set it). The store cannot tell a person
from an agent and does not try; the flag is the distinction. Three surfaces set it:

- the web UI, for every plan write (`via: "plan_view"`): the page is the person;
- the CLI with `--person`, recorded under the machine's configured `humanName` and refused
  when none is set (`via: "cli"`);
- the app-only MCP tool `reset_idea_baseline`, a button in a view that hosts hide from the
  model, under `humanName` (`via: "mcp_view"`).

Model-visible MCP tools and the CLI without `--person` never set it. A steering write without
it is refused with `validation` (`steeringRefusal`) that says what an agent may do instead.
`update_idea` accepts the steering fields only so that the refusal can explain itself.

**Start from an agent** is allowed only on an idea the person has marked `shaped`; a person
may start any idea.

Each refusal is pinned in *agents capture, the person steers*, and each was checked by
removing it. `test/plan-surfaces.test.ts` pins the same refusals on the CLI and over MCP, the
person path on HTTP and `--person`, and that `reset_idea_baseline` is app-only.

## Derived, never stored

| fact | rule |
|---|---|
| stage | `started` when it links work (its own or a sub-idea's), `shipped` when every linked issue is resolved, `dropped`, `scheduled` when it has a horizon, otherwise its maturity (`deriveStage`) |
| progress | done leaves over counted leaves of the linked work, each leaf once, cancelled leaves not counted |
| actual window | first `started_at` in the linked subtrees to the last `completed_at`/`cancelled_at` once all are resolved |
| forecast end | a straight line from the days spent and the share done, while open and partly done |
| late | linked work landed, or is forecast to land, after the earlier of the planned end and the horizon's date, or that day has passed while it is open (`isLate`) |
| not started | nothing linked and the planned start has passed (`isNotStarted`) |
| rollups | a parent idea reads its sub-ideas' links for stage, progress and dates |

Late and not started are separate facts with separate counts, on cards, horizon headers and
the timeline, and never one number. Dates are calendar days in UTC, inclusive, as for
milestones ([milestones.md](milestones.md#dates-calendar-days-utc-inclusive)).

## The baseline

The first planned window an idea has once it is started is kept as its baseline
(`plan_baseline_*`). It is written when an idea becomes started with a window, or when a
started idea gets its first window, and for every started idea above it; a baseline that
exists is never moved by a re-plan. Reset is an explicit, person-only action that copies the
current window. Before an idea is started there is no baseline and moving the window just
moves it. The timeline draws a baseline that differs from the plan as an outline behind it.

Pinned in *the baseline* (each step checked by removal), and through sync in
`test/cloud-plan-sync.test.ts`.

## Surfaces

- **CLI** `staple plan enable|show`, `staple idea ls|new|show|set|start|adopt|unlink|ask|resolve|decide|reset-baseline`,
  `staple horizon ls|new|set|mv|rm`, with `--person` for steering.
- **MCP** `list_ideas`, `get_idea`, `list_horizons` (reads); `capture_idea`, `update_idea`,
  `start_idea` (link or spawn: `adopt` links an existing issue, otherwise an epic is created
  with the brief as its `plan` document), `unlink_idea`; the app-only `reset_idea_baseline`.
- **HTTP** `GET /api/plan`, `GET /api/plan-idea?ref=`; `POST /api/plan/{enable, capture, update, question, resolve, decision, start, adopt, unlink, reset-baseline, horizon-create, horizon-update, horizon-remove}`.
  Every write answers `{ plan, idea }`.
- **Web UI** the Plan view ([web-ui.md](web-ui.md)): Ideas (columns by maturity, capture),
  Horizons (Unscheduled and each horizon), Timeline (planned, baseline and actual windows on a
  month axis, today and horizon lines, drag to move and resize), and an idea detail panel. A
  sub-idea in its parent's column folds under the parent's card; one in another column shows
  there, labelled with its parent. Below 768px the boards are one column with a switcher and
  the timeline scrolls inside its own frame with the names pinned.

## What the tests prove

| test | proves |
|---|---|
| `test/store-plan.test.ts` | enabling, every guard, nesting and stage, horizons, documents, Start/Adopt/Unlink and derived facts, late vs not started, the baseline, every steering refusal |
| `test/cloud-plan-sync.test.ts` | the plan converges across devices under both folds, with no new entity |
| `test/sync-mutation-convergence.test.ts` | every `PlanStore` mutation converges column for column |
| `test/plan-surfaces.test.ts` | CLI, MCP and HTTP read one plan, refuse the same agent writes, and let the person steer |
| `src/ui/app/src/views/plan/plan-model.test.ts` | board columns and nesting, the Ideas lens, the late/not-started split, timeline groups, range and dragging |
