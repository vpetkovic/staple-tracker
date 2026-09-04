# Milestones

A milestone is a dated, human-ordered plan that may contain epics and tasks
from anywhere in the tree **without moving them**. This page is the contract
the R3 tickets implement: R3b (store, migration, CLI, MCP, HTTP), R3c (the
Milestones view beside Graph) and R3d (milestones in the pickup queue). The
pure types and helpers it names live in `src/core/milestones.ts` and are
pinned today by `test/milestones.test.ts`; what needs a database is pinned by
`test/store-milestones.test.ts` and `test/contract-milestones.test.ts` (R3b),
what needs the queue by `test/store-queue-resolver.test.ts` (R3d), and what
needs the whole system at once by `test/milestones-e2e.test.ts` and
`src/ui/app/src/views/milestones/milestones-e2e.test.tsx` (R3e) — see
[What the tests prove](#what-the-tests-prove) at the end.
Where this page and [semantics.md](semantics.md) disagree, semantics.md describes today
and this page the target. The queue it plugs into is [queue.md](queue.md).

## Identity: an issue of the `milestone` kind

A milestone **is an issue** — it has an identifier, a title, a description, a
status, comments, documents, events, a place in the tree if somebody gives it
one, and every guard an issue has. What makes it a milestone is its `kind`:
the reserved id **`milestone`** (`MILESTONE_KIND` in `src/core/milestones.ts`).
Nothing else marks it; there is no flag column and no second table of
milestones. `staple milestone show STA-159` and `staple show STA-159` describe
the same row. (Pinned by `store-milestones.test.ts` — *"a milestone is
an ordinary issue with an ordinary history"*.)

**Why a reserved id and not a kind flag.** Kinds are a vocabulary without
categories, and that is deliberate ([semantics.md](semantics.md#kinds--declared-never-derived)):
a status gets its behaviour from a category column, a kind gets none. Giving
kinds a flag column would be inventing categories for kinds so that exactly one
of them could carry a rule — a second vocabulary mechanism for one value. The
gate commands already follow the cheaper pattern: `staple gate` writes "the
first status of the `gated` category", and a workspace that removed that
status has no gate command and is told which `statuses add` brings it back.
Milestones do the same with an id, because an id is all a kind has.

This is the **one documented exception** to "a kind carries no behaviour". An
issue whose kind is `milestone` may own metadata and members; no other kind
may. Everything else about it — checkout, derivation, ordering, gates — is
exactly what any issue gets. The exception is confined to the milestone tables
and the operations on this page, so that adding a seventh kind still adds no
rule.

**When the workspace has no `milestone` kind.** The kind is not seeded: a
workspace that never ran `staple kinds add milestone` has no milestones, and
every operation on this page is refused with `validation` naming the command
that adds it:

```
No `milestone` kind is configured in this workspace. Run
`staple kinds add milestone --label Milestone` to enable milestones.
```

Nothing is created on its behalf: a vocabulary the operator did not write is
not theirs. (Pinned by `milestones.test.ts` —
*"assertMilestoneKindConfigured names the kinds add that enables the feature"*;
pinned by `contract-milestones.test.ts` — *"every surface refuses with
the same validation envelope when the kind is absent"*.)

**Kind changes are guarded in both directions.** Re-declaring a milestone as a
`task` while it has members or dates is refused with `validation` naming the
member count — remove the members first, because an issue that is not a
milestone cannot own them. Re-declaring any issue *as* a milestone is allowed;
its metadata row appears on first write. `staple kinds rm milestone` is refused
outright while any milestone has members or dates, exactly as removing the last
status of a required category is: the refusal names the milestones. `--migrate-to`
does not buy a way past it — it re-kinds every milestone at once, which is the
same move the guard above already refuses one at a time.
(Pinned by `store-milestones.test.ts` — *"refuses to re-kind a milestone that
still has members"* and *"refuses to remove the milestone kind while milestones
exist"*.)

## Metadata: two dates in a table, everything else reused

A milestone's metadata is **target date, start date, state, owner, details,
notes**. Only the dates need new storage; the rest already exists on every
issue and is reused rather than duplicated:

| field | lives in | why |
|---|---|---|
| target date | `milestone_meta.target_date` | new; nullable |
| start date | `milestone_meta.start_date` | new; nullable |
| state | **derived**, never stored | see below |
| owner | `issues.assignee` | the person who owns the plan is its assignee; a second owner column would be two fields that disagree |
| details | `issues.description` | what the milestone is for, edited where every description is edited |
| notes | the `notes` document | revisioned, restorable, already keyed per issue ([semantics.md](semantics.md#revisioned-documents)) |

```sql
CREATE TABLE milestone_meta (
  issue_id         TEXT    PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  target_date      TEXT,             -- YYYY-MM-DD or NULL
  start_date       TEXT,             -- YYYY-MM-DD or NULL
  members_revision INTEGER NOT NULL DEFAULT 0,
  updated_at       TEXT    NOT NULL
);
```

**Why a table and not columns on `issues`.** The dates are meaningful on one
kind and null on every other row; columns on `issues` would put milestone-only
fields into `Issue`, into every `show` payload the contract tests characterise,
and into every surface that serialises an issue. A table keyed by `issue_id`
keeps the exception where the exception is, and `ON DELETE CASCADE` gives
deletion its semantics for free. The row is created lazily — on the first
`milestone set`, `milestone add`, or `create-from-epic` — so a milestone with
no dates and no members is just an issue of the `milestone` kind, and
`milestone ls` still lists it. R3b added the tables in workspace migration
**007** (`007-milestones.ts`; if the queue's migration merges first, whichever
merges second renumbers, per `src/core/migrations/workspace/index.ts`); the
migration creates the two tables and seeds nothing. (Pinned by
`migrations-fixtures.test.ts` — *"the milestone migration preserves every issue
and every configured kind and creates no rows"*.)

**State is derived, never stored.** A stored state would drift from the issue's
status the way a stored parent status drifts from its children. `milestoneState`
reads the milestone's own status category, its dates and its progress, first
match wins:

| state | when |
|---|---|
| `done` | category `done` |
| `cancelled` | category `cancelled` |
| `overdue` | a target date is set and UTC today is past it |
| `active` | the start date has arrived, or any counted leaf has left the pre-work band (`active`, `review` or `done`) |
| `planned` | otherwise |

A milestone whose members have all landed but that nobody closed is `active`
with `progress.complete: true`; the view says so and a human runs
`staple done`. Blocked and gated are not milestone states — they are facts
about members, which the view shows per row from the queue's eligibility —
never from a status category, because staple moves no status for either: a
blocker lives in the blocker table and a gate queues descendants through
`queuedBy`. (Pinned by `milestones.test.ts` — *"milestoneState: resolved first,
then overdue, then active, then planned"*; by
`views/milestones/milestones-model.test.ts` — *"reads overdue from the state and
blocked/gated from the queue's eligibility"*; and end to end by
`views/milestones/milestones-e2e.test.tsx` — *"counts blocked and gated members
from the queue's eligibility, not from status categories"*.)

**Milestone status is not derived from members.** The derived ladder in
[semantics.md](semantics.md#a-parents-status-is-derived-from-its-children)
walks `parent_id`, and membership is not `parent_id`. A milestone with
hierarchical children derives from *them* as any parent does; its members
change its progress, never its status. Two ladders writing one column would be
two answers to "why is this `in_progress`", and the timing replay reads that
column. (Pinned by `store-milestones.test.ts` — *"a member landing does
not move the milestone's status"*.)

## Dates: calendar days, UTC, inclusive

A milestone date is a **calendar day**, written and stored as `YYYY-MM-DD`,
with no time and no zone. It is interpreted in **UTC**, and a day is
**inclusive of its whole extent**:

- target date `D` means the milestone is due by the end of `D`: the interval
  `[D 00:00:00.000Z, D 23:59:59.999Z]`, which `milestoneDateBounds(D)` returns
  as `{startsAt, endsAt}`.
- It is **overdue** from `D+1 00:00:00.000Z` — that is, when the UTC calendar
  date of *now* is greater than `D` (`isOverdue`). On `D` itself, at any hour,
  it is not overdue.
- `daysUntil(D, now)` is the whole-day difference between UTC today and `D`:
  `0` on the day, positive before, negative after — a whole number, never a
  fraction of a day.
- start date `S` means work is planned to begin on `S`; `S` must be on or
  before the target when both are set (`assertMilestoneDates`), and a start
  with no target is allowed.
- an invalid string — wrong shape, or a day that does not exist such as
  `2026-02-30` — is refused with `validation`; `none` on the CLI clears a date.

**Why UTC.** Every timestamp the store writes is already UTC (`nowIso()`), and
a workspace is opened by whoever's machine has the file: two agents in two
zones asking "is STA-159 overdue?" must get the same answer, and a hub
aggregating workspaces must not have one milestone overdue in one pane and not
in the next. The web UI may *display* a date however it likes; it computes with
the same helpers (the browser keeps a hand mirror of `milestoneDateBounds` and
`isOverdue`, as it does for `KIND_RANK`). Lexicographic comparison of two
`YYYY-MM-DD` strings is chronological, which is why the column is TEXT and the
listing can `ORDER BY target_date`. (Pinned by `milestones.test.ts` —
*"parseMilestoneDate accepts a real calendar day and nothing else"*,
*"milestoneDateBounds is the inclusive UTC day"*, *"isOverdue turns over at
the UTC midnight after the target"*, *"daysUntil is 0 on the day, negative
after"*, *"assertMilestoneDates refuses a start after the target"*.)

On the queue, a target date surfaces as `dueAt` — the `endsAt` bound
(`2026-10-31T23:59:59.999Z`, not the bare day), so that sorting by `dueAt` and
comparing to `now` both honour the inclusive day — and is not an input to order
or eligibility ([queue.md](queue.md#the-resolver--one-deterministic-next-item-algorithm)).
(Pinned by `milestones-e2e.test.ts` — *"emits dueAt as the inclusive endsAt
bound, not the bare calendar day"*.)

## Membership: a relation, not a hierarchy

Membership is a **separate table**. Joining a milestone changes nothing about
the member: `parent_id`, `depth`, its `blocks` edges, its status, its claim and
its gate all stay exactly as they were. That is the whole reason membership is
not re-parenting — an epic can belong to the Q4 milestone *and* remain the
child of the programme that owns it, and a task can be pulled into a milestone
without leaving its epic.

```sql
CREATE TABLE milestone_members (
  issue_id     TEXT    PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  milestone_id TEXT    NOT NULL    REFERENCES issues(id) ON DELETE CASCADE,
  rank         INTEGER NOT NULL,
  added_by     TEXT    NOT NULL,
  added_at     TEXT    NOT NULL,
  note         TEXT,
  UNIQUE (milestone_id, rank)
);
CREATE INDEX milestone_members_milestone_idx ON milestone_members(milestone_id, rank);
```

(Pinned by `store-milestones.test.ts` — *"adding a member leaves its
parent, depth, blockers and status untouched"*.)

**One direct milestone per issue.** `PRIMARY KEY (issue_id)` says an issue is a
*direct* member of at most one milestone. Adding it to a second is refused with
`validation` naming the milestone it is already in; `milestone mv <ref> --to
<milestone>` is the move. The alternative — an issue in several milestones —
was rejected because every consumer wants *the* milestone of an issue: the
ungrouped list's milestone cue is one cue, the resolver reports one milestone
path per row, and a progress percentage that the same task can move in two
places is a percentage nobody trusts. An issue still *reaches* a second
milestone indirectly when its ancestor is a member there; see nesting.
(Pinned by `milestones.test.ts` — *"assertMembershipAllowed refuses a second
direct milestone and names the first"*.)

**Duplicate membership.** Adding a present member with no position is an
idempotent replay — the existing row, `replayed: true`, no event. With a
position it is a move. This is the queue's rule, verbatim. (Pinned by
`store-milestones.test.ts` — *"add of a present member is a no-op replay"*,
*"add with a position of a present member is a move"*.)

**Nested membership.** An epic and its own descendant may both be direct
members of the same milestone. This is allowed, not refused, because it is how
a human pulls one child forward in the plan without queueing the whole epic
first. Progress counts the descendant once (below); the queue emits it once, at
whichever occurrence comes first ([queue.md](queue.md#the-resolver--one-deterministic-next-item-algorithm)).
`milestone show` lists both rows and marks the descendant `nestedUnder:
<epic>` so the view can indent it. (Pinned by `store-milestones.test.ts`
— *"an epic and its child may both be members, and the child is marked
nestedUnder"*.)

**The effective milestone of an issue** is its nearest direct membership,
looking at the issue itself first and then up its ancestors: an issue that is a
direct member of M2 while its epic is a member of M1 belongs to M2. This is
the `milestone` cue on the ungrouped list and the milestone half of the path
the resolver reports. (Pinned by `milestones.test.ts` — *"nearestMilestone:
self before ancestor, nearest ancestor first"*.)

**What may not be a member.** A milestone may not be a member of a milestone —
plans do not nest, because the queue's precedence has exactly three rungs
(milestone order, member order, descendant order) and a fourth would need a
cycle check nobody asked for. A milestone may not be a member of itself. A
foreign identifier is refused with `validation` naming its workspace, as the
queue refuses it. Any other kind is fine: epics and tasks are the point, and a
`bug` or a `spike` is just as much work. (Pinned by `milestones.test.ts` —
*"assertMembershipAllowed refuses a milestone as a member and a self-member"*;
pinned by `store-milestones.test.ts` — *"refuses a foreign identifier and
names its workspace"*.)

**Create from an epic.** `staple milestone new --from-epic <epic>` creates a
milestone titled after the epic and adds **the epic** as its one member. The
epic's children come along by descent — through progress and through
expansion — and are not copied into the table, so the epic's hierarchy is the
milestone's structure and re-parenting is impossible by construction.
`--preview` returns the exact plan and writes nothing:

```json
{"milestone": {"title": "S: opt-in cloud continuity"},
 "members": [{"identifier": "STA-66", "position": 1}],
 "hierarchyChanges": []}
```

`hierarchyChanges` is always empty and is returned anyway, so that the test —
and the human reading the preview — can see the promise rather than infer it.
(Pinned by `store-milestones.test.ts` — *"create-from-epic previews one
membership and no hierarchy change, and writes nothing"*;
`contract-milestones.test.ts` — *"the preview and the commit name the same
changes on every surface"*.)

## Order: sparse ranks and a per-milestone revision

Members are ordered by `rank` within their milestone, and the encoding is the
queue's, verbatim ([queue.md](queue.md#storage)): the first member takes
`1024`, an append takes `max + 1024`, an insert between neighbours takes their
midpoint rounded down, and when the gap is exhausted (`b - a < 2`) the write
renumbers that milestone's members to multiples of `1024` in the same
transaction and then inserts (`MEMBER_RANK_STEP`, `rankBetween`,
`renumberedRanks`). `UNIQUE (milestone_id, rank)` plus a midpoint computed inside
an immediate transaction is what makes concurrent inserts unable to collide.
Order is **durable** — it is a column, not a sort — and **independent**: it is
not derived from priority, `created_at`, status order, or the members' tree
positions, and none of those reorder it. (Pinned by `milestones.test.ts` —
*"rankBetween: first, append, midpoint, exhausted"*; pinned by
`store-milestones.test.ts` — *"member order ignores priority, created_at and
tree order"*, *"renumbers when the gap is exhausted, in one transaction"*.)

**Reorder is CAS.** Each milestone carries its own `members_revision`, bumped by
every membership mutation on it (add, remove, move, bulk reorder, renumber).
Every read of the members returns it; every mutation accepts an optional
`baseRevision` and is refused with `revision_conflict` (exit 7, retryable)
when it does not match, leaving the order untouched. Per-milestone rather than
the queue's single global counter because two humans reordering two milestones
are not in conflict. The web editor always sends the base; the CLI sends it
with `--base N` and otherwise writes blind. (Pinned by
`store-milestones.test.ts` — *"a stale baseRevision is refused and the order
stands"*, *"bulk reorder is atomic and bumps the revision once"*;
`views/milestones/milestones-e2e.test.tsx` — *"shows a genuinely stale reorder as
a conflict, in the store's own words, with the order untouched"*.)

## Progress: count each leaf once

Progress is a rollup over **leaves** — issues with no children — reachable from
the milestone's members, each leaf counted **once** no matter how many ways it
is reached. A parent is never counted: its status is derived from its children,
so counting the epic *and* its tasks would count the same work twice, once as
itself and once as the report of itself. This is the whole rule; the rest is
consequences.

`milestoneProgress(members, descendantsByMember)` takes the direct members
(each with its `id`, `parentId` and status `category`) and, per member, every
descendant of it at any depth, and returns:

```ts
interface MilestoneProgress {
  total: number;                          // leaves counted, cancelled included
  countable: number;                      // total minus cancelled
  counts: Record<StatusCategory, number>; // leaves per category
  percent: number | null;                 // floor(done * 100 / countable); null when countable is 0
  complete: boolean;                      // countable > 0 and every countable leaf is done
}
```

- **Nested membership counts once.** Milestone M has members E (an epic with
  tasks T1 `done`, T2 `todo`), T2 again as a direct member, and a standalone
  task S (`done`). The reachable set is {E, T1, T2, T2, S}; E is a parent and
  is dropped, T2 is deduplicated by id, so the leaves are {T1, T2, S}:
  `total 3, countable 3, done 2, percent 66, complete false`. Not 4 of 5, not
  3 of 4. (Pinned by `milestones.test.ts` — *"counts a task reached through
  its epic and as a direct member once"*, *"never counts a parent"*.)
- **A member with no children is its own leaf.** An epic with nothing under it
  counts as one unit — there is no other work to stand for it. A member with
  children counts for nothing on its own. (*"a childless member is one leaf"*.)
- **Cancelled leaves leave the denominator.** Cancelled work is neither
  delivered nor pending: counted as done it would inflate the number, counted
  as pending the milestone could never reach 100. So `countable = total −
  cancelled`, and `percent` is `null` — not 0, not 100 — when nothing is
  countable, because a plan of cancelled work has no completion to report.
  `counts.cancelled` still says how much was abandoned. (*"excludes cancelled
  leaves from the denominator"*, *"percent is null when nothing is countable"*.)
- **A resolved ancestor does not hide its descendants.** A cancelled or done
  epic whose child is still `todo` still has an open leaf, and it counts: the
  child's status is the child's own, exactly as the inbox still lists it. A
  human who means the whole subtree cancelled cancels the children. (*"a
  cancelled parent does not hide an open leaf"*.)
- **Reopening a member is just a category change.** Membership rows are never
  removed by status, so a leaf that leaves `done` moves from `counts.done` back
  to whatever it now is and `complete` turns false again on the next read.
  Nothing is re-added. (*"a reopened leaf lowers the count on the next read"*.)
- **`percent` rounds down**, so 199 of 200 reads `99`, not `100`: a hundred is
  reserved for `complete`. (*"percent rounds down"*.)

The categories are read from the workspace's configured statuses at read time,
never from the status ids, so a renamed `done` still counts. (Pinned by
`store-milestones.test.ts` — *"progress reads categories, not status ids"*;
the fixture case in `milestones-e2e.test.ts` (R3e) — *"counts a member epic's
child that is also a direct member once, and drops the cancelled leaf from the
denominator"*.)

## Lifecycle

**Deleting a milestone** is deleting an issue: `ON DELETE CASCADE` removes its
metadata row and every membership row; the members themselves are untouched —
parent, blockers, status, claim, queue entry. Its own queue entry cascades out
with it, as any issue's does. (Pinned by `store-milestones.test.ts` —
*"deleting a milestone frees its members and changes nothing about them"*.)

**Deleting a member** cascades its membership row out; the other members keep
their ranks (the encoding is sparse, so no renumber is needed), and the
milestone's progress shrinks on the next read. (*"deleting a member leaves the
other ranks alone"*.)

**A resolved member stays a member.** When a member lands or is cancelled, its
row stays at its rank: it is the numerator of the progress, and the plan is
also the record of what was planned. There is no `milestone prune`, and a
member is only ever removed by a human (`milestone rm`). (*"a done member is
kept and counted"*.)

**Reopening a member** (`done` → anything open) needs no milestone write: the
row never left. Progress and state re-derive on the next read.

**Re-parenting, renaming and status changes** do not touch a membership row:
it references `issues.id`, never the identifier, title or parent. Moving a task
out of a member epic and into an unrelated one does not change *which
milestone it is directly in*, only whether it is also reached by descent.
(*"a membership survives rename, status change and re-parent"*.)

**Cancelling a milestone** (`staple cancel`) is an ordinary status transition:
the members are not cancelled, released or removed — they are other people's
work, and a plan being abandoned says nothing about the tasks it pointed at.
The state reads `cancelled` and `milestone ls` hides it without `--all`.
(*"cancelling a milestone leaves its members open"*.)

## In the pickup queue

A milestone joins the queue as one plan row: `staple queue add STA-159`
reserves one position, and that position is **the milestone's order** — there
is no separate ranking of milestones. Two milestones' relative precedence is
where a human put them in the plan, and `milestone ls` sorts by plan position
first, then by target date, then by identifier. A milestone not in the queue
is still a milestone: its members simply fall wherever the queue's other rules
place them.

In effective order the milestone is a **container** and is never emitted as
itself, even when it has no children of its own ([queue.md](queue.md#the-resolver--one-deterministic-next-item-algorithm)
step 1). It expands **in membership order first, then in hierarchy order**:
each direct member in rank order, each member expanded by the tree rule
(depth-first, siblings in presentation sort), then the milestone's own open
children — if it has any — by the same tree rule. An issue reached twice —
as a direct member and through a member epic, or through two rows — is emitted
once, at its first occurrence. A milestone with no members and no children
expands to nothing and is simply a plan row with no effective rows under it.
Every effective row carries `milestonePath` — the milestone it belongs to, by
its own membership or its nearest ancestor's — beside `epicPath`, the ancestor
epics it came through; both are arrays of identifiers, outermost first, and both
are `[]` rather than null when there is nothing to say
([queue.md](queue.md#the-resolver--one-deterministic-next-item-algorithm)
step 4). (Pinned by `store-queue-resolver.test.ts` — *"expands a milestone in
membership order, then each member by the tree rule"*, *"a milestone's own
children follow its members"*, *"emits a doubly-reached issue once, at its first
occurrence"*, *"reports the milestone and epic path for every effective row"*.)

Reordering members **is** reordering the effective queue: the resolver reads
`milestone_members` on every call, so a `milestone mv` is visible on the next
`queue next` with no queue write — and therefore with **no queue revision
bump**. The revision that moves is the milestone's own `members_revision`; the
plan still says exactly what it said. A caller that watches `queue.revision` for
"did the order change" is watching the PLAN, not the effective order. A date
change moves neither: it changes `dueAt` on the rows and nothing else, so
swapping two milestones' target dates leaves an explicit plan byte-identical.
Eligibility is untouched by all of this — a member that is blocked, gated,
claimed or resolved is classified exactly as
[queue.md](queue.md#the-resolver--one-deterministic-next-item-algorithm)
says, and is shown rather than dropped. (Pinned by
`store-queue-resolver.test.ts` — *"reordering membership updates effective order
on the next read"*, *"a milestone date changes dueAt and nothing else"*,
*"changing milestone dates never reorders an explicit plan"*, *"a blocked or
gated member stays visible under its milestone"*.)

## Events

All carry `actor`; membership events carry the milestone's resulting
`revision`:

- `milestone_updated` — on the milestone: `{targetDate, startDate}` after the
  write, with the previous values under `previous`
- `milestone_member_added` — on the milestone: `{identifier, rank, position}`
- `milestone_member_removed` — on the milestone: `{identifier, position}`
- `milestone_member_moved` — on the milestone: `{identifier, fromPosition,
  toPosition, rank}`, also used for a move between milestones with `from` and
  `to` milestone identifiers
- `milestone_members_reordered` — on the milestone: `{order: [identifiers]}`
- `milestone_joined` — on the **member**: `{milestone}`, so the member's own
  timeline says when and by whom it was planned; `milestone_left` is its twin

None moves an issue's status, so none joins `STATUS_MOVING_EVENT_KINDS`.

## Operations, by surface

| CLI | MCP | HTTP |
|---|---|---|
| `staple milestone ls [--all]` | `list_milestones` | `GET /api/milestones` |
| `staple milestone show <ref>` | `get_milestone` | `GET /api/milestone?ref=` |
| `staple milestone new "<title>" [--target D] [--start D] [--from-epic <ref>] [--preview]` | `create_milestone` | `POST /api/milestone/create` |
| `staple milestone set <ref> [--target D\|none] [--start D\|none]` | `update_milestone` | `POST /api/milestone/update` |
| `staple milestone add <milestone> <ref> [--before R \| --after R \| --at N] [--base N] [-m note]` | `add_milestone_member` | `POST /api/milestone/add` |
| `staple milestone rm <milestone> <ref> [--base N]` | `remove_milestone_member` | `POST /api/milestone/remove` |
| `staple milestone mv <ref> (--before R \| --after R \| --at N \| --to <milestone>) [--base N]` | `move_milestone_member` | `POST /api/milestone/move` |
| `staple milestone reorder <milestone> <r1,r2,…> --base N` | `reorder_milestone_members` | `POST /api/milestone/reorder` |

`ls` prints identifier, state, target date, `done/countable` and percent, and
the next eligible row from the resolver; `--all` includes resolved milestones.
`show` returns one shape everywhere under `--json`:

```json
{"milestone": {"identifier": "STA-159", "title": "…", "status": "in_progress",
               "kind": "milestone", "assignee": "VP", "targetDate": "2026-10-31",
               "startDate": null, "state": "active", "planPosition": 2},
 "progress": {"total": 12, "countable": 11, "percent": 45, "complete": false,
              "counts": {"done": 5, "active": 1, "ready": 3, "unstarted": 2, "cancelled": 1,
                         "review": 0, "gated": 0, "blocked": 0}},
 "revision": 7,
 "members": [{"identifier": "STA-66", "kind": "epic", "position": 1, "rank": 1024,
              "status": "in_progress", "parent": "STA-156", "nestedUnder": null},
             {"identifier": "STA-68", "kind": "task", "position": 2, "rank": 2048,
              "status": "todo", "parent": "STA-66", "nestedUnder": "STA-66"}],
 "next": {"identifier": "STA-67", "position": 4}}
```

Each member row also carries `title`, `addedBy`, `addedAt` and `note`, which
the view (R3c) renders. `planPosition` and `next` are the QUEUE's two fields on
this shape and the resolver fills them (R3d): `planPosition` is the milestone's
own row in the pickup plan, `null` when it is not queued, and `next` is the
first `eligible` effective row that reports this milestone in its
`milestonePath` — the real next work under this plan, in the position an agent
sees it at, and `null` when nothing under the milestone is takeable. A milestone
that is not queued still has next work: its members are in the unqueued band and
are still work, just later. `ls` returns the same object without `members`, plus
`memberCount`, sorted by plan position first. (Pinned by
`store-milestones.test.ts` — *"fills planPosition and next from the resolver"*,
*"sorts the list by plan position first, then by date"*;
`contract-milestones.test.ts` — *"a queued milestone reports its plan position
and its next eligible row everywhere"*.) The service behind every surface
is `src/core/milestone-store.ts` (`store.milestones()`), and every membership
mutation returns this same view, so a writer redraws from its result exactly
as a reader does.

Title, description, assignee and status are edited with the ordinary issue
commands; `set` takes only what is milestone-specific. A non-milestone
identifier given where a milestone is expected is refused with `validation`
naming its kind (`STA-66 is an epic, not a milestone`); an unknown identifier
is `not_found`; `--at N` is a 1-based position; `rm` of a non-member is
`not_found`. (Pinned by `contract-milestones.test.ts` — *"every operation
has the same shape and refusal on every surface"*, *"round-trips dates, order
and removal"*.)

## Worked example

VP has the S epic (STA-66, twelve children, S1–S12) under the R programme
(STA-156), and a flake ticket (STA-146) with no epic at all. They want both
shipped by the end of October, and S2 done before anything else in S.

```
$ staple kinds add milestone --label Milestone           # once per workspace
$ staple milestone new "October cut" --target 2026-10-31 --from-epic STA-66 --preview
  would create  October cut  (milestone, target 2026-10-31)
  + member  STA-66  S: opt-in cloud continuity   at 1
  hierarchy changes: none
$ staple milestone new "October cut" --target 2026-10-31 --from-epic STA-66
  STA-190  October cut
$ staple milestone add STA-190 STA-146                    # the flake, no epic
$ staple milestone add STA-190 STA-68 --before STA-66     # S2, pulled forward
$ staple queue add STA-190
```

- **Nothing moved.** STA-66 is still the child of STA-156; STA-68 is still the
  child of STA-66; STA-146 still has no parent. `staple tree` is unchanged.
- **Order.** STA-66 took `1024` as the first member and STA-146 appended at
  `2048`; `--before STA-66` took the midpoint of `0` and `1024`, so the members
  are STA-68 (`512`), STA-66 (`1024`), STA-146 (`2048`) and `show` prints
  positions 1, 2, 3. The ranks are an encoding; nobody types them.
- **Progress.** Leaves reachable: S1–S12 through STA-66, STA-68 again directly
  (counted once), STA-146: thirteen leaves. With S1 done and S3 cancelled:
  `total 13, countable 12, done 1, percent 8`.
- **Queue.** STA-190 is plan row 1, a container. Effective order: STA-68 first
  (member 1, a leaf — `blocked STA-35, STA-67`, shown, skipped), then STA-66's
  open children in presentation sort with STA-68 omitted because it was already
  emitted, then STA-146. `queue next` is STA-67. `staple milestone mv STA-146
  --at 1` makes it STA-146 on the very next read.
- **Dates.** On `2026-10-31T23:59:59Z` the milestone is `active`; at
  `2026-11-01T00:00:00Z` it is `overdue`, in every zone, and `daysUntil` reads
  `-1`. `queue` shows `dueAt: 2026-10-31T23:59:59.999Z` on all thirteen rows.
- **Landing.** When S12 lands and STA-146 is fixed, `progress.complete` is
  true and STA-190 is still `in_progress` (or whatever VP set) until
  `staple done STA-190`; its queue row then reads `resolved` and `queue prune`
  removes it. The members stay in `milestone_members` as the record.

Those transitions are what R3e replays end to end, on its own fixture, in
`test/milestones-e2e.test.ts` — *"commits exactly the previewed plan and leaves
the epic's hierarchy byte-identical"*, *"a reorder changes the next read and does
not touch the plan revision"*.

## What the tests prove

R3a–R3d each pin one rule on the smallest workspace that rule needs. R3e adds
one realistic workspace — `test/fixtures/milestones-scenario.ts` — and replays
the whole feature over it through the real surfaces, so that the places where
the rules MEET are covered and not merely implied.

**The fixture.** A programme epic over three child epics (`Q`, `M`, `S`), two
loose tasks, an approval gate on `M` owned by a human, a blocker inside `Q`, one
done leaf, one cancelled leaf, and two dated milestones that OVERLAP: October
owns the epic `Q` while November owns `Q`'s own child. Nothing in it is a
special case invented for a test; it is the shape a real quarter has. It is
written in-process into the database `staple init --global` makes, so the CLI,
the MCP server and the HTTP server all open one file.

**`test/milestones-e2e.test.ts`** — a real HTTP server, a real MCP server over
stdio, and the real CLI in child processes. Every milestone and queue read that
carries a claim goes through all three at once.

- *Conversion.* `--preview` over the browser's own route returns one membership,
  `hierarchyChanges: []`, and writes nothing — no milestone, no membership, not
  even an identifier. The commit then makes exactly that plan, and the epic's
  subtree — identifier, parent, depth, kind, status and unresolved blockers for
  every descendant — is compared as one value before and after and is unchanged.
- *Cross-epic membership.* A task whose epic is in October and which is itself in
  November reports November: self beats ancestor. Adding it to a second milestone
  is refused naming the first and naming the `mv --to` that is the move; the move
  keeps its note and does not touch its parent.
- *Progress.* October reaches five leaves, not six: the member that is also a
  member epic's child is counted once. The cancelled leaf leaves the denominator
  (`countable` 4 of `total` 5) and the done leaf is the numerator. Landing a leaf
  moves only the numerator; reopening it moves it back, with no membership write.
- *Order.* A reorder under `--base` changes the effective pickup order on the very
  next read while `queue.revision` does not move — the plan still says what it
  said. A stale base is refused with `revision_conflict` on all three surfaces,
  and the order stands. Rank never lifts a blocker.
- *Expansion.* Milestone, then member, then descendant, with an issue reachable
  twice emitted once at its first occurrence — proved on two such issues.
- *Dates.* A boundary table over month end, year end, a leap day, the day before
  a leap day, and two `now`s written in zones whose local calendar date disagrees
  with UTC's: the turnover is the UTC midnight after the target, every time. Every
  dated queue row carries the day's inclusive `endsAt` bound as `dueAt`, and an
  undated one carries null, so a consumer's own `new Date(dueAt) < now` turns over
  at the same instant `isOverdue` does. A target edit moves `dueAt` on every row
  the milestone reaches and reorders nothing; `none` clears a date; an impossible
  day and a start after the target are refused identically everywhere.
- *Gates, claims and landing.* Gated members stay visible at the head of the plan
  and are never takeable; `request-changes` keeps them there and `approve`
  releases them, both on the next read with no queue write. A live claim is
  skipped for everyone but its holder. A plan whose work has all landed reads
  `complete` and stays open until a human closes it; closing it takes it out of
  `milestone ls`, `queue prune` forgets its plan row, and its members keep their
  ranks as the record.

**`src/ui/app/src/views/milestones/milestones-e2e.test.tsx`** — the same server,
serving the same fixture, into the real view components rendered with
`react-dom/server`. No jsdom, no screenshot harness, no new dependency: a
"browser test" here is the real HTTP routes plus the real markup. It pins the
list and the detail drawn entirely from the wire; the three layouts at real
widths; the accessible row order equalling the server's member order; a name on
every reorder control with only the true edges disabled; each state legible as a
glyph AND a word with the glyph hidden from a screen reader; the conflict banner
after a genuinely stale `baseRevision`, showing the store's sentence verbatim
while the server keeps the other writer's order; and the risk lines and rollups
counting the fixture's one genuinely blocked leaf and two genuinely gated ones
off `GET /api/queue`'s `eligibility`, where the status categories read zero.
