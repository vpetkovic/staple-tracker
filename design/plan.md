# The plan layer: ideas, horizons and the timeline

The contract behind the Plan view, for people working on staple. The user guide is [docs/plan.md](../docs/plan.md).

Tickets are for doing. The plan layer is for deciding what to do and when, without putting
undecided work in the task list. It has three things:

- an **idea**, which has a *maturity* (`raw`, `exploring`, `shaped`, or `dropped`), a brief,
  open questions, decisions, an optional parent idea, and an optional planned window. An idea
  has no ticket number;
- a **horizon**, which is a milestone the plan shows as a column, such as Now, Next or Later.
  A dated horizon is a release line;
- the way into the tracker: **Promote** turns the idea itself into an epic, which takes its
  ticket number then, and **Adopt** links an existing issue to it.

Maturity and horizon are independent. "Shaped, no horizon" is a feature whose timing is open;
"exploring, on Next" is a reserved slot whose scope is open. Both are valid.

The pure rules live in `src/core/plan.ts` and the lifecycle table in `src/core/plan-lifecycle.ts`; the store half is `src/core/plan-store.ts`
(`store.plan()`); links are `src/core/plan-links.ts`; derived membership is
`src/core/plan-members.ts`; the surfaces are `src/commands/plan.ts` (CLI), the plan tools in
`src/mcp.ts`, the `/api/plan` routes in `src/ui/server.ts` and `src/ui/app/src/views/plan/`.

## Identity: ideas are issues, horizons are milestones

An idea **is an issue** of the reserved kind `idea`. Title, description, parent, documents,
comments, files, events and sync come from the issue (`PLAN_KINDS`, `isPlanKind`).

A horizon **is a milestone** ([milestones.md](milestones.md#identity-an-issue-of-the-milestone-kind)):
an issue of the kind `milestone` with a plan rank. The rank is what makes it a column; a
milestone without one (an autopilot milestone, say, or one made with `create_milestone`) is
an ordinary milestone and never appears in the plan. Its name is the milestone's title and its
date is the milestone's target date, so everything a milestone has (progress, state, the queue
expanding it, the goal check) a horizon has too. Issues are never deleted: removing a horizon
cancels the milestone and unschedules its unstarted ideas. It is refused while the horizon
holds open work (planned or placed by hand) or sits in the queue, naming what to move first,
and an edit of a removed horizon is refused before anything is written.

**Only the person removes a horizon.** A horizon is listed by its flag (`LISTED_HORIZON`): a
milestone with a plan rank, unless a person cancelled it, which is what removing does. Its
derived status never hides it, and derivation never cancels it: a horizon derives from its
open and done work only (`deriveHorizonStatus`), so cancelling all its work leaves it planned,
it ships only on work that was done, and reopening the work derives it again. Membership is
rebuilt over the same listed horizons, so no rebuild drops a horizon's rows for its status, and
the outcome does not depend on when rebuilds run.

**Planning is on** once the `idea` and `milestone` kinds exist and a milestone carries a plan
rank (`WorkspaceStore.planningOn`). Only the plan layer writes one, it synchronizes as data,
and no setting can switch it. Every guard below applies only while planning is on, so a
workspace that already used `idea` as a kind of its own keeps every such issue a numbered
tracker issue after upgrading.

**Turning planning on.** `staple plan enable` (and "Turn on planning" in the web UI) adds the
two kinds when they are missing and creates Now, Next and Later as milestones. While any issue
already has kind `idea`, it is refused with `validation` naming those issues: they are someone's
work, and planning would take them out of every task view. Re-kind them, then turn planning on.
Every plan write before then is refused with `validation` naming the command
(`PLAN_KINDS_MISSING_MESSAGE`). Run again where planning is on, `enable` gives any idea an
earlier build numbered its draft identifier (below), and records the number it gave up as an
alias, as every device that applies the move does, so the old number names the idea everywhere.

## Ticket numbers: none until promotion

An idea is stored under a **draft identifier**, `~` and its id's 32 hex digits
(`draftIdentifier`). The `issues.identifier` column stays `NOT NULL UNIQUE`, so nothing about
the issue row changes shape, and the draft:

- is unique, because the id is;
- never parses as a ticket ref (`IDENTIFIER_RE` is `^[A-Z]+-\d+$`), so no ref a person types
  reaches it, and `advanceIssueNumber` ignores it;
- consumes nothing: `createIssue` skips `nextIssueNumber` for an idea while planning is on;
- synchronizes as the identifier field, like any other value of it;
- is never shown. Every surface sends what it prints through one rule in `plan.ts`: the CLI's
  output (every line it prints, `cli.ts`), every MCP tool's answer (`published` in `mcp.ts`)
  and every HTTP answer (`json` in `server.ts`). In JSON an issue whose identifier is a draft
  goes out as `identifier: null, draft: true` (`hideDraftIdentifiers`), and a draft anywhere
  else, a text line, a message or an event, goes out as the idea's id (`draftsAsIds`), which
  is how the CLI, MCP tools and page refer to an idea. `IdeaView.identifier` is `null` until
  promotion, and refusals name an idea by its title (`displayRef`).

**Promotion allocates the number** through the tracker's own counter, on the same row
(`promoteInPlace`): the identifier and the kind change in one journaled `update`, and
`recordIdentifierMove` keeps the draft as an alias. To the sync applier that update is a
*claim* on the number, exactly like a create's ([sync.md](sync.md), `claims.ts`): when two
devices promote two ideas offline and both take the same next number, the log order decides.
The earlier claim keeps it, the later device moves its epic to a stand-in and settles it on the
next number it has, and every device converges on two distinct numbers with no conflict left
open. A third device that reads both claims before the settlement gives the later one the same
stand-in and records it, as it would a create's, so it never shows a promoted epic without a
number (`displaceIdentifierHolder` in `apply.ts`).

**One idea promoted on two devices offline** writes the identifier of one record twice. That
is one field, so the last write in the log is its value, which is what the service's fold
keeps, and every device keeps the same: a device whose own write of it is later than the
arriving one keeps its number and lets the arriving one displace nobody; otherwise the arriving
number is applied as a claim, and the number the record gave up is freed for whatever issue
waits on it. The conflict screen leaves such an `update` to the applier and passes on its place
in the log. Every device, a freshly hydrated one included and under both folds, ends with one
number per record, no number naming two records, and no open conflict
(`test/cloud-plan-promotion-identity.test.ts`). No protocol change and no Worker change: the
identifier is an existing field, the settlement an existing verb, and last-write-wins per field
is what the fold already does.

## Storage: seven columns on `issues`, two tables, no new entity

What an issue cannot already say lives in seven nullable `issues` columns added by workspace
migration **020** (`020-plan-fields.ts`), NULL on every row outside the plan, and two tables:
`plan_links` (synchronized) and `plan_members` (derived on each device, never sent).

| column | on | meaning |
|---|---|---|
| `plan_maturity` | plan record | `raw`, `exploring`, `shaped` or `dropped`; non-null marks a plan record, promoted or not |
| `plan_horizon_id` | plan record | the horizon it is scheduled into, or NULL |
| `plan_start`, `plan_target` | plan record | the planned window, `YYYY-MM-DD` |
| `plan_baseline_start`, `plan_baseline_target` | plan record | the window kept when it was started |
| `plan_rank` | both | order of records, and of horizons; a ranked milestone is a horizon |

A horizon's date is its milestone's `target_date`. The brief, open questions and decisions are
documents on the record (`brief`, `questions`, `decisions`), so they are revisioned and
synchronize as documents already do, and they stay on the epic after promotion.

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
than refusing, and shows every unpromoted idea as an ordinary issue whose identifier is its
`~hex` draft. Mixed old and new builds on one repository are out of scope for the plan layer:
upgrade every device before planning.

## Links: one row, and one synced field, per link

`plan_links (idea_id, issue_id, linked_by, linked_at)` holds one row per link. On the wire each
link is one field of the record's `milestone` entity, `planLink.<issue id>`, whose value is
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

## Membership: derived from the plan, never typed twice

A horizon's members come from its records. A promoted record on horizon H is a member of
milestone H, and so is every issue a record on H links. Moving the record moves its work,
unscheduling it removes the work, and unlinking removes that issue. Nobody adds them by hand.

`plan_members (issue_id, milestone_id, position)` holds the result, rebuilt by one
deterministic function of synchronized facts (`derivePlanMembers`): the listed horizons, each
record's horizon, rank and kind, its links in `linked_at` order, and which issues exist on this
device. Records are walked in plan order with the id breaking ties; an issue is placed once,
first record wins; ideas and milestones are never members. Two devices holding the same facts
hold the same rows. It is rebuilt after every plan write and after every pull, and each
milestone whose membership changed on this device re-derives its status here, after a pull too
(`rederivePlanMilestonesAfterPull`): two devices that moved ideas offline each derived from
their own half, and only the merged membership says what the status is.

Every reader of membership reads `MILESTONE_MEMBERSHIP`, the union of the hand-made
`milestone_members` and `plan_members` for any issue not already in the first: the milestone
view and progress, `milestoneOf`, the queue's expansion of a milestone, status derivation, the
gate holders and the agent instructions. **A member a person put in a milestone by hand stays
where it was put** and wins over the plan.

**Why not write `milestone_members`.** Milestone membership replicates as one ordered list per
milestone, written whole against a base version. Two devices moving ideas between horizons
offline would each rewrite two lists, and the second would land as a conflict for a person to
settle. The derived rows are never journaled or seeded; only the ideas' own fields travel, and
those merge per field.

## Promote, Adopt and Unlink

**Promote** (`PlanStore.promote`) turns the idea into an epic in place (the workspace's `epic`
kind, or its default kind when it has none). It is the same record: its id, documents,
comments, files, events, links, sub-ideas and plan fields stay, and its history shows the
promotion (`idea_promoted`). It takes its ticket number then, it is started from then on, and
its baseline is kept if it has a window. Only a shaped idea offers promotion, to a person or an
agent alike (the lifecycle, below). A sub-idea is promoted only once its parent is, so
an epic always sits under an epic. Once promoted it is an ordinary epic: queued, worked,
renamed and closed as any other, while its plan fields keep it on the board and the timeline.
Breaking it down into tickets is ordinary tracker work.

**Adopt** links an existing issue to a record, promoted or not; **Unlink** removes one link.

## Lifecycle: one table drives every action

Each record is in one lifecycle state, and the state decides which actions it offers
(`plan-lifecycle.ts`). An idea's state is its derived stage, with `scheduled` read as its
maturity: raw, exploring, shaped, started (promoted, or linked to work), shipped, or dropped. A
horizon is planned (no open work), active (it holds open work) or shipped (its milestone is done);
only a person's removal cancels one. A
promoted record is an ordinary epic in the tracker; its plan record reads started or shipped.

| state | offers |
|---|---|
| raw | edit, ask, decide, explore, drop, reparent, reorder |
| exploring | edit, ask, decide, shape, drop, schedule, plan dates, reparent, reorder |
| shaped | edit, ask, decide, back to exploring, drop, schedule, plan dates, reparent, reorder, promote, adopt |
| started | edit, ask, decide, schedule, plan dates, reorder, adopt, unlink, reset baseline, open the epic |
| shipped | adopt (linking more work: landed work keeps it shipped, open work reopens it), open the epic |
| dropped | restore |
| horizon planned | rename, date, reorder, remove (held back while it is queued) |
| horizon active | rename, date, reorder, queue |
| horizon shipped | remove |

So raw is never scheduled or promoted, a started or promoted idea never offers promotion again,
shipped offers no edits (only linking more work), and a horizon is removed only while it holds no
open work and is not queued (a done horizon included), and queued only while it holds open work. Each action also says who may take it: the steering actions (maturity moves,
schedule, dates, order, parent, baseline, every horizon definition) are the person's; the rest
are anyone's. A few preconditions need data and travel with the offer as a `disabledReason`:
unlinking needs a link, a sub-idea is promoted after its parent, the epic opens once promoted.

**Every surface derives from the table.** `PlanStore` checks it first on every write and refuses
with `validation` naming the state, the refused action and what the state offers, before the
person rule; the tracker's own edit of an idea's title or description, and queueing a horizon,
ask the same table. Every plan payload carries each record's `state` and `actions` (id, label,
who, disabledReason), so `get_idea`, `list_ideas`, `list_horizons` and `staple idea show`
("offers") read it, and the page renders from it: `plain-actions.ts` (`planActionItems`,
`horizonActionItems`, `moveOffered`) turns exactly those offers into the drawer's buttons, the
card's ⋯ menu, the board's drops and the timeline's drags; it names which action a board move
is, never whether it is allowed. `test/plan-lifecycle-surfaces.test.ts` walks every (state,
write) cell on HTTP, MCP and the CLI with and without `--person`, and every horizon (state,
action) cell, and checks that every payload carries exactly the table's row.

## The drawer: ideas and horizons open where issues do

An idea opens in the shared detail drawer (`detail/IssueDetailPanel.tsx`), as every issue does.
The tab registry (`detail/tabs/registry.ts`) chooses the strip by kind and state through
`available`: an unpromoted idea gets **Plan** (in place of Details: stage, maturity, horizon,
parent, planned and actual windows, brief, questions, decisions, sub-ideas, linked work),
**Connections** (parent, sub-ideas, horizon, linked work), Documents, Files, Activity, **For
agents** (the `get_idea` payload) and **Time** (planned against actual against baseline). Its
header shows the title, an "Idea · state" chip and a sentence, never a ticket number: the
detail arrives through the shared serialization seam with `identifier: null, draft: true`, and the
page addresses the record by its id (`getIssue`). Each editor in the Plan tab renders only when the state offers
its action. Once promoted, the same record is an epic and gets the epic's strip, with the Plan
tab kept for the plan actions its state still offers. A horizon opens as the milestone it is,
with its state, its offered actions and the ideas on it above the milestone's own parts; its due
date is written through the plan, as the person.

## Guards: an idea never enters the tracker

While planning is on, for an idea that is not promoted (a promoted one is an ordinary epic):

| guard | where | pinned by (`test/store-plan.test.ts`) |
|---|---|---|
| never queued: `enqueue` refuses with `validation` | `QueueStore.enqueue` | *is never queued* |
| never checked out | `WorkspaceStore.checkoutIssue` | *is never checked out* |
| never an effective row, so never `queue next` or `next_task` | `QueueStore.nodes` | *is never emitted by the resolver even when another device's plan holds it* |
| never counted by a non-idea parent's derived status; ideas derive nothing | `derivationInputRows` | *is never counted in a non-idea parent's derived status* |
| never listed by `listIssues` (Tasks, board, inbox, `list_tasks`) unless asked by kind | `issuesQuery` | *is never listed in a task view by default* |
| never in the tree | `WorkspaceStore.tree` | same |
| an idea's parent is a plan record; tracker work never sits under an idea | `assertPlanParent` in `createIssue` | *keeps tracker work and plans apart…* |
| no re-kind across the idea boundary, in either direction, except by promotion | `assertPlanRekind` in `updateIssue` | same |
| never a milestone member, by hand or derived | `MilestoneStore.addMember`, `derivePlanMembers` | same, and *membership…* |
| never gated | `gateIssue` | *refuses a gate on an idea* |
| never a blocker and never blocked | `assertNoPlanDependency` in `setBlockedBy` and `createIssue` | *refuses an idea as a blocker…* |
| the kind goes only when nothing uses it | `removeKind` | *keeps tracker work and plans apart…* |
| no ticket number, never shown | `createIssue`, `displayRef`, `IdeaView.identifier`; on every surface `hideDraftIdentifiers` and `draftsAsIds` | *identity…*; on the surfaces `test/plan-surfaces.test.ts`, *no surface shows…* |

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
**Promote from an agent** is allowed only on an idea the person has marked `shaped`.

**The tracker's own writes hold the same line.** `create_task`/`staple new`,
`update_task`/`staple set` and `update_milestone` reach the store's `createIssue`,
`updateIssue` and `MilestoneStore.update`, which carry no person, so while planning is on: a
horizon cannot be edited there at all (name, status, dates or any field); a milestone made
there is an ordinary milestone, never a column; an idea's status never moves there (maturity is
its state; dropping it is the person's, in the Plan view); and an idea made there is captured
raw, numberless, at the end of the plan, as `capture_idea` would make it. The plan layer's own
writes pass `PlanInternal` after applying the person rule. Pinned in *the tracker's own writes
follow the person rule*, and on MCP in `test/plan-surfaces.test.ts`.

## Derived, never stored

| fact | rule |
|---|---|
| stage | `started` when it is promoted or links work (its own or a sub-idea's), `shipped` when every issue it stands for that is present is resolved, `dropped`, `scheduled` when it has a horizon, otherwise its maturity (`deriveStage`) |
| progress | done leaves over counted leaves of the record's work (itself once promoted, its links, its sub-records'), each leaf once, cancelled leaves not counted |
| actual window | the first `started_at` anywhere under that work (an epic whose own start is null reads its children's) to the last `completed_at`/`cancelled_at` once all are resolved; work nobody started draws no actual window |
| forecast end | a straight line from the days spent and the share done, while open and partly done |
| late | the work landed, or is forecast to land, after the earlier of the planned end and the horizon's date, or that day has passed while it is open (`isLate`) |
| not started | nothing linked or promoted and the planned start has passed (`isNotStarted`) |
| rollups | a parent record reads its sub-records' work for stage, progress and dates |
| horizon shipped | its milestone's derived status is done, derived from its open and done work only (cancelled work is not counted, so a horizon never derives to cancelled) |
| membership | `plan_members`, above |

Late and not started are separate facts with separate counts, on cards, horizon headers and
the timeline, and never one number. Dates are calendar days in UTC, inclusive, as for
milestones ([milestones.md](milestones.md#dates-calendar-days-utc-inclusive)).

## The baseline

The first planned window a record has once it is started is kept as its baseline
(`plan_baseline_*`). It is written when a record becomes started with a window (promoted, or
linked to work), or when a started record gets its first window, and for every started record
above it; a baseline that exists is never moved by a re-plan. Reset is an explicit,
person-only action that copies the current window. Before a record is started there is no
baseline and moving the window just moves it. The timeline draws a baseline that differs from
the plan as an outline behind it.

## Surfaces

- **CLI** `staple plan enable|show`, `staple idea ls|new|show|set|promote|adopt|unlink|ask|resolve|decide|reset-baseline`,
  `staple horizon ls|new|set|mv|rm`, with `--person` for steering. An idea's ref is its id.
- **MCP** `list_ideas`, `get_idea`, `list_horizons` (reads); `capture_idea`, `update_idea`,
  `start_idea` (promote in place, or with `adopt` link an existing issue; answers the promoted
  `{ id, identifier, kind }` or `null`), `unlink_idea`; `reset_idea_baseline` (a view button).
- **HTTP** `GET /api/plan`, `GET /api/plan-idea?ref=`; `POST /api/plan/{enable, capture, update, question, resolve, decision, promote, adopt, unlink, reset-baseline, horizon-create, horizon-update, horizon-remove, horizon-queue}`.
  Every write answers `{ plan, idea }`. `GET /api/issue` adds `planRecord` and `horizonPlan`.
- **Web UI** the Plan view ([web-ui.md](web-ui.md)): Ideas (columns by maturity, capture),
  Horizons (Unscheduled and each horizon), Timeline (planned, baseline and actual windows on a
  month axis, today and horizon lines, drag to move and resize); a card or a horizon opens in
  the shared drawer. Cards never show a number; a promoted record's detail does. A sub-idea in its
  parent's column folds under the parent's card; one in another column shows there, labelled
  with its parent. Below 768px the boards are one column with a switcher and the timeline
  scrolls inside its own frame with the names pinned, each up to three lines.

## What the tests prove

| test | proves |
|---|---|
| `test/store-plan.test.ts` | enabling and its refusal; identity (no counter consumed, never a ref, never shown, numbered at promotion, earlier builds' numbers drafted); every guard; the tracker's own writes, horizon dates included; dependencies; nesting and stage; horizons as milestones; membership (move, unschedule, unlink, plan order, hand-placed members stay, a promoted record counted, a queued horizon expanding); a horizon's own status (its only work cancelled with and without a rebuild between, reopened; shipped on done work only; an earlier build's derived cancel taken back; removal refused while it holds open work or is queued; an edit of a removed horizon refused before any write); Promote in place, under a promoted parent, refused when dropped or already promoted; Adopt on a promoted record; missing links; actual windows on real-shaped data; late vs not started; the baseline; every steering refusal |
| `test/cloud-plan-sync.test.ts` | under both folds: the plan, its membership and its numbers converge on a tail device and a hydrated one; two offline adopts both arrive; an unlink racing an adopt converges; offline moves on two devices derive the same membership with no conflict and nothing sent for it; two offline promotions end with two distinct numbers, no draft and no open conflict; a third device reading both claims before the settlement shows a recorded stand-in, never a numberless epic; a horizon whose only work is cancelled stays listed on every device and derives again when another device reopens the work; two offline moves re-derive each horizon from the merged membership; an idea an earlier build numbered resolves by its old number on every device |
| `test/cloud-plan-promotion-identity.test.ts` | under both folds: one idea promoted on two devices offline (with a ticket made offline on one, with a third device ahead, with equal counters, whichever device sends first) ends on one number per record on every device and a fresh one, no number on two records, no open conflict |
| `test/sync-mutation-convergence.test.ts` | every `PlanStore` mutation, and `promoteInPlace`, converges column for column |
| `test/plan-surfaces.test.ts` | CLI, MCP and HTTP read one plan with no idea numbers and no draft shown, walk every surface that prints or serializes an issue (CLI text and JSON, MCP tools, HTTP routes, events, refusals) and find no draft, with `identifier: null, draft: true` on every issue object, consume no number at capture, refuse the same agent writes (plain tracker tools and `update_milestone` included), promote into the horizon's milestone, and let the person steer |
| `test/plan-lifecycle.test.ts` | the table itself, pinned: every state's actions, who takes each, how a maturity change is named, how states are read |
| `test/plan-lifecycle-surfaces.test.ts` | every idea (state, write) cell and every horizon (state, action) cell agrees with the lifecycle table on HTTP, MCP and the CLI with and without `--person`; every payload carries exactly the table's row; the page's items are built from it alone |
| `src/ui/app/src/detail/plan-drawer.test.tsx` | an idea's tab strip, the epic's strip once promoted, no ticket number in any presentation, actions exactly as offered, a horizon's section |
| `src/ui/app/src/views/plan/plan-model.test.ts` | board columns and nesting, the Ideas lens, the late/not-started split, timeline groups, range and dragging |
