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
(`store.plan()`); links are `src/core/plan-links.ts`; the surfaces are `src/commands/plan.ts`
(CLI), the plan tools in `src/mcp.ts`, the `/api/plan` routes in `src/ui/server.ts` and
`src/ui/app/src/views/plan/`.

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

**Planning is on** once a horizon carries a plan rank (`WorkspaceStore.planningOn`). Only the
plan layer writes one, it synchronizes as data, and no setting can switch it. Every guard below
applies only while planning is on, so a workspace that already used `idea` or `horizon` as a
kind of its own keeps every such issue a tracker issue after upgrading.

**Turning planning on.** `staple plan enable` (and "Turn on planning" in the web UI) adds the
two kinds when they are missing and seeds Now, Next and Later. While any issue already has kind
`idea` or `horizon`, it is refused with `validation` naming those issues: they are someone's
work, and planning would take them out of every task view. Re-kind them, then turn planning on.
Every plan write before then is refused with `validation` naming the command
(`PLAN_KINDS_MISSING_MESSAGE`).

## Storage: seven columns on `issues`, one table for links, no new entity

What an issue cannot already say lives in seven nullable `issues` columns added by workspace
migration **020** (`020-plan-fields.ts`), meaningful on the plan kinds only and NULL on every
other row, and one table, `plan_links`.

| column | on | meaning |
|---|---|---|
| `plan_maturity` | idea | `raw`, `exploring`, `shaped` or `dropped` |
| `plan_horizon_id` | idea | the horizon it is scheduled into, or NULL |
| `plan_start`, `plan_target` | idea | the planned window, `YYYY-MM-DD` |
| `plan_target` | horizon | the horizon's date, or NULL |
| `plan_baseline_start`, `plan_baseline_target` | idea | the window kept when it was started |
| `plan_rank` | both | order of horizons, and of ideas in a column; a ranked horizon means planning is on |

The brief, open questions and decisions are documents on the idea (`brief`, `questions`,
`decisions`), so they are revisioned and synchronize as documents already do.

**Why no protocol bump and no Worker change.** A new *entity* needs a protocol integer
([sync.md](sync.md#protocol-evolution)): attempts took 3 and attachments 4. These are new
*fields* on existing entities, which is additive within a protocol version:

- the columns are listed in `ISSUE_FIELDS`, so the row diff journals them, the applier writes
  them, the seed and snapshot carry them, and conflict detection compares them, all through
  the generic issue path;
- the Worker validates only entity names, verbs and that a payload is an object
  (`worker/src/envelope.ts`); it stores and folds payload fields verbatim, as it already does
  for `derivedStatus` (migration 017) and the revision's `instructions` (migration 019).

The plan fields are left out of an issue's *create* while they are null (`PLAN_ISSUE_FIELDS`,
`nullOmittedOnInsert`), so a task's create carries exactly the fields it carried before; an
absent key on a create reads as NULL, the column default.

**What an older build does.** A device that has not migrated refuses a pulled operation page
stamped schema 20 with `schema_ahead`. The snapshot route checks the protocol only, not the
schema, so an older build that hydrates from a snapshot drops these fields and links rather
than refusing. Mixed old and new builds on one repository are out of scope for the plan layer:
upgrade every device before planning.

## Links: one row, and one synced field, per link

`plan_links (idea_id, issue_id, linked_by, linked_at)` holds one row per link. On the wire each
link is one field of the idea's `milestone` entity, `planLink.<issue id>`, whose value is
`{ linkedBy, linkedAt }` and whose `null` unlinks. That is the shape criterion marks already
use (`criterion<n>`, [milestones.md](milestones.md#goal)): the service folds the entity's keys
one by one, so two devices linking different work to one idea write two fields and both
arrive, with no conflict and no person needed. Unlinking one issue while another device links
a different one converges the same way. Linking and unlinking the *same* issue on two devices
is one field and a genuine disagreement, preserved as a conflict like any other. The apply,
seed, snapshot comparison, conflict, rewind and quarantine paths read the link fields wherever
they read criterion marks; an idea that holds only links is seeded as its link fields alone, so
no milestone row is ever written for it.

**Why not `relations`.** The `relation` entity is keyed by the blocked issue and carries its
whole `blockedBy` set as one field, so two devices editing one set conflict; a new relation
type would have had the same problem as a single JSON field on the idea.

**A link whose issue is gone** (a rewind removed it): `issue_id` has no foreign key, so the row
stays. The idea keeps counting it, so its stage does not slip back to a maturity it had left;
shipped is judged on the linked work that is present. The detail lists it as missing, and
`unlink` accepts its bare id.

## Guards: a plan never enters the tracker

While planning is on:

| guard | where | pinned by (`test/store-plan.test.ts`) |
|---|---|---|
| never queued: `enqueue` refuses with `validation` | `QueueStore.enqueue` | *is never queued* |
| never checked out | `WorkspaceStore.checkoutIssue` | *is never checked out* |
| never an effective row, so never `queue next` or `next_task` | `QueueStore.nodes` | *is never emitted by the resolver even when another device's plan holds it* |
| never counted by a non-plan parent's derived status; plans derive nothing | `derivationInputRows` | *is never counted in a non-idea parent's derived status* |
| never listed by `listIssues` (Tasks, board, inbox, `list_tasks`) unless asked by kind | `issuesQuery` | *is never listed in a task view by default* |
| never in the tree | `WorkspaceStore.tree` | same |
| an idea's parent is an idea; a horizon has none; tracker work never sits under a plan | `assertPlanParent` in `createIssue` | *keeps tracker work and plans apart…* |
| no re-kind across the plan boundary, in either direction | `assertPlanRekind` in `updateIssue` | same |
| never a milestone member | `MilestoneStore.addMember` | same |
| never gated | `gateIssue` | *refuses a gate on an idea* |
| never a blocker and never blocked | `assertNoPlanDependency` in `setBlockedBy` and `createIssue` | *refuses an idea as a blocker…* |
| the kinds go only when nothing uses them | `removeKind` | *keeps tracker work and plans apart…* |

Every guard was checked by removing it and running the suite: each removal fails the test
named above. The resolver, derivation and listing guards hold even for shapes the local
guards refuse but another device could deliver (an idea in `queue_entries`, an idea under a
task), which is why those tests write the shape directly. While planning is off, none applies
(*a workspace that already had its own idea kind*).

## Who steers: agents capture, the person decides

An agent may capture raw ideas (title, brief, parent), edit titles and briefs, add and resolve
questions, add decisions, and adopt or unlink work. Maturity, horizon assignment, parent,
planned dates, order, horizon definitions and dates, and the baseline are the person's.

The distinction is the one the tracker already uses for gate decisions: a write carries a
`PersonDecision` or it does not (the view decisions `approve_gate_from_view` and
`request_changes_from_view` set it). The store cannot tell a person from an agent and does not
try; the flag is the distinction. Three surfaces set it:

- the web UI, for every plan write (`via: "plan_view"`): the page is the person;
- the CLI with `--person`, recorded under the machine's configured `humanName` and refused
  when none is set (`via: "cli"`);
- `reset_idea_baseline`, the Reset baseline button in an MCP view, under `humanName`
  (`via: "mcp_view"`). It is marked app-only, which asks hosts to keep it from the model; that
  is a hint, not a guarantee. The person decision is what permits the write.

Model-visible plan tools and the CLI without `--person` never set it, and a steering write
without it is refused with `validation` (`steeringRefusal`) saying what an agent may do
instead. `update_idea` accepts the steering fields only so that the refusal can explain itself.
**Start from an agent** is allowed only on an idea the person has marked `shaped`.

**The tracker's own writes hold the same line.** `create_task`/`staple new` and
`update_task`/`staple set` reach the store's `createIssue` and `updateIssue`, which carry no
person, so while planning is on: a horizon cannot be created there; a horizon cannot be edited
there at all (name, status or any field); an idea's status never moves there (maturity is its
state; dropping it is the person's, in the Plan view); and an idea made there is captured raw
at the end of the plan, as `capture_idea` would make it. The plan layer's own writes pass
`PlanInternal` after applying the person rule. Pinned in *the tracker's own writes follow the
person rule*, and on MCP in `test/plan-surfaces.test.ts`.

## Derived, never stored

| fact | rule |
|---|---|
| stage | `started` when it links work (its own or a sub-idea's), `shipped` when every linked issue present is resolved, `dropped`, `scheduled` when it has a horizon, otherwise its maturity (`deriveStage`) |
| progress | done leaves over counted leaves of the linked work, each leaf once, cancelled leaves not counted |
| actual window | the first `started_at` anywhere under the linked work (an epic whose own start is null reads its children's) to the last `completed_at`/`cancelled_at` once all are resolved; work nobody started draws no actual window |
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

## Surfaces

- **CLI** `staple plan enable|show`, `staple idea ls|new|show|set|start|adopt|unlink|ask|resolve|decide|reset-baseline`,
  `staple horizon ls|new|set|mv|rm`, with `--person` for steering.
- **MCP** `list_ideas`, `get_idea`, `list_horizons` (reads); `capture_idea`, `update_idea`,
  `start_idea` (link or spawn: `adopt` links an existing issue, otherwise an epic is created
  with the brief as its `plan` document), `unlink_idea`; `reset_idea_baseline` (a view button).
- **HTTP** `GET /api/plan`, `GET /api/plan-idea?ref=`; `POST /api/plan/{enable, capture, update, question, resolve, decision, start, adopt, unlink, reset-baseline, horizon-create, horizon-update, horizon-remove}`.
  Every write answers `{ plan, idea }`.
- **Web UI** the Plan view ([web-ui.md](web-ui.md)): Ideas (columns by maturity, capture),
  Horizons (Unscheduled and each horizon), Timeline (planned, baseline and actual windows on a
  month axis, today and horizon lines, drag to move and resize), and an idea detail panel. A
  sub-idea in its parent's column folds under the parent's card; one in another column shows
  there, labelled with its parent. Below 768px the boards are one column with a switcher and
  the timeline scrolls inside its own frame with the names pinned, each up to three lines.

## What the tests prove

| test | proves |
|---|---|
| `test/store-plan.test.ts` | enabling and its refusal, every guard, the tracker's own writes, dependencies, nesting and stage, horizons, documents, Start/Adopt/Unlink, missing links, actual windows on real-shaped data, late vs not started, the baseline, every steering refusal |
| `test/cloud-plan-sync.test.ts` | the plan converges across devices under both folds; two offline adopts both arrive; an unlink racing an adopt converges; neither raises a conflict |
| `test/sync-mutation-convergence.test.ts` | every `PlanStore` mutation converges column for column |
| `test/plan-surfaces.test.ts` | CLI, MCP and HTTP read one plan, refuse the same agent writes (plain tracker tools included), and let the person steer |
| `src/ui/app/src/views/plan/plan-model.test.ts` | board columns and nesting, the Ideas lens, the late/not-started split, timeline groups, range and dragging |
