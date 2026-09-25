# Timing semantics

What each time number staple reports means, which instants bound it, and which
single number an estimate is compared against. This page is a contract, and every
quantity on it is built: the `wall` partition, `workSeconds`, `orchestrationSeconds`
and the attempt `role` arrived with the lifecycle work (workspace migration 014, hub
migration 007), with every open-question default below accepted. Where building it
showed the page was ambiguous, the reading taken is stated in place and collected
under [Clarifications from building it](#clarifications-from-building-it).

Two pages already define time numbers, and this one does not redefine either:

- [cli.md](cli.md#estimates-vs-actuals) and `IssueTiming` in `src/core/types.ts`
  define the issue's `timing`: `activeSeconds`, `ownActiveSeconds`,
  `reviewSeconds`, `countedThrough`, `approximate`, and the estimate fields
  `estimatedSeconds`, `childrenEstimatedSeconds` and `subtreePlan`.
- [execution-telemetry.md](execution-telemetry.md#execution-attempts) defines the
  execution attempt and its derived `activeSeconds`, `pausedSeconds`,
  `idleSeconds`, `countedThrough`, lifecycle transitions and end reasons.

This page owns what neither of them could: how the two sets of numbers relate,
how one issue's elapsed time divides into buckets that never overlap, where the
boundary of each bucket falls at every transition, how orchestrator time is kept
out of agent work, and which measure the estimate ratio uses.

Why a new page rather than a section of [semantics.md](semantics.md): that page
states what the store guarantees about an issue (statuses, claims, the graph,
gates). The timing numbers are specified in cli.md and the attempt numbers in
execution-telemetry.md. Putting the reconciliation in semantics.md would make it a
third place defining `activeSeconds`. Here it is referenced and not restated.

## Two axes: elapsed and effort

Every time number on this page lies on one of two axes, and no number mixes them.

- **Elapsed** is calendar time for one issue: how long it took from the first
  start to the finish, and what it was doing each second. Each second of an
  issue's elapsed span belongs to exactly one bucket. Elapsed numbers never add
  across issues, because parallel work shares the same seconds.
- **Effort** is actor time spent on an issue: agent work and orchestration.
  Effort adds across actors and across issues. Two agents working one hour in
  parallel are two hours of effort and one hour of elapsed time.

An estimate is a statement about effort. The estimate ratio therefore uses an
effort measure ([below](#the-estimate-ratio)). Scheduling latency questions
("how long until this lands") use elapsed buckets.

The two axes also differ in where they can be computed. **Effort is computed
from replicated data only** (attempt rows, attempt transitions, the issue row, and
the agent's comments and document revisions) and reads the same on every device. **Elapsed is computed from the local event
log**, which does not replicate, so it is exact only on the device that wrote the
history ([Multi-device](#multi-device)).

## Every timing field, one meaning

The complete list. A field not in this table is not a timing field.

| Field | Axis | One meaning | Defined in | Null means |
|---|---|---|---|---|
| `timing.estimatedSeconds` | plan | The issue's own recorded estimate. | cli.md | none recorded |
| `timing.subtreePlan.estimatedSeconds` | plan | The effective plan: own estimate, else the sum of the children's effective plans. | cli.md | no plan anywhere below |
| `timing.childrenEstimatedSeconds` | plan | Sum of direct children's own estimates. | cli.md | no child estimated |
| `attempt.estimateAtStart` | plan | A reading of `subtreePlan` at the moment the attempt opened. | execution-telemetry.md | never null |
| `timing.ownActiveSeconds` | elapsed | Seconds this issue itself sat in the `active` category, summed over intervals not opened by a derived flip, with an open interval ending at `countedThrough`. | cli.md | never active |
| `timing.activeSeconds` | elapsed | The comparable form of `ownActiveSeconds`: a leaf's own, a parent's sum over direct children, `null` when cancelled. The number surfaces print as "ran". | cli.md | never active, or cancelled |
| `timing.reviewSeconds` | elapsed | Seconds in the `review` category, non-derived intervals only. An open interval ends at the newest event on the issue ([see Q3](#open-questions)). | cli.md | never in review |
| `timing.countedThrough` | instant | Where a leaf's open active interval stopped counting. Held issue: the holder's `lastActivityAt`. Unheld issue (a status write into `active` with no checkout): the newest event by **any** actor on the issue. | cli.md, `store.ts` `timingFor` | no open active interval, or a parent |
| `timing.approximate` | quality | The event log could not be replayed, so the numbers came from the fallback: `completedAt − startedAt` for `done`, `now − startedAt` for `active` and `review`, `null` otherwise. A parent is also `approximate` when any child is (the flags are ORed up). | cli.md, `store.ts` `approximateActiveOf` | never null |
| `claim.lastActivityAt` | instant | The newest event or comment by the holder on the issue, floored at `checkoutAt`. | continuity.md | not held |
| `claim.heldSeconds` | elapsed | `now − checkoutAt`. | continuity.md | not held |
| `claim.idleSeconds` | elapsed | `now − lastActivityAt`. Information, never a verdict. | continuity.md | not held |
| `attempt.activeSeconds` | effort | `startedAt` to `endedAt` (open: to `lastActivityAt`) minus `pausedSeconds`. | execution-telemetry.md | never null |
| `attempt.pausedSeconds` | effort | Sum of the attempt's paused intervals, clipped to the same end. | execution-telemetry.md | never null |
| `attempt.idleSeconds` | elapsed | For an effectively open attempt, `now − lastActivityAt`. | execution-telemetry.md | ended |
| `attempt.countedThrough` | instant | For an effectively open attempt, its `lastActivityAt`. | execution-telemetry.md | ended |
| **`wall`** | elapsed | The issue's elapsed span and its partition into buckets ([below](#the-elapsed-partition-of-one-issue)). | this page | `never_started`, or `replay_unavailable` |
| **`leadSeconds`** | elapsed | `createdAt` to `wall.startAt`. Time before any work began. Not part of `wall`. | this page | as `wall` |
| **`workSeconds`** | effort | Agent work on the issue, from worker-lane attempts only ([Work](#work)). Leaf: `ownWorkSeconds`. Parent: the sum over direct children, with `coverage`. **The estimate ratio's actual.** | this page | [reason code](#missingness-for-the-new-fields) |
| **`ownWorkSeconds`** | effort | The measurement behind `workSeconds`: this issue's own worker attempts, for any status including cancelled. | this page | [reason code](#missingness-for-the-new-fields) |
| **`orchestrationSeconds`** | effort | Orchestrator-lane attempts' effective `activeSeconds` on this issue, plus the sum over its children. Never part of `workSeconds`. | this page | `no_orchestrator_attempt` |
| **`resumeGapSeconds`** | elapsed | On a `chain` link, `next.startedAt − previous.endedAt`: how long an interrupted piece of work waited to be picked up again, across whatever buckets that spans. Specified here for the calibration work and not emitted yet. | this page | no successor yet |
| **`estimateRatio`** | ratio | `workSeconds / estimatedSeconds`, for the eligible population only ([below](#the-estimate-ratio)). | this page | ineligible |

Durations are whole seconds in a field ending in `Seconds`. Instants are
ISO-8601 UTC with milliseconds ([Formats](execution-telemetry.md#formats)). A zero
is a measured zero, and `null` is never `0`
([Missingness](execution-telemetry.md#missingness)).

Two existing fields have names close to new ones, and each keeps its existing
meaning. `timing.activeSeconds` is **category time**: it counts every second the
issue sat in `active`, including paused time, interruption gaps and silent
stretches. `attempt.activeSeconds` is **tenure time**: one agent's tenure minus
its pauses. Neither is renamed. Where this page needs "agent work" it says
`workSeconds`, and where it needs "the issue was in progress" it says the
`active` category.

## The elapsed partition of one issue

### The span

- **`wall.startAt`**: for a leaf, the first entry into the `active` category that
  was not a derived flip. For a parent, the first entry into `active` by any means,
  including derived flips. That is the moment the first child started, or the
  parent's own checkout.
- **`wall.endAt`**: the last entry into `done` or `cancelled`, if the issue is in
  one of them now. Otherwise the issue is open, `wall.endAt` is `null`, and the
  span runs to the read's `asOf` instant, reported as `wall.through`.
- **`wall.seconds`**: `endAt − startAt`, or `through − startAt` while open.

The category at each instant comes from replaying the local status-moving events,
the same replay `timingFor` runs. When that replay cannot reproduce the row's
current status (`timing.approximate`), `wall` is `null` with reason
`replay_unavailable`. `wall` has no two-timestamp fallback, because a fallback
cannot say which bucket a second was in.

`asOf` is a parameter of every derivation on this page. Surfaces pass the read
instant. Fixtures pass an explicit instant: `timingFor(ids, asOf)`, which defaults
to the clock only when a surface passes nothing.

### Attempt coverage at an instant

The active-category buckets are defined against the issue's **worker-lane**
attempts, each read with the orphan rule applied. For a worker attempt `A`:

- `I(A) = [A.startedAt, end(A))`, where `end(A)` is the attempt's end as the
  ledger reads it on this device: the stored `endedAt`, or `endedAtBound` for an
  attempt that reads orphaned, and `asOf` for an effectively open one. The
  partition is device-local anyway, so it uses the same local evidence the
  ledger does. `workSeconds` uses replicated evidence instead ([Work](#work)).
- `c(A)` is the evidence limit: `countedThrough` for an effectively open attempt,
  and `end(A)` otherwise.
- `P(A)` is the union of its paused intervals: each `attempt_paused` at `p` to the
  next `attempt_resumed`, or to `end(A)` when none followed.
- "The latest worker attempt started at or before `x`" is the one with the
  greatest `startedAt` not after `x`, ties broken by the greater `id`, the order
  the telemetry contract uses.

### The buckets

Every millisecond `x` of `[wall.startAt, wall.endAt or wall.through)` falls into
exactly one bucket. The bucket is chosen by the issue's status **category** at
`x`, and, for a leaf in `active`, by attempt coverage at `x`:

| Bucket | A leaf's millisecond `x` is here when |
|---|---|
| `work` | category `active`, and some worker attempt `A` has `x ∈ I(A)`, `x < c(A)` and `x ∉ P(A)` |
| `paused` | category `active`, and some worker attempt `A` has `x ∈ I(A)` and `x ∈ P(A)` |
| `silent` | category `active`, and some effectively open worker attempt `A` has `x ∈ I(A)`, `x ≥ c(A)` and `x ∉ P(A)`. Open attempts only, and provisional ([below](#provisional-buckets)) |
| `interrupted` | category `active`, no worker attempt covers `x`, and the latest worker attempt started at or before `x` has effectively ended `interrupted` or reads `orphaned` |
| `unattributed` | category `active` and none of the above: no worker attempt started at or before `x`, or the latest one ended `completed`, `yielded` or `failed` while the category stayed `active`. Pre-capture history, or a capture gap |
| `review` | category `review` |
| `gated` | category `gated` |
| `blocked` | category `blocked`, **or** category `unstarted`/`ready` while the issue has at least one unresolved `blocks` edge ([edge history](#dependency-edge-history)) |
| `queued` | category `unstarted`/`ready` with no unresolved blocker: returned to the pool after starting (release, a status write back, `request-changes`) |
| `resolved` | category `done`/`cancelled` before a later reopen. Only a reopened issue has any |

**Precedence.** When more than one active-category row matches, which happens
only when attempts overlap (a merge of two offline checkouts, or the contested
case), the first match wins: `work` > `paused` > `silent` > `interrupted` >
`unattributed`. Each millisecond is counted once, in the winning bucket.

Invariant, exact in milliseconds **when no interval was clamped for
`clock_skew`** ([Clocks](#clocks)):

```
wall = work + paused + interrupted + silent + unattributed
     + review + gated + blocked + queued + resolved
```

Reported values are each floored to whole seconds once, so the reported sum can
fall short of `floor(wall)` by at most one second per nonzero bucket. A clamped
inversion breaks the invariant by the clamped amount, and the record carries
`clock_skew`.

The first five buckets partition the leaf's time in the `active` category. When
every worker attempt on the leaf held a claim (`claim.scope` of `local` or
`lease`) and the replay is exact:

```
ownActiveSeconds = work + paused + interrupted + unattributed      (ended work)
ownActiveSeconds = work + paused + interrupted + unattributed
                   up to countedThrough                            (open work)
```

This holds within one second per interval, since `ownActiveSeconds` floors each
interval separately. It does **not** hold for an open attempt opened by a status
write with no claim (`claim.scope: none`). There `timing.countedThrough` is the
newest event by any actor, while the attempt's evidence limit is its own agent's
last activity, so `ownActiveSeconds` can run past `c(A)` and count some of
`silent`.

**Why `blocked` includes dependency waits.** A blocked status is a human-cleared
flag, and dependency edges are the way this project records waiting on other
work. A pre-work second with an unresolved blocker cannot be worked, because the
`in_progress` guard refuses it, so it is blocked whichever way the block was
recorded. Precedence is by category: an issue in `active` that gains a blocker
stays in the `active` buckets. Checkout is refused only on entry, and the agent's
attempt is still open. [Agent guidance](#what-downstream-work-takes-from-this-page)
asks the agent to yield or pause in that case, so the time moves to `blocked` or
`paused`.

**Review and gated stay separate buckets.** `review` is a leaf that is finished
and waiting on a reviewer. `gated` is a parent parked on a named owner. Both are
waits on a person, and reports that want "review delay" sum the two. They stay
separate because `timing.reviewSeconds` already means the `review` category
alone, and folding the gate into it would change an existing field.

### Parents

A parent has no stopwatch ([semantics.md](semantics.md#a-parents-status-is-derived-from-its-children)),
and that rule governs **effort**. It does not apply to elapsed time. A parent's
elapsed partition uses its own status category at each instant, **derived flips
included**, because the derived ladder already answers "what is this subtree doing
right now" with one category:

| Parent bucket | The parent at that instant |
|---|---|
| `active` | category `active`: ladder rung 1 (an open child is active), or the parent is checked out |
| `review` | category `review`: rung 2 (no child active, an open child in review) |
| `gated` | category `gated`: the parent's own gate |
| `blocked` | category `blocked` (rung 4, every open child blocked or gated, or a manual block), **or** category `unstarted`/`ready` with an unresolved `blocks` edge on the parent itself, such as a `blockParentUntilDone` edge from a child |
| `queued` | category `unstarted`/`ready` (rung 3, an open child is workable and none is active or in review) with no unresolved edge on the parent |
| `resolved` | category `done`/`cancelled` before a reopen |

The edge rule is the same one leaves use, so a parent held back by an unresolved
`blockParentUntilDone` edge reads `blocked`, as a leaf with an unresolved blocker
does.

A parent's `active` bucket is not divided by attempts. Its effort is the
children's `workSeconds` plus its own `orchestrationSeconds`, reported on the
effort axis. The ladder's rule that `blocked` requires every open child to be
blocked is the right rule for elapsed time: one workable child means the subtree
is not waiting.

On the maintainers' tracker, parents spent 247.9 hours in derived `active`
intervals. That time is correctly not billed as effort today, and it is the
parent `active` bucket here.

## Boundary rules

### Intervals are half-open

Every interval is `[start, end)`. A transition at instant `t` closes the old
bucket at `t` and opens the new one at `t`, so no instant belongs to two buckets.
Two transitions at the same instant produce a zero-length interval, which is
counted as `0` and not dropped, as `activeSeconds` already does. The replay orders
an issue's status-moving events by `created_at`, then `seq`, with its
`issue_created` first whatever its instant. Within one database the two orders
agree; once pulled operations re-emit their events at the origin's instant
([Multi-device](#multi-device)), a pulled event can hold a higher `seq` than a
local event it precedes in time, and only the time order is one every device that
holds the same events replays alike. Attempts and transitions are ordered by
`startedAt`/`at`, then `id`.

### Every transition

`t` is the mutation's instant. `L` is the ending attempt's `lastActivityAt`.

| Transition | Elapsed boundary | Effort boundary |
|---|---|---|
| `checkout` (new claim) | `wall` starts at `t` if it has not. `work` from `t` | worker attempt opens at `t` |
| Issue born in `active`, or a non-derived status write into `active` | as checkout | worker attempt `openedBy: status`, `claim.scope: none`, opens at `t` |
| Holder re-claims with its attempt still open (any `sessionRef`) | none | none. `attempt_session_added` is not a boundary |
| Holder re-claims after its attempt ended | `interrupted` until `t`, `work` from `t` | new attempt at `t`, `resumesAttemptId` set |
| `checkout --steal-if-stale` | `[L, t)` is `interrupted`, `work` from `t` | old attempt ends at `L` (`endedAtSource: last_activity`), even if it was paused. New attempt at `t` |
| `attempt_paused` | `paused` from `t` | pause starts at `t` |
| `attempt_resumed` | `work` from `t` | pause ends at `t` |
| `attempt_milestone` | none. Evidence only, it moves `lastActivityAt` | none |
| `attempt interrupt` (reported) | `interrupted` from `t` | attempt ends at `t` (`endedAtSource: mutation`) |
| Leaves `active` for `review` | `review` from `t` | attempt ends `completed` at `t` |
| Leaves `active` for `blocked` | `blocked` from `t` | attempt ends `yielded` at `t` |
| Leaves `active` for `ready`/`unstarted`, or `release` | `blocked` or `queued` from `t`, by the edges | attempt ends `yielded` at `t` |
| `release --if-stale` | `[L, t)` `interrupted`, then `blocked`/`queued` from `t` | attempt ends `interrupted` at `L`, even if it was paused |
| Leaves `active` for `done`/`cancelled` | `wall` ends at `t` unless reopened | attempt ends at `t` |
| `gate` (parent) | parent `gated` from `t` | a checked-out parent's attempt ends `yielded`/`gated` at `t` |
| `approve` | parent re-derived at `t`, bucket by the ladder | none |
| `request-changes` | parent `queued` or `blocked` from `t`, by its edges. Children unchanged | none |
| `approve --children` | none on the parent. Released children leave the queue, which does not change their buckets | none |
| Derived flip on a parent | parent bucket changes at `t` | none, ever |
| `blocked-by` adds an unresolved blocker to a pre-work issue (`blockers_changed`) | `queued` becomes `blocked` at `t` | none |
| `blocked-by` removes the last unresolved blocker (`blockers_changed`) | `blocked` becomes `queued` at `t` | none |
| A blocker enters `done`/`cancelled` (the blocker's own event at `t`) | a dependent's `blocked` becomes `queued` at `t`, if that was its last unresolved blocker | none |
| A blocker is reopened | a dependent's `queued` becomes `blocked` at `t` | none |
| A blocker is deleted (the edge goes by cascade, with no event) | unknown instant. The dependent's edge-derived time is `approximate` | none |
| An edge is created with the issue (`--blocked-by` on `new`) or by `blockParentUntilDone` (no event) | from `relations.created_at`. The record is `approximate` if that edge matters inside the wall span | none |
| Reopen from `done`/`cancelled` | `[endAt, t)` becomes `resolved`. `wall.endAt` is recomputed | none |
| Attempt read as orphaned | its end is `endedAtBound`, clipped to the `active` category | replicated evidence before the earliest limit ([Work](#work)) |
| Issue deleted | `wall` ends at the deletion. Excluded from every ratio | open attempts orphan (`issue_removed`) |
| A status is recategorized in the vocabulary (`staple statuses`) | no event. The replay reads each status's category from the **current** vocabulary, so it still replays exactly and the history is re-bucketed retroactively ([Q9](#open-questions)) | open worker attempts orphan by clause 2 if the status left `active` |
| `statuses remove --migrate-to` | no event, and the removed id is unreadable to the replay, so the issue falls back to `approximate` and `wall` is `replay_unavailable` | as above |

Two consequences:

- **Elapsed attempt time is clipped to the issue's own non-derived `active`
  intervals.** An attempt that reads orphaned can have an effective end after the
  instant the issue left `active`. In the elapsed partition, category precedence
  already puts those milliseconds in the category's bucket. This clipping belongs
  to the elapsed axis only. `workSeconds` does not read the event log
  ([Work](#work)).
- **Boundaries from one mutation are one instant.** The attempt ledger and the
  event writer call the clock separately (`nowIso()` in each), so one checkout
  can stamp its event and its attempt a few milliseconds apart. That would put a
  few-millisecond `unattributed` sliver at every start. Rule: an attempt's
  `startedAt` or `endedAt` within one second of a category boundary on the same
  issue is snapped to the **category boundary**, which wins. Pause and resume
  instants are never snapped, because they are not category boundaries and have
  no partner instant to snap to. New data needs no snapping: a mutation reads the
  clock once (`Journal.mutationAt`, the scope's instant) and hands that instant to
  the row, its events and the attempt ledger's opens, ends and transitions.

### Dependency edge history

The `blocked` bucket needs the set of unresolved blockers at every instant of the
wall span. The sources, in order of authority:

1. **`blockers_changed` events on the dependent.** Each carries the full blocker
   set after the change (`blocked-by` is set replacement), identified by
   `identifier`. This is authoritative for every change it records.
2. **`relations.created_at`** for an edge no event explains. It is only a lower
   bound on how long the edge has existed: `blocked-by` deletes and re-inserts the
   whole set, which resets `created_at` on every edge it keeps.
3. **The blocker's own status-moving events** for when it resolved (entered
   `done` or `cancelled`) and reopened.

The gaps, as measured before the lifecycle work, and how each is closed now:

- An edge created with the issue (`new --blocked-by`) and every
  `blockParentUntilDone` edge were inserted without a `blockers_changed` event.
  Both now emit one, with the whole set, on the dependent: the new issue for
  `--blocked-by`, the parent for `blockParentUntilDone`. The child-to-parent edge
  also travels now, with the child's create, and every applier adds it to the
  parent's set rather than replacing the set, so two children created offline on two
  devices both keep theirs. Before, it existed nowhere but on the device that created
  the child, and was lost even there when the parent's own create came back.
- Deleting an issue removes its edges by cascade, with no event on the dependent.
  No mutation of this build deletes an issue; the one path that removes rows and
  edges is a restore's rewind, and it now writes a `blockers_changed` on every issue
  whose set it changed, dated at the instant the restore committed (the snapshot's
  `restoredAt`), the same on every device. An edge the newest event names and the
  device no longer holds, however it went, is reported as `edge_history_incomplete`.
- `blocked-by` deleted and re-inserted the whole set, resetting `created_at` on
  every edge it kept. It now removes only the edges that leave and inserts only
  the ones that arrive.
- Events do not replicate, so edge history was device-local. Pulled operations now
  re-emit their `blockers_changed` at the origin's instant ([Multi-device](#multi-device)).
  Each event carries the blocker ids (`blockedByIds`) beside the identifiers, and
  the replay reads the ids, which survive a renumber.

On the maintainers' tracker there are 37 `blockers_changed` events and 221
`blocks` edges, and 22 of those edges are child-to-parent `blockParentUntilDone`
edges.

Rule: edge-derived `blocked` time is exact only when every edge that was
unresolved at some instant of the wall span is explained by a `blockers_changed`
event on the dependent. Otherwise that edge is taken to start at its
`relations.created_at`, and the record carries `edge_history_incomplete`, which
makes it `approximate`. A blocker's resolution comes from its own status-moving
events; a blocker with none (a device that hydrated) is taken as open until its
row's `completedAt` or `cancelledAt`.

### Clocks

| Instant | Clock |
|---|---|
| `events.created_at`, issue `startedAt`/`completedAt`/`cancelledAt`/`updatedAt`, attempt `startedAt`/`endedAt`, transition `at`, comment `created_at` | the local clock of the device that made the mutation |
| `observedAt`, `resetsAt` on budget samples | the provider ([Clocks](execution-telemetry.md#formats)) |
| lease expiry | the sync service |

Provider and service instants never bound a timing interval. Local-clock
instants from **different devices** are compared in three places, and each is
named so a skew there is expected:

1. `workSeconds` compares an orphaned attempt's replicated evidence (the
   agent's clock) with the issue row's `completedAt` or `cancelledAt` (the clock
   of whoever made that mutation) ([Work](#work)).
2. The elapsed partition compares attempt instants (the opening device's clock)
   with category boundaries from the local event log.
3. The `blocked` bucket compares a blocker's resolution instant with the
   dependent's own boundaries. Both are in the same local log, but once events
   are re-emitted with origin instants they can come from different devices.

An interval whose end precedes its start counts as `0`, as the existing replay
already does. That clamp breaks the exact partition invariant by the clamped
amount, so the record carries `clock_skew` and is `approximate` whenever an
inversion exceeds one second.

### Multi-device

- **Pulled operations re-emit their events, dated at the origin.** A local
  mutation notes every status-moving event (`issue_created`, `status_changed`,
  `checkout`, `claim_stolen`, `release`, `claim_released_stale`) and every
  `blockers_changed` it writes, and its `issue` or `relation` operation carries them
  as `originEvents`: kind, actor, payload and instant. Applying the operation writes
  the same events as local rows, with the origin's instant and a `deviceId`, under
  the apply's suppressed journal scope, so nothing is journaled and a redelivered
  operation re-derives the same dedup keys (`src/core/cloud/reemit.ts`). A device's
  own operations coming back are skipped, a status a conflict withheld narrates
  nothing, and an operation from a build that carries none is narrated from the
  change itself (`issue_created` from a create, `status_changed` from a status that
  moved, dated at the row's `updatedAt`). A device that read the tail therefore
  replays the writer's history and reads the same `timing` and `wall`.
- **A hydrated device still has no history.** A snapshot folds operations into
  state and carries no event log, so a device that hydrated reads `timing` as
  `approximate` and `wall` as `replay_unavailable` for every issue that changed
  before it hydrated. Its `workSeconds` is the same as everywhere else, which is
  why the estimate ratio uses it.
- **Effort converges.** `workSeconds` and `orchestrationSeconds` read only
  attempt rows, attempt transitions, the issue row and the agent's comments and
  document revisions, all of which replicate with origin instants. Open and
  orphaned attempts are measured to their replicated evidence, not to
  `lastActivityOf`, so they read the same everywhere too ([Work](#work)). The
  attempt's own `lastActivityAt` and `countedThrough` fields still read local
  `events` and can differ between devices. They are information about the claim,
  not inputs to effort.
- **Contested attempts** ([the contested case](execution-telemetry.md#orphaned-attempts-are-closed-at-read-time))
  carry `contested: true`, and any measure that includes one is provisional until
  the claim conflict is resolved.

### Pauses are not interruptions

This follows [Lifecycle](execution-telemetry.md#lifecycle) and adds only where
the time goes.

- A **pause** keeps the attempt, the claim and the harness session. Paused time is
  its own bucket and never `work`. A pause that is still open stays `paused`
  through `asOf`, because a declared pause needs no further evidence.
  `attempt.pausedSeconds` for an open attempt stops at `lastActivityAt`, so the
  bucket can exceed it until the attempt ends. For an ended attempt the two are
  equal.
- An **interruption** ends the attempt. The time from its end to the next worker
  attempt on the issue, or to the issue leaving `active`, is `interrupted`. If the
  issue left `active` (a stale release), what follows is `queued` or `blocked`,
  and the link's `resumeGapSeconds` spans all of it.
- **Neither is idle.** `idleSeconds` (claim or attempt) is information about an
  open tenure at read time. It is never a bucket and never summed.

### Provisional buckets

Two buckets can change after the fact, and a read at a later `asOf` reclassifies
the same milliseconds.

**`silent`** exists only while an attempt is open. It is the part of the span
after the last evidence of work, and it resolves one of three ways:

1. The agent writes again. `lastActivityAt` moves, and the silence becomes `work`.
2. The attempt ends by a mutation the agent makes (`done`, `status`). The span up
   to that mutation becomes `work`, and the attempt carries the `sparse` quality
   input if the silence was long ([below](#quality-inputs)).
3. The attempt ends by inference (steal, stale release, stored or read-time
   orphan end). It ends at `L`, so the silence becomes `interrupted`.

**`paused`** is provisional too. An inferred end is dated at `L`, the agent's
last activity, whether the attempt was running or paused
(`endByMutation` with `inferred` in `src/core/telemetry/attempts.ts`). Recording a pause
writes an event by the agent, so `L` is at or after the pause start: the pause
keeps `[pausedAt, L)`, and everything from `L` to the steal or release becomes
`interrupted`. That is deliberate. A pause nobody resumed before the claim was
taken away was, in the end, an interruption.

This is the existing rule for `countedThrough` applied to buckets: a dead
process is never billed for a weekend, and a live one is credited once it proves
it was alive.

## Effort: work and orchestration

### Work

`workSeconds` reads **replicated data only**: the worker-lane attempt rows, their
transitions, the replicated issue row, and the agent's replicated comments and
document revisions on the issue. It never reads the local `events` table. That
rules out `lastActivityOf` (`src/core/telemetry/attempt-derive.ts`), which reads
`events` and therefore gives a different `lastActivityAt`, `countedThrough` and
`endedAtBound` on a device that did not write the history.

**Replicated evidence.** For a worker attempt `A`, `evidenceAt(A)` is the latest
of:

- `A.startedAt`;
- the `at` of `A`'s `attempt_started`, `attempt_paused`, `attempt_resumed`,
  `attempt_milestone` and `attempt_session_added` transitions. **Never an ending
  transition** (`attempt_ended`, `attempt_interrupted`): the ledger stamps those
  with `nowIso()` when the end is written (`end` in
  `src/core/telemetry/attempts.ts`), which can be days after the work stopped;
- the `created_at` of every comment on the issue by `A.agent` that is not deleted,
  after `A.startedAt`;
- the `created_at` of every document revision on the issue by `A.agent`, after
  `A.startedAt`.

All of these replicate with their origin instants, so every device computes the same
`evidenceAt(A)` from the same rows. It can be earlier than `lastActivityAt`,
because a status write or other event by the agent is not replicated evidence.
On the maintainers' tracker this makes no difference to the sparse count: the
same 30 of 187 done leaves are sparse by either kind of evidence.

**Limits filter evidence, they never clamp it.** Every bound below is a
**limit** on which evidence counts, not a value the end is pulled to. For a limit
`λ`, `evidenceBefore(A, λ)` is the latest of `A.startedAt` and every evidence
instant of `A` that is **strictly before** `λ`. Evidence at or after the limit is
ignored, and the end never moves to `λ` itself. A clamp would do the opposite:
`min(evidenceAt, λ)` turns a comment written after a stale release into "work
until the release", crediting the silence the release had already classified as
an interruption. With several limits, the earliest one applies.

**The row bound.** For an attempt whose issue left `active`, the replicated row
gives a limit when it can:

- the row is `done` and has `completedAt`: `completedAt`;
- the row is `cancelled` and has `cancelledAt`: `cancelledAt`;
- anything else: **no limit from the row**. `updatedAt` is not one, because
  recategorizing a status (`recategorizeStatus` in `src/core/store.ts`) moves
  issues out of `active` without touching `updated_at`. Such an attempt carries
  the `end_unbounded` quality input.

**The successor limit.** `next(A)` is the `startedAt` of the next worker attempt
on the issue, by `startedAt` then `id`, when there is one. Evidence at or after
it belongs to the successor's tenure. Without this limit, an attempt orphaned by
a recategorisation and followed by the same agent re-claiming and commenting
would absorb the successor's comments and count the same seconds twice.

**The end of each worker attempt `A`, read with the orphan rule applied:**

- **Recorded end, reported or by another actor** (a stored end that is not an
  orphan end, as `isOrphanEnd` in `src/core/cloud/attempt-ends.ts` tells them
  apart, with `endDetection` other than `inferred`): `end(A) = A.endedAt`. Each
  is written by the mutation that ended the tenure (the `statusMoved`, `released`
  and `stolen` hooks in `src/core/telemetry/attempts.ts`), dated at that
  mutation, and replicates, so it reads the same everywhere.
- **Recorded end, inferred** (`claim_stolen`, `released_stale`): the stored
  `endedAt` is the stealing or releasing device's `lastActivityOf`, which reads
  that device's local events and can miss evidence that replicated from the
  attempt's own device. Using it alone would shrink the work after the fact. So
  `end(A) = max(A.endedAt, evidenceBefore(A, λ))`, where `λ` is `next(A)` for a
  steal, and the `at` of the ending `attempt_interrupted` transition (the release
  instant) for a stale release.
- **Orphan end, stored or derived** (a stored end with `endDetection: inferred`
  and a reason in `ORPHAN_END_REASONS`, or a stored-open attempt that reads
  `orphaned`): `end(A) = evidenceBefore(A, λ)`, where `λ` is the earliest of
  `next(A)` and, for `left_active`, the row bound.

  A **stored** orphan end also filters at its stored `endedAt`, inclusively
  (evidence after it is ignored). The opener dated it at its own
  `lastActivityOf`, which is at or after every replicated evidence instant it
  had applied, so the filter only drops evidence written after the tenure was
  given up, and the number does not move when the stored end arrives. One edge
  case breaks that argument: the **same identity** writing document revisions
  from a second device. The opener applies those revisions but emits no
  `doc_updated` event for them, so its `lastActivityOf` can miss them, and the
  stored `endedAt` can be earlier than evidence the derived end had counted. The
  number then shrinks when the stored end arrives. It is the same shared-identity
  cost the telemetry contract already documents, and a per-session identity
  avoids it.

  A derived orphan end is **provisional** until the stored end exists. Its reason
  can still change, and the row limit with it: an attempt orphaned `left_active`
  becomes `claim_moved` if the issue is reopened and another agent claims it,
  which drops the `completedAt` limit. The `workSeconds` read carries the
  `orphan_provisional` input (`approximate`) until the stored orphan end is
  written.
- **Effectively open**: `end(A) = evidenceBefore(A, next(A))` when a successor
  exists (only after a merge), otherwise the latest evidence. An open attempt's
  work is counted through its last replicated evidence, so it can lag the elapsed
  `countedThrough` on the device that is writing.

`A`'s contribution is `seconds(startedAt, end(A))` minus its paused intervals
clipped to `[startedAt, end(A))`. For recorded ends that equals
`attempt.activeSeconds`.

`ownWorkSeconds` is the sum of those contributions over the issue's worker-lane
attempts. `workSeconds` applies the judgement `activeSeconds` applies:

- leaf: `ownWorkSeconds`
- parent: the sum of the direct children's `workSeconds`, with `coverage`
  ([below](#missingness-for-the-new-fields))
- `cancelled`: `null` with reason `not_applicable_cancelled`, whatever ran

A parent's own worker attempts (a parent checked out and worked directly) stay
in its `ownWorkSeconds` and are not added to its `workSeconds`, mirroring
`ownActiveSeconds`. [Q5](#open-questions) asks whether that should change.

The elapsed `work` bucket is a different, device-local reading of the same
tenures: it uses `countedThrough` and the attempt's effective end from the
ledger, clipped to the replayed `active` category. On the writing device the two
agree except where replicated evidence trails local evidence. Elsewhere
`workSeconds` is defined and `wall` is not.

**The capture gap, from replicated data.** The issue row's `startedAt` is
stamped on the first entry into `active` and never cleared, and it replicates.
If the issue's first worker attempt started more than one second after
`startedAt`, some work before it has no attempt, `workSeconds` is a **lower
bound**, and the record carries the `capture_gap` quality input. If the row has
a `startedAt` and there is no worker attempt at all, `workSeconds` is `null` with
`no_worker_attempt`. This test needs no "capture began" instant, which would be
device-local (it is when migration 013 ran on that device).

Before capture began, attempts exist only if `staple attempt reconstruct` built
them, with `provenance: reconstructed`. Those carry no pauses, so their work
equals the category time of the reconstructed tenures.

### Missingness for the new fields

These follow the telemetry contract's [Missingness](execution-telemetry.md#missingness)
rules, and add five reason codes to its closed set. That is a contract addition:

| Code | Meaning |
|---|---|
| `never_started` | The replicated row has no `startedAt` and the issue has no worker attempt. `workSeconds` and `leadSeconds` are `null`. On the maintainers' tracker, 6 of the 187 done leaves went to `done` this way. `wall` uses it too, for an issue whose replay never enters `active`. |
| `not_applicable_cancelled` | `workSeconds` of a cancelled issue. `ownWorkSeconds` still reports what ran. |
| `no_worker_attempt` | The row has a `startedAt` and the issue has no worker attempt: work before capture that was never reconstructed, or a capture gap. The two are not told apart, because the instant capture began is device-local. |
| `no_orchestrator_attempt` | `orchestrationSeconds` when no issue in the subtree has an orchestrator attempt, including every issue while [Q1](#open-questions) is unresolved. |
| `replay_unavailable` | `wall` on a device whose event replay does not reach the row's status ([Multi-device](#multi-device)). |

A parent's `workSeconds` is a sum over a set, so it follows the contract's
Propagation rule and carries `coverage: {known, total}`:

- `total` is the number of direct children that are not cancelled and are not
  `never_started`. A child that never started owes no work.
- `known` is the number of those whose `workSeconds` is not `null`.
- `partial: true` when `known < total`. The parent's quality is then
  `approximate`.
- `known = 0` makes the parent's `workSeconds` `null` with `input_missing` and the
  list of the missing children. `total = 0` makes it `null` with `never_started`.

### Orchestration

Orchestration is coordination: choosing and dispatching work, writing and
reading handoffs, reviewing an agent's result, merging, and moving tickets
between states on someone else's behalf. It runs alongside agent work, often on
the same issues, so it lies on the effort axis only. It is never an elapsed
bucket, because a second in which an orchestrator reviews a ticket that is in
`review` is already that ticket's `review` second.

**Attribution is an explicit, per-attempt field.** The recommendation adds
`role` to the attempt record: `worker` or `orchestrator`. An attempt opened by
`checkout`, a steal, a re-claim or a status write is always `worker`. Those
writes refuse a `role` argument, and no environment variable sets it. The only
way to get an `orchestrator` attempt is `staple attempt open <ref> --role
orchestrator` ([below](#the-orchestrator-lane)). `workSeconds` sums worker
attempts only, `orchestrationSeconds` sums orchestrator attempts only, and no
attempt is in both.

Why not an identity convention (for example "any `STAPLE_AGENT` containing
`orchestrator` is an orchestrator"):

- **The identities are not consistent.** The maintainers' tracker records
  coordination under at least `voya-orchestrator` (108 events),
  `codex-orchestrator` (11), `orchestrator-opus` (6), `orchestrator` (1), and the
  human or assistant identities `Voya`, `voya`, `vpetkovic` and `VP`. 181 events
  have no actor at all. A convention would need a registry, and every new
  spelling would count as agent work until someone added it.
- **The same identity does both.** `voya` checked out and implemented 5 leaves
  itself. That was work, and a name-based rule would have filed it as overhead.
  The role belongs to the tenure, not to the actor. This is also why checkout
  refuses `role`: an orchestrator that takes a leaf is working it.
- **Shared identities hide it.** `claude` and the `$USER` fallback are shared by
  concurrent sessions ([Q3 of the telemetry contract](execution-telemetry.md#open-questions)).
  A name cannot say which session was coordinating.

### The orchestrator lane

An orchestrator does not hold the claim on the tickets it coordinates, a worker
does. So orchestrator attempts are a second **lane** of attempts on an issue,
with their own opening path and their own end rules. Every rule of the attempt
contract as implemented on master is scoped to the **worker lane**, and the
orchestrator lane gets the rules below. [Q1](#open-questions) lists each of these
as a contract change.

**Worker-lane scoping, by function** (paths under `src/` on master):

| Function | Change |
|---|---|
| `evaluateIssue` (`core/telemetry/attempt-derive.ts`) | Evaluates worker attempts only. The contested set, clauses 3 to 5 and `laterOpen` never see an orchestrator attempt, so an open orchestrator attempt cannot orphan an older worker attempt as `superseded_by_merge`. |
| `viewsOfIssue` and `viewOf` (`attempt-derive.ts`) | Evaluate each lane with its own clauses: worker attempts through `evaluateIssue`, orchestrator attempts through the orchestrator-lane clauses below. Every view carries `role`. |
| `effectivelyOpen`, and `targets` (`core/telemetry/attempts.ts`) through it | Return worker attempts only. A release, steal or status write ends the worker's attempt and leaves the orchestrator's alone. |
| `resumeFor` (`attempts.ts`) | "The latest attempt" means the latest **worker** attempt. |
| `record` (`attempts.ts`) | `pause`, `resume`, `milestone` and `interrupt` choose among the actor's **worker** attempts, and the `open[0]` fallback for `interrupt` is limited to worker attempts. To act on an orchestrator attempt the caller passes a new `--role orchestrator` flag or the attempt id, which is required when the actor holds one of each. With neither, an actor holding an attempt in one lane only acts on that lane, so an orchestrator with nothing claimed pauses its own attempt without the flag. |
| `countEffectivelyOpen` (`attempt-derive.ts`), the concurrency context (`concurrency` in `attempts.ts`) and the presence index (`ownAttempts`, `writeRows` in `core/telemetry/presence.ts`) | Count both lanes, because both burn provider budget, and report the split by `role` in new concurrency fields. The presence index gains a `role` column. |
| `attemptLinkerFor` (`core/telemetry/attempt-link.ts`) | A harness session that holds one attempt in each lane would link a budget sample to two candidates and return `ambiguous_attempt`. The linker prefers the worker attempt and falls back to the orchestrator attempt only when no worker attempt matches. |
| The read summary `attempts: {current, last, count}` on `show`/`get_task` ([Surfaces](execution-telemetry.md#surfaces)) | Describes the worker lane only. Orchestrator attempts appear beside it as `orchestration: {current, count}`. |
| `reconstructAttempts` (`core/telemetry/reconstruct.ts`) | Builds worker attempts only. Orchestration before capture is `null` with `no_orchestrator_attempt`. |
| `writeOrphanEnds` (`attempts.ts`) | Writes stored ends for orchestrator attempts using the orchestrator-lane clauses below. |
| `ORPHAN_END_REASONS` (`core/cloud/attempt-ends.ts`) | Gains `issue_resolved` and `superseded_by_newer`. Every reader of the log applies the orphan-versus-real-end rule through this set: the client applier (`apply-attempts.ts`), conflict screening (`conflicts.ts`), hydration through `ATTEMPT_END_FIELDS` (`hydrate.ts`), the tail fold (`tail-fold.ts`), the Worker fold (`worker/src/fold.ts`) and the test service. Without the new reasons, each of them would treat an orchestrator's stored orphan end as a real end, and a stored `superseded_by_newer` would conflict with a real `coordination_ended`. The Worker imports this file, so it must be **redeployed** before any client writes the new reasons. |

**How an orchestrator attempt opens.** `staple attempt open <ref> --role
orchestrator` (MCP `record_attempt_event` with `event: "open"`) opens an attempt
with `openedBy: "orchestrate"`, `claim.scope: "none"` and `role: "orchestrator"`
on the issue being coordinated, usually the parent or epic. It changes neither
the issue's status nor its claim. `staple attempt end <ref> --role orchestrator`
ends it `yielded`, reason `coordination_ended`, which is a real end.

**How it ends at read time.** The orchestrator lane has its own orphan clauses,
evaluated only from replicated rows, so every device reads the same answer:

> A stored-open orchestrator attempt is **effectively ended** when:
>
> 1. its issue no longer exists (`issue_removed`);
> 2. its issue's category is `done` or `cancelled` (`issue_resolved`). Bound:
>    `completedAt` or `cancelledAt`;
> 3. a **newer orchestrator attempt by the same agent exists** in the workspace,
>    in any state, by `startedAt` then `id` (`superseded_by_newer`). Bound: the
>    newer attempt's `startedAt`.
>
> When more than one clause holds, the reason is the **first** clause that holds,
> and the effective end is `evidenceBefore(A, λ)` ([Work](#work)), where `λ` is
> the earliest bound of every clause that holds. Bounds filter the evidence, they
> never clamp the end to themselves.

Clause 3 does not require the newer attempt to be open. If it did, an attempt
superseded by a newer one would revive as soon as the newer one ended. Clause 2
means an epic resolved on another device still ends its orchestrator attempt on
every device, with no local mutation needed. Clause 3 makes "one open
orchestrator attempt per agent" a read-time rule: the newest wins
deterministically, whichever device opened which. Two sessions sharing one
identity (`claude`) will supersede each other. That is the documented cost of a
shared identity, and it is visible as `superseded_by_newer`. The device that
opened a superseded or resolved attempt writes its stored end the same way it
writes a worker orphan end, and the apply rule then settles it against any real
end. Its stored `endedAt` is the replicated evidence before the clauses' earliest
bound, the same instant every device already read as the derived end, rather than
the opener's local `lastActivityOf`: an orchestrator's evidence is on other issues,
and dating the end by this issue's local events would move the number when the
stored end arrives.

The successor limit of an orchestrator attempt is the agent's next orchestrator
attempt anywhere in the workspace (clause 3's bound), not the next attempt on the
issue: another agent's orchestration on the same issue is a separate clock.

Because clause 3 bounds the older attempt's end by the newer one's start, one
agent's orchestrator attempts never overlap, and that agent's orchestration
clock is the sum of its attempts' effective durations.

**Evidence.** An orchestrator attempt's replicated evidence (as defined in
[Work](#work)) includes the agent's comments and document revisions on the issue
**and on every descendant**, because coordination is written on the children.
Pauses and milestones work as for any attempt.

`orchestrationSeconds` for an issue is the sum over its own orchestrator
attempts of `seconds(startedAt, end)` minus pauses, with the end computed as in
[Work](#work) (recorded end as stored, otherwise evidence and bounds), plus its
children's `orchestrationSeconds`. An orchestrator's writes outside every
orchestrator attempt are not orchestration time. They are events, with no
duration.

**Why not measure orchestration from write cadence.** It can be done today with
no new write path: group an orchestrator's writes into sessions separated by more
than 15 minutes of silence. On the maintainers' tracker, `voya-orchestrator` has
148 writes (events and comments) over 18 days, and that method yields 33 sessions
totalling 1.59 hours. That is far below the real coordination time, because
coordination is mostly reading and waiting, which leave no write. A figure that
low would make orchestration look free. Cadence is kept as an illustration only
and is not a measure.

**Review effort.** A reviewer agent dispatched to check a worker's result is
coordination, not execution of the ticket. It opens an orchestrator attempt on
the ticket in review. [Q6](#open-questions) asks whether review needs a third
role.

**Humans.** A person approving a gate or reading a review is not measured as
effort. Their wait shows as the issue's `review` and `gated` buckets, which is
what a scheduler needs.

## The estimate ratio

**The actual is `workSeconds`.** It is the only measure the ratio uses:

```
estimateRatio = workSeconds / estimatedSeconds
```

An issue is **eligible** when all of these hold:

- it contributes its **own** estimate (`subtreePlan.source` is `own`), so the plan
  and the actual cover the same subtree. An issue whose plan was inherited from
  descendants is not a separate data point. Its estimated descendants are.
- it is resolved `done`. Cancelled work has `workSeconds: null`.
- its quality state is `exact` ([Quality inputs](#quality-inputs)), unless the
  consumer asks to include other states explicitly.

An aggregate over a set of issues is `Σ workSeconds / Σ estimatedSeconds` over
the eligible members (a ratio of sums, weighted by size). It carries
`coverage: {known, total}`, where `total` is the number of issues in the
requested set that are `done` and have `subtreePlan.source` `own`, and `known`
is the number of those that are eligible. That is the denominator the quality
work reports coverage against.

Why `workSeconds` and not the alternatives:

| Candidate | Why not |
|---|---|
| `timing.activeSeconds` (today's "ran") | It is category time. It includes paused time (a provider-limit wait with the claim held), interruption gaps before a steal, and, once the agent writes again, the silence before that write. These are the non-work intervals the attempt contract was built to separate. It is also computed from the local event log, so it is `approximate` on every device that did not write the history ([Multi-device](#multi-device)). |
| `wall.seconds` | Elapsed, not effort. It includes review, gates, blocking and queueing, which the estimate never planned for. On the maintainers' tracker, 15 of the 124 estimated done leaves have `(completedAt − startedAt) / estimate` above 0.5, against 13 for `activeSeconds / estimate`, and its 90th percentile is 0.715 against 0.293. The extra tail is waiting, not work. |
| `attempt.activeSeconds` of the last attempt | A single tenure. Work that was interrupted and resumed spans several attempts. |
| `workSeconds + orchestrationSeconds` | It charges coordination to the ticket. The estimate is for doing the work. Orchestration overhead is reported beside the ratio, as a separate figure. |

What the choice costs: `workSeconds` needs attempts. For history before capture,
the ratio needs `staple attempt reconstruct` and is then `reconstructed` quality.
Without it, older issues are `missing` and drop out of trusted samples. They are
not silently replaced by `activeSeconds`.

**Which estimate.** The denominator is the issue's own `estimatedSeconds` at
read time, which is what every surface shows today. `attempt.estimateAtStart` is
the better calibration input once there is enough of it, because the estimate
column is overwritten in place. Each change is recorded as an `estimate_changed`
event (`from`, `to`, actor), but a read of the column shows only the latest
value, and an imported or restored workspace has no event log to replay.
[Q4](#open-questions) asks when to switch.

## Quality inputs

Each record gets exactly one quality state. The state set and the coverage rules
belong to the quality-indicators work. This page supplies what each state is
derived from, and a precedence that makes the answer unique.

There are two records with two states, because the two axes are computed from
different data. **The state of `workSeconds` uses replicated inputs only**, so
the ratio's eligibility is the same on every device:

| `workSeconds` state (highest precedence first) | Inputs that produce it |
|---|---|
| `missing` | **Exactly when `workSeconds` is `null`** on an issue that is not cancelled: reason `never_started`, `no_worker_attempt` or `input_missing`. |
| `reconstructed` | Any contributing attempt has `provenance: reconstructed`. |
| `approximate` | Any of: a parent's `coverage.partial`; any contributing attempt `contested` (the claim is contested, or two devices ended it differently and the attempt's `end` record is open); `capture_gap` (the row's `startedAt` is more than one second before the first worker attempt, so `workSeconds` is a lower bound); `orphan_provisional` (a derived orphan end not yet stored); `end_unbounded` (an orphan end the row cannot bound); `clock_skew` between an attempt's instants and the row bound; or `sparse`, a gap longer than **30 minutes** between consecutive replicated evidence instants inside a worker attempt's working time. |
| `timing-floor` | `workSeconds < 60`. The work fits inside the write cadence the measure resolves, so the number says "quick" and little more. The record stays visible. |
| `exact` | None of the above. |

**The state of `wall`** and every elapsed figure is `approximate` when
`timing.approximate` is set, `unattributed > 0`, `edge_history_incomplete`,
`conflict_resolved` (part of the span is a resolved status conflict's reading), or
`clock_skew` on a partition interval, and is `null` with `replay_unavailable`
where the replay cannot run. These inputs never reach the `workSeconds` state:
they are device-local, and a ratio that was eligible on one device and not on
another would not be a measurement.

`provider-unavailable` concerns budget samples, not timing, and nothing on this
page produces it.

**Why `sparse` and why 30 minutes.** This is the largest data-quality problem in
the current numbers. On a snapshot of the maintainers' tracker (300 issues, 187
leaves resolved `done`, taken 2026-09-24):

- The 187 done leaves have 345.4 hours of `activeSeconds`. **295.1 hours (85.4%)
  of it lies inside holder-silent gaps longer than 30 minutes**: stretches with
  no event and no comment by the holder, inside an active interval that later
  closed normally. Those gaps occur in only 30 of the 187 issues. Measured with
  replicated evidence only (the holder's comments and document revisions, plus
  the interval's start and end), the same 30 issues are sparse, and the same 18
  of the 124 estimated ones. One ticket
  estimated at 6 hours shows 68.5 hours, of which 67.9 are silent.
- The longest silent gap per interval (187 closed non-derived active intervals
  across the done leaves: 178 leaves have one, 2 have two, 1 has five, and 6 have
  none) has a
  median of 10.4 minutes, a 75th percentile of 19.5 minutes and a 90th
  percentile of 332.8 minutes (lower quantiles; see the note below the figures
  table). The distribution is bimodal, and 30 minutes falls in the empty stretch
  between the modes. Moving the threshold between 30 and 240 minutes changes the
  silent share only from 85.4% to 82.6%, so the choice is not sensitive.
- Of the 124 estimated done leaves, 18 are sparse. **All 13 leaves whose
  `activeSeconds / estimate` exceeds 0.5 are sparse, and so are all 11 above
  1.0.** None of the 106 non-sparse leaves exceeds 0.5. The sparse minority is
  the whole upper tail.

With attempts, much of that silence should become `paused` (an agent that stops
at a provider limit reports `checkpoint_before_reset`) or `interrupted` (a
session that died and was resumed). `sparse` marks the remainder instead of
guessing a cap. Capping a gap at N minutes would produce a number no timeline
produced.

## What the live tracker says, in one place

All figures come from a read-only snapshot of the maintainers' tracker **taken
on 2026-09-24**, read with this repository's own `timingFor` under an isolated
home directory. The tracker is live and keeps changing: a later read the same
day found 31 sparse done leaves (19 of them estimated) where this snapshot has
30 (18).

| Figure | Value |
|---|---|
| Issues, leaves, done leaves, estimated done leaves | 300, 259, 187, 124 |
| Issues whose timing is `approximate` | 5 |
| Done leaves that were never `active` | 6 |
| Active hours on done leaves; share in >30 min holder-silent gaps | 345.4 h; 85.4% |
| `activeSeconds / estimate`, estimated done leaves (n = 124): p10 / p50 / p90 | 0.047 / 0.097 / 0.293 |
| The same, above 0.5 / above 1.0 | 13 / 11, all of them sparse |
| The same, non-sparse only (n = 106): p10 / p50 / p90 | 0.046 / 0.089 / 0.159 |
| `(completedAt − startedAt) / estimate` (n = 124): p50 / p90 | 0.098 / 0.715 |
| Closed-interval category time, all issues: active, derived active (parents), review, gated, blocked | 351.6 h, 247.9 h, 5.3 h, 20.1 h, 32.0 h |
| Entries into `active`: checkout, non-derived status write, derived flip | 191, 10, 116 |
| Entries into `blocked` by hand: status writes, created as `blocked` | 4, 1 |
| `blocks` edges; of which `blockParentUntilDone` (child to parent); `blockers_changed` events | 221; 22; 37 |
| Orchestrator cadence (`voya-orchestrator`, 15-minute sessions) | 148 writes, 33 sessions, 1.59 h |

**Quantile method.** Every percentile on this page is the **lower** quantile: the
value at index `floor(p × (n − 1))` of the ascending list, with `n` as stated.
The upper tail of the ratio is sparse, so the method matters there: the values
around the 90th percentile of the 124 ratios run 0.293, 0.574, 0.862, and linear
interpolation gives 0.490 where the lower quantile gives 0.293. That is why the
claims above rest on counts (13 above 0.5, 11 above 1.0), which do not depend on
the method. Other methods move the non-sparse figures only in the third decimal
place.

The ratios are far below 1 because estimates are recorded as human-effort plans
and agents execute faster. That is the thing being calibrated, not an error.

## What downstream work takes from this page

| Work | Takes |
|---|---|
| Closing lifecycle capture gaps | The [bucket table](#the-buckets), its precedence and [every transition](#every-transition) as the reconstruction spec. `asOf` as a parameter. One mutation instant for every writer. `workSeconds` from replicated data only, as specified in [Work](#work). Re-emitting status-moving and edge events dated at the origin instant, so `wall` stops being device-local. `blockers_changed` from every edge-writing path. Pauses never counted as work, and resume opening a new interval. Terminal transitions closing every open interval. The replicated-only inputs (`sparse`, `capture_gap`, `end_unbounded`) as the explicit approximation flags on `workSeconds`, and `unattributed` and `edge_history_incomplete` on `wall`. The orchestrator lane and worker-lane scoping, if [Q1](#open-questions) is accepted. Agent guidance: yield or pause when a blocker appears mid-work. |
| Validating against controlled runs | Every bucket is defined in milliseconds from recorded instants, so a controlled run states its expected timeline as a list of transitions and an `asOf`, and compares the `wall` buckets, `workSeconds`, `interrupted` and `resumeGapSeconds`, and `orchestrationSeconds`. **Fixtures must control the write clock**, not just `asOf`: every instant on this page comes from `nowIso()` at write time, so a reproducible run injects the clock the store, the event writer and the attempt ledger all read. Tolerance: one second per interval for `activeSeconds`, one second per nonzero bucket for the partition, plus the one-second snapping window. `review` and `blocked` are disjoint by construction, so a run that reads the same second in both has found a bug. Runs on a second device check that `workSeconds` matches and that `wall` reads `replay_unavailable` until re-emission is built. |
| Quality indicators | The [quality inputs](#quality-inputs), the precedence, the [coverage](#missingness-for-the-new-fields) of parents and of the ratio aggregate, and the five new reason codes. |
| Calibration and forecasting | `estimateRatio` and its eligibility, `orchestrationSeconds` as a separate overhead figure, `resumeGapSeconds` per chain link. |

## Where the numbers appear

`timing` on every detail surface (`staple show --json`, MCP `get_task`, HTTP
`/api/issue` and `/api/agent-context`) carries, beside the existing fields:

```json
{
  "workSeconds": 2400,
  "ownWorkSeconds": 2400,
  "orchestrationSeconds": null,
  "leadSeconds": 0,
  "estimateRatio": 0.6666666666666666,
  "wall": {
    "startAt": "2026-09-01T09:00:00.000Z",
    "endAt": "2026-09-01T10:10:00.000Z",
    "through": null,
    "seconds": 4200,
    "buckets": { "work": 2400, "paused": 1800, "silent": 0, "interrupted": 0, "unattributed": 0,
                 "review": 0, "gated": 0, "blocked": 0, "queued": 0, "resolved": 0 }
  },
  "quality": {
    "work": { "state": "exact", "inputs": [], "coverage": null, "missingInputs": [] },
    "wall": { "state": "exact", "inputs": [] }
  },
  "missing": { "orchestrationSeconds": "no_orchestrator_attempt" }
}
```

A parent's `wall.buckets` are `active`, `review`, `gated`, `blocked`, `queued` and
`resolved`; its `quality.work.coverage` is `{known, total, partial}`, and
`missingInputs` (the contract's name for the inputs of an `input_missing` value) names the children counted in `total` whose `workSeconds` is
null. `missing` holds the reason for each new field that is null. The work
state of a cancelled issue is `null`: it owes no comparable work, so it is neither
`missing` nor any other state.

Beside `attempts: {current, last, count}` (the worker lane), the same surfaces
carry `orchestration: {current, count}`: the issue's own orchestrator attempts, read
with the orchestrator lane's clauses.

The orchestrator lane is written with `staple attempt open <ref> --role
orchestrator` and `staple attempt end <ref> --role orchestrator` (MCP
`record_attempt_event` with `event: "open"` or `"end"` and `role: "orchestrator"`).
Both refuse any other role. `checkout`, `status`, `done`, `release` and the MCP claim
tools refuse `--role` (`role`) by name rather than dropping it. The concurrency
context reports `openAttemptsInWorkspaceByRole` and
`storedOpenAttemptsStartedHereByRole`, `{worker, orchestrator}`, beside the totals,
which count both lanes.

## Clarifications from building it

Each is a reading of this page the implementation had to choose. The page above
states the choice in place.

1. **Replay order.** The replay orders events by `created_at`, then the tie-break of item 10, with the
   birth first. The page said `seq`, which is only a device-local order once
   events are re-emitted at their origin's instant ([Intervals are half-open](#intervals-are-half-open)).
2. **A hydrated device.** Re-emission makes `wall` the same on a device that read
   the tail. A device that hydrated from the snapshot still reads
   `replay_unavailable`, because a fold carries no history ([Multi-device](#multi-device)).
3. **An orchestrator's stored orphan end** is dated at its replicated evidence
   before the clauses' bound, not at the opener's `lastActivityOf`, so the number
   holds when it arrives. Its successor limit is the agent's next orchestrator
   attempt anywhere in the workspace ([The orchestrator lane](#the-orchestrator-lane)).
4. **Lane choice without a flag.** An actor with an attempt in one lane only acts
   on it. `--role` or the attempt id is required only when it holds one of each.
5. **A cancelled issue's work state** is `null`, not `missing`: the table defines
   `missing` for issues that are not cancelled.
6. **Five reason codes, not four.** The table under
   [Missingness](#missingness-for-the-new-fields) lists five
   (`never_started`, `not_applicable_cancelled`, `no_worker_attempt`,
   `no_orchestrator_attempt`, `replay_unavailable`), and so does Q10. The downstream
   row said four.
7. **`sparse` is measured over working time.** The gaps are between consecutive
   evidence instants, with the attempt's start and effective end counted as
   evidence, and paused time taken out of each gap.
8. **The child-to-parent edge now replicates.** `blockParentUntilDone` edges were
   device-local, and were lost even on the originating device when the parent's own
   create came back. They travel with the child's create and are added to the
   parent's set, never replacing it.
9. **`resumeGapSeconds`** is defined here for the calibration work and not emitted
   by the lifecycle work.
10. **Tie-break for one millisecond.** Events carry the device that wrote them first
   and its `seq` (`origin_device`, `origin_seq`), and the replay orders by
   `(created_at, origin_device, origin_seq or seq)`, the same on every device.
11. **What a seed or a migration narrates is nothing.** Every issue and relation
   operation carries `originEvents`, empty when the mutation narrated nothing, so
   a receiver invents no history. An issue a device learned of by a seed reads
   `replay_unavailable` there, with its `timing` on the two-timestamp fallback.
12. **A resolved status conflict is one approximate span.** Between the first of two
   conflicting status writes and the decision, each device holds only its own side's
   events. Every resolution writes a canonical `status_changed` to the chosen value at
   the decision, on every device and whether or not the row moves there, naming where
   the disagreement began and where its second write was (`conflictStartedAt`,
   `conflictLastWriteAt`). The replay replaces only the disputed span, from the first
   write to the first event both sides hold after the second (or to the decision), with
   the decision; history before and after it stays, however late the decision comes.
   Every device reads the same partition, and `wall` carries the new input
   `conflict_resolved` (approximate), on the issue and on every dependent whose
   blocker's history was settled this way. Two devices that decide one record offline
   to different values converge on the decision later in the log, on every device, the
   one whose own decision lost included; both canonical events are held everywhere.
   Operations are dated at their mutation's instant, so the two instants are the
   contested writes themselves. The two status writes also ended the worker attempt two
   ways; the decision settles that attempt-end record too, choosing the end that follows
   the chosen status, as its own `conflict` operation, so `workSeconds`, its quality and
   `estimateRatio` read the same everywhere. An attempt-end conflict nobody has settled
   is `contested` on the devices that hold its record; a device that hydrated from the
   snapshot holds no record, cannot see the disagreement, and reads the fold's end
   unflagged until it is settled.

## Open questions

Each needs a decision. The page above is written to the recommended default.

1. **Orchestrator attribution, and the attempt-contract changes it needs.**
   Default: accept all of the following, each a change to the approved attempt
   contract:
   - a `role` field on the attempt (`worker` | `orchestrator`). That is a new
     column, so workspace migration 014 and a new `schema` stamp, which again
     forces every device to upgrade together (older clients refuse the page with
     `schema_ahead`). The attempt create payload and the sync.md field inventory
     gain `role`. The hub presence index gains a `role` column (a hub migration);
   - `role` is set only by `staple attempt open`. `checkout`, steals, re-claims
     and status writes refuse it, and no environment variable sets it;
   - two new commands, `staple attempt open` and `staple attempt end`, which are an
     exception to "No caller writes an attempt directly";
   - a new `openedBy` value, `orchestrate`, and new end reasons
     `coordination_ended`, `issue_resolved` and `superseded_by_newer`;
   - an orchestrator attempt's evidence includes the issue and all its
     descendants;
   - the orchestrator-lane read-time clauses (removed, resolved, superseded by
     any newer attempt of the same agent, first clause wins, earliest limit filters the evidence),
     applied by every reader and by `writeOrphanEnds`;
   - `issue_resolved` and `superseded_by_newer` added to `ORPHAN_END_REASONS` in
     `src/core/cloud/attempt-ends.ts`, which the client applier, conflict
     screening, hydration, the tail fold, the Worker fold and the test service
     all read. The Worker imports that file, so it is **redeployed first**, as
     for protocol 3;
   - a `--role orchestrator` flag (or an attempt id) on `staple attempt
     pause|resume|milestone|interrupt` and MCP `record_attempt_event`, required
     when the actor holds an attempt in each lane;
   - the concurrency context and the presence counts split by `role`;
   - budget-sample linking (`attemptLinkerFor`) preferring the worker attempt when
     one harness session holds both;
   - the read summary `attempts: {current, last, count}` describing the worker
     lane, with a new `orchestration: {current, count}` beside it;
   - every existing attempt rule scoped to the worker lane, in `evaluateIssue`,
     `viewsOfIssue`/`viewOf`, `effectivelyOpen`, `targets`, `resumeFor`,
     `record`, `countEffectivelyOpen`, the presence index and
     `reconstructAttempts`, as listed in
     [The orchestrator lane](#the-orchestrator-lane).

   The alternative is a registered set of orchestrator identities (a workspace
   setting) classifying attempts by agent. It needs no contract change, but it
   misfiles an orchestrator that implements a leaf, and it depends on identities
   being spelled consistently, which the data shows they are not. Without either,
   `orchestrationSeconds` is always `null` with `no_orchestrator_attempt`.
2. **Sparse threshold.** Default: a gap of more than 30 minutes between
   consecutive replicated evidence instants inside a worker attempt's working
   time marks it `sparse` and makes it `approximate`. Nothing is
   subtracted.
3. **Open review intervals.** `timing.reviewSeconds` ends an open review interval
   at the newest event on the issue, borrowed from the rule for active intervals.
   Review is a queue, and a queue's clock does not stop because nobody writes.
   Default, built: an open review interval ends at `asOf`. This changed the
   reading for issues currently in review, and no closed interval.
4. **Which estimate the ratio divides by.** Default: the current own
   `estimatedSeconds`, until estimate history exists (the estimate-mutation event
   the telemetry contract asks for). Then switch to the first worker attempt's
   `estimateAtStart`, so a re-estimate made after the work started cannot flatter
   the ratio.
5. **A parent's own worker attempts.** Default: kept in `ownWorkSeconds`, not
   added to the parent's `workSeconds`, mirroring `activeSeconds`. The alternative
   adds them, which is more complete but makes the two rollups differ.
6. **Review effort as its own role.** Default: no. A reviewer agent opens an
   orchestrator attempt, and review effort is part of `orchestrationSeconds`. The
   alternative is a third role, `reviewer`, if review cost needs forecasting on
   its own.
7. **`timing-floor` cut-off.** Default: `workSeconds < 60`. One done leaf is
   below 60 seconds on the maintainers' tracker, and 12 are below 300 seconds.
8. **Dependency waits inside `blocked`.** Default: yes, a pre-work second with an
   unresolved `blocks` edge is `blocked`, for leaves and parents alike. The
   alternative keeps `blocked` to the status category and reports dependency
   waits inside `queued`. That would leave `blocked` near zero on a tracker that
   records blocking as edges.
9. **Recategorizing a status re-buckets history.** The replay reads categories
   from the current vocabulary, so moving a status to another category changes
   the buckets of every past interval spent in it, with no `approximate` flag.
   Default: accept this. The elapsed partition is retroactive, and it is the
   same rule `timing` follows today: a recategorization says what the status
   means, including in the past. The alternative is to stamp the category into
   each status-moving event and replay the stamped category. That is exact to
   history but needs every emitter to change, and it still cannot fix events
   written before the change.
10. **New reason codes.** Default: add `never_started`, `not_applicable_cancelled`,
    `no_worker_attempt`, `no_orchestrator_attempt` and `replay_unavailable` to the
    telemetry contract's closed set, and the quality inputs `sparse`,
    `capture_gap`, `orphan_provisional`, `end_unbounded`, `clock_skew` (for `workSeconds`) and
    `unattributed`, `edge_history_incomplete`, `clock_skew` (for `wall`) to the
    quality-indicators work.
