# Execution telemetry

What agent execution cost, recorded so a scheduler can reason about it. This page
is the contract for three new records: the **execution attempt** (one tenure of
one agent on one issue), the **limit window** (one instance of a provider usage
limit, bounded by an absolute reset instant) and the **budget sample** (one
reading of how much of that window is used). It specifies identifiers, fields,
units, timestamps, lifecycle, provenance and missingness. It was written before
any of it was built: nothing on this page exists yet. Where this page and
[semantics.md](semantics.md) or [cli.md](cli.md) disagree, those pages describe
today and this page the target.

The reason for the page is one separation. A scheduler has to make two
predictions, and they come from different data:

- **Completion latency**: how long the work will take. That comes from estimates
  and measured runtime, which staple already records ([cli.md](cli.md#estimates-vs-actuals)).
- **Provider-budget consumption**: how much of a subscription window the work
  will burn. That can only come from what the provider reports. **Runtime is
  never converted into quota.** Fourteen agents that finish fourteen
  fifteen-minute tasks in fifteen minutes can still exhaust a five-hour window in
  thirty.

This page records both kinds of fact and keeps them apart. It does not decide
anything: admission policy, reserve, forecasting and the operator panel consume
this contract and are specified elsewhere.

## What this builds on

Nothing below is redefined here. Each row is an existing contract this page
reads, and the column on the right is the whole of what it adds.

| Existing contract | Where it is specified | What this page does with it |
|---|---|---|
| Issue identity: `issues.id` (UUID), `identifier` for display | [sync.md](sync.md#identity-is-the-uuid-never-the-identifier) | An attempt names its issue by `issueId`. `identifier` is copied into read payloads for display only, never used as a key. |
| The claim: `checkout_agent`, `checkout_at`, and the derived `claim` payload (`heldBy`, `lastActivityAt`, `idleSeconds`, `scope`, `lease`) | [continuity.md](continuity.md), [sync.md](sync.md#claims-a-local-checkout-is-not-a-global-lease) | An attempt is the **history of a claim tenure**. The claim stays the only concurrency mechanism; attempts never grant or refuse anything. |
| Checkout semantics: atomic claim, idempotent re-claim by the holder, `--steal-if-stale`, `release --if-stale`, no sweeper | [semantics.md](semantics.md#atomic-checkout-and-release), [continuity.md](continuity.md) | Attempt boundaries are placed on exactly these mutations, in the same transaction. No timer, sweeper or TTL opens or closes an attempt. |
| Status categories (`active`, `review`, `blocked`, `gated`, `done`, `cancelled`, …) and derived parent flips | [semantics.md](semantics.md#categories--why-a-configurable-status-set-is-still-safe) | Attempt outcomes key off the **category** an issue leaves `active` for, never a status id. Derived flips never open an attempt: a parent that is `in_progress` only because a child is has no attempt, as it has no stopwatch. A parent that is itself checked out does. |
| Timing: `activeSeconds`, `reviewSeconds`, `countedThrough`, `approximate`, replayed from events at read time | [cli.md](cli.md#estimates-vs-actuals) | Unchanged. Attempt durations are derived the same way (clamped at `lastActivityAt`, never stored). This page does not change what `activeSeconds` means. |
| Estimates: `estimatedSeconds`, `subtreePlan`, the duration vocabulary (`90s`, `30m`, `2h`) | [cli.md](cli.md#estimates-vs-actuals) | The only estimate. An attempt records a **reading** of it at start (see [below](#the-estimate-reading)), never a second estimate. |
| Agent identity: `STAPLE_AGENT` / the `actor` on every write | [agents.md](agents.md) | The attempt's `agent`. Harness details are an optional, self-reported addition, not a new identity. |
| The events log and its `dedup_key`; events re-derived on apply, never transported | [sync.md](sync.md#events-are-re-derived-never-transported) | Every attempt transition also emits one local event, keyed from the transition id, so `events --follow` hooks keep working. |
| Idempotency keys on create | [semantics.md](semantics.md#duplicate-and-replay-guards) | Attempt-opening writes accept one; a replay returns the original attempt. |
| Sync: entity operations, the envelope, deterministic `opId`, protocol integers, "what never leaves the machine" | [sync.md](sync.md) | Attempts become synchronized entities (which needs a protocol integer). Limit windows and budget samples join the never-leaves list. |
| The actionable pickup set (`inbox`, `next_task`, the queue resolver) | [queue.md](queue.md) | Not consumed here. The scheduler ranks from that set; telemetry never decides what is actionable. |
| The error envelope and exit codes | [cli.md](cli.md#machine-readable-output) | Reused as they stand. This page adds no error code. |

## Terms

Six words, each naming one thing. The rest of the page uses them strictly.

- **Task**: an issue. The logical unit of work, with one identity for its whole
  life however many times it is worked.
- **Execution attempt**: one agent's tenure on one issue, from the moment
  staple records that agent starting work to the moment that tenure ends. An
  issue has zero or more attempts.
- **Claim**: the existing `checkout_agent`/`checkout_at` pair (and, connected,
  its lease). The mechanism that makes an attempt exclusive.
- **Harness session**: one conversation or process of an agent harness: a Claude
  Code session, a Codex thread. Harness sessions come and go inside and across
  attempts; staple only ever sees an opaque reference to one.
- **Limit window**: one instance of a provider usage limit for one account,
  ending at an absolute reset instant: "this account's five-hour limit that
  resets at 19:00Z". What the scheduling work calls a *provider session* is a
  limit window. It is **not** a harness session, and the two are never joined by
  time alone.
- **Budget sample**: one reading of a limit window's usage, with its source,
  unit, method and confidence.

## Execution attempts

### An issue has many attempts

Work on one issue can start, die at a usage limit, be resumed by a different
harness, go to review, come back with changes and be picked up again. Today the
issue row records only the latest claim and the event log records the
transitions; nothing names the tenures. An attempt does.

- An attempt belongs to exactly one issue. An issue has any number of attempts.
- An attempt belongs to exactly one agent identity. A different agent is a
  different attempt, always.
- **At most one attempt per issue is effectively open** (`running` or `paused`)
  at a time, because at most one claim is held at a time. Stored rows can
  disagree after a merge or an unobserved claim change. The
  [read-time rule](#orphaned-attempts-are-closed-at-read-time) leaves one
  effectively open attempt per issue, evaluated only from replicated rows. After
  two offline checkouts the answer is marked `contested` and is provisional
  until the claim conflict is resolved.
- Attempts exist on whatever issue was claimed. Checkout has no leaf-only rule,
  so a parent can be checked out, and that tenure is an attempt like any other.
  A parent that reads `in_progress` only because a child does has no attempt of
  its own. This is the rule timing already follows: an interval opened by a
  derived flip is never billed.

### The attempt record

```json
{
  "id": "0b6f2c1e-6d0a-4f7e-9d38-2f3b8a1c9e44",
  "issueId": "3f2b8c1a-…",
  "agent": "opus-s1",
  "state": "ended",
  "outcome": "interrupted",
  "endReason": "claim_stolen",
  "endDetection": "inferred",
  "endedBy": "sonnet-s2",
  "openedBy": "checkout",
  "resumesAttemptId": null,
  "startedAt": "2026-09-24T14:09:31.710Z",
  "endedAt": "2026-09-24T15:02:10.004Z",
  "endedAtSource": "last_activity",
  "deviceId": "d41c…",
  "claim": { "scope": "local", "fencingToken": null },
  "harness": {
    "name": "claude_code",
    "version": "2.1.281",
    "sessionRef": "9c1d4be07a51f2e3",
    "model": "claude-opus-…",
    "provenance": "self_reported"
  },
  "providerBinding": { "provider": "anthropic", "accountRef": "personal-max", "source": "machine_binding" },
  "estimateAtStart": { "estimatedSeconds": 10800, "source": "own" },
  "idempotencyKey": null,
  "provenance": "recorded",
  "missing": {}
}
```

Stored fields:

| Field | Meaning |
|---|---|
| `id` | UUID v4, minted locally by the device that opens the attempt, never reissued. The attempt's only key, on every surface and on the wire. |
| `issueId` | The issue's UUID. |
| `agent` | The actor that opened the attempt: the same string as `checkout_agent` and the event `actor`. |
| `state` | `running`, `paused` or `ended`. See [Lifecycle](#lifecycle). |
| `outcome` | `null` while open. On `ended`: `completed`, `yielded`, `failed` or `interrupted`. Reads can also show `orphaned`, which is derived and never stored ([below](#orphaned-attempts-are-closed-at-read-time)). |
| `endReason` | A reason code from the [lifecycle tables](#how-an-attempt-ends), `null` while open. One more code is written only by reconstruction: `capture_began`, on a reconstructed attempt whose tenure went on as the same agent's first recorded attempt ([History before capture](#history-before-capture)). It is `yielded`, never an interruption. |
| `endDetection` | Who knew the attempt ended. `reported`: the attempt's own agent made the ending mutation. `by_other`: a different actor made it (another agent, a human, a script calling `status` or `release` with no agent). `inferred`: staple concluded it from a later mutation, such as a steal or a stale release. `reconstructed`: backfilled from the event log. `null` while open. The `derived` value never appears in storage; it exists only on reads ([below](#orphaned-attempts-are-closed-at-read-time)). |
| `endedBy` | The actor on the ending mutation, or `null` when it had none. `status` and `release` have no holder check today, and `release` skips the ownership check entirely when no agent is given, so the actor is recorded rather than assumed. |
| `openedBy` | `checkout`, `steal`, `reclaim`, `status` or `reconstructed`. Which mutation opened it. |
| `resumesAttemptId` | The attempt this one continues after an interruption, or `null`. The link that makes an interruption boundary reconstructable. See [the resume rule](#the-resume-rule). |
| `startedAt`, `endedAt` | UTC instants, written by the device that made the mutation and carried in the attempt operation. `endedAt` is `null` while open. |
| `endedAtSource` | `mutation` (the time of the ending mutation) or `last_activity` (an inferred end, dated at the agent's last activity rather than at the moment somebody noticed). |
| `deviceId` | The sync device that opened the attempt, or `null` on an unconnected workspace. |
| `claim` | `scope` (`local`, `lease` or `none`) and the lease's `fencingToken` when `scope` is `lease`, copied at open for correlation only. It proves nothing: the service checks fencing tokens on lease renew and release, not on push. `none` means the attempt was opened by a status write with no claim. |
| `harness` | Optional and self-reported by the agent: harness `name` (a closed set: `claude_code`, `codex`, `other`), `version`, a hashed `sessionRef` ([Privacy](#privacy)) and `model`. `null` when not supplied, with a `missing` entry. Later harness sessions on the same attempt arrive as `attempt_session_added` transitions. |
| `providerBinding` | Which provider account the attempt spends from: `{provider, accountRef, source}`, where `source` is `flag` (passed explicitly) or `machine_binding` (resolved from the [source binding](#source-bindings-produce-the-account)). `null` when neither applies. The join key to limit windows. |
| `estimateAtStart` | A reading of the issue's effective plan at open. See [The estimate reading](#the-estimate-reading). |
| `idempotencyKey` | Optional retry key on the opening write, as on `new`. |
| `provenance` | `recorded` (written live by this contract) or `reconstructed` (backfilled from events; see [History](#history-before-capture)). |
| `missing` | The [missingness map](#missingness). Empty when every nullable field that should have a value has one. |

Derived at read time and **never stored**, for the reason [cli.md](cli.md#estimates-vs-actuals)
gives for `activeSeconds`: a reading frozen onto an entity is wrong the instant
it is written.

| Field | Derivation |
|---|---|
| `ordinal` | 1-based position among the issue's attempts ordered by `startedAt`, then `id`. Display only (`ABC-42 attempt 3`); never a key, never allocated, so two devices can never contest one. |
| `lastActivityAt` | For an open attempt, the newest event or comment by the **attempt's agent** on the issue, floored at `startedAt`. This is the same query the claim uses (`lastActivityOf(issueId, agent, since)`), with the attempt's agent and `startedAt` substituted for `checkout_agent` and `checkout_at`, so it is defined even for an attempt opened by a status write with no claim. For an ended one, `endedAt`. |
| `activeSeconds` | `startedAt` to `endedAt` (open: to `lastActivityAt`), minus paused intervals. Never `null`: an attempt exists only once it has started, and `0` means it ran for under a second. |
| `pausedSeconds` | Sum of paused intervals. `0` when there were none. That is a measured zero, not a missing value. |
| `countedThrough` | Where the clock stopped for an open attempt, as in timing. |
| `idleSeconds` | For an open attempt, seconds since `lastActivityAt`. It is information. It is not a verdict: staple does not declare an attempt dead on a threshold. |
| `state`, `outcome`, `endReason`, `endDetection` on read | The stored values, unless the [orphan rule](#orphaned-attempts-are-closed-at-read-time) applies. In that case they are the derived end, and `storedState` shows what the row holds. |
| `chain` | The attempts linked by `resumesAttemptId`, oldest first, so one read shows every interruption boundary of one piece of work. |
| `contested` | `true` when the [contested case](#orphaned-attempts-are-closed-at-read-time) applies to this attempt, otherwise `false`. A `contested` state is provisional. |

An attempt's `activeSeconds` and the issue's `timing.activeSeconds` measure
different things and are **not required to agree**. Timing replays status
intervals, including an active status nobody claimed. Attempts measure claim
tenures. How the two reconcile belongs to the timing-semantics work. This page
only ensures both are derivable.

### The estimate reading

`estimateAtStart` records what the issue's effective plan was when the attempt
opened: `timing.subtreePlan.estimatedSeconds` and its `source` (`own`,
`descendants`, `none`). It is a reading of the existing field at an instant,
never written back, never used as the plan and never shown as an estimate.

It exists because the estimate has no history today. `estimated_seconds` is
overwritten in place, no event records the change, and sync keeps only the
newest write of a field. Calibration needs to compare an attempt against the
estimate the agent was working to, not the one somebody set afterwards. If the
estimate-mutation work adds an event carrying the old and new value, the reading
stays anyway: an imported or restored workspace has no event log to replay.

### How an attempt opens

Every rule is a side effect of a **local** mutation that exists today, in the
same transaction, like `startedAt`. No caller writes an attempt directly, and
**applying a pulled operation never runs these side effects**. A pulled
operation applies under a suppressed journal scope, so any attempt row it
changed would change on the applying device alone and never reach the others.
Attempt state therefore arrives on other devices only as `attempt` and
`attemptTransition` operations, carrying the originating device's own
timestamps. It is never re-derived from the applied issue change, and never
dated by the local event an apply re-emits, whose `created_at` is the apply
time.

| Local mutation | Result |
|---|---|
| `checkout` succeeds and creates a new claim | A new attempt, `openedBy: "checkout"`. |
| `checkout --steal-if-stale` succeeds (`claim_stolen`) | If the previous holder has an open attempt, it ends (`interrupted`, `claim_stolen`, `inferred`, `endedAt` = the previous holder's `lastActivityAt`, `endedAtSource: "last_activity"`). Either way a new attempt opens with `openedBy: "steal"`, and [the resume rule](#the-resume-rule) sets `resumesAttemptId`. |
| The holder re-claims an issue it already holds with an open attempt (the crash-recovery path, which today returns the row and emits nothing), with the same `sessionRef` or none | Nothing. The open attempt is returned. Re-claim stays idempotent. |
| The same re-claim with a different `sessionRef` | The open attempt stays open and gains an `attempt_session_added` transition. **No interruption is inferred** (see below). |
| The holder re-claims an issue it still holds but whose latest attempt has ended (a reported interruption, or an [orphaned](#orphaned-attempts-are-closed-at-read-time) attempt) | A new attempt, `openedBy: "reclaim"`, with `resumesAttemptId` set by the resume rule. |
| A non-derived `status` write moves an issue into the `active` category without a checkout | A new attempt, `openedBy: "status"`, `claim.scope: "none"`, agent = the actor. |

A derived flip, a gate, an approval or a queue change never opens an attempt.
Every opening write accepts an optional idempotency key, and a replay returns
the original attempt.

**Why a new harness session is not an interruption.** A change of `sessionRef`
under one agent identity would mean the old session died only if every
identity ran one session at a time. It does not: the MCP setup in
[agents.md](agents.md#the-mcp-surface) names every Claude Code install
`STAPLE_AGENT=claude`, and the CLI falls back to `$USER` when no identity is set,
so two live sessions routinely share one identity. The contract records the
second session and concludes nothing. Interruptions become visible through a
per-session identity: a second session under a different name is refused by
the claim, as it is today, and has to steal. Or the resuming session reports
the old attempt's end first (`staple attempt interrupt <ref> --reason
harness_exit`) and then re-claims.

The honest limit: **most interruptions are inferred, not reported.** A harness
killed by a usage limit or a closed terminal cannot say so. The interruption
becomes visible only when someone steals the claim, releases it as stale, or the
resuming agent reports it. Until then the attempt reads `running` with a growing
`idleSeconds`, which is exactly what the claim already says about a dead holder
today.

### The resume rule

One rule, applied whenever any attempt opens on an issue by any path: **if the
issue's latest attempt (by `startedAt`, then `id`) has effectively ended
`interrupted` or `orphaned`, the new attempt's `resumesAttemptId` names it.**
The rule is evaluated by the opening device, and the value is stored, so it does
not change afterwards. If the latest attempt read `contested: true` at that
moment, the link is still written, and the `attempt_started` transition's
`detail` records `resumeBasis: "contested"`. `resumeBasis` replicates as part
of that transition record. The `contested` flag itself is derived at read time
and never replicates.
Otherwise `resumesAttemptId` is `null`. The rule covers every sequence the
individual rows would miss: a stale release followed by a fresh checkout, a
reported interruption followed by another agent's checkout, and a steal from a
holder whose attempt had already ended. An attempt that ended `completed`,
`yielded` or `failed` is never resumed. Work picked up after review, a block or
a failure is a new attempt with no link, and `ordinal` still orders it.

### How an attempt ends

The default outcome is set by the local mutation that clears or moves the claim,
keyed on the category the issue enters. `endDetection` is `reported` when the
mutation's actor is the attempt's agent and `by_other` otherwise. `endedBy`
records the actor either way.

| Mutation | `outcome` | `endReason` | `endDetection` |
|---|---|---|---|
| Leaves `active` for `review` or `done` | `completed` | `review` / `done` | `reported` / `by_other` |
| Leaves `active` for `blocked` | `yielded` | `blocked` | `reported` / `by_other` |
| Parked by a gate. The claim is cleared, and a gate can only be put on a parent, so this ends an attempt on a checked-out parent. | `yielded` | `gated` | `reported` / `by_other` |
| Leaves `active` for `cancelled` | `yielded` | `cancelled` | `reported` / `by_other` |
| Leaves `active` for `ready` or `unstarted` by a status write | `yielded` | `returned` | `reported` / `by_other` |
| `release` | `yielded` | `released` | `reported` / `by_other` |
| `release --if-stale` (`claim_released_stale`) | `interrupted` | `released_stale` | `inferred` |
| `claim_stolen` | `interrupted` | `claim_stolen` | `inferred` |
| Explicit interruption report ([below](#lifecycle)) | `interrupted` | the reported reason | `reported` / `by_other` |
| Reconstruction only: a pre-capture tenure the same agent's first recorded attempt continued ([History before capture](#history-before-capture)) | `yielded` | `capture_began` | `reconstructed` |

`failed` is never inferred. It means *the agent concluded it could not do the
work*, and only the agent can say that. It is passed as an optional `outcome`
(with a `reason`) on the claim-clearing mutation that accompanies it (`release`,
`status`), which overrides the default row. A `failed` outcome with no
claim-clearing mutation is refused with `validation`. A failed attempt that kept
the claim would be a claim nobody is working.

The claim and the attempt can briefly disagree in one direction, and it is
legal: **a claim may be held with no open attempt** after the holder reported an
interruption (for example, a harness hook that fires when the provider refuses
a request for a usage limit) and before it resumes. The read surfaces show this
as `attempts.current: null` beside a live `claim`, with `attempts.last.outcome:
"interrupted"`. The reverse, an open attempt with no claim behind it, is closed
by the mutation that cleared the claim when that mutation is one of the rows
above. When it is not, it is closed by the next rule.

### Orphaned attempts are closed at read time

A claim can be cleared or moved by a path that runs none of the side effects
above:

- **An applied remote operation.** Another device's release, steal, status
  change or lease projection moves `checkout_agent` here under a suppressed
  journal scope.
- **A merge of two offline devices**, each of which opened its own attempt on
  one issue.
- **A status recategorized** out of `active` in the vocabulary (`staple
  statuses`), which moves every issue carrying it with no event and no claim
  change per issue.
- **`statuses remove --migrate-to`**, which moves the rows as a vocabulary rename,
  not as status transitions.
- **A cloud restore or rewind**, which deletes and re-stages issue rows.
- **Hand edits and imports.**

Enumerating these as write-time hooks would leave the next unlisted path
uncovered, so the rule is derived at read time. It reads only **replicated
data**: the issue row and the attempt rows, which every device holds after
applying the same operations. It never reads the local conflict table. A
conflict record exists only on a device whose own write overlapped the incoming
one, detection is never journaled, and a device that bootstrapped after the
disagreement never detects it. A rule that switched on the conflict table would
therefore give a third device a different answer.

> An attempt whose stored `state` is `running` or `paused` is **effectively
> ended** when any of these holds:
>
> 1. its issue no longer exists (`issue_removed`);
> 2. the issue's status is not in the `active` category (`left_active`);
> 3. the issue's `checkout_agent` is non-null and is not the attempt's agent
>    (`claim_moved`). This applies to every attempt, including one with
>    `claim.scope: "none"`;
> 4. the attempt has `claim.scope` other than `none` and the issue's
>    `checkout_agent` is null (`claim_cleared`);
> 5. a later attempt on the same issue is effectively open
>    (`superseded_by_merge`). This applies to every attempt.
>
> Attempts are evaluated newest first (by `startedAt`, then `id`), so clause 5
> is well founded: of two stored-open attempts that survive clauses 1 to 4, the
> newer one stays open.

**The contested case.** Two offline checkouts of one issue leave two
stored-open attempts, with different agents and `claim.scope` other than
`none`. They also leave a conflict on the claim pair, and until a human
resolves it each device keeps its own `checkout_agent`, because the contested
field is stripped from incoming operations and from the snapshot re-read
([conflict preservation](sync.md#conflicts-are-preserved-never-resolved-silently)).
Clauses 3 and 4 would then orphan a different attempt on each device. So the
trigger is the replicated shape itself:

> When an issue has **two or more stored-open attempts with different agents and
> `claim.scope` other than `none`**, clauses 3 and 4 are not evaluated for those
> attempts. Clauses 1, 2 and 5 still are, so the newest of them stays open and
> the others read orphaned with `superseded_by_merge`. Every one of them,
> open and orphaned alike, reads `contested: true`.

Only the clauses whose input can diverge are skipped. Status is not part of the
trigger, so an issue another device moved to review or done still ends the
attempts on it through clause 2. If `status` is itself under an open conflict,
clause 2 can differ between the devices that hold the conflict. That affects
reads only, and it settles when the conflict is resolved. The contested case
ends when the attempts it covers are down to one stored-open attempt, which
happens through the stored end below.

Two offline checkouts under the **same identity** (for example `claude` on two
machines) do not trigger the contested case, because the agents do not differ.
Clause 3 cannot tell the two attempts apart either, so they fall through to
clause 5. The newest one survives, deterministically on every device. The
losing attempt's device still waits for its own claim conflict to be resolved
before it writes that attempt's end.

An effectively ended attempt reads `state: "ended"`, `outcome: "orphaned"`,
`endDetection: "derived"`, the clause's `endReason`, and `storedState` equal to
the stored value. It has `endedAt: null` with reason `end_not_observed`, and a
derived `endedAtBound` equal to its `lastActivityAt`.

**The orphan is written down once, by the device that opened it.** A
derivation is not monotonic. A status recategorized out of `active` and back
in, a restore, or a conflict resolution can make the clauses stop holding, and
a purely derived orphan would then revive as `running` with the gap counted as
active time. So the device that opened the attempt (`deviceId`, or the only
device of an unconnected workspace) journals a **stored orphan end** when all of
these hold:

- it is running a **mutating** command in that workspace: a write through the
  CLI, MCP or HTTP, or a sync. The end is journaled at the start of that
  command. Read-only surfaces never write it (`show`, `ls`, `inbox`, `events`,
  MCP `get_task` and the other read tools, HTTP `GET`), so a read never writes
  to the journal;
- on a connected workspace, its last pull reached the head of the log. Staple
  does not persist that fact today: `hasMore` is only a loop variable in the
  pull, and `sync_state` keeps a `cursor` and `last_sync_at`. So the persistence
  work records it, for example as a head-reached cursor and timestamp in
  `sync_state`. This narrows the window in which the real end is still in
  flight. It does not close it, because the other device may not have pushed
  yet. The [apply rule](#a-stored-orphan-end-never-overwrites-a-real-end) is
  the actual protection;
- it has no open conflict of its own on the issue's claim pair. After the
  conflict is resolved, the loser's device sees the winner's `checkout_agent`,
  clause 3 holds for its own attempt, and it writes that attempt's end. That is
  what ends the contested case. For this write the device evaluates all five
  clauses against its own rows, and the contested-case skip does not apply. The
  skip exists to keep reads from diverging, and a device with no open conflict
  of its own holds the settled claim.

The stored orphan end is `outcome: "interrupted"`, `endReason` set to the
clause's reason, `endDetection: "inferred"`, `endedAt` equal to the attempt's
`lastActivityAt` and `endedAtSource: "last_activity"`. It is an ordinary
`attempt.update`. From then on the stored row says `ended`, the derivation
agrees with it, and nothing can revive it.

#### A stored orphan end never overwrites a real end

A remote steal or release journals its `issue.update` and its `attempt.update`
from one scope, but push batches and pull pages are bounded, so the two can
arrive separately, and an orphan end can be written in the gap. A stored orphan
end is recognizable: `endDetection: "inferred"` with one of the orphan reasons
(`claim_moved`, `claim_cleared`, `left_active`, `superseded_by_merge`,
`issue_removed`). Any other stored end is a **real end**.

Choosing between the two is an **apply rule**, not a conflict-detection rule.
Conflict screening runs only on a device whose own write overlapped. A third
device applies both operations in log order, and so does the Worker's
per-key fold behind `/snapshot` and backups. Only a rule that every reader
of the log applies makes them all hold the same end:

> When an `attempt` operation that sets end fields is applied, an **orphan end
> never overwrites a real end** that the row already holds, and a **real end
> always overwrites an orphan end**. A **state that is not an end** (a pause or a
> resume) **never overwrites any end** the row already holds, and any end always
> overwrites it. Otherwise the ordinary rules apply.

The third clause exists because a pause is also an `attempt.update`. A holder that
paused offline while another device stole the claim sends its pause after the steal's
end in the log, and without the clause the pause reopened the attempt everywhere the
fold was read, after which the holder's own stored orphan end replaced the steal's.

The rule compares the incoming end fields (`state`, `outcome`, `endReason`,
`endDetection`, `endedBy`, `endedAt`, `endedAtSource`) with the stored ones as
one unit. So **any `attempt` operation that sets end fields carries all seven**,
never only the ones that changed. Attempts are not among the row-diff tables,
so the store writes this payload itself. When a reader drops an incoming orphan
end or a stale state under this rule, it records none of those keys in its field-write
provenance (the Worker fold's `fieldWrites`, the client's
`sync_field_writes`). Otherwise a device hydrated from that fold would inherit
provenance for a write it never took. Every reader of the log implements it: the client applier, the
Worker fold (and with it `/snapshot` hydration and backups), the tail fold and
the test service. This is the same arrangement as revision placement, where
[every reader of the log uses one rule](sync.md#conflicts-are-preserved-never-resolved-silently).
A pair of an orphan end and a real end, or of an end and a state that is not
one, is settled by this rule, in either direction and in either order of
arrival, and **records no conflict**. Conflict screening skips the end fields
for exactly those pairs. The opening device does not write a stored orphan end
while it holds an open conflict on that attempt's end. Two real ends that disagree still conflict as usual, and so
do two orphan ends that disagree.

The bounded exception is the interval before the opening device next runs a
mutating command. A revival inside that window reads as `running`, and a
device that never runs again leaves the attempt to the derivation for good.
The contested case has the same limit. If the losing device never runs again,
the contested case stays in place permanently. The newest of the attempts
survives, which is not necessarily the one whose agent holds the claim, and
every attempt in the case keeps reading `contested: true`. All of this is
visible: `storedState` shows that no end has been written. An attempt
whose stored end is `interrupted`, whether real or orphan, is resumable by
[the resume rule](#the-resume-rule).

### Lifecycle

```
            open (checkout | steal | reclaim | status)
                              │
                              ▼
   ┌──── pause ─────────  running  ◄──── resume ────┐
   │                        │  ▲                    │
   ▼                        │  └── milestone        │
 paused ────────────────────┼───────────────────────┘
   │                        │
   └──── end ──────►  ended (completed | yielded | failed | interrupted)
                              │
                              └── if interrupted (or read as orphaned),
                                  the next attempt names it in resumesAttemptId
```

Transitions, each stored as one immutable **attempt transition** record and
each emitting one local event of the same name:

| Transition | From → to | Written by | Carries |
|---|---|---|---|
| `attempt_started` | none → `running` | the opening mutation | `openedBy`, `resumesAttemptId`, concurrency |
| `attempt_milestone` | `running` → `running` | the holder | `label` (one line), optional `commentId` and/or `document: {key, revision}` pointing at the checkpoint it summarizes |
| `attempt_paused` | `running` → `paused` | the holder | `reason`: `checkpoint_before_reset`, `awaiting_reset`, `awaiting_input`, `operator`, `other` |
| `attempt_resumed` | `paused` → `running` | the holder | `reason`, optional |
| `attempt_interrupted` | `running`/`paused` → `ended` | a report (`staple attempt interrupt`) or an inferring mutation | `reason`. A report may give only `provider_limit`, `harness_exit`, `operator_stop` or `unknown`. `claim_stolen` and `released_stale` are written only by the mutations they name, and a report that gives one is refused with `validation`. The orphan reasons are written only by the [stored orphan end](#orphaned-attempts-are-closed-at-read-time). |
| `attempt_session_added` | `running`/`paused` → unchanged | a re-claim by the same agent from a different harness session | the new `sessionRef`. Not an interruption: see [How an attempt opens](#how-an-attempt-opens) |
| `attempt_ended` | `running`/`paused` → `ended` | the claim-clearing mutation | `outcome`, `endReason` |

**Pause and interruption are different on purpose.** A pause is planned, keeps
the claim and the harness session, and resumes the same attempt: paused time is
not attempt active time. An interruption is the end of a tenure. Whatever
continues the work afterwards is a new attempt with `resumesAttemptId`, because
it may be another harness, another agent, another device or a later limit
window, and each of those is a fact a scheduler has to be able to see. This is
what lets the lifecycle reconstruct interruption boundaries: every boundary is
an `ended`/`interrupted` attempt followed by one that names it.

A milestone does not duplicate the checkpoint text. The worklog stays a
revisioned document and the progress note stays a comment. The transition
points at them, so "resume reads the latest checkpoint" is one lookup.

Transition record:

```json
{
  "id": "c7e1…",
  "attemptId": "0b6f2c1e-…",
  "kind": "attempt_paused",
  "at": "2026-09-24T14:51:00.000Z",
  "actor": "opus-s1",
  "detection": "reported",
  "reason": "checkpoint_before_reset",
  "detail": { },
  "concurrency": { "…": "see below" }
}
```

Transitions are ordered by `at`, then `id`. They carry no per-attempt counter,
for the same reason `ordinal` is derived: a counter two devices can both
allocate is a counter they will both allocate. The local event is emitted with
an explicit content key in the shape `ids.ts` uses for its level-triggered keys,
`<kind>:<entityId>:<count>:<32 hex>`:
`attempt_transition:<attemptId>:1:<32 hex of sha256(transition id)>`. The
count is always the literal `1`, because exactly one id is hashed. It is never a
counter. Because
the key is derived from the transition id, re-applying a pulled transition
re-derives the same key and cannot duplicate the timeline.

### Concurrency context

Every transition records what else was running when it happened, because a
burn rate means nothing without the number of agents producing it:

```json
"concurrency": {
  "observedAt": "2026-09-24T14:51:00.000Z",
  "scope": "device",
  "openAttemptsInWorkspace": 3,
  "storedOpenAttemptsStartedHere": 5,
  "storedOpenAttemptsOnAccountStartedHere": 4,
  "workspaceSyncedThrough": "2026-09-24T14:50:12.000Z",
  "missing": {}
}
```

| Field | Meaning |
|---|---|
| `scope` | Always `device` in this contract. The counts are what this machine's databases know, and no field claims otherwise. |
| `openAttemptsInWorkspace` | Effectively open attempts in this workspace database, including any pulled from other devices. |
| `storedOpenAttemptsStartedHere` | **Approximate.** Attempts opened on this machine that the presence index (below) holds as open, across the reachable workspaces in the hub registry. Pulled attempts are excluded, because they run elsewhere. The index stores open/ended. It cannot evaluate the [orphan rule](#orphaned-attempts-are-closed-at-read-time), so it can over-count until its next refresh. |
| `storedOpenAttemptsOnAccountStartedHere` | The subset of the previous count whose `providerBinding` names the same account as this attempt. `null` with reason `no_provider_binding` when this attempt has none. Approximate in the same way. |
| `workspaceSyncedThrough` | The workspace's `last_sync_at`, or `null` with reason `not_connected`. How stale the "other devices" part of the first count may be. |

**How the machine-wide counts stay cheap.** Computing them by opening every
registered workspace database on every transition would make one transition
cost as much as the number of repositories. Instead, `hub.db` keeps a
machine-local **presence index**: one row per attempt opened on this machine
(`workspaceId`, `attemptId`, `accountRef`, `startedAt`, `endedAt`). That makes
both counts one indexed query on one file. The index is a cache, and its rules
reflect that:

- It is written **after** the workspace transaction commits, as a best-effort
  step outside the journal seam. [Sync obligation 7](sync.md#the-journal-seam-and-what-it-owes)
  keeps hub writes away from the seam, and a hub write cannot be atomic with a
  workspace transaction anyway. A failed or skipped write loses no telemetry:
  the workspace rows are the record.
- It is updated from **every** change to an attempt this machine opened,
  including a pulled `attempt.update` that ended one and a stored orphan end.
  Hub state is machine state and is not journaled, so applying an operation may
  write to it.
- Rows for workspaces that are unregistered, moved, or whose database cannot be
  opened are excluded from the counts. Any command in a workspace can refresh
  that workspace's rows, and a full rebuild reads every reachable workspace.
- Because it stores ended/open and not the derived orphan state, the counts are
  **approximate and can be too high**. The field names say `storedOpen` for that
  reason.

Agents on another machine against the same subscription, and interactive or
headless sessions that never touch staple, are invisible here. Their usage
still shows up in the account's percentages. The counts therefore neither bound
the account's real concurrency from below nor from above. They describe what
this machine started through staple, approximately.

### History before capture

Attempts can be **reconstructed** for work done before this contract ships,
from the events that already exist: `checkout` opens, `claim_stolen` interrupts
and reopens, `release` / `claim_released_stale` / a `status_changed` out of the
active category end. A reconstructed attempt carries `provenance:
"reconstructed"`, `openedBy: "reconstructed"`, `endDetection: "reconstructed"`,
`harness: null` and `providerBinding: null`, each with a `before_capture_began`
reason in `missing`. Crash-recovery re-claims left no event, so a reconstructed
history under-counts interruptions and says so. Analytics exclude reconstructed
attempts from trusted samples unless asked, as they exclude `approximate`
timing.

Reconstruction is a command (`staple attempt reconstruct`), because reconstructed
attempts replicate and a migration never journals. It is idempotent: an attempt's
id is derived from its issue and the event that opened it. It reads an issue's
events up to its **first recorded attempt**, where capture began, and writes no
transitions. A tenure still open at that point is ended by the rule that fits:

- **The first recorded attempt is a steal.** The tenure was interrupted:
  `interrupted` / `claim_stolen`, dated at the holder's last activity as the
  steal's own event recorded it. The recorded steal keeps the `resumesAttemptId`
  its device stored when it opened (the resume rule saw no attempt then, and a
  stored value never changes), so this boundary reads by adjacency, not by link.
- **The first recorded attempt is the same agent's re-claim.** The tenure went on
  as that attempt. It ends at the boundary as `yielded` / `capture_began`, a
  reason only reconstruction writes. It is never read as an interruption, and no
  later orphan rule sees the two as a merge.
- **Anything else, or no recorded attempt at all.** The claim was cleared or moved
  by an operation another device made, which re-emits no event locally, so the
  issue's replicated row decides. Done and cancelled end at `completed_at` and
  `cancelled_at`. Any other category ends by the ending table at the row's
  `updated_at`, an upper bound, so a claim cleared by a remote release reads as
  `yielded` / `returned`, the label a status write back to ready also gets. A
  claim now held by another agent reads as `yielded` / `released`, dated at that
  agent's `checkout_at`: the row cannot tell a release followed by a checkout
  from a steal, and reconstruction never claims an interruption it has no event
  for, so a remote steal is recorded as a release. A tenure the row shows still
  held by its agent stays open.

## Limit windows

### A reset is an absolute instant

Every reset is stored as a UTC instant, never as a duration. "Resets in 3h" is
converted at capture time, `capturedAt + 3h`, and marked as converted. The
reason is that a relative value is only true at the instant it was read. Stored
as-is, it becomes wrong as soon as it is read again.

```json
{
  "id": "e0a4…",
  "provider": "openai",
  "accountRef": "codex-plus",
  "limitKey": "codex.primary",
  "label": "5h",
  "windowSeconds": 18000,
  "windowSecondsSource": "observed",
  "anchor": "unknown",
  "resetsAt": "2026-09-24T19:04:29.000Z",
  "resetsAtSource": "observed_absolute",
  "startsAt": "2026-09-24T14:04:29.000Z",
  "firstSampleAt": "2026-09-24T14:10:02.114Z",
  "lastSampleAt": "2026-09-24T14:51:00.310Z",
  "planTier": "plus",
  "supersededBy": null,
  "missing": {}
}
```

| Field | Meaning |
|---|---|
| `id` | UUID v4, minted when the first sample of a new window instance is ingested. |
| `provider` | `anthropic`, `openai`, or another lowercase provider slug. |
| `accountRef` | The operator's label for the account ([Privacy](#privacy)). |
| `limitKey` | The provider's own name for the limit, lowercased and dotted: `five_hour`, `seven_day`, `spend_limit` from Claude Code. `<limit_id>.primary` and `<limit_id>.secondary` from Codex. Positional Codex keys are **not** renamed to `five_hour` by assumption. The window length is its own field. |
| `label` | A display string derived from `windowSeconds` when known (`5h`, `7d`). Never a key. |
| `windowSeconds` | The window's length. `windowSecondsSource`: `observed` (the provider reported it, as Codex's `window_minutes` does) or `documented` (taken from the provider's published description, lower confidence). `null` with a reason when neither exists. |
| `anchor` | How the provider places the window: `first_use` (starts at first activity after the previous reset), `fixed_schedule`, `sliding` or `unknown`. **`unknown` unless the source states it.** Neither verified surface states it today. |
| `resetsAt` | UTC instant. `resetsAtSource`: `observed_absolute` (the provider gave an instant) or `derived_from_relative` (the provider gave a duration and staple added it to the capture instant; precision is the source's rounding). |
| `startsAt` | `resetsAt − windowSeconds` **only when** `windowSeconds` is `observed`. Otherwise `null` with reason `not_reported_by_source`. |
| `firstSampleAt`, `lastSampleAt` | Derived bounds of what was actually observed. `lastSampleAt` is part of the staleness test. |
| `planTier` | The provider's plan name when the source reports one (Codex `plan_type`), otherwise `null` with reason `not_reported_by_source` (Claude Code reports none). Optional. Explains a limit and identifies nobody ([Privacy](#privacy)). |
| `supersededBy` | Stored. The id of the window instance that replaced this one before it reset (below), otherwise `null`. Windows are machine-local rows, so this one mutable field is safe to write in place. |

Derived at read: `status`. It is `superseded` when `supersededBy` is set, otherwise
`current` (`now < resetsAt`) or `elapsed` (`now ≥ resetsAt`). "Superseded" is
stored exactly once, as `supersededBy`. `status` only reads it.

### Fixed, first-use and sliding windows

- A **fixed or first-use** window has one reset instant. Both are represented
  the same way, a `resetsAt`, and differ only in `anchor`. The scheduler needs
  the reset. It needs the anchor only to predict the *next* window's reset, and
  it must treat `unknown` as "the next reset cannot be predicted until the
  first sample after this one".
- A **sliding** window (usage ages out continuously, with no single reset) has
  `resetsAt: null` with reason `sliding_window`. Neither verified provider
  surface reports one today. The encoding exists so that a source which does
  will not be forced into a fake reset.

### Window identity

Samples join an existing window instance when `provider`, `accountRef` and
`limitKey` match and `|resetsAt − window.resetsAt| ≤ tolerance`. The default
tolerance is 120 seconds, to absorb a provider that recomputes or rounds its reset
between readings. The largest jitter seen in recorded samples so far is 17
seconds, and the ingestion work keeps checking the figure against new samples.
Otherwise:

- A sample whose `resetsAt` is later than a window that has elapsed opens the
  next window instance.
- A sample whose `resetsAt` differs beyond tolerance from a window that is still
  current (a provider-side reset, a changed plan) opens a new instance and sets
  the old one's `supersededBy`, with reason `reset_moved`. Staple does not decide
  which reading was right. It keeps both.
- A sample with **no `resetsAt`** (older Codex builds, below) joins no window. It
  is stored with `windowId: null` and reason `reset_not_reported`, is usable as
  historical evidence of usage and window length, and never feeds a current
  reading.

## Budget samples

### What providers actually expose

The contract only uses fields someone has seen. The table below lists what was
checked when this page was written and how. Confidence refers to the
*surface's stability*, not to whether the numbers are accurate: staple has no
means of auditing a provider's arithmetic.

| Provider surface | What it reports | How verified | Confidence |
|---|---|---|---|
| **Claude Code status line input** (JSON on the configured `statusLine` command's stdin) | `rate_limits.five_hour`, `rate_limits.seven_day` and, behind a gateway, `rate_limits.spend_limit`, each `{used_percentage (0–100; spend_limit may exceed 100), resets_at (Unix epoch seconds)}`. Documented as present only for subscribers, only after the first API response, and each window only while its reset has not passed. No window length, no plan tier, no account, no observation timestamp. Values carry one decimal place. | The schema text bundled in Claude Code 2.1.281 | High for that version's shape. Medium across versions. See [the status-line caveats](#status-line-readings-are-cached-re-reads). |
| Claude Code `/usage` | Session and weekly percentages and reset times, including per-model weekly limits | Interactive screen only | Not a machine source. An operator may type a reading in (`operator_manual`). |
| Anthropic `anthropic-ratelimit-unified-*` response headers (`5h-utilization`, `5h-reset`, `7d-…`) | Utilization and reset per window | Header names appear in the Claude Code 2.1.281 binary. Undocumented. | Low. Staple never sees these responses and never makes the request. A harness could forward them as a source. |
| Codex CLI rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `event_msg` lines with `payload.type = "token_count"`) | `payload.rate_limits.limit_id`, `primary` and `secondary` each `{used_percent, window_minutes, resets_at (Unix epoch seconds)}`, `plan_type`, `credits`. The line's own `timestamp` is ISO-8601 UTC. Observed windows: 300 and 10080 minutes. A second limit id (`premium`) was observed with `primary: null, secondary: null`. Older builds (lines from a 0.45 alpha on the same machine) write `limit_id: null`, `resets_at: null` and windows of 299 and 10079 minutes. **No file on the machine carries a relative `resets_in_seconds`**, so this contract has no relative-reset source today. Values are whole numbers. | codex-cli 0.156.1 files, and every older rollout on the author's machine | Medium. The file format is undocumented. See [Codex rollout rules](#codex-rollout-rules) for forks and old lines. |
| Codex `/status` | Same percentages, interactive | Interactive screen only | `operator_manual` only |
| Token counts in harness transcripts (Claude Code session transcripts, Codex `info.total_token_usage`) | Tokens per request or per session | Present in the files | High as token counts. **Not normalizable**: neither provider publishes a subscription limit in tokens. |
| Provider usage endpoints reached with the user's OAuth credential | Used by some community tools | Not examined | **Excluded.** They need the credential ([Privacy](#privacy)) and a network call (the [zero-network rule](sync.md#two-invariants-the-rest-of-the-page-serves)). |

API-key usage without a subscription has request and token rate limits, not
subscription windows. It is out of scope, and an account that has only those
reports `not_subscriber`.

### The sample record

```json
{
  "id": "5d2a…",
  "windowId": "e0a4…",
  "provider": "openai",
  "accountRef": "codex-plus",
  "limitKey": "codex.primary",
  "unit": "percent_of_limit",
  "usedPercent": 6.0,
  "remainingPercent": 94.0,
  "exceeded": false,
  "resetsAt": "2026-09-24T19:04:29.000Z",
  "method": "observed",
  "confidence": "medium",
  "source": {
    "kind": "codex_rollout",
    "harnessVersion": "0.156.1",
    "field": "payload.rate_limits.primary"
  },
  "observedAt": "2026-09-24T14:51:00.310Z",
  "observedAtSource": "provider",
  "recordedAt": "2026-09-24T14:51:01.002Z",
  "attemptId": "0b6f2c1e-…",
  "sessionRef": "4be07a51f2e39c1d",
  "heartbeat": false,
  "dedupKey": "9f0e…",
  "missing": {}
}
```

### Units

`unit` names what the number counts, and only one unit normalizes:

| `unit` | Normalizes to `remainingPercent` | Example |
|---|---|---|
| `percent_of_limit` | Yes | Claude `used_percentage`, Codex `used_percent` |
| `tokens` | No: `limit_not_published` | Transcript token totals |
| `usd` | Only when the source also reports the limit in `usd` | A gateway spend limit reported in currency |
| `requests` | No: `limit_not_published` | Request counts |

Normalization is arithmetic on the reported value and nothing else:
`remainingPercent = max(0, 100 − usedPercent)`, `exceeded = usedPercent ≥ 100`.
`usedPercent` is always kept as reported, including values above 100 and
fractional values. It is never rounded. Resolution differs by source: Claude Code
values carry one decimal place, and Codex values have all been whole numbers,
so a Codex burn below one percent between two samples cannot be measured. The
contract stores what arrives and assumes no resolution. Forecasting has to
allow for the quantization of each source.

There is no conversion between units. In particular, **no sample ever converts
runtime or tokens into a percentage**. That conversion is the error this contract
exists to correct.

### Provenance

Every sample says where its number came from:

| Field | Values | Meaning |
|---|---|---|
| `method` | `observed` | The provider reported the value and staple read it verbatim. |
| | `estimated` | A tool computed it from local evidence (for example, tokens against an assumed limit). Stored for comparison, never used as a measurement. |
| `source.kind` | `claude_code_statusline`, `codex_rollout`, `harness_forwarded_headers`, `operator_manual`, `fixture` | The ingestion path. `fixture` rows are refused outside disposable test databases. |
| `source.harnessVersion` | string or `null` | The harness build that produced the input, because field shapes change between builds. |
| `source.field` | string | The path of the value inside its input. |
| `confidence` | `high`, `medium`, `low` | Assigned by rule, never by judgement: `high` = observed through a surface its harness documents; `medium` = observed through an undocumented surface, or typed by an operator from a provider screen; `low` = estimated, or `resetsAt` derived from a relative value. |
| `observedAt` | UTC instant | When the provider's value was true, as far as the source says. |
| `observedAtSource` | `provider`, `capture` | `provider`: the source carries its own timestamp for the reading (a Codex line's `timestamp`, from a line that is not [fork-copied](#codex-rollout-rules)). `capture`: the source carries none, so `observedAt` is the capture instant. That is an upper bound on how fresh the value is, not a claim about it (the Claude Code status line is always `capture`). |
| `sessionRef` | hashed id or `null` | The harness session that produced the reading: the status-line `session_id`, or the Codex rollout's thread id: the first `session_meta` line's `payload.id`, which is also the tail of the rollout's file name and the value a fork's `forked_from_id` names. Not `payload.session_id`, which newer builds set to the root thread of a fork tree (it differs from `payload.id` in every fork and in sub-agent rollouts), so hashing it would merge a fork or sub-agent with its parent. An attempt reported from a Codex thread hashes the same `payload.id`. Hashed as for attempts ([Privacy](#privacy)). `null` for `operator_manual`. |
| `recordedAt` | UTC instant | When staple stored it. A large gap between `observedAt` and `recordedAt` identifies a late ingestion, such as a backfill from rollout files. |

There is no `derived` method. A value staple computes (an interpolation, a burn
rate, a forecast) exists only in read payloads and in the scheduler's decision
records, and is never written back as a sample. Stored samples are always
readings.

### Linking samples to attempts

`attemptId` is set at ingestion when exactly one effectively open attempt on this device
matches the sample's `providerBinding` and harness `sessionRef` (the status-line
input carries its session id). Otherwise it is `null` with reason
`no_matching_attempt` or `ambiguous_attempt`. Burn per attempt is derived at
read time from the samples that bracket it inside one window instance (using
the [high-water rule](#regressions-within-a-window)), summed across instances
when it spans a reset. It is reported with `attribution: "sole_known"` when
`storedOpenAttemptsOnAccountStartedHere` was 1 throughout and `"shared"` otherwise.
If any count is unknown (`null`) and nothing shows a second attempt,
`attribution` is `null` with that count's reason. An unknown count is never
read as "alone".

The read brackets each window instance separately:

- A window counts only if it holds **at least one reading inside the
  attempt**. A reading from before the attempt says nothing about what the
  attempt burned. With none inside, the window's delta is `null` with
  `stale`, never a measured `0`.
- The **end** is the window's high-water at or before the attempt's end (for
  an open attempt, now).
- The **start** (`baseline`) is the window's high-water at or before the
  attempt's start (`window`). If the window holds no such reading, the start
  is one of three things. It is `0` when the limit's previous instance reset
  inside the attempt, because a reset is the provider's statement that usage
  restarts (`reset`). It is the high-water at the start of the instance this
  one superseded, when this one's readings continue from it: a moved reset
  (`superseded_window`). Otherwise it is the first reading inside the attempt
  (`first_reading`). In that last case usage before it was not seen, so the
  window, and the limit's sum, carry `lowerBound: true`.
- A superseded instance is not summed beside the one that replaced it. Doing
  so would count one usage twice. There is one exception: when the
  replacement holds no reading inside the attempt, or does not reach it at
  all, the superseded instances' readings during the attempt are the measure.
  They are reported with the `superseded_window` baseline, or as a
  `first_reading` lower bound when none of them was read before the attempt.
`sole_known` means only that no *other attempt this machine knows of* ran on the
account. Usage from another machine, from an interactive session or from a
headless run outside staple lands in the same percentage and cannot be excluded,
so the read never calls a delta exclusive. With a shared account, a delta
belongs to every agent that ran during it, and the read makes no claim that it
can be divided among them.

### Source bindings produce the account

Neither automated source says which account it measures: the status-line JSON
has no account field, and a rollout line has only a plan name. The account
therefore comes from a **machine-local source binding** in the staple home's
`config.json`, never from the input:

```json
"telemetry": {
  "budgetCapture": false,
  "bindings": [
    { "source": "claude_code_statusline", "configDir": "~/.claude", "provider": "anthropic", "accountRef": "personal-max" },
    { "source": "codex_rollout", "home": "~/.codex", "provider": "openai", "accountRef": "codex-plus" }
  ]
}
```

A Claude Code binding is keyed by its config directory (`CLAUDE_CONFIG_DIR`, or
`~/.claude` when unset), which is how one machine runs two Claude accounts. A
Codex binding is keyed by `CODEX_HOME` (or `~/.codex`), and a rollout file
belongs to the binding whose home contains it. At ingestion the status-line path
resolves the binding from the `CLAUDE_CONFIG_DIR` it inherits from the Claude Code
process. `--account` overrides the binding, and a source with no binding and no
flag is refused with `validation` naming the missing binding. Nothing is stored
under a guessed account. The same resolution gives an attempt its default
`providerBinding` at checkout when the agent reports its harness and passes no
`--account` (`source: "machine_binding"`). With no binding it is `null` with reason
`no_binding_configured`.

### Status-line readings are cached re-reads

The Claude Code status line does not measure anything. Each Claude Code process
keeps the `rate_limits` from its **own last API response** and re-sends that
object every time it renders the status line, including on a timer when a
refresh interval is configured. Three consequences are binding on ingestion:

- A status-line sample is always `observedAtSource: "capture"`. A re-send of an
  unchanged value proves that the process is alive. It does not prove the provider
  measured again.
- Two concurrent sessions on one account hold caches of different ages and
  alternate between them, so a later sample can show lower usage than an
  earlier one. That is handled by [the regression rule](#regressions-within-a-window),
  not treated as a refund.
- Headless runs (`claude -p`) and SDK-driven sessions may never render a status
  line. Their usage appears only when some interactive session on the same
  account next receives a response. For those sessions the source is
  `source_unavailable`, while their burn still shows up in the account's
  percentage.

### Codex rollout rules

- **Fork-copied history is skipped, and only at the start of the file.** A
  rollout whose first `session_meta` line carries `payload.forked_from_id`
  begins with its parent's history copied in, re-stamped at or just after the
  fork instant. One file on the author's machine has all 388 lines at a single
  timestamp, with `used_percent` rising from 36 to 83 under one `resets_at`.
  Other forks stamp their copies 1 to 3 ms after the `session_meta` line, so a
  timestamp-equality rule misses them. Let the **fork instant** be the outer
  `timestamp` of that `session_meta` line (not `payload.timestamp`). Walking the
  file's token-count lines from the first one, a line is a copy when either
  test holds:
  1. **Pre-fork content match.** Its `rate_limits` (`limit_id`, `primary`,
     `secondary`, compared whole) equals a reading stamped **before the fork
     instant** in an ancestor rollout. The parent is found by `forked_from_id`,
     which is the tail of every rollout file name, then its parent, and so on
     up the chain, because a fork of a fork copies copies. Ancestor readings
     from after the fork instant are excluded: the parent keeps running after
     the fork, both processes see the same account-level percentages, and the
     fork's own later readings often equal them.
  2. **Opening burst, a heuristic.** It follows the previous **token-count
     line** (for the first one, the fork instant) by no more than 1,000 ms.
     This catches copies whose ancestor is missing or was itself trimmed. It
     can also drop the fork's own first reading when that lands inside the
     burst. That loses one reading and never mis-dates one.
  Skipping covers only the **leading contiguous run**. The walk stops at the
  first token-count line that passes neither test, and nothing after it is
  skipped, whatever it matches. Skipped lines are reported by ingestion as
  `{stored: false, reason: "fork_copied"}` and never reach the dedup key.
- **Old lines without `limit_id` or `resets_at`** get `limitKey`
  `unlabelled.primary` / `unlabelled.secondary`, `windowSeconds` exactly as
  reported (299 × 60, not rounded to 300), `resetsAt: null` with
  `reset_not_reported`, and `confidence: "low"`. They [join no
  window](#window-identity).
- **Relative resets.** None has been seen. If a build that writes one appears,
  its value is converted at the line's own `timestamp` (not at ingestion) and
  marked `derived_from_relative`.

### Regressions within a window

Usage inside one window instance can read lower than an earlier reading from
the same account. Causes include status-line caches of different ages, parallel
Codex sessions, and provider-side corrections. Across the rollouts on the
author's machine, merged across files and ordered by line timestamp, 98
readings fall below the window's running high-water mark, by up to 9 points,
once fork copies are removed by the leading-run rule above (887 lines skipped).
Other copy-detection rules tried during review gave between roughly 60 and 100
readings, with a maximum of 8 or 9 points, so the figure depends on the rule
and not on the provider. With the copied lines
included it is 945 readings, by up to 42 points, so most apparent regressions
in raw rollouts are fork copies and not provider behaviour. The contract does not
pick the right one:

- Every sample is stored as reported. Nothing is clamped or rewritten.
- A read marks a sample `regression: true` (derived) when its `usedPercent` is
  below the highest earlier `usedPercent` in the same window instance, by
  `observedAt`.
- Current pressure and per-attempt burn use the window's **high-water** value,
  the highest `usedPercent` observed so far, which is the conservative reading
  for a budget. Reads report `regressionCount` beside it so a noisy window is
  visible.
- High-water errs in one direction only. If a provider resets or refunds usage
  **without moving `resetsAt`**, high-water keeps reporting the old, higher
  figure until the window ends. The scheduler then under-admits, which is the
  safe failure, and `regressionCount` makes it visible. A window instance that
  closes with a large regression is evidence for that case, and staple does not
  act on it silently.
- High-water is **undefined for a sliding window** (`resetsAt: null`,
  `sliding_window`), because there is no window instance to take the maximum
  over. For such a limit, current pressure is the latest sample by `observedAt`
  and burn is `null` with reason `sliding_window`, until a rule for sliding
  windows is specified with evidence from a source that has one.

### Ingestion cadence

Claude Code renders the status line often, so ingestion compares each reading
with the **latest stored sample for the same window and the same harness
`sessionRef`**. "Latest" means the greatest `observedAt` that is not after the
incoming reading's own, not the most recently recorded, so a backfill ingested
out of order compares against its real neighbour and not against a later
reading. The age that makes a heartbeat is measured the same way, from that
neighbour's `observedAt` to the incoming reading's, within one session and so on
one clock. The comparison is per session because concurrent sessions on one
account alternate between caches of different ages. Compared per window
alone, every render would differ from the last and be stored. A sample is
stored only when `usedPercent` differs from that latest sample, or when
`resetsAt` differs from it by more than the window tolerance (a sub-tolerance
jitter is the same reading), or when that latest sample is older than 300
seconds. The last kind is stored with `heartbeat: true`. A heartbeat shows
that capture was running. With `observedAtSource: "capture"` it does not show a
fresh provider observation, so coverage reports capture gaps and never presents
heartbeats as measurements. `dedupKey` is the first 32 hex characters of
`sha256` over the tuple `(source.kind, accountRef, limitKey, sessionRef,
resetsAt, usedPercent, observedAt)`.
Replaying the same rollout file therefore stores nothing twice. Fork-copied lines
never reach the key, because they are skipped, not deduplicated. Samples live
in `hub.db`, not in the events table, so the key is a plain digest and not an
event key.

## Missingness

An unknown value is never zero, never the previous value and never an
estimate. The encoding is the same for every record on this page:

1. **Every measurable field is nullable, and `null` never means `0`.** Zero means
   measured zero, the same distinction [cli.md](cli.md#estimates-vs-actuals)
   draws for `activeSeconds` and for estimate sums.
2. **Every `null` measurable field has an entry in the record's `missing`
   object**, `{ "<field>": "<reason code>" }`. A field with a value never appears
   there. A consumer can therefore tell "not applicable" from "not known" without
   guessing from field names.
3. **An absent sample is a gap, not a row.** Staple never writes a placeholder
   sample. Gaps are reported by the read that spans them (see
   [coverage](#bounded-reads-coverage-and-truncation)).
4. **Nothing carries forward across a reset.** Once a window has elapsed, its
   last sample says nothing about the next window, and the current reading for
   that limit is `null` with reason `window_elapsed` until a new sample arrives.

Reason codes (a closed set; an unknown code from a newer build is preserved and
shown verbatim):

| Code | Meaning |
|---|---|
| `not_reported_by_source` | The source ran and has no such field, or reported it as `null` (Codex's `premium` limit) |
| `source_unavailable` | No ingestion path is configured for this account or harness |
| `not_subscriber` | The account has no subscription windows (API-key usage) |
| `no_sample_yet` | Ingestion is configured and nothing has arrived |
| `stale` | The latest sample is older than the heartbeat interval allows |
| `window_elapsed` | The only samples belong to a window that has reset |
| `sliding_window` | The limit has no single reset instant |
| `limit_not_published` | The unit cannot be normalized because the provider publishes no limit in it |
| `unit_not_normalizable` | Any other unit without a matching limit |
| `not_on_this_device` | The value exists on the device that captured it, and budget data does not replicate |
| `no_provider_binding` | The attempt names no account, so budget cannot be joined to it |
| `no_binding_configured` | No [source binding](#source-bindings-produce-the-account) matches the harness, and no `--account` was passed |
| `reset_not_reported` | The source gave usage without a reset instant (old Codex lines), so the sample joins no window |
| `end_not_observed` | An attempt read as `orphaned`: no device recorded when it actually stopped |
| `no_matching_attempt`, `ambiguous_attempt` | A sample could not be linked to exactly one attempt |
| `not_connected` | The workspace is not synchronized, so there is no sync horizon |
| `before_capture_began` | The record predates this contract |
| `not_supplied` | An optional self-reported field the agent did not send |
| `parse_error` | The source was read and the field could not be parsed. The raw value is not kept. |
| `input_missing` | A derived value with at least one missing input. It is accompanied by `missingInputs` |

**Propagation.** Any value derived from a missing input is itself `null`, with
`input_missing` and the list of the inputs that were missing. A sum over a set
is `null` when no member contributed, and otherwise carries `coverage: {known,
total}` and `partial: true` when `known < total`. This is the rule that already
makes `childrenEstimatedSeconds` `null` rather than `0`. Consumers must not
replace a `null` with a default. The scheduling decision record already says
what missing telemetry means for admission: start with one continuous agent.
That rule belongs to the policy contract, and this page's job is to keep
missing values from looking like measurements.

## Formats

| Kind | Format |
|---|---|
| Instant | ISO-8601 UTC with milliseconds and `Z` (`new Date().toISOString()`, `nowIso()`), as every staple timestamp already is. Lexicographic order is chronological order. Provider epoch seconds are converted on ingest. The conversion is exact, so the epoch is not kept. |
| Duration | Integer seconds in a field ending `Seconds`. Input accepts the existing vocabulary (`90s`, `30m`, `2h`, `3d`). |
| Percent | A JSON number on a 0–100 scale (not a 0–1 fraction), as reported. `usedPercent` may exceed 100. |
| Identifier | UUID v4 (`randomUUID()`) for attempts, transitions, windows and samples. Display handles (`ABC-42 attempt 3`, a window's `label`) are derived and never keys. |
| Hash input | Every `sha256` on this page hashes UTF-8 bytes. A tuple is serialized as a compact JSON array in the order written (`JSON.stringify([...])`, no whitespace). Strings are JSON strings, instants are their ISO-8601 strings, numbers are JSON numbers exactly as stored, and a missing value is JSON `null`. A single value (a transition id) is hashed as its bare string. `sessionRef`'s `harness name + ":" + session id` is a plain string, not a tuple. |
| Dedup key | Event keys for attempt transitions use the `ids.ts` level-triggered shape, `<kind>:<entityId>:<count>:<32 hex>` ([Lifecycle](#lifecycle)). Budget samples are not events, so their `dedupKey` is a bare 32-hex digest, the form the journal scope keys already take. |
| Enum | Lowercase `snake_case`, a closed set per field (`harness.name` included: `claude_code`, `codex`, `other`). A value from a newer build is preserved and shown verbatim, never coerced, following the unknown-field rule in [sync.md](sync.md#the-operation-envelope). |
| `accountRef` | Operator-chosen slug, `[a-z0-9][a-z0-9-]{0,63}`. |

Clocks: `startedAt`, `endedAt`, transition `at` and `recordedAt` come from the
local clock. `observedAt` and `resetsAt` come from the provider. Lease expiry
comes from the sync service. Nothing compares a local-clock value against a
provider instant without saying so. Reset countdowns are measured on `resetsAt`.
Staleness is measured on `observedAt`, the instant the value was true, because
it is the value's age that matters. A reading backfilled from a rollout a
minute ago can be two hours old. For a `capture`-sourced sample `observedAt`
is the local capture instant, so the comparison stays on one clock. For a
`provider`-sourced one it compares the local clock with the provider's
timestamp, and that is said here. `get_budget`'s `stale` and the history's
coverage gaps apply this one rule.

## Where it lives and what synchronizes

**Attempts and their transitions are repository state.** They live in the
workspace database beside the issues they describe and, when the repository is
connected, replicate as two new entity kinds:

- `attempt`, keyed by `id`, with `create` and `update`. The fields that can
  change after creation are `state`, `outcome`, `endReason`, `endDetection`,
  `endedBy`, `endedAt` and `endedAtSource`.
- `attemptTransition`, keyed by `id`, `create` only and immutable once written,
  like `documentRevision`.

[sync.md](sync.md#protocol-evolution) is explicit that **a new entity kind is not
additive**. Both kinds go through the journal seam with its existing
obligations. The seam journals one operation per entity per mutation scope, so a
local steal journals the `issue.update` it already journals, an `attempt.update`
for the ended attempt, an `attempt.create` for the new one, and one
`attemptTransition.create` per transition, all in the same transaction. Applying
them runs none of the attempt side effects ([How an attempt
opens](#how-an-attempt-opens)). Each applied transition re-emits its local event
under its transition-derived key, as every applied operation already does.

**What protocol 3 does to a fleet.** It follows the standing decision that no
release stays compatible with old builds and the new Worker is deployed first:

- The Worker that understands `attempt` and `attemptTransition` is deployed
  before any client that journals them, and it advertises `{ min: 1, max: 3 }`.
- The workspace client's `CLIENT_PROTOCOL` moves from 1 to 3. (Today only the
  hub-registry leg declares 2.)
- A device that has not upgraded **stops converging** on that repository as soon
  as an upgraded device pushes anything, not only an attempt. The attempts arrive
  with a workspace migration, so every operation an upgraded device journals
  carries the new `schema`, and an older client refuses a page holding one with
  `schema_ahead`. A page or fold that holds an attempt is also refused to it at
  the service, with `protocol_unsupported` and `requiredProtocol: 3`. Both are the
  existing refusals, working as designed: every device upgrades together, the
  Worker first, and upgrading the device is the only remedy.
- A workspace backup taken after the first attempt operation records
  `backups.protocol` 3, the lowest protocol that can replay it. A Worker rolled
  back to protocol 2 cannot restore it.

Two offline devices can each open an attempt on the same issue. Offline claims
are `local` and never implied exclusivity, and that does not change. After a
merge, both attempts exist and both are shown. Neither is deleted. The
[orphan rule](#orphaned-attempts-are-closed-at-read-time) leaves one of them
effectively open. While both attempts are stored-open, every device takes the
newer one as the survivor from the replicated rows alone, and marks both
`contested: true`. Once the claim conflict is resolved, the losing attempt's
opening device writes its end down, and the contested case is over. A contradictory stored end (one device completed, the other
recorded an interruption) is a field conflict on `attempt` and follows
[conflict preservation](sync.md#conflicts-are-preserved-never-resolved-silently),
never silent last-writer-wins. No part of this relies on the fencing token. The
service checks it on lease renew and release, not on push, and releasing a
superseded claim still clears it locally, so an attempt write from a stale holder
is not refused by the wire.

**Limit windows and budget samples are machine state.** They live in the staple
home's `hub.db`, because a subscription belongs to an account, and an account
spans every repository on the machine. They **do not replicate**, and join the
[never-leaves list](sync.md#what-never-leaves-the-machine). Replicating them
through a repository log would copy one person's subscription usage into every
repository they connect, and to anyone else connected to those repositories.
The consequence is stated rather than hidden: a second machine using the same
account sees none of the first machine's samples, and a replicated attempt read
on another device reports its burn as `null` with `not_on_this_device`.

Ingestion is local and **makes no network call**: it reads stdin (the status-line
pass-through) and local files (Codex rollouts), and nothing else. The
zero-network invariant holds unchanged.

Storage is additive (new tables, no altered columns), and a new workspace
migration moves the `schema` number every operation carries. This page contains
no DDL. The persistence work writes the migration against this contract.

## Surfaces

### One shape on every surface

Every read and write below is one store method called by the CLI, the MCP tool
and the HTTP route alike. That rule is what keeps the queue's verbs identical
across surfaces ([queue.md](queue.md#operations-by-surface)), and it is how
"CLI and MCP expose equivalent telemetry JSON" is met structurally rather than by
tests catching drift. The names are proposals. The single-method rule is not.

| CLI | MCP | Returns |
|---|---|---|
| `staple show <ref>` | `get_task` | Adds `attempts: {current, last, count}` beside `timing` and `claim`, derived at read |
| `staple attempts <ref> [--limit N] [--cursor C]` | `list_attempts` | `{items, truncated, nextCursor, coverage}`. Items carry the effective (read-time) state and `storedState`. |
| `staple attempt <attempt-id>` | `get_attempt` | The attempt, its transitions, its `chain` and its derived burn |
| `staple attempt pause\|resume\|milestone\|interrupt <ref> [--reason R] [-m label]` | `record_attempt_event` | The updated attempt |
| `checkout`, `status`, `done` gain optional `--harness-session`, `--harness claude_code\|codex\|other`, `--model`, `--account`, `--attempt-key K` (the attempt's idempotency key), and the claim-clearing verbs (`release`, `status`, `done`) gain `--outcome failed --reason R` | the same fields on `checkout_task`, `release_task`, `update_task` (`harness_session`, `harness`, `model`, `account`, `attempt_idempotency_key`, `outcome`, `reason`) | Unchanged payloads, plus `attempt` |
| `staple budget [--account A]` | `get_budget` | Per account, each current window with its latest sample, `status`, `missing` |
| `staple budget history --account A [--since T] [--limit N]` | `list_budget_samples` | `{items, truncated, nextCursor, coverage}` |
| `staple budget ingest --source claude-statusline [--tee] [--account A]` (stdin), `--source codex-rollout <file> [--account A]`, `--source manual --account A --limit-key K --used P --resets-at T` | `record_budget_sample` | The stored sample, or `{stored: false, reason: "unchanged" \| "fork_copied"}` |

`--tee` passes the status-line input through to stdout unchanged, so staple can
sit in front of a status-line command the operator already uses.

Field names are the camelCase names on this page on every surface. `--json`
emits the store objects unformatted, and errors use the existing envelope and
exit codes: an event on an attempt that is not open is `conflict`, and a
malformed reading is `validation`. No new code is added.

### Bounded reads, coverage and truncation

Every list is bounded: default `limit` 50, maximum 500. Every list returns:

```json
{
  "items": [ ],
  "truncated": true,
  "nextCursor": "opaque",
  "coverage": {
    "from": "2026-09-24T09:00:00.000Z",
    "to": "2026-09-24T15:00:00.000Z",
    "itemCount": 50,
    "gaps": [
      { "from": "2026-09-24T11:10:00.000Z", "to": "2026-09-24T12:40:00.000Z", "reason": "stale" }
    ]
  }
}
```

`gaps` lists spans in which capture did not run (no sample and no heartbeat),
each with a reason from the [missingness table](#missingness), so a consumer can
tell "capture saw no change" from "nobody was looking". A gap is a span of more
than **600 seconds**, two heartbeat intervals, with no stored sample, measured
on `observedAt`. One interval is not enough: an unchanged reading is stored
again only once the previous one is 300 seconds old, so a live session's
heartbeats land a little over 300 seconds apart. `stale` in `get_budget` uses
the same 600 seconds. Budget history reports a gap before the account's first
reading as `no_sample_yet`, and every other gap as `stale`. An attempt list
reports the span of an issue worked before any attempt was recorded in the
workspace as `before_capture_began`. When a page speaks for no span at all,
`from` and `to` are `null`, and `coverage.missing` gives the reason, as on
every other record. For budget history that reason is `no_sample_yet` or
`source_unavailable`. For an issue with no attempts it is one of the
[timing contract's](timing-semantics.md#missingness-for-the-new-fields) codes:
`never_started`, or `no_worker_attempt` when the issue has a start and no
attempt.

The cursor is a keyset position `(instant, id)`. The id breaks ties, because
one status-line render stores one sample per limit at the same `observedAt`.
Rows written between two pages never shift a page. A relative `since` (`2h`)
is resolved against the clock once, on the first page. A cursor is already
past it, so a later page never resolves it again. For `capture`-sourced
samples, "no change" still does not mean the provider measured again (see
[the status-line caveats](#status-line-readings-are-cached-re-reads)). `truncated` is never inferred from
`itemCount == limit`: it is stated.

## Privacy

- **Credentials are never read.** Ingestion does not open `~/.claude/.credentials.json`,
  the macOS keychain, `~/.codex/auth.json` or any file or endpoint that needs
  them. No OAuth token, API key, cookie or session secret is stored, logged or
  echoed, in whole or in part. This matches [sync.md's redaction
  rule](sync.md#trust-boundaries).
- **Inputs are parsed for their rate-limit fields and the rest is discarded.**
  The status-line JSON also carries `cwd`, `transcript_path`, repository
  identity and a session name. None of it is stored. Codex rollout lines carry
  prompts and outputs. From a rollout, ingestion reads only the `session_meta`
  line's thread id (`payload.id`), fork marker and timestamp, and each `token_count` line's
  timestamp and rate-limit object. To detect fork copies it reads the same
  fields, and nothing else, from the ancestor rollout files named by
  `forked_from_id`. The session id is hashed before storage (next bullet).
- **Accounts are labels, not identities.** `accountRef` is a name the operator
  chooses (`personal-max`). No email address, organization id or account UUID is
  stored. `plan_type` is kept as the optional `planTier` field of the
  machine-local [window record](#a-reset-is-an-absolute-instant), because it is
  not identifying and it explains a limit. Source bindings name config
  directories on this machine and stay in the staple home.
- **Harness session ids are hashed.** `sessionRef` is the first 16 hex characters
  of `sha256(harness name + ":" + session id)`. The harness name is the
  `harness.name` enum value. On a budget sample it comes from `source.kind`
  (`claude_code_statusline` → `claude_code`, `codex_rollout` → `codex`), so a
  sample's `sessionRef` equals the `sessionRef` of an attempt reported from the
  same session, and the two can be joined. It is enough to tell "same
  session" from "new session", which is all the attempt rules need, and it does
  not reveal the transcript file name when the attempt replicates.
- **Attribution travels, as it already does.** The attempt's `agent`, harness
  name, version and model replicate with the attempt, like `checkout_agent` and
  the event `actor` ([sync.md](sync.md#entity-operations)). They are named here so
  that nobody finds out later that a model name travelled.
- **Budget data does not leave the machine** (above).

## What each piece of downstream work takes from this page

| Work | Sections it implements or reads |
|---|---|
| Persisting the attempt lifecycle | [The attempt record](#the-attempt-record), [How an attempt opens](#how-an-attempt-opens), [The resume rule](#the-resume-rule), [How an attempt ends](#how-an-attempt-ends), [Orphaned attempts](#orphaned-attempts-are-closed-at-read-time), [Lifecycle](#lifecycle), [Concurrency context](#concurrency-context), [Where it lives](#where-it-lives-and-what-synchronizes) |
| Ingesting budget samples and reset windows | [Limit windows](#limit-windows), [Budget samples](#budget-samples) (source bindings, status-line caveats, Codex rollout rules, regressions), [Missingness](#missingness), [Privacy](#privacy) |
| Agent-facing telemetry JSON | [Surfaces](#surfaces), [Bounded reads](#bounded-reads-coverage-and-truncation), [Missingness](#missingness) |
| Timing semantics, lifecycle gaps, controlled validation, quality states | Attempt `activeSeconds` vs issue `timing` ([The attempt record](#the-attempt-record)), pause vs interruption ([Lifecycle](#lifecycle)), `provenance`/`endDetection` and [History before capture](#history-before-capture) as quality inputs |
| Calibration and forecasting | `estimateAtStart`, outcomes, `chain`, per-attempt burn and `attribution`, the no-conversion rule ([Units](#units)), resolution caveat |
| Admission policy, ranking, checkpointing, dry runs | Current windows and `resetsAt`, high-water `remainingPercent` with `missing`, `storedOpenAttemptsOnAccountStartedHere`, `attempt_paused` with `checkpoint_before_reset`, milestone pointers to the worklog |
| Pressure panel, decision history, guidance | `get_budget` shape, `missing` reasons to show as unknown, attempt `id` as the join key from a decision to its outcome, the `sessionRef` rule for guidance |
| Fixtures, policy comparisons, cold-agent trials, release gate | Every record here is plain JSON with explicit instants, so a fixture is a list of records. `source.kind: "fixture"` is refused outside disposable databases. |

## Open questions

These need a decision before or during implementation. Each has a recommended
default, and the contract above is written to that default.

1. **Should budget samples ever replicate?** Default: no. They are machine-local,
   and a second machine on the same subscription is blind to the first. If
   cross-machine burn matters, the alternative is a separate, opt-in,
   account-scoped channel (not the repository log), which would be a new consent
   in the sense of [Three consents](sync.md#three-consents).
2. **Account identity: operator label or derived fingerprint?** Default: label.
   It stores nothing identifying, but two machines only agree on an account if the
   operator gives it the same name on both.
3. **Should agent guidance require a per-session agent identity?** A shared
   identity (`STAPLE_AGENT=claude` on every install, or the `$USER` fallback)
   means a crashed session's successor re-claims silently, and the interruption
   is visible only if the successor reports it. Default: guidance recommends a
   per-session identity (for example `claude-<short session id>`), asks a resuming
   session to report the previous attempt's interruption, and asks every checkout
   to pass its harness session. The store accepts all three being absent.
4. **Does a status write into `active` with no checkout open an attempt?**
   Default: yes, with `claim.scope: "none"`, so the work is not lost from
   telemetry. The alternative is to refuse attempts without a claim and leave
   that work unmeasured.
5. **Estimate history.** Default: keep `estimateAtStart` and also ask the
   estimate-mutation work to emit an event with the old and new value. The
   alternative is the event alone, which does not cover imported workspaces.
6. **Is budget capture opt-in?** Default: yes, a machine setting that defaults to
   off. Nothing is read from a harness until the operator enables a source.
7. **Ship attempts local-only first, or wait for protocol 3?** Journaling a new
   entity needs the Worker redeployed first. Default: build the local tables and
   the protocol-3 entities together, and deploy the Worker first, following the
   support boundary sync already has. The alternative, local-only attempts,
   leaves a history to seed later.
8. **Retention.** Heartbeats every five minutes are about 2,000 rows per limit
   per week for each harness session that stays open all week, plus one row per
   change. Many sessions multiply that. Default: keep everything until measured. The alternative is to
   downsample samples of elapsed windows to their first, last and every change.
