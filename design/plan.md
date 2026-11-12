# The plan layer: ideas, horizons and the timeline

The contract behind the Plan view, for people working on staple. The user guide is [docs/plan.md](../docs/plan.md).

Tickets are for doing. The plan layer is for deciding what to do and when, without putting
undecided work in the task list. It has three things:

- an **idea**, which has a *maturity* (`raw`, `exploring`, `shaped`, or `dropped`), a brief,
  open questions, decisions, an optional parent idea, and an optional planned window. An idea
  has no ticket number;
- a **horizon**, which is a milestone the plan shows as a column, such as Now or Next.
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

**Planning is experimental** and may change. One synchronized workspace setting,
`features.planning`, defaults false. Only a person changes it in Settings → Experimental
or with `staple settings set features.planning true --person` under their humanName.
Agents read it through `get_setting` and `show_about`; agent `set_setting` refuses.

The UI is the person, and the UI token is the person's. An authenticated HTTP
`/api/settings` request therefore declares a person decision. The CLI's `--person`
declares the configured `humanName`. These declarations use the existing person
model, not a separate authentication boundary: agents are trusted not to impersonate
the person by using that token or `--person`. Agent tools can read `features.planning`
with `get_setting`; they must ask the person to change it.

**Planning is on** when the flag is true AND the existing structural check holds: the
idea and milestone kinds exist and a milestone carries a plan rank. Setting true runs the
existing enable path in the same transaction, including default horizons, legacy-Later
migration and drafting. `staple plan enable --person` is an alias for this same setting.
There is no second switch. Migration 020 runs for every workspace regardless of the flag:
it is additive and nullable; the setting gates behavior, not schema installation.

**Off hides the whole layer and keeps its data.** Plan, its lenses, drawer tabs, palette
actions and Tasks horizon chip/axis/filter disappear. Planning CLI, MCP and HTTP operations
refuse with one validation sentence. `/api/issues` omits horizon fields, and pickup answers
and run briefs omit horizon-run instructions. Horizons appear as plain milestones; promoted
epics are ordinary epics. Ideas remain unnumbered drafts, never task-list or pickup work,
with idea guards active in both states. Re-enabling restores ideas, horizons, sections,
links and run settings without deleting or rewriting their data.

## Unscheduled and optional dates

Unscheduled is the absence of a horizon (`plan_horizon_id = NULL`), not a milestone.
It replaces the old default Later column. New workspaces seed Now and Next only.
Named horizons may still be undated: Now, Next or a person-created Research column describes
an intentional grouping, while Unscheduled means no grouping has been chosen. Requiring dates
would invent deadlines for those groups and complicate the lifecycle without changing delivery.
The same lifecycle, Tasks chip/group/filter, CLI and MCP operations apply with or without a date.
Only **dated horizons** appear in the Milestones list, alongside plain milestones as before.
Clearing a horizon date removes it from that list; it remains in Plan and Tasks grouping.

**Upgrade.** On workspace open, on `plan enable`, and after sync binds its device journal,
`migrateLegacyLater` finds listed, undated horizons named exactly Later. In one journaled
transaction it unschedules every plan record on them, including promoted records, then clears
the old milestone's plan rank. Derived membership rebuilds; hand-placed members, queue position,
goal, history and status remain on the now-plain milestone. Nothing is deleted or cancelled:
keeping the ordinary milestone is what preserves the person's manual commitments. An empty
plain milestone may be removed by the person later. Dated Later horizons are intentional and stay.
The changed `planHorizonId` and `planRank` fields travel through the existing issue journal,
tail and snapshots, with no new schema or protocol. A connected workspace without a device identity defers the upgrade until its journal can send it. Clearing rank makes the upgrade idempotent.

## Returning to Plan

Plan reuses the detail drawer's `DetailTabStrip`, Radix keys and accessibility. The phone uses
its finger-sized segments; the desktop uses its underline strip. There is one implementation.
The last lens, open record, each lens's scroll axes and phone column are per-viewer preferences
under `staple:plan:v1:<workspace>`. Filters use the existing workspace/view preference envelope
and URL state. The shareable `plan-lens` and `issue` parameters take precedence on arrival;
Back/Forward follows the URL, and an explicit drawer close clears the remembered record.
Storage reads, writes and access to the storage getter all fail safe. Search filters the ideas
in every lens. Per-column vertical scrolling is remembered separately from the board frame.

A horizon's drawer and the Milestones detail both link directly to each planned record using
`view=plan&issue=<stable id>`. A promoted epic is the same record and carries an explicit
"Open original idea in Plan" link. On phones the task row's secondary metadata has a quiet
unfilled diamond. Tap reveals the full horizon name and its Open link; the desktop keeps its chip.

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

## Storage: seven columns on `issues`, three tables, no new entity

What an issue cannot already say lives in seven nullable `issues` columns added by workspace
migration **020** (`020-plan-fields.ts`), NULL on every row outside the plan, and three tables:
`plan_links` and `plan_rows` (synchronized, one field per link and per breakdown row) and
`plan_members` (derived on each device, never sent).

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
agent alike (the lifecycle, below), whether or not its parent is promoted. Once promoted it is
an ordinary epic: queued, worked, renamed, documented and closed as any other, in every plan
state, while its plan fields keep it on the board and the timeline. Breaking it down into
tickets is ordinary tracker work.

**A sub-idea promoted before its parent.** The plan's tree is the tracker's: promotion never
moves a record, so the epic's parent is still the idea above it. The tracker reads that epic as
top-level work: `WorkspaceStore.tree` lists it at the root, and an idea derives nothing, so no
status flows into or out of the idea. When the parent is promoted, the same write makes it the
epic above its promoted sub-ideas, and its status is derived from theirs in that transaction
(`rederiveParents`). A sub-idea promoted under a parent that is already promoted is its child
from the start.

**Adopt** links an existing issue to a record, promoted or not; **Unlink** removes one link.

## Plan sections: an idea an agent can build from

An idea is a plan. Besides its brief, open questions and decisions it holds ten sections
(`plan-sections.ts`): **Goal**★, **Context and constraints**, **Decisions**, **Open questions**
(answered, open, or deferred: left open on purpose), **Task breakdown**★, **Acceptance
criteria**★, **Dependencies**, **Out of scope**, **Risks** and **Sources and files**. Text and
list sections are revisioned documents on the record, versioned and synchronized as documents
already are: text sections are markdown, list sections one `- item` per line. Writing a section
is the edit action (anyone's); a write replaces each section it names whole. The detail carries
the sections, a completeness count (★ sections, and all ten), what the shaped gate still needs,
estimate warnings and the breakdown's revision.

Every surface writes sections through one check (`checkPlanPatch`): a text section is text or
null, a list section a list of text, the breakdown a list of rows, and anything else (a string
where a list belongs, an unknown section, a row without a key or a title) is refused by name
before anything is written. A raw document write on a plan record (`put_document`, `staple doc
put`, a restore) is held to the same shapes: the breakdown is not a document and is refused
there, and a list section or the questions checklist must read as the list it holds, so a body
can never read back as fewer items than it was given.

### Task breakdown rows: one synced field per row

The task breakdown is structured: rows `{ id, key, title, estimate, dependsOn, acceptance,
owner, notes }`, because a row's fields become a task's when the idea is scaffolded. `key` is how
rows depend on each other (`42.1`) and may be renamed; `id` is the row's own and never changes.
Rows live in `plan_rows (idea_id, row_id, body, rank)` (`plan-rows.ts`), and on the wire each row
is one field of the record's `milestone` entity, `planRow.<row id>`, whose value is the row with
its rank and whose `null` removes it: the shape links use (above).

Why this shape. With the breakdown as one document, two devices editing two different rows each
wrote a whole new revision, and the log kept one of them as the head: an edit was lost with no
conflict to say so. As one field per row, the service folds the entity's keys one by one, so:

- two devices editing different rows, or each adding a row, write different fields, and both
  edits arrive, with no conflict;
- two devices editing the same row write one field, and that is a conflict recorded like any
  other (`conflict_list` / `conflict_resolve`), never a silent overwrite;
- a write sends only the rows it changed, and a row keeps its rank while the order allows, so an
  edit to one row never rewrites the others.

No protocol bump and no Worker change: these are fields of an existing entity, carried and
folded verbatim. The apply, seed, snapshot comparison, conflict, rewind and quarantine paths read
row fields wherever they read link fields; an idea holding only links and rows is seeded as
those fields alone.

On one device, a breakdown write may name the `breakdownRevision` it read (`breakdownBase`;
`breakdown_base` on MCP); it is refused with `revision_conflict` when the breakdown changed
since, so a stale editor never overwrites a newer edit. The Plan tab and `staple idea task` always
send it. A write without it replaces the breakdown, keeping each row's id: the id it names, else
the stored row with its key, else a new one.

### The shaped gate

An idea is shaped only with a goal; a task breakdown of at least one row, every row titled, no
two rows on one key, no row waiting on a key the breakdown does not hold, and no depends-on cycle;
acceptance criteria; and no open question that is not deferred (`shapedGate`). A row without
its own "done when" inherits the plan's acceptance criteria, so it needs none. A key "the
breakdown does not hold" is one shaped like this plan's keys (`42.9` in a plan of `42.x` rows);
another plan's key (`39.4`) or an outside event waits outside the plan instead. A cycle is named
by its rows (`1 → 2 → 1`). The gate holds on every way to shaped: a maturity change, a capture
straight into shaped, a raw idea shaped in the same write that gives it its plan, and an import
into shaped, where it reads everything the import writes, its open questions included, before
any of it is written. The lifecycle offers Mark shaped held back with what is missing.

**A shaped plan edited since.** Agents may edit a shaped idea's plan, and an edit can leave it
failing the gate: a cleared goal, an emptied breakdown, an added or reopened question, a removed
row, an old revision restored. Its maturity stays: maturity is the person's, and no edit moves it
as a side effect. The record says so instead (`planIncomplete`), shown as "shaped · plan
incomplete" with what it lacks in the drawer, on the card and in the For agents view, and
Scaffold and Promote are held back with that reason and refused at confirm, naming what is
missing.

### Scaffold

**Scaffold** (`PlanStore.scaffold`) is Promote plus the breakdown: the idea promotes in place
into the epic, the epic's `plan` document is composed from the goal, context, decisions,
dependencies, scope, risks and sources, its acceptance criteria are the idea's, and each row
becomes a child task with its estimate, blockers from the rows it depends on, its acceptance, and
a `context` document that makes it workable alone (what the epic is for, done-when, what it waits
on inside and outside the plan, the constraints, scope). A row without its own done-when gives
its task the plan's acceptance criteria, labels it `acceptance-inherited`, and says so in its
context, so whoever takes it sharpens it and removes the label; the plan's row shows it inherits.
Each shaped sub-idea is scaffolded the same way under it. A sub-idea can be scaffolded before its
parent, as it can be promoted before it: its epic is top-level work until the parent is
scaffolded or promoted, and that write files it under the parent's epic (Scaffold promotes
through the same `promoteRecord` as Promote).

**Preview, then confirm.** `scaffoldPreview` computes exactly what the create path writes, and
the create path builds from it. The preview carries the problems that hold the confirm back
(the gate, here and in each sub-idea it carries), warnings (an estimate that is not a duration),
and a fingerprint: a digest of everything it shows. A confirm names that fingerprint, and is
refused without one ("preview first") and when the plan changed since ("the plan changed since
the preview"), on the page, over MCP and on the CLI (`staple idea scaffold <ref>` previews and
prints the confirm; `--confirm <fingerprint>` creates). Only a state that offers Scaffold has a
preview: a raw or exploring idea and a plain task are refused, preview included.

**Task identity: the idea and the row.** A row's task has an id that follows from the idea's id
and the row's (`scaffoldTaskId`, a digest shaped as a UUID). So a retry, a scaffold after rows
were added, a key renamed since, and a second device scaffolding the same idea offline all name
the same task: whatever has a task already is not created again, and two devices that created it
offline sent two creates of one record, which sync merges as it merges any record written on two
devices (identical fields, one number settled as a promotion's is). No scaffold map is kept and
no idempotency key is claimed. Scaffold adds the blockers its rows' depends-on name to a task that
exists, and never removes a blocker someone else set. A started record offers Scaffold again only
if it was scaffolded (a task of one of its rows exists).

**Estimates** read as a plan writes them: `3h`, `3 hours`, `3hrs`, `30m`, `30 mins`, `90s`,
`2h30m`, `1 day`, `2 days`, `1.5d`, `1w`, `~4h`, `2-3h` (its top), a working day of eight hours
and a week of five days. One that does not read is never a silent null: the plan and the preview
show why.

### Import

**Import** (`staple idea import <plan.md>`, `PlanStore.importPlan`) reads a plan file into one
idea, in one transaction: the first heading outside a code fence is the title, the text before
the first section is the brief, and each `##` heading is mapped by its words (Goal, Task or Step
breakdown, Acceptance criteria, Out of scope, Risk, Open questions, Dependencies, Decisions or
ruling, Sources). Headings inside code fences are text. Breakdown tables are read by their header
row whatever their columns, an escaped `\|` inside a cell; a list line like `42.1 — Title` works
too. A list item's wrapped line joins it, and a nested item folds into its parent. Every other
heading lands in Context under its own heading, front matter too. What a section cannot hold
(prose under a list heading, a table row without a key, a key a table already gave) is kept in
Context and reported as a warning: nothing is dropped. What a row waits on outside the plan
becomes a dependency; the file is attached and listed as a source.

## Lifecycle: one table drives every action

Each record is in one lifecycle state, and the state decides which actions it offers
(`plan-lifecycle.ts`). An idea's state is its derived stage, with `scheduled` read as its
maturity: raw, exploring, shaped, started (promoted, or linked to work), shipped, or dropped.

**Its own state against its rollup.** The state reads only the record's own facts: its
maturity, whether it is promoted, and its own links. Its sub-ideas' work is its **rollup**:
progress, the actual window, the forecast and the late and not-started flags read the record's
work and every sub-record's, for the card, the header and the timeline. The rollup never changes
the state or the actions. So a raw parent whose sub-idea is underway stays raw (refined, never
scheduled), a parent whose sub-ideas all shipped can still be shaped and promoted, and a
dropped parent stays dropped and restorable while its sub-ideas carry on. Maturity never
cascades: dropping a parent leaves its sub-ideas' states alone. A
horizon is planned (no open work), active (it holds open work) or shipped (its milestone is done);
only a person's removal cancels one. A
promoted record is an ordinary epic in the tracker; its plan record reads started or shipped,
and it offers the epic's own edits (edit, ask, decide: `PROMOTED_ALWAYS`) in both, so its title
and documents follow epic rules on the plan's surfaces and the tracker's alike.

| state | offers |
|---|---|
| raw | edit, ask, decide, explore, shape, drop, reparent, reorder |
| exploring | edit, ask, decide, shape, drop, schedule, plan dates, reparent, reorder |
| shaped | edit, ask, decide, back to exploring, drop, schedule, plan dates, reparent, reorder, promote, scaffold, adopt |
| started | edit, ask, decide, schedule, plan dates, reorder, scaffold (only if it was scaffolded), adopt, unlink, reset baseline, open the epic |
| shipped | adopt (linking more work: landed work keeps it shipped, open work reopens it), open the epic; a promoted record adds edit, ask, decide |
| dropped | restore |
| horizon planned | rename, date, reorder, run setting, remove (held back while it is queued) |
| horizon active | rename, date, reorder, queue (held back once it is queued), run setting |
| horizon shipped | remove |

So raw is never scheduled or promoted, a started or promoted idea never offers promotion again,
an unpromoted shipped idea offers no edits (only linking more work), and a horizon is removed only while it holds no
open work and is not queued (a done horizon included), queued only while it holds open work, and given its run setting until it ships. Each action also says who may take it: the steering actions (maturity moves,
schedule, dates, order, parent, baseline, every horizon definition) are the person's; the rest
are anyone's. A few preconditions need data and travel with the offer as a `disabledReason`:
unlinking needs a link, the epic opens once promoted.

A maturity change is named from where the record stands (`maturityAction`): the maturity it
already has is no change and succeeds as one, in any state; out of dropped is restoring; to
exploring is going back from shaped and exploring otherwise; to raw is going back to raw, an
action (`back_to_raw`) that no state offers, so its refusal says so in those words.

**Every write on an idea's own content is its edit action.** A document under any key (the
brief, questions, decisions, every plan section, any other), a restore of an old revision, and
adding or removing a file are refused where the idea's state offers no edit, on every surface:
`WorkspaceStore.putDocument`, `attachFile` and `removeFile` ask the table through
`PlanStore.assertEditable`, the same cell and person rule as `update_idea`, so the MCP tools, the
CLI and `/api/action` (`doc_restore`) all inherit it. The plan's own writes have already asked.

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

## Lenses: thinking, delivery, time

The Plan view has three lenses, each with one job (`views/plan/plan-model.ts`). Shaping is the
hand-off between the first two: no record is ever in both.

**Ideas is thinking.** It holds a record in its own raw or exploring state, in those two columns.
A sub-idea still being explored under started work stays (`inIdeasLens` reads the record's own
`state`, never the rollup). Its card shows how much of the plan is written (`★ 2/3 · 6/10
written`, the payload's `completeness`), open questions and the horizon it is aimed at (`◇ Now`),
and nothing about delivery: no progress, no linked count, no late or not started. Marked shaped
(from the card's menu or the Plan tab), it moves to Horizons.

**Horizons is delivery.** One column per horizon, then Unscheduled (*Ready, no horizon yet*),
holding shaped, started and shipped records (`inHorizonsLens`). A card shows where the work
stands, its progress and late or not started; a shaped record whose plan no longer passes the
shaped gate is flagged *plan incomplete*, and its Scaffold is held back (`planIncomplete` reads
the server's missing-plan reasons from the payload). A horizon's header takes every number from the
server, which sees what the cards do not (a member added by hand, a record still being explored
past its planned start): its date, a progress bar (members landed over members held,
`progress`), `✓ n shipped` (`shippedCount`), late (`lateCount`) and not started
(`notStartedCount`), *Waiting for your approval* while its close is gated (`awaitingApproval`),
and two buttons from its offered actions: **Queue**, which queues the horizon exactly as queueing
a task does, held back as *Queued* once it is in the queue, and its **run setting**. The drawer's
horizon section and the timeline's group headers read the same fields, so the three agree. A
horizon is done only when the server says so (`horizonDone`: its milestone is done, or every
member has landed); then its column folds to a ✓ summary that opens on a click.

**A horizon's run setting.** How far agents take the horizon when they pick its work up, and its
goal. It is a setting, like autopilot's, and nothing runs from it: the person sets it in the
horizon's header or drawer (`setHorizonRun`, `POST /api/plan/horizon-run`, `staple horizon set
--run --goal --person`; refused to an agent, as every horizon setting is), and every agent that
takes the horizon's work reads it. The goal is the milestone's own acceptance criteria, now
editable from the plan and the person's on a horizon (`update_milestone` and `update_task` refuse
an agent's edit of them). How far is `plan_run_mode`, one of three, because they are the three
places a run can stop:

| setting | what agents do | how it ends |
|---|---|---|
| `work`: until its work is done | take its work from the queue until every member has landed; nothing beyond it, no goal run | ships itself when its last member lands, as any milestone does |
| `goal`: until its goal is met | a goal run over it works its members, judges each criterion with evidence, and may file the tickets the goal still needs | the run gates the close to the person: the header reads *Waiting for your approval* until they approve it |
| `epic`: stop for review after each epic | work one epic at a time and stop when it lands, leaving the next for the person | each epic is reviewed before the next starts; the horizon ships with its last member |

Unset, agents work it as any milestone. Agents receive it as the `horizon-run` instruction
(`instructions.ts`), on every ticket of the horizon and on the horizon itself, so it arrives
wherever work is picked up: `queue next` / `next_task`, `get_task`, `run continue` /
`continue_run` and the run brief all carry the same instruction list, and the horizon's For agents
view shows it. A goal run over a horizon (`start_run`) is refused unless the horizon is set to
`goal` (`RunStore.assertHorizonRunsToGoal`): a goal run gates the close for a goal check, which a
horizon set to stop at its work or at each epic is not to get. So an agent-run horizon ends where
its setting says, and only a goal-set horizon waits for the person's approval.

**Shipped is one mark** (`detail/ShippedMark.tsx`): a check in the done hue's icon token and the
words, `✓ Shipped Oct 3` or `✓ 4 shipped`, never the colour alone. The card (muted, no progress
bar), the horizon header, the drawer's state chip, status sentence and phases, the horizon
section of a milestone's detail, and the timeline's end-cap on a shipped bar all draw it, and all
read the record's own `state` (a horizon's, the server's `shipped` or `progress`).

A horizon without a run setting is worked through the queue, as any milestone. A goal run is
allowed only after the person explicitly selects the goal mode. Stopping a goal run leaves its
approval gate standing: stopping execution does not approve the goal. The horizon stays open and
reads "Waiting for your approval" until the person approves or requests changes. Work and epic
modes do not create this goal gate. A pending gate takes precedence over a completed progress bar
in the board, drawer and timeline.

**Timeline is time.** Planned, baseline and actual windows as before, a ✓ end-cap where a
record shipped, and an arrow from each record to every record that waits on it. What a record
waits on is the payload's `dependsOn` (`resolveDependencies`), and only an explicit reference
counts: a line of its Dependencies section, or a depends-on cell naming something outside its own
breakdown, that leads with a record's ticket number, a key the record's title leads with (capitals
with a number: `C2 Checkout API` is C2, `R2 · EPIC-40 — Exercise API` is R2 and EPIC-40), or the
key of a row in exactly one other record's breakdown (`42.1`). Everything else is prose, however
many words with digits it holds (`OAuth2`, `S3`). A key two records share names neither, and a
record never waits on itself. An arrow is red when the record waiting starts before the one it
waits on ends.

**Tasks reads the same horizons.** `GET /api/issues` leaves the horizons themselves out of its
rows when planning is on (`PlanStore.horizonIds`): a horizon is not a task, and shows as a section
heading under Group: Horizon and as each row's chip. Plain milestones stay rows. Each row carries
its `horizon` (`PlanStore.horizonsOf`): the milestone the issue is a member of, put there or
derived from the plan, else its nearest ancestor's, when that milestone is a horizon (a horizon is
its own). The row's milestone chip becomes `◇ <horizon>`, in every grouping and on landed work;
below 480px, where the milestone mark is dropped, a compact `◇ Now` chip keeps its own slot and
shows the full name on a tap. **Group: Horizon** sections the list by horizon in the plan's order,
then *No horizon*, without nesting members under their milestone again (`placeForAxis`); and a
**Horizon** filter keeps the work of the horizons asked for ([web-ui.md](web-ui.md)).

**Reading mode.** The brief and every text and list section of the Plan tab read as formatted
Markdown (`lib/markdown.tsx`, which reads quotes, numbered lists, checklists, pipe tables and
emphasis as well as before), with an **Edit** control only where the state offers the edit
action; Edit opens the textarea, a blur saves what changed and Escape puts it back. An empty
section offers to write it where edits are offered and says *Not written* where they are not.

## The drawer: ideas and horizons open where issues do

An idea opens in the shared detail drawer (`detail/IssueDetailPanel.tsx`), as every issue does.
The tab registry (`detail/tabs/registry.ts`) chooses the strip by kind and state through
`available`: an unpromoted idea gets **Plan** (in place of Details: the lifecycle as phases,
Thinking, Started and Shipped, with maturity and horizon as separate facts so being scheduled
never reads as more mature than exploring; the completeness meter; Scaffold's preview and
confirm; horizon, parent, planned and actual windows; the brief; every plan section, the task
breakdown a table on a desk and a tap-to-edit card per row on a phone; questions with defer;
decisions; sub-ideas; linked work),
**Connections** (parent, sub-ideas, horizon, linked work), Documents, Files, Activity, **For
agents** (the `get_idea` payload) and **Time** (planned against actual against baseline). Its
header shows the title, an "Idea · state" chip and a sentence, never a ticket number: the
detail arrives through the shared serialization seam with `identifier: null, draft: true`, and the
page addresses the record by its id (`getIssue`). Each editor in the Plan tab renders only when the state offers
its action, the header's title is read-only where the state offers no edit, and the Documents
tab offers no restore there. The command palette builds an idea's commands from the same offered
actions (`planActionItems`), with its title as the hint, never its id. Once promoted, the same record is an epic and gets the epic's strip, with the Plan
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
| stage | from its own facts only: `started` when it is promoted or links work itself, `shipped` when every issue of its own work that is present is resolved, `dropped`, `scheduled` when it has a horizon, otherwise its maturity (`deriveStage`) |
| progress | done leaves over counted leaves of the record's work (itself once promoted, its links, its sub-records'), each leaf once, cancelled leaves not counted |
| actual window | the first `started_at` anywhere under that work (an epic whose own start is null reads its children's) to the last `completed_at`/`cancelled_at` once all are resolved; work nobody started draws no actual window |
| forecast end | a straight line from the days spent and the share done, while open and partly done |
| late | the work landed, or is forecast to land, after the earlier of the planned end and the horizon's date, or that day has passed while it is open (`isLate`) |
| not started | nothing linked or promoted and the planned start has passed (`isNotStarted`) |
| rollups | a parent record reads its sub-records' work for progress, dates, the forecast and late / not started, which it displays; never for its stage, state or actions |
| horizon shipped | its milestone's derived status is done, derived from its open and done work only (cancelled work is not counted, so a horizon never derives to cancelled) |
| membership | `plan_members`, above |

Late and not started are separate facts with separate counts, on cards, horizon headers and
the timeline, and never one number. Dates are calendar days in UTC, inclusive, as for
milestones ([milestones.md](milestones.md#dates-calendar-days-utc-inclusive)).

### Reads

Every derived fact is read from the plan as it stands, so a read must stay cheap as the plan
grows: the page's server answers every plan write with the whole plan and the record's detail,
on one event loop shared by every request. A record's documents are read by its id in one
statement each, never by resolving a reference, and the records' views are derived once per state
of the database (keyed on the connection's `total_changes()`, SQLite's `data_version` and the
day): a request that checks a state, writes and answers rebuilds them once for its write. The
server holds an idle kept-alive connection for 65 seconds (`KEEP_ALIVE_MS`), well past SQLite's
five-second busy timeout, so a request a client sent on a reused socket while the loop was busy
is read and answered, never reset.

## The baseline

The first planned window a record has once it is started itself is kept as its baseline
(`plan_baseline_*`). It is written when a record becomes started with a window (promoted, or
linked to work), or when a started record gets its first window; a sub-idea's start starts no
baseline above it. A baseline that exists is never moved by a re-plan. Reset is an explicit,
person-only action that copies the current window. Before a record is started there is no
baseline and moving the window just moves it. The timeline draws a baseline that differs from
the plan as an outline behind it.

## Surfaces

- **CLI** `staple plan enable|show`, `staple idea ls|new|show|set|plan|task|promote|scaffold|import|adopt|unlink|ask|resolve|defer|decide|reset-baseline`,
  `staple horizon ls|new|set|mv|rm`, with `--person` for steering. An idea's ref is its id.
- **MCP** `list_ideas`, `get_idea`, `list_horizons` (reads); `capture_idea`, `update_idea`,
  `start_idea` (promote in place, or with `adopt` link an existing issue; answers the promoted
  `{ id, identifier, kind }` or `null`), `unlink_idea`, `scaffold_idea` (preview without
  `confirm`; with it and the preview's `fingerprint`, create); `update_idea` also takes `plan`
  (sections), `breakdown_base` and `defer_question`;
  `reset_idea_baseline` (a view button).
- **HTTP** `GET /api/plan` (each record with `completeness` and `dependsOn`, each horizon with `shippedCount`, `progress`, `runMode`, `goal` and `awaitingApproval`), `GET /api/plan-idea?ref=`, `GET /api/issues` (each row with its `horizon`, horizons themselves left out); `POST /api/plan/{enable, capture, update, question, resolve, decision, promote, scaffold, adopt, unlink, reset-baseline, horizon-create, horizon-update, horizon-remove, horizon-queue, horizon-run}`; `update` and `capture` take `plan`, `update` takes `breakdownBase`, `resolve` takes `deferred`, `scaffold` takes `preview` or the preview's `fingerprint`.
  Every write answers `{ plan, idea }`. `GET /api/issue` adds `planRecord` and `horizonPlan`.
- **Web UI** the Plan view ([web-ui.md](web-ui.md)): Ideas (thinking: raw and exploring,
  capture, completeness on each card), Horizons (delivery: shaped onwards, Unscheduled and each
  horizon, with the server's counts, the shipped mark, Queue and the run setting), Timeline (planned, baseline and actual
  windows on a month axis, today and horizon lines, dependency arrows, a ✓ end-cap, drag to move
  and resize); a card or a horizon opens in the shared drawer. Tasks shows each row's horizon, groups by it and filters by it. Cards never show a number; a promoted record's detail does. A sub-idea in its
  parent's column folds under the parent's card; one in another column shows there, labelled
  with its parent. Below 768px the boards are one column with a switcher and the timeline
  scrolls inside its own frame with the names pinned, each up to three lines.

## What the tests prove

| test | proves |
|---|---|
| `test/store-plan.test.ts` | enabling and its refusal; identity (no counter consumed, never a ref, never shown, numbered at promotion, earlier builds' numbers drafted); every guard; the tracker's own writes, horizon dates included; dependencies; nesting and stage; horizons as milestones; membership (move, unschedule, unlink, plan order, hand-placed members stay, a promoted record counted, a queued horizon expanding); a horizon's own status (its only work cancelled with and without a rebuild between, reopened; shipped on done work only; an earlier build's derived cancel taken back; removal refused while it holds open work or is queued; an edit of a removed horizon refused before any write); Promote in place, under a promoted parent, refused when dropped or already promoted; Adopt on a promoted record; missing links; actual windows on real-shaped data; late vs not started; the baseline; every steering refusal |
| `test/plan-sections.test.ts` | the importer on fixtures shaped like real plan files (lane tables, a step breakdown with other columns, revision notes naming keys, decision subsections, checklists, a risk note): every row kept, sections mapped, nothing dropped, what it cannot place reported; wrapped and nested items, prose under list headings, headings and comments inside code fences, escaped pipes, repeated keys and front matter kept, each said; unknown keys named; sections round-trip through their documents; every estimate form, and why one reads as none; cycles, unknown and repeated keys in the gate; the gate's phrases; completeness |
| `test/plan-scaffold.test.ts` | sections persist as revisions, an agent writes them, duplicate keys refused; the gate on every path to shaped, deferred questions let through; Scaffold creates exactly its preview (epic, plan document, acceptance, tasks with estimate, blockers, acceptance, context), idempotently and for rows added later, nested sub-ideas as child epics (one scaffolded before its parent is filed under it later, created once), never where the lifecycle does not offer it; import with its file attached |
| `test/plan-scaffold-surfaces.test.ts` | the gate on the page, the CLI with `--person` and an agent over MCP; the three Scaffold previews agree and write nothing; a confirm creates once whichever surface retries; CLI import |
| `test/cloud-plan-sync.test.ts` | under both folds: the plan, its membership and its numbers converge on a tail device and a hydrated one; two offline adopts both arrive; an unlink racing an adopt converges; offline moves on two devices derive the same membership with no conflict and nothing sent for it; two offline promotions end with two distinct numbers, no draft and no open conflict; a third device reading both claims before the settlement shows a recorded stand-in, never a numberless epic; a horizon whose only work is cancelled stays listed on every device and derives again when another device reopens the work; two offline moves re-derive each horizon from the merged membership; an idea an earlier build numbered resolves by its old number on every device |
| `test/cloud-plan-promotion-identity.test.ts` | under both folds: one idea promoted on two devices offline (with a ticket made offline on one, with a third device ahead, with equal counters, whichever device sends first) ends on one number per record on every device and a fresh one, no number on two records, no open conflict |
| `test/cloud-plan-breakdown-sync.test.ts` | under both folds: two devices editing different breakdown rows offline, or each adding one, keep both with no conflict, on a hydrated device too; one row edited on both is a recorded conflict holding both values, and resolving it settles both; two devices scaffolding one idea offline create the same tasks (same ids), merged into one set, and a later scaffold adds only the new row |
| `test/plan-scaffold-guards.test.ts` | a shaped plan hollowed by an edit (goal, breakdown, acceptance, an added or reopened question, a restored empty revision, an unknown key) stays shaped, says what it lacks, holds Scaffold and Promote back and refuses both; a breakdown never written as a document, list sections and questions written as lists only; every malformed plan payload refused by name; import into shaped held to the gate with its questions, writing nothing when refused; the source file attached byte for byte; a confirm refused without a fingerprint and on a changed plan; no preview where Scaffold is not offered; inherited acceptance, labelled; blockers added and never removed; a renamed key keeps its task; tasks named by idea and row; cycles named; a stale breakdown save refused; one row edited writes one row |
| `test/plan-read-cost.test.ts` | a plan read never resolves a reference per document, derives the plan once per state of the database, and once more for a write as the server answers it; a change made outside the plan layer and a new day are read |
| `test/ui-server-keep-alive.test.ts` | the page's server holds kept-alive sockets past SQLite's busy timeout and says so in its `Keep-Alive` header; a socket idle longer than Node's default is reused and answered |
| `test/sync-mutation-convergence.test.ts` | every `PlanStore` mutation, and `promoteInPlace`, converges column for column |
| `test/plan-surfaces.test.ts` | CLI, MCP and HTTP read one plan with no idea numbers and no draft shown, walk every surface that prints or serializes an issue (CLI text and JSON, MCP tools, HTTP routes, events, refusals) and find no draft, with `identifier: null, draft: true` on every issue object, consume no number at capture, refuse the same agent writes (plain tracker tools and `update_milestone` included), promote into the horizon's milestone, and let the person steer |
| `test/plan-lifecycle.test.ts` | the table itself, pinned: every state's actions, who takes each, the promoted record's epic edits, back to raw offered nowhere, how a maturity change is named (a no-op included), how states are read |
| `test/plan-own-state.test.ts` | with hand-written expectations, not the table's: a parent's own state against its rollup (a raw parent with work underway or landed beneath it, a dropped one restored, its sub-ideas left alone, no baseline, late rolled up); a sub-idea promoted or adopted on its own and re-parented by its parent's promotion, its tree and derived status; a promoted record edited as an epic once shipped; the maturity no-op; every document key, restore and file on a shipped, dropped or raw idea |
| `test/plan-lenses-review.test.ts` | the server counts a horizon's hand-added members and exploring records (shipped, progress, not started); a horizon is its own horizon and the task list's horizon ids; the run setting is the person's on every path (`setHorizonRun`, `update_milestone`, `update_task`), reaches every ticket of the horizon and the horizon itself as the `horizon-run` instruction, and allows a goal run only when set to `goal`; dependencies only from explicit references, never prose words with digits |
| `test/plan-lenses.test.ts` | what the lenses read: records named by number and title keys, dependencies from the section and outside depends-on cells, a shared key and the record itself never named; completeness and `dependsOn` on the payload; a horizon's shipped count and progress; Queue and Run to goal offered while it holds work, Queue held back once queued; each issue's horizon from its own membership (derived or put there) or an ancestor's, a plain milestone's never, none with the plan off |
| `views/plan/lenses.test.tsx` | Ideas holds own-state thinking only (a sub-idea under started work included) and shows completeness and the horizon with nothing about delivery; Horizons holds shaped, started and shipped; a shipped card's mark and date; the header's progress, shipped count, late, Queue and Run (Queued held back, neither on a planned horizon); a done horizon folds; the goal-run commands; the shipped mark's words; the timeline's end-cap on shipped bars only; arrows between laid-out rows, red when the waiting record starts first; Markdown quotes, numbered lists, checklists, tables and emphasis, a lone asterisk left alone |
| `views/tree/horizon-axis.test.tsx` | a horizon's own row files under itself, never No horizon, never re-placed on the Horizon axis; the phone's compact chip in its own slot below 480px with the full name on tap; the ◇ chip names the row's horizon ahead of the queue's milestone; Group by Horizon in the plan's order then No horizon, an epic with its task; the horizon filter's options, counts and matches, absent without horizons |
| `test/plan-lifecycle-surfaces.test.ts` | every idea (state, write) cell and every horizon (state, action) cell agrees with the lifecycle table on HTTP, MCP and the CLI with and without `--person` (the CLI bundled once per run, so the walk takes seconds); every payload carries exactly the table's row, promoted records and parents with sub-ideas included; every document and file write (MCP `put_document`, `attach_file`, `doc_restore`, `staple doc --put`) in every state; the no-op maturity; a horizon's milestone route refusing a start date before any write |
| `src/ui/app/src/detail/plan-drawer.test.tsx` | an idea's tab strip, the epic's strip once promoted, no ticket number in any presentation, actions exactly as offered, a read-only title where the state offers no edit, idea wording in Activity, Documents and Files, a horizon's section and a held-back action's reason |
| `src/ui/app/src/components/command-palette/commands.test.ts` | a plan record's palette commands are its one-click offered actions only (no status, start or stop for an idea; a promoted one keeps its epic commands), with its title as the hint, never its id |
| `src/ui/app/src/views/plan/plan-model.test.ts` | board columns and nesting, the Ideas lens, the late/not-started split, timeline groups, range and dragging |
