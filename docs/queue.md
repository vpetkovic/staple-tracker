# The pickup queue

An explicit, human-ordered plan of what agents pick up next, separate from
status, priority and display grouping. This is the contract the R2 tickets
implement and that R3d (milestones) and R6d (the policy setting) plug into.
Every rule names the test that pins it, or that will. The STORAGE half (R2b,
migration 008: the `queue_entries` table, the plan's order and its revision),
the RESOLVER and the four surfaces (R2c), the visual editor (R2d) and the agent
protocol, diagnostics and lifecycle regressions (R2e) are built; the milestone
plumbing beyond membership order (R3d) is not. Where this page
and [semantics.md](semantics.md) disagree, semantics.md describes today and this
page the target.

## Presentation sort is not the queue

Today `inbox` READY is a **presentation sort**: category tier (`active, review,
ready, unstarted`), then priority, then `created_at`, then `rowid`
(`issuesQuery` in `src/core/store.ts`). It is a good default and it stays the
default for everything the queue does not mention. But it is derived from
fields that mean other things — a priority is a judgement about importance,
`created_at` is an accident of when somebody typed — and neither is a
statement that *this comes before that*. The queue is that statement, and it is
its own data: nothing about it is derived from priority, `created_at` or the
configured status order, and reordering statuses never reorders the queue.
(Pinned by `store-queue.test.ts` — *"plan order ignores priority,
created_at and configured status order"*.)

Two orders therefore exist and both are shown. **Plan order** is the rows a
human put in the queue, containers included, in the order they put them — what
the editor edits. **Effective order** is the plan with every container expanded
to leaf work and every row annotated with whether an agent may take it — what
agents receive, and what READY derives from. A row's `planPosition` and its
effective `position` are reported side by side wherever they differ. (Pinned by
`queue-surfaces.test.ts` — *"reports plan position and effective position
separately"*.)

## The resolver — one deterministic next-item algorithm

One function, `store.queue().effectiveQueue({actor?})`, is the only thing that computes
the effective order, and every surface — `inbox`, `queue`, `queue next`, the
checkout guard, MCP, HTTP and the editor's preview — reads it. Its inputs are
exactly: the `queue_entries` table; the issue tree (`parent_id`, sibling order);
status categories; local `blocks` edges and hub `cross_links`; gates
(`queuedByFor`); live claims (`checkout_agent` on an active-category row);
milestone membership order (R3); the workspace policy; and the calling actor.
Cross-workspace blockers are the one input the resolver takes INJECTED rather
than fetched — they live in the hub, and `Hub.crossBlockersOf` opens a workspace
file per link, which is not a cost an inbox can pay per row — so a caller that
already has a hub open hands them in. Same inputs, same output, on every surface
and after a restart. (Pinned by `queue-surfaces.test.ts` — *"CLI, MCP, HTTP and
inbox return the same revision and the same order"*; `store-queue.test.ts` —
*"survives restart with a stable total order"*.)

**Step 1 — expand.** Walk the plan in rank order. A leaf is emitted as one
effective row. A **container** — an issue with at least one open child — is
never emitted as itself; it is expanded in place, depth-first, to its open leaf
descendants (the same "nothing open underneath" test gates use, so a parent a
human gave a status to after its children finished is a leaf). A milestone
expands to its members in membership order (R3d), and each member expands by
this rule — what a milestone is and how its membership is ordered is
[milestones.md](milestones.md); it is never emitted as a row itself, in the plan
or in the unqueued band, because nobody checks out a milestone. Siblings inside
a container expand in **presentation sort**, so a queued epic behaves exactly
like today's inbox restricted to that epic; a human
who wants a different order inside it queues the child explicitly. An issue
reached twice — queued directly and via a container, or via two containers —
is emitted once, at its **first** occurrence. (Pinned by
`store-queue-resolver.test.ts` — *"expands a container to open leaves,
depth-first"*, *"never emits a container as a row"*, *"treats a parent resolved
after its children as a leaf, not a container"*, *"emits a doubly-reached issue
once, at its first occurrence"*, *"expands a milestone in membership order, then
each member by the tree rule"*.)

**Step 2 — the unqueued band.** After the last plan row, every open LEAF not
reached by step 1 follows in presentation sort. The queue is a prefix, not a
filter: unqueued work is still work, it is just later. Containers stay out of the
band for the same reason they stay out of step 1 — "never emits a container as a
row" is absolute, and a row here is something an agent may be TOLD to take. The
inbox still LISTS containers; it takes only its order from here. (Pinned by
`store-queue-resolver.test.ts` — *"appends unqueued work after the plan in
presentation sort"*, *"a reopened issue whose entry was pruned lands in the
unqueued band"*.)

**Step 3 — classify.** Each effective row gets one `eligibility`, the first
rule that matches; the ladder is hard constraints only, and rank is not on it:

| # | eligibility | when |
|---|---|---|
| 1 | `resolved` | category `done` or `cancelled` |
| 2 | `gated` | `queuedBy` non-null, or category `gated` — named before a blocker, as the inbox does |
| 3 | `blocked` | any unresolved local blocker, any unresolved or *unresolvable* cross-workspace blocker, or category `blocked` |
| 4 | `claimed` | category `active` with `checkout_agent` set to somebody other than the actor |
| 5 | `eligible` | everything else |

Every non-eligible row carries a `detail` saying why (`queuedBy`, the blocker
identifiers, the holder and their `idleSeconds`). Rows are **never dropped** for
being ineligible — the plan is shown whole, so a human can see what their order
is waiting on. Milestone target dates appear as `dueAt` on the row and are not
an input to order or eligibility: a date explains urgency, it never reorders a
plan somebody wrote by hand. Assignee is deliberately not an input either.
(Pinned by `store-queue-resolver.test.ts` — *"classifies by the ladder, first
match wins"*, *"names the gate before the blocker"*, *"treats an unresolvable
cross-workspace blocker as blocked"*, *"never drops an ineligible row"*, *"a
milestone date changes dueAt and nothing else"*.)

**Next item** is the first `eligible` row for the actor; the rows before it are
returned as `skipped`, each with its eligibility and detail. With no actor,
`claimed` rows are reported as claimed and the next item is the first row
nobody holds. (Pinned by `store-queue-resolver.test.ts` — *"next is the first
eligible row and lists what it skipped"*, *"has no eligible row, and no next,
when everything is held"*.)

**READY takes its order from the resolver and keeps its membership.** The three
inbox buckets partition open work exactly as today (`gated` and `queuedBy` →
QUEUED; `blocked` and unresolved blockers → BLOCKED; the rest → READY); what
changes is that READY is printed in effective order rather than presentation
sort, with each row's `position`, and QUEUED/BLOCKED rows that are in the plan
carry their `planPosition` as a cue. A container is in READY but is not an
effective row, so it has no `position` of its own and ranks where its earliest
plan-band descendant does; with an EMPTY queue nothing is in the plan band and
the list is byte-identical to what it always was. (Pinned by
`queue-surfaces.test.ts` — *"READY is in effective order and carries
positions"*, *"a queued-but-gated row stays in QUEUED with its plan
position"*.)

## Policy: advisory or strict

`queue.policy` is a workspace-scoped setting with two values, registered through
the R6 settings registry (STA-179) and read by the resolver on every checkout.
**`advisory`** is the default: the queue orders and explains, and checkout is
never refused for order. Upgrading a workspace changes nothing an agent can
observe until a human sets `strict`. (Pinned by `store-settings.test.ts` —
*"queue.policy defaults to advisory"*; `store-queue-resolver.test.ts` —
*"advisory never refuses a checkout for order"*.)

**`strict`** refuses a checkout of issue X when an `eligible` row for the actor
exists **earlier** in effective order — earlier meaning a smaller position, or
any position at all when X is in the unqueued band. The refusal has its own
code, **`out_of_order`, exit 10**, non-retryable, and its `detail` names what
the agent should take instead:

```json
{"code":"out_of_order",
 "message":"STA-146 is later in the queue than STA-67, which is ready. Take STA-67, or ask a human to reorder or override.",
 "detail":{"policy":"strict","expected":["STA-67"],"position":14,"expectedPosition":2},
 "retryable":false}
```

It is not `conflict` (somebody else got there first — pick another *now*) and
not `gated` (a person must act) but a third instruction: *the plan says
something else comes first*. Retrying does not clear it; taking the expected
item does. "Earlier" is measured against the PLAN BAND only: the unqueued band
is ordered, but it is not a human's statement that this comes before that, which
is why an empty queue refuses nothing. (Pinned by
`store-queue-resolver.test.ts` — *"strict refuses a later checkout with
out_of_order, naming the earlier eligible rows"*, *"strict allows the head
row"*, *"strict allows a later row once every earlier row is ineligible"*,
*"strict refuses unqueued work while any plan row is eligible"*, *"strict is a
no-op on an empty queue"*; `queue-surfaces.test.ts` — *"exits 10 with the
out_of_order triple"*, *"refuses the same way on MCP and HTTP"*.)

**Where the guard sits.** In `checkoutIssue`, the order check runs after the
crash-recovery re-claim (an agent resuming its own held ticket is mid-flight
work, not a pickup) and after the `gated` guard (a gate is the more binding
fact), inside the same immediate transaction as the claiming `UPDATE`. That
placement is what makes strict serializable: two agents racing for the head
row are the ordinary `conflict` case, and the loser's next read sees the row as
`claimed` and gets the second row — so two agents never both pass the same
next-item check. `--steal-if-stale` does not route around it: a stale holder
and a plan are unrelated facts. (Pinned by `queue-concurrency.test.ts` — *"two
processes cannot both pass strict next-item checkout"*, *"a second process is
refused out_of_order rather than jumping the head"*, *"a reorder committed
during a checkout has a deterministic, serializable outcome"*, *"a human
override lands beside a concurrent checkout and records what it stepped over"*,
*"releasing a stale claim re-derives the effective order for the next
process"*;
`store-queue-resolver.test.ts` — *"still lets the existing holder re-claim"*,
*"is not bypassed by --steal-if-stale"*.)

**Hard constraints are never bypassed by rank, in either mode.** A blocker, a
pending or `changes_requested` gate, a live claim and a resolved status all
refuse or skip exactly as they do today; the queue can only order what is
already takeable. Approve, request-changes, `blockers_resolved` and a release
change eligibility on the very next read — no queue write happens or is needed.
(Pinned by `store-queue-resolver.test.ts` — *"rank cannot lift a blocked row"*,
*"rank cannot lift a gated row"*, *"approve re-derives effective order on the
next read"*; `queue-lifecycle.test.ts` — *"gate, request-changes and approve
each land on the next read, with no queue write"*, *"a live claim is skipped, a
steal moves it, and a release hands the head back"* — both of which read the
order back through the CLI, MCP and HTTP and assert the revision never moved,
because a re-derivation that needed a queue write would not be one.)

## Human override

The store cannot tell a human from an agent and does not try; the override flag
is the distinction. `staple checkout <ref> --override -m "<reason>"` (MCP
`checkout_task {override_reason}`, HTTP `/api/action` with `overrideReason`,
UI: a confirm dialog with a reason field) skips **only** the `out_of_order`
check. The reason is mandatory, as it is for `request-changes`. Blockers, gates
and conflicts still refuse — an override is "take this out of turn", never
"take this regardless". (Pinned by `store-queue-resolver.test.ts` — *"override
takes a later row and records why"*, *"override requires a reason"*, *"override
does not bypass a gate, a blocker or a live claim"*.)

Every override emits **`queue_overridden`** on the checked-out issue, with
`actor`, `reason`, `policy`, `expected` (the identifiers it stepped over),
`position` and `expectedPosition`. It does not modify the plan: the displaced
rows keep their positions and the next agent still gets them first. In
`advisory` mode the flag is accepted, the event is still written, and nothing
else differs — the audit trail is the point, not the refusal. Queue mutations
themselves need no override: they are actor-attributed events, so an agent that
reorders is visible rather than forbidden, and the agent guide (STA-170) tells
it not to. (Pinned by `store-queue-resolver.test.ts` — *"emits queue_overridden
with actor, reason and the displaced rows"*, *"writes the event under advisory
too, where nothing was refused"*, *"an override does not reorder the plan"*;
`queue-surfaces.test.ts` — *"--override without -m is refused"*, *"an override
with a reason succeeds on every surface and is recorded"*.)

## Lifecycle of an entry

**Resolved entries are kept, hidden and skipped.** When a queued issue — or a
queued container, by derivation — reaches `done` or `cancelled`, its entry stays
in the table at its rank, is `resolved` in effective order, and is hidden from
the default `queue` listing (`--all` shows it). Nothing removes it
automatically, because the plan is also the record of what was planned, and
because of the next rule. `staple queue prune` removes every resolved entry in
one transaction and emits one `queue_dequeued` per row with `reason: "pruned"`.
(Pinned by `store-queue.test.ts` — *"a resolved entry is kept and hidden"*,
*"prune removes only resolved entries and emits per-row events"*, and being
SKIPPED by `store-queue-resolver.test.ts` — *"classifies by the ladder, first
match wins"*.)

**Reopen restores position.** An issue that comes back out of `done` while its
entry still exists resumes at its rank on the next read — nothing to re-queue.
If the entry was pruned, the reopened issue is unqueued and sits in the
unqueued band. (Pinned by `store-queue.test.ts` — *"a reopened issue resumes its
plan position"* — and `store-queue-resolver.test.ts` — *"a reopened issue whose
entry was pruned lands in the unqueued band"*; both halves end to end, against a
row created after it, in `queue-lifecycle.test.ts` — *"resumes at its rank, and
lands in the unqueued band only after prune"*. Plan positions are numbered over
the entries that REMAIN, so a prune closes the hole rather than leaving one.)

**Duplicate membership.** An issue appears at most once in the plan
(`PRIMARY KEY (issue_id)`). Enqueueing a present issue with no position is
idempotent — the existing entry, `replayed: true`, no event; with a position it
is a move. A container and its descendant may both be queued; the descendant is
emitted at whichever comes first. (Pinned by *"enqueue of a present issue
is a no-op replay"*, *"enqueue with a position of a present issue is a move"*,
*"a container and its descendant may both be queued"*.)

**Deleted issues** cascade out of the table. **Renames, status changes and
re-parenting** do not touch the entry: it references `issues.id`, never the
identifier, title or parent. (Pinned by *"an entry survives rename,
status change and re-parent"*, *"deleting an issue deletes its entry"*.)

**Cross-workspace items.** A queue belongs to one workspace file and references
only its own issues; enqueueing a foreign identifier is refused with
`validation` naming the workspace it belongs to. Other workspaces reach the
queue only as blockers, through the hub's `cross_links`, and those are hard
constraints as today — a blocker whose file is not on this machine is
`unresolvable` and reads as blocked. `inbox --hub` concatenates each
workspace's effective order in hub registration order; strict enforcement is
per workspace, since a checkout consults the queue of the file the issue lives
in. (Pinned by `store-queue.test.ts` — *"refuses a foreign identifier and
names its workspace"*; to be pinned by `hub.test.ts` — *"hub inbox concatenates
per-workspace effective orders"*.)

## Concurrent reorder: revision and CAS

The plan carries a monotonic **`revision`** (`meta.queue_revision`, starting at
`0`), bumped by every mutation including a renumber. Every read that returns the
plan returns it; every mutation accepts an optional `baseRevision` and is
refused with **`revision_conflict`** (exit 7, the one retryable code) when it
does not match — the same rule revisioned documents follow. A refused reorder
changes nothing: the server order stands, the caller re-reads it and decides
again. The web editor always sends the base; the CLI sends it with `--base N`
and otherwise writes blind, which is the human's own risk to take. Bulk reorder
is one call, one transaction, one revision bump. (Pinned by
`store-queue.test.ts` — *"a stale baseRevision is refused with
revision_conflict and leaves the order unchanged"*, *"bulk reorder is atomic
and bumps the revision once"*; to be pinned by `ui-queue-editor.test.ts` — *"a
stale reorder keeps the server order and offers a retry"*; pinned by
`queue-surfaces.test.ts` — *"a stale base is the same revision_conflict triple
on every surface"*.) Checkout does not
bump the revision — it changes eligibility, not the plan — so two reads of one
revision may still differ in eligibility if a claim landed between them.

## Storage

One table, added by workspace migration **008** (this page said 007 when it was
written, before R3b's milestones took that number; R2b took the next one free at
merge, per the rule in `src/core/migrations/workspace/index.ts`):

```sql
CREATE TABLE queue_entries (
  issue_id TEXT    PRIMARY KEY REFERENCES issues(id) ON DELETE CASCADE,
  rank     INTEGER NOT NULL UNIQUE,
  added_by TEXT    NOT NULL,
  added_at TEXT    NOT NULL,
  note     TEXT
);
```

The migration creates the table and seeds nothing: every existing issue is
preserved untouched and the initial queue is empty. Milestone membership (R3)
gets its own table; the queue references the milestone issue only. (Pinned by
`migrations-fixtures.test.ts` — *"the queue migration preserves every issue and
leaves the queue empty"*.)

**Rank encoding: sparse integers.** The first entry takes `1024`; an append
takes `max + 1024`; an insert between neighbours `a` and `b` takes
`(a + b) / 2` rounded down. When the gap is exhausted (`b - a < 2`) the write
renumbers the whole table to multiples of `1024` **in the same transaction** and
then inserts — a plan is tens of rows, so the O(n) rewrite is cheap and rare.
This is the `sort_order` / `SORT_ORDER_STEP` approach migration 004 already uses
for statuses and kinds, with a wider step; fractional-index strings were
rejected because integers compare natively and the renumber keeps every rank
small and readable. `UNIQUE (rank)` plus a midpoint computed inside an immediate
transaction is what makes concurrent inserts unable to collide. (Pinned by `store-queue.test.ts` — *"insert
between neighbours takes the midpoint"*, *"renumbers when the gap is exhausted,
in one transaction"*, and *"concurrent inserts never produce duplicate ranks"* —
which lives with the encoding it is about, two real processes racing one file,
rather than waiting for `queue-concurrency.test.ts`.)

**Events**, all carrying `actor` and the resulting `revision`:

- `queue_enqueued` — `{identifier, rank, position}`
- `queue_dequeued` — `{identifier, position, reason: "removed" | "pruned"}`
- `queue_moved` — `{identifier, fromPosition, toPosition, rank}`
- `queue_reordered` — `{order: [identifiers]}` (bulk reorder, one event)
- `queue_overridden` — on the issue, as above

None moves an issue's status, so none joins `STATUS_MOVING_EVENT_KINDS`.
`queue_reordered` is the one with no `issue_id`: it is a fact about the plan
rather than about any one row. (Pinned by `store-queue.test.ts` — *"every
mutation carries the actor and the resulting revision"*.)

## Operations, by surface

| CLI | MCP | HTTP |
|---|---|---|
| `staple queue [--all] [--effective]` | `list_queue` | `GET /api/queue` |
| `staple queue next [--actor A]` | `next_task` | `GET /api/queue/next` |
| `staple queue add <ref> [--before R \| --after R \| --at N] [--base N] [-m note]` | `enqueue_task` | `POST /api/queue/enqueue` |
| `staple queue rm <ref> [--base N]` | `dequeue_task` | `POST /api/queue/remove` |
| `staple queue mv <ref> (--before R \| --after R \| --at N) [--base N]` | `move_queue_entry` | `POST /api/queue/move` |
| `staple queue reorder <r1,r2,…> --base N` | `reorder_queue` | `POST /api/queue/reorder` |
| `staple queue prune` | `prune_queue` | `POST /api/queue/prune` |
| `staple checkout <ref> --override -m …` | `checkout_task {override_reason}` | `POST /api/action` |

`queue` prints plan order with the expansion indented under each container and
a `→ n` effective cue per leaf; `--effective` prints effective order with its
eligibility column. Every listing returns `{revision, entries, effective}` under
`--json`, identically on MCP and HTTP; `--at N` is a 1-based plan position and
`rm` of an absent issue is `not_found`. Every mutation on every surface goes
through ONE method, `QueueStore.mutate(verb, input, actor)`, so the verb set and
the refusals cannot drift between them. The two reads are GET-only: they share a
prefix with five POST routes and are still not writable. (Pinned by
`queue-surfaces.test.ts` — *"enqueue, move, reorder, dequeue and prune agree on
all three"*, *"next is one shape on CLI, MCP and HTTP"*, *"the reads are not
writable and the verbs are not readable"*.)

## Worked example: STA-31 → STA-66 → STA-146

VP queues three things, in this order: **STA-31** (A1, a task, `done`),
**STA-66** (S, an epic with twelve open children S1–S12), **STA-146** (a leaf,
`backlog`). Policy is `strict`. Among STA-66's children only **STA-67** (S1)
has no blocker; STA-68 (S2) waits on STA-35 and STA-67, and everything else
waits on one of those two.

```
$ staple queue
 1  STA-31   done      A1: characterize current product contracts     → 1  resolved
 2  STA-66   backlog   S: opt-in cloud continuity …                   container
      STA-67   S1: specify the local-first sync …                     → 2  eligible
      STA-68   S2: add clone-safe repository identity …               → 3  blocked STA-35, STA-67
      STA-70   S4: build the repository-scoped Worker …               → 4  blocked STA-67
      …
 3  STA-146  backlog   Flaky under full-suite load …                  → 14 eligible
```

- **Resolved.** STA-31 is a plan row and an effective row, `resolved`, skipped.
  It stays until `queue prune`.
- **Container.** STA-66 is never a checkout target. Its children expand in
  place in presentation sort (all `backlog`, so priority then `created_at`:
  S1, S2, S4, …). `staple checkout STA-66` is refused — an epic with open
  children is not claimable work. Under `strict` the ORDER guard is what speaks
  first, since a container is not an effective row at all and is therefore
  "later" than its own children; an advisory workspace hears the container
  refusal instead. Either way nobody ever holds STA-66.
- **Blocked.** STA-68 sits at effective position 3 and is `blocked` by two
  identifiers, one of them outside the epic. The queue reports it; the queue
  does not move it.
- **Next.** `staple queue next` is STA-67, with `skipped: [STA-31 resolved]`.
- **Strict refusal.** Agent `codex-1` runs `staple checkout STA-146`: exit 10,
  `out_of_order`, `expected: ["STA-67"]`. It takes STA-67 instead. Agent
  `claude-2` then runs `queue next`: STA-67 is now `claimed` (held by codex-1),
  STA-68 and STA-70 are still `blocked`, so next is **STA-146**, and its
  checkout passes the strict check.
- **Override.** Before that, VP had wanted the flake fixed first:
  `staple checkout STA-146 --override -m "CI is red for everyone"` succeeds
  under any policy and writes `queue_overridden {expected: ["STA-67"],
  position: 14, expectedPosition: 2, reason: "CI is red for everyone"}`. The
  plan is unchanged; STA-67 is still the head row for the next agent.
- **Gated.** VP runs `staple gate STA-66 --owner VP`. Every S row becomes
  `gated` (`queuedBy: STA-66`), the parked parent is still a container, and
  next becomes STA-146 (or, if it is claimed, the first unqueued row). Approval
  re-derives the whole thing on the next read; request-changes keeps it.
- **Resolved by derivation.** When S12 lands, STA-66 derives `done`; its entry
  is `resolved` like STA-31's. `queue prune` removes both.
- **Reopened.** A regression reopens STA-31 (`staple status STA-31 todo`)
  before the prune: it is plan row 1 and `eligible`, so it is the next item
  again. After a prune it is unqueued and sits in the unqueued band behind
  every plan row.
- **Cross-workspace.** A second workspace's `WOR-12` is cross-linked as a
  blocker of STA-146 (`staple link WOR-12 STA-146`). STA-146 becomes
  `blocked WOR-12` in this workspace's effective order; if `WOR-12`'s file is
  not on this machine it is `unresolvable` and STA-146 is still blocked.
  `staple queue add WOR-12` here is refused with `validation` — it belongs to
  the WOR queue.

Those nine transitions are what STA-170's regression suite replays end to end,
against a scratch workspace whose prefix really is `STA` — the transitions are
written about these identifiers, and a replay that renamed them would not be
one. (Pinned by `queue-lifecycle.test.ts`, describe *"replays the STA-31 →
STA-66 → STA-146 sequence"*: *"resolves the plan to the doc's listing: resolved
head, expanded container, blocked children"*, *"hands out STA-67, refuses
STA-146 out_of_order, then hands the second agent STA-146"*, *"takes STA-146 out
of turn under an override, on the record, without touching the plan"*, *"gates
the epic, then approves it, and the whole order re-derives on the next read"*,
*"treats a cross-workspace blocker as blocked, resolvable or not, and refuses to
queue it"*, *"derives the epic done when its last child lands, and prune forgets
both entries"*.)

## Diagnostics

`staple doctor` carries a read-only **`queue`** check over the current
workspace, reporting the plan's `revision` and entry count and warning about the
two states nothing else can show: an **orphaned** entry, whose issue no longer
exists — every ordinary listing JOINs `queue_entries` to `issues`, so such a row
is in no list, is never picked up, and still holds a rank — and an **exhausted
rank gap**, two neighbours less than 2 apart, where the next insert renumbers
the whole plan inside its own transaction. Neither is repairable by `--fix`: a
rank is renumbered by the next ordinary `queue mv`, and an orphan is only
reachable by deleting rows with foreign keys off, which is not something doctor
should silently undo. A workspace older than migration 008 skips the check.
(Pinned by `doctor.test.ts` — *"reports the revision, the entry count and an
open plan"*, *"warns about an orphaned entry and an exhausted rank gap, and
repairs neither"*; the check id list pin moved to make room for it.)

## What agents are told

The protocol the generated `AGENTS.md` teaches ([agents.md](agents.md)) is this
page reduced to what an agent must not get wrong: READY is the effective queue
rather than a suggestion, a queued container stands for its leaf work and is
never a checkout target, `staple queue next` answers before you claim, and
`conflict` (exit 4), `gated` (exit 9) and `out_of_order` (exit 10) each mean
STOP and take what the refusal names — never retry, never wait, never escalate
to `--steal-if-stale`. It also tells an agent not to reorder the plan or send
`--override`: both work for it, both record it as the actor, and both are a
human's decision. `staple queue --help` and the MCP `inbox`, `list_queue`,
`next_task` and `checkout_task` descriptions carry the same distinction between
raw plan order and effective pickup order. (Pinned by `agents-guide.test.ts` —
*"teaches that READY is the effective queue, and how the plan expands"*,
*"teaches that conflict, gated and out_of_order all mean stop, never retry"*.)
