# Timing semantics

What each time number staple reports means, which instants bound it, and which
single number an estimate is compared against. This page is a contract. The
quantities it names as existing are built. The ones it names as new (the `wall`
partition, `workSeconds`, `orchestrationSeconds`, the attempt `role`) are not built
yet, and the changes they need in the attempt contract are listed in
[Q1](#open-questions).

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
from replicated data only** (attempt rows, attempt transitions and the issue row)
and reads the same on every device. **Elapsed is computed from the local event
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
| **`orchestrationSeconds`** | effort | Orchestrator-lane attempts' effective `activeSeconds` on this issue, plus the sum over its children. Never part of `workSeconds`. | this page | no orchestrator attempt in the subtree |
| **`resumeGapSeconds`** | elapsed | On a `chain` link, `next.startedAt − previous.endedAt`: how long an interrupted piece of work waited to be picked up again, across whatever buckets that spans. | this page | no successor yet |
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
instant. Fixtures pass an explicit instant. Today `timingFor` calls `nowIso()`
itself. Taking `asOf` as an argument is part of the lifecycle work.

### Attempt coverage at an instant

The active-category buckets are defined against the issue's **worker-lane**
attempts, each read with the orphan rule applied. For a worker attempt `A`:

- `I(A) = [A.startedAt, end(A))`, where `end(A)` is the effective end from
  [Work](#work) for an attempt that has ended or reads orphaned, and `asOf` for
  an effectively open one.
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
counted as `0` and not dropped, as `activeSeconds` already does. Events are
ordered by `seq` within one database. Attempts and transitions are ordered by
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
| Attempt read as orphaned | its end is the effective end from [Work](#work) | same end |
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
  no partner instant to snap to. The lifecycle work should also pass one mutation
  instant to every writer (the ledger already accepts `mutationAt` on open), so
  new data needs no snapping.

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

The gaps, all measured against the current store:

- An edge created with the issue (`new --blocked-by`) and every
  `blockParentUntilDone` edge are inserted without a `blockers_changed` event.
  `issue_created` carries no blocker set.
- Deleting an issue removes its edges by cascade, with no event on the dependent.
- Events do not replicate, so edge history is device-local, like the rest of the
  elapsed axis.

On the maintainers' tracker there are 37 `blockers_changed` events and 221
`blocks` edges, and 22 of those edges are child-to-parent `blockParentUntilDone`
edges.

Rule: edge-derived `blocked` time is exact only when every edge that was
unresolved at some instant of the wall span is explained by a `blockers_changed`
event on the dependent. Otherwise that edge is taken to start at its
`relations.created_at`, and the record carries `edge_history_incomplete`, which
makes it `approximate`. The lifecycle work closes the gap by emitting
`blockers_changed` with the full set from every edge-writing path: creation,
`blockParentUntilDone`, and the cascade on delete.

### Clocks

| Instant | Clock |
|---|---|
| `events.created_at`, issue `startedAt`/`completedAt`/`cancelledAt`/`updatedAt`, attempt `startedAt`/`endedAt`, transition `at`, comment `created_at` | the local clock of the device that made the mutation |
| `observedAt`, `resetsAt` on budget samples | the provider ([Clocks](execution-telemetry.md#formats)) |
| lease expiry | the sync service |

Provider and service instants never bound a timing interval. Local-clock
instants from **different devices** are compared in three places, and each is
named so a skew there is expected:

1. `workSeconds` compares an orphaned attempt's `endedAtBound` (the attempt's
   agent's clock) with the issue row's `completedAt`, `cancelledAt` or
   `updatedAt` (the clock of whoever made that mutation) ([Work](#work)).
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

- **Pulled operations write no issue events.** On master and on the attempts
  branch, `src/core/cloud/` has no event writer for issue operations. The only
  re-emission is `apply-attempts.ts`, for attempt transitions, dated by their own
  `at`. So on a device that pulled an issue's status change, and on a freshly
  hydrated device that has no event log at all, the replay cannot reach the row's
  status. `timing` reads `approximate: true` with `reviewSeconds: null` there, and
  `wall` is `replay_unavailable`. This is not a rare case. It is every issue that
  device did not change itself. [sync.md](sync.md#events-are-re-derived-never-transported)
  says applying an operation re-emits the originating event, and that is not
  built. Building it as written would still not be enough, because an event
  written at apply time is dated by the apply. The lifecycle work must re-emit
  status-moving and edge events **dated at the operation's origin instant** before
  `wall` or `timing` can be the same on two devices.
- **Effort converges.** `workSeconds` and `orchestrationSeconds` read only
  attempt rows, attempt transitions and the issue row, all of which replicate
  with origin instants ([Work](#work)). An ended attempt reads the same on every
  device. An open attempt's `lastActivityAt` reads local evidence, which on a
  remote device is the replicated comments and transition events, so its
  `countedThrough` can trail the origin's until the attempt ends.
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
(`endByMutation` with `inferred` in `telemetry/attempts.ts`). Recording a pause
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
transitions, and the replicated issue row. It never reads the local event log,
and so it is the same on every device.

For each worker-lane attempt `A` on the issue, read with the orphan rule applied:

- **Stored end** (`state: ended` in the row, whether a recorded end or a stored
  orphan end): `end(A)` is `A.endedAt`. Every recorded end is already written by
  the mutation that takes the issue out of `active` (the `statusMoved`,
  `released` and `stolen` hooks in `telemetry/attempts.ts`), so no further
  clipping is needed.
- **Derived orphan end** (stored open, reads `orphaned`): `end(A)` is
  `A.endedAtBound`, further clipped by the replicated issue row where it says the
  work stopped earlier:
  - reason `left_active` and the row is `done`: `min(endedAtBound, completedAt)`
  - reason `left_active` and the row is `cancelled`: `min(endedAtBound, cancelledAt)`
  - reason `left_active` and any other category: `min(endedAtBound, updatedAt)`,
    an upper bound on when the status changed
  - `claim_moved`, `claim_cleared`, `superseded_by_merge`, `issue_removed`:
    `endedAtBound`
- **Effectively open**: `end(A)` is `countedThrough`.

`A`'s contribution is `seconds(startedAt, end(A))` minus its paused intervals
clipped to `[startedAt, end(A))`. For stored ends that is exactly
`attempt.activeSeconds`, which is what the ledger already derives.

`ownWorkSeconds` is the sum of those contributions over the issue's worker-lane
attempts. `workSeconds` applies the judgement `activeSeconds` applies:

- leaf: `ownWorkSeconds`
- parent: the sum of the direct children's `workSeconds`, with `coverage`
  ([below](#missingness-for-the-new-fields))
- `cancelled`: `null` with reason `not_applicable_cancelled`, whatever ran

A parent's own worker attempts (a parent checked out and worked directly) stay
in its `ownWorkSeconds` and are not added to its `workSeconds`, mirroring
`ownActiveSeconds`. [Q5](#open-questions) asks whether that should change.

On a device where the replay is exact, the elapsed `work` bucket and
`ownWorkSeconds` differ only where an orphaned attempt's effective end falls
after the issue left `active`, which the partition clips and `workSeconds`
bounds by the row. On any other device, `workSeconds` is still defined and `wall`
is not.

When `unattributed > 0` on the elapsed axis, some active time had no worker
attempt, and `workSeconds` is a **lower bound** on the real work. The record is
then `approximate` ([Quality inputs](#quality-inputs)).

Before capture began, attempts exist only if `staple attempt reconstruct` built
them, with `provenance: reconstructed`. Those carry no pauses, so their work
equals the category time of the reconstructed tenures.

### Missingness for the new fields

These follow the telemetry contract's [Missingness](execution-telemetry.md#missingness)
rules, and add four reason codes to its closed set. That is a contract addition:

| Code | Meaning |
|---|---|
| `never_started` | The issue never entered `active` and has no worker attempt. `wall`, `leadSeconds` and `workSeconds` are all `null`. On the maintainers' tracker, 6 of the 187 done leaves went to `done` this way. |
| `not_applicable_cancelled` | `workSeconds` of a cancelled issue. `ownWorkSeconds` still reports what ran. |
| `no_worker_attempt` | The issue was active after capture began and has no worker attempt: a capture gap. |
| `replay_unavailable` | `wall` on a device whose event replay does not reach the row's status ([Multi-device](#multi-device)). |

`before_capture_began` (existing) covers an issue that was active only before
capture and has no reconstructed attempts.

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
contract as implemented on the attempts branch is scoped to the **worker lane**,
and the orchestrator lane gets the rules below. [Q1](#open-questions) lists each
of these as a contract change.

**Worker-lane scoping, by function** (`src/core/telemetry/` on the attempts
branch):

| Function | Change |
|---|---|
| `evaluateIssue` (`attempt-derive.ts`) | Evaluates worker attempts only. The contested set, clauses 3 to 5 and `laterOpen` never see an orchestrator attempt, so an open orchestrator attempt cannot orphan an older worker attempt as `superseded_by_merge`. |
| `effectivelyOpen`, and `targets` (`attempts.ts`) through it | Return worker attempts only. A release, steal or status write ends the worker's attempt and leaves the orchestrator's alone. |
| `resumeFor` (`attempts.ts`) | "The latest attempt" means the latest **worker** attempt. |
| `record` (`attempts.ts`) | `pause`, `resume`, `milestone` and `interrupt` choose among the actor's **worker** attempts, and the `open[0]` fallback for `interrupt` is limited to worker attempts. To act on an orchestrator attempt the caller passes `--role orchestrator` (or the attempt id), which is required when the actor holds one of each. |
| `countEffectivelyOpen` (`attempt-derive.ts`) and the presence index (`ownAttempts`, `writeRows` in `presence.ts`) | Count both lanes, because both burn provider budget, and report the split by `role`. The presence index gains a `role` column. |
| `reconstructAttempts` (`reconstruct.ts`) | Builds worker attempts only. Orchestration before capture is `before_capture_began`. |
| `writeOrphanEnds` (`attempts.ts`) | Writes stored ends for orchestrator attempts using the orchestrator-lane clauses below. |

**How an orchestrator attempt opens.** `staple attempt open <ref> --role
orchestrator` (MCP `record_attempt_event` with `event: "open"`) opens an attempt
with `openedBy: "orchestrate"`, `claim.scope: "none"` and `role: "orchestrator"`
on the issue being coordinated, usually the parent or epic. It changes neither
the issue's status nor its claim. `staple attempt end <ref> --role orchestrator`
ends it `yielded`, reason `coordination_ended`.

**How it ends at read time.** The orchestrator lane has its own orphan clauses,
evaluated only from replicated rows, so every device reads the same answer:

> A stored-open orchestrator attempt is **effectively ended** when:
>
> 1. its issue no longer exists (`issue_removed`);
> 2. its issue's category is `done` or `cancelled` (`issue_resolved`). The
>    effective end is `min(endedAtBound, completedAt or cancelledAt)`;
> 3. a newer stored-open orchestrator attempt by the **same agent** exists in the
>    workspace, by `startedAt` then `id` (`superseded_by_newer`). The effective
>    end is `min(endedAtBound, newer.startedAt)`.

Clause 2 means an epic resolved on another device still ends its orchestrator
attempt on every device, with no local mutation needed. Clause 3 makes "one open
orchestrator attempt per agent" a read-time rule: the newest wins
deterministically, whichever device opened which. Two sessions sharing one
identity (`claude`) will supersede each other. That is the documented cost of a
shared identity, and it is visible as `superseded_by_newer`. The device that
opened a superseded or resolved attempt writes its stored end the same way it
writes a worker orphan end.

Because clause 3 clips the older attempt's end to the newer one's start, one
agent's orchestrator attempts never overlap, and that agent's orchestration
clock is the sum of its attempts' effective `activeSeconds`.

**Evidence.** An orchestrator attempt's `lastActivityAt` reads the agent's events
and comments on the issue **and on every descendant**, because coordination is
written on the children. Pauses and milestones work as for any attempt.

`orchestrationSeconds` for an issue is its own orchestrator attempts' effective
`activeSeconds` plus its children's `orchestrationSeconds`. An orchestrator's
writes outside every orchestrator attempt are not orchestration time. They are
events, with no duration.

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
the better calibration input once there is enough of it, because the estimate is
overwritten in place with no history. [Q4](#open-questions) asks when to switch.

## Quality inputs

Each record gets exactly one quality state. The state set and the coverage rules
belong to the quality-indicators work. This page supplies what each state is
derived from, and a precedence that makes the answer unique:

| State (highest precedence first) | Timing inputs that produce it |
|---|---|
| `missing` | **Exactly when `workSeconds` is `null`** on an issue that is not cancelled: reason `never_started`, `before_capture_began`, `no_worker_attempt` or `input_missing`. |
| `reconstructed` | Any contributing attempt has `provenance: reconstructed`. |
| `approximate` | Any of: a parent's `coverage.partial`; any contributing attempt `contested`; `clock_skew`; `unattributed > 0` on the elapsed axis (so `workSeconds` is a lower bound); `edge_history_incomplete`; or `sparse`, a holder-silent gap longer than **30 minutes** inside a worker attempt's working time. |
| `timing-floor` | `workSeconds < 60`. The work fits inside the write cadence the measure resolves, so the number says "quick" and little more. The record stays visible. |
| `exact` | None of the above. |

`timing.approximate` on the issue is not an input to the state of `workSeconds`,
because `workSeconds` does not read the replay. It is an input to the state of
`wall` and of any elapsed figure. `provider-unavailable` concerns budget samples,
not timing, and nothing on this page produces it.

**Why `sparse` and why 30 minutes.** This is the largest data-quality problem in
the current numbers. On a snapshot of the maintainers' tracker (300 issues, 187
leaves resolved `done`, taken 2026-09-24):

- The 187 done leaves have 345.4 hours of `activeSeconds`. **295.1 hours (85.4%)
  of it lies inside holder-silent gaps longer than 30 minutes**: stretches with
  no event and no comment by the holder, inside an active interval that later
  closed normally. Those gaps occur in only 30 of the 187 issues. One ticket
  estimated at 6 hours shows 68.5 hours, of which 67.9 are silent.
- The longest silent gap per interval (187 intervals, one per done leaf) has a
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

All figures come from a read-only snapshot of the maintainers' tracker, read
with this repository's own `timingFor` under an isolated home directory.

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
| Closing lifecycle capture gaps | The [bucket table](#the-buckets), its precedence and [every transition](#every-transition) as the reconstruction spec. `asOf` as a parameter. One mutation instant for every writer. `workSeconds` from replicated data only, as specified in [Work](#work). Re-emitting status-moving and edge events dated at the origin instant, so `wall` stops being device-local. `blockers_changed` from every edge-writing path. Pauses never counted as work, and resume opening a new interval. Terminal transitions closing every open interval. The `sparse`, `unattributed` and `edge_history_incomplete` inputs as the explicit approximation flags. The orchestrator lane and worker-lane scoping, if [Q1](#open-questions) is accepted. Agent guidance: yield or pause when a blocker appears mid-work. |
| Validating against controlled runs | Every bucket is defined in milliseconds from recorded instants, so a controlled run states its expected timeline as a list of transitions and an `asOf`, and compares the `wall` buckets, `workSeconds`, `interrupted` and `resumeGapSeconds`, and `orchestrationSeconds`. **Fixtures must control the write clock**, not just `asOf`: every instant on this page comes from `nowIso()` at write time, so a reproducible run injects the clock the store, the event writer and the attempt ledger all read. Tolerance: one second per interval for `activeSeconds`, one second per nonzero bucket for the partition, plus the one-second snapping window. `review` and `blocked` are disjoint by construction, so a run that reads the same second in both has found a bug. Runs on a second device check that `workSeconds` matches and that `wall` reads `replay_unavailable` until re-emission is built. |
| Quality indicators | The [quality inputs](#quality-inputs), the precedence, the [coverage](#missingness-for-the-new-fields) of parents and of the ratio aggregate, and the four new reason codes. |
| Calibration and forecasting | `estimateRatio` and its eligibility, `orchestrationSeconds` as a separate overhead figure, `resumeGapSeconds` per chain link. |

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
   - an orchestrator attempt's `lastActivityAt` reads the issue and all its
     descendants;
   - the orchestrator-lane read-time clauses (removed, resolved, superseded by the
     same agent's newer attempt), applied by every reader and by `writeOrphanEnds`;
   - every existing attempt rule scoped to the worker lane, in `evaluateIssue`,
     `effectivelyOpen`, `targets`, `resumeFor`, `record`, `countEffectivelyOpen`,
     the presence index and `reconstructAttempts`, as listed in
     [The orchestrator lane](#the-orchestrator-lane).

   The alternative is a registered set of orchestrator identities (a workspace
   setting) classifying attempts by agent. It needs no contract change, but it
   misfiles an orchestrator that implements a leaf, and it depends on identities
   being spelled consistently, which the data shows they are not. Without either,
   `orchestrationSeconds` is always `null`.
2. **Sparse threshold.** Default: 30 minutes of holder silence inside a worker
   attempt's working time marks it `sparse` and makes it `approximate`. Nothing is
   subtracted.
3. **Open review intervals.** `timing.reviewSeconds` ends an open review interval
   at the newest event on the issue, borrowed from the rule for active intervals.
   Review is a queue, and a queue's clock does not stop because nobody writes.
   Default: the lifecycle work changes the open review interval to end at
   `asOf`. This changes the reading for issues currently in review, and no
   closed interval.
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
    `no_worker_attempt` and `replay_unavailable` to the telemetry contract's closed
    set, and the quality inputs `sparse`, `clock_skew` and
    `edge_history_incomplete` to the quality-indicators work.
