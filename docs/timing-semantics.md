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
| `timing.subtreePlan.estimatedSeconds` | plan | The effective plan: own estimate, else the sum of the children's contributions. A cancelled issue's own estimate contributes nothing, while live work beneath it still does. Certified never to count a parent's estimate and its descendants' together. Coverage over plan units is `contributingCount` of `contributingCount + unplannedCount`. | cli.md | no plan anywhere below |
| `planSummary.criticalPath.seconds` | plan | The planned path: the longest in-subtree `blockedBy` chain of plan units, every unit at its estimate, parallel branches taking the max. Also on `staple compare` / `compare_plans`. Not a forecast. | cli.md | no unit planned |
| `planSummary.remainingPath.seconds` | plan | The longest chain over the same graph, with `done` units weighing 0: what is left of the plan. It can follow a different chain from the planned path. A unit in progress weighs its full estimate. | cli.md | open units remain and none is planned |
| `timing.childrenEstimatedSeconds` | plan | Sum of direct children's own estimates. | cli.md | no child estimated |
| `attempt.estimateAtStart` | plan | A reading of `subtreePlan` at the moment the attempt opened, stored with the attempt. For a parent whose plan is built from descendants, readings taken since the rollup was certified leave out cancelled work (a cancelled issue's own estimate). Readings stored before that include it, so an older and a newer record of the same tree can differ by exactly that amount. | execution-telemetry.md | never null |
| `timing.ownActiveSeconds` | elapsed | Seconds this issue itself sat in the `active` category, summed over intervals not opened by a derived flip, with an open interval ending at `countedThrough`. | cli.md | never active |
| `timing.activeSeconds` | elapsed | The comparable form of `ownActiveSeconds`: a leaf's own, a parent's sum over direct children, `null` when cancelled. The number surfaces print as "ran". | cli.md | never active, or cancelled |
| `timing.reviewSeconds` | elapsed | Seconds in the `review` category, non-derived intervals only. An open interval ends at the newest event on the issue ([see Q3](#open-questions)). | cli.md | never in review |
| `timing.countedThrough` | instant | Where a leaf's open active interval stopped counting. Held issue: the holder's `lastActivityAt`. Unheld issue (a status write into `active` with no checkout): the newest event, comment or document revision by **any** actor on the issue. Comments and revisions count because they replicate and their events do not, so a device that read the tail stops the interval where the writer does. A comment deleted later still counts, as its event on the writer does. | cli.md, `store.ts` `timingFor` | no open active interval, or a parent |
| `timing.approximate` | quality | The event log could not be replayed, so the numbers came from the fallback: `completedAt − startedAt` for `done`, `now − startedAt` for `active` and `review`, `null` otherwise. A parent is also `approximate` when any child is (the flags are ORed up). | cli.md, `store.ts` `approximateActiveOf` | never null |
| `claim.lastActivityAt` | instant | The newest event, comment or document revision by the holder on the issue, floored at `checkoutAt`. A comment deleted later still counts. | continuity.md | not held |
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
| **`resumeGapSeconds`** | elapsed | On a `chain` link, `next.startedAt − previous.endedAt`: how long an interrupted piece of work waited to be picked up again, across whatever buckets that spans. `previous.endedAt` is the stored end when the mutation that ended the tenure wrote it; for an end inferred by a steal, a stale release or the orphan rule, it is the end [Work](#work) reads (the replicated evidence before the limits), never the orphan's `endedAtBound` or stored orphan end, which count the resuming attempt's own activity when the same agent resumed. Emitted per link in `timing.resumeGaps` and on each entry of an attempt's `chain` ([Where the numbers appear](#where-the-numbers-appear)). An inverted gap counts `0` and the link carries `clockSkew: true` when the inversion exceeds one second. | this page | no successor yet |
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
  ledger reads it on this device: the stored `endedAt` when the mutation that ended
  the tenure wrote it, and `asOf` for an effectively open attempt. An end that was
  inferred is read as [Work](#work) reads it. For a steal or a stale release that is
  the later of the stored `endedAt` and the replicated evidence before the limit,
  because the stored one is the ending device's `lastActivityOf` and can miss evidence
  that had not reached it yet. An orphan's end is its `endedAtBound` (or stored end),
  its agent's last activity, not effort's evidence before the successor: this axis is
  elapsed, and where an orphan overlaps a successor (two offline checkouts) both agents
  really held the issue, which the precedence below resolves. The successor limit is
  effort's rule against counting the same seconds twice. The chain link reads effort's
  end instead (clarification 17).
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
newest event, comment or document revision by any actor, while the attempt's
evidence limit is its own agent's last activity, so `ownActiveSeconds` can run past `c(A)` and count some of
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
   with category boundaries from the local event log, and one attempt's end with
   the start of the attempt that resumes it, which another device may have opened.
3. The `blocked` bucket compares a blocker's resolution instant with the
   dependent's own boundaries. Both are in the same local log, but once events
   are re-emitted with origin instants they can come from different devices.

An interval whose end precedes its start counts as `0`, as the existing replay
already does. That clamp breaks the exact partition invariant by the clamped
amount, so the record carries `clock_skew` and is `approximate` whenever an
inversion exceeds one second. A resumed attempt that starts more than a second
before the end of the attempt it resumes is such an inversion: the interruption
between them runs backwards, `wall` carries `clock_skew`, and the link's
`resumeGapSeconds` is a clamped `0` with `clockSkew: true`. `workSeconds` is not
affected, because each attempt is measured on the one clock that opened and
ended it.

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
  nothing, and an operation from a build that carries none narrates only a
  pristine birth (`issue_created`, for a create never edited); anything else it
  changed has no history, and the replay reads `replay_unavailable` rather than
  guess. A device that read the tail therefore replays the writer's history and
  reads the same `timing` and `wall`.
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
  attempt's own `lastActivityAt` and `countedThrough`, and the claim's, read the
  agent's events, comments and document revisions. Every kind of the agent's
  activity that replicates (attempt transitions, which are re-emitted as events,
  comments and revisions) is read from what replicated, so a device that read the
  tail reads the writer's instant once it has pulled. They differ only on a device
  that has not pulled yet, for activity that writes an event and replicates nothing
  (a field edit writes neither), and on a hydrated device, which holds no events.
  They are information about the claim, not inputs to effort.
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
  given up, and the number does not move when the stored end arrives.
  `lastActivityOf` reads the agent's document revisions as well as its events and
  comments, so revisions the **same identity** wrote from a second device, which
  the opener applies without a `doc_updated` event, are counted too.

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

Durations these surfaces print (`staple show`, `staple compare`) use days of
24 hours: `5d5h` is 125 hours, not five working days. JSON is always seconds.

**Which estimate.** The denominator is the issue's own `estimatedSeconds` at
read time, which is what every surface shows today. `attempt.estimateAtStart` is
the better calibration input once there is enough of it, because the estimate
column is overwritten in place. Each change is recorded as an `estimate_changed`
event (`from`, `to`, actor), but a read of the column shows only the latest
value, and an imported or restored workspace has no event log to replay.
[Q4](#open-questions) asks when to switch.

## Quality inputs

Each record gets exactly one quality state. This section supplies what each
state is derived from, and a precedence that makes the answer unique.
[Quality states](#quality-states) defines the state set for every record type,
the reasons each state carries, and the coverage rules.

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
`clock_skew` on a partition interval. Where there is no `wall` (the replay cannot
run, `replay_unavailable`, or the issue never started) the figure is `null` and
its state is `missing`. These inputs never reach the `workSeconds` state:
they are device-local, and a ratio that was eligible on one device and not on
another would not be a measurement.

`provider-unavailable` concerns budget records, not timing. No timing record
takes it. [Quality states](#quality-states) says which budget records do.

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

## Quality states

Every record that carries a timing or budget figure has exactly one quality
state, and the reasons that produced it. The state set is closed: `exact`,
`approximate`, `missing`, `timing-floor`, `reconstructed` and
`provider-unavailable`. Each record type takes the subset that can apply to it.
The precedence is written once (`src/core/telemetry/quality.ts`), and every
surface calls it.

| Record | Its figure | States, highest precedence first | Surfaces |
|---|---|---|---|
| An issue's work | `workSeconds` | `missing` > `reconstructed` > `approximate` > `timing-floor` > `exact`, from the [quality inputs](#quality-inputs). `null` for a cancelled issue, which owes no work | `timing.quality.work` |
| An issue's wall | `wall` | `missing` > `approximate` > `exact` | `timing.quality.wall` |
| An attempt | `effortSeconds`: its contribution to the issue's `workSeconds` (worker) or `orchestrationSeconds` (orchestrator), read with the end rules of [Work](#work) | `reconstructed` > `approximate` > `timing-floor` > `exact`. Never `missing`: an attempt always has a figure | every attempt a read or a write returns: `attempts`, `list_attempts`, `get_attempt`, `record_attempt_event`, and the `attempt` beside a claim write |
| A budget sample | `remainingPercent`, the reading as a budget | `provider-unavailable` or `missing` when null, else `approximate` > `exact` | `list_budget_samples`, `latestSample`, the sample `record_budget_sample` stored |
| A limit's current reading | `remainingPercent` | as a sample | `get_budget` |
| A window's part of a burn | `deltaPercent` | as a sample | `get_attempt` `burn.limits[].windows[]` |
| A limit's burn | `burnPercent` | as a sample | `burn.limits[]` |
| An attempt's burn | its limits taken together | as a sample | `burn` |

Each record's quality is `{state, reasons}` (the issue's two also keep
`inputs`). `reasons` lists **every** reason that holds, highest precedence
first, so the state is always the level of the first reason, and `reasons` is
empty exactly when the state is `exact`. A lower-precedence reason is kept: a
reconstructed record that is also sparse reads `["reconstructed", "sparse"]`,
and an approximate one under a minute reads `["sparse", "timing_floor"]`.

| State | Reasons it carries |
|---|---|
| `missing` | The figure's reason code: `never_started`, `no_worker_attempt`, `input_missing` (work); `replay_unavailable`, `never_started` (wall); any capture reason for a budget figure (below) |
| `reconstructed` | `reconstructed` |
| `approximate` | Work and attempts: the replicated inputs (`sparse`, `capture_gap`, `contested`, `partial`, `orphan_provisional`, `end_unbounded`, `clock_skew`). Wall: the device-local inputs, and `timing_approximate` when `timing.approximate` is set. Budget: `estimated`, `low_confidence`, `reset_not_reported` (a sample that joined no window), `stale` (a current reading older than 600 s), `lower_bound`, `partial`, `shared` and `attribution_unknown` (a burn not known to be this attempt's alone) |
| `timing-floor` | `timing_floor`: the figure is under 60 seconds ([Q7](#open-questions)) |
| `provider-unavailable` | The null budget figure's reason, when the provider does not expose the value: `not_reported_by_source`, `not_subscriber`, `sliding_window`, `limit_not_published`, `unit_not_normalizable`, `reset_not_reported` |
| `exact` | none |

**Provider-unavailable against missing.** A budget figure that is `null` is
`provider-unavailable` when no capture on this machine could have filled it:
the provider does not report the value, the account has no subscription
windows, the window has no reset instant, or the unit has no published limit.
Every other reason is a gap in capture and reads `missing`: nothing has been
ingested yet (`no_sample_yet`), no ingestion path is configured on this machine
(`source_unavailable`, which is this machine's configuration, not the
provider's), the reading went stale, the window elapsed, the attempt was opened
on another device (`not_on_this_device`) or names no account
(`no_provider_binding`).

### Cohort coverage

`staple timing quality` (MCP `timing_quality`, HTTP `GET /api/timing/quality`)
counts the states over a filtered population. Coverage always uses the
**eligible population** as its denominator:

- **Eligible** for work and wall: the leaves in the filter resolved `done`. A
  leaf is the unit that owes a measured `workSeconds`. A parent's is the sum of
  its children's, so counting both would count the same seconds twice. An open
  leaf owes no final figure yet, and a cancelled one owes none. Parents, open
  and cancelled leaves are reported apart, in `population.notEligible`.
  Milestones are plans, not work, and are never in the population.
- **Ratio population**: the issues in the filter resolved `done` with their
  own estimate (`subtreePlan.source` is `own`, above 0 seconds) and **no live
  estimated descendant**. Every estimated done leaf is in it, and so is a
  done parent whose own estimate is the only one in its subtree. A parent
  over estimated descendants is not, because they already are: no seconds
  are summed twice. `ratio.parents` says how many members are parents.
  `ratio.exact` is `Σ workSeconds / Σ estimatedSeconds` over its exact
  members, with `coverage: {known, total}` against the whole ratio
  population: the aggregate [The estimate ratio](#the-estimate-ratio) defines.
- `work.coverage[state]` and `wall.coverage[state]` are `counts[state] /
  eligible`. With nothing eligible they are `null` with `no_eligible_records`,
  never 0.

**The selection is explicit, and never moves the counts.** Every reason code
sits at the level of the state it produces (`WORK_REASON_LEVEL`: `sparse`,
`capture_gap`, `contested`, `partial`, `orphan_provisional`, `end_unbounded`
and `clock_skew` are approximate; `reconstructed` is reconstructed;
`timing_floor` is timing-floor; `never_started`, `no_worker_attempt` and
`input_missing` are missing). A record is **admitted** when its state and the
level of every reason it carries are admitted:

- `include` names the admitted states (default all). `include exact` is exact
  records only. `include exact,reconstructed` adds the reconstructed records
  with nothing approximate, missing or under a minute about them.
- `exclude` removes states. `exclude approximate` drops every record carrying an
  approximate reason, a reconstructed record that is also sparse included, even
  though its one state stays `reconstructed`. Precedence decides the state;
  the selection reads every reason.
- `excludeReasons` drops every record carrying one of the named codes, whatever
  its levels. The codes are the closed set above; any other is refused.

Dropped records leave the listing and `ratio.admitted`, and `excluded` counts
them by state and by the reasons they carried. The counts and every coverage
figure stay over the whole eligible population. Nothing is dropped by default,
so a `timing-floor` record stays listed with its state.

For calibration the default is `include exact`, which is exactly `ratio.exact`.
Reconstructed history is an opt-in cohort reported apart:
`include reconstructed` is the reconstructed records with no approximate,
missing or floor reason, and `include exact,reconstructed` is the two together.

The eligible records are listed oldest resolution first, bounded and
keyset-cursored like every telemetry list
([Bounded reads](execution-telemetry.md#bounded-reads-coverage-and-truncation)).
Filters: `kind`, `parent` (every issue beneath it) and `since` (resolved at or
after an instant, or a duration ago).

### Calibration cohorts

`staple calibrate` (MCP `calibration_cohorts`, HTTP `GET /api/calibration`)
builds cohorts from the samples calibration can trust. The rules are written
once, in `src/core/telemetry/calibration.ts`.

**Samples.** The population is the ratio population above. A member is a
sample of the `exact` set when `include exact` admits it: exactly the records
`ratio.exact` sums. The `reconstructed` set is read only when asked for
(`include reconstructed`: reconstructed records with no approximate, missing or
floor reason), and it is reported as its own set with its own cohorts.
Backfilled history and captured history are different evidence, so the two
are never pooled, and the exact set reads the same with or without the other
beside it. `timing-floor`, `approximate` and `missing` records are never
samples. They stay in every denominator and are counted, by state and reason,
under `excluded`.

**The estimate a sample divides by** is the `estimateAtStart` of the first
worker attempt on the issue itself, among those behind its `workSeconds`,
whose reading is the issue's own estimate above 0 (a reconstructed attempt
read none, so a later captured attempt's reading is used), and otherwise the
current own estimate ([Q4](#open-questions), clarification 27).
`estimate.source` says which, and `estimate.missing.atStart` says why there
was no reading: `parent` (a parent data point: its work is its children's, Q5
keeps its own attempts out of it, and a child's reading is of the child's
estimate), `no_worker_attempt`, `not_recorded` (every attempt read no
estimate, as a reconstructed one does) or `not_own` (the plan came from
descendants). A sample's
`ratio` is `workSeconds / estimate.seconds`, so it can differ from the issue's
`estimateRatio`, which divides by the current estimate.

**Dimensions.** A cohort key is the full combination of five:

| Dimension | Source | No value |
|---|---|---|
| `kind` | the issue's kind | never empty |
| `priority` | the issue's priority | never empty |
| `workType` | labels `type:<x>` | `unknown` |
| `area` | labels `area:<x>` | `unknown` |
| `model` | `harness.model` of the worker attempts behind `workSeconds`, collected by the rule that sums it: a leaf's own; for a parent, those of the children its rollup counts, so never a cancelled child's and never a non-leaf's own ([Q5](#open-questions)) | `unknown` |

The tracker has no column for work type or repository area, so both read a
label convention: the prefix is matched without case, the value is lowercased
and trimmed, and several values on one issue are joined with `+` in sorted
order. Projects were not used: a project groups work by initiative, not by the
part of the repository it touches. The workspace itself is the repository, and
its id is part of the snapshot identity. An attempt that named no model counts
as `unknown`, so work by several models, or by a named and an unnamed one,
reads their sorted join (`opus+unknown`). Every source is replicated, so a
sample has the same key on every device. The evidence set is the sixth
partition: every cohort belongs to one set and never mixes them.

**The fallback.** A key with fewer than **5** samples reads a broader class,
dropping one dimension at a time, in this order: `model`, `area`, `workType`,
`priority`, `kind`, down to the whole set (levels `full`, `without_model`,
`without_area`, `without_work_type`, `kind`, `all`). With 5 samples, the range
of the samples covers the median with probability 1 − 2 × 0.5⁵ = 93.75%, the
first n at which the range is at least a 90% distribution-free interval for it
(4 samples give 87.5%). The order drops first what is least often recorded and
most likely to change between runs of the same kind of work (the model an
agent ran on, then the two label conventions), and keeps longest what every
issue has and what most shapes its size (priority, then kind). Each cohort
reports `path`, every level tried with its sample count; `level`, `levelName`
and `class` (the key with dropped dimensions as `*`); and `fallback`: `none`,
`below_minimum`, or `below_minimum_everywhere` when not even the whole set has
5, in which case the whole set is read and the cohort carries the warning
`small_sample`. A level also stops the walk when its
[timing-floor members](#confidence-ranges) outnumber its samples and the two
together make 5: that is evidence the class's work is mostly under a minute,
and a broader class would hide it. Each `path` step counts `samples` and
`floors`. The walk is deterministic, and the class a key reads depends only on
the samples and the floors.

**Per cohort.** `samples`; `coverage: {samples, eligible, fraction,
denominator: "ratio_population"}`, where `eligible` is every population member
in the class whatever its quality; `ratio.median` (the lower median, index
`floor((n − 1) / 2)`, the quantile method of this page), `ratio.pooled`
(`Σ workSeconds / Σ estimate`) and the sample range `ratio.min`/`ratio.max`;
`workSeconds.median`, `.total`, `.min` and `.max`; `rangeConfidence`, `1 − 2 ×
0.5ⁿ`, the probability that the range covers the class's median whatever the
distribution (0.9375 at n = 5, the guarantee the minimum rests on);
`estimateSources`; `members` (up to 20 refs, oldest resolution first, with the
total); and `excluded`, the members of the class that are not samples of this
set, by state and reason. Each set also reports its own samples, coverage over
the whole population and exclusions. Uncertainty (quantiles, intervals,
bounds, the timing floor and heavy tails) sits beside `ratio` and
`workSeconds`, from the same samples: see [Confidence ranges](#confidence-ranges).

**Snapshot identity.** Every report carries `snapshot`: `{id, algorithm,
repositoryId, members, samples}`. `id` is a SHA-256 over the algorithm version
(`calibration/2`: version 1 had no floor stop in the fallback), the repository id, the selection (kinds, priorities, the
parent's id, `since` as given, the sets read), the minimum,
and every population member in id order. A sample contributes its set, its
resolution instant, its state and reasons, its dimensions, `workSeconds`, the
estimate it divided by, its source and the current estimate. Any other member
contributes what keeps it out (its state and reasons), its dimensions and its
resolution instant, and not its figure, which for an unsettled record can move
with `asOf`. So the same data gives the same id on every device, whatever order
the rows are read in and however much later, and a page or the sample listing
of it shares the id. It reads no event sequence and no operation sequence:
both are device-local. A suggestion or forecast built from a report can name
the exact data it came from by quoting `snapshot.id`. A relative `since` (`30d`) is hashed as
written, not as the instant it resolves to at the read, so reading it again
later over the same members gives the same id.

### Confidence ranges

Every cohort of `staple calibrate` carries its uncertainty, and `--for <ref>`
turns a cohort into a duration forecast for one issue. The rules are written
once, in `src/core/telemetry/calibration.ts`, and `method` in every report
states them: `quantile`, `quantiles`, `confidence`, `intervals`,
`minBoundsSamples`, `heavyTail` and `floorSeconds`.

**Quantiles.** `ratio.quantiles` and `workSeconds.quantiles` are `p10`, `p25`,
`p50`, `p75` and `p90`, each the **lower** quantile of this page: the value at
index `floor(p × (n − 1))` of the ascending samples, computed in whole percents
so no rounding moves the index. `p50` is the lower median the cohort already
published. The quartiles are the spread a heavy tail cannot move. `p10` and
`p90` are the band a plan works between. Nothing is interpolated: with
5 samples, `p75` and `p90` are both the fourth value, and the report says so
rather than inventing a figure between two observations.

**Intervals and bounds** are distribution-free: they hold for any continuous
distribution, so they need no assumption about a tail this page shows to be
heavy and bimodal. The target is **90%** (`method.confidence`). Every interval
reports `{lower, upper, ranks, confidence, reached}`: the 1-based ranks of the
two order statistics, the probability it covers what it claims, and whether
that reaches 90%. **An interval that cannot reach 90% is not widened past the
data.** It is the whole sample range, with the lower confidence it does reach.
Probabilities are published to 12 decimal places.

- `intervals.pXX` covers the class's true quantile. Ranks `r ≤ s` cover it with
  probability `P(r ≤ B ≤ s − 1)` for `B ~ Binomial(n, p)`. Of the pairs that
  hold the point estimate's rank and reach 90%, the chosen pair has the fewest
  ranks between them, then the highest confidence, then the pair most centred
  on the point, then the lowest. The choice depends on n and p only, never on
  the values. The median's interval reaches 90% from n = 5 (the range,
  0.9375, which is `rangeConfidence`). `p10` and `p90` need n ≥ 22, because the
  range covers them with probability `1 − 0.9ⁿ − 0.1ⁿ`.
- `bounds` is where **one more sample** of the class falls: `[x(k), x(n+1−k)]`
  holds it with probability `(n + 1 − 2k) / (n + 1)` when the samples and the new
  one are exchangeable. The largest k that reaches 90% is chosen. It reaches 90%
  from n = **19** (`method.minBoundsSamples`: the range of 19 holds a 20th with
  probability 18/20). Below that it is the range, with `(n − 1) / (n + 1)`: 66.7% at
  n = 5. A forecast's bounds are these, not a quantile's interval: a plan needs
  where this issue lands, not where the class median is.

**Heavy tails.** `tail` tests `ln(ratio)`, which turns a multiplicative spread
into an additive one. The test uses the **standard** median (the mean of the
two middle values at even n), for m and for the MAD, the standard median of
`|x − m|`. The lower median, the quantile method above, under-reads the MAD at
even n and made the test cry wolf there, so only the tail test departs from
it. The published quantiles stay lower quantiles. The scale is `MAD / 0.6745`,
or `1.2533 × mean |x − m|` when the MAD is 0 (at least half the samples equal).
A sample is an outlier when it sits more than `max(3.5 × scale, ln 1.05)` from
m: a modified z-score over **3.5** (Iglewicz and Hoaglin's threshold), and more
than 5% away. The 5% floor matters when the MAD is 0: thirty-nine ratios of
1.0 and three of 1.001 have an enormous z-score and no tail. The cohort is
**heavy-tailed** when at least **3** samples, and at least **5%** of them, are
outliers. It is tested from **10** samples (`tested: false` below; the
median interval and the fallback minimum are unaffected). `tail` reports
`tested`, `outliers.lower` and `.upper`, `share`, `heavy`, `fences` (the ratios
beyond which a sample is an outlier), `scale` and `fenceClippedPooled`.

Why these numbers: a seeded simulation of plain lognormal cohorts (no tail;
2 000 to 4 000 per n) flags at most about 1.2% of them at any n from 10 to 200
under this rule. With 2 outliers, or from 5 samples, the same simulation
flagged 3% to 6%. A small class has a real chance of one or two far draws, so
two is not enough; three in a class of ten or more is. The rule finds a real
tail: with 3 of 20 samples forty times the median it flags more than 90% of
cohorts, and at twenty times about 70%, because all three must clear the
fence. Those power figures assume a core with a log-spread (σ of `ln(ratio)`)
of about 0.5, the live tracker's. A wider core widens the fences with it, so
power drops: with σ 0.8, three samples forty times the median are flagged in
only about 30% of cohorts. The false-alarm rate does not depend on σ. On the maintainers' tracker (below), it flags the estimated done leaves
with their sparse records in (12 of 129 beyond the fence, 9.3%) and none once
the sparse records are out (0 of 108). Sparse records are never samples, so that
is the tail the quality rules already remove.

A heavy-tailed cohort uses robust statistics. Its quantiles and bounds are
order statistics, so they are robust already. `ratio.expected`, the figure a
forecast's expected duration uses, is `{value, method}`: the pooled ratio
(`method: "pooled"`), and for a heavy-tailed cohort the **fence-clipped pooled
ratio** (`"fence_clipped_pooled"`): `Σ clamp(ratio, fences) × estimate / Σ
estimate`, each sample's ratio held inside the fences. **No figure here is ever
a mean of the samples.** A heavy-tailed cohort's pooled ratio, the one
mean-like figure, is still published, but nothing downstream reads it. **The
clipped figure is biased low on exactly the classes it is used for**: it caps
the long runs that make the tail. A sum of expected figures along a path
inherits that bias, and the `heavy_tail` warning travels with every forecast
that carries it.

**Timing floors.** A record under 60 seconds of work (`timing-floor`, from
[Quality states](#quality-states)) is never a sample, since its figure fits
inside the write cadence. It is still evidence that the work was short. Each
cohort lists its class's floors apart in `floors: {count, share, dominated,
seconds, refs, truncated}`. A floor of the `exact` set is a captured record
whose only reason is `timing_floor`. A floor of the `reconstructed` set is a
reconstructed record whose other reasons are all `reconstructed`. An approximate
record under a minute is approximate first, and is neither. `share` is
`floors / (floors + samples)`. `dominated` is true when floors outnumber
samples **and** the two together make at least 5, the same minimum as the
fallback: one record under a minute is one record, not a class. The samples of
a class with floors leave its shortest work out, so they read long: the cohort
warns `floors_excluded`. A **floor-dominated** class warns `floor_dominated`,
and a forecast from it reads `state: "floor"` whether or not the issue has an
estimate: the work is expected under `floors.seconds` (60). It has no `seconds`
or `bounds`, with `missing.seconds: "floor_dominated"`, rather than a ratio
taken from the minority that ran longer. Its `expected` is `{seconds: 60,
ratio: null, method: "floor_bound"}`, an upper bound, so a sum along a path
counts it rather than dropping it.

**Warnings.** One closed list, in this order, on every cohort and forecast:

| Code | When |
|---|---|
| `small_sample` | fewer than 5 samples in the class read: no median interval reaches 90% |
| `bounds_below_confidence` | fewer than 19: the bounds reach less than 90% |
| `quantile_below_confidence` | a ratio quantile's interval reaches less than 90% (p10 and p90 last, from 22 samples) |
| `fallback_used` | the class read is broader than the first level the key's walk tried |
| `heavy_tail` | the tail test flags the ratio; `ratio.expected` is clipped at the fences, and reads low |
| `floor_dominated` | more timing-floor members than samples, 5 or more of the two; a forecast reads the floor |
| `floors_excluded` | some timing-floor members, not dominating; the samples read long |
| `reconstructed_only` | the set is `reconstructed`: backfilled history, not captured |
| `no_samples` | the class read has no sample at all |

**Duration forecasts.** `staple calibrate --for REF[,REF]` (MCP
`calibration_cohorts {for: [...]}`, HTTP `/api/calibration?for=`) adds
`forecasts`: one per issue asked for and per evidence set read, in the order
asked. The issue's key is read by the rules a sample's is (its kind, priority,
`type:` and `area:` labels, and the models of the worker attempts behind its
work), with one exception. **An issue nobody has started has no model to
match.** Its key reads model `*`, and its walk starts at `without_model`, so it
is never filed under the samples whose attempts named no model as if "no model"
were one (`unknown` is still what a sample reads when its attempts named
none). A caller who knows the harness pins it with `--model M` (MCP `model`,
HTTP `model=`), which sets the model of every forecast in the read. For a key
with model `*`, `without_model` is the first level tried: reading it is
`fallback: "none"`, and no `fallback_used`. The key resolves to a class as the
listing resolves it, and the forecast is the issue's own current estimate times
that class's figures:

- `seconds`: `estimate × ratio.quantiles` (p10 … p90);
- `bounds`: `estimate × ratio.bounds`, where this issue's duration falls, with the
  confidence reached;
- `expected`: `{seconds, ratio, method}`, `estimate × ratio.expected` (or the
  floor bound).

**Only `expected` adds along a path.** The expected duration of a chain is the
sum of the expected durations of its links, so `walkPlanGraph` with a weight
that reads `expected.seconds` gives the chain's expected duration. **Quantiles
and bounds do not add**: the p90 of a sum is not the sum of the p90s (it is
less, unless every link runs long together), and the sum of the links' bounds
is not a bound of the chain at any stated confidence. A path forecast that
needs a band must combine the links' distributions, not their quantiles. A
path sum also inherits the low bias of a fence-clipped `expected` on a
heavy-tailed class, and carries its warnings.

`state` is `ratio`, `floor`, `no_samples` or `no_estimate` (an issue with no
own estimate has nothing to multiply), with the reason in `missing.seconds`.
`floor` is decided first: it needs no estimate. `cohort` names the class read
(`level`, `levelName`, `class`, `path`, `fallback`, `samples`, `coverage`),
and the cohort's warnings carry over. Asking for a forecast, or pinning a
model, does not change `snapshot.id`: the forecast is computed from the data
the id names, and the issue's own inputs are in the forecast. Up to `--limit`
issues per read.

**Worked example.** Eleven `task`/`high`/`type:feature` samples: eight worked
18, 19, 20, 21, 22, 23, 24 and 25 minutes against 2 hours, and three worked
20 minutes against a 5-minute estimate (controlled run
`37-confidence-ranges`).

- Ratios, ascending: 0.150, 0.158, 0.167, 0.175, 0.183, 0.192, 0.200, 0.208,
  4.0, 4.0, 4.0. The lower quantiles at indices 1, 2, 5, 7 and 9
  (`floor(p × 10)`): p10 0.158, p25 0.167, p50 0.192, p75 0.208, p90 4.0.
- The median's interval: the point is rank 6. No pair five ranks apart
  reaches 90% (the best, ranks 3 to 8 and 4 to 9, hold 0.854). Six apart,
  ranks 3 to 9 hold `P(3 ≤ B ≤ 8) = 1914/2048 = 0.9346` for `B ~ Binomial(11, ½)`,
  so the interval is `[0.167, 4.0]`.
- The bounds: n = 11 is below 19, so the range `[0.150, 4.0]` with
  `10/12 = 0.833`, `reached: false`, and the warnings `bounds_below_confidence`
  and `quantile_below_confidence` (p10 and p90 need 22 samples).
- The tail: m is the standard median of the logs, ln 0.192 (n is odd, so it
  is the sixth). The MAD is the sixth deviation, `ln(0.192/0.167) = ln 1.15 =
  0.1398`, so the scale is `0.1398 / 0.6745 = 0.2072`. The three 4.0s sit at
  `ln(4.0/0.192) / 0.2072 = 14.7` robust deviations, far past 3.5. The fences
  are `0.192 × e^(±3.5 × 0.2072)`, 0.093 and 0.396. Three outliers, 27%:
  `heavy_tail`. The pooled ratio is `232 / 975 = 0.238`, pulled up by 60
  minutes of work against 15 minutes of estimate. Clipped, each 4.0 counts as
  0.396: `(172 + 3 × 0.396 × 5) / 975 = 0.1825`, which reads low, since three of
  eleven such tickets really did take four times their estimate.
- A forecast for an unstarted issue of the same labels estimated at 4 hours
  reads `without_model` (the same eleven samples): p50 `0.192 × 14 400 = 2 760 s`
  (46 minutes), p10 to p90 38 minutes to 16 hours, bounds
  `[2 160 s, 57 600 s]` at 83.3%, expected `0.1825 × 14 400 = 2 628 s`
  (`fence_clipped_pooled`).

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

**Quality states on a later snapshot** (taken 2026-09-25, 302 issues, 196 done
leaves eligible, 133 of them with their own estimate), read with
`staple timing quality` under an isolated home:

| Read | Work states (eligible = 196) | Reasons |
|---|---|---|
| As captured | exact 4, approximate 3, missing 189 | `no_worker_attempt` 183, `never_started` 6, `sparse` 2, `capture_gap` 1 |
| After `staple attempt reconstruct` on a copy | exact 4, approximate 2, reconstructed 184, missing 6 | `reconstructed` 184, `sparse` 33, `never_started` 6, `timing_floor` 1 |

Attempts have been captured only since the lifecycle work landed, so nearly all
history is `missing` until it is reconstructed. Reconstructed, 33 of the 196
done leaves are sparse (21 of the 133 estimated ones), the same minority the
2026-09-24 figures above found (30 of 187) on a tracker that grew by nine done
leaves. `reconstructed` outranks `approximate`, so 31 of the 33 are
`reconstructed` with `sparse` among their reasons, and `--exclude-reason sparse`
is how an analysis drops them. Over the estimated task leaves with a figure,
the admitted ratio (a ratio of sums) is 0.088 once sparse records are
excluded, and the exact aggregate covers only the 3 task leaves captured and
exact.

**Calibration on the same tracker** (a snapshot taken 2026-09-25, 302
issues, 134 in the ratio population), read with `staple calibrate` under an
isolated home:

| Read | Samples | Cohorts |
|---|---|---|
| As captured (exact only) | 5 of 134 (3.7%): four `task`/`high`, one `bug`/`high`; every one divides by its estimate at start | Two keys, 4 and 1 samples; both fall back to `all` (n = 5, ratio median 0.218, pooled 0.237) |
| After `staple attempt reconstruct` on a copy, `--include reconstructed` | exact 5 as before; reconstructed 108 of 134 (80.6%), 19 more reconstructed records excluded for `sparse` or the floor | 10 reconstructed keys: 4 read their own key (`task`/`high` n = 52, ratio median 0.081), 6 fall back (`task`/`low` to `kind` n = 84; `spike` to `all`) |

**Confidence ranges on the same tracker** (a snapshot taken 2026-09-25, 302
issues, 135 in the ratio population), read with `staple calibrate` under an
isolated home, after `staple attempt reconstruct` on a copy for the second row:

| Cohort | n | ratio p10 / p50 / p90 | median interval | bounds | warnings |
|---|---|---|---|---|---|
| exact, `task`/`high` (own key) | 5 | 0.146 / 0.179 / 0.256 | ranks 1–5, [0.146, 0.515], 93.75% | [0.146, 0.515], 66.7% | `bounds_below_confidence`, `quantile_below_confidence` |
| reconstructed, `task`/`high` (own key) | 52 | 0.042 / 0.081 / 0.142 | ranks 20–32, [0.066, 0.095], 90.2% | ranks 2–51, [0.028, 0.163], 92.5% | `reconstructed_only` |
| reconstructed, `task`/`low` → `kind` | 84 | 0.042 / 0.092 / 0.154 | ranks 34–50, [0.074, 0.099], 91.8% | [0.034, 0.184], 90.6% | `fallback_used`, `reconstructed_only` |
| reconstructed, `spike` → `all` | 108 | 0.046 / 0.089 / 0.159 | ranks 45–63, [0.081, 0.097], 91.6% | ranks 5–104, [0.034, 0.194], 90.8% | `fallback_used`, `reconstructed_only` |

No cohort on either set is heavy-tailed. The exact cohorts (n = 5 and 6) are
below the 10 samples the tail test needs, and every reconstructed cohort it
tests has no sample beyond a fence.
The tail the rule is built for is the sparse minority, which the quality rules
already keep out of every set: the same test over all 129 estimated done leaves
with a figure, sparse ones in, finds 12 beyond the fence and flags it. No done
leaf in either set is a timing floor, so no cohort lists floors. The
reconstructed `task`/`high` interval, checked by hand: the lower median of 52 is
rank `floor(51/2) + 1 = 26`. Ranks 21 to 32 hold `P(21 ≤ B ≤ 31) = 0.874` for
`B ~ Binomial(52, ½)`, below 90%, and ranks 20 to 32 hold
`P(20 ≤ B ≤ 31) = 0.9016`, the value published. Ranks 21 to 33 tie with it and
are less centred. The 20th and 32nd of the 52 sorted ratios are 0.0663 and
0.0954. An unstarted `task`/`high` issue estimated at 6 hours (model `*`, read
`without_model`, which holds the same samples here) forecasts p50 1 h 4 min
from the exact set (bounds 52 min to 3 h 5 min, 66.7%) and 29 min from the
reconstructed set (bounds 10 min to 59 min, 92.5%). The two sets disagree by a
factor of two, and that is why they are never pooled.

No label on the tracker carries `type:` or `area:`, and no captured attempt
names a model, so those three dimensions read `unknown` everywhere and never
split a cohort. Live calibration is thin: five exact samples, one class. It
grows only as attempts are captured with `--harness` and `--model` on the
checkouts.

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
| Validating against controlled runs | Every bucket is defined in milliseconds from recorded instants, so a controlled run states its expected timeline as a list of transitions and an `asOf`, and compares the `wall` buckets, `workSeconds`, `interrupted` and `resumeGapSeconds`, and `orchestrationSeconds`. **Fixtures must control the write clock**, not just `asOf`: every instant on this page comes from `nowIso()` at write time, so a reproducible run injects the clock the store, the event writer and the attempt ledger all read. Tolerance: one second per interval for `activeSeconds`, one second per nonzero bucket for the partition, plus the one-second snapping window. `review` and `blocked` are disjoint by construction, so a run that reads the same second in both has found a bug. Runs on a second device check that `workSeconds` matches everywhere, that `wall` matches on a device that read the tail, and that it reads `replay_unavailable` on one that hydrated. Built: see [Controlled runs](#controlled-runs). |
| Quality indicators | The [quality inputs](#quality-inputs), the precedence, the [coverage](#missingness-for-the-new-fields) of parents and of the ratio aggregate, and the five new reason codes. Built: see [Quality states](#quality-states). |
| Calibration and forecasting | `estimateRatio` and its eligibility, `orchestrationSeconds` as a separate overhead figure, `resumeGapSeconds` per chain link. Cohorts built: see [Calibration cohorts](#calibration-cohorts). Ranges, floors, tails and per-issue forecasts built: see [Confidence ranges](#confidence-ranges). A completion forecast along a path sums `forecasts[].expected.seconds` (a floor forecast's is its 60-second bound) as the `walkPlanGraph` weight, and carries the warnings. Quantiles and bounds do not add along a path: a band for a chain needs the links' distributions combined, not their quantiles summed. A fence-clipped `expected` reads low on a heavy-tailed class, and the sum inherits it. |

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
  "resumeGaps": [],
  "quality": {
    "work": { "state": "exact", "inputs": [], "reasons": [], "coverage": null, "missingInputs": [] },
    "wall": { "state": "exact", "inputs": [], "reasons": [] }
  },
  "missing": { "orchestrationSeconds": "no_orchestrator_attempt" }
}
```

A parent's `wall.buckets` are `active`, `review`, `gated`, `blocked`, `queued` and
`resolved`; its `quality.work.coverage` is `{known, total, partial}`, and
`missingInputs` (the contract's name for the inputs of an `input_missing` value) names the children counted in `total` whose `workSeconds` is
null. `resumeGaps` lists the issue's own worker-lane chain links, oldest by the
resuming attempt's start: each `{attemptId, resumedByAttemptId, endedAt,
resumedAt, resumeGapSeconds, clockSkew}`. An attempt resumed twice (two devices
re-claimed it offline) links to the earlier resumer. `staple attempt <id> --json`
(MCP `get_attempt`) carries the same `resumeGapSeconds` on each `chain` entry: from
that attempt's end to the start of the attempt that resumed it, `null` when
nothing has yet. `missing` holds the reason for each new field that is null. The work
state of a cancelled issue is `null`: it owes no comparable work, so it is neither
`missing` nor any other state. The wall state is `missing` whenever `wall` is
`null`, with `missing.wall`'s code as its reason; it is `null` only on a read that
skipped the effort and elapsed fields. Every attempt on these surfaces carries
`effortSeconds` and its `quality` ([Quality states](#quality-states)).

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

## Controlled runs

The downstream row above asks for runs with known durations, compared against what
staple records. They are in the repository and run in CI with the rest of the suite:

```
npm run validate:timing     # the controlled runs alone
npm test                    # the whole suite, which includes them
```

**What a run is.** A JSON file in `test/fixtures/controlled-runs/`: a `start` instant,
a list of `steps` (one store mutation each, at an offset from `start`, on a named
device), and a list of `expect` reads (an issue, an `asOf` offset, and the figures it
must read then). `test/controlled-runs/runner.ts` replays it and
`test/controlled-runs.test.ts` fails on the first figure outside tolerance, naming the
run, the device, the issue, the instant, the field, the expected value and the value
read.

**How it controls the clock.** Every recorded instant comes from `nowIso()` in
`src/core/types.ts`: the mutation scope's one instant (`Journal.mutationAt`), the event
writer, the attempt ledger, claims and the sync engine. `setClock` installs a clock
behind it, and production installs none. The runner sets it to each step's instant
before the step runs, and to the read's `asOf` before the read, and points the test
sync service's clock at the same value. Ids are a counter (`randomUUID` is replaced in
the test file), so a run writes the same ids every time, and every run is replayed twice
and must read the same figures both times. The counter counts down, so a later record
sorts first by id: a rule that orders two records of one millisecond by id rather than
by what happened first fails a run instead of passing by luck.

**What a step can be.** Each is the store method the CLI, MCP and HTTP surfaces call,
never a hand-written row:

| `do` | Store method | Fields |
|---|---|---|
| `create` | `createIssue` | `ref`, `title`, `parent`, `status`, `estimate`, `blockedBy`, `blockParentUntilDone`, `agent`, `kind`, `priority`, `labels` |
| `checkout` | `checkoutIssue` | `ref`, `agent`, `stealIfIdle` (a steal), `model` (with harness `claude_code`) |
| `estimate` | `setEstimate` (`staple estimate`) | `ref`, `agent`, `estimate` (`null` clears it) |
| `release` | `releaseIssue` | `ref`, `agent`, `ifIdle` (a stale release) |
| `status` | `updateIssue` | `ref`, `to`, `agent`, `assignee` |
| `comment` | `addComment` | `ref`, `agent`, `body`, `saveAs` (a name for the comment) |
| `document` | `putDocument` | `ref`, `agent`, `key`, `body` |
| `addStatus`, `recategorize` | `addStatus`, `recategorizeStatus` | `id`, `category`, `agent` |
| `pause`, `resume`, `milestone`, `interrupt` | `recordAttemptEvent` | `ref`, `agent`, `reason`, `label`, `role` |
| `blockedBy` | `setBlockedBy` | `ref`, `blockers`, `agent` |
| `gate`, `approve`, `requestChanges` | `gateIssue`, `approveGate`, `requestChanges` | `ref`, `owner`, `comment`, `agent` |
| `orchestrate`, `orchestrateEnd` | `openOrchestratorAttempt`, `endOrchestratorAttempt` | `ref`, `agent` |
| `sync` | the sync engine | `devices` |
| `olderBuildCreate` | the service's push route, as a build from before attempts | `ref`, `parent`, `status`, `startedAt`, `completedAt` |
| `olderBuildUpdate` | the same, an `update` of an issue or a comment at the version `a` holds | `entity`, `ref`, `payload` (a key ending in `At` is an offset) |
| `legacyEvent` | the event writer, as an older build of this device wrote its local log before attempts were captured | `ref`, `kind` (`checkout`, `release`, `status_changed`), `agent`, `eventAt`, `from`, `to` |
| `reconstruct` | `reconstructAttemptHistory` (`staple attempt reconstruct`) | none |

Every step takes `at` (an offset such as `"41m30.75s"`) and `device` (default `a`). A
step with `"refused": "conflict"` must be refused with that error code: it is a check,
and the run goes on (a refusal writes nothing). A read can also state `claim`, the
claim's `lastActivityAt` as the steal and release guards read it, or `null` when the
issue is not held; it is checked on the hydrated device too. A read can state
`quality.workReasons` and `quality.wallReasons`; `attempts`, each worker attempt's
`effortSeconds` and quality state and reasons, oldest first; and `cohort`, what
`staple timing quality --parent <ref>` reads at that instant (the eligible
population, the work counts and reasons, the ratio aggregates, what an exclusion
drops and the records listed); and `calibration`, what `staple calibrate --parent <ref>`
reads (the population, the samples per set, every cohort with its key, level, class
size and median, its ratio quantiles, median interval and bounds, its tail, expected
ratio, floors and warnings, and every sample with its estimate source and ratio; with
`for`, every forecast with its state, class, seconds, bounds, expected figure and
warnings), with the snapshot id required to be the same on every device and for both listings. Every read also checks that the work state is
`exact` exactly when it has no reason, and that the wall has a state.
Durations in `expect` are the same notation or whole seconds.

**Devices.** `a` writes. `"devices": {"tail": true}` enrolls `b` before the first step;
every read first syncs every device twice, so `b` has pulled the log, and `b` must read
everything `a` does, `wall` included, because pulled operations re-emit their events at
the origin's instant. `"hydrate": true` enrolls a fresh `c` at the last read, which
hydrates from the service's fold with no event history: it must read the same
`workSeconds`, `ownWorkSeconds`, `orchestrationSeconds`, work quality, coverage,
`resumeGaps`, attempt states and the cohort's work counts, and `wall: null` with
`replay_unavailable`, its state `missing`. Steps can run on `b`, so a run
can steal or re-claim on the other device. A read can name the devices that sync before
it (`"sync": ["b"]`), so it can read a device that has not yet pulled what another wrote. `"skew": {"b": "-2m"}` makes `b`'s clock
read two minutes behind the run's.

**Tolerance.** One second per attempt interval for `workSeconds`, `ownWorkSeconds`,
`orchestrationSeconds`, `activeSeconds`, `reviewSeconds`, `leadSeconds` and each
`resumeGapSeconds` (`intervals` in a read says how many), plus the one-second snapping
window. One second per nonzero bucket in `wall`, plus the snap. A bucket the timeline
never enters must read exactly `0`. On every read the buckets must add up to
`wall.seconds`, short by at most one second per nonzero bucket and never over, so no
second is counted in two buckets. Instants (`wall.startAt`, `wall.endAt`), reason codes,
quality states and inputs, and coverage are compared exactly.

**The runs.** Every file runs on the writer, a tail device and a hydrated device.

| Run | What it controls |
|---|---|
| `01-active` | plain active work with instants off the second; a re-claim with the attempt open is no boundary |
| `02-pause-resume` | paused is never work, resume opens a new interval, an open pause runs to `asOf` |
| `03-interruption` | a reported interruption and the holder's re-claim: `interrupted` and `resumeGapSeconds` |
| `04-steal-after-silence` | a steal ends the old tenure at its last activity; the silence becomes `interrupted` |
| `05-stale-release` | `interrupted` until a stale release, `queued` after, and a resume gap spanning both |
| `06-review` | review then done; an open review runs to `asOf` |
| `07-blocked-edge` | a blocker added mid-work, yielded, resolved by the blocker; added and removed pre-work |
| `08-review-and-blocked` | a blocker added during review is review; sent back it is blocked, then queued |
| `09-gate` | a parent gated and approved: `gated`, the ladder around it, and coverage |
| `10-orchestrator` | orchestrator attempts on a parent and a leaf beside a worker |
| `11-parent-coverage` | cancelled, never-started and open children in a parent's work and coverage |
| `12-reopen` | a reopen after done: `resolved`, and work added across it |
| `13-same-instant` | born and done in one millisecond; interrupt and re-claim, pause and resume, review in and out, each in one millisecond; three attempts opened in one millisecond, each resuming the one before |
| `14-two-device-writes` | a steal and a re-claim written on the tail device; a read mid-timeline sees the same silence on both |
| `15-manual-block-and-request-changes` | a manual block, and a gate answered with request-changes, re-gated and approved |
| `16-edges-at-creation` | a child that blocks its parent until done; an issue born blocked has lead time, not wall |
| `17-pause-then-inferred-end` | a paused attempt stolen, and one stale-released after a later comment |
| `18-status-write-without-claim` | an unheld attempt: work stops at its agent's evidence, category time at anyone's |
| `19-orchestrator-superseded` | a newer orchestrator attempt by the same agent bounds the older one's evidence |
| `20-blocker-cancel-reopen` | a blocker cancelled, reopened and done: the dependent's blocked and queued follow it |
| `21-parent-partial` | a child worked on a build from before attempts: partial coverage |
| `22-provisional` | silence read at several instants becomes work when the agent writes again; done while paused |
| `23-cross-device-same-instant` | the old holder's late comment and a steal on the other device in the same millisecond |
| `24-clock-skew` | an interruption resumed on a device whose clock is two minutes behind |
| `25-steal-misses-replicated-evidence` | a steal on a device that had not yet pulled the holder's last document revision |
| `26-open-document-revision` | a holder's document revision on an open attempt: the writer and the tail agree on where work stopped |
| `27-stale-release-misses-replicated-evidence` | a stale release on a device that had not yet pulled the holder's last revision |
| `28-contested-reclaim` | an interrupted attempt resumed on two devices by two agents while both were offline: one link, to the earlier resumer; contested until the opener settles it |
| `29-resumed-orphan` | an attempt orphaned by a recategorisation on the other device, resumed there by its own agent, read before and after its opener writes the stored end |
| `30-unattributed-after-yielded` | active time after a yielded attempt is unattributed, not the earlier interruption's |
| `31-clock-skew-threshold` | inversions of 0.9 s (not skew) and 1.1 s (skew) |
| `32-deleted-comment` | a comment deleted after it was written, and a document revision, each mark where an unheld interval counted to; a held issue's deleted comment still sets the claim's liveness and the attempt's evidence limit on every device |
| `33-steal-refused-document` | a steal on the other device refused at 20 minutes idle because the holder wrote a document revision, then allowed past the threshold |
| `34-steal-refused-deleted-comment` | the same with a comment the holder wrote and that was deleted later by a replicated deletion |
| `35-quality-states` | one record in each work state (exact, timing-floor, sparse, missing, reconstructed, reconstructed and sparse) with its reasons and its attempt's state, a cancelled issue with no state, a parent that is reconstructed, and the cohort the leaves make: the eligible denominator, the ratio aggregates, and exclusion by state and by reason |
| `37-confidence-ranges` | eleven samples of one key with three tickets that took four times a five-minute estimate: the lower quantiles, the median's order-statistic interval (ranks 3 to 9, 1914/2048), the bounds below 90% and said so, a heavy tail read with the fence-clipped expected ratio, two timing floors listed apart, a key with one sample and four floors reading its own class as floor-dominated, and forecasts for an unstarted issue (its walk starting without the model), two in the floor-dominated class (the floor, with and without an estimate) and one with no estimate, the same on every device |
| `36-calibration-cohorts` | calibration over the leaves of a parent: exact samples with models from the checkouts and labels for work type and area, a sample re-estimated after it started dividing by its estimate at start, keys of three and two samples falling back to their class without model, a lone bug falling back to the whole set, sparse, timing-floor and reconstructed records kept out of the exact set, the reconstructed set on request, and one snapshot id on every device |

**Adding one.** Write the timeline you want to check as a new file in
`test/fixtures/controlled-runs/`, with a `title` and the `covers` it exercises. Work out
every figure you `expect` from the timeline and this page, not from what the build
prints, then run `npm run validate:timing`. A figure that disagrees is either a mistake
in the expectation or a defect; the second is the point of the run.

**Defects the runs found.** Each is fixed, and the run that found it now passes.

1. **A tail device stopped an unheld interval early** (`18-status-write-without-claim`).
   An issue moved into `active` by a status write has no holder, and its open interval
   counted through the newest *event* on the issue. Comments replicate and their events
   do not, so after a bystander's comment at 25 minutes the writer read
   `activeSeconds` 1500 and a device that read the tail read 0. The clamp now reads
   comments too, as the held clamp did.
2. **An interruption resumed on a slow clock read exact** (`24-clock-skew`). A device
   whose clock ran two minutes behind re-claimed an interrupted attempt, so the
   resuming attempt started a minute before the end it resumed. The partition counted
   the overlap as work and the link's gap as `0`, and `wall` read `exact`. It now
   carries `clock_skew` (approximate), and the link carries `clockSkew: true`.
3. **A steal on the other device moved the holder's work into `interrupted`**
   (`25-steal-misses-replicated-evidence`). The holder commented at 10 minutes and
   wrote a document revision at 30; the other device stole the claim at 90. Applying a
   revision writes no event there, so its `lastActivityOf`, and the stored end, said
   10 minutes. `workSeconds` already took the later replicated evidence (50 minutes),
   but the partition and the chain link read the stored end alone: `work` 30 minutes,
   `interrupted` 80, `resumeGapSeconds` 4800 on every device. Both now read the end
   `workSeconds` reads: `work` 50, `interrupted` 60, gap 3600.
4. **A holder's document revision moved an open interval on the writer only**
   (`26-open-document-revision`, found in review). The held clamp and an open
   attempt's evidence limit read the holder's events and comments. Revisions
   replicate and their events do not, so with a comment at 10 minutes and a revision at
   30, the writer read `activeSeconds` 1800 and `work` 30 minutes while the tail read
   600 and 10. Both now read the agent's document revisions (the claim's
   `lastActivityAt`, `countedThrough` and an attempt's `lastActivityOf`).
5. **A deleted comment moved an unheld interval on the writer only**
   (`32-deleted-comment`). The writer's `comment_added` event outlives the deletion, and a
   device that read the tail holds only the deleted row, which the clamps skipped: the
   writer read `activeSeconds` 1500, the tail 600. The clamps now count a comment
   whether or not it was later deleted. (Effort's replicated evidence still skips
   deleted comments, as [Work](#work) says.)
6. **An orphan resumed on a device that was not its opener linked to nothing**
   (`29-resumed-orphan`). The resume rule read the issue after the resuming mutation had
   moved it back into `active`, where the orphan (`left_active`) reads revived, so no
   `resumesAttemptId` was stored; on the opener the stored orphan end, written at the
   start of the command, hid this. The rule now reads the issue as it stood before the
   mutation.
7. **That link measured from the resumer's own activity** (`29-resumed-orphan`). An
   orphan's `endedAtBound` and its stored end are the opener's `lastActivityOf`, which
   counts the same agent's activity after it resumed: the gap read 0 with `clockSkew`,
   and `wall` read `clock_skew`, where the agent waited 20 minutes. A chain link now
   measures from the orphan's replicated evidence before the resumer, as `workSeconds`
   does.

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
9. **`resumeGapSeconds`** was defined here for the calibration work and not emitted
   by the lifecycle work. The controlled runs compare it, so they emit it: per link
   in `timing.resumeGaps`, and on each `chain` entry. A link's `previous.endedAt` is
   the same end the elapsed partition uses: the stored `endedAt`, the corrected end of
   an inferred one (item 15), or the orphan's `endedAtBound`.
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
13. **The clamps read what replicates.** `timing.countedThrough` for an issue in
   `active` with no holder was the newest event on the issue, and the holder's clamp
   and an attempt's `lastActivityOf` the newest event or live comment. Comments and
   document revisions replicate and their events do not, and a comment's event outlives
   its deletion, so a device that read the tail stopped intervals early. Every clamp now
   reads events, comments (deleted or not) and document revisions
   ([Controlled runs](#controlled-runs), defects 1, 4 and 5).
14. **An inverted chain link is clock skew.** A resumed attempt that starts more
   than a second before the end it resumes makes `wall` `clock_skew`
   ([Clocks](#clocks); [Controlled runs](#controlled-runs), defect 2).
15. **An inferred end is corrected on both axes.** `end(A)` in the partition, and a chain
   link's `previous.endedAt`, read a steal's or a stale release's end as `workSeconds`
   does, not as stored ([Attempt coverage at an instant](#attempt-coverage-at-an-instant);
   [Controlled runs](#controlled-runs), defect 3).
16. **The resume rule reads the issue before the mutation.** Whether the latest worker
   attempt has ended `interrupted` or reads `orphaned` is judged on the issue as it stood
   before the checkout, steal or status write that opens the new attempt
   ([Controlled runs](#controlled-runs), defect 6).
17. **A chain link measures from the evidence, not the orphan bound.** For an inferred or
   orphan end, `resumeGapSeconds` and its clock-skew test read the replicated evidence
   before the resumer, as `workSeconds` does ([Controlled runs](#controlled-runs),
   defect 7).
18. **An older build's operation narrates only a pristine birth.** The Multi-device
   bullet said such an operation was narrated from the change itself, `status_changed`
   included; `reemit.ts` narrates only an unedited create, and the replay reads
   `replay_unavailable` for the rest. The page now says what is built.
19. **An orphan's end in the partition stays its agent's last activity.** Review asked
   whether `end(A)` for an orphan should read the chain link's corrected end. It should
   not: in `28-contested-reclaim` and the contested case of `cloud-timing-convergence`,
   the older agent really kept working, or kept its pause, after the other device's
   agent started. Cutting its tenure at that start would drop real elapsed time (a
   15-minute pause read as silence). The partition keeps the overlap and resolves it by
   precedence; `workSeconds` and the chain link use the successor limit
   ([Attempt coverage at an instant](#attempt-coverage-at-an-instant)).
20. **Liveness counts what replicates.** `claim.lastActivityAt`, and with it the
   `--steal-if-stale` and `release --if-stale` guards, reads the holder's document
   revisions and its comments whether or not they were deleted later, at their
   `created_at` (`33-steal-refused-document`, `34-steal-refused-deleted-comment`).
21. **A wall with no figure has a state.** `quality.wall.state` was `null` whenever
   `wall` was. Every record now has one state, so it reads `missing`, with
   `missing.wall`'s code (`replay_unavailable`, `never_started`) as its reason. It
   is `null` only on a read that skipped telemetry. The work state of a cancelled
   issue stays `null` (item 5): it has no work record at all.
22. **Coverage is over leaves; the ratio is over issues that never double count.**
   Eligible, the denominator of work and wall coverage, is the done leaves: a
   parent's work is its children's sum. The ratio population follows the
   estimate-ratio aggregate ("done and `source: own`") with one restriction: no
   live estimated descendant. A parent whose own estimate is the only one in its
   subtree is a data point; a parent over estimated children is not, because the
   children are, and summing both would count the same seconds twice.
23. **Reasons keep what precedence hides, and the selection reads them.**
   `reconstructed` outranks `approximate`, so on the maintainers' tracker 31 of
   the 33 sparse done leaves read `reconstructed`. Each state therefore lists
   every reason that holds, and excluding a state drops every record with a
   reason at that level: on a reconstructed copy of that tracker,
   `exclude approximate` admits 112 of the 133 ratio records at 0.089, where
   matching the top state alone admitted 131 at 0.428.
24. **An attempt's figure is its effort.** An attempt's quality describes
   `effortSeconds`, its contribution to `workSeconds` or `orchestrationSeconds`
   read from replicated data, not `activeSeconds`, which is tenure time read
   from this device's ledger. The two differ exactly where the readings of the
   end differ ([Work](#work)).
25. **`provider-unavailable` is decided by the reason code.** A null budget figure
   is `provider-unavailable` when its reason says the provider does not expose it,
   and `missing` otherwise; `source_unavailable` is this machine's configuration,
   so it is `missing` ([Quality states](#quality-states)).
26. **Silence of exactly thirty minutes is not sparse.** The rule is a gap
   *longer than* 30 minutes. On the maintainers' tracker one done leaf is sparse by
   a 30 min 51 s gap between a comment and a worklog revision inside its second
   attempt; the threshold is applied as written.
27. **Calibration divides by the estimate at start (Q4).** Q4 kept the current
   estimate until estimate history existed. Every estimate write now records
   `estimate_changed`, and every attempt stores `estimateAtStart`, so calibration
   switched: a sample divides by the first reading of its own estimate among the
   attempts on the issue behind its work, and otherwise by the current one, and
   says which. A parent data point divides by its current estimate.
   The per-issue `estimateRatio` still divides by the current estimate.
28. **Work type and area are label conventions.** The tracker has no column for
   either, and a new column would need a migration and a way to fill it for
   history. `type:<x>` and `area:<x>` labels are replicated already, cost
   nothing to adopt, and read `unknown` until someone does.
29. **The model of a sample is every model behind its work.** The worker attempts
   that make up `workSeconds` can name different models; the dimension is their
   sorted join, with `unknown` for an attempt that named none, so no sample is
   silently filed under one of them.
30. **A calibration snapshot is identified by content, not by sequence.** The
   event and operation sequences differ between devices, so an id built from
   them would name the same data differently on each. The id hashes the
   replicated inputs of every member instead
   ([Calibration cohorts](#calibration-cohorts)).
31. **Bounds are for one more sample, not for the median.** A confidence interval
   for the median narrows as n grows, and a plan that read it as "this ticket
   will take between" would be wrong most of the time. `bounds` is the
   prediction interval for one more sample, the question a forecast asks, and the
   quantile intervals answer the other question beside it
   ([Confidence ranges](#confidence-ranges)).
32. **Floors stop the fallback.** Version 1 walked the fallback on samples alone,
   so a key whose work was mostly under a minute fell back to a broader class and
   read that class's ratio. The walk now stops at a level where floors outnumber
   samples and the two make 5, and the snapshot algorithm is `calibration/2`.
   Nothing else changes for a class without floors.
33. **Nothing is interpolated.** The page's quantile method is the lower
   quantile, and the intervals are order statistics, so every figure a cohort
   publishes is an observed value (or an observed value times the estimate). One
   method across the codebase keeps a figure here comparable with every
   percentile above.
34. **The tail test is tuned against false alarms.** Review of the first cut
   found that two outliers from five samples, with the lower median, flagged 6% to
   16% of plain lognormal cohorts (the lower median of the deviations under-reads
   the MAD at even n). A false alarm switches the expected ratio to the clipped
   figure, which reads low along a path. The test now uses the standard median, needs
   10 samples and 3 outliers, and ignores deviations under 5%. The simulation
   behind the threshold is a test (`test/calibration-ranges.test.ts`).
35. **An unstarted issue has no model.** Its key reads `*`, not `unknown`:
   `unknown` is what a sample reads when its attempts named no harness, and a
   class of those can run very differently from the named ones. Filing a new
   issue under them read their ratio as its own. `--model` pins the model when
   the caller knows it.


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
   Calibration has switched (clarification 27); the per-issue `estimateRatio`
   has not.
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
