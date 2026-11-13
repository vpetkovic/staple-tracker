# The plan layer: ideas, horizons and the timeline

The contract behind planning, for people working on staple. The user guide is
[docs/plan.md](../docs/plan.md).

Tickets are for doing. The plan layer is for deciding what to do and when, without putting
undecided work in the task list. It has two records and one path into the tracker:

- an **idea**, which has a *maturity* (`raw`, `exploring`, `shaped` or `dropped`), a brief, plan
  sections with a structured task breakdown, open questions, decisions, an optional parent idea
  and an optional planned window. An idea has no ticket number;
- a **horizon**, which is a milestone the plan shows as a column, such as Now or Next. A dated
  horizon is a release line;
- **Scaffold** turns a shaped idea into an epic and its breakdown into tasks, on the same record.
  **Promote** does the conversion without the tasks, and **Adopt** links work that already exists.

Maturity and horizon are independent. "Shaped, no horizon" is a feature whose timing is open;
"exploring, on Next" is a reserved slot whose scope is open. Both are valid.

Where it lives: the pure rules in `src/core/plan.ts`, the lifecycle table in
`src/core/plan-lifecycle-table.ts` and its refusals in `src/core/plan-lifecycle.ts`, plan sections
in `plan-sections.ts`, breakdown rows in `plan-rows.ts`, links in `plan-links.ts`, derived
membership in `plan-members.ts`, rollups in `plan-rollup.ts`, and the store half in
`plan-store.ts` (`store.plan()`). The surfaces are `src/commands/plan.ts` (CLI), the plan tools in
`src/mcp.ts`, the `/api/plan` routes in `src/ui/server.ts` and `src/ui/app/src/views/plan/`.

## The flag: experimental, off by default

Planning is experimental and may change. One synchronized workspace setting,
`features.planning` (`settings-registry.ts`), defaults to false. Only a person changes it, in
Settings → Experimental or with `staple settings set features.planning true|false --person`
under their `humanName`. `staple plan enable --person` is an alias that sets the same flag; there
is no second switch. Agents read it through `get_setting` and `show_about`; an agent's
`set_setting` on it is refused.

The UI is the person, and the UI token is the person's: an authenticated HTTP `/api/settings`
request declares a person decision. The CLI's `--person` declares the configured `humanName`.
These declarations use the existing person model, not a separate authentication boundary.
Agents are trusted not to impersonate the person through that token or `--person`.

**Planning is on** when the flag is true AND the structural check holds: the idea and milestone
kinds exist and a milestone carries a plan rank. Setting it true runs the enable path in the same
transaction (`PlanStore.initialize`): the kinds when missing, the default horizons Now and Next,
the upgrade of a legacy Later column, and drafting ideas an earlier build numbered. Enabling is
refused while issues use the `idea` kind for other work; they are kept and named, and a person
resolves them first. Migration 020 runs for every workspace whatever the flag: it is additive and
nullable, and the flag gates behaviour, not schema.

The flag separates **presentation** from **protection**.

*Presentation follows the flag.* Off hides the whole layer and keeps its data. Plan, its lenses,
drawer tabs, palette actions and the Tasks horizon chip, axis and filter disappear. Planning CLI,
MCP and HTTP operations refuse with one validation sentence (`PLAN_KINDS_MISSING_MESSAGE`).
`/api/issues` omits horizon fields, and pickup answers and run briefs omit horizon-run
instructions. Horizons appear as plain milestones; promoted epics are ordinary epics. Direct
generic idea reads (`get_task`, `/api/issue`) refuse with the same sentence, and generic task
detail and explicit subtrees omit nested ideas.

*Protection never depends on the flag.* Ideas stay unnumbered drafts, never task-list or pickup
work, in both states. Horizon identity and the idea-kind guards hold whether the flag is on or
the structure is ready. Hidden horizons refuse generic writes, goal runs included, and queue
pruning cannot remove a retained horizon while the flag is off. Re-enabling restores ideas,
horizons, sections, links and run settings without deleting or rewriting their data.

## Identity: ideas are issues, horizons are milestones

An idea **is an issue** of the reserved kind `idea`. Title, description, parent, documents,
comments, files, events and sync come from the issue (`PLAN_KINDS`, `isPlanKind`).

A horizon **is a milestone** ([milestones.md](milestones.md#identity-an-issue-of-the-milestone-kind)):
an issue of the kind `milestone` with a plan rank. The rank is what makes it a column; a milestone
without one (an autopilot milestone, say, or one made with `create_milestone`) is an ordinary
milestone and never appears in the plan. Its name is the milestone's title and its date is the
milestone's target date, so everything a milestone has (progress, state, the queue expanding it,
the goal check) a horizon has too.

**Only the person removes a horizon.** Issues are never deleted: removing a horizon cancels the
milestone and unschedules its unstarted ideas. It is refused while the horizon holds open work
(planned or placed by hand) or sits in the queue, naming what to move first, and an edit of a
removed horizon is refused before anything is written. A horizon is listed by its flag
(`LISTED_HORIZON`): a milestone with a plan rank, unless a person cancelled it. Its derived status
never hides it, and derivation never cancels it: a horizon derives from its open and done work
only (`deriveHorizonStatus`), so cancelling all its work leaves it planned, it ships only on work
that was done, and reopening the work derives it again. Membership is rebuilt over the same
listed horizons, so no rebuild drops a horizon's rows for its status, and the outcome does not
depend on when rebuilds run.

### Unscheduled and optional dates

Unscheduled is the absence of a horizon (`plan_horizon_id = NULL`), not a milestone. New
workspaces seed Now and Next. Named horizons may be undated: Now, Next or a person-created
Research column describes an intentional grouping, while Unscheduled means no grouping has been
chosen. Requiring dates would invent deadlines for those groups without changing delivery. The
same lifecycle, Tasks chip, grouping and filter, CLI and MCP operations apply with or without a
date. Only **dated horizons** appear in the Milestones list, alongside plain milestones; clearing a
horizon's date removes it from that list, and it stays in Plan and the Tasks grouping.

### Upgrade from the Later column

Earlier builds seeded a third, undated horizon named Later as the default bucket. When the
person turns the flag on, and after sync binds its device journal while the flag is on,
`migrateLegacyLater` finds listed, undated horizons named exactly Later. In one journaled
transaction it unschedules every plan record on them, promoted ones included, then clears the
old milestone's plan rank. Derived membership rebuilds; hand-placed members, queue position,
goal, history and status stay on the now-plain milestone. Nothing is deleted or cancelled:
keeping the ordinary milestone preserves the person's manual commitments, and the person may
remove it once empty. A dated Later is intentional and stays. The changed `planHorizonId` and
`planRank` fields travel through the existing issue journal, tail and snapshots. A connected
workspace without a device identity defers the upgrade until its journal can send it. Clearing
the rank makes the upgrade idempotent.

## Ticket numbers: none until promotion

An idea is stored under a **draft identifier**, `~` and its id's 32 hex digits
(`draftIdentifier`). The `issues.identifier` column stays `NOT NULL UNIQUE`, so nothing about the
issue row changes shape, and the draft:

- is unique, because the id is;
- never parses as a ticket ref (`IDENTIFIER_RE` is `^[A-Z]+-\d+$`), so no ref a person types
  reaches it, and `advanceIssueNumber` ignores it;
- consumes nothing: `createIssue` skips `nextIssueNumber` for an idea while planning is on;
- synchronizes as the identifier field, like any other value of it;
- is never shown. Every surface sends what it prints through one rule in `plan.ts`: the CLI's
  output (every line it prints, `cli.ts`), every MCP tool's answer (`published` in `mcp.ts`) and
  every HTTP answer (`json` in `server.ts`). In JSON an issue whose identifier is a draft goes out
  as `identifier: null, draft: true` (`hideDraftIdentifiers`); a draft anywhere else, a text line,
  a message or an event, goes out as the idea's id (`draftsAsIds`), which is how the CLI, MCP
  tools and page refer to an idea. `IdeaView.identifier` is `null` until promotion, and refusals
  name an idea by its title (`displayRef`).

**Promotion allocates the number** through the tracker's own counter, on the same row
(`promoteInPlace`): the identifier and the kind change in one journaled `update`, and
`recordIdentifierMove` keeps the draft as an alias. An idea an earlier build numbered takes its
draft back when planning is enabled (`draftNumberedIdeas`), and its old number still resolves.

## Storage: eight columns on `issues`, three tables, no new entity

What an issue cannot already say lives in eight nullable `issues` columns added by workspace
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
| `plan_run_mode` | horizon | its run setting: `work`, `goal`, `epic` or NULL |

A horizon's date is its milestone's `target_date`, and its goal is the milestone's acceptance
criteria. An idea's brief, open questions, decisions and text and list plan sections are
documents on the record, so they are revisioned and synchronize as documents already do, and
they stay on the epic after promotion.

The plan fields are left out of an issue's *create* while they are null (`PLAN_ISSUE_FIELDS`,
`nullOmittedOnInsert`), so a task's create carries exactly the fields it carried before; an absent
key on a create reads as NULL, the column default.

## Links and breakdown rows: one synced field each

`plan_links (idea_id, issue_id, linked_by, linked_at)` holds one row per link. On the wire each
link is one field of the record's `milestone` entity, `planLink.<issue id>`, whose value is
`{ linkedBy, linkedAt }` and whose `null` unlinks. That is the shape criterion marks already use
(`criterion<n>`, [milestones.md](milestones.md#goal)).

The task breakdown is structured: rows `{ id, key, title, estimate, dependsOn, acceptance, owner,
notes }`, because a row's fields become a task's at scaffold. `key` is how rows depend on each
other (`42.1`) and may be renamed; `id` is the row's own and never changes. Rows live in
`plan_rows (idea_id, row_id, body, rank)`, and on the wire each row is one field of the same
entity, `planRow.<row id>`, whose value is the row with its rank and whose `null` removes it.

The service folds the entity's keys one by one, so two devices linking different work to one
idea, or editing or adding different rows, write different fields and both edits arrive with no
conflict and no person needed. Linking and unlinking the *same* issue, or editing the *same* row,
on two devices is one field and a genuine disagreement, recorded as a conflict like any other
(`conflict_list` / `conflict_resolve`), never a silent overwrite. A write sends only the rows it
changed, and a row keeps its rank while the order allows. The apply, seed, snapshot comparison,
conflict, rewind and quarantine paths read link and row fields wherever they read criterion
marks; an idea that holds only links and rows is seeded as those fields alone, so no milestone
row is ever written for it.

**Why not `relations`, and why not one document.** The `relation` entity is keyed by the blocked
issue and carries its whole `blockedBy` set as one field, so two devices editing one set
conflict. A breakdown stored as one document lost an edit with no conflict when two devices each
wrote a revision, because the log kept one head.

On one device, a breakdown write may name the `breakdownRevision` it read (`breakdownBase`;
`breakdown_base` on MCP); it is refused with `revision_conflict` when the breakdown changed since.
The Plan tab and `staple idea task` always send it. A write without it replaces the breakdown,
keeping each row's id: the id it names, else the stored row with its key, else a new one.

**A link whose issue is gone** (a rewind removed it): `issue_id` has no foreign key, so the row
stays. The idea keeps counting it, so its stage does not slip back to a maturity it had left;
shipped is judged on the linked work that is present. The detail lists it as missing, and
`unlink` accepts its bare id.

## Membership: derived from the plan, never typed twice

A horizon's members come from its records. A promoted record on horizon H is a member of
milestone H, and so is every issue a record on H links. Moving the record moves its work,
unscheduling it removes the work, and unlinking removes that issue. Nobody adds them by hand.

`plan_members (issue_id, milestone_id, position)` holds the result, rebuilt by one deterministic
function of synchronized facts (`derivePlanMembers`): the listed horizons, each record's horizon,
rank and kind, its links in `linked_at` order, and which issues exist on this device. Records are
walked in plan order with the id breaking ties; an issue is placed once, first record wins; ideas
and milestones are never members. Two devices holding the same facts hold the same rows. It is
rebuilt after every plan write and after every pull, and each milestone whose membership changed
on this device re-derives its status there (`rederivePlanMilestonesAfterPull`): two devices that
moved ideas offline each derived from their own half, and only the merged membership says what
the status is.

Every reader of membership reads `MILESTONE_MEMBERSHIP`, the union of the hand-made
`milestone_members` and `plan_members` for any issue not already in the first: the milestone view
and progress, `milestoneOf`, the queue's expansion of a milestone, status derivation, the gate
holders and the agent instructions. **A member a person put in a milestone by hand stays where it
was put** and wins over the plan.

**Why not write `milestone_members`.** Milestone membership replicates as one ordered list per
milestone, written whole against a base version. Two devices moving ideas between horizons
offline would each rewrite two lists, and the second would land as a conflict for a person to
settle. The derived rows are never journaled or seeded; only the ideas' own fields travel, and
those merge per field.

## Plan sections and the shaped gate

An idea is a plan. Besides its brief, open questions and decisions it holds ten sections
(`plan-sections.ts`): **Goal**★, **Context and constraints**, **Decisions**, **Open questions**
(answered, open, or deferred: left open on purpose), **Task breakdown**★, **Acceptance
criteria**★, **Dependencies**, **Out of scope**, **Risks** and **Sources and files**. Text
sections are markdown documents; list sections are documents with one `- item` per line; the
breakdown is rows (above). Writing a section is the edit action (anyone's); a write replaces each
section it names whole. The detail carries the sections, a completeness count (★ sections, and
all ten), what the shaped gate still needs, estimate warnings and the breakdown's revision.

Every surface writes sections through one check (`checkPlanPatch`): a text section is text or
null, a list section a list of text, the breakdown a list of rows, and anything else (a string
where a list belongs, an unknown section, a row without a key or a title) is refused by name
before anything is written. A raw document write on a plan record (`put_document`, `staple doc
put`, a restore) is held to the same shapes: the breakdown is not a document and is refused there,
and a list section or the questions checklist must read as the list it holds, so a body can never
read back as fewer items than it was given.

**The gate** (`shapedGate`). An idea is shaped only with a goal; a task breakdown of at least one
row, every row titled, no two rows on one key, no row depending on a key the breakdown does not
hold, and no depends-on cycle; acceptance criteria; and no open question that is not deferred. A
key "the breakdown does not hold" is one shaped like this plan's keys (`42.9` in a plan of `42.x`
rows); another plan's key (`39.4`) or an outside event waits outside the plan instead. A cycle is
named by its rows (`1 → 2 → 1`). The gate holds on every way to shaped: a maturity change, a
capture straight into shaped, a raw idea shaped in the same write that gives it its plan, and an
import into shaped, where it reads everything the import writes, its open questions included,
before any of it is written.

**An umbrella** is a record with at least one sub-idea that is not dropped (a sub-record of any
maturity but dropped, promoted or not, as the plan lists its records: `PlanStore.hasSubIdea`). Its
sub-ideas are its breakdown, so the gate does not ask it for rows of its own; every other part of
the gate holds, and rows it does have are held to the same row rules. `gateOf`, `missingForShaped`,
the shape action's hold-back reason, Scaffold's problems and `planIncomplete` all read the same
`shapedGate(sections, questions, { subIdea })`. A capture or an import makes one new record, which
has no sub-idea yet, so on those paths its own rows are its breakdown: a parent is imported as
exploring, its sub-ideas added, then shaped. Dropping the last sub-idea of a shaped umbrella with
no rows leaves it **shaped · plan incomplete**, as any hollowed plan (below). An umbrella whose
sub-ideas are all dropped needs rows like any idea.

**Inherited acceptance.** A row without its own "done when" inherits the plan's acceptance
criteria, so the gate needs none from it. The plan's row says it inherits; at scaffold its task
gets the plan's criteria and the label `acceptance-inherited`, and its context says so, so
whoever takes it sharpens it and removes the label.

**A shaped plan edited since.** Agents may edit a shaped idea's plan, and an edit can leave it
failing the gate: a cleared goal, an emptied breakdown, an added or reopened question, a removed
row, an old revision restored. Its maturity stays, because maturity is the person's and no edit
moves it as a side effect. The record says so instead (`planIncomplete`), shown as "shaped · plan
incomplete" with what it lacks in the drawer, on the card and in the For agents view; Scaffold and
Promote are held back with that reason and refused at confirm, naming what is missing.

**Estimates** read as a plan writes them: `3h`, `3 hours`, `3hrs`, `30m`, `30 mins`, `90s`,
`2h30m`, `1 day`, `2 days`, `1.5d`, `1w`, `~4h`, `2-3h` (its top), a working day of eight hours and
a week of five days. One that does not read is never a silent null: the plan and the preview show
why.

## Into the tracker: Scaffold, Promote, Adopt

**Promote** (`PlanStore.promote`) turns the idea into an epic in place (the workspace's `epic`
kind, or its default kind when it has none). It is the same record: its id, documents, comments,
files, events, links, sub-ideas and plan fields stay, and its history shows the promotion
(`idea_promoted`). It takes its ticket number then, it is started from then on, and its baseline
is kept if it has a window. Only a shaped idea offers it, to a person or an agent alike. Once
promoted it is an ordinary epic: queued, worked, renamed, documented and closed as any other, in
every plan state, while its plan fields keep it on the board and the timeline.

**Scaffold** (`PlanStore.scaffold`) is Promote plus the breakdown. The epic's `plan` document is
composed from the goal, context, decisions, dependencies, scope, risks and sources; its acceptance
criteria are the idea's; and each row becomes a child task with its estimate, blockers from the
rows it depends on, its acceptance, and a `context` document that makes it workable alone (what
the epic is for, done-when, what it waits on inside and outside the plan, the constraints, scope).
Each shaped sub-idea is scaffolded the same way under it. An umbrella with no rows of its own
scaffolds to its epic and its shaped sub-ideas' epics and no task of its own; a sub-idea that is
not shaped is left as it is. The preview lists only what it builds: the epic, its own rows' tasks
and, under `children`, each sub-idea that offers Scaffold with its own preview. A sub-idea that is
not shaped is not in it. Scaffold promotes through the same `promoteRecord` as Promote.

*Preview, then confirm.* `scaffoldPreview` computes exactly what the create path writes, and the
create path builds from it. The preview carries the problems that hold the confirm back (the gate,
here and in each sub-idea it carries), warnings (an estimate that is not a duration), and a
**fingerprint**: a digest of everything it shows. A confirm names that fingerprint, and is refused
without one ("preview first") and when the plan changed since ("the plan changed since the
preview"), on the page, over MCP and on the CLI (`staple idea scaffold <ref>` previews and prints
the confirm; `--confirm <fingerprint>` creates). Only a state that offers Scaffold has a preview:
a raw or exploring idea and a plain task are refused, preview included.

*Task identity: the idea and the row.* A row's task has an id that follows from the idea's id and
the row's (`scaffoldTaskId`, a digest shaped as a UUID). So a retry, a scaffold after rows were
added, a key renamed since, and a second device scaffolding the same idea offline all name the
same task: whatever has a task already is not created again, and two devices that created it
offline sent two creates of one record, which sync merges as it merges any record written on two
devices. No scaffold map is kept and no idempotency key is claimed. Scaffold adds the blockers its
rows' depends-on name to a task that exists, and never removes a blocker someone else set.

*Scaffolded before.* A started record offers Scaffold again, preview included, only if it was
scaffolded: it is promoted and a task of one of its rows exists, or it is promoted, has no rows of
its own and has a sub-idea that is not dropped. The second is an umbrella. Its Scaffold made the
same epic Promote makes and nothing of its own, so the two are not told apart, and either way a
Scaffold of it builds only its sub-ideas. Both read facts every device holds after a sync, so no
marker is stored. A record started by linked work alone, or a promoted record with rows and no
task of theirs, offers no Scaffold.

*Sub-ideas shaped later.* A retry on the parent builds what is missing below it: a sub-idea shaped
after the parent's scaffold is in the parent's next preview and its confirm builds it as a child
epic, once, as its own Scaffold would. Scaffolding the sub-idea on its own does the same.

**A sub-idea promoted or scaffolded before its parent.** The plan's tree is the tracker's:
promotion never moves a record, so the epic's parent is still the idea above it. The tracker reads
that epic as top-level work: `WorkspaceStore.tree` lists it at the root, and an idea derives
nothing, so no status flows into or out of the idea. When the parent is promoted or scaffolded,
the same write makes it the epic above its promoted sub-ideas, and its status is derived from
theirs in that transaction (`rederiveParents`). A sub-idea promoted under a parent that is already
promoted is its child from the start.

**Adopt** links an existing issue to a record, promoted or not; **Unlink** removes one link.
Exploring offers it as well as shaped: tickets that already exist can belong to an idea whose
scope is still open. Raw never does.

**Import** (`staple idea import <plan.md>`, `PlanStore.importPlan`) reads a plan file into one
idea, in one transaction: the first heading outside a code fence is the title, the text before the
first section is the brief, and each `##` heading is mapped by its words (Goal, Task or Step
breakdown, Acceptance criteria, Out of scope, Risk, Open questions, Dependencies, Decisions or
ruling, Sources). Headings inside code fences are text. Breakdown tables are read by their header
row whatever their columns, an escaped `\|` inside a cell; a list line like `42.1 Title` works too.
A list item's wrapped line joins it, and a nested item folds into its parent. Every other heading
lands in Context under its own heading, front matter too. What a section cannot hold (prose under
a list heading, a table row without a key, a key a table already gave) is kept in Context and
reported as a warning: nothing is dropped. What a row waits on outside the plan becomes a
dependency; the file is attached and listed as a source.

## Lifecycle: one table drives every action

Each record is in one lifecycle state, and the state decides which actions it offers
(`plan-lifecycle-table.ts`). An idea's state is its derived stage, with `scheduled` read as its
maturity: raw, exploring, shaped, started (promoted, or linked to work), shipped, or dropped. A
horizon is planned (no open work), active (it holds open work) or shipped (its milestone is done);
only a person's removal cancels one.

| state | offers |
|---|---|
| raw | edit, ask, decide, explore, shape, drop, reparent, reorder |
| exploring | edit, ask, decide, shape, drop, schedule, plan dates, reparent, reorder, adopt |
| shaped | edit, ask, decide, back to exploring, drop, schedule, plan dates, reparent, reorder, promote, scaffold, adopt |
| started | edit, ask, decide, schedule, plan dates, reorder, scaffold (only if it was scaffolded), adopt, unlink, reset baseline, open the epic; shape while its maturity is exploring |
| shipped | adopt (linking more work: landed work keeps it shipped, open work reopens it), open the epic; a promoted record adds edit, ask, decide |
| dropped | restore |
| horizon planned | rename, date, reorder, run setting, remove (held back while it is queued) |
| horizon active | rename, date, reorder, queue (held back once it is queued), run setting |
| horizon shipped | remove |

So raw is never scheduled, promoted or linked to work, a started or promoted idea never offers promotion again, an
unpromoted shipped idea offers no edits (only linking more work), and a horizon is removed only
while it holds no open work and is not queued, queued only while it holds open work, and given its
run setting until it ships. Each action also says who may take it: the steering actions (maturity
moves, schedule, dates, order, parent, baseline, every horizon definition and the run setting) are
the person's; the rest are anyone's. A few preconditions need data and travel with the offer as a
`disabledReason`: unlinking needs a link, the epic opens once promoted.

**Its own state against its rollup.** The state reads only the record's own facts: its maturity,
whether it is promoted, and its own links. Its sub-ideas' work is its **rollup**: progress, the
actual window, the forecast and the late and not-started flags read the record's work and every
sub-record's, for the card, the header and the timeline. The rollup never changes the state or the
actions. So a raw parent whose sub-idea is underway stays raw, a parent whose sub-ideas all
shipped can still be shaped and promoted, and a dropped parent stays dropped and restorable while
its sub-ideas carry on. Maturity never cascades. A promoted record is an ordinary epic in the
tracker; its plan record reads started or shipped, and it offers the epic's own edits (edit, ask,
decide: `PROMOTED_ALWAYS`) in both.

**Started while exploring.** An exploring idea that adopts work derives stage `started` (linked
work starts a record whatever its maturity), so it reads started and leaves the Ideas lens for
Horizons, and its maturity stays exploring: maturity is the person's and no link moves it. The
started row has no shape action, so the table adds one cell on top of it for exactly this record,
`UNSHAPED_STARTED` (Mark shaped), the way `PROMOTED_ALWAYS` adds a promoted record's edits:
`ideaOffered(state, promoted, maturity)`. Shaping it is held to the gate and is the person's, as
any shaping is, and the hint of what shaping needs follows that offer on the CLI and the drawer.
Its questions are asked, answered and deferred through the started row's `ask`. It is not offered
drop, reparent or back to exploring, as a shaped record with linked work is not; Promote and
Scaffold stay shaped-only. Once shaped it reads started as before, with the started row alone.
Its membership, baseline and guards are a started record's: its linked work joins its horizon's
milestone, its window is kept as the baseline when it starts, and it is never queued, checked out
or listed as work. A record that shipped while exploring reads shipped and offers what shipped
offers.

A maturity change is named from where the record stands (`maturityAction`): the maturity it
already has is no change and succeeds as one, in any state; out of dropped is restoring; to
exploring is going back from shaped and exploring otherwise; to raw is going back to raw, an
action (`back_to_raw`) that no state offers, so its refusal says so in those words.

**Every write on an idea's own content is its edit action.** A document under any key, a restore
of an old revision, and adding or removing a file are refused where the idea's state offers no
edit, on every surface: `WorkspaceStore.putDocument`, `attachFile` and `removeFile` ask the table
through `PlanStore.assertEditable`, the same cell and person rule as `update_idea`, so the MCP
tools, the CLI and `/api/action` (`doc_restore`) all inherit it.

**Every surface derives from the table.** `PlanStore` checks it first on every write and refuses
with `validation` naming the state, the refused action and what the state offers, before the
person rule; the tracker's own edit of an idea's title or description, and queueing a horizon, ask
the same table. Every plan payload carries each record's `state` and `actions` (id, label, who,
disabledReason), so `get_idea`, `list_ideas`, `list_horizons` and `staple idea show` ("offers")
read it, and the page renders from it: `plain-actions.ts` (`planActionItems`, `horizonActionItems`,
`moveOffered`) turns exactly those offers into the drawer's buttons, the card's ⋯ menu, the
board's drops, the timeline's drags and the command palette; it names which action a board move
is, never whether it is allowed.

## Who steers: agents capture, the person decides

An agent may capture raw ideas (title, brief, parent), edit titles, briefs and plan sections, add,
answer and defer questions, add decisions, adopt work onto an exploring or shaped idea or unlink
it, and promote or scaffold an idea the person has marked shaped. Maturity, horizon assignment, parent, planned dates, order, horizon
definitions, dates and run settings, the baseline and the feature flag are the person's.

The distinction is the one the tracker already uses for gate decisions: a write carries a
`PersonDecision` or it does not. The store cannot tell a person from an agent and does not try;
the flag is the distinction. Three surfaces set it:

- the web UI, for every plan write (`via: "plan_view"`): the page is the person;
- the CLI with `--person`, recorded under the machine's configured `humanName` and refused when
  none is set (`via: "cli"`);
- `reset_idea_baseline`, the Reset baseline button in an MCP view, under `humanName`
  (`via: "mcp_view"`).

Model-visible plan tools and the CLI without `--person` never set it, and a steering write without
it is refused with `validation` (`steeringRefusal`) saying what an agent may do instead.
`update_idea` accepts the steering fields only so that the refusal can explain itself.

**The tracker's own writes hold the same line.** `create_task`/`staple new`, `update_task`/`staple
set` and `update_milestone` reach the store's `createIssue`, `updateIssue` and
`MilestoneStore.update`, which carry no person, so while planning is on: a horizon cannot be edited
there at all (name, status, dates, goal or any field); a milestone made there is an ordinary
milestone, never a column; an idea's status never moves there; and an idea made there is captured
raw, numberless, at the end of the plan, as `capture_idea` would make it. The plan layer's own
writes pass `PlanInternal` after applying the person rule.

## Guards: an idea never enters the tracker

For an idea that is not promoted (a promoted one is an ordinary epic):

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

Every guard was checked by removing it and running the suite: each removal fails the test named
above. The resolver, derivation and listing guards hold even for shapes the local guards refuse
but another device could deliver (an idea in `queue_entries`, an idea under a task), which is why
those tests write the shape directly. These guards are protection: they hold with the flag off as
well as on (`test/planning-feature*.test.ts`).

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
| dependencies | `dependsOn`: explicit references only (`resolveDependencies`), below |

Late and not started are separate facts with separate counts, on cards, horizon headers and the
timeline, and never one number. Dates are calendar days in UTC, inclusive, as for milestones
([milestones.md](milestones.md#dates-calendar-days-utc-inclusive)).

**Dependencies between records.** Only an explicit reference counts: a line of the Dependencies
section, or a depends-on cell naming something outside its own breakdown, that leads with a
record's ticket number, a key the record's title leads with (capitals with a number: `C2 Checkout
API` is C2, `R2 · OPS-40 Billing export` is R2 and OPS-40), or the key of a row in exactly one
other record's breakdown (`42.1`). Everything else is prose, however many words with digits it
holds (`OAuth2`, `S3`). A key two records share names neither, with one exception: a key that
names one record by its title and is otherwise only the key of rows of that record's own ancestors
names the record. An umbrella keys its rows like its sub-ideas (`R5` a row of the parent, `R5
Billing export` a sub-idea), and a sibling's `R5` means the sub-idea. A key shared by two records'
titles, or by a title and a row of a record that is not an ancestor, still names neither. A record
never waits on itself, on any of its ancestors or on any of its descendants: a parent's work holds
its sub-ideas', so either wait would be a cycle. So a parent's own row keys in its own
Dependencies name its own rows, and a sub-idea naming a key only its ancestors' rows hold waits on
nothing. The timeline draws no arrow between a record and its ancestor.

**The baseline.** The first planned window a record has once it is started itself is kept as its
baseline (`plan_baseline_*`). It is written when a record becomes started with a window (promoted,
or linked to work), or when a started record gets its first window; a sub-idea's start starts no
baseline above it. A baseline that exists is never moved by a re-plan. Reset is an explicit,
person-only action that copies the current window. Before a record is started there is no baseline
and moving the window just moves it.

**Reads.** Every derived fact is read from the plan as it stands, so a read must stay cheap as the
plan grows: the page's server answers every plan write with the whole plan and the record's
detail, on one event loop shared by every request. A record's documents are read by its id in one
statement each, never by resolving a reference, and the records' views are derived once per state
of the database (keyed on the connection's `total_changes()`, SQLite's `data_version` and the day):
a request that checks a state, writes and answers rebuilds them once for its write. The server
holds an idle kept-alive connection for 65 seconds (`KEEP_ALIVE_MS`), well past SQLite's
five-second busy timeout, so a request a client sent on a reused socket while the loop was busy is
read and answered, never reset.

## A horizon's run setting

How far agents take the horizon when they pick its work up, and its goal. It is a setting, like
autopilot's, and nothing runs from it: the person sets it in the horizon's header or drawer
(`setHorizonRun`, `POST /api/plan/horizon-run`, `staple horizon set --run --goal --person`;
refused to an agent, as every horizon setting is), and every agent that takes the horizon's work
reads it. The goal is the milestone's own acceptance criteria, editable from the plan and the
person's on a horizon (`update_milestone` and `update_task` refuse an agent's edit of them). How
far is `plan_run_mode`, one of three, because they are the three places a run can stop
(`RUN_MODES`):

| setting | what agents do | how it ends |
|---|---|---|
| `work`: until its work is done | take its work from the queue until every member has landed; nothing beyond it, no goal run | ships itself when its last member lands, as any milestone does |
| `goal`: until its goal is met | a goal run over it works its members, judges each criterion with evidence, and may file the tickets the goal still needs | the run gates the close to the person: the header reads *Waiting for your approval* until they approve it |
| `epic`: stop for review after each epic | work one epic at a time and stop when it lands, leaving the next for the person | each epic is reviewed before the next starts; the horizon ships with its last member |

Unset, agents work it as any milestone. Agents receive it as the `horizon-run` instruction
(`instructions.ts`), on every ticket of the horizon and on the horizon itself, so it arrives
wherever work is picked up: `queue next` / `next_task`, `get_task`, `run continue` /
`continue_run` and the run brief all carry the same instruction list, and the horizon's For agents
view shows it. With the flag off, none of them carries it.

A goal run over a horizon (`start_run`) is refused unless the horizon is set to `goal`
(`RunStore.assertHorizonRunsToGoal`). Stopping a goal run leaves its approval gate standing:
stopping execution does not approve the goal, and the horizon reads *Waiting for your approval*
until the person approves or requests changes. Work and epic modes create no goal gate. A pending
gate takes precedence over a completed progress bar in the board, the drawer and the timeline.

## Presentation

### Lenses: thinking, delivery, time

The Plan view has three lenses, each with one job (`views/plan/plan-model.ts`). Shaping is the
hand-off between the first two: no record is ever in both.

**Ideas is thinking.** It holds a record in its own raw or exploring state, in those two columns.
A sub-idea still being explored under started work stays (`inIdeasLens` reads the record's own
`state`, never the rollup). Its card shows how much of the plan is written (`★ 2/3 · 6/10
written`, the payload's `completeness`), open questions and the horizon it is aimed at (`◇ Now`),
and nothing about delivery. Marked shaped, it moves to Horizons.

**Horizons is delivery.** One column per horizon, then Unscheduled (*Ready, no horizon yet*),
holding shaped, started and shipped records (`inHorizonsLens`). A card shows where the work
stands, its progress and late or not started; a shaped record whose plan no longer passes the gate
is flagged *plan incomplete*. A horizon's header takes every number from the server, which sees
what the cards do not (a member added by hand, a record still being explored past its planned
start): its date, a progress bar (members landed over members held, `progress`), `✓ n shipped`
(`shippedCount`), late (`lateCount`) and not started (`notStartedCount`), *Waiting for your
approval* while its close is gated (`awaitingApproval`), and two buttons from its offered actions:
**Queue**, held back as *Queued* once it is in the queue, and its **run setting**. The drawer's
horizon section and the timeline's group headers read the same fields. A horizon is done only
when the server says so (`horizonDone`); then its column folds to a ✓ summary.

**Timeline is time.** Planned, baseline and actual windows on a month axis, today and dated
horizon lines, a ✓ end-cap where a record shipped, and an arrow from each record to every record
that waits on it, red when the record waiting starts before the one it waits on ends. Drag to move
and resize, where the state offers plan dates.

**Shipped is one mark** (`detail/ShippedMark.tsx`): a check in the done hue's icon token and the
words, `✓ Shipped Oct 3` or `✓ 4 shipped`, never the colour alone. The card, the horizon header,
the drawer's state chip, status sentence and phases, a milestone's horizon section and the
timeline's end-cap all draw it, and all read the record's own `state`.

**Reading mode.** The brief and every text and list section of the Plan tab read as formatted
Markdown (`lib/markdown.tsx`), with an **Edit** control only where the state offers the edit
action; Edit opens the textarea, a blur saves what changed and Escape puts it back. An empty
section offers to write it where edits are offered and says *Not written* where they are not.

### The drawer

An idea opens in the shared detail drawer (`detail/IssueDetailPanel.tsx`), as every issue does.
The tab registry (`detail/tabs/registry.ts`) chooses the strip by kind and state through
`available`: an unpromoted idea gets **Plan** in place of Details (the lifecycle as phases,
Thinking, Started and Shipped, with maturity and horizon as separate facts; the completeness
meter; Scaffold's preview and confirm; horizon, parent, planned and actual windows; the brief;
every plan section, the breakdown a table on a desk and a tap-to-edit card per row on a phone;
questions with defer; decisions; sub-ideas; linked work), **Connections**, Documents, Files,
Activity, **For agents** (the `get_idea` payload) and **Time** (planned against actual against
baseline). Its header shows the title, an "Idea · state" chip and a sentence, never a ticket
number: the page addresses the record by its id. Each editor renders only when the state offers
its action. Once promoted, the same record gets the epic's strip, with the Plan tab kept for the
plan actions its state still offers. A horizon opens as the milestone it is, with its state, its
offered actions and the ideas on it above the milestone's own parts.

### Tasks reads the same horizons

`GET /api/issues` leaves the horizons themselves out of its rows while planning is on
(`PlanStore.horizonIds`): a horizon shows as a section heading under Group: Horizon and as each
row's chip. Plain milestones stay rows. Each row carries its `horizon` (`PlanStore.horizonsOf`):
the milestone the issue is a member of, put there or derived from the plan, else its nearest
ancestor's, when that milestone is a horizon. The row's milestone chip becomes `◇ <horizon>`;
below 480px a compact chip keeps its own slot and shows the full name on a tap. **Group: Horizon**
sections the list by horizon in plan order, then *No horizon*, without nesting members under their
milestone again (`placeForAxis`), and a **Horizon** filter keeps the work of the horizons asked for
([web-ui.md](web-ui.md)).

### Returning to Plan

Plan reuses the detail drawer's `DetailTabStrip`, Radix keys and accessibility; the phone uses its
finger-sized segments and the desktop its underline strip. The last lens, open record, each lens's
scroll axes and phone column are per-viewer preferences under `staple:plan:v1:<workspace>`.
Filters use the existing workspace/view preference envelope and URL state. The shareable
`plan-lens` and `issue` parameters take precedence on arrival; Back/Forward follows the URL, and
an explicit drawer close clears the remembered record. Storage reads and writes fail safe. Search
filters the ideas in every lens. A horizon's drawer and the Milestones detail link to each planned
record with `view=plan&issue=<stable id>`, and a promoted epic carries an "Open original idea in
Plan" link.

## Sync guarantees

No protocol bump and no Worker change. A new *entity* needs a protocol integer
([sync.md](sync.md#protocol-evolution)); these are new *fields* on existing entities, which is
additive within a protocol version. The columns are in `ISSUE_FIELDS`, so the row diff journals
them, the applier writes them, the seed and snapshot carry them and conflict detection compares
them through the generic issue path. The Worker validates only entity names, verbs and that a
payload is an object (`worker/src/envelope.ts`); it stores and folds payload fields verbatim.

What converges, under both folds, on a tail device and a freshly hydrated one:

- **Plan fields** merge per field; offline moves on two devices derive the same membership with
  nothing sent for it, and each horizon re-derives from the merged membership.
- **Links and breakdown rows** merge per field (above): different links or rows arrive together,
  the same one on two devices is a recorded conflict.
- **Two offline promotions** take numbers as claims, exactly like creates (`claims.ts`): the log
  order decides, the later device moves its epic to a stand-in and settles it on its next number,
  and every device converges on two distinct numbers with no conflict left open. A third device
  that reads both claims first gives the later one the same stand-in, so it never shows a promoted
  epic without a number (`displaceIdentifierHolder` in `apply.ts`).
- **One idea promoted on two devices** writes one record's identifier twice. The last write in the
  log is its value, as the fold keeps; the number the record gave up is freed. Every device ends
  with one number per record, no number naming two records and no open conflict.
- **One idea scaffolded on two devices** creates the same task ids, merged into one set.
- **A horizon whose only work is cancelled** stays listed on every device and derives again when
  another device reopens the work.

## Known limits

- **Experimental.** The model, its surfaces and its storage may change in any release.
- **Mixed builds.** A device that has not migrated refuses a pulled operation page stamped schema
  20 with `schema_ahead`. The snapshot route checks the protocol only, so an older build that
  hydrates from a snapshot drops the plan fields, links and rows and shows each unpromoted idea as
  an ordinary issue under its `~hex` draft. Upgrade every device before planning.
- **The person is declared, not authenticated.** The UI token and `--person` are trusted; an agent
  that uses them is impersonating the person. `reset_idea_baseline` is marked app-only, which asks
  hosts to keep it from the model; that is a hint, not a guarantee.
- **The `idea` kind is reserved.** A workspace already using it for other work cannot enable
  planning until a person resolves those issues; generic kind migration is refused.
- **Dependencies are explicit references only.** A dependency written as prose draws no arrow.
- **Membership is derived per device.** It is rebuilt from synchronized facts and never sent, so a
  device that lacks an issue a link names leaves it out until the issue arrives.

## Surfaces

- **CLI** `staple plan enable|show`, `staple idea ls|new|show|set|plan|task|promote|scaffold|import|adopt|unlink|ask|resolve|defer|decide|reset-baseline`,
  `staple horizon ls|new|set|mv|rm`, with `--person` for steering. An idea's ref is its id.
- **MCP** `list_ideas`, `get_idea`, `list_horizons` (reads); `capture_idea`, `update_idea` (also
  `plan` sections, `breakdown_base` and `defer_question`), `start_idea` (promote in place, or with
  `adopt` link an existing issue; answers the promoted `{ id, identifier, kind }` or `null`),
  `unlink_idea`, `scaffold_idea` (preview without `confirm`; with it and the preview's
  `fingerprint`, create); `reset_idea_baseline` (a view button).
- **HTTP** `GET /api/plan` (each record with `state`, `actions`, `completeness` and `dependsOn`,
  each horizon with `shippedCount`, `progress`, `runMode`, `goal` and `awaitingApproval`),
  `GET /api/plan-idea?ref=`, `GET /api/issues` (each row with its `horizon`, horizons themselves
  left out); `POST /api/plan/{enable, capture, update, question, resolve, decision, promote,
  scaffold, adopt, unlink, reset-baseline, horizon-create, horizon-update, horizon-remove,
  horizon-queue, horizon-run}`; `update` and `capture` take `plan`, `update` takes
  `breakdownBase`, `resolve` takes `deferred`, `scaffold` takes `preview` or the preview's
  `fingerprint`. Every write answers `{ plan, idea }`. `GET /api/issue` adds `planRecord` and
  `horizonPlan`.
- **Web UI** the Plan view with its three lenses, the shared drawer, and the Tasks horizon chip,
  grouping and filter ([web-ui.md](web-ui.md)). Cards never show a number; a promoted record's
  detail does. A sub-idea in its parent's column folds under the parent's card; one in another
  column shows there, labelled with its parent. Below 768px the boards are one column with a
  switcher and the timeline scrolls inside its own frame with the names pinned.

## What the tests prove

| test | proves |
|---|---|
| `test/planning-feature*.test.ts(x)` (the base suite, surfaces, sync, protocol, poll, review, UI) | the flag: off by default, person-only on every surface, off hides every surface and keeps the data, on restores it, protection holds in both states, the flag and the Later upgrade sync |
| `test/store-plan.test.ts` | enabling and its refusal; identity (no counter consumed, never a ref, never shown, numbered at promotion, earlier builds' numbers drafted); every guard; the tracker's own writes, horizon dates included; dependencies; nesting and stage; horizons as milestones; membership (move, unschedule, unlink, plan order, hand-placed members stay, a promoted record counted, a queued horizon expanding); a horizon's own status (its only work cancelled with and without a rebuild between, reopened; shipped on done work only; removal refused while it holds open work or is queued; an edit of a removed horizon refused before any write); Promote in place, under a promoted parent, refused when dropped or already promoted; Adopt on a promoted record; missing links; actual windows on real-shaped data; late vs not started; the baseline; every steering refusal |
| `test/plan-sections.test.ts` | the importer on fixtures shaped like real plan files: every row kept, sections mapped, nothing dropped, what it cannot place reported; wrapped and nested items, prose under list headings, headings and comments inside code fences, escaped pipes, repeated keys and front matter kept, each said; unknown keys named; sections round-trip through their documents; every estimate form, and why one reads as none; cycles, unknown and repeated keys in the gate; the gate's phrases; completeness |
| `test/plan-scaffold.test.ts` | sections persist as revisions, an agent writes them, duplicate keys refused; the gate on every path to shaped, deferred questions let through; an umbrella shaped on a sub-idea that is not dropped, refused when every sub-idea is dropped, plan incomplete when its last one is; Scaffold creates exactly its preview, idempotently and for rows added later, nested sub-ideas as child epics, an umbrella with no rows as its epic and its shaped sub-ideas' epics, previewed and retried after its confirm and building a sub-idea shaped since, never where the lifecycle does not offer it; import with its file attached |
| `test/plan-scaffold-surfaces.test.ts` | the gate on the page, the CLI with `--person` and an agent over MCP, an umbrella's included, and an import into shaped held to it; the `idea defer` help says what the gate asks; the three Scaffold previews agree and write nothing; a confirm creates once whichever surface retries, an umbrella with no rows previewed and retried on the CLI after its confirm; CLI import |
| `test/plan-scaffold-guards.test.ts` | a shaped plan hollowed by an edit stays shaped, says what it lacks, holds Scaffold and Promote back and refuses both; the breakdown never written as a document; every malformed plan payload refused by name; import into shaped held to the gate; the source file attached byte for byte; a confirm refused without a fingerprint and on a changed plan; no preview where Scaffold is not offered; inherited acceptance, labelled; blockers added and never removed; a renamed key keeps its task; tasks named by idea and row; a stale breakdown save refused; one row edited writes one row |
| `test/cloud-plan-sync.test.ts` | under both folds: the plan, its membership and its numbers converge on a tail device and a hydrated one; offline adopts and unlinks; offline moves derive the same membership with no conflict; two offline promotions end with two distinct numbers; a third device never shows a numberless epic; a horizon whose only work is cancelled stays listed; an idea an earlier build numbered resolves by its old number |
| `test/cloud-plan-promotion-identity.test.ts` | under both folds: one idea promoted on two devices offline ends on one number per record on every device and a fresh one, no number on two records, no open conflict |
| `test/cloud-plan-breakdown-sync.test.ts` | under both folds: different rows edited or added offline both kept with no conflict; one row edited on both is a recorded conflict, and resolving it settles both; two devices scaffolding one idea create the same tasks, and one umbrella with no rows the same epics, which either device or a fresh one retries after sync to build a sub-idea shaped since |
| `test/sync-mutation-convergence.test.ts` | every `PlanStore` mutation, and `promoteInPlace`, converges column for column |
| `test/plan-surfaces.test.ts` | CLI, MCP and HTTP read one plan with no idea numbers and no draft shown on any surface, consume no number at capture, refuse the same agent writes, promote into the horizon's milestone, and let the person steer |
| `test/plan-lifecycle.test.ts` | the table itself, pinned: every state's actions, who takes each, the promoted record's epic edits, Mark shaped on a record started while exploring, adopt from exploring on and never raw, back to raw offered nowhere, how a maturity change is named |
| `test/plan-lifecycle-surfaces.test.ts` | every idea (state, write) cell and every horizon (state, action) cell agrees with the table on HTTP, MCP and the CLI with and without `--person`; every payload carries exactly the table's row; a record started while exploring carries the started row and Mark shaped, and only the person shapes it; every document and file write in every state |
| `test/plan-own-state.test.ts` | with hand-written expectations: a parent's own state against its rollup; a sub-idea promoted on its own and re-parented by its parent's promotion; a promoted record edited as an epic once shipped; an exploring idea that adopts work reads started, keeps its maturity, offers Mark shaped, joins its horizon, keeps its baseline and stays out of the tracker; every document key, restore and file on a shipped, dropped or raw idea |
| `test/plan-lenses.test.ts`, `test/plan-lenses-review.test.ts` | what the lenses read: dependencies only from explicit references, a sub-idea's title key over its ancestor's row key, never a wait between a record and its ancestor or descendant; completeness and `dependsOn` on the payload; a horizon's shipped count, progress and server counts; Queue and the run setting offered and held back; each issue's horizon; the run setting is the person's on every path, reaches every ticket as the `horizon-run` instruction, and allows a goal run only when set to `goal` |
| `test/plan-read-cost.test.ts`, `test/ui-server-keep-alive.test.ts` | a plan read derives once per state of the database, and ten more records add no more statements than they did before the umbrella gate; kept-alive sockets outlive SQLite's busy timeout |
| `views/plan/lenses.test.tsx`, `views/plan/plan-model.test.ts` | the lenses' membership, cards, headers, fold, shipped mark, timeline end-caps and arrows (none between a record and its ancestor), Markdown reading mode; board columns, nesting, timeline groups, range and dragging |
| `views/tree/horizon-axis.test.tsx`, `test/ui-horizon-chip.test.ts` | the Tasks horizon chip, grouping and filter |
| `detail/plan-drawer.test.tsx`, `command-palette/commands.test.ts` | an idea's tab strip and the epic's once promoted, no ticket number anywhere, actions exactly as offered, a read-only title where no edit is offered; palette commands from the offered actions only |
