---
title: Web UI
description: The local browser app that staple open serves, with every view it has, what each one shows and changes, and how it authenticates.
---

# Web UI

```bash
staple open      # serves the app and opens it in your browser
```

One command, no daemon: the server runs in the foreground and Ctrl-C closes it
along with every database handle, then exits 130 (143 for SIGTERM). A second
Ctrl-C or SIGTERM while it is closing is absorbed, not treated as a harder kill.
It prints `staple ui — <mode> at http://localhost:<port>/` and a second line
saying that a browser on this machine needs no token and where API callers find
it (see [Auth](#auth)). The port is `config port` (4400 by default); an implicit
port that is busy falls back to a free one, an explicit `--port` that is taken
fails. `--hub` serves every registered workspace at once. Whether a browser
opens follows `--browser` / `--no-browser`, then `config
browser=auto|always|never`. `staple ui` is an alias.

## Views

Six views, one per entry of `VIEWS` in `src/ui/app/src/lib/session.ts`, plus the
surfaces that open on top of any of them.

| View | What it shows | How to reach it |
| --- | --- | --- |
| [Tasks](#tasks) | Every issue as one tree, parents over children, with grouping, sorting, filters, search and the pickup cues | Rail and tab bar *Tasks*; "Go to Tasks"; a project row under it; `?view=tasks` |
| [Queue](#queue) | The pickup order as one tree: the plan, what each queued epic or milestone expands to, what comes next, and the editor for it | *Queue*; "Go to Queue"; `?view=queue` |
| [Graph](#graph) | Issues as a node graph: epics as containers, dependencies as edges | *Graph*; "Go to Graph"; `?view=graph` |
| [Milestones](#milestones) | Milestones in plan order, each with progress, risk, members and its goal | *Milestones*; "Go to Milestones"; a row's milestone marker; `?view=milestones` |
| [Estimates](#estimates) | How long work took against its estimate, per group of similar work | *Estimates*; "Go to Estimates"; `?view=estimate-accuracy` |
| [Usage](#usage) | This computer's provider limits and the pace against each one | *Usage* under *This computer*; "Go to Usage"; `?view=budget` |
| [Task detail](#task-detail) | One issue: details, connections, documents, activity, the agent payload and time | Click or Enter on any row, node or reference |
| [Autopilot runs](#autopilot-runs) | Live runs, their history, and a notice when one stops | The rail's *Autopilot* section; a task's run line |
| [Settings](#settings) | Statuses, kinds, workflow settings, cloud, usage capture | The rail's *Settings*; the palette; `?settings` |
| [Choose a workspace](#choose-a-workspace) | Shown in place of Queue or Estimates on *All workspaces* | Opening either view with no workspace chosen |

The command palette (`⌘K`), the New task dialog (`c`), the project dialog and
the dependencies dialog also open over any view. **New task**
(`components/CreateIssueDialog.tsx`) asks for the workspace (in hub mode),
title, description, kind, priority, parent, project, labels, *Blocked by* and
*Blocking*; the relation fields only offer tasks that exist in the target
workspace, nothing is validated in the browser, and a refusal is the store's
own sentence. It posts to `POST /api/action`.

## Layout

The app has two shapes, split at one breakpoint: 768px (`DESK_MIN_WIDTH` in
`lib/use-media.ts`; Tailwind's `md:` is the same width). From 768px it is the
**desk**: a rail, a top bar, a toolbar and the view. Below it, it is a **phone**
app: a top bar, the view, and a tab bar.

**The frame.** The page is the sidebar tint and the content is a card on it:
one hairline, rounded corners, and an 8px gutter round it.
Below 768px the gutter and the radius go and the frame is `100dvh`. Dark mode
is charcoal, not near-black. Every shell size is a token in
`styles/system-tokens.css`.

**The rail** is 240px (264px from 1680px) and reads top to bottom:

- the brand mark and a *Hide navigation* button;
- in `--hub` mode, the **Workspaces** group: *All workspaces*, then each
  registered workspace with a one-letter tile, capped at six (the current one is
  always kept) with the rest behind *More workspaces*. A single-workspace page
  lists none;
- **Views**: *Tasks*, *Queue*, *Graph*, *Milestones*, *Estimates*;
- **Autopilot**, once the workspace has had a run: one card per live run and a
  *Run history* row (see [Autopilot runs](#autopilot-runs));
- **This computer**: *Usage*, at the bottom of the rail;
- the foot, above a hairline: *Settings* and a dark-mode switch
  (`role="switch"`, remembered under `staple:theme`).

Rows are 32px (44px on a touch screen). The active view carries
`aria-current="page"`; a group header is a disclosure button whose chevron
shows on hover and focus. The groups are data (`components/nav/nav-model.ts`,
an array of groups of items), so moving a view between groups is an edit to
that array and not to the rail. *Usage* sits apart because budget readings are
this computer's: the view takes no workspace, and no workspace row is marked
current while it is open.

**Projects hang off Tasks.** The Tasks row carries a `+` (*New project*),
visible on hover and focus and always in the tab order, that opens the project
dialog. Every tracked project is a sub-row beneath it (see
[Projects](#projects)): the name and its open issue count, which gives way to a
gear (*Project settings*) on hover. Clicking a project switches to Tasks and
narrows it to that project's issues, and nothing else; the row then carries
`aria-current="true"` for as long as Tasks is filtered to exactly it. On *All
workspaces* the rows are captioned with their workspace, which is what tells two
projects with one name apart.

The rail collapses with `[` or `⌘\` (Ctrl-\ elsewhere) and remembers that it
did (`staple:rail:v1`); a *Show navigation* button then appears in the top bar.
A bare `[` typed into a field, or pressed while a menu or dialog is open, is
not a toggle.

**The top bar** (52px) names the scope and the view: "All workspaces › Tasks"
or "staple › Tasks" (the workspace's name), where the scope opens the workspace switcher in hub
mode, and "This computer" on Usage. Beside it sits the sync pill (below), then,
on the right, the palette field (*Find a task or command*, `⌘K`) and the
**New task** button (`c`). The browser tab is titled `View · Scope · staple`.

**The sync pill** says the workspace's sync state in a word or two
("Synced", "Offline", "2 waiting to send"); a click opens a short card with what
that means and the technical values behind *Show details*. It renders nothing
when the workspace is not connected, and it never prompts you to connect. It
reads `/api/cloud/status` once per workspace shown (on *All workspaces*,
`/api/cloud/workspaces` once), never on the poll. See [sync.md](sync.md).

**The toolbar** (44px) is only on views that use it (`viewControls` in
`lib/session.ts`): Tasks has all of it, Graph has the filters only, Milestones
has only *Done*, which moves into the top bar, and Queue, Estimates and Usage
have no toolbar. On the left: **Filter** with its count as a badge, then the
**quick filters**, one click each: *My tasks*, *In progress*, *Blocked*, *High
priority*, *Bugs* (only where `bug` is a configured kind) and *Unassigned*
(`components/filters/presets.ts`). Each is an ordinary filter, so a quick
filter and the same filter built in the menu are one thing. *My tasks* asks
once which assignee is you and remembers it in this browser (`staple:me:v1`).
On the right: **Group**, **Sort**, **Done** and the **search** field. Controls
are 32px. Below 1280px their words drop and they become icon buttons with
tooltips, and the search folds into an icon that opens in place. Escape in the
search clears it; a second Escape leaves the field.

**On a phone** the top bar holds the menu button (the rail as a drawer, at most
85% of the width, closed by a row, the scrim, Escape or Back), the workspace
switcher as a pill (a bottom sheet), the sync state as one icon, search and New
task. Under it, the view's name large, its controls as 44px icon buttons, and
the active filters as one sideways-scrolling row. A bottom **tab bar** holds all
six views (`components/nav/ViewTabBar.tsx`). On a touch screen, controls grow to
44px at any width.

**The address follows the page.** The workspace, the view, the search text,
the done toggle, a milestone focus and every filter are written into the URL
(`ws`, `view`, `q`, `done=1`, `focus`, one parameter per filter dimension;
`lib/session-url.ts`), so a link opens the same page. Going to another view or
workspace pushes a history entry, so Back returns from it; narrowing the list
replaces the entry. An address naming a workspace the hub does not have lands on
*All workspaces*. The page re-reads on a change fingerprint polled every 1.5s
(`lib/useStaple.ts`), so a write from the CLI, MCP or another tab shows within
one poll.

### Keyboard

| Keys | Where | Does |
| --- | --- | --- |
| `⌘K` / Ctrl-K | anywhere, even in a field | opens or closes the command palette |
| `c` | anywhere but a field or open dialog | New task |
| `[`, `⌘\` / Ctrl-\ | anywhere | hides or shows the rail |
| ↑ ↓ ← → Home End Enter Space | the Tasks grid | move, fold and unfold, open |
| `s` | a focused task row (desk) | opens the row's status menu |
| `j` / `k`, Alt-↓ / Alt-↑ | task detail | next or previous task in the list on screen |
| Escape | an open surface | closes it (the palette, a dialog, the detail, the phone drawer) |
| Alt-↑ / Alt-↓ | Queue and Milestones rows, settings lists | move the row up or down |
| Alt-Home / Alt-End | Queue rows | move the row to the top or bottom |

The palette's first group lists "Go to Tasks", "Go to Queue", "Go to Graph",
"Go to Milestones", "Go to Estimates" and "Go to Usage" (all but the current
view), "Settings", "Settings: Usage", "Settings: Cloud account" and "Settings:
Statuses", and in hub mode "Switch to All workspaces" and "Switch to"
followed by each workspace's name.

## Tasks

The Tasks view (`views/TreeView.tsx`, `views/tree/`) is every issue of the
scope as one tree, read from `GET /api/issues` (resolved work included, hidden
by the Done toggle until you ask for it). On *All workspaces* it shows every
workspace's issues at once. It has the whole toolbar: Filter, the quick
filters, Group, Sort, Done and search.

**Rows.** A row is 40px on a desk (44px on a touch screen) and one 48px line on
a phone. Left to right it carries the priority signal, the fold chevron, the
status icon (a button: its menu, or `s` on a focused row, changes the status),
the kind glyph, the identifier and the title, then the cues below, the
*Autopilot* badge when a run holds the task, dependency badges (what it waits
on and what waits on it; a click opens the dependencies dialog), labels, a
worklog cue (whether somebody else could pick it up), one avatar for the claim
and the assignee, and the date it last moved. As the window narrows the row
drops the least useful parts first, in a fixed order
(`COLLAPSE_LADDER` in `components/task-list/row-layout.ts`): the second label
below 1280px, label names below 1024px, the worklog cue below 960px, the date
below 880px, the rolled-up plan and cue words below 768px, and the decorative
marks and the identifier below 480px. A folded parent shows its sub-tasks'
progress and, when they are estimated, their plan (*about 6 days of work*; `est
6d5h` on a phone). The `⋯` menu on a row is the [row menu](#queue) (open,
change status, queue). A refused status change shows as a notice under the
row.

**Keyboard.** The grid is one tab stop. ↑ / ↓ move (Shift extends the
selection), → unfolds or steps into the children, ← folds or goes to the
parent, Enter opens the row (or folds a group header), Space selects, Home and
End jump, and Escape clears the selection, then closes the detail.

**Search.** The toolbar's search field narrows the list by text as you type;
it is part of the filter state and of the address (`q`).

### Grouping

The tree is ungrouped by default: one hierarchy, parents over children. The
"Group" control adds an axis (*Status*, *Pickup order*, *Epic* or *Kind*;
*No grouping* goes back) and each axis is a way of *displaying* the same rows,
never a second copy of them. *Pickup order* reads `GET /api/inbox`: the store's
own dependency-ordered sections, with *Pending approval* first.

**Milestones in the tree.** Ungrouped and under every axis but Epic, a row with
no parent that is a direct member of a milestone is drawn under that milestone,
in the list's copy only; a real parent always wins. A milestone row opens one
level by default.

**Expansion.** Every parent has one expand/collapse state, keyed by the issue
and shared by every axis, so an epic folded in the ungrouped view is folded
under Group by Epic and vice versa; the choice survives the poll, a view switch,
and a reload. On first visit — before you have clicked anything — a parent is
**open when it, or anything beneath it, is active** (in progress, in review, or
blocked) and **folded otherwise**, so live work is on screen and the backlog is
not a wall. Group by Epic uses exactly that default; the epic's own row is the
top of its section, its chevron is the only fold, and nothing is collapsed on
your behalf.

**Epic sections.** Under Group by Epic every row sits under its top-level
ancestor, with the epic itself as the section's first row (dimmed, when the
current filter removed it) and "No epic" last for rows that have none. Adjacent
sections are separated by one rule — 8px of air plus a hairline — whether the
next section is headed by a real epic, a ghost of one, or the "No epic" header,
at every width. There is no gap between an epic and its own first task.

### Row cues

Ungrouped is the normal working view, not the absence of information. Every row
in it carries four readings, and none of them changes the row's height (the
`--row-height` and desk-row sizes in `components/task-list/task-list.css` and
`desktop-row.css`):

- **Status**: the status icon, in its own column.
- **Kind**: the glyph the workspace configured for that kind (see
  [Glyph catalog](#glyph-catalog)). A plain task's glyph is left out on a desk.
- **Pickup**: one glyph, and a number when there is one, right of the
  identifier. Below 480px the marks become one plain pill.
- **Milestone**: a `◇` marker when the row is planned under a milestone, shown
  on a desk as a chip with the milestone's name. It is a button: it opens the
  Milestones view with that milestone focused.

**The pickup cue speaks the queue's vocabulary** (see [queue.md](queue.md)), one
word per row, first match wins:

| Cue | Glyph | Prints | Means |
| --- | --- | --- | --- |
| Pickable | `▸` | `next` | the one row the resolver would hand an agent right now |
| Queued | `#` | `#5` | eligible, but the plan puts an earlier row first — the **effective** position |
| Queued (container) | `#` | `plan #2` | an epic or milestone the plan holds — the **plan** position |
| Waiting | `⋯` | — | an unresolved blocker, or a blocked status |
| Gated | `⚑` | — | a human review gate holds it, or it stands behind one |
| In flight | `◐` | — | somebody is holding it, or it is already being worked |
| Unqueued | `·` | — | not in the pickup plan — still work, just later |
| Unavailable | `–` | — | its status cannot be checked out |

A **resolved** row has no pickup cue at all: finished work is not waiting for
anything, and saying it is "not pickable" would file it beside work that is stuck.

**Two numbers, and they are not interchangeable.** An actionable row prints its
position in the *effective* order — the sequence an agent receives — and a
container prints the position of the *plan* row it sits at, spelled out as
`plan #2` so the two can never be read as one scale. A container is never in the
effective order (the resolver expands it in place), so it never gets an
effective number, and a leaf never borrows its container's plan number.

**Glyph and word, never colour alone.** No cue carries a hue. Every one of them
has a `title` tooltip and screen-reader text saying the same sentence — the word
first, then what it means, then the position, then the queue resolver's own
reason where there is one ("STA-3 is queued behind STA-9, awaiting approval by
VP"). The milestone marker's accessible name names the milestone and says where
it goes.

**Where the numbers come from.** One read of `GET /api/queue` per poll, joined
onto the list in the browser by identifier, memoised, refreshed by the same 1.5s
fingerprint as everything else. That one join feeds both halves — the number a row
prints and the number **Queue position** sorting orders it by are the same value,
so the list can never sort by anything other than what it shows. The list
*displays* these numbers and can never set them — presentation sort is not the
queue.

**Ungrouped only.** The cues are joined only in the ungrouped view; the grouped
axes render without them. The queue is still read whenever a workspace is in
view, because the row menu needs the plan's `revision` and entries to queue a
task from any shape of the list. In hub mode the cues appear once a workspace is
selected: a plan is a per-workspace sequence, and there is no cross-workspace
order to show.

### Sorting

The "Sort" control sits beside "Group" and names both halves of its own state without
being opened — "Sort: Activity" with a direction arrow on the trigger, and the whole
reading, "Sort: Activity · Most active first", as its accessible name and tooltip, never an arrow you have to
decode. Every mode is a real radio in a labelled group, so Tab and Enter operate it.
The choice is stored **per workspace and per view** under the same
`staple:view:v1` key as the grouping; a scope you have never set uses the default, and
setting one back to the default forgets it rather than pinning it.

**Sorting is not the queue.** Ordering the list by queue position is a statement about
your screen; it cannot move an item in the pickup plan, change checkout eligibility, or
reorder a dependency. See [queue.md](queue.md).

Direction flips the **primary key only** — every tie-break below runs forwards in both
directions, so two rows that tie never swap and "descending, then ascending" is exactly
where you started. Under Queue position, unqueued rows come last in both directions.
Every chain ends in the identifier, which is unique and compared **numerically on the
number part**, so STA-9 precedes STA-10 and the list cannot reshuffle on the 1.5s poll.

| Mode | Orders by | Tie-break chain, in order | Parent rollup |
| --- | --- | --- | --- |
| **Activity** (default) | a live claim first, then the configured status order | priority → newest update → identifier | best activity tier in the subtree |
| **Queue position** | the effective queue position; rows with one before rows without | activity → priority → newest update → identifier | earliest effective position in the subtree |
| **Status** | the workspace's configured status order | priority → newest update → identifier | — |
| **Priority** | critical → high → medium → low | activity → newest update → identifier | — |
| **Updated** | when anything last moved | priority → identifier | latest update in the subtree |
| **Created** | when the ticket was filed | priority → identifier | — |
| **Identifier** | the number, numerically | — (identifiers are unique) | — |
| **Title** | alphabetically, locale-aware | identifier | — |

Only three modes roll a parent up over its descendants, and each is named above; the
other five read the row and nothing else. A rollup counts only rows the current filter
kept, so an order is always accountable from what is on the screen. A status the
workspace order does not mention ranks last but still ranks.

**Queue position has one scale, and it is the effective one.** A row sorts by the
position its own cue prints — the place in the sequence an agent receives. A **container**
never has one (the resolver expands it in place), so it sorts by the *earliest effective
position among the rows it holds*; its `plan #2` caption is a place in the plan, a
different ruler, and the sort never reads it. Anything the queue has no position for —
waiting, gated, in flight, unqueued, resolved — sorts after everything that has one, in
both directions. The numbers come from the same browser-side join as the cues, so the list
always sorts by exactly what it prints.

Sorting orders **siblings**: it never lifts a child out from under its parent, and it
applies inside a group exactly as it does in the ungrouped view. Under Group by Status
the activity tier is inert — every row in a status bucket ranks equally on it — so the
default mode there is priority, then the newest update, then the identifier. Under
*Pickup order* the store's own dependency-ordered rank *is* the activity tier,
so Activity — the default — renders the queue exactly as `/api/inbox` published it,
"Least active first" renders the back of it, and every other mode reorders inside each
section by the key you named. Gate holders still head Pending approval whatever you sort
by: that is what the section is, not an order you chose.

### Filtering

The *Filter* button opens a two-page menu: pick a dimension, then pick values inside
it. **Alternatives inside one dimension are ORed, dimensions are ANDed** — "gated or
waiting, and in Release 1.0" is one question — and an empty selection is the *absence*
of a constraint rather than "match nothing". Every option is enumerated from data the
server sent: statuses and kinds from the workspace vocabulary, assignees and labels
from the rows on the page, milestones from `/api/milestones`, epics from the rows' own
ancestry. Nothing in the menu is a value this build invented.

| Dimension | Values | Read from |
| --- | --- | --- |
| **Status** | the workspace's configured statuses | the issue |
| **Blocked** | Blocked or waiting on another task | the status and the open blockers |
| **Kind** | the kinds present, in the configured order | the issue |
| **Assignee** | the names on the page, plus Unassigned | the issue |
| **Priority** | Urgent, High, Medium, Low | the issue |
| **Label** | the labels on the page | the issue |
| **Claim** | Working now, Stale claim, Held, Unclaimed | the claim reading |
| **Handoff** | Stale worklog, No worklog | the worklog summary |
| **Gate** | Awaiting approval, Queued behind a gate | the gate siblings |
| **Pickup state** | Pickable, Queued, Waiting, Gated, In flight | the queue resolver |
| **Milestone** | every milestone, by title | milestone **membership** |
| **Epic** | the top-level ancestors present | the row's ancestry |
| **Project** | every tracked project, by name (captioned with its workspace when the page spans several) | the issue's `projectId` |

**Pickup state** is the resolver's own word for the row when the server sends one
([queue.md](queue.md), step 3). When it does not, four of the five are derived locally in the
resolver's order — gated (its own gate, or the gate it stands behind), waiting (an
unresolved blocker or a blocked status), in flight (a claim, a checkout, or a working
status), pickable (everything else) — and a resolved row has no pickup state at all.
*Queued* is the one the browser never derives: it means "eligible, but the plan puts an
earlier row first", and order is the resolver's knowledge, not the page's.

**Milestone is membership, never the tree.** A milestone contains epics and tasks
without reparenting them, so filtering by one selects its members — which may include a
row whose own parent is not a member, and exclude a child of one that is.

**Epic** is the top-level ancestor, and a top-level row is its own epic, so selecting one
keeps the epic and everything under it.

**Chips.** Every active value gets a chip naming its dimension and its value —
"Pickup state: Gated", never a bare "Gated", because a label, an assignee and a
milestone can all be called the same thing. Clicking a chip reopens its own menu, the
`×` removes that one value, and "Clear all" resets to the shipped default (which
re-hides done work).

**Hierarchy survives a filter.** A parent the filter removed is still drawn above its
surviving children, dimmed, as a ghost — it is a bracket around rows rather than a row,
so it is not in any count and it folds like the real one would.

**An empty page says why.** With nothing left, the view names the dimensions
responsible: either the one whose removal would bring rows back and how many (*No
task matches all of these filters. Removing Priority would show 4 tasks.*), or,
with several, one *Remove … · n tasks* button per filter that would, or that they
exclude every row only in combination, or — for a selection that could not match anything whatever the data said,
such as *done* plus *pickable* — that the two cannot both be true and one has to go.

**Filters persist per workspace and per view**, under the same `staple:view:v1` key as
the sort and the grouping. A scope you have never filtered in opens with whatever the
older global filter key (`staple:filters:v1`) holds, so nothing is lost on upgrade. Changing a filter is a
statement about your screen: it cannot touch `queue.policy`, the pickup plan, or any
write path.

### What the view tests prove

Grouping, sorting, filtering and the row cues meet on one page. The tests that hold
that page together are listed here so a change knows what it is up against.

All of them are pure functions or `react-dom/server` markup: the app's component tests
use no jsdom and no screenshots. **A "visual check" below means the rendered markup at a
phone width and a desk width, with class and attribute assertions, plus the
`task-list.css` rule that does the rest.** (One repo test, `test/ui-phone-back.test.ts`,
drives real Chromium through `playwright-core` against the built app, for the phone's
Back behaviour.)

One board — `views/tree/drift-fixture.ts` — backs all four files: two epics, one open
and one folded, a gated child, a stale claim, a done child, a custom kind, a milestone
whose two members sit under different epics, and a `/api/queue` payload covering every
cue state. Every file below reads it, so a claim proved about the model is a claim about
the same rows on the screen.

| File | What it pins |
| --- | --- |
| `views/tree/view-combinations.test.ts` | every sort mode × every grouping axis keeps section membership, the header counts, the nesting and the published visible order; filter combinations keep the ghosts and agree with the counts the menu and the empty state print; a queued milestone member is cued and ordered consistently; a folded epic keeps its rollup and its cue |
| `views/tree/polling-stability.test.ts` | the 1.5s poll changes nothing you chose — sort, filters, folds and cues all survive a fresh payload, a new queue payload moves the cues and nothing else, and the rendered page is identical bar the absolute timestamps |
| `views/tree/view-a11y.test.tsx` | the sort trigger names the mode *and* the direction in all sixteen states; chips and the empty state name the dimension, the value and the count; all six cue words reach a screen reader; `aria-level` and `aria-expanded` on rows and group headers; the controls tab in reading order and the grid has one roving tab stop |
| `views/tree/view-responsive.test.tsx` | all five groupings at 400px and 1440px draw the same sections, rows, levels and cues; labels degrade from names to dots to none; the rolled-up plan is absent, not hidden, on a phone; the row stays one 48px line on a phone; the date and the worklog cue drop in the ladder's order |

Alongside them, `lib/sort-modes.test.ts` walks each mode's key and tie-breaks,
`lib/filter-dimensions.test.ts` and `components/filters/filters-render.test.tsx` walk the
dimensions, `views/tree/tree-model.test.ts` pins placement and ghosts, and
`views/tree/group-header.test.tsx` pins the epic-axis rhythm.

`view-combinations.test.ts` also pins three cross-cutting rules: the chosen
sort reaches the *Pickup order* grouping, **Queue position** orders by the numbers the cues
print, and a container is ranked on the effective scale rather than on its plan index.

## Queue

The Queue view (`views/queue/QueueView.tsx`) is the editor for the
[pickup queue](queue.md): the order agents take work in, as one full-width tree.
Everything on it comes from one `GET /api/queue?all=1` (`staple queue --json`),
read whole regardless of the Done toggle, so resolved plan rows stay in place,
dimmed, and the plan's numbering has no gaps. The view has no toolbar. On *All
workspaces* it asks you to [choose a workspace](#choose-a-workspace): each
workspace keeps its own order.

**The header.** *Pickup order*, a sentence saying what the order is for, and
*Clear n finished* when the plan holds resolved rows (*Prune n resolved* on a
phone), which prunes them. Under it, a summary card: *5 tasks are in the plan: 3
ready to pick up, 1 being worked on and 1 waiting on something.* with a progress
strip over the same counts (`views/queue/queue-summary.ts`). The plan's
`revision` is behind *Show details*.

**Next up.** A band across the top names the row an agent asking right now
would be handed, with its title and *Open*. It is the first `eligible` row of
the list below, which is what the resolver answers for a read with no actor, so
the band and the list can never disagree. With nothing eligible it says
*Nothing can be picked up right now: every task in the plan is waiting on
something.*

**The order.** The plan's entries in plan order, each drawn with the same task
row as the Tasks view, and each printing its **plan position** bare in a gutter
(1, 2, 3, …). Under a queued epic or milestone, the rows it expands to are
nested on the tree's own connector lines, in the order an agent meets them,
each printing its **pickup number** with a `#` (`#5`). A container never gets a
pickup number, because it is never a checkout target, and a resolved row loses
its number. The expansion is capped at five rows with *and n more under
STA-66*; the fold chevron opens and closes it. A row that is not pickable
carries the store's sentence for why as its caption ("blocked by STA-35",
"queued behind STA-66's review", "held by codex-1"). A claimed row keeps its
place and its number dims: nothing moves while you are reading.

**Not planned.** Every other open leaf follows in a folded section, *Not
planned · n items · picked up after the plan*, in presentation sort, capped at
ten with the rest counted.

**Reordering.** Drag (`@dnd-kit/core`, the reorder list the settings editors
use), the per-row move buttons, Alt-↑ / Alt-↓, Alt-Home / Alt-End, and the row
menu's *Move to top* / *Move to bottom* all end in one
`POST /api/queue/reorder` carrying the view's `revision` as `baseRevision`. A
move that would change nothing is never sent. Alt is required on the arrows and
on Home/End so the plain keys stay with the list's own navigation.

**The row menu** (`components/QueueRowMenu.tsx`, the `⋯` on every row, also
opened by a long press) is where every row action lives, here and on the Tasks
list: *Open details*; on a queued row the moves and *Remove from queue*
(`POST /api/queue/remove`), disabled while somebody holds the row, with the
reason; on a row not in the plan *Queue next* (`POST /api/queue/enqueue` at
position 1) and *Add to queue* (appended). A row that is only in the order
because its container is queued counts as not queued, so it offers the add
items. On *All workspaces* the menu names which workspace's queue it acts on.

**Adding.** The picker above the list, *Queue a task, epic or milestone…*,
lists this workspace's issues that are not already in the plan and adds the one
you pick.

**A stale reorder.** Every write carries `baseRevision`, and the store refuses
a stale one with `revision_conflict`, changing nothing, so the server's order is
still the truth. The page re-reads and shows *The plan changed elsewhere —
nothing was written.* with the store's sentence and two deliberate ways out:
**Reload**, which abandons the move, and **Retry my order**, which re-applies
the intent at the new revision, keeping whatever the other writer added and
dropping whatever they removed. Neither happens on its own. Any other refusal
is the store's own sentence in the shared refusal panel.

`views/queue/queue-render.test.tsx` renders the pieces to static markup;
`queue-model.test.ts`, `queue-tree.test.ts` and `queue-summary.test.ts` pin the
numbering, the nesting and the summary.

## Graph

The Graph view (`views/GraphView.tsx`, `views/graph/`) draws the dependency
graph from `GET /api/graph` with React Flow, laid out left to right by dagre.
Only issues that take part in a dependency are drawn. The toolbar's filters
apply here too (the same predicates as Tasks, joined on identifier), and an
empty canvas says which filter to remove, or that there are no dependencies
yet.

**Nodes and edges.** A node is an issue: identifier, status, a two-line title,
and in hub mode its workspace. An arrow runs from an issue to the work that
waits on it. An edge to another workspace is dashed, an edge bridged across
hidden done work is dotted, and an arrow that stands for several dependencies
is labelled `×N`. A legend names each mark. A click on any node opens it in the
[detail](#task-detail). Hovering or selecting an issue lights the chain it
waits on and dims the rest.

**Epics.** An expanded epic is a box around its members, with its progress
(*3/4 done*) and a *collapse* chevron in its header; a collapsed epic is one
node with its done count, and its chevron expands it. With more than 24 issues
drawn, every epic starts collapsed. Opening or closing one epic re-lays out
that level only and zooms to it. The **Epics** picker lists the epics as a
tree: search, *Collapse all* / *Expand all*, and ticking epics narrows the
canvas to them and their child epics. `/api/graph` in `--hub` mode carries no
parents, so the hub graph is flat and the picker is hidden.

**The toolbar**, left to right:

- **View** (*View: Frontier · done faded*): a mode, *Off*, *Frontier* (only what
  could be picked up right now) or *Path to target* (only the unfinished work
  between now and the selected issue; disabled until one is selected); and done
  work *Shown*, *Faded* or *Hidden* (its edges bridge across it). The done
  setting starts from the page's Done toggle.
- **Copy link** puts the canvas state in the address as `?graph=` (mode, done,
  selected and collapsed epics, the target), so a shared link opens the same
  canvas and reopens the target.
- **Export**: *PNG — for a slide* or *SVG — vector, editable*, saved as
  `staple-graph-YYYY-MM-DD` with a caption naming the scope and the date.
- **Epics**, the picker above.
- **Auto-arrange** drops dragged positions and applies the default layout.

Dragged positions are kept per mode and workspace in the browser
(`staple:graph-positions:v2:…`) and saved when a drag ends. On a narrow screen
the first view frames the leftmost nodes at a readable zoom rather than fitting
everything, and the minimap is hidden.

**Scope.** With one workspace chosen in hub mode, the canvas shows that
workspace's issues plus each issue in another workspace that blocks one of them
or is blocked by one (`views/graph/graph-scope.ts`). *All workspaces* shows the
whole hub graph.

## Milestones

The Milestones view (`views/milestones/MilestonesView.tsx`) is the planning view
for [milestones](milestones.md): dated, human-ordered plans that contain epics
and tasks without moving them. The page has no toolbar of its own. The *Done*
toggle in the top bar, the same one the Tasks view uses, decides whether
finished and cancelled milestones are listed and whether finished rows show in a
milestone's member list.

**Turned off.** A workspace without the `milestone` kind shows *Milestones are
not turned on in staple.* (the workspace's name) and a **Turn on milestones in Settings** button
that opens that workspace's *Task types* in [Settings](#settings).

**Left, the plan.** Every milestone in plan order, then target date, then
identifier: an unplanned milestone sits below every planned one, and a date
never reorders a plan. On a desk each is a card: the title; the status pill; the
due date in words; a progress strip; *3 of 4 tasks finished (75%).*; and what
is in the way (*3 are blocked: 2 wait on other tasks, 1 on a person.*). On a
phone a row is denser: identifier, `target` date, member count, `plan #`, a
progress bar with `done/countable` and the percent, the state, the risk, and the
queue's answer, `next: STA-67 (#4)`, or "no eligible work". With Done hidden
and nothing open, the list says *No open milestones* (*All 3 milestones are
finished and hidden while Done is hidden.*) with a **Show finished milestones**
button; a workspace with no milestones at all says *No milestones here yet* with
a **New task** button that opens the create dialog on the Milestone kind. A
milestone the address points at (`?focus=`) or that is open stays listed even
when it is finished and Done is hidden.

**The status pill** is the milestone's stored status, the same glyph, word and
colour the Tasks list and the task detail give any status (*Backlog*, *Todo*,
*In Progress*, *Awaiting Approval*, *Done*, or the workspace's own label). The store derives that status
from the members, so this page and the Tasks list give one answer about the same
milestone. In the detail header the pill is the task detail's own status menu,
and a pending approval gate shows the task detail's approve and send-back block
under the header, through the same action controller, refusals and signing.

**The due date** (`views/milestones/MilestoneDue.tsx`) is said in words: the
target a person set (*Due 15 Oct, in 18 days*, *Due today*, *Due tomorrow*,
*Was due 12 Oct, 3 days ago*, and only *Was due 12 Oct* once the milestone is
finished or cancelled); with no target, a projection from the work still
estimated in it, *Due ~3 Oct (estimated)*, or *Due no earlier than ~3 Oct
(estimated)* when some open tasks cannot be forecast; a finished milestone with
no target says *Finished 3 Oct* (*Closed 3 Oct* when cancelled), from its
`closedAt`; and otherwise *No due date*. The projection is now plus the view's
`remaining.forecastSeconds` ([milestones](milestones.md)), all open work summed
rather than the critical path, and it is never stored; its tooltip gives the
estimated and forecast hours and how many open tasks it leaves out. Overdue is
judged on the reader's local calendar day, so the words, the red and the risk
line agree. Beside an open milestone's date a calendar button (*Set a due date*,
or *Change the due date*) opens a date field pre-filled from the projection;
**Save** writes the milestone's own target through `POST /api/milestone/update`,
the same write as `staple milestone set --target`, and a set target has a
**Use the estimate** (or **Clear date**) button that removes it. The milestone's
task detail shows the same control as its Due property.

**Right, one milestone.** On a desk: the title, the status, the due date,
*Owned by …*, **Open** (the milestone's [detail](#task-detail), where its goal
is) and an expand button that gives the detail the whole content box. A progress
card follows with the progress sentence, then one line that says what waits,
how many cancelled tasks the count leaves out (*1 cancelled task is not
counted.*) and *Next up: STA-67, number 4 in the pickup order.* The strip splits
the counted tasks into finished, in review, in progress, blocked, to do and not
started, in the colours the task rows' status glyphs use; every counted task is
in exactly one, and cancelled ones are in none. *Show details* opens a grid of
*Reference*, *Tasks counted* (with the cancelled ones it leaves out), *Starts*,
*Target*, *Blocked, waiting on other tasks*, *Blocked, waiting on a person*,
*Started, still waiting on other tasks* and *Started, waiting for an approval*
(each only when not 0), *Plan position* (when queued) and *Next up*. The two
*Blocked* rows add up to the strip's blocked count.

Then *What is in this milestone* (*4 items, in order*): the ordered members,
drawn with the Tasks list's own row and columns. A click on a row, or Enter or
Space on it, opens the task; the arrow keys, Home and End move between rows, and
right and left unfold and fold a member epic's children, which follow it
read-only: membership never rewrites hierarchy and neither does this list. A
member added with a note shows the note under its row. Done hidden hides the
same rows here as in the Tasks list: a hidden row's open children take its
place, each with its parent's chip, and the first of them carries the hidden
member's controls. The list ends with *3 finished items hidden* and a **Show
done** button; when every member is finished and hidden it says so (*Everything
in this milestone is finished; Done is hidden.*) instead of calling the
milestone empty (`views/milestones/HiddenDone.tsx`). A milestone with no members
says *Nothing is in this milestone yet*.

**Editing membership.** Each member has *Open*, *Move up*, *Move down* and
*Remove*, plus Alt-↑ / Alt-↓ on the row. Below 1280px, and on a phone, the four
fold into one `⋯` menu (*Open details*, *Move up*, *Move down*, *Remove from
this milestone*). The form under the list adds a task by reference with an
optional note (*Add to milestone*). Writes go to `POST /api/milestone/add`,
`/remove` and `/reorder`, each carrying the view's `revision` as
`baseRevision`; the store refuses a stale one with `revision_conflict` and the
page shows *Member order changed elsewhere.* with the store's sentence and a
Reload, because the fix is to read again. Any other refusal is the store's own
sentence. There is no drag. A finished or cancelled milestone is a record: its
members keep *Open* only, the add form is gone, and its due date has no
calendar.

**States without colour.** On a phone row (and in the phone detail header until
the milestone's status loads) the milestone's state is a glyph and a word: planned `○`, active `◐`, overdue `!`,
done `✓`, cancelled `×`, with "all members done" beside an active milestone
whose members have all landed (seen only while a gate or a manual status holds
it open). Blocked and gated are facts about members, not milestone states, and
appear in the risk line.

**Layout.** Below 1024px (`SPLIT_MIN_WIDTH_PX`) the two panes stack: the list,
then the detail with a "Back to milestones" button. From 1024px they split:
wider than the shell's 768px because the rail takes its share of the window
first. The expand button in the detail header gives it the whole content box at
any width; press it again to return.

**All workspaces.** With no workspace chosen in hub mode the view is *Milestones
in every workspace*: read-only, grouped by workspace, leaving out workspaces
with no milestones or without the kind, and naming a workspace whose read
failed. Opening a milestone switches to its workspace and focuses it
(`views/milestones/AllWorkspacesMilestones.tsx`).

**In the rest of the app.** A row that is a direct member of a milestone and has
no parent is drawn under the milestone in the Tasks tree (in the list's copy
only: a real parent always wins, and the grouped-by-epic view skips it;
`views/tree/milestone-placement.ts`). A row's milestone marker opens this view
focused on that milestone (`?view=milestones&focus=`). An issue's detail names
its milestone, direct or inherited.

**How this section is verified.** `views/milestones/milestones-e2e.test.tsx`
starts the real HTTP server over a scenario workspace, fetches
`/api/milestones`, `/api/milestone`, `/api/issues` and `/api/queue`, and
renders the real list, detail and layout pieces from those payloads with
`react-dom/server`. It pins the stacked and split layouts and full screen, that
the accessible row order equals the server's member order (the epic's child
indented immediately under it, nothing drawn twice), that every reorder control
carries its member's identifier and only the true edges are disabled, that each
state is a glyph and a word with the glyph `aria-hidden`, and that a genuinely
stale `baseRevision`, a real 409 from the real route, renders the conflict
banner with the store's sentence verbatim while the server keeps the other
writer's order. It also sets a due date through the real update route and clears
it back to the projection, and shows the stored status with the detail's approve
action, whose approval lands where the Tasks list reads it.

## Estimates

The fifth view in the rail, **Estimates** (also "Go to Estimates" in
the command palette, which also finds it by *estimate accuracy* and
*calibration*), is the
workspace's calibration report: `GET /api/calibration`, the payload of `staple
calibrate --json` and MCP `calibration_cohorts`
([timing-semantics.md](timing-semantics.md), "Calibration cohorts" and
"Confidence ranges"). The view's internal id is `calibration` (saved preferences
and commands key off it); the address calls it `estimate-accuracy`. It is per
workspace; on *All workspaces* it shows [Choose a workspace](#choose-a-workspace)
(*Estimates are checked for each workspace on its own.*). The view has no
toolbar, and the palette's filter commands are hidden here: they narrow the
issue list, and this report is not one. The page asks for the workspace it
names, so the label and the data cannot diverge.

**The answer first.** A card titled *How long work really takes in
staple* (the workspace's name) opens the page with one sentence, the first three
cards of the measured history in display order, cards that say the same thing
said once, together: *Tasks (high priority) and all finished work (every kind)
usually take about a fifth of the estimate.* (and how many more groups follow). It reads only the measured
history, so it is the same with the older-history switch on or off. It holds the switch, **Include older history (rebuilt from logs, less
precise)**; its *Show details* keeps the population line and the snapshot id with
its member count and instant.

**Each group is a card.** A cohort that read its own key: title (*Bug fixes
(high priority)*; dimensions nobody recorded are left out), a confidence pill,
the figure (*About ⅕ of the estimate*, the ratio a forecast scales by; below a
fifth, *About 50 minutes per 10 estimated hours*), and plain sentences: *Tasks
(high priority) usually take about a fifth of the estimate. Based on 8 finished
tasks. Rough guess: not enough data to be sure.* Its confidence reads only its
own fields: no samples or no bounds is *Unknown*; bounds under the 90% target or
`small_sample` is *Rough guess*; a quantile under the target is *Fairly sure*;
otherwise *Quite sure*. **Cohorts that fell back** to a broader class never get a
card of their own, because the figure is the class's, not theirs: the cohorts
that share a class are ONE card named for it and for what it spans (*All finished
work (every kind)*, *All bug fixes (every priority)*), with the class's figure and count (*Based on 9 finished tasks.*) and
*Also used for: Bug fixes (high priority): too few of their own (1)*, the own
count being the fallback path's first level. Its pill is always *Rough guess*
(the kinds it stands in for have too few of their own), never *Quite sure*, and
it says so for them: *Rough guess for spikes (critical priority): only 3 of their
own, so all finished work (every kind) stands in.* The verb agrees with the class: *All
finished work (every kind) usually takes*, *All bug fixes (every priority) usually take*. The
bar shows where 8 in 10 past tasks landed (the ratio's p10–p90) inside where the
next one is likely to land (the prediction bounds, at the confidence they reach,
in tens; under 50% it says *Too little data to say where the next one lands* and
draws no band), the typical ratio as the marker, and the estimate itself as a
dashed line. Under *Show details*: the
key (`task · high · type unknown · area unknown · model unknown`), `n`, the class
it read and how (`read at full, its own key`, or `fell back to all: its key has 1
sample`) with the whole fallback path, coverage (`7 of 10 eligible (70%)`), the
median and pooled ratio, the ratio a forecast scales by and how it was formed,
`p10–p90`, where the next one lands with the confidence reached (under the 90%
target marked in words), the median interval, the work median and `p10–p90`,
floors and heavy tails when present, and the warning chips.

**Measured history first; older history on by default, and apart.** The page leads
with the `exact` set, *Finished tasks with measured time*, with a plain line
(*Based on 9 finished tasks with measured time, out of 138 finished with an
estimate.*) and what is not used, by the state the payload counts, said for that
set (*Not used here: 2 have only approximate timing and 127 have timing rebuilt
from logs (they're in the older history).*, the same with the switch on or off);
the older history, drawn under it, says *10 are in the measured history above, 2
have only approximate timing and 19 couldn't be rebuilt reliably*. The technical set line is behind *Show details*. The
switch re-reads with `include=reconstructed`; the reconstructed groups then
appear in their own section, *Older history (rebuilt from logs, less precise)*,
*kept separate: never mixed with the history above*, after the exact one. The
exact section reads the same either way. The switch is a remembered preference
(`staple:estimates-include-older-history` in the browser's storage): on until you
turn it off, and then off on every visit and reload until you turn it back on. With no samples a set says *We can't tell yet* and why.

**How the two are verified.** `detail/forecast-e2e.test.tsx` starts the real
HTTP server over `test/fixtures/forecast-scenario.ts`, a scenario written through
the real store (checkouts and comments for the samples, a unit in progress, one
in review, one unestimated, a dependency, reconstructed history rebuilt by the
real `reconstruct`) and the real budget ingestion (a status-line limit read
during a real attempt, a Codex account with no attempt), plus an empty
workspace. It renders `ForecastReportView` and `CalibrationReportView` from the
responses and pins the separate blocks, the lower bounds, the chain, the
confidence and warnings, the unknowns with their reasons, the provisional
reserve, the reconstructed toggle leaving the exact section and the opening
answer identical, and the plain layer over the same payloads: each headline, each
pill's word and icon, each visual's text alternative and legend, the fallback
cohort grouped under its class, each set's per-state summary, and every technical
figure sitting inside a closed *Show details*. `lib/plain-language.test.ts` pins the rounding, the
phrasing and the status mapping on both sides of each threshold (other use and
pace included), including unknown, lower bound, low confidence, in review and no
samples;
`lib/forecast-text.test.ts` pins the technical formats and the rule for which
issues get a forecast. The type mirror is pinned against the store's types in
`test/contract-ui-types.test.ts`.

## Usage

The rail's **This computer** group holds one view, **Usage** (also "Go to
Usage" in the command palette, which also finds it by *budget*): this machine's provider limits and each
one's session pressure, `GET /api/budget`, the payload of `staple budget
--json` and MCP `get_budget` ([execution-telemetry.md](execution-telemetry.md#pressure)).
It sits apart from the workspace views because budget readings live in this
machine's hub and never synchronize: the view takes no workspace and shows
the same figures whichever one the switcher names. It has no toolbar, and the
top bar names the scope *This computer*. It also reads `GET /api/budget/polling`
for the live-check state.

**Plain first.** The view opens with one sentence: *Your subscription limits on
this computer, and whether your recent pace keeps a safety reserve of 20% (a
default until you set one). The pace check is an early rule of thumb until a
budget policy is set.*, a pill counting the limits at risk, and the rule's
technical wording behind *Show rule details*. Accounts are named for people
(*Claude (Anthropic)*, *Codex (OpenAI)*) with the operator's label and *measured
on this computer* / *not set up on this computer*. Each limit with a current
reading is a plain card (the same components as the forecast's, see
[Plain-language cards](#plain-language-cards)): a status pill, what is left as
the figure (*78% left*, with its age when stale, *· 12 min ago*), a sentence
with the reset and the verdict (*Resets in 3h 56m. At your current pace you'll
stay above the reserve.*), a solid **Measured** frame (the gauge with the reserve
line; *Using about 4.2% an hour lately; last read 1 min ago.*, *No use lately.*
for an idle limit, *… as of 3h ago* for a stale one) and a dashed **Forecast**
frame labelled *an early rule of thumb until a budget policy is set* (*To keep
the 20% reserve until it resets, use no more than about 15% an hour.*; *Already
at or below the 20% reserve; any more use eats into it.*; *Almost any pace is
safe until the reset.* when the safe pace exceeds everything left). Both frames
say a pace in the same unit, so they compare: one decimal under 10%, per hour for
a short window and per day for a window of two days or more (*about 8.4% a
day*). When the pace reaches the reserve is said once, in the sentence, never
again in the Forecast frame; at a pressure of exactly ×1.00 the sentence says
*you'll use up everything above the 20% reserve by the reset*, which the frame's
safe pace agrees with.
The status is `pressureStatus`, the store's own provisional state and no
threshold of the page's: *unsafe* is **At risk** (with the hatched edge; the
sentence says when the pace reaches the reserve, or that it already has),
*within* is **On track**, no state is **Unknown** with its reason in words. Limits
with no current window collapse into one line per account (*1 Claude limit can't
be read yet: the provider doesn't say when it resets.*); an account or a machine
with nothing says why in plain words (*Set up, but no reading has arrived yet.*,
*Usage tracking is off on this computer…*), with `staple budget setup` behind
*Show details*. Everything below is what each card's (or account's) *Show
details* holds.

**One card per limit, two blocks per card.** Accounts are listed as the read
returns them, each limit a card. **Measured**, in a solid frame, is what the
provider reported: the high-water remaining figure, the reset countdown and
its local time, the observed pace (`%/h`, from the window's first reading to
its latest) and the last reading's age and source, with a `stale` mark past
10 minutes. **Forecast**, in a dashed frame labelled *provisional, as of*
the read, is what the pace implies: the sustainable pace (what is left above
the reserve over the time to the reset), the pressure (observed over
sustainable), when the pace uses the limit up and when it reaches the
reserve, safe concurrency, and the confidence of the pace with its warning
chips (few readings, a span under 30 minutes, regressions in the window).
No figure appears in both blocks, and the page computes none of them.

**States.** Each card carries its pressure state as a word and an icon:
*Within*, *Unsafe* or *Unknown*, and the line under it says *(provisional)*
for the first two, since the rule behind them is. Unsafe also gets a red frame and a hatched
left edge, so the state never rests on colour alone, and the header counts
the unsafe limits. Unknown is always the word with the payload's reason
(`stale`, `no_sample_yet`, `window_elapsed`, a missing second reading) in the
italic placeholder style, never a 0. A limit with no current window (it
reset, or its readings carried no reset instant) collapses to one line that
says so. An account with no limits says why (no reading yet, capture off, no
source bound) and names `staple budget setup`; a machine with no budget data
at all says the same at the top. Safe concurrency always reads *Not defined
yet*: it needs an admission policy, and staple has none.

**The reserve and the rule.** The header states the reserve (20% of each
limit, a provisional default until an admission policy sets one) and the
provisional pressure rule (unsafe at ×1.00 or over), both from the payload.

**Live.** The view re-reads every 30 seconds while the page is visible and at
once when it becomes visible again. It does not follow the workspace
fingerprint: budget readings live in the hub, not in a workspace.

**Refresh.** The button runs one real collection
(`POST /api/budget/collection/refresh`, what `staple budget collect` runs: the
passive scan, then, with [live polling](execution-telemetry.md#live-polling)
on, one check with each linked provider, at most once a minute per account),
reads *Checking…* while it runs, then says per provider what happened:
*Updated just now*, or the provider's reason in plain words (*Claude Code's
sign-in on this computer has expired… Sign in to Claude Code again*). With live
checks off it says so and where to turn them on. It works from the phone on
the tailnet, and is the one write gated by the token alone (see
[Auth](#auth)). With live checks on, each account says when it was last checked;
when that check failed, a bordered line above its cards says why and how old
the figures below are. A limit the provider reports with no window running
reads *nothing used since it last reset, so the full allowance is there*
instead of unknown. The last reading's source reads *live check*.
Between reads, the reset countdown and the last reading's age tick by the
seconds the page has held the answer, by the page's own clock, so a device
whose clock is off still counts right; the forecast figures stay as of the
read. At 390 px the two blocks stack, labels keep a fixed column and long
values wrap; nothing scrolls sideways, and the controls keep the app's touch
rules (the chips at 24 px).

## Task detail

Any issue opens in one detail surface (`detail/IssueDetailMount.tsx`,
`detail/IssueDetailPanel.tsx`): a click or Enter on a row, a graph node, a
breadcrumb, a reference chip or a palette result. It reads `GET /api/issue` and
is not part of the address: Back closes it rather than navigating.

**Drawer or page.** On a desk it is a drawer on the right (up to 46rem, with a
scrim) or, with *Expand to full screen*, the whole window with the properties in
a sticky right-hand column; *Collapse to drawer* goes back. The choice is
remembered (`staple:detail-mode`). Below 768px it is always a full-screen sheet
with *Back to the list*, summary chips (status, priority, kind, assignee), the
properties behind *More details* and the primary action in a bar at the bottom.
It closes with the X (*Close detail*), Escape (except while typing in a field),
the scrim, or the browser's Back, and focus returns to the row it came from.

**Moving through the list.** *Previous task* and *Next task*, `j` / `k` and
Alt-↑ / Alt-↓ step through the list on screen, after filtering, grouping and
folding, and the bar shows the position (*3 of 24*). It does not wrap. Once the
issue has loaded, the selection is pinned to its internal id, so a sync that
renumbers it cannot switch the drawer to another issue.

**The top.** A breadcrumb (milestone, then parents, then the reference), the
title (edited in place), and a status line: the status pill, a plain sentence
(*Being worked on by …*), one primary action and a *More actions* menu. The
actions, all `POST /api/action`, are *Start work* (a checkout, which asks for a
working name once and remembers it as `staple:actor`), *Take it over* (when the
holder has been silent for 30 minutes), *Mark done*, *Reopen*, *Stop working on
it* (release), *Free it up* (a stale claim), *Ask for approval…* (a parent
only) and *Copy task ID*. The status pill's menu lists the workspace's statuses
with a line each; it never offers the gated status, and it sends you to *Start
work* rather than moving an unassigned task into an active status. When a run
holds the issue, a line names the run with *See the run*.

**Properties.** Title, kind, priority and labels write through `POST
/api/action` (`update`); the project writes through `POST /api/project/assign`.
Assignee, milestone (with *via …* when inherited), dates and the timestamps are
read-only here; *More details* shows ids and raw timestamps.

**Approval.** While the issue's gate is active, a *Review gate* block sits above
the properties (`detail/GateReview.tsx`): the children queued behind the gate as
a tree to tick, *Approve all* (or *Approve and close gate* when nothing is
queued), *Approve selected (N)*, and *Send back*, which takes a required note,
posts it as a comment and returns the issue to the next agent. Every decision
asks the signer to type their name. *Ask for approval…* in the menu opens the
request form with an approver. Routes: `POST /api/gate/approve`,
`/api/gate/request-changes`, `/api/gate/request`; each answers with the
refreshed issue. `detail/gate-review.test.tsx` pins the block.

**Tabs** (`detail/tabs/registry.ts`):

| Tab | Shows | Reads and writes |
| --- | --- | --- |
| **Details** | The description; for a milestone its goal and *What is in this milestone*; *Done when* criteria; the unblock note; a worklog excerpt with *Show all*; *Waiting on*, *Holding up*, *Tasks inside* | `GET /api/document` |
| **Connections** | *Part of*, *Sub-tasks* with progress, *Waiting on*, *Holding up*, as rows with summary sentences, and a read-only map behind *Show map* | `GET /api/graph` |
| **Documents** | Only when the issue has documents. A picker, *Read* / *History*, a compare between two revisions (*One column* / *Side by side*), and *Restore this version* | `GET /api/document`, `GET /api/revisions`, `POST /api/action` (`doc_restore`, refused on a stale base revision) |
| **Activity** | One timeline by day: comments as cards, events as lines, document revisions; a comment box (Enter sends) | `GET /api/events?issue=`, `POST /api/action` (`comment`) |
| **For agents** | Exactly what an agent sees when it opens the issue, its size in tokens, with or without document bodies, *Copy*, *Where the size goes* | `GET /api/agent-context?ref=` |
| **Time** | Planned against actual, the forecast, and how exact the figures are (below) | the issue payload, `GET /api/forecast`, `GET /api/timing/quality` |

**A milestone's detail.** A milestone opens in the same surface. Its status line
reads *3 of 9 tasks finished (33%). Due 11 Oct, in 13 days.*, its primary action
is *Open plan* (the [Milestones](#milestones) view), and Details carries the
**goal** in place of *Done when* (`detail/MilestoneGoal.tsx`,
`lib/goal-text.ts`): *n/m met*, a summary line, each criterion with its verdict
(*Met*, *Not met*, *Unknown*), its evidence as links (a ticket opens it, a
document opens that document), who marked it and when, and why an unknown one
is unknown; the pace (*On track*, *Behind*, *Overdue*, …) with its numbers; the
gate, and whether a goal run or a person asked for it; and the goal run working
it. A member a run created says *Created by autopilot*. See
[milestones.md](milestones.md#goal) and [runs.md](runs.md#goal-mode).
`detail/milestone-goal-e2e.test.tsx` pins the goal view against a real goal run.

**The dependencies dialog** (`components/DependenciesDialog.tsx`) opens from a
row's dependency badge: *Blocked by* and *Blocks*, read-only.

### Time

The **Time** tab (`detail/tabs/AnalyticsTab.tsx`; the tab id stays `analytics`)
is estimate versus actual for one issue, drawn from the `timing` and
`childrenTiming` the issue payload already carries (see [cli.md](cli.md),
"Estimates vs actuals"). The page adds nothing up itself, so it can never
disagree with `staple show` or with MCP `get_task`, and it runs no stopwatch of
its own: figures move on the 1.5s poll.

**One headline.** Leaf and parent alike open with one sentence-shaped line,
*Planned 6 hours · 4 minutes so far* (*took …* once the work is finished), a bar
that fills as the actual approaches the plan, and the difference said as what it
means: *5 hours 56 minutes left in the plan*, *Took 20 minutes longer than
planned*, *Right on the plan*. Planned is the recursive `subtreePlan`: the
issue's own estimate when one is set, otherwise its descendants', so an epic
nobody estimated over three 4h/3h/4h tasks leads with 11 hours. Actual is the
headline `activeSeconds`, which for a parent is already its children's
aggregate; an epic has no stopwatch of its own. An absence is the words *No
estimate* or *No work recorded*, never a zero or a dash, and with neither the
tab says there is nothing to compare yet and how to get there. Under the card
one muted line carries the caveats: why there is no difference, how many
sub-tasks have no estimate, whether the time is approximate, and time spent
waiting for review, which is named but never counted as work. A screen reader
hears the headline once, as one sentence (planned, actual, difference,
coverage, source), and the drawn card is hidden from it.

**This task and its sub-tasks.** A parent gets a compact block beneath the
headline with two rows. *This task itself* is the estimate typed on the parent
and the time worked on it directly; *Its sub-tasks* is the plan from the tasks
under it and their added-up time. Every figure names its source in words,
because the two plans are alternatives, never addends: the headline takes the
own estimate when it exists, otherwise the sub-tasks'. A leaf has nothing to
break down and shows the headline only.

**Sub-tasks.** Two lines per direct child: status, title and the difference
(*2 hours under the plan*), then *Planned 3 hours · 1 hour 50 minutes spent*.
The plan is the child's *effective* plan, the figure its parent counts it as,
and where it came from is the tooltip on it. A child that is itself a parent
shows its own total. An unfinished child's difference says *so far* while its
clock is fed and *stalled* once it has gone idle, and a line under the list says
what each word means.

**How exact these numbers are.** Last, when there is something to say: the
agent-work figure and its measurement state, the time on the clock and its
state, and, for a parent, a line counting how the finished tasks under it were
measured (*Of the 9 finished tasks under it: 7 measured exactly (78%), …*), read
from `GET /api/timing/quality?parent=` (`staple timing quality --parent`).

In the task list, a folded parent shows the same rolled-up plan beside its
progress bar; it is absent rather than a dash when nothing beneath is
estimated.

**Forecast.** Between the breakdown and the sub-task list, an open parent
shows its forecast, and an open leaf with its own estimate a compact one: both
read `GET /api/forecast?ref=` (`staple forecast --json`, MCP `forecast`; see
[timing-semantics.md](timing-semantics.md), "Forecasts") and render it as
returned. The page computes nothing: every figure is a field of the payload,
rounded and phrased for a reader who is not an engineer, with the exact figure
one click away. A resolved issue, or a leaf with no estimate, shows no forecast.
A leaf in review or awaiting approval shows one card, *This task is waiting for
review, so there's no work left to forecast*, with an *In review* pill, and
makes no request: its work was handed over, and the wait is not work.

### Plain-language cards

Every block of the forecast and of [Estimates](#estimates) is a
card (`components/plain/`), built the same way so it reads at a glance:

1. a small title and, where the block has one, a **pill**;
2. **one headline figure** (`16 hours`, `78% left`, `About ¾ of the estimate`);
3. **the answer sentence**, in everyday words (`This should take about 16 hours
   of work.`), which never repeats the figure's own words where it can help it;
4. a **visual** with a text alternative (below);
5. **What does this mean?**, a button that opens two or three sentences inline
   (inline rather than a tooltip, so a touch screen gets it too);
6. **Show details**, a closed disclosure holding every technical figure in its
   exact form: quantiles, bands, bounds and
   the confidence they reach, the fallback path, warning chips, reason codes,
   snapshot ids. Power users and agents lose nothing.

The cards sit in a container-query grid: one column in a narrow detail panel or
on a phone (390 px), two where the panel has room, so they reflow on the width
they are given rather than the window's. Light and dark each have their own
validated steps (below).

**Rounding and phrasing, never meaning** (`lib/plain-language.ts`, pure and
tested in `lib/plain-language.test.ts`). Effort durations round by band: under a
minute says *less than a minute*; under 5 minutes, *a few minutes*; under 90
minutes, the nearest 5 minutes (so a typical *55 minutes* never jumps to *1
hour*); under 10 hours, the nearest half hour (`8½ hours`); under 100 hours, the nearest hour; beyond, the nearest 5 hours. Effort is
never written in days. A range shares its unit (`between 14 and 21 hours`),
reads *up to about 1 hour* when it starts under a minute, and collapses to `about
15 hours` when both ends round alike. A reset countdown reads
like a clock (`3h 56m`, `3 hours`, `4 days 1h`), rounded once to the minute and
carried (3 599 s is *1 hour*, never *60 minutes*); a stale reading's age is short
(`12 min ago`, 3 598 s is *1h*, 23½ hours is *1 day*). *About* goes only before a
number: *a few minutes*, never *about a few minutes*. An estimate ratio (work / estimate) reads *about as long as estimated*
from 0.9 to 1.1; *a little less than estimated* from 0.85, *a little longer than
estimated* up to 1.125 (a 10% overrun is never hidden as "1 times"); from a fifth
up to 0.85, the nearest of *half*, *a third*, *a quarter*, *a fifth*, *two
thirds*, *three quarters*; below a fifth, concretely on a 10-hour estimate (*a
10-hour estimate usually takes about 50 minutes*), never `1/12`; from 1.125 the
nearest quarter to 1.5 (*1¼ times*), then halves to 3 (*twice*), then wholes. A
lower bound always keeps *at least* (and *at most* for what is left, *or more* on
a range); an unknown is always *We can't tell yet* with the payload's reason in
everyday words (`no usage has been measured on this computer`), never 0.
Confidence is a word — high *Quite sure*, medium *Fairly sure*, low *Rough
guess* — shown once, as the card's figure, with a sentence of what it rests on
(`Based on 8 finished tasks with measured time.`) and why it is not surer.

**The status word** (`limitStatus`, the one mapping, tested on both sides of each
threshold). A provider limit is:

| Status | Icon | When (first match wins) |
|---|---|---|
| **Unknown** | question mark | nothing is known to be left (`remainingPercent` null) |
| **At risk** | octagon | already under the reserve (`reserve.alreadyBelow`) |
| **Tight** | triangle | no projection of this work, but the account's pace runs out before the reset (`exhaustion.atPace` = `before_reset`): *At the account's current pace this limit runs out before it resets; what this work adds is unknown.* |
| **Unknown** | question mark | no projection of this work (`work`, `reserve` or `reserve.breachProbability` null) |
| **At risk** | octagon | the work alone runs the limit out (`work.remainingAtResetPercent.expected` < 0) |
| **At risk** | octagon | the worse breach probability (alone, or with other use) ≥ 50% |
| **Tight** | triangle | the worse breach probability ≥ 10% |
| **On track** | check | the worse breach probability < 10% |
| then one step worse | | the burn is a lower bound (`work.lowerBound`) |
| then at least **Tight** | triangle | the account's pace runs out before the reset (`exhaustion.atPace` = `before_reset`) |

The breach probability is the **worse** of the work alone
(`reserve.breachProbability`) and, when the payload has it, the work with the
account's other use (`reserve.withOtherUse.breachProbability`); the sentence says
*Counting other use of this account, …* when the other use is what made it worse.
Then, in order: a lower-bound burn (`work.lowerBound`: part of the work could not
be measured, so the real use can only be higher) moves the result one step worse
(On track → Tight, Tight → At risk), because *On track* is never claimed from part
of the work (*Probably fits, but we could only measure part of this work, so it
may need more.*); and when the account's own pace runs the limit out before the
reset (`exhaustion.atPace` is `before_reset`) the result is at least **Tight**
(*This work fits, but at the account's current pace this limit runs out before it
resets.*). A low-confidence work rate does not change the word; the sentence adds
*(a rough guess: little usage measured so far)*. The completion card's pill is its
confidence word (a neutral outline, dashed for *Rough guess*), *Unknown* when
there is no figure, *Done* when settled. Every pill is a word plus an icon of its
own shape, never colour alone.

**Visuals.** The **likely-range bar** starts at 0 and draws the draws' p10–p90
as the strong *likely* band, the 90% band (p5–p95) as a pale edge with a ≥3:1
outline, and the expected figure as an ink marker with a card-coloured ring; on
estimate accuracy it adds the estimate itself as a dashed line. Its legend says
ONE range, *Most likely between 14 and 19 hours (8 in 10 chances)* (*, or more*
on a lower bound); the pale edge is named only as *Rarely beyond 20 hours*, and
only when that rounds to different words and the figure is not a lower bound,
whose upper ends promise nothing. The exact quantiles and band are under *Show
details*. The **budget
gauge** is the whole allowance, read left to right as what is left: solid for
what this work leaves at the reset, striped for what this work is expected to use
(stripes, not a second hue, so it reads under colour-blindness and in print),
grey for already used, a dashed ink line at the safety reserve. Each visual is
`role="img"` whose name says every mark in words (`78% left now. This work would
use at least 20%, leaving at most 58% when it resets. Safety reserve: 20%.`); the
legend beneath repeats it for sighted readers and is hidden from assistive
technology so nothing is heard twice. The components take figures as props and
only position them, so any other analytics view can reuse them.

**Colour and access** (theme-tokens.css, `--plain-*` and `--viz-*`). Status
tones are tints whose text clears 4.5:1 on its own background in both modes; the
visuals are one blue ramp whose likely band, fill and wide-band edge clear 3:1 on
the card, and the track's outline is drawn at full strength (≥3:1 on the card),
light and dark each chosen and checked against its own surface. The
help button and the details summary are at least 24 px tall (44 px on a coarse
pointer) with a visible focus ring; the disclosure chevron's turn is the only
motion and is off under reduced motion.

### What the forecast shows

- **Work left** (full width): the headline figure, the answer sentence, the
  likely-range bar of the remaining labor, and a *Not counted* line naming how
  many units are in review (*time waiting for review isn't work*) or cannot be
  estimated (the latter only when the headline has not already said it). With no
  figure at all, the *How sure we are* card is left out (there is nothing to be sure
  about) and its technical line and warnings move under *Work left*'s details. A lower bound reads *At least
  1½ hours of work is left, probably more: 1 task can't be estimated yet.* Under
  *Show details*: *Remaining labor* (or *Remaining work* for a leaf) with the
  expected figure, the draws' `p10–p90` and the `90% band`, *(lower bounds)*
  where partial, *Unknown:* with its reason where null; the units in review as
  *Not forecast* and the unknown units with their reason; the unit counts and the
  plan's estimates; and *Effort along the work, not calendar time*. Effort
  figures are hours past a day (`139h`, never `5d19h`).
- **What has to happen in order** (full forecast only): the critical path in
  words (*At least 8½ hours of it has to happen one step after another.*) with
  its own range bar, and a line when some unit waits on work outside the subtree.
  Under *Show details*: *Critical path* with its figures, the chain first to last
  as issue links with each unit's expected remaining work, and every open outside
  blocker by reference (`STA-42 waits on STA-7 (backlog)`). Identifiers never
  break across lines.
- **How sure we are**: the confidence word and sentence. Under *Show details*:
  the line with what the classes' bounds reach against the 90% target and why it
  is not high, and the warning chips in the payload's order. Each chip is a
  button: hover or keyboard focus shows its sentence in the app's tooltip, a
  press opens it inline, and the sentence is in the button's accessible name.
- **Usage**, in its own dashed frame under its own heading, subtitled *Usage
  measured on this computer*: usage data never synchronizes and never blends
  with the completion figures. It opens with *How this work fits your
  subscription limits. We aim to keep 20% of each limit in reserve (a default
  until you set one).*, or *We can't tell yet: no usage has been measured on this
  computer.* Each account is named for people, *Claude (Anthropic)* or *Codex
  (OpenAI)*, with the operator's own label beside it and the raw account
  reference behind the account's *Show account details*. Each limit with a
  reading gets a card, named from its window (*5-hour limit*, *Weekly limit*):
  the status pill, what is left as the figure (with its age when the reading is
  stale, *93% left · 12 min ago*), the reset and the verdict as the sentence
  (*Resets in 3h 56m. This work fits comfortably.*), the gauge, and a *What does
  this mean?* that describes only the marks that card draws. Cards keep their own
  height. The limits that can't be read at all collapse into one line per account
  (*2 other Codex limits can't be read yet: the provider doesn't say when they
  reset.*),
  their technical rows behind the account's *Show account details*.
  Under each card's *Show details*: the limit key, what is left, the
  reset countdown with the read's clock time (`resets in 3h58m (as of 11:02)`),
  the work rate in %/work-hour with its confidence and warnings, what the work
  alone uses and leaves at the reset (across how many windows when more than
  one; *runs the limit out before the reset* in words), and the chance of going
  under the reserve alone and with other use of the account — *at least* on a
  lower-bound burn, *no draw went under the reserve (the burn is a lower bound)*
  instead of an empty *at least 0%*, *(already below it)* when it is. Every
  unknown reads *unknown* with the reason from `missing` and `missingInputs`,
  never 0%. The budget block's own *Show reserve details* names the reserve,
  provisional or not, that the work runs serially from now, and that the data is
  this machine's only.
- **Where these numbers come from**, a closed disclosure: the forecast,
  calibration and budget snapshot ids, the instant, and whether the scope is the
  subtree or the issue itself.

The forecast re-reads on the page's refresh fingerprint.

## Autopilot runs

The page watches and stops [autopilot runs](runs.md); it never starts or
continues one. Everything reads one `GET /api/runs` per change fingerprint
(`lib/runs.ts`). [runs.md](runs.md#in-the-web-ui) has the full description.

- **The rail's Autopilot section**, once the workspace has had a run: one card
  per live run (its scope, progress, the next ticket, what would stop it, its
  state, whether a driver is attached, **Stop** and **Details**), then *Run
  history*. On a phone the first live run is one line above the tab bar with a
  44px Stop.
- **The badge.** A task a live run holds, the run's scope row and a folded
  parent hiding held work wear an *Autopilot* badge; the task's detail says
  which run is working on it.
- **Run history** (*Autopilot runs*): *Running now* and *Earlier*, each run with
  who ran it, over what, when, how long, its driver, its tickets and how each
  went, and how it ended in plain words (`lib/run-text.ts`). Live runs have
  **Stop** and **Pause** / **Resume**. Stop asks first and takes an optional
  note: `POST /api/run/stop`; pause and resume are `POST /api/run/pause` and
  `/api/run/resume`.
- **Stop notices.** When a run ends, every open page shows a notice within one
  refresh: why, and a link to what needs a person (*Review*, *Unblock*,
  *Open*). It sits in the corner on a desk, above the run strip on a phone, and
  inside the detail while a task is open. What this browser has already seen is
  kept in `staple:run-stops:v1`.

`components/autopilot/autopilot-e2e.test.tsx` drives the banner, the phone
strip, the badge, the history, a stop notice and a stop from the page against a
real server and real runs.

## Choose a workspace

Queue and Estimates are about one workspace at a time. On *All workspaces* with
more than one workspace they show a **Choose a workspace** card instead
(`views/ChooseWorkspace.tsx`, `views/workspace-scope.ts`): a sentence saying why
(*Each workspace keeps its own pickup order, so there is no single queue for all
of them.*), a button per workspace with its prefix, and *What does this mean?*.
Choosing one is the same as choosing it in the switcher, and it becomes the
default answer when New task or Settings ask which workspace. Tasks and Graph
show every workspace at once; Milestones shows its read-only all-workspaces
list; Usage is not about a workspace at all.

## Settings

One **Settings** sheet holds everything configurable from the page, for this
computer and for every workspace (`settings/SettingsDialog.tsx`,
`settings/settings-shell.ts`). It opens from the Settings row at the foot of the
rail, from the command palette ("Settings", "Settings: Usage", "Settings: Cloud
account", "Settings: Statuses"), from the sync pill, or by URL: `?settings`
opens it on its list, `?settings=kinds` opens one section, and
`settings-ws=<workspace>` says which workspace a per-workspace section edits.
Opening from the rail pushes one history entry, so Back closes it and lands on
the page you were on; moving between sections or workspaces replaces that entry
rather than adding to it. A deep-link arrival pushed nothing, so closing strips
the parameters in place.

**Two panes.** Left, the sections in two groups. *Across all workspaces*: *Cloud
account*, *Workspaces on this computer* (the hub registry), *Usage*, and *This
computer* (the machine's `config.json` preferences: `browser`, `port`,
`setupComplete`). *Per workspace*: *Statuses*, *Task types*, *Picking up work*
and *Cloud sync*. The registry sections come from `src/core/settings-registry.ts`
(the page shows *Task types*, *Picking up work* and *This computer* for the
registry's *Kinds*, *Workflow* and *This machine*); the cloud and usage
sections are the page's own. Right, the selected section, with a line saying
whom it applies to (*Applies to every workspace on this computer*, *Applies to
staple only*). Under the title a line says whether a workspace is being
edited. A per-workspace section carries its own workspace picker, and changing
it re-points the section without closing the sheet. Opened from *All
workspaces* with no workspace remembered, a per-workspace section shows a
*Which workspace?* card (`settings/WorkspaceChooser.tsx`) instead of editing
the first one. Scroll position is kept per section, and selecting one does not
move focus off the list.

**Narrow screens** (below 768px) stack the panes: the list first, then the
section, with *Back to categories* in the header (and the phone's Back) that
returns to the list and puts focus back on the section you were in. The
stacked frame is the whole viewport, so no form is clipped by a centred dialog.

**Full screen.** On wide displays *Enter full screen* takes the sheet edge to
edge and *Exit full screen* brings it back; it is per open and never
persisted. Esc closes, as every dialog in the app does.

What a registry section holds is decided by its `editor`: `statuses` and
`kinds` are the two vocabulary editors below; a `fields` section renders a
control per registered definition (see
[Registry-driven categories](#registry-driven-categories)).

### Form primitives

Every section is built from one set of primitives (`settings/form/`), so
saving, cancelling, dirty state, inline errors and conflicts behave the same
way everywhere:

- **Field** — a label, a description, the control, an inline error
  (`role="alert"`, tied to the control with `aria-describedby`) and a scope
  tag that says *Workspace* or *Global* and where the value came from
  (`default`, `workspace`, `config`). **Section** groups fields and carries the
  error that belongs to no single field.
- **ActionBar** — *Save changes* / *Cancel* / *Reset to defaults*, sticky at
  the foot of the section, with a *Saved* confirmation after a save. Nothing is
  written until Save; Cancel drops the draft; Reset is offered only by forms
  that have defaults to go back to. While a save is in flight the bar says
  *Saving…* and every control is disabled; a refused save keeps the draft and
  puts the store's sentence on the row or field it names, or on the section
  when it names none. Nothing is paraphrased and nothing is retried.
- **ReorderList** — drag by the handle, or the per-row *Move up* / *Move down*
  buttons, or Alt-arrow on the row. After a keyboard move focus stays on the
  moved row: on the same button, or on the other one when the row reached an
  end and that button became disabled. In a narrow pane the handle and the
  buttons give way to one `⋯` menu per row (*Move up*, *Move down*, *Remove*).
- **Destructive confirmation** — a removal opens an inline confirmation under
  the row, with the migrate-to picker when issues still carry it; the
  confirm button stays disabled until a target is chosen.

**Unsaved changes.** A form with a draft reports it to the shell, and every
way out — the X, Esc, a click outside, the narrow layout's Back, selecting
another section, closing the tab — asks first: *Discard changes* or *Keep
editing*. Nothing leaves a dirty form on a keypress.

**External revisions.** The 1.5s poll republishes the settings envelope while
the sheet is open. A clean form simply shows the new state. A dirty form
remembers the served state it started from; when that moves underneath it
(another tab, an agent through MCP, the CLI) a conflict banner appears and
Save is held until you choose: *Reload* drops the draft and shows the new
state, *Keep my changes* keeps the draft and makes the next save a deliberate
overwrite. The store remains the authority — a batch it refuses after that
comes back as a refusal on the responsible row.

### Statuses and kinds

The status set and the kind vocabulary are workspace data, not staple's
(see [semantics.md](semantics.md)).

Two lists. Each row has an editable label, a drag handle, and — for statuses —
a category select; removing a row that issues still carry requires a target to
migrate them onto. Reorder by dragging, or with the per-row move buttons, which
are the keyboard path and are always visible rather than revealed on hover (in a
narrow pane, the row's `⋯` menu).
Edits accumulate as a draft — the list shows what Save produces, with the
usage count moved along by a migrate-to removal — and Save posts them as one
ordered, all-or-nothing batch of the same ops the MCP tools take. A refusal
is the store's own sentence, on the row it names. A kind row carries one thing
more: its glyph, which is also the control that changes it (see
[Glyph picker](#glyph-picker)).

Behaviour follows the CATEGORY, never the id. A workspace that adds `pairing` in
`active` gets a claimable status wearing the in-progress glyph and the
in-progress colour, with no new theme token — `styles/app.css` maps the eight
categories onto the existing `--status-task-*` hues.

**Order.** The sheet's list is the CONFIGURED order. Lists and group headers use
the LIST RANK, which the server computes: categories in a fixed sequence (active,
review, gated, blocked, ready, unstarted, then done and cancelled) with the
configured order breaking ties inside each one. So dragging reorders statuses
within a category, and moving one between groups means changing its category.
Rows sort by the same rank, so a header can never sit above rows ordered
differently.

`GET /api/settings` returns the vocabulary, the derived orders, the category set,
and a per-id count of what still carries it. `POST /api/settings` takes
`{ target, ops }` — the same ordered, all-or-nothing op batch as the
`update_statuses` / `update_kinds` MCP tools — and answers with the identical
envelope, so the page re-derives from one response rather than merging. It is
the only route that both reads and writes.

The same envelope carries the **settings registry**
(see [configuration.md](configuration.md#the-settings-registry)): `registry`
lists every category with its scope and editor and every typed definition;
`values` holds this workspace's registered values, each with its `source`
(`default` or `workspace`) and version; `unknownKeys` names stored keys this
build has no definition for; and `global` is the machine's `config.json` with
each value's `source` (`default` or `config`) — served read-only, because its
write path is `staple config set`. `target: "settings"` takes
`{ op: "set", key, value }` / `{ op: "reset", key }` ops for workspace keys
and refuses a global one. `lib/settings.ts` exposes `settingCategories()`,
`settingDefinitions()` and `settingValue()` over the served registry; nothing
in the browser restates a definition.

### Registry-driven categories

A `fields` category is its definitions, rendered as controls chosen by each
one's value schema: a boolean is a switch, an integer a number field with the
schema's bounds, a string a text field whose description carries the pattern
hint, an enum a select over the registry's values. Each control sits in a
Field with the definition's label and description, its scope tag and source,
and its own *Reset* to the default. Values are checked against the schema
before the round trip; the store still refuses on its own terms, and that
sentence lands on the field whose key it names. Save posts `target:
"settings"` ops — `set` per changed key, `reset` for a stored value sent back
to its default. Global-scope definitions render disabled with the sentence
naming `staple config set`. Registering a definition is the whole of adding
it to the page: nothing in the form names a setting.

**Picking up work** (the registry's *Workflow* category, id `queue`) is the
first such section in workspace scope, and its control is the queue policy
([configuration.md](configuration.md#queuepolicy)): a select over `advisory`
and `strict`, with the registry's description stating before you save what
`strict` changes for agents, and the scope tag beside it saying *Workspace ·
default* until a value is stored and *Workspace · workspace* after. The
category, the control and its explanation all come from the registry entry;
`settings/fields-form.test.tsx` renders a second fixture toggle beside it and
pins that none of the shell's files names the setting or the category. *Task
types* carries two registry fields as well: `kinds.default` (the kind a new
ticket gets) and `kinds.appearance` (the glyphs, edited through the
[glyph picker](#glyph-picker)). *This computer* shows the global definitions
(`machine.browser`, `machine.port`, `machine.setupComplete`), disabled, with
the sentence naming `staple config set`.

Adding a setting or a category of your own is a registry entry and nothing
else — the checklist is
[configuration.md → Adding a setting](configuration.md#adding-a-setting). That
the claim holds end to end is asserted rather than assumed:
`test/settings-verification.test.ts` registers a category no build has ever
had, serves it through the real HTTP server and renders this shell from that
envelope, then reads the shell's own sources to prove none of them names it;
`settings/settings-verification.test.tsx` renders every breakpoint with both a
registry-driven and a vocabulary category, and pins the unsaved-changes guard,
the conflict banner's two ways out, and the label, scope, error and
`aria-current` wiring over every field and button on the surface.

### Cloud: the hub registry

Three sections deal with sync, and none of them is in the settings registry:
they read `/api/cloud/status` and write the cloud routes, which act on this
computer's files, because a credential written to the workspace database would
replicate to every device. Opening them makes one network-free request; nothing
leaves the machine without a press. See [sync.md](sync.md).

- **Cloud account** (across all workspaces): this computer's connection to the
  sync service. Connecting is two steps: a preview of the service, then a
  connect that carries only the consent id the preview minted.
- **Cloud sync** (per workspace): whether this workspace syncs, and the devices
  it syncs with, listed only when asked (`/api/cloud/workspace/*`).
- **Workspaces on this computer**: the hub registry panel below.

The **hub registry** panel is the page's half of `staple hub registry`: four
tiles for its state (*Registry id*, *Service*, *Publishing*, *Hub backups*),
then one block per step.

- **Identity.** The hub's registry id, or *None yet*. *Mint an id* is
  `staple hub registry id`; *Take on an existing id* is `staple hub registry
  identity`. Replacing an id asks first, and the question is the server's
  `describeIdentityReplacement` sentence. It is shown whenever there is a
  previous id, because this machine cannot tell whether that id was used. The
  yes names the id the warning was about. If another tab or the CLI changed the
  stored id in the meantime, it is refused. Unavailable while the hub is
  connected.
- **Connection.** A collapsed form for endpoint, enrollment secret, label and
  credential store. *Review connection* shows the hub's own preview; *Connect*
  sends only the ticket and the secret. Connected, it offers *Disconnect the
  hub*, which is local and leaves what was published on the service.
- **Publish.** The publish switch, with `REGISTRY_DISCLOSURE` from the report,
  and *Publish now*. The result lists every group the publish report carries:
  what the service holds that this machine lacks, names that differ between
  here and the registry, link retractions and re-links, and anything that
  could not be published.
- **Backups on the service.** Its own switch, asked of the service first. The
  list is fetched only when *Show backups* is pressed. *Restore…* on a row
  shows the CLI's disclosure, and the confirm button names the backup, its
  epoch and its entity count. The server checks those three against its own
  list and restores nothing if they differ. Afterwards the panel names the
  undo copy, marked *undo* in the list, and previews the adoption of what came
  back.
- **Adopt.** *Preview adoption* lists one decision per incoming workspace and
  per link. *Apply N changes to this machine* carries the preview's digest.
  The server reads the service once, checks that read against the digest and
  applies that same read. If anything moved since the preview, it refuses and
  writes nothing. The count includes clearing a stale opt-out on a row that is
  already here, and that row shows its sentence.

Nothing in the panel reaches the service without a press. The routes are the
eleven `POST /api/hub/registry/*` routes, each named in the method gate.
`test/network-silence.test.ts` drives every one of them in the state where it
must not leave the machine.

### Usage & budget

The *Usage* section (across all workspaces, after *Workspaces on this
computer*) configures provider budget capture without the CLI. Like the cloud sections it is not in the settings
registry: everything it changes is this computer's (`config.json` `telemetry`,
the Claude settings file, `~/Library/LaunchAgents`) and nothing of it is
synced. It is written for a reader who has never seen the CLI, and each plain
sentence is chosen from a value the server sends (a problem `code`, a plan
step's `part` and `action`, a wrapper `state`), never parsed out of a message.
The server's own sentences stay behind *Show details*.

- **At a glance.** On, Off or *Needs attention*, as a word and an icon; the
  privacy note ("readings stay on this computer; nothing is sent anywhere", or
  with live checks on, what is sent and to whom);
  *Turn usage tracking on/off* (`staple budget capture on|off`) behind an
  inline confirmation; *Collect now* (`staple budget collect`) with what it
  found in words; *Check again*.
- **Live checks.** On, Off or *Waiting* (on, but tracking is off);
  *Turn live checks on/off* (`staple budget live on|off`) behind an inline
  confirmation that says, before it is pressed, what is asked, of whom and
  with which sign-in; each linked account with the host it asks, when it was
  last checked, and a failed check's reason.
- **Where readings come from.** Each bound source with its account, the age of
  its newest reading, and how it is fed: the status-line wrapper's state for
  Claude, the watcher's for Codex. The status's problems follow, in everyday
  words.
- **Automatic collection.** *Turn on automatic collection* (or *Check or
  repair automatic collection* once it is on) opens a short form (the two account
  labels, pre-filled from existing bindings; the status-line step and the
  Codex check, both on), then *Show me what will change* asks
  `POST /api/budget/collection/plan` and shows the plan as sentences ("Turn on
  usage tracking", "Add a small step to your Claude status line … (a backup of
  your Claude settings is kept)", "Check your Codex sessions every 5 minutes").
  *Confirm and turn on* sends back only the plan's single-use consent ticket
  and digest. *Turn off automatic collection* shows the unsetup plan the same
  way. A ticket that
  went stale (expired, used, or the machine changed under the plan: 404 or
  409) is never retried: the page asks for the plan again and shows it with
  the reason, to be confirmed again. A plan that refuses has no Confirm. A
  setup that stopped partway (`setup_incomplete`) says so and lists what was
  already done. The flow is `settings/telemetry-flow.ts`.
- **Account links.** List, add, edit and remove bindings (what it reads, the
  folder, the account label, and under *Advanced* the provider). Nothing is
  validated in the browser: the server runs the CLI's own checks, and its
  refusal's `detail.reason` picks the plain sentence on the form ("The account
  label can only use lowercase letters, digits and dashes …"); the CLI's own
  sentence, which names flags, stays under *Show details*. Editing a link is
  one write that replaces the old binding in place, and it is refused when the
  new folder already has a link of its own, so an edit never removes another
  link. Switching what a link reads resets its provider to that source's
  default.

The section is built from the plain-language cards (`components/plain/*`:
`PlainCard`, `StatusPill`, *What does this mean?*, *Show details*) and the
`--plain-*` colour tokens. Its state and handlers live in
`settings/telemetry-controller.ts`, which `TelemetrySection` subscribes to, so
`settings/telemetry-e2e.test.tsx` drives the real handlers against the real
server (with a stub launcher and a stateful fake launchctl in a private HOME,
so setup really plans, installs, fails and removes the watcher).

**From another device.** The app's own page writes from another device too: it
sends the token header (see *The write rule* under Auth). A page on another
origin WITHOUT the header (one that does not hold the token) is refused, and
that refusal carries `detail.reason: "cross_origin"`. This section still turns
its own writes off when opened from another device (below), a choice about
configuring this computer from elsewhere, not a server refusal. `lib/api.ts` treats it as an ordinary refusal, not a dead
token (no token screen), and `describeRefusal` words it once for every view:
*"Changes can only be made from this computer's browser …"*, with the server's
sentence kept as `serverMessage`; the refusal strip (`GuardRefusal`) frames it
as *only from this computer's browser*, not as a store guard. A page not on
`127.0.0.1` or `localhost` says so up front in this section and turns its
write buttons off; `/api/bootstrap` also returns the server's `writeOrigins`,
so a page on `localhost` through a port-forward (another port) is recognised
as remote before anything is pressed.

Problems about one account or folder are one line each, naming it ("No
reading yet from claude-max (Claude status line)…", "The Claude folder … is
linked, but its status line doesn't record usage yet"); a bound folder with no
Claude settings file says exactly that. The subjects come from the status's
own `sources` and `statusline` values, never from the message.

Routes (each the same store or service method as the CLI verb):
`GET /api/budget/collection` (`budget status`), `POST
/api/budget/collection/{plan,setup,unsetup,collect}`, `GET
/api/budget/bindings` (`budget bindings`), `POST /api/budget/capture`
`{enabled}` (`budget capture on|off`), `POST /api/budget/bindings/bind`
`{source, account, provider?, configDir? | codexHome?, replacing?}` (`budget
bind`; `source` is `claude-statusline` or `codex-rollout`, and `replacing`
names the binding an edit replaces), `POST /api/budget/bindings/unbind`
`{source, configDir? | codexHome?}` (`budget unbind`) and `POST
/api/budget/live` `{enabled}` (`budget live on|off`). All are POST-only where
they write, token- and Origin-checked, and skip the post-write sync trigger.
The server also answers `POST /api/budget/forget` (`budget forget`), which the
page does not use.
`test/budget-bindings-http.test.ts` runs each write through the CLI and the
route and compares the two `config.json` files and answers, refusals included;
`settings/telemetry-e2e.test.tsx` drives the page's own API functions against
the real server.

## Glyph catalog

Every kind wears one **appearance** record — `{ source, value, label, fallback }`
— resolved by the server and served on each row of `/api/settings` `kinds[]`,
the same record `staple kinds ls --json` and MCP `list_kinds` answer. The
operator's choices live in the `kinds.appearance` workspace setting (see
[configuration.md](configuration.md#the-settings-registry)); a kind with no
entry wears the built-in mark, and a kind that has none wears a generic one.
`lib/kind-appearance.ts` mirrors the built-in table so the first paint, before
the fetch lands, already shows the right marks, and `kindAppearance(id)` in
`lib/settings.ts` is the accessor every row, group header, form and graph node
resolves through. No
colour travels in the record: hue is a status-category property, and a kind
glyph is monochrome by design.

### One resolver

There is exactly one component in the browser that turns an appearance record
into pixels: `components/task-list/KindGlyph.tsx`. Given no `appearance` prop it
resolves the served record itself through `useKindAppearance(id)` — the
`kindAppearance` accessor wrapped in a `useSyncExternalStore` subscription to the
settings snapshot — and then draws the arm the record names: `emoji` and `svg`
through `SafeGlyph`, `lucide` through the catalog chunk, `none` (and anything
that fails validation, including a Lucide key the catalog does not know) through
its own hand-drawn mark, so a slot is never empty. Because the resolution happens
inside the glyph, every surface gets it by drawing `<KindGlyph kind={…}/>` and
nothing else: ungrouped and grouped rows and the epic-headed sections
(`TaskRowLine`), kind group headers (`views/tree/TreeGrid.tsx`), graph nodes and
the epic picker (`views/graph/`), the create dialog and the detail panel's kind
editor, and the settings preview. And because the subscription is to the same
snapshot the settings editor republishes after its POST — and the 1.5 s
fingerprint poll refetches — **changing a kind's glyph repaints every one of them
without a reload**. The `appearance` prop survives for the one caller drawing
something not saved yet: the picker's preview. The `lucide` arm is asynchronous
(the catalog is its own chunk); the built-in mark is the synchronous fallback
while it loads, cached module-wide so only the first glyph on a page waits.
`components/task-list/kind-glyph.test.tsx` renders all six seeded kinds and one
custom kind at the row, header, graph-node, picker and form sites, and swaps the
published envelope to prove the re-render.

The catalog a `lucide` value names is not a hand-kept list: it is generated
from the INSTALLED `lucide-react`, and checked in. The server validates only
that a value is *shaped* like a key (the manifest is browser code); the
browser's `resolveIcon` decides whether it exists, and an unknown key answers
`undefined` — the cue to draw the fallback.

```bash
npx tsx scripts/gen-lucide-catalog.ts    # after bumping lucide-react, or editing the category table
```

That writes two modules under `src/ui/app/src/lib/`. `icon-catalog.generated.ts`
is data only — the pinned `LUCIDE_VERSION`, the category list, and every canonical
key with its category and aliases. `icon-previews.generated.ts`
names every icon by a real import from `lucide-react`, so a key that does not
exist in the package fails `npm run typecheck` and `npm run build:ui`, not a user.
`test/lucide-catalog-freshness.test.ts` regenerates in memory and fails, with the
command above, if the checked-in text is stale.

The source of truth is the package's own `dynamicIconImports` map. A key that
points at itself is canonical; one that points elsewhere is an alias, and aliases
never become keys — `alert-triangle` collapses onto `triangle-alert`, is recorded
on that entry, and its words join the entry's search terms (Lucide's aliases are
its synonym list: `home` finds `house`). The package ships
no tags or categories, so the category comes from an ordered keyword table in the
generator — first row sharing a word with the key wins, then the same pass over
alias words, then `other`. Deterministic and offline: the same version gives the
same catalog on every machine.

`lib/icon-catalog.ts` is what the app consumes. It rebuilds the human label
("Triangle Alert"), the search terms, and the alias map from the manifest at
load, so the checked-in data stays small enough for the main view to carry
(rows resolve persisted keys synchronously). `resolveIcon(key)` accepts a
canonical key, an alias, or "Triangle Alert" and answers the canonical entry (or
`undefined` — the cue to fall back); `searchIcons(query, { category, limit })` is
ranked (exact key, whole word, prefix, alias word, substring) and stable;
`loadIconComponent(key)` reaches the React component through `import()`, so the
module that names every icon is its own chunk (about 140 kB gzipped) and the main
view never pays for icons it does not draw. Importing the catalog module costs
the manifest alone, about 12 kB gzipped.

### Custom glyphs

When the catalog is not enough, a kind can wear an **emoji** or a **custom
SVG**. Both are validated in core (`src/core/kind-appearance.ts`), and both
are drawn by one browser primitive, `components/task-list/SafeGlyph.tsx`, which
`KindGlyph` delegates an `emoji` or `svg` record to, drawing its own built-in
mark for anything else. The **glyph picker** below is how an operator chooses
one.

An **emoji** value is bounded by grapheme clusters, not bytes: `Intl.Segmenter`
counts what a person sees as one glyph, so a joined family (`👨‍👩‍👧‍👦`, eleven
UTF-16 units) or a flag is one, and the bound is 1 to 2 of them with a ceiling
of 32 units. Whitespace, control characters, lone surrogates and a value with
no visible code point (a bare zero-width joiner) are refused. The browser draws
it as text, which is safe by construction.

A **custom SVG** goes through `src/core/svg-sanitize.ts` — pure string work, no
DOM, no dependency — and only the sanitiser's **canonical output** is ever
stored, served or drawn. The security model has three walls:

1. **The write boundary.** `kinds.appearance` accepts an `svg` value only if it
   is exactly the sanitiser's output (a fixed point: sanitising it again
   returns it unchanged). A raw document is refused with a sentence saying to
   sanitise it first; a hostile one is refused with the reason. The sanitiser
   is an allowlist, not a denylist: `svg`, `g`, `path`, `circle`, `ellipse`,
   `rect`, `line`, `polyline`, `polygon`, `defs`, `clipPath`, `symbol`, `use`
   and a `title`/`desc`, with the presentation and geometry attributes those
   take. It **refuses** `<script>`, `<foreignObject>`, `<style>`, `<image>`,
   `<a>`, animation elements, a nested `<svg>`, every `on*` attribute,
   `javascript:`/`data:`/`vbscript:` URLs in any attribute (including
   entity-encoded spellings), `url(` to anything but a local `#id`, an `href`
   that is not a local `#id`, `@import` or `url(` in a `style`, DOCTYPE and
   entity declarations (so a billion-laughs document never reaches a parser),
   CDATA, processing instructions, undeclared entities, control characters,
   malformed or truncated markup, more than 512 elements or 32 levels, and
   anything over 8 KiB. It **strips** what an editor leaves behind: the XML
   declaration, comments, `xmlns:*`, `class`, `data-*`, `style` (when it
   carries nothing external), unknown attributes, and `width`/`height`/`x`/`y`
   on the root.
2. **The canonical form.** The root is rewritten as
   `<svg xmlns viewBox role="img" aria-label>`: the `viewBox` is normalised
   (derived from a plain width and height when absent) and bounded to ±4096 with
   a positive width and height of at most 4096; absolute sizing is gone, so the
   glyph inherits the caller's box; every `fill` and `stroke` becomes
   `currentColor` unless it is `none`, so the glyph takes the row's colour like
   the built-in marks; and exactly one `<title>` carries the accessible name —
   the document's own root `<title>` if it had one, else the record's `label`,
   else its `aria-label`, else the document is refused. Attributes are written
   in one order with escaped values, so equal drawings give equal strings.
3. **The browser's gate.** `safeGlyph` in `lib/kind-appearance.ts` does not
   trust the wire: before anything is injected it holds the value to the exact
   shape the sanitiser writes (that root, only those elements, no handler, no
   non-local reference) and answers null for everything else. `SafeGlyph`
   places the canonical body inside an `<svg>` it owns — which sets the size,
   the recorded `viewBox` and the accessible name — and that body is the only
   string in the app that ever reaches `dangerouslySetInnerHTML`. Null draws
   the record's terminal `fallback` as text, so an invalid record costs the row
   nothing but its custom mark.

The same suites that prove this live in `test/svg-sanitize.test.ts`,
`test/kind-appearance.test.ts`, `test/store-settings.test.ts` (custom glyphs),
`test/contract-kind-appearance.test.ts` (a hostile save is refused and no
surface carries executable markup) and
`components/task-list/safe-glyph.test.tsx`.

### Glyph picker

Every row of the *Task types* editor carries its glyph, and the glyph *is* the control:
pressing it (*Change glyph for Epic*) opens the picker under that row. Three
tabs, one preview, and one form shape — `{ source, value, label, fallback }`
— whichever tab produced the choice. `settings/glyph-picker/` holds it:
`glyph-picker-model.ts` is every decision as a function, `GlyphPicker.tsx` the
wiring, `GlyphPreview.tsx` the preview.

**The catalog tab** is a search field over names and Lucide's own aliases
(`alert-triangle` finds `triangle-alert`), a category filter over
`ICON_CATEGORIES`, and a live count. The grid is a `listbox` that takes focus
itself and names its active cell through `aria-activedescendant` — which is
what makes a WINDOWED grid navigable at all, since the cell holding the
"focus" need not be in the DOM until the arrow key that reaches it scrolls it
into the window. Arrows step a cell or a row, Home and End jump, Enter or
Space chooses, Escape closes; the index is clamped rather than wrapped. Only a
viewport's worth of cells plus two overscan rows exist at a time and two
spacers stand in for the rest, so scrolling ~1,800 icons costs the DOM a few
dozen nodes. Each cell is a `role="option"` with the icon's label as its
accessible name.

The icon COMPONENTS arrive through `loadIconComponents()` — the `import()`
that makes `icon-previews.generated.ts` its own chunk — and only once the
catalog tab is open, so a page that never opens the picker never fetches them.
Until they land a cell is a placeholder box, and the search, the keyboard and
the choice all work without them. The main bundle therefore carries the
manifest (data only, about 12 kB gzipped — `resolveIcon` answers synchronously)
and never the icon code (about 140 kB gzipped).

**The emoji tab** is one field, held to the same grapheme rule core states
(`isEmojiGlyph`). **The custom SVG tab** posts the raw document to
`POST /api/glyph/sanitize` — core's `sanitizeSvg`, over the wire, writing
nothing; the route exists because the store accepts an `svg` value only as
that function's canonical output and the sanitiser is Node-only code the
browser cannot import. Only the answer becomes a choice; the raw text never
enters the draft, and a refusal is the sanitiser's own sentence.

A **recents** strip remembers the last twelve choices in `localStorage`
(`staple:glyph-recents`). An `svg` is not remembered: a canonical document is
up to 8 KiB, and twelve of those is not what a recents strip is for.

**The preview** is not a second renderer. It hands the appearance the draft
currently holds to the same `KindGlyph` a list row draws, at the row's 12 px
and the graph node's 14 px, so what the picker shows is what those surfaces
show by construction — every source, `lucide` included, since the glyph
resolves all of them itself. Beside it are the accessible name and the terminal
fallback, both bounded exactly as core bounds them, and *Reset to default* —
offered only when this kind has an entry to drop. The picker sits beside the
chooser when the shell is two-pane or full screen and below it when the shell
is stacked, from the same `STACKED_QUERY` the dialog uses, so the two never
disagree about how wide the world is.

**Nothing here writes.** A choice enters a SECOND draft — the
`kinds.appearance` map, posted to `target: "settings"` — held beside the
vocabulary ops rather than inside them, because the store lets that map name
only CONFIGURED kinds: a glyph for a kind the same draft is adding can only be
written after the kinds batch lands. Save therefore posts the ops first and the
map second (one `set` of the whole map, or `reset` when nothing is customised
any more), and a refusal on the second cannot re-post the first. The user sees
ONE form all the same: one dirty state, one ActionBar whose summary counts
both halves, one Cancel that drops both, one unsaved-changes guard, and one
conflict banner for either half moving underneath.

`settings/glyph-picker/glyph-picker-model.test.ts` pins the arithmetic,
`glyph-picker.test.tsx` the markup, and `test/ui-glyph-sanitize.test.ts` the
route.

## Projects

A project is a named container an issue can be filed under — the thing the rail
lists under Tasks and the thing the Project filter narrows by. It is workspace
data: workspace migration **009** adds a `projects` table and a nullable
`issues.project_id`, alongside milestones and the queue.

**Two kinds.** An **unmanaged** project is a name and nothing else. A
**managed** project points at a source, and the source's kind is stored
explicitly rather than inferred from the shape of a string: `github` (a
repository URL like `https://github.com/owner/repo`) or `local` (a folder path).
The record is `{ id, slug, name, kind, sourceKind, source, createdAt, updatedAt }`;
`sourceKind` and `source` are null exactly when the kind is `unmanaged`.

**Rules.** The name is required. A managed project needs both a source kind and
a source; a GitHub source must look like a repository URL; a local path is any
non-empty string — nothing probes the network or the filesystem. An unmanaged
project may not carry a source: sending one is refused rather than dropped. The
rules are pure (`src/core/projects.ts`) and pinned in `test/projects.test.ts`.

**Slug and id.** The slug is derived from the name once, at create time
(`My Project (v2)` → `my-project-v2`, numbered `-2`, `-3` when taken), and a
rename leaves it alone. Every lookup answers to the id or the slug. An issue
points at a project by `projectId` — at most one, exactly like `parentId`, and
null for every issue that predates the migration. Deleting a project lets its
issues go (their `projectId` becomes null in the same transaction) and touches
nothing else about them.

**The dialog.** One dialog creates and edits: a *General* section (name, kind
— and, on a create in hub mode with several workspaces, which one) and a
*Source* section that appears for a managed project (source kind, then the URL
or the path, labelled by kind). Errors sit beside their field once a save has
been tried, in the form's own words; a store refusal renders the store's
sentence unchanged. An edit starts on the served values, saves only when
something changed, and offers *Delete project* behind a confirm that says what
deleting does — the issues stay, unfiled. The draft is a discriminated union on
kind (`components/projects/projectForm.ts`, pinned without a DOM), switching
kind keeps the name and drops or seeds the source, and the sections are a list,
so a new project setting is one more entry.

**Where a project shows up.** The page fetches every workspace's projects once
per poll and narrows them where they are used, so an issue opened from another
workspace still sees its own workspace's projects. The rail lists them under
Tasks; the **Project** filter dimension offers them by name (captioned with the
workspace when the page spans several) and matches on the id, so a saved filter
survives a rename — and a deleted project's id is dropped from every saved
scope on the next poll, so no chip outlives its project; the
New task dialog has a *Project* select (no project by default, narrowed to the
target workspace); and the detail panel's property block has a *Project* row
that is an editor, like Kind, writing through `/api/project/assign`.

**Routes.** `GET /api/projects` answers `{ workspace, project }` rows — for one
workspace with `?ws=`, and in `--hub` mode with no `ws` for every workspace at
once, so two projects called `docs` in two workspaces are tellable apart. The
writes are POST-only and Origin-checked, the milestone family's shape:
`/api/project/create`, `/api/project/update` (absent fields keep their value;
changing the kind means changing the source in the same call),
`/api/project/delete` (answers how many issues it let go of) and
`/api/project/assign` (`{ ref, project }`, where `project` is an id, a slug, or
null to take the issue out; answers the refreshed `/api/issue` payload). A task
created through `/api/action` may name a `project`. `/api/issues` rows and the
detail payload carry `issue.projectId`. `test/contract-projects.test.ts` pins the
gate, the refusals and the row shape; `test/store-projects.test.ts` pins the
store. CLI and MCP have no project verbs — `projectId` simply rides along on the
issue shape they already print.

## Auth

Pages served to loopback carry their own token, so the browser never sees a
token screen. The token — for curl, agents, and remote tabs — lives in
`~/.staple/ui-token` (0600) and survives restarts; delete the file to rotate it.

Every `/api/*` route is gated by the per-process token (`X-Staple-Token`,
`Authorization: Bearer`, or `?token=`), compared with `timingSafeEqual`; writes
are `POST`-only and every route pins the methods it accepts.

**The write rule** ("Origin-checked" throughout these docs). A `POST` is accepted
when its `Origin` is absent (curl, the CLI) or is the server's own loopback page
(`http://127.0.0.1:<port>`, `http://localhost:<port>`), **or** when it carries the
token in the `X-Staple-Token` header, compared in constant time. The page sends
that header on every request (`lib/api.ts`), so the app opened through a forwarder
that keeps the browser's own Origin (a phone on the tailnet; the forwarder
rewrites `Host` to loopback, which is what seeds the token into the page) can
write like the page on this computer. A cross-site page cannot set a custom
header without a CORS preflight, and the server grants none: it sets no
`Access-Control-*` header anywhere, and an `OPTIONS` is refused by the token or
method gate like any other method. So a forged form or `fetch` from another site
arrives without the header and is refused (`403`, `detail.reason:
"cross_origin"`). `?token=` and `Bearer` open reads only and never stand in for
the header on a write: a query string rides a plain cross-site form. Pinned in
`test/ui-auth.test.ts` and `lib/api-write-header.test.ts`.

**One exception.** `POST /api/budget/collection/refresh`, the Usage view's
Refresh, is gated by the token alone, in any of its transports, and skips the
Origin check. It takes no input, can only do what the collection schedule
already does, and asks a provider at most once a minute per account, which is
why no other write may join it. `test/budget-refresh-http.test.ts` pins that
every other write still refuses a foreign Origin.

**A forwarder must check the Host it was sent.** Because the forwarder rewrites
`Host` to loopback, the server cannot tell which name the browser used, and a
page on a domain that resolves to the forwarder's address (DNS rebinding) would
be handed the token like the real page — and, with the header rule, could write.
So the forwarder answers only requests whose `Host` is its own tailnet name or
address (`100.x.y.z:<port>`, `<machine>.<tailnet>.ts.net:<port>`) and refuses
every other one (`421 Misdirected Request`) before forwarding anything. That
check lives in the forwarder, not here: this server only ever sees loopback.
The app reads the token out of its own URL once, keeps it in `sessionStorage`,
and strips it from the address bar. Arriving without a valid token renders an
explanation, not a blank page.

## Stack

The page is a Vite + React + TypeScript app in `src/ui/app/`, shipped inside the
package as a prebuilt static bundle that `src/ui/server.ts` reads off disk.

React 19, Tailwind v4, [shadcn/ui](https://ui.shadcn.com) in the *new-york*
style, `radix-ui` primitives, `lucide-react` icons, React Flow (`@xyflow/react`)
and dagre for the graph, `@dnd-kit/core` for drag. All of it is a
**devDependency**: what ships is the built app, not the toolchain that made
it.

## Theme

The styles are four layers, imported in this order by `styles/app.css`:

- `theme-tokens.css` holds 531 CSS custom properties: the light and dark
  scales, the radius and type ladders, motion, the `.status-chip` color-mix
  recipe, and the plain-language card tones (`--plain-*`) and chart ramp
  (`--viz-*`).
- `geist-tokens.css` re-layers colour, type, surfaces and focus onto the Geist
  palette, including the charcoal dark mode.
- `system-tokens.css` is the desktop visual system: a seven-step type scale
  (`text-caption` … `text-display`, each with its own line height, registered
  with `cn()` in `lib/utils.ts` so a size and a colour class merge correctly), the
  4px spacing rhythm, named surfaces, one focus ring, and the shell geometry
  (rail width, top bar and toolbar heights, the gutter, control heights).
- `app.css` is staple's own layer on top: the status-to-hue mapping and the SVG
  chrome for the dependency graph, which has no Tailwind equivalent.

The load-bearing family is `--status-task-*`: one hue per built-in status, so a
status badge is one variable and light/dark both fall out of the same color-mix.
Since the status set became configurable, the mapping that matters is
`[data-status-category]` — eight categories onto those same hues, declared after
the per-id rules so the category wins. Adding a status never needs a new token.

Working on the app itself is a contributor path — dev server, rebuild loop, and
the rest are in [CONTRIBUTING.md](https://github.com/vpetkovic/staple-tracker/blob/master/CONTRIBUTING.md).
