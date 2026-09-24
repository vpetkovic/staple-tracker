# Timing semantics

What each time number staple reports means, which instants bound it, and which
single number an estimate is compared against. This page is a contract. The
quantities it names as existing are built. The ones it names as new (the `wall`
partition, `workSeconds`, `orchestrationSeconds`, the attempt `role`) are not built
yet.

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
| `timing.countedThrough` | instant | Where a leaf's open active interval stopped counting: the holder's `lastActivityAt`. | cli.md | no open active interval, or a parent |
| `timing.approximate` | quality | The event log could not be replayed, and the numbers came from `completedAt − startedAt`. | cli.md | never null |
| `claim.lastActivityAt` | instant | The newest event or comment by the holder on the issue, floored at `checkoutAt`. | continuity.md | not held |
| `claim.heldSeconds` | elapsed | `now − checkoutAt`. | continuity.md | not held |
| `claim.idleSeconds` | elapsed | `now − lastActivityAt`. Information, never a verdict. | continuity.md | not held |
| `attempt.activeSeconds` | effort | `startedAt` to `endedAt` (open: to `lastActivityAt`) minus `pausedSeconds`. | execution-telemetry.md | never null |
| `attempt.pausedSeconds` | effort | Sum of the attempt's paused intervals, clipped to the same end. | execution-telemetry.md | never null |
| `attempt.idleSeconds` | elapsed | For an effectively open attempt, `now − lastActivityAt`. | execution-telemetry.md | ended |
| `attempt.countedThrough` | instant | For an effectively open attempt, its `lastActivityAt`. | execution-telemetry.md | ended |
| **`wall`** | elapsed | The issue's elapsed span and its partition into buckets ([below](#the-elapsed-partition-of-one-issue)). | this page | never started |
| **`leadSeconds`** | elapsed | `createdAt` to `wall.startAt`. Time before any work began. Not part of `wall`. | this page | never started |
| **`workSeconds`** | effort | Agent work on the issue: the worker-role attempts' `activeSeconds`, clipped to the issue's own active intervals. Leaf: its own. Parent: the sum over direct children. `null` when cancelled. **The estimate ratio's actual.** | this page | no worker attempt |
| **`ownWorkSeconds`** | effort | The measurement behind `workSeconds`: this issue's own worker attempts, for any status including cancelled. | this page | no worker attempt |
| **`orchestrationSeconds`** | effort | Orchestrator-role attempts' `activeSeconds` on this issue, plus the sum over its children. Never part of `workSeconds`. | this page | no orchestrator attempt in the subtree |
| **`resumeGapSeconds`** | elapsed | On a `chain` link, `next.startedAt − previous.endedAt`: how long an interrupted piece of work waited to be picked up again, across whatever buckets that spans. | this page | no successor yet |
| **`estimateRatio`** | ratio | `workSeconds / subtreePlan.estimatedSeconds`, for the eligible population only ([below](#the-estimate-ratio)). | this page | ineligible |

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

`asOf` is a parameter of every derivation on this page. Surfaces pass the read
instant. Fixtures pass an explicit instant, which makes a controlled run's
expected values reproducible to the millisecond. Today `timingFor` calls
`nowIso()` itself. Taking `asOf` as an argument is part of the lifecycle work.

### The buckets

Every millisecond of `[wall.startAt, wall.endAt or wall.through)` falls into
exactly one bucket. The bucket is chosen first by the issue's status **category**
at that instant, and then, for a leaf in `active`, by attempt coverage.

| Bucket | A leaf's millisecond is here when |
|---|---|
| `work` | category `active`, and a worker-role attempt is effectively `running` and has evidence up to at least this instant (for an open attempt, before its `countedThrough`) |
| `paused` | category `active`, and the effectively open attempt is `paused` |
| `interrupted` | category `active`, no attempt is effectively open, and the issue's latest attempt ended `interrupted` or reads `orphaned` |
| `silent` | category `active`, a worker attempt is effectively `running`, and the instant is at or after its `countedThrough`. **Open issues only**, and provisional ([below](#silent-is-provisional)) |
| `unattributed` | category `active` and none of the above: no attempt covers the time and none ended interrupted. Pre-capture history, or a capture gap |
| `review` | category `review` |
| `gated` | category `gated` |
| `blocked` | category `blocked`, **or** category `unstarted`/`ready` while the issue has at least one unresolved `blocks` edge |
| `queued` | category `unstarted`/`ready` with no unresolved blocker: returned to the pool after starting (release, a status write back, `request-changes`) |
| `resolved` | category `done`/`cancelled` before a later reopen. Only a reopened issue has any |

Invariant, exact in milliseconds:

```
wall = work + paused + interrupted + silent + unattributed
     + review + gated + blocked + queued + resolved
```

Reported values are each floored to whole seconds once, so the reported sum can
fall short of `floor(wall)` by at most one second per nonzero bucket.

The first five buckets partition the leaf's time in the `active` category. For a
leaf whose history replays exactly:

```
ownActiveSeconds = work + paused + interrupted + unattributed      (ended work)
ownActiveSeconds = work + paused + interrupted + unattributed
                   up to countedThrough                            (open work)
```

`silent` is the part of the open interval that `ownActiveSeconds` does not count,
because its clock stops at `countedThrough`. The equality holds within one second
per interval, since `ownActiveSeconds` floors each interval separately.

**Why `blocked` includes dependency waits.** A blocked status is a human-cleared
flag, and dependency edges are the way this project records waiting on other
work. The maintainers' tracker shows 5 manual entries into `blocked` and 221
`blocks` edges. A `blocked` bucket that read only the status would miss almost
all real blocking. A pre-work second with an unresolved blocker cannot be worked,
because the `in_progress` guard refuses it, so it is blocked whichever way the
block was recorded. Precedence is by category: an issue in `active` that gains a
blocker stays in the `active` buckets. Checkout is refused only on entry, and the
agent's attempt is still open. [Agent guidance](#what-downstream-work-takes-from-this-page)
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

| Parent bucket | The parent's category |
|---|---|
| `active` | `active`: at least one child is active, or the parent is checked out |
| `review` | `review`: no child active, at least one in review |
| `gated` | `gated`: the parent's own gate |
| `blocked` | `blocked`: every open child blocked or gated, or a manual block |
| `queued` | `unstarted`/`ready`: open children, none active, in review or blocked |
| `resolved` | `done`/`cancelled` before a reopen |

A parent's `active` bucket is not divided by attempts. Its effort is the
children's `workSeconds` plus its own `orchestrationSeconds`, which are reported
on the effort axis. The ladder's rule that `blocked` requires every open child to
be blocked is the right rule for elapsed time: one workable child means the
subtree is not waiting.

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
| Issue born in `active`, or a non-derived status write into `active` | as checkout | attempt `openedBy: status`, `claim.scope: none`, opens at `t` |
| Holder re-claims with its attempt still open (any `sessionRef`) | none | none. `attempt_session_added` is not a boundary |
| Holder re-claims after its attempt ended | `interrupted` until `t`, `work` from `t` | new attempt at `t`, `resumesAttemptId` set |
| `checkout --steal-if-stale` | `[L, t)` is `interrupted`, `work` from `t` | old attempt ends at `L` (`endedAtSource: last_activity`). New attempt at `t` |
| `attempt_paused` | `paused` from `t` | pause starts at `t` |
| `attempt_resumed` | `work` from `t` | pause ends at `t` |
| `attempt_milestone` | none. Evidence only, it moves `lastActivityAt` | none |
| `attempt interrupt` (reported) | `interrupted` from `t` | attempt ends at `t` (`endedAtSource: mutation`) |
| Leaves `active` for `review` | `review` from `t` | attempt ends `completed` at `t` |
| Leaves `active` for `blocked` | `blocked` from `t` | attempt ends `yielded` at `t` |
| Leaves `active` for `ready`/`unstarted`, or `release` | `blocked` or `queued` from `t`, by the edges | attempt ends `yielded` at `t` |
| `release --if-stale` | `[L, t)` `interrupted`, then `blocked`/`queued` from `t` | attempt ends `interrupted` at `L` |
| Leaves `active` for `done`/`cancelled` | `wall` ends at `t` unless reopened | attempt ends at `t` |
| `gate` (parent) | parent `gated` from `t` | a checked-out parent's attempt ends `yielded`/`gated` at `t` |
| `approve` | parent re-derived at `t`, bucket by the ladder | none |
| `request-changes` | parent `queued` from `t`, children unchanged | none |
| `approve --children` | none on the parent. Released children leave the queue, which does not change their buckets | none |
| Derived flip on a parent | parent bucket changes at `t` | none, ever |
| `blockers_changed` adds an unresolved blocker, pre-work | `queued` becomes `blocked` at `t` | none |
| A blocker enters `done`/`cancelled` (its own instant `t`) | a dependent's `blocked` becomes `queued` at `t`, if that was its last unresolved blocker | none |
| A blocker is reopened | a dependent's `queued` becomes `blocked` at `t` | none |
| Reopen from `done`/`cancelled` | `[endAt, t)` becomes `resolved`. `wall.endAt` is recomputed | none |
| Attempt read as orphaned | its effective end is `endedAtBound` (= `L`), clipped to the `active` category | same end |
| Issue deleted | `wall` ends at the deletion. Excluded from every ratio | open attempts orphan (`issue_removed`) |
| A status recategorized, or `statuses remove --migrate-to` | no event exists, so the replay no longer lands on the row's status and the issue falls back to `approximate` | orphan rule, clause 2 |

Two consequences:

- **Attempt time is always clipped to the issue's own non-derived `active`
  intervals.** An attempt read as orphaned after a remote status change can have
  an `endedAtBound` after the instant the issue left `active`. Anything outside
  the category is discarded rather than counted as work.
- **Boundaries from one mutation are one instant.** The attempt ledger and the
  event writer call the clock separately (`nowIso()` in each), so one checkout
  can stamp its event and its attempt a few milliseconds apart. That would put a
  few-millisecond `unattributed` sliver at every start. Rule: an attempt boundary
  within one second of a category boundary on the same issue is snapped to the
  category boundary. The lifecycle work should also pass one mutation instant to
  every writer (the ledger already accepts `mutationAt` on open), so new data
  needs no snapping.

### Clocks

| Instant | Clock |
|---|---|
| `events.created_at`, issue `startedAt`/`completedAt`/`cancelledAt`, attempt `startedAt`/`endedAt`, transition `at`, comment `created_at` | the local clock of the device that made the mutation |
| `observedAt`, `resetsAt` on budget samples | the provider ([Clocks](execution-telemetry.md#formats)) |
| lease expiry | the sync service |

No timing number on this page mixes clocks. Provider and service instants never
bound a timing interval. An interval whose end precedes its start (a clock that
ran backwards between two writes, or two devices' clocks) counts as `0`, as the
existing replay already does. The record gets the `clock_skew` quality input when
the inversion exceeds one second.

### Multi-device

The issue replay and the attempt measures behave differently across devices,
and this is the strongest reason the ratio uses the attempt measure.

- **Issue `timing` is device-local.** It replays the local `events` table.
  [sync.md](sync.md#events-are-re-derived-never-transported) says applying a
  pulled operation re-emits the originating event. On master, `cloud/apply.ts`
  writes rows and calls no event writer. A pulled status change therefore leaves
  the receiving device with a log that does not reach the row's status, and that
  issue reads `approximate` there. Building re-emission as sync.md describes
  would not fully fix it: an event written at apply is dated by the apply, so the
  receiving device's intervals would shift by the sync delay. The lifecycle work
  either dates re-emitted status events by the operation's origin instant or
  labels issue `timing` as local to the device that wrote it.
- **Attempts converge.** Attempts and their transitions replicate with the
  originating device's instants, and an applied transition's local event is dated
  by its own `at` ([Lifecycle](execution-telemetry.md#lifecycle)). An ended
  attempt has the same `activeSeconds` and `pausedSeconds` on every device. An
  open attempt's `lastActivityAt` reads local evidence, which on a remote device
  is the replicated comments and transition events, so it can trail the origin's
  value until the attempt ends. That difference is visible as a lower
  `countedThrough`.
- **Contested attempts** ([the contested case](execution-telemetry.md#orphaned-attempts-are-closed-at-read-time))
  carry `contested: true`, and any measure that includes one is provisional until
  the claim conflict is resolved.

### Pauses are not interruptions

This follows [Lifecycle](execution-telemetry.md#lifecycle) and adds only where
the time goes.

- A **pause** keeps the attempt, the claim and the harness session. Paused time is
  its own bucket and never `work`. A paused attempt that is still open stays in
  `paused` through `asOf`, because a declared pause needs no further evidence.
  (`attempt.pausedSeconds` for an open attempt stops at `lastActivityAt`, so the
  bucket can exceed it until the attempt ends. For an ended attempt the two are
  equal.)
- An **interruption** ends the attempt. The time from its end to the next attempt
  on the issue, or to the issue leaving `active`, is `interrupted`. If the issue
  left `active` (a stale release), what follows is `queued` or `blocked`, and the
  link's `resumeGapSeconds` spans all of it.
- **Neither is idle.** `idleSeconds` (claim or attempt) is information about an
  open tenure at read time. It is never a bucket and never summed.

### Silent is provisional

`silent` exists only while an attempt is open. It is the part of its span after
the last evidence of work. It resolves one of three ways, and a read at a later
`asOf` reclassifies the same milliseconds accordingly:

1. The agent writes again. `lastActivityAt` moves, and the silence becomes `work`.
2. The attempt ends by a mutation the agent makes (`done`, `status`). The span up
   to that mutation becomes `work`, and the attempt carries the `sparse` quality
   input if the silence was long ([below](#quality-inputs)).
3. The attempt ends by inference (steal, stale release, orphan). It ends at `L`, so
   the silence becomes `interrupted`.

This is the existing rule for `countedThrough` applied to buckets: a dead
process is never billed for a weekend, and a live one is credited once it proves
it was alive.

## Effort: work and orchestration

### Work

`ownWorkSeconds` for an issue is the sum of `activeSeconds` over its
worker-role attempts as they read (effective state, orphan rule applied), each
clipped to the issue's own non-derived `active` intervals. `workSeconds` applies
the same judgement `activeSeconds` applies:

- leaf: `ownWorkSeconds`
- parent: the sum of the direct children's `workSeconds` (`null` when no child
  contributed)
- `cancelled`: `null`, whatever ran

A parent's own worker attempts (a parent checked out and worked directly) stay
in its `ownWorkSeconds` and are not added to its `workSeconds`, mirroring
`ownActiveSeconds`. [Q5](#open-questions) asks whether that should change.

Attempt coverage decides whether work is known. Before capture began, attempts
exist only if `staple attempt reconstruct` built them, with `provenance:
reconstructed`. Those carry no pauses, so their `workSeconds` equals the category
time of the reconstructed tenures. A leaf with active time and no attempts at all
has `workSeconds: null` with reason `before_capture_began`, and its category time
is `unattributed`.

### Orchestration

Orchestration is coordination: choosing and dispatching work, writing and
reading handoffs, reviewing an agent's result, merging, and moving tickets
between states on someone else's behalf. It runs alongside agent work, often on
the same issues, so it lies on the effort axis only. It is never an elapsed
bucket, because a second in which an orchestrator reviews a ticket that is in
`review` is already that ticket's `review` second.

**Attribution is an explicit, per-attempt field.** The recommendation adds
`role` to the attempt record: `worker` (the default) or `orchestrator`. It is
set on the opening write (`--role orchestrator`, MCP `role`, or `STAPLE_ROLE` in
the environment) and never changes. `workSeconds` sums worker attempts only,
`orchestrationSeconds` sums orchestrator attempts only, and no attempt is in both.

Why not an identity convention (for example "any `STAPLE_AGENT` ending in
`-orchestrator` is an orchestrator"):

- **The identities are not consistent.** The maintainers' tracker records
  orchestration and human coordination under at least `voya-orchestrator`,
  `Voya`, `voya`, `vpetkovic` and `VP`, and 181 events have no actor at
  all. A convention would need a registry, and every new spelling would count
  as agent work until someone added it.
- **The same identity does both.** `voya` checked out and implemented 5 leaves
  itself. That was work, and a name-based rule would have filed it as overhead.
  The role belongs to the tenure, not to the actor.
- **Shared identities hide it.** `claude` and the `$USER` fallback are shared by
  concurrent sessions ([Q3 of the telemetry contract](execution-telemetry.md#open-questions)).
  A name cannot say which session was coordinating.

**How an orchestrator attempt opens.** An orchestrator does not hold the claim on
the tickets it coordinates. A worker does. So the recommendation extends the
attempt contract with one opening path:

- `staple attempt open <ref> --role orchestrator` (MCP `record_attempt_event`
  with `event: open`) opens an attempt with `openedBy: "orchestrate"`,
  `claim.scope: "none"` and `role: "orchestrator"` on the issue being
  coordinated, usually the parent or epic. It changes neither the issue's status
  nor its claim.
- Orchestrator attempts are a separate lane. They are not counted in "at most one
  effectively open attempt per issue", they are not candidates for the resume
  rule, and orphan clauses 2 to 5 do not apply to them. The coordination of an
  epic continues while its children are in review. An orchestrator attempt ends
  by `staple attempt end` or `interrupt`, by its issue resolving or being
  removed, or by the same agent opening another orchestrator attempt (one open
  orchestrator attempt per agent, ended `yielded`, reason `switched`).
- Its `lastActivityAt` reads the agent's events and comments on the issue **and
  on every descendant**, because coordination is written on the children.
  Pauses, milestones and interruptions work as for any attempt.

`orchestrationSeconds` for an issue is its own orchestrator attempts' `activeSeconds`
plus its children's `orchestrationSeconds`. An orchestrator's writes that fall
outside every orchestrator attempt are not orchestration time. They are events,
with no duration. The orchestrator identity's own clock is the union of its
orchestrator attempts, and the one-open-attempt-per-agent rule means that union
is their sum.

**Why not measure orchestration from write cadence.** It can be done today with
no new write path: group an orchestrator's writes into sessions separated by more
than 15 minutes of silence. On the maintainers' tracker, `voya-orchestrator` has
148 writes over 18 days, and that method yields 33 sessions totalling 1.59 hours.
That is clearly far below the real coordination time, because coordination is
mostly reading and waiting, which leave no write. A figure that low would make
orchestration look free. Cadence is kept as an illustration only and is not a
measure.

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

The ratio is computed per **eligible issue**:

- it contributes its **own** estimate (`subtreePlan.source` is `own`), so the plan
  and the actual cover the same subtree. An issue whose plan was inherited from
  descendants is not a separate data point. Its estimated descendants are.
- it is resolved `done`. Cancelled work has `workSeconds: null`.
- its quality state is `exact` ([Quality inputs](#quality-inputs)), unless the
  consumer asks to include approximate states explicitly.

An aggregate over a set of issues is `Σ workSeconds / Σ estimatedSeconds` over the
eligible members (a ratio of sums, weighted by size), reported with `coverage:
{known, total}` over the population it was drawn from
([Propagation](execution-telemetry.md#missingness)).

Why `workSeconds` and not the alternatives:

| Candidate | Why not |
|---|---|
| `timing.activeSeconds` (today's "ran") | It is category time. It includes paused time (a provider-limit wait with the claim held), interruption gaps before a steal, and, once the agent writes again, the silence before that write. These are the non-work intervals that the attempt contract was built to separate. It is also device-local and degrades to `approximate` on a device that pulled the status change. |
| `wall.seconds` | Elapsed, not effort. It includes review, gates, blocking and queueing, which the estimate never planned for. On the maintainers' tracker, the median ratio of `completedAt − startedAt` to estimate is close to the active one, but the 90th percentile is 0.715 against 0.293. The tail is waiting, not work. |
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
| `missing` | No worker attempt and no replayable active interval. On the maintainers' tracker, 6 of 187 done leaves went to `done` without ever being `active`. |
| `reconstructed` | Any contributing attempt has `provenance: reconstructed`. |
| `approximate` | `timing.approximate` on the issue; any contributing attempt `contested`; `clock_skew`; `unattributed > 0`; or `sparse`: a holder-silent gap longer than **30 minutes** inside a worker attempt's running time. |
| `timing-floor` | `workSeconds < 60`. The work fits inside the write cadence the measure resolves, so the number says "quick" and little more. The record stays visible. |
| `exact` | None of the above. |

`provider-unavailable` concerns budget samples, not timing, and nothing on this
page produces it.

**Why `sparse` and why 30 minutes.** This is the largest data-quality problem in
the current numbers. On a snapshot of the maintainers' tracker (300 issues, 187
leaves resolved `done`, taken 2026-09-24):

- The 187 done leaves have 345.4 hours of `activeSeconds`. **295.1 hours (85.4%)
  of it lies inside holder-silent gaps longer than 30 minutes**: stretches with
  no event and no comment by the holder, inside an active interval that later
  closed normally. Those gaps occur in only 30 of the 187 issues. One ticket
  estimated at 6 hours shows 68.5 hours, of which 67.9 are silent.
- The longest silent gap per interval has a median of 10.4 minutes, a 75th
  percentile of 19.5 minutes, and a 90th percentile of 332.8 minutes. The
  distribution is bimodal, and 30 minutes falls in the empty stretch between the
  modes. Moving the threshold between 30 and 240 minutes changes the silent share
  only from 85.4% to 82.6%, so the choice is not sensitive.
- For the 124 estimated done leaves, the ratio of `activeSeconds` to estimate has
  a median of 0.097 and a 90th percentile of 0.293. Without the 18 sparse ones,
  the median is 0.089 and the 90th percentile 0.159. The sparse minority roughly
  doubles the upper tail.

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
| `activeSeconds / estimate`, estimated done leaves: p10 / p50 / p90 | 0.047 / 0.097 / 0.293 |
| The same, excluding sparse: p10 / p50 / p90 (n = 106) | 0.046 / 0.089 / 0.159 |
| `(completedAt − startedAt) / estimate`: p50 / p90 | 0.098 / 0.715 |
| Closed-interval category time, all issues: active, derived active (parents), review, gated, blocked | 351.6 h, 247.9 h, 5.3 h, 20.1 h, 32.0 h |
| Entries into `active`: checkout, non-derived status write, derived flip | 191, 10, 116 |
| Manual entries into `blocked`; `blocks` edges | 5; 221 |
| Orchestrator cadence (`voya-orchestrator`, 15-minute sessions) | 148 writes, 33 sessions, 1.59 h |

The ratios are far below 1 because estimates are recorded as human-effort plans
and agents execute faster. That is the thing being calibrated, not an error.

## What downstream work takes from this page

| Work | Takes |
|---|---|
| Closing lifecycle capture gaps | The [bucket table](#the-buckets) and [every transition](#every-transition) as the reconstruction spec. `asOf` as a parameter. One mutation instant for every writer. Clipping attempts to the category. Pauses never counted as work, and resume opening a new interval (both already true of attempts, and to be made true of the elapsed partition). Terminal transitions closing every open interval. The `sparse` and `unattributed` inputs as the explicit approximation flag. Closing or labelling the device-local issue replay. The `role` field and the orchestrator attempt path, if [Q1](#open-questions) is accepted. Agent guidance: yield or pause when a blocker appears mid-work. |
| Validating against controlled runs | Every bucket is exactly defined in milliseconds from recorded instants, so a controlled run states its expected timeline as a list of transitions and an `asOf`, and compares `wall` buckets, `workSeconds`, `interrupted` and `resumeGapSeconds`, and `orchestrationSeconds`. Tolerance: one second per interval for `activeSeconds`, one second per nonzero bucket for the partition, plus the one-second snapping window. `review` and `blocked` are disjoint by construction, so a run that reads the same second in both has found a bug. |
| Quality indicators | The [quality inputs](#quality-inputs), the precedence, the eligible population for the ratio, and `coverage` from the telemetry contract's propagation rule. |
| Calibration and forecasting | `estimateRatio` and its eligibility, `orchestrationSeconds` as a separate overhead figure, `resumeGapSeconds` per chain link. |

## Open questions

Each needs a decision. The page above is written to the recommended default.

1. **Orchestrator attribution.** Default: an explicit `role` on the attempt
   (`worker` | `orchestrator`) and a claimless orchestrator attempt path
   (`openedBy: "orchestrate"`) that is exempt from the one-open-per-issue rule, the
   resume rule and orphan clauses 2 to 5. This extends the approved attempt
   contract. The alternative is a registered set of orchestrator identities
   (a workspace setting) classifying attempts by agent. It needs no new write
   path, but it misfiles an orchestrator that implements a leaf, and it depends on
   identities being spelled consistently, which the data shows they are not.
2. **Sparse threshold.** Default: 30 minutes of holder silence inside a worker
   attempt's running time marks it `sparse` and makes it `approximate`. Nothing is
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
   unresolved `blocks` edge is `blocked`. The alternative keeps `blocked` to the
   status category and reports dependency waits inside `queued`. That would leave
   `blocked` near zero on a tracker that records blocking as edges.
