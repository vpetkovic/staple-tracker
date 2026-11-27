# The plan layer: ideas, horizons and the timeline

The contract behind planning, for people working on staple. The user guide is
[docs/plan.md](../docs/plan.md).

Tickets are for doing. The plan layer is for deciding what to do and when, without putting
undecided work in the task list. It has two records and one path into the tracker:

- an **idea**, which has a *maturity* (`raw`, `exploring`, `shaped` or `dropped`), a brief, plan
  sections with a structured task breakdown, open questions, decisions, an optional parent idea
  and an optional planned window. An idea has no ticket number;
- a **horizon**, which is a milestone the plan shows as a section, such as Now or Next. A dated
  horizon is a release line;
- **Scaffold** turns a shaped idea into an epic and its breakdown into tasks, on the same record.
  **Promote** does the conversion without the tasks, and **Adopt** links work that already exists.

Maturity and horizon are independent. "Shaped, no horizon" is a feature whose timing is open;
"exploring, on Next" is a reserved slot whose scope is open. Both are valid.

Where it lives: the pure rules in `src/core/plan.ts`, the lifecycle table in
`src/core/plan-lifecycle-table.ts` and its refusals in `src/core/plan-lifecycle.ts`, plan sections
in `plan-sections.ts`, breakdown rows in `plan-rows.ts`, links in `plan-links.ts`, derived
membership in `plan-members.ts`, rollups in `plan-rollup.ts`, what a horizon and a record count
in `plan-accounting.ts`, and the store half in
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

A horizon its plan holds open ([Accounting](#accounting)) stays open with the flag off too, where
its ideas are hidden. So it says why: its milestone view carries `heldByPlan` (how many records
hold it) and `milestone show` prints `held by plan · 3 ideas on it not shipped yet`, and a write
to it is refused with the planning-off sentence followed by `… is held by 3 scheduled ideas that
have not shipped; turn planning on to see them.` A plain milestone, and a horizon nothing holds,
read and refuse exactly as before.

## Identity: ideas are issues, horizons are milestones

An idea **is an issue** of the reserved kind `idea`. Title, description, parent, documents,
comments, files, events and sync come from the issue (`PLAN_KINDS`, `isPlanKind`).

A horizon **is a milestone** ([milestones.md](milestones.md#identity-an-issue-of-the-milestone-kind)):
an issue of the kind `milestone` with a plan rank. The rank is what puts it in the plan; a milestone
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
(`deriveHorizonStatus`), so cancelling all its work leaves it planned, it ships only on work
that was done, and reopening the work derives it again. **It is not shipped while a record it
carries is not** (`PlanStore.heldByPlan`, [Accounting](#accounting)): work that has all landed,
or no work at all, leaves it in the unstarted band while a record on it is still to be built.
Membership is rebuilt over the same listed horizons, so no rebuild drops a horizon's rows for its
status, and the outcome does not depend on when rebuilds run.

### Unscheduled and optional dates

Unscheduled is the absence of a horizon (`plan_horizon_id = NULL`), not a milestone. New
workspaces seed Now and Next. Named horizons may be undated: Now, Next or a person-created
Research horizon describes an intentional grouping, while Unscheduled means no grouping has been
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

## Idea numbers: their own counter, and no ticket number until promotion

An idea holds an **idea number**, `I-<PREFIX>-<n>` (`I-STA-12`), as its identifier
(`idea-numbers.ts`). It is a value of the identifier field, so everything the tracker does for a
ticket number it does for this one, with no new mechanism:

- the `issues.identifier` `UNIQUE` index;
- two devices that capture offline settle as two that create tickets offline (`claims.ts`): the
  earlier claim in the log keeps the number, the later one takes a stand-in (`I-STA-12+seq`) until
  the device that made it renumbers it (`settleOne`, from the idea counter through
  `freshIdentifier`), with the system comment; a conflict record and its resolution as for tickets;
- every move is remembered (`identifier-moves.ts`): the old number keeps resolving here, and the
  write guard asks about it;
- a joining workspace moves its ideas, and the numbers its promoted records kept, into the
  repository's idea namespace and clear of every idea number the repository holds or kept, never
  into its tickets' (`cloud/seed.ts`), each with a system comment.

It never parses as a ticket ref (`IDENTIFIER_RE` is `^[A-Z]+-\d+$`; `I-STA-12` has two dashes), and
consumes nothing from the ticket counter. Its own counter is `meta.next_idea_number`, a local
provisional allocator like `next_issue_number`: never synchronized, advanced by the applier past
every idea number that lands on the device (`advanceIdeaNumber`), and, when it allocates, past
every number a row holds as identifier or kept number. **A number is never handed out twice.**

Every reference resolves it (`WorkspaceStore.lookupRow`): `I-STA-12` in any case, `I-12` in its
own workspace, a stand-in, then the kept number of a promoted record, then an alias. A live
identifier always wins over a kept number or an alias, as for tickets. The hub reads the workspace
from the prefix (`Hub.resolveIdentifier`). `Issue.ideaNumber` carries it on every plan record and
is absent on every other issue; `IdeaView.identifier` stays the ticket number (`null` until
promotion) and `IdeaView.number` is the idea number. Refusals name an idea by title and number
(`displayRef`).

**Promotion allocates the ticket number** through the tracker's own counter, on the same row
(`promoteInPlace`): the identifier, the kind and **`plan_idea_number`** change in one journaled
`update`, and `recordIdentifierMove` keeps the idea number as an alias. The alias is this device's
only (`meta`); the column is what a device that receives the promotion, or hydrates long after it,
resolves and shows the number from. Scaffold promotes, so it keeps the number the same way.

**A kept number is a claim too.** One idea number names one record, held as an identifier or
kept. A write that leaves it on two records (a record promoted before an offline capture of the
same number reached the promoting device, or two devices numbering different sets of legacy
records) is settled by the applier (`claimKeptIdeaNumbers`, `cloud/apply.ts`) like any claim on a unique
value: the earlier claim in the log keeps the number. An idea's claim is the write that gave it the
number, a kept number's the write that kept it (the promotion), measured the same way on every
device. Only the device that made the later claim settles it: a later idea is renumbered from the
idea counter, a later kept number by an `update` of `planIdeaNumber` by `staple` with a system
comment (`settleOne`, `claims.ts`). Every claim on an identifier is measured by the device's first
write of that value (`ownValueClaimSeq`), never by its newest write of the field.

**Promotion wins over a late idea number.** An idea number written onto a record that is no
longer an idea (a device numbered a legacy idea before it heard it was promoted) is dropped on
apply, and a promotion's ticket number arriving on a record this device later gave an idea number
is applied. When the promoting device sees the late idea number sit after its promotion in the log,
it states the ticket number again (`ticketNumber` settlement), so the service's fold and a device
that hydrates read the ticket number.

**With planning off** a promoted record says nothing of its kept number (`Issue.ideaNumber` is
left out), and neither the kept number nor an idea number's alias resolves or matches a search.
Nothing is deleted.

**Ideas from before.** An idea an earlier build left under a draft identifier (`~` and its id's
hex) or a ticket number, and a promoted record with no kept number, are numbered in creation order
(`created_at`, `id`) by `PlanStore.numberIdeas`, run when planning is enabled and whenever the
workspace is opened or synced with planning on. It journals as `staple`: an idea's number as a
`renumber`, a claim settled by the log like a settlement's, so two devices that number the same
records before hearing of each other converge with nothing left open; a promoted record's as an
`update` of `planIdeaNumber`, which is exempt from field contests (`conflicts.ts`): staple assigns
it, nobody chooses it, and the last write in the log is the value on every device. Nothing is
numbered while planning is off.

The draft rules still hold for a record still under a draft: in JSON it goes out as
`identifier: null, draft: true` (`hideDraftIdentifiers`), a draft in text as the idea's id
(`draftsAsIds`).

## Storage: eleven columns on `issues`, three tables, no new entity

What an issue cannot already say lives in eleven nullable `issues` columns, eight added by workspace
migration **020** (`020-plan-fields.ts`), one by **021** (`021-plan-delivered.ts`), one by
**026** (`026-idea-numbers.ts`) and one by **028** (`028-plan-ticket-number.ts`), NULL on every row outside the plan, and three tables:
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
| `plan_delivered_on` | plan record | the day the person marked it delivered outside the tracker, `YYYY-MM-DD`, or NULL (below) |
| `plan_idea_number` | promoted record | the idea number it kept when it was promoted, `I-<PREFIX>-<n>`; NULL on an unpromoted idea, which holds it as its identifier |

A horizon's date is its milestone's `target_date`, and its goal is the milestone's acceptance
criteria. An idea's brief, open questions, decisions and text and list plan sections are
documents on the record, so they are revisioned and synchronize as documents already do, and
they stay on the epic after promotion.

The plan fields are left out of an issue's *create* while they are null (`PLAN_ISSUE_FIELDS`,
`nullOmittedOnInsert`), so a task's create carries exactly the fields it carried before; an absent
key on a create reads as NULL, the column default.

## Links and breakdown rows: one synced field each

`plan_links (idea_id, issue_id, linked_by, linked_at, purpose)` holds one row per link. On the wire each
link is one field of the record's `milestone` entity, `planLink.<issue id>`, whose value is
`{ linkedBy, linkedAt }` and whose `null` unlinks. That is the shape criterion marks already use
(`criterion<n>`, [milestones.md](milestones.md#goal)).

A link's `purpose` is `delivery` (the work the record stands for) or `exploration` (research or a
proof of concept done while it is worked out). An exploration link's value carries
`purpose: "exploration"`; a delivery link's value carries none, as before. Only delivery links are
the record's work: they start it, measure its progress, dates and lateness, and make its horizon's
members. Exploration links are listed on the record on their own (`explorations` on its view,
`exploration` on its detail) and change none of that. An issue is linked one way at a time, since
the purpose rides the one field: relinking it the other way rewrites that field, and two devices
linking it two ways offline disagree on one field, a conflict like linking and unlinking it.

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
incomplete" with what it lacks in the drawer, on its Horizons row and in the For agents view; Scaffold and
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

*Provenance.* Each task Scaffold makes keeps the idea and row it came from on its origin columns:
`origin_kind` `plan-row`, `origin_id` `<idea id>/<row id>` (`core/plan-provenance.ts`), written in
its own create. Its id follows from the same pair, so two devices scaffolding offline send one
identical value and no origin claim contends with another record's. Its `context` document opens
with "Scaffolded from idea I-STA-n, breakdown row K, as numbered at scaffold": a snapshot, written
once, so a number sync later moves or a key renamed since is not rewritten there (a document
rewrite would be a synced write of its own); a stand-in number (`I-STA-5+12`) is never written,
and the line names the row alone then. A detail read (`WorkspaceStore.context`,
so `staple show`, `get_task` and the drawer) answers `scaffoldedFrom`: the idea's id, its idea
number and ticket number as they stand now, and the row's key as the breakdown holds it now (null
once the row is removed). A task an earlier build scaffolded has no such origin; the read matches
its id against `scaffoldTaskId` of its parent's rows instead, while the row is still there.

*Sparked ideas.* An idea captured with `sparkedBy` (`staple idea new --sparked-by`, `capture_idea`
`sparked_by`) keeps that ticket the way a finding keeps where it was found: `origin_kind`
`sparked`, `origin_id` `<ticket id>/<idea id>`, unique by construction, in the idea's own create.
An idea, a milestone or an empty reference is refused as the spark before anything is written; it
is written once, with no later edit, as a finding's origin is. The idea's detail and
context answer `sparkedBy`; the ticket's context answers `sparked`, the ideas it sparked, oldest
first. Both stay when the idea is promoted or scaffolded. All three reads are on one record's
detail, a constant number of queries, and no list reads them; with planning off they answer null
and `[]`, and the columns are kept.

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

### Converting a ticket into an idea

**Convert** (`PlanStore.convertTicket`, `WorkspaceStore.convertToIdea`) is promotion run
backwards, for a ticket that should have been an idea: a brainstorm filed as work, or an unplanned
capability found during ticket work. The same row takes the next idea number, the kind `idea`, and
what a capture gives a record (maturity raw, rank at the end of the plan); its id, comments,
documents, files, events, external links, title, description, labels and status stay. Its history
shows it (`ticket_converted`). A person or an agent may convert, as either may capture a raw idea.

*Its ticket number stays a name for it.* The identifier, the kind, the plan columns and
**`plan_ticket_number`** (migration 028) change in one journaled `update`, and
`recordIdentifierMove` keeps the old number as this device's alias. A device that receives the
update records the same move; one that hydrates later has no alias, so `lookupRow` reads the column
after a live identifier and a kept idea number, and before an alias. A live identifier still wins:
a number another issue holds names that issue. The applier keeps the ticket counter past a kept
number (`advanceIssueNumber`, as the record arrives), so a device that only hydrated never mints
it again, and a text search that includes plan records (`kind idea`, `includePlan`) matches it;
task lists, `ls -q` and the toolbar search leave ideas out, as they always do. With planning off neither the column nor an alias that leads to an idea
resolves, on any device.

*What converts.* The ticket and everything under it, parents first: each child becomes a sub-idea
of the record above it, keeping its own history and number. A parent that is ordinary tracker work
is left first, by the tracker's own move (`parent_changed`, the old parent re-derives), because an
idea's parent is an idea; a parent in the plan (a promoted record) stays. Refused, naming every
reason for every record, unless each record is open, in the unstarted or ready band, never started
(`started_at`), not checked out or leased here, has no recorded branch, no blocking edge either way
(a plan neither blocks nor waits), no place in the pickup queue or a milestone, no link to an idea,
no pending review gate, and no stand-in number (sync settles a stand-in by renumbering it from the ticket counter, which
would overwrite the idea number). A milestone or a plan record is never converted.

*Across devices.* A conversion's idea number is the record's first claim on one, as a capture's is:
an update that carries `planTicketNumber` and loses its number to an earlier claim takes the
stand-in a create would (`displaceIdentifierHolder`), on the record until the converting device
settles it. So two devices that convert one ticket and its subtree offline, each minting its own
numbers, end on the log's numbers on every device with nothing open; dropped instead, the losing
writes left each device on its own set. Both wrote the same kept numbers. Neither the kept number nor a conversion's rank is a field contest
(`conflicts.ts`): staple assigned both. A ticket number written onto a record that is an idea once
the write lands (a renumber from before a conversion) is not "promotion over an idea number"
(`displaceIdentifierHolder`): a promotion carries its kind, and without one the log orders the
two writes like any other. An edit another device made before it heard of the conversion is
applied as written, and every device reads the same record: a checkout leaves an idea that is
checked out and in progress, a queue entry stays (the effective queue skips a plan record), and a
move under tracker work or a child filed under the ticket leaves an idea under that work, or work
under the idea. Nothing reconciles these; the person releases, dequeues or moves them. A ticket
converted before its create reached the log keeps the number it had here; if an earlier claim in
the log gave that number to another ticket, the live identifier names that ticket and the kept
number only says what the idea was called on this device.

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
| exploring | edit, ask, decide, shape, drop, schedule, plan dates, reparent, reorder, adopt, mark delivered outside the tracker |
| shaped | edit, ask, decide, back to exploring, drop, schedule, plan dates, reparent, reorder, promote, scaffold, adopt, mark delivered outside the tracker |
| started | edit, ask, decide, schedule, plan dates, reorder, scaffold (only if it was scaffolded), adopt, unlink, reset baseline, open the epic; shape while its maturity is exploring |
| shipped | adopt (linking more work: landed work keeps it shipped, open work reopens it), open the epic; a promoted record adds edit, ask, decide; a record marked delivered outside the tracker adds edit, ask, decide and clear the mark |
| dropped | restore |
| horizon planned | rename, date, reorder, run setting, remove (held back while it is queued) |
| horizon active | rename, date, reorder, queue (held back once it is queued), run setting |
| horizon shipped | remove |

So raw is never scheduled, promoted or linked to work, a started or promoted idea never offers promotion again, an
unpromoted shipped idea offers no edits (only linking more work) unless the person marked it delivered outside the tracker, and a horizon is removed only
while it holds no open work and is not queued, queued only while it holds open work, and given its
run setting until it ships. Each action also says who may take it: the steering actions (maturity
moves, schedule, dates, order, parent, baseline, the delivered-outside-the-tracker mark, every
horizon definition and the run setting) are the person's; the rest are anyone's. A few preconditions need data and travel with the offer as a
`disabledReason`: unlinking needs a link, the epic opens once promoted.

**Its own state against its rollup.** The state reads only the record's own facts: its maturity,
whether it is promoted, and its own links. Its sub-ideas' work is its **rollup**: progress, the
actual window, the forecast and the late and not-started flags read the record's work and every
sub-record's, for the lens row, the header and the timeline. The rollup never changes the state or the
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

A restore lands the record in the state it restores into, so it is held to what that state may
carry, as a capture straight into a maturity is: into shaped only through the shaped gate, into
raw only while it holds no horizon and no planned dates (raw offers neither schedule nor plan
dates, and a dropped record keeps both). Otherwise it is refused, naming what it holds and that
exploring or shaped hold it. The page's Restore, in the drawer and the Dropped shelf alike, is the
offered `restore` action, which restores to exploring.

### Delivered outside the tracker

Work that shipped before the tracker existed, or somewhere it does not reach, is a record the person
marks **delivered outside the tracker**, with the day it was delivered and an optional note. It
then reads shipped with no ticket: no placeholder chore is created, no number is taken, and it is
never a member, queued or checked out (every guard below holds; it is still an unpromoted idea).

- **The mark.** `plan_delivered_on` holds the day; the note is the record's `delivered-note`
  document, written only with the mark (a raw document write of that key is refused, as the
  breakdown is). The day is required, a calendar day, and not after today. Clearing the mark
  empties the note, and clearing a record that carries none is no change, as a maturity it already
  has is.
- **Who and when.** `mark_delivered` is in the exploring and shaped rows: an unpromoted record with
  no work of its own. `clear_delivered` is in no row; a marked record gets it, with edit, ask and
  decide, from one cell on top of its row (`DELIVERED_MARKED`), the way `PROMOTED_ALWAYS` gives a
  promoted record its edits: `ideaOffered(state, promoted, maturity, delivered)`. So a delivered
  record's title, brief, questions and decisions are still edited (by anyone), and its schedule,
  dates, maturity and order are not, as for any shipped record. Both actions are the person's
  (`steeringRefusal("delivery")`), whose refusal tells an agent to adopt the ticket that landed
  the work instead, or to tell the person.
- **What it derives.** One rule each, in `plan.ts`: `deriveStage` reads a marked record shipped
  whatever its maturity, unless work linked to it since is open (open work reopens it, as it
  reopens any shipped record); while no work is present its actual window ends on the delivery
  day, with no start and no forecast, and `isLate` is true only when that day is after the earlier
  of its planned target and its horizon's date; once work is present the window and lateness are
  that work's, as for any record, the window ending no earlier than the delivery day once it has
  all landed; and `isNotStarted` is false. Its maturity stays what the person last set.

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
`moveOffered`) turns exactly those offers into the drawer's buttons, a row's or card's ⋯ menu,
the lenses' drops, the timeline's drags and the command palette; it names which action a drop
is, never whether it is allowed.

## Who steers: agents capture, the person decides

An agent may capture raw ideas (title, brief, parent), edit titles, briefs and plan sections, add,
answer and defer questions, add decisions, adopt work onto an exploring or shaped idea or unlink
it, and promote or scaffold an idea the person has marked shaped. Maturity, horizon assignment, parent, planned dates, order, horizon
definitions, dates and run settings, the baseline, the delivered-outside-the-tracker mark and the
feature flag are the person's.

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
| stage | from its own facts only: `shipped` when the person marked it delivered outside the tracker and no work linked since is open, `started` when it is promoted or links work itself, `shipped` when every issue of its own work that is present is resolved, `dropped`, `scheduled` when it has a horizon, otherwise its maturity (`deriveStage`) |
| progress | done units over all units of the record's rollup ([Accounting](#accounting)): the ticket leaves of its work (itself once promoted, its links, its sub-records'), each leaf once, cancelled leaves not counted, and the planned units of itself and every non-dropped sub-record (rows of a record with no work that is not an umbrella); null before any of that work is started |
| actual window | the first `started_at` anywhere under that work (an epic whose own start is null reads its children's) to the last `completed_at`/`cancelled_at` once all are resolved; work nobody started draws no actual window. A record delivered outside the tracker with no work present ends on its delivery day with no start; with work present, its window is that work's, ending no earlier than the delivery day once it has all landed |
| forecast end | a straight line from the days spent and the share done, while open and partly done |
| late | the work landed, or is forecast to land, after the earlier of the planned end and the horizon's date, or that day has passed while it is open; a record delivered outside the tracker with no work present only when its delivery day is after that line; with work present, that work's window as for any record (`isLate`) |
| not started | nothing linked or promoted, not delivered outside the tracker, and the planned start has passed (`isNotStarted`) |
| rollups | a parent record reads its sub-records' work and planned rows for progress, and their work for dates, the forecast and late / not started, which it displays; never for its stage, state or actions |
| units | a record's own, and a horizon's: [Accounting](#accounting) |
| horizon shipped | its milestone's derived status is done, derived from its open and done work (cancelled work is not counted, so a horizon never derives to cancelled), and never while a record it carries that is not dropped and not an umbrella is not shipped (`heldByPlan`); the page folds a horizon on this flag alone, never on its progress |
| membership | `plan_members`, above |
| dependencies | `dependsOn`: explicit references only (`resolveDependencies`), below |
| plan steps | a carried record's `nextStep` and a horizon's `planSteps`: [Plan steps](#plan-steps), below |

Late and not started are separate facts with separate counts, on rows, horizon headers and the
timeline, and never one number.

### Accounting

What the plan counts is **work items** (`plan-accounting.ts`): one function per fact, read by
every surface, so the Horizons lens, the horizon drawer, the Milestones view, `horizon ls`,
`milestone show` and `milestone ls`, `list_horizons`, `get_milestone`, `list_ideas` and
`/api/plan` report the same numbers. The page computes none. Every percentage is one formula,
`unitPercent`: the whole percent of the counts, rounded down (`floor(done · 100 / total)`), never
of a fraction, so 29 of 50 reads 58 everywhere. A horizon, a record and a link carry it as
`percent`; a horizon at 100 that is not `complete` prints `100% incomplete`.

**A record's own units** (`ownUnits`), the first that applies:

1. it has own work (it is promoted, or links issues present on this device): the ticket leaves
   under that work, each leaf once, cancelled leaves not counted, done and open;
2. it is an **umbrella** (`isUmbrella`): no own work, over at least one sub-record that is not
   dropped. Its sub-records carry its size, so it has no units of its own. A parent's breakdown
   usually names its sub-ideas, and counting both would count that work twice; its rows count
   once they are tickets (rule 1);
3. the person marked it **delivered outside the tracker**: its breakdown rows, at least one, all
   done, none open or planned;
4. it has breakdown rows: one **planned** unit per row, none done;
5. otherwise it is **unsized**: zero units, flagged, never read as zero work.

**A parent's rollup** is its rolled ticket leaves (each once, as before) plus the planned units of
itself and every non-dropped descendant. Its `progress` is done over that total while any of its
work is started (null before, as before). It displays progress; it never changes state or actions.

**The records a horizon carries** are those scheduled on it and, under each, every descendant
that is scheduled on no horizon: a record is carried by the horizon it is scheduled on, else by its
nearest scheduled ancestor's, unless that ancestor is dropped. A sub-idea scheduled on another
horizon is carried there alone, with everything beneath it that is scheduled on none. Dropped
records are carried nowhere. A carried sub-idea's tickets count where they are members, like
anyone's; its planned rows and its hold count on the horizon that carries it.

**A horizon's units** (`horizonAccounting`) are the ticket leaves under its members
(`MILESTONE_MEMBERSHIP`, hand-placed included, each leaf once: exactly what its milestone's
progress counts, `MilestoneStore.leafProgress`) plus the planned units of every non-dropped record
it carries, plus the done units of every record it carries that was delivered outside the tracker
with no own work (no leaf counts those; `deliveredUnits`). `progress = done / (done + open + planned)`,
null when the total is 0. A horizon whose only units are delivered outside the tracker reads
`complete` with no member to derive its milestone's status from, so closing it stays the
person's. The horizon
carries `units: { done, open, planned, total }`, `percent`, `complete` (all its units are done and
nothing holds it: what derives its milestone done), `unsizedCount`, and `records`: the non-dropped
**leaf** records it carries (no live sub-record) by state, `shipped`, `started`, `shaped`,
`exploring`, `raw` (a carried sub-idea not developed yet), their sum `leaves`, and `parentCount`
beside them. `ideaCount` keeps its meaning (every non-dropped record scheduled on it, parents
included), but every surface prints `records`: `3 ideas (+1 parent)`, never the parent as one of
its children.

**The milestone view of a horizon** reads the same derivation (`PlanStore.accountingOf`), with
planning on only: its `progress` adds `planned`, `delivered` (the units of ideas delivered outside
the tracker, in the numerator beside `counts.done`) and `unsized`, `percent` is over
`countable + planned + delivered`, and it is `complete` only when its milestone would derive done: nothing
open, planned or unsized, and no record holding it (`withPlannedUnits`). `milestone show` prints `progress 78/155 50% · 69 planned · 87 leaves`.
Plain milestones, and every horizon with planning off, carry exactly the fields they always did.

**A horizon is not shipped while a record it carries is not.** A carried record that is not
dropped, not shipped and not an umbrella holds its horizon (`holdsHorizon`; `holdOf` counts
them). It reads the record's stage from the same derivation as the record's own view, so a link
whose issue this device lacks is treated alike by both: it is neither landed nor open, a record
whose only links are missing reads started and holds, and one whose present links have all
landed reads shipped and does not. `deriveHorizonStatus` answers the unstarted band where it would
answer done while held, and while held with no members at all.

The hold and its release are **one derivation** from synchronized facts. After every plan write
and every pull (`rederivePlanHolds`, `rederivePlanMilestonesAfterPull`), each horizon whose inputs
moved re-derives its status as a parent does when a child moves, closing included: its status, its
members' statuses and its hold are compared with what this device last settled them from (a
device-local cache in `meta`, never sent), and a horizon whose inputs did not move is not touched.
`deriveOneAncestor` writes only where the status differs, never over a gate, and outside the
pre-work band only over a status derivation wrote. So a held horizon that reads done reopens (on a
device that pulled an idea another device scheduled while this one closed the last ticket), and a
horizon no record holds any more whose work has all landed closes, whether or not derivation ever
wrote its status before: its last holding record was dropped, unscheduled, moved or shipped. A
status a person set outside the pre-work band, or a gate, is left alone. Every device that holds
the same facts writes the same status, and two devices' derived writes of one horizon are never a
conflict: the pull applies the other device's and re-derives from the merged facts
(`cloud/conflicts.ts`, `derivedHorizonWrite`). Derivation owns the status and the timestamps it
writes with it (when the horizon started, completed or was cancelled, and its blocked cycle).
Those timestamps are applied in the log's order, so every device holds the last one written, as
the service's fold does, and a horizon derivation leaves open has its completion time cleared
after the pull (`clearDerivedCompletion`). An open horizon has none; a closed one has one, the
same on every device. A status a person set on either side is still a conflict, and the horizon
keeps its timestamps while it is.

The hold is protection, not presentation: it keys on what the records are, so it holds with the
flag off too, where the horizon reads as a plain milestone that says it is held by its plan
([the flag](#the-flag-experimental-off-by-default)). Dates are calendar days in UTC, inclusive, as for milestones
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
of the database (keyed on the connection's `total_changes()` and SQLite's `data_version`; the views
also on the day): a request that checks a state, writes and answers rebuilds them once for its
write. The facts every view, every horizon's accounting and every hold read (`PlanFacts`: the
records, horizons, work, links, breakdown rows, the plan documents plan steps read, and status categories) are read in a constant
number of statements, whatever the plan holds; each horizon's accounting is computed once per
state. So a warm plan read, a horizon's milestone view and a pull that changed nothing cost what
they cost before the plan counted anything, plus a constant (`test/plan-read-cost.test.ts`). The server
holds an idle kept-alive connection for 65 seconds (`KEEP_ALIVE_MS`), well past SQLite's
five-second busy timeout, so a request a client sent on a reused socket while the loop was busy is
read and answered, never reset.

## Plan steps

A horizon's planned work that is not tickets yet reaches agents as **plan steps** beside its
tickets (`plan-steps.ts`). A step is derived from the plan's facts on every read, never stored,
never claimed and never queued: an idea stays unclaimable, and the resolver never sees a step. Two
functions, and every surface reads them: `planStepOf` says what one record a horizon carries needs
next (or nothing), and `orderPlanSteps` lists a horizon's steps in plan order.

**Which records.** One step at most per record a horizon carries (the one it is scheduled on, or
its nearest scheduled ancestor's; [Accounting](#accounting)) that is not shipped and not dropped:

| record | `need` | `who` | its instruction says, and it lists |
|---|---|---|---|
| raw, or exploring and scheduled on no horizon itself (a descendant the horizon carries) | `brainstorm` | agent | develop it and capture the result on the idea; scheduling and maturity stay the person's |
| exploring, with questions neither resolved nor deferred | `answer_questions` | person | bring these questions to the person and record each answer with resolve; never mark it shaped yourself. Lists `questions` |
| exploring, no open question, the shaped gate not met | `write_plan` | agent | write what the gate names, then tell the person. Lists `missing` |
| exploring, the gate met | `mark_shaped` | person | tell the person it is ready to be marked shaped |
| shaped, its plan edited since so the gate fails (`planIncomplete`) | `fix_plan` | agent | fix what the gate names. Lists `missing` |
| shaped, no own work, waiting | `wait` | nobody | nothing to do yet; never scaffold it. Carries `waitingOn` |
| shaped, no own work, its turn has come | `scaffold` | agent | re-check the breakdown against what has landed since it was written and bring the person any change; then preview and confirm Scaffold, or Adopt existing tickets where its decisions say they come from elsewhere |

A shaped record with its own work (promoted, or linking tickets) needs nothing: its work is
tickets. An exploring record that adopted work (it reads `started`) still yields
`answer_questions` while it has open questions, and nothing after. `who` is who must act next; an
`answer_questions` step is still an agent's to carry, since it takes the questions to the person.

**Waiting.** Shaped with no tickets is a normal resting state, not a to-do: scaffolding waits until
an idea's turn comes. A shaped record with no own work **waits** while its planned start is later
than today, or while a record it depends on (`dependsOn`, explicit references only) is neither
shipped nor dropped; a dropped dependency holds nothing. A record with no planned start of its own
waits on its nearest ancestor's, so a parent whose start lies ahead keeps its sub-ideas waiting
with it; a dropped or shipped ancestor is skipped on that walk, since its dates hold nothing. A record whose Scaffold would also build a sub-idea that waits (Scaffold builds every
shaped sub-idea beneath it) waits too, `waitingOn.records` naming those sub-ideas: scaffolding the
parent would scaffold them early. Its sub-ideas whose turn has come keep their own `scaffold`
steps and are scaffolded one by one. `waitingOn` is `{ start?, records?: [{ id, title, state }] }`. The person releases an idea
early by moving its planned start (or its parent's), which is already theirs; nothing new is
stored. A `fix_plan` step comes before waiting: a plan that fails the gate is worth fixing whenever.

**Order.** Plan order of the records the horizon carries: rank, then id, each parent before the
records beneath it whatever their own ranks, so a `brainstorm` step follows its parent.

**Shape.** `{ ideaId, title, parentId, parentTitle, horizonId, state, need, who, instruction,
questions?, missing?, waitingOn? }`; `horizonId` is the horizon that carries the record, so an
answer that lists several horizons' steps says whose each is.

**Where they arrive, planning on only:**

- each record: `nextStep` on `get_idea`, `list_ideas`, `idea show` and `/api/plan` (null while no
  horizon carries it, or it needs nothing);
- each horizon: `planSteps` on `list_horizons`, `horizon ls --json`, `get_milestone`,
  `milestone show` (and its text: one line per step), `/api/plan` and `/api/issue`'s `horizonPlan`;
- pickup: `queue next` and `next_task` carry `planSteps`: those of the horizon they are scoped to,
  of the horizon of the ticket they answer, and, unscoped, of every queued horizon, each horizon
  once in the plan's horizon order (`PlanStore.pickupPlanSteps`). `next` is still a ticket when one
  is eligible, and null otherwise; never an idea;
- runs: `continue_run`'s take carries the same `planSteps` for the run's scope and the ticket it
  takes, and the run brief lists them as information, never as the session's work;
- an instruction, `horizon-plan`, beside `horizon-run` on every ticket of every horizon and on the
  horizon itself (`instructions.ts`): tickets first; with no ticket left take the first step whose
  `who` is agent; stop for the person on the rest; never scaffold a waiting idea. Its body is fixed
  text, so it changes only with the flag and raises no `instructions_changed` event; a document
  keyed `horizon-plan` on a nearer issue shadows it.

**A run with nothing to take.** A run over a horizon (or over the queue, for its queued horizons)
with no eligible ticket and steps pending answers `stop` with reason `planning_needed` and ends
`stopped`, never `completed`: the horizon's planned work is not done. It comes after
`waiting_on_others` (somebody else is moving a ticket) and before the goal check, `goal_met` and
`scope_empty`. `detail.planSteps` lists the steps; when every one of them is `wait`,
`detail.earliestWait` is the earliest planned start among them, or null when they wait only on
records. No new `action`.

**The horizon's label.** A horizon whose tickets are all done but which still has steps pending
keeps lifecycle state `planned` and does not offer Queue: queueing reaches tickets, and it has
none to reach. Its steps are what its pickup answers and its `continue_run` carry instead
(`queue next --scope` answers `next: null` with non-empty `planSteps`), and its `records` counts and
units say what is left. It is not shipped while a record it carries is unshipped (`heldByPlan`).

**Cost.** The steps read the plan's facts: the records, every record's plan documents in one
statement, and the breakdown rows in the one statement that already counted them. So a horizon's
steps on its milestone view or a pickup answer cost a constant, whatever it carries
(`test/plan-read-cost.test.ts`, unchanged). They are derived once per state of the database and
day, like the views.

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
| `work`: until its work is done | take its work from the queue until every member has landed; nothing beyond it, no goal run | ships itself when its last member lands and no scheduled idea on it is unshipped |
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

The Plan view has three lenses, each with one job (`views/plan/plan-model.ts`), under one toolbar
(`views/plan/PlanView.tsx`). Shaping is the hand-off between the first two: no record is a card
in both. A record still being explored on a horizon also holds a reserved row there (below),
which is not a card. The page computes no number: every count, unit, percent, state, flag and
offered action is the payload's, and an action is drawn only where the record's state offers it.

**Layout follows the Plan container, not the viewport.** The view is a container
(`@container/plan`), because the same parts draw in the drawer and the Milestones view, which
are narrow on a wide screen. Its widths are `PLAN_WIDTH` in `views/plan/plan-parts.tsx`: under
620px the toolbar takes its phone form; under 760px Horizons rows take two lines, Ideas stacks
its panes and the Timeline stacks its rows; under 1040px the Planned column drops and the
Timeline's name column narrows; under 1100px the filter folds to a button. Script that must
know a width (the Timeline's pixels per day, an outline's default fold) measures its element
with a ResizeObserver (`useElementWidth`), never the viewport.

On the phone shell the lens tabs leave the toolbar for the page's title row: the shell's phone
header has an empty slot beside the page name (`data-phone-header-slot` in
`components/AppShell.tsx`, not drawn while empty) and `PlanView` portals a compact
`DetailTabStrip` into it, so the toolbar is one row of at most 44px with the pills, the filter and
**+ Idea**. In the desk shell the tabs stay in the toolbar at every width.

**Landing on a horizon.** A row's horizon chip calls `session.openHorizon`, whose address is
`?view=plan&plan-lens=horizons&focus=<horizon identifier>`; on Plan `session.milestoneFocus` names
that horizon and `HorizonsBoard` takes it as `landing` (matched against the horizon's identifier or
id). The lens scrolls that section to the top after the page has restored its remembered scroll
position, unfolds it for the visit without writing `PlanMemory.folded`, and marks it with a ring
that fades after 1.6s (no ring with reduced motion): the Milestones outline's landing, so a link to
a milestone and a link to a horizon behave alike. The visit's unfolds are per section (`PlanView`
keeps them beside the folds): folding a section ends only that section's visit unfold, and
Collapse all / Expand all ends all of them. The control reads the sections as drawn, so a section
a link unfolded counts as open. Pinned in `test/ui-plan-folds.test.ts`.

**The toolbar** (`PlanBar`) holds the lens tabs with their counts (Ideas: the records the lens
holds; Horizons: `horizons.length`; Timeline: none), the **Show only** pills, the lens's tools
(on Horizons, **Collapse all** / **Expand all** and **+ Horizon**; under 900px of the Plan
container **+ Horizon** is drawn at the end of the outline and the fold control moves to the
right end of the outline's first line as a small text button, 28px high with a 32px tap), the
filter and,
outside Ideas, **+ Idea**, an icon under 900px: a popover with the capture field that leaves the lens where it is and
answers *Captured to Raw* with a link to Ideas. The focus and the filter are
`views/plan/plan-focus.ts`. Each pill reads one payload flag: needs you is
`nextStep.who === "person"`, late is `late` on a record not shipped, not started is
`notStarted`. A pill counts the live records with its flag and is left out at none unless it is
on. `focusPlan` narrows `ideas` to the records that match the focus and hold the filter text in
their title, adds every ancestor of each, and every lens draws that plan. While either is on
nothing folds away (groups, a parent's shipped leaves, a done horizon): the remembered folds are
neither applied nor changed, and the fold control is held with its reason as a tooltip (*Clear
the focus and filter to fold sections*). A lens with nothing
left says *Nothing here matches.* with **Clear filter**. The focus is view state and is not
remembered.

**Ideas is thinking** (`views/plan/IdeasLens.tsx`, its words in `ideas-words.ts`). It holds a
record in its own raw or exploring state. A sub-idea still being explored under started work
stays (`inIdeasLens` reads the record's own `state`, never the rollup). From 760px it is two
panes, each its own scroller; under that they stack in one scroller with sticky headings, and no
lens has a column switcher. **Raw** is a list under the capture field, newest `createdAt` first:
the state glyph, the title, *captured 8d ago* (a difference of `createdAt` and `plan.today`), open
questions, late and not started, and **Explore**, the record's offered `explore` action in one
click. The Dropped shelf sits under it. **Exploring** is a grid of cards: the parent's title,
the title, `briefLine`, the shaping line, then the foot. The shaping line reads the `shape`
action: with a `disabledReason` it prints *To shape:* and the reason, the server's *It needs …
before it is shaped.* wrapper taken off; offered with none, *Ready to mark shaped. The plan
passes the gate.*, a border in the done hue and a **Mark shaped** button that runs the action.
The foot is the sections meter (`completeness`: `total` marks, the `starredTotal` required ones
first and taller, filled to `starred` and to `filled - starred`), `filled/total written`, open
questions, late and not started, the ◇ horizon it is aimed at and the ⋯ menu. Sub-ideas fold
under the card behind their count and rollup words. **One rule changed on purpose:** a card
shows late and not started (`late`, `notStarted`), because the Late and Not started pills pick
cards by them, and a card picked by a flag shows it. It still shows nothing about delivery.
Marked shaped, a record moves to Horizons.

**Horizons is delivery** (`views/plan/HorizonsLens.tsx`): one scroller of stacked sections.
First **Not scheduled**, the shaped, started and shipped records no horizon carries; with
none it is one line on the sunken surface, still the drop target that unschedules; with rows it
is a section whose header has a horizon's fold chevron, at the same x, size and tap. Then a
section per horizon in plan order: a sticky header and the horizon's outline (below). Under
760px only the header's first line sticks (the fold, the name, the date, the server's percent
and the menu, at most 44px); its bar, flags and counts scroll away with the rows. A section
holds the records its horizon carries (`carriedBy`: scheduled on it, or a sub-idea scheduled on
none under one that is), the way its counts read them. The header (`HorizonHeader.tsx`) is the
fold, `HorizonSummary` with the inline rename and date editors, and on the right **Queue** (held
back as *Queued* once it is in the queue), the run setting (`runSettingLabel`) and the ⋯ menu;
under 760px only the ⋯, which holds them as the horizon's offered actions. *add a date* and
*clear* show only where `offers(horizon, "date")`. The rename writes once, on submit or on a blur
that changed the name, and stays open when refused.

**Folds are remembered.** A section's fold is the person's choice, kept per workspace in this
browser with the rest of Plan's memory (`PlanMemory.folded` in `views/plan/plan-memory.ts`): a
`Record<string, boolean>` keyed by horizon id, and `"none"` for Not scheduled. A malformed entry
reads as no choice, and a save keeps only the sections the plan still has (`keepFolds`). With no
choice a done horizon starts folded and every other section unfolded, as before. **Collapse
all** / **Expand all** (`FoldAll`) collapses while any section that folds is unfolded, else
expands, writing the choice for every horizon and for Not scheduled when it has rows; it is
disabled when nothing folds. The Milestones page folds the same way and remembers its folds
alike, so a long plan reads section by section in both places
([web-ui.md](web-ui.md#milestones)).

`HorizonSummary` (`plan-parts.tsx`) is the horizon's header on every surface, in three lines:
the name and the date with its distance from `plan.today` (`Mar 5, 2027 · in 99 days`); a
segmented bar of done, open and planned `units` with the server's `percent` (`100% incomplete`
while not `complete`, [Accounting](#accounting)) and its flags, *Waiting for your approval*
(`awaitingApproval`), *Needs you: n* (`needsYou`: its plan steps whose `who` is the person), late
(`lateCount`), not started (`notStartedCount`) and `✓ n shipped` (`shippedCount`); then its words,
leaf ideas apart from parents and its members (`records`, `memberCount`:
`3 ideas (+1 parent) · 2 members`), leaf ideas by state, and its units. The server sees what the
rows do not (a member added by hand, a record still being explored past its planned start). A
horizon is done only when the server says so (`horizonDone`: its milestone is done, `shipped`;
never its progress, since every counted unit can land while a reopened member, a gated epic or an
idea whose work sits on another horizon keeps it open); then, with no remembered choice, its
section starts folded behind *All n members landed*. The Timeline's group rows read the same fields, and the Milestones
view's own bar reads the same percentage from the milestone's `progress`, with its planned units
as a segment of it.

**Drag to schedule.** A delivery row drags only on an outline at least 760px wide under a fine
pointer. The lens keeps the dragged record from `dragstart` to `dragend`. A section, the Ready
line included, is a target only when `dropChanges` and `moveOffered` both allow the move; one
that would refuse gets no highlight and `dropEffect = "none"`. While a drag is on, a drop rail
pins to the top of the lens with one target per section, Ready first, marked the same way, so a
section far down is reachable without scrolling. A drop writes `dropBody` for its section.

**A horizon's plan is an outline** (rows from `views/plan/plan-tree.ts`, visible lines and keys
from `plan-outline.ts`, drawn by `views/plan/PlanTree.tsx`), one component on three surfaces: the
Horizons lens section, the horizon's drawer and the Plan line of its section on the Milestones
page, all fed by
the server's payload alone. It is a treegrid with the columns Idea, Progress, Next and Planned.
Records group parent to children in plan order, and a parent folds its sub-ideas.

- *Idea*: indent guides, the fold, `StateGlyph`, the title, *in <parent>* for a top row whose
  parent is elsewhere, and late (unless shipped) and not started.
- *Progress*: the record's segmented bar and `percent` where it has both, else its state in
  words: *Shaped · 9 planned* (`units.planned`), *· unsized* (`unsized`), *Shipped Nov 13*
  (`actual.end`) with *outside the tracker* (`delivered`).
- *Next*: open questions unless the step asks them, *plan incomplete* (`planIncomplete`), and the
  plan step in a few words (`nextStep`), in the foreground weight when it waits on the person:
  `wait` reads *starts <date>* or *waits on <record>*, `scaffold` *ready to scaffold*,
  `answer_questions` *needs you: n questions*, `write_plan` and `fix_plan` *plan needed*,
  `mark_shaped` *ready to mark shaped*, `brainstorm` *to develop*. Started work with no step
  reads `linkCount` and `units.open`.
- *Planned*: the `planned` window, empty once shipped.

A sub-idea another horizon carries, or none, is dimmed with *on <horizon>* or *unscheduled* and
draws no bar there. A record still being explored on a horizon is a **reserved row** (VP changed
the one-lens rule): its state and open questions, no ⋯ menu, never dragged, and still a card in
the Ideas lens. Two or more shipped leaves under one parent gather into one line,
`3 shipped: …`, until it is opened. The outline measures its own width (`@container/tree`), so a
narrow drawer gets the compact form on a wide screen: under 760px a row is two lines, the title,
then its state, percent, a short bar, flags, questions and step; indent is 16px per depth with a
rule on child rows; groups start folded and say how many sub-ideas they hold; nothing drags.
Rows are one tab stop with roving focus: Up, Down, Home and End move, Right opens a group or
steps into it, Left folds it or goes to the parent, Enter or Space opens the record or the
shipped line. Each bar's segments grow by its unit counts; the one percent string is the
server's `percent` printed as the CLI's `percentText` prints it. A horizon with an unshipped
scheduled record never folds: the fold reads `shipped`, which such a record holds false. With
planning off none of it renders: the server sends no `horizonPlan`, and a plain milestone's
Milestones view is byte for byte what it was.

**Timeline is time** (`views/plan/PlanTimeline.tsx`, each lane in `TimelineBars.tsx`, the
arithmetic in `timeline-model.ts`). Rows group by the horizon that carries them
(`timelineGroups`, `carriedBy`), as Horizons does, so a sub-idea following its parent's horizon
sits under its parent there; then the records no horizon carries. A row draws the planned window
(a 12px track, or a diamond for a target alone), the baseline as a dashed outline behind it when
it differs, and the actual line under it from `actual`, dashed to `forecastEnd` and hatched past
the planned end, with a ✓ end-cap where the record shipped. An actual window with an end and no
start (delivered outside the tracker, or work completed without a recorded start) is a row
marking the day it landed, with its end-cap. After each bar an end label (`endLabel`):
*shipped Nov 14*, *forecast Dec 15 · 80d over* and *61d past Sep 26* in the destructive colour,
*forecast Dec 6*, *to Jan 30*, each a difference of payload days. A bar's tooltip gives its state
and percent, each window and what it waits on. Records without dates share one line at the end
of their group, a chip each: one that offers `plan_dates` plans four weeks from `plan.today`, the
rest open the record.

- *Range*: 3 mo, 6 mo, Year or All. Pixels per day are the visible chart width over 92, 183 or
  365 days, or the span fitted for All. The default is All from 760px and 3 mo under it; any
  range but All brings today a third of the way in.
- *Axis*: short month names on months wider than 44px, a letter down to 16px, the year in bold
  on January and the first month; a *Today* tag and line, and a ◆ tag and dashed line per dated
  horizon.
- *Links* (`dependencyEdges`) show on demand (`linkView`): those touching the row hovered, the
  bar focused or the record selected, with every row they do not touch dimmed, or all of them
  with **Show all links** and nothing dimmed. Each is a right-angle elbow, red when the record
  waiting starts before the one it waits on ends. That record, unless shipped, carries a red
  notch at the start of its bar at all times (`notched`).
- *Editing*: drag to move and resize, and the arrow keys' week nudge, run only for a mouse or a
  pen and only where the record offers `plan_dates` (`startsDrag`, `nudge`). A finger pans the
  chart, and a tap opens the record, whose Planned fields edit the dates.

From 760px a name column (300px, 220px under 1040px) is pinned on the left with the range in the
corner above it, and the key, **Today** and **Show all links** sit under the chart. Under 760px
(`data-plan-timeline-stacked`) each row is a label line pinned over its own lane, with the end
label at its right, so the chart takes the full width; links show for the selected record only,
and the range, **Today** and a **Key** toggle sit under the chart. The frame
(`data-plan-timeline-frame`) is the lens's one scroller.

**Shared parts** (`views/plan/plan-parts.tsx`). `StateGlyph` draws a record's `state` as a 14px
picture (raw a dotted ring, exploring a dashed amber ring with a dot, shaped a plain ring, started
a wedge filled to `percent`, shipped the check), always beside the state word or in a row whose
name says it, so state is never the colour alone. `Flag` is a filled tag for late, not started,
needs you and waiting for your approval and nothing else; open questions are amber words. Each
flag's text is a token that passes AA on its tint (`--flag-late`, `--flag-todo`, `--flag-you`).
`SegmentedBar` and `HorizonSummary` are shared as above.

**Shipped is one mark** (`detail/ShippedMark.tsx`): a check in the done hue's icon token and the
words, `✓ Shipped Oct 3` or `✓ 4 shipped`, never the colour alone. The state glyph, the horizon
header, the drawer's status line and lifecycle track, a milestone's horizon section and the
timeline's end-cap all draw it, and all read the record's own `state`.

**Reading mode.** The brief and every text and list section of the Plan tab read as formatted
Markdown (`lib/markdown.tsx`), with an **Edit** control only where the state offers the edit
action; Edit opens the textarea, a blur saves what changed and Escape puts it back. Where edits
are offered, the sections with no content wait on one *Not written yet* line of chips, each
opening its editor in place; where they are not, an empty section is not drawn.

### The drawer

An idea opens in the shared detail drawer (`detail/IssueDetailPanel.tsx`), as every issue does.
The tab registry (`detail/tabs/registry.ts`) chooses the strip by kind and state through
`available`: an unpromoted idea gets **Plan** in place of Details, **Connections**, Documents,
Files, Activity, **For agents** (the `get_idea` payload) and **Time** (planned against actual
against baseline). Its header shows the title and one status line, never a ticket number: the
state glyph and words (`statusWords` in `detail/PlanActions.tsx`: the state, *n% done* once
started, *aimed at ◇ <horizon>* while raw or exploring and *on* after, or *not scheduled*, and
the planned window), *plan incomplete*, then late and not started; a record delivered outside
the tracker shows its delivered mark instead. The page addresses the record by its id.

The Plan tab (`detail/tabs/PlanTab.tsx`) reads as a document, in this order:

1. **Where it stands** (`PlanStanding.tsx`). The lifecycle track: Thinking with its maturity,
   Started, Shipped, or *Dropped* in their place. Raw and exploring: *To shape it* with
   *n things left*, or *Ready to mark shaped*, over a checklist of the required sections written
   (`planSectionsOf` in `plan-tab-model.ts`, each going to its section) and every entry of
   `missingForShaped` verbatim with a capital first letter. Shaped: *Ready to scaffold* with the
   task count and hours (`estimateHours`, only when every estimate is plain hours or days) and
   Scaffold's preview and confirm (`ScaffoldSection`), which the header's Scaffold opens
   (`onScaffoldRequest`). Started and shipped: the units in words, the bar and `percent`, the
   start, forecast or ship day and the planned end, late, and for a record started while
   exploring the checklist or a note that it can be marked shaped. Then the `planIncomplete`
   warning, the delivered mark with its note and its clear, and the open questions, each with
   Answered and Defer at its own position, the add field and the answered ones folded.
2. **Properties**: Horizon, Part of and Planned edited in place where offered; Baseline when it
   differs and Actual, read-only. Maturity is no row: the header and the track say it.
3. For started and shipped records, **Work in the tracker**: a row per link with identifier,
   title, status, bar and percent, and unlink where offered.
4. **Section chips**, a sticky row named *Plan sections*: one chip per section in plan order,
   filled where it has content, starred where shaping requires it, a count for lists, and the
   server's `completeness` read out. A chip scrolls its section under the chips; one whose
   section is not drawn is disabled.
5. **The sections** (`PlanSections.tsx`): Markdown at 14/22, Edit on hover and focus. Brief and
   Context fold past 700 characters behind *Show all*. The task breakdown is a table of #, Task,
   Est. and After, *done when: inherits the plan's acceptance* under a row with none of its own;
   a row opens in place to its notes, done-when and owner and to the row editor (inputs on a
   desk, the tap-to-edit card on a phone). Sources shows three and *Show all n* past four;
   decisions show the latest three with their leading ISO day, then *Show all n*. Then sub-ideas,
   with the state glyph and flags.
6. For raw, exploring and shaped records, Work in the tracker with the Adopt field.
7. **Rare actions**: *Delivered outside the tracker…* opens its form (the day, a note, Mark
   delivered) in place, only where `mark_delivered` is offered and no mark is set.

The tab is its own container (`@container/plantab`) and takes its compact form under 512px of
content, a 560px drawer less its gutters: the checklist goes to one column, the breakdown's After
and a link's status are left out, and Edit shows always. Each editor renders only when the state offers its action. Once promoted, the
same record gets the epic's strip, with the Plan tab kept for the plan actions its state still
offers. A horizon opens as the milestone it is: its state, its offered actions (a held one with
its reason), its run setting, then `HorizonSummary` with its risk flags and the outline, above
the milestone's own parts. Its `horizonPlan` carries the records the outline draws
(`horizonTreeRecords`: those it carries, their ancestors and their sub-ideas wherever they are)
and every horizon's name.

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

Plan reuses the detail drawer's `DetailTabStrip`, Radix keys and accessibility; under 620px of
the Plan container it uses its finger-sized segments, wider its underline strip. The last lens,
open record, each lens's scroll position and the Horizons lens's folds are per-viewer
preferences under `staple:plan:v1:<workspace>`. A lens has one scroller each position is kept for
(`[data-plan-board]`, `[data-plan-timeline-frame]`, and `[data-plan-scroll-key]` on each Ideas
pane); the phone column an earlier build kept is no longer read, since no lens has a column
switcher. Filters use the existing workspace/view preference envelope and URL state. The
shareable `plan-lens` and `issue` parameters take precedence on arrival; Back/Forward follows the
URL, and an explicit drawer close clears the remembered record. Storage reads and writes fail
safe. The filter text and the Show only focus narrow every lens; the focus starts again with
each workspace and is not remembered. A horizon's drawer and the Milestones page's Plan line link to each planned
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
- **One idea scaffolded on two devices** creates the same task ids, merged into one set, each with
  the same origin (its idea and row), so a tail device and a fresh one read the same provenance and
  no conflict is raised. An idea sparked by a ticket carries the ticket in its create the same way.
- **A horizon whose only work is cancelled** stays listed on every device and derives again when
  another device reopens the work.
- **A horizon held by a scheduled idea** stays open on every device when its last ticket lands,
  and one that a device derived shipped while another scheduled an unshipped idea onto it
  offline reopens on every device after the pull. One device releasing a horizon (its last
  holding idea taken off) while another reopens a ticket on it offline ends with the status the
  merged facts derive on both, and no conflict.
- **A horizon two devices derive offline** ends with one start time and one completion time on
  every device, a fresh one included, and no conflict. Closed on two devices and reopened by a
  third, or closed before a device joined and reopened by an offline write, it ends open with no
  completion time anywhere. A person's cancel still conflicts with a derived close or reopen, and
  keeps its own timestamps while it does.
- **A mark delivered outside the tracker** is one issue field and one document: a tail device and
  a fresh one read the same shipped record, day and note, and the same again once it is cleared.

## Known limits

- **Experimental.** The model, its surfaces and its storage may change in any release.
- **Mixed builds.** A device that has not migrated refuses a pulled operation page stamped schema
  20 with `schema_ahead`, and one on schema 20 refuses a page stamped 21 (the delivered mark) the
  same way. The snapshot route checks the protocol only, so an older build that
  hydrates from a snapshot drops the plan fields, links and rows and shows each unpromoted idea as
  an ordinary issue under its `~hex` draft. Upgrade every device before planning.
- **The person is declared, not authenticated.** The UI token and `--person` are trusted; an agent
  that uses them is impersonating the person. `reset_idea_baseline` is marked app-only, which asks
  hosts to keep it from the model; that is a hint, not a guarantee.
- **The `idea` kind is reserved.** A workspace already using it for other work cannot enable
  planning until a person resolves those issues; generic kind migration is refused.
- **Dependencies are explicit references only.** A dependency written as prose draws no arrow.
- **Membership is derived per device.** It is rebuilt from synchronized facts and never sent, so a
  device that lacks an issue a link names leaves it out until the issue arrives. Plan steps are
  derived the same way, and read the same on every device once the facts have synced.
- **A step is advice, not a claim.** Two agents reading the same steps can both act on the first
  one whose `who` is agent; Scaffold's fingerprint and its idempotent retry keep a double scaffold
  from creating anything twice, but nothing reserves a step.

## Surfaces

- **CLI** `staple plan enable|show`, `staple idea ls|new|show|set|plan|task|promote|scaffold|import|convert|adopt|unlink|ask|resolve|defer|decide|reset-baseline`,
  `staple horizon ls|new|set|mv|rm`, with `--person` for steering. An idea's ref is its id.
  `staple idea set <ref> --delivered YYYY-MM-DD [--note T] --person` marks it delivered outside
  the tracker and `--undelivered` clears the mark.
- **MCP** `list_ideas`, `get_idea`, `list_horizons` (reads); `capture_idea`, `update_idea` (also
  `plan` sections, `breakdown_base` and `defer_question`; `delivered_on`, `delivered_note` and
  `undelivered` only to refuse them), `start_idea` (promote in place, or with
  `adopt` link an existing issue; answers the promoted `{ id, identifier, kind }` or `null`),
  `unlink_idea`, `scaffold_idea` (preview without `confirm`; with it and the preview's
  `fingerprint`, create); `convert_to_idea` (a ticket into a raw idea; answers the idea, each
  `{ from, to, title }` converted and the parent it left); `reset_idea_baseline` (a view button).
- **HTTP** `GET /api/plan` (each record with `state`, `actions`, `completeness`, `dependsOn`,
  `units` and `unsized`, each horizon with `shippedCount`, `units`, `unsizedCount`, `records`,
  `progress`, `runMode`, `goal` and `awaitingApproval`),
  `GET /api/plan-idea?ref=`, `GET /api/issues` (each row with its `horizon`, horizons themselves
  left out); `POST /api/plan/{enable, capture, update, question, resolve, decision, promote,
  scaffold, adopt, unlink, reset-baseline, horizon-create, horizon-update, horizon-remove,
  horizon-queue, horizon-run}`; `update` and `capture` take `plan`, `update` takes
  `breakdownBase` and `delivered` (`{ on, note }`, or null to clear), `resolve` takes `deferred`, `scaffold` takes `preview` or the preview's
  `fingerprint`. Every write answers `{ plan, idea }`. `GET /api/issue` adds `planRecord` and
  `horizonPlan`.
- **Web UI** the Plan view with its three lenses, the shared drawer, and the Tasks horizon chip,
  grouping and filter ([web-ui.md](web-ui.md)). Cards and rows never show a number; a promoted
  record's detail does. On Ideas a sub-idea in its parent's pane folds under the parent's card;
  one in the other pane shows there, labelled with its parent. Under 760px of Plan width Ideas
  stacks its panes, Horizons draws two-line rows and the Timeline pins each name over its lane;
  the timeline scrolls inside its own frame.

## What the tests prove

| test | proves |
|---|---|
| `test/planning-feature*.test.ts(x)` (the base suite, surfaces, sync, protocol, poll, review, UI) | the flag: off by default, person-only on every surface, off hides every surface and keeps the data, on restores it, protection holds in both states, the flag and the Later upgrade sync |
| `test/store-plan.test.ts` | enabling and its refusal; identity (no counter consumed, never a ref, never shown, numbered at promotion, earlier builds' numbers drafted); every guard; the tracker's own writes, horizon dates included; dependencies; nesting and stage; horizons as milestones; membership (move, unschedule, unlink, plan order, hand-placed members stay, a promoted record counted, a queued horizon expanding); a horizon's own status (its only work cancelled with and without a rebuild between, reopened; shipped on done work only; removal refused while it holds open work or is queued; an edit of a removed horizon refused before any write); Promote in place, under a promoted parent, refused when dropped or already promoted; Adopt on a promoted record; missing links; actual windows on real-shaped data; late vs not started; the baseline; every steering refusal |
| `test/plan-sections.test.ts` | the importer on fixtures shaped like real plan files: every row kept, sections mapped, nothing dropped, what it cannot place reported; wrapped and nested items, prose under list headings, headings and comments inside code fences, escaped pipes, repeated keys and front matter kept, each said; unknown keys named; sections round-trip through their documents; every estimate form, and why one reads as none; cycles, unknown and repeated keys in the gate; the gate's phrases; completeness |
| `test/plan-scaffold.test.ts` | sections persist as revisions, an agent writes them, duplicate keys refused; the gate on every path to shaped, deferred questions let through; an umbrella shaped on a sub-idea that is not dropped, refused when every sub-idea is dropped, plan incomplete when its last one is; Scaffold creates exactly its preview, idempotently and for rows added later, nested sub-ideas as child epics, an umbrella with no rows as its epic and its shaped sub-ideas' epics, previewed and retried after its confirm and building a sub-idea shaped since, never where the lifecycle does not offer it; import with its file attached |
| `test/plan-scaffold-surfaces.test.ts` | the gate on the page, the CLI with `--person` and an agent over MCP, an umbrella's included, and an import into shaped held to it; the `idea defer` help says what the gate asks; the three Scaffold previews agree and write nothing; a confirm creates once whichever surface retries, an umbrella with no rows previewed and retried on the CLI after its confirm; CLI import |
| `test/plan-scaffold-guards.test.ts` | a shaped plan hollowed by an edit stays shaped, says what it lacks, holds Scaffold and Promote back and refuses both; the breakdown never written as a document; every malformed plan payload refused by name; import into shaped held to the gate; the source file attached byte for byte; a confirm refused without a fingerprint and on a changed plan; no preview where Scaffold is not offered; inherited acceptance, labelled; blockers added and never removed; a renamed key keeps its task; tasks named by idea and row; a stale breakdown save refused; one row edited writes one row |
| `test/cloud-plan-sync.test.ts` | under both folds: the plan, its membership and its numbers converge on a tail device and a hydrated one; offline adopts and unlinks; offline moves derive the same membership with no conflict; two offline promotions end with two distinct numbers; a third device never shows a numberless epic; a horizon whose only work is cancelled stays listed; a horizon a scheduled idea holds stays open, reopens after a concurrent close, and converges with no conflict when one device releases it while another reopens its ticket; a horizon's start and completion times converge with no conflict when devices derive it offline, a person's cancel still conflicts, and a plain milestone is unchanged; an idea an earlier build numbered resolves by its old number |
| `test/cloud-plan-promotion-identity.test.ts` | under both folds: one idea promoted on two devices offline ends on one number per record on every device and a fresh one, no number on two records, no open conflict |
| `test/cloud-plan-breakdown-sync.test.ts` | under both folds: different rows edited or added offline both kept with no conflict; one row edited on both is a recorded conflict, and resolving it settles both; two devices scaffolding one idea create the same tasks, and one umbrella with no rows the same epics, which either device or a fresh one retries after sync to build a sub-idea shaped since |
| `test/sync-mutation-convergence.test.ts` | every `PlanStore` mutation, and `promoteInPlace`, converges column for column, the plan columns included; the delivered mark and its clear among them |
| `test/plan-delivered.test.ts`, `test/cloud-plan-delivered-sync.test.ts` | a record delivered outside the tracker: shipped with no ticket and no number, never a member, queued, checked out or listed; late only when delivered after its line, never not started; offered in exploring and shaped only; its day required and not in the future; the person's alone, an agent told what to do instead; its edits and the clear; the note kept to the mark; reopened by open work linked since; refused with planning off and back when it is on; the same on a tail device and a fresh one under both folds |
| `test/plan-surfaces.test.ts` | CLI, MCP and HTTP read one plan with no idea numbers and no draft shown on any surface, consume no number at capture, refuse the same agent writes, promote into the horizon's milestone, and let the person steer |
| `test/plan-lifecycle.test.ts` | the table itself, pinned: every state's actions, who takes each, the promoted record's epic edits, Mark shaped on a record started while exploring, adopt from exploring on and never raw, back to raw offered nowhere, how a maturity change is named, the delivered mark in exploring and shaped and the marked record's edits and clear |
| `test/plan-lifecycle-surfaces.test.ts` | every idea (state, write) cell and every horizon (state, action) cell agrees with the table on HTTP, MCP and the CLI with and without `--person`; every payload carries exactly the table's row; a record started while exploring carries the started row and Mark shaped, and only the person shapes it; a record delivered outside the tracker carries the shipped row with its edits and the clear, the mark and the clear are the person's on every surface, and a mark without a day is refused before anything is written; every document and file write in every state |
| `test/plan-own-state.test.ts` | with hand-written expectations: a parent's own state against its rollup; a sub-idea promoted on its own and re-parented by its parent's promotion; a promoted record edited as an epic once shipped; an exploring idea that adopts work reads started, keeps its maturity, offers Mark shaped, joins its horizon, keeps its baseline and stays out of the tracker; every document key, restore and file on a shipped, dropped or raw idea |
| `test/plan-lenses.test.ts`, `test/plan-lenses-review.test.ts` | what the lenses read: dependencies only from explicit references, a sub-idea's title key over its ancestor's row key, never a wait between a record and its ancestor or descendant; completeness and `dependsOn` on the payload; a horizon's shipped count, progress and server counts; Queue and the run setting offered and held back; each issue's horizon; the run setting is the person's on every path, reaches every ticket as the `horizon-run` instruction, and allows a goal run only when set to `goal` |
| `test/plan-accounting.test.ts`, `test/plan-accounting-surfaces.test.ts` | a horizon's done, open and planned units and its percentage, the same on the plan, the milestone view and every CLI, MCP and HTTP surface; unsized ideas never zero work; leaf ideas counted with the parent apart; a parent's rollup counting its sub-ideas' rows once; plain milestones and planning off unchanged; a horizon held open by a scheduled idea when its last ticket closes, in both flag states, released when the idea is dropped or moved (closing whether or not derivation wrote its status before), reopened when one is scheduled onto it, with or without members; a scheduled parent carrying its sub-ideas scheduled on no horizon, a sub-idea scheduled elsewhere counted there alone; `complete` and the page's fold false while every counted unit landed but an idea holds it; one whole percent rounded down from the counts; the hold reading the record's own stage, missing links included; with planning off, the hold named in the refusal and on the milestone view |
| `test/plan-steps.test.ts` | one test per row of the step table with hand-written expectations (need, who, the questions, the gate's missing sections, `waitingOn`), deferred questions left out, a dropped dependency holding nothing; the person releasing a waiting idea by moving its planned start, a sub-idea waiting on its parent's, and a parent waiting while its Scaffold would build a waiting sub-idea; an exploring idea that adopted work asking its questions and then needing nothing; shaped with work, shipped, dropped and unscheduled records needing nothing; plan order, a parent before a sub-idea that ranks earlier |
| `test/plan-steps-pickup.test.ts` | a pickup answer scoped and unscoped carries the steps in plan order beside its ticket, the ticket's horizon's and every queued horizon's; with no ticket `next` is null and the steps stay; no idea ever named; a goal run over a horizon and a run over the queue stop `planning_needed` (not `goal_met`, not `scope_empty`) and end `stopped`, with `earliestWait` when every step waits; the stop rules' order; the take and the brief carry the steps; `horizon-plan` reaches every ticket wherever `horizon-run` does, and the horizon; with planning off, a run takes and ends as before |
| `test/plan-steps-surfaces.test.ts` | `planSteps` and `nextStep` the same on the CLI, MCP and HTTP; `queue next` and `next_task` agree scoped and unscoped, with `horizon-plan` among the instructions; a horizon with only steps left reads `planned` with no Queue; with planning off, every pickup, milestone, task and issue surface answers byte for byte the same while the steps underneath change, with no step, field or instruction |
| `test/cloud-plan-steps-sync.test.ts` | under both folds: two devices that change the facts under the steps offline, and a freshly hydrated one, read the same steps; reading them adds nothing to the outbox and no column stores them |
| `test/plan-read-cost.test.ts`, `test/ui-server-keep-alive.test.ts` | a plan read derives once per state of the database, and ten more records add no more statements than they did before the umbrella gate; a warm plan read costs nothing more per record or per horizon, a pull that changed nothing a constant and no mutation, a horizon's milestone view what a plain milestone's costs plus a constant; kept-alive sockets outlive SQLite's busy timeout |
| `views/plan/lenses.test.tsx`, `views/plan/plan-model.test.ts` | the lenses' membership; an Ideas card's written sections, horizon, late and not started and nothing about work; a horizon section's header, Queue and run setting; the fold of a done horizon only; the shipped mark; the Timeline stacked under 760px, its default range, end labels, dimming by the selected record's links, the notch, the target diamond and the undated line; end-caps and arrows (none between a record and its ancestor); Markdown reading mode; board columns, nesting, timeline groups, range and dragging |
| `views/plan/plan-view.test.tsx`, `views/plan/plan-focus.test.ts` | the toolbar's lens counts, the labelled Show only group with the payload's counts, a pill with none left out unless pressed, and + Idea on Horizons and the Timeline only; each pill's count from its payload flag; a focus or the filter text narrowing every lens to the matches and every ancestor of each, never a shipped late record or a dropped one; *Nothing here matches.* with Clear filter |
| `views/plan/ideas-lens.test.tsx` | a raw row's capture age, newest first, and Explore only where offered, running that action's write; an exploring card's shaping line without the server's wrapper, Ready to mark shaped with Mark shaped running the shape action's write, the brief line and the sections meter from the server's counts; both panes at every width with no column switcher; the empty panes' words |
| `test/plan-memory.test.ts`, `test/ui-plan-folds.test.ts` | a section's fold kept as a yes or no whatever else the stored folds hold, and dropped on save for a section the plan no longer has; in Chromium, a fold remembered across a reload and a lens change, Collapse all folding every section, the control held while a filter is on with no fold applied and the folds kept for after, Not scheduled's chevron at a horizon's x, size and tap, and the control at the right end of the outline's first line where the toolbar has no room |
| `views/plan/horizons-outline.test.tsx` | Not scheduled as one quiet line that still unschedules, or a section with its count, by that one name on the drop rail and in the move menu; a parent's shipped leaves gathered into one line ahead of the rest, opened on request, never fewer than two; a compact outline's groups folded with their count; a focus or filter folding nothing and drawing no fold control; with no choice a done horizon folded and the rest open, a remembered fold and unfold applied, Not scheduled's chevron when it has rows, and Collapse all and Expand all; the drop rail and sections marked only for a move the state offers and that moves the record; add a date and clear only where offered; the row keys |
| `views/plan/plan-parts.test.tsx`, `views/plan/timeline-model.test.ts`, `styles/contrast.test.ts` | the state glyph hidden from assistive technology, its word on request, the started wedge from the server's percent, never empty or whole; flags in words; the horizon summary's date and distance, percent, flags, counts and units, a done horizon shipped without late or not started; the Timeline's pixels per day for each range, today a third in, every end label, links on demand and Show all links, the notch never on a shipped row, the elbow, drags for a mouse or a pen only where dates are offered, the week nudge, folding, the axis labels; the flags' text AA on their tint in both themes |
| `views/plan/plan-tree.test.ts` | the tree with hand-written expectations: a parent with its sub-ideas, one carried elsewhere dimmed with where, one scheduled nowhere, one carried through its parent, dropped ones left out; reserved rows; the group's rollup and a leaf's own units; the same tree from the whole plan and from a horizon's detail; the records no horizon carries (Not scheduled); every step's words and whether it waits on the person; the header's words; `100% incomplete` |
| `views/plan/plan-tree-render.test.tsx`, `views/milestones/milestones-flag-off.test.tsx` | the lens section, the horizon drawer and the Milestones view draw the same rows, header, bars, steps and "Needs you" for one payload; a reserved row is never a card or dragged and stays a card in Ideas; a horizon at 100% that is not complete never folds; on a wide outline sub-ideas show without a click and only delivery rows drag; on a compact one a disclosure folds them and nothing drags; a plain milestone's Milestones view, and any with planning off, byte for byte the markup recorded before the tree |
| `test/plan-tree-payload.test.ts` | each record's `own`, `umbrella` and `carriedBy`, and each horizon's `needsYou`, the same on the CLI, MCP and HTTP; a horizon's detail carries every record its tree draws and the horizons' names; with planning off none of those fields on any surface that still answers |
| `views/tree/horizon-axis.test.tsx`, `test/ui-horizon-chip.test.ts` | the Tasks horizon chip, grouping and filter |
| `detail/plan-drawer.test.tsx`, `command-palette/commands.test.ts` | an idea's tab strip and the epic's once promoted, no ticket number anywhere, actions exactly as offered, a read-only title where no edit is offered; palette commands from the offered actions only |
| `detail/idea-drawer.test.tsx` | the header's one status line; Where it stands in each state: `missingForShaped` verbatim beside the required sections written, ready to scaffold with hours only from plain estimates, the incomplete warning, work under way, the note for a record started while exploring, the delivered mark and its clear; open questions with Answered and Defer, none offered where asking is not; properties with no maturity row and the work's place by state; the section chips; Brief, Context, Sources and decisions folded; the breakdown as a table; *Not written yet* only where edits are offered; sub-ideas with the glyph and flags; the delivered form only where the mark is offered |
