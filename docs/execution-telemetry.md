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
| Status categories (`active`, `review`, `blocked`, `gated`, `done`, `cancelled`, …) and derived parent flips | [semantics.md](semantics.md#categories--why-a-configurable-status-set-is-still-safe) | Attempt outcomes key off the **category** a leaf leaves `active` for, never a status id. Derived flips never open an attempt: an epic has no attempts, as it has no stopwatch. |
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
- **Execution attempt**: one agent's tenure on one leaf issue, from the moment
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
- **At most one attempt per issue is open** (`running` or `paused`) at a time,
  because at most one claim is held at a time. The one exception is a merge of
  two offline devices, below.
- Attempts exist only on the issue that was claimed. A parent that reads
  `in_progress` because a child did has no attempt of its own. The rule is the one
  timing already follows: an interval opened by a derived flip is never billed.

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
  "openedBy": "checkout",
  "resumesAttemptId": null,
  "startedAt": "2026-09-24T14:09:31.710Z",
  "endedAt": "2026-09-24T15:02:10.004Z",
  "claim": { "scope": "local", "fencingToken": null },
  "harness": {
    "name": "claude-code",
    "version": "2.1.281",
    "sessionRef": "9c1d4be07a51f2e3",
    "model": "claude-opus-…",
    "provenance": "self_reported"
  },
  "providerBinding": { "provider": "anthropic", "accountRef": "personal-max" },
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
| `outcome` | `null` while open. On `ended`: `completed`, `yielded`, `failed` or `interrupted`. |
| `endReason` | A reason code from the [lifecycle tables](#how-an-attempt-ends), `null` while open. |
| `endDetection` | `reported` (the holder said so), `inferred` (staple concluded it from a later mutation) or `reconstructed` (backfilled from the event log). `null` while open. |
| `openedBy` | `checkout`, `steal`, `reclaim`, `status` or `reconstructed`. Which mutation opened it. |
| `resumesAttemptId` | The attempt this one continues after an interruption, or `null`. The link that makes an interruption boundary reconstructable. |
| `startedAt`, `endedAt` | UTC instants. `endedAt` is `null` while open. |
| `claim` | `scope` (`local`, `lease` or `none`) and the lease's `fencingToken` when `scope` is `lease`, copied at open. `none` means the attempt was opened by a status write with no claim. |
| `harness` | Optional and self-reported by the agent: harness `name`, `version`, a hashed `sessionRef` ([Privacy](#privacy)), `model`. `null` when not supplied, with a `missing` entry. |
| `providerBinding` | Which provider account the attempt spends from, as `{provider, accountRef}`, or `null` when unknown. The join key to limit windows. |
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
| `lastActivityAt` | For an open attempt, the holder's `lastActivityAt` from the claim derivation, floored at `startedAt`. For an ended one, `endedAt`. |
| `activeSeconds` | `startedAt` to `endedAt` (open: to `lastActivityAt`), minus paused intervals. Zero means it ran for under a second; `null` means it never ran. |
| `pausedSeconds` | Sum of paused intervals, `null` when there were none. |
| `countedThrough` | Where the clock stopped for an open attempt, as in timing. |
| `idleSeconds` | For an open attempt, seconds since `lastActivityAt`. It is information. It is not a verdict: staple does not declare an attempt dead on a threshold. |
| `chain` | The attempts linked by `resumesAttemptId`, oldest first, so one read shows every interruption boundary of one piece of work. |

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

Every rule is a side effect of a mutation that exists today, in the same
transaction, like `startedAt`. No caller writes an attempt directly.

| Mutation | Result |
|---|---|
| `checkout` succeeds and creates a new claim | A new attempt, `openedBy: "checkout"`. |
| `checkout --steal-if-stale` succeeds (`claim_stolen`) | The previous holder's open attempt ends (`interrupted`, `claim_stolen`, `inferred`, `endedAt` = the previous holder's `lastActivityAt`). A new attempt opens with `openedBy: "steal"` and `resumesAttemptId` pointing at it. |
| The holder re-claims an issue it already holds (the crash-recovery path, which today returns the row and emits nothing) and supplies a harness `sessionRef` that differs from the open attempt's | The open attempt ends (`interrupted`, `harness_session_changed`, `inferred`, `endedAt` = its `lastActivityAt`). A new attempt opens with `openedBy: "reclaim"` and `resumesAttemptId` pointing at it. |
| The same re-claim with the same `sessionRef`, or with none | Nothing. The open attempt is returned. Re-claim stays idempotent. |
| The holder re-claims an issue whose last attempt ended `interrupted` by a report and still holds the claim | A new attempt, `openedBy: "reclaim"`, `resumesAttemptId` set. |
| A non-derived `status` write moves a leaf into the `active` category without a checkout | A new attempt, `openedBy: "status"`, `claim.scope: "none"`, agent = the actor. |

A derived flip, a gate, an approval or a queue change never opens an attempt.

The honest limit, stated once: **most interruptions are inferred, not
reported.** A harness killed by a usage limit or a closed terminal cannot say
so. The interruption becomes visible only when someone steals the claim,
releases it as stale, or re-claims it from a new harness session. Until then
the attempt reads `running` with a growing `idleSeconds`, which is exactly what
the claim already says about a dead holder today. A re-claim that omits
`sessionRef` hides the interruption altogether. That is why agent guidance
should pass one (see [Open questions](#open-questions)).

### How an attempt ends

The default outcome is set by the mutation that clears or moves the claim, keyed
on the category the leaf enters:

| Mutation | `outcome` | `endReason` | `endDetection` |
|---|---|---|---|
| Leaves `active` for `review` or `done` | `completed` | `review` / `done` | `reported` |
| Leaves `active` for `blocked` | `yielded` | `blocked` | `reported` |
| Parked by a gate (the claim is cleared) | `yielded` | `gated` | `reported` |
| Leaves `active` for `cancelled` | `yielded` | `cancelled` | `reported` |
| Leaves `active` for `ready` or `unstarted` by a status write | `yielded` | `returned` | `reported` |
| `release` | `yielded` | `released` | `reported` |
| `release --if-stale` (`claim_released_stale`) | `interrupted` | `released_stale` | `inferred` |
| `claim_stolen`, re-claim from a new harness session | `interrupted` | `claim_stolen` / `harness_session_changed` | `inferred` |
| Explicit interruption report ([below](#lifecycle)) | `interrupted` | the reported reason | `reported` |

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
"interrupted"`. The reverse never holds. An open attempt whose claim has been
cleared is closed in the transaction that cleared it.

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
                              └── a later attempt may name it in resumesAttemptId
```

Transitions, each stored as one immutable **attempt transition** record and
each emitting one local event of the same name:

| Transition | From → to | Written by | Carries |
|---|---|---|---|
| `attempt_started` | none → `running` | the opening mutation | `openedBy`, `resumesAttemptId`, concurrency |
| `attempt_milestone` | `running` → `running` | the holder | `label` (one line), optional `commentId` and/or `document: {key, revision}` pointing at the checkpoint it summarizes |
| `attempt_paused` | `running` → `paused` | the holder | `reason`: `checkpoint_before_reset`, `awaiting_reset`, `awaiting_input`, `operator`, `other` |
| `attempt_resumed` | `paused` → `running` | the holder | `reason`, optional |
| `attempt_interrupted` | `running`/`paused` → `ended` | the holder (reported) or the inferring mutation | `reason`: `provider_limit`, `harness_exit`, `operator_stop`, `claim_stolen`, `released_stale`, `harness_session_changed`, `unknown` |
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
`dedup_key` = `attempt_transition:<transition id>`, so re-applying a pulled
transition cannot duplicate the timeline.

### Concurrency context

Every transition records what else was running when it happened, because a
burn rate means nothing without the number of agents producing it:

```json
"concurrency": {
  "observedAt": "2026-09-24T14:51:00.000Z",
  "scope": "device",
  "openAttemptsInWorkspace": 3,
  "openAttemptsOnDevice": 5,
  "openAttemptsOnAccount": 4,
  "workspaceSyncedThrough": "2026-09-24T14:50:12.000Z",
  "missing": {}
}
```

| Field | Meaning |
|---|---|
| `scope` | Always `device` in this contract. The counts are what this machine's databases know, and no field claims otherwise. |
| `openAttemptsInWorkspace` | Open attempts in this workspace database, including any pulled from other devices. |
| `openAttemptsOnDevice` | Open attempts across every workspace in this machine's hub registry. |
| `openAttemptsOnAccount` | Open attempts on this device whose `providerBinding` names the same account. `null` with reason `no_provider_binding` when this attempt has none. |
| `workspaceSyncedThrough` | The workspace's `last_sync_at`, or `null` with reason `not_connected`. How stale the "other devices" part of the first count may be. |

Agents running on another machine against the same subscription are invisible
here unless their attempts have synced. The count is a floor, and the field
names say so.

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

Derived at read: `status`, one of `current` (`now < resetsAt`), `elapsed`
(`now ≥ resetsAt`) or `superseded` (a later sample moved the reset, below).

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
between readings. That figure is not established, and the ingestion work must
check it against recorded samples. Otherwise:

- A sample whose `resetsAt` is later than a window that has elapsed opens the
  next window instance.
- A sample whose `resetsAt` differs beyond tolerance from a window that is still
  current (a provider-side reset, a changed plan) opens a new instance and marks
  the old one `superseded` with reason `reset_moved`. Staple does not decide which
  reading was right. It keeps both.

## Budget samples

### What providers actually expose

The contract only uses fields someone has seen. The table below lists what was
checked when this page was written and how. Confidence refers to the
*surface's stability*, not to whether the numbers are accurate: staple has no
means of auditing a provider's arithmetic.

| Provider surface | What it reports | How verified | Confidence |
|---|---|---|---|
| **Claude Code status line input** (JSON on the configured `statusLine` command's stdin) | `rate_limits.five_hour`, `rate_limits.seven_day` and, behind a gateway, `rate_limits.spend_limit`, each `{used_percentage (0–100; spend_limit may exceed 100), resets_at (Unix epoch seconds)}`. Documented as present only for subscribers, only after the first API response, and each window only while its reset has not passed. No window length, no plan tier. | The schema text bundled in Claude Code 2.1.281 | High for that version's shape. Medium across versions. |
| Claude Code `/usage` | Session and weekly percentages and reset times, including per-model weekly limits | Interactive screen only | Not a machine source. An operator may type a reading in (`operator_manual`). |
| Anthropic `anthropic-ratelimit-unified-*` response headers (`5h-utilization`, `5h-reset`, `7d-…`) | Utilization and reset per window | Header names appear in the Claude Code 2.1.281 binary. Undocumented. | Low. Staple never sees these responses and never makes the request. A harness could forward them as a source. |
| Codex CLI rollout files (`~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`, `event_msg` lines with `payload.type = "token_count"`) | `payload.rate_limits.limit_id`, `primary` and `secondary` each `{used_percent, window_minutes, resets_at (Unix epoch seconds)}`, `plan_type`, `credits`. The line's own `timestamp` is ISO-8601 UTC. Observed windows: 300 and 10080 minutes. A second limit id (`premium`) was observed with `primary: null, secondary: null`. | codex-cli 0.156.1 files on the author's machine | Medium. The file format is undocumented. Older builds are reported to have carried a relative `resets_in_seconds`, which this page did not verify (low). |
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
  "recordedAt": "2026-09-24T14:51:01.002Z",
  "attemptId": "0b6f2c1e-…",
  "heartbeat": false,
  "dedupKey": "budget_sample:9f0e…",
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
fractional values. It is never rounded. The samples seen so far were whole numbers,
so a burn smaller than one percent between two samples cannot be measured. The
contract does not assume a resolution. Forecasting has to allow for that
quantization.

There is no conversion between units. In particular, **no sample ever converts
runtime or tokens into a percentage**. That conversion is the error this epic
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
| `observedAt` | UTC instant | When the provider's value was true: the source's own timestamp when it has one (Codex line `timestamp`), otherwise the capture instant. |
| `recordedAt` | UTC instant | When staple stored it. A large gap between `observedAt` and `recordedAt` identifies a late ingestion, such as a backfill from rollout files. |

There is no `derived` method. A value staple computes (an interpolation, a burn
rate, a forecast) exists only in read payloads and in the scheduler's decision
records, and is never written back as a sample. Stored samples are always
readings.

### Linking samples to attempts

`attemptId` is set at ingestion when exactly one open attempt on this device
matches the sample's `providerBinding` and harness `sessionRef` (the status-line
input carries its session id). Otherwise it is `null` with reason
`no_matching_attempt` or `ambiguous_attempt`. Burn per attempt is derived at
read time from the samples that bracket it inside one window instance, summed
across instances when it spans a reset. It is reported with `attribution:
"exclusive"` when `openAttemptsOnAccount` was 1 throughout and `"shared"`
otherwise. With a shared account, a percentage delta belongs to every agent
that ran during it, and the read makes no claim that it can be divided among
them.

### Ingestion cadence

Claude Code runs the status-line command often, so ingestion stores a sample
only when `(usedPercent, resetsAt)` differs from the latest stored sample for
that window, or when the latest is older than 300 seconds. The second kind is
stored with `heartbeat: true`. Heartbeats are what make a gap meaningful: with
a heartbeat interval, "no change" and "no observation" are distinguishable, and
a gap longer than the interval is reported as a gap. `dedupKey` =
`sha256(source.kind, accountRef, limitKey, observedAt, usedPercent)` (32 hex),
so replaying the same rollout file stores nothing twice.

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
| Dedup key | `<kind>:<32 hex of sha256(...)>`, the shape `ids.ts` already uses. |
| Enum | Lowercase `snake_case`, a closed set per field. A value from a newer build is preserved and shown verbatim, never coerced, following the unknown-field rule in [sync.md](sync.md#the-operation-envelope). |
| `accountRef` | Operator-chosen slug, `[a-z0-9][a-z0-9-]{0,63}`. |

Clocks: `startedAt`, `endedAt`, transition `at` and `recordedAt` come from the
local clock. `observedAt` and `resetsAt` come from the provider. Lease expiry
comes from the sync service. Nothing compares a local-clock value against a
provider instant without saying so: staleness is measured on `recordedAt`, and
reset countdowns on `resetsAt`.

## Where it lives and what synchronizes

**Attempts and their transitions are repository state.** They live in the
workspace database beside the issues they describe and, when the repository is
connected, replicate as two new entity kinds:

- `attempt`, keyed by `id`, with `create` and `update`. The fields that can
  change after creation are `state`, `outcome`, `endReason`, `endDetection` and
  `endedAt`.
- `attemptTransition`, keyed by `id`, `create` only and immutable once written,
  like `documentRevision`.

[sync.md](sync.md#protocol-evolution) is explicit that **a new entity kind is not
additive**: it needs a protocol integer (the next one, 3), a Worker that
understands it deployed first, and a version-scoped vocabulary so an older
client is refused at the request boundary rather than failing inside a fold.
Both kinds go through the journal seam with its existing obligations, including
one operation per logical mutation: a steal journals the lease change, the ended
attempt and the new attempt as the operations of one mutation. Each applied
transition re-emits its local event, keyed by transition id, as every applied
operation already does.

Two offline devices can each open an attempt on the same issue. Offline claims
are `local` and never implied exclusivity, and that does not change. After a
merge, both attempts exist and both are shown. Neither is deleted. A
contradictory end (one device completed, the other recorded an interruption) is
a field conflict on `attempt` and follows [conflict preservation](sync.md#conflicts-are-preserved-never-resolved-silently),
never silent last-writer-wins. Connected, the fenced lease already stops a stale
holder from writing, and the attempt copies the `fencingToken` that opened it.

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
| `staple attempts <ref> [--limit N] [--cursor C]` | `list_attempts` | `{items, truncated, nextCursor, coverage}` |
| `staple attempt <attempt-id>` | `get_attempt` | The attempt, its transitions, its `chain` and its derived burn |
| `staple attempt pause\|resume\|milestone\|interrupt <ref> [--reason R] [-m label]` | `record_attempt_event` | The updated attempt |
| `checkout`, `release`, `status`, `done` gain optional `--harness-session`, `--harness`, `--model`, `--account`, and on claim-clearing verbs `--outcome failed --reason R` | the same fields on `checkout_task`, `release_task`, `update_task` | Unchanged payloads, plus `attempt` |
| `staple budget [--account A]` | `get_budget` | Per account, each current window with its latest sample, `status`, `missing` |
| `staple budget history --account A [--since T] [--limit N]` | `list_budget_samples` | `{items, truncated, nextCursor, coverage}` |
| `staple budget ingest --source claude-statusline [--tee]` (stdin), `--source codex-rollout <file>`, `--source manual --account A --limit-key K --used P --resets-at T` | `record_budget_sample` | The stored sample, or `{stored: false, reason: "unchanged"}` |

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

`gaps` lists spans where no sample and no heartbeat arrived, each with a reason
from the [missingness table](#missingness). A consumer can then tell "usage
stayed flat" from "nobody was looking". `truncated` is never inferred from
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
  prompts and outputs, and only the `token_count` rate-limit object is read.
- **Accounts are labels, not identities.** `accountRef` is a name the operator
  chooses (`personal-max`). No email address, organization id or account UUID is
  stored. `plan_type` may be kept as an optional `planTier` on the
  machine-local window, because it is not identifying and it explains a limit.
- **Harness session ids are hashed.** `sessionRef` is the first 16 hex characters
  of `sha256(harness name + ":" + session id)`. It is enough to tell "same
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
| Persisting the attempt lifecycle | [The attempt record](#the-attempt-record), [How an attempt opens](#how-an-attempt-opens), [How an attempt ends](#how-an-attempt-ends), [Lifecycle](#lifecycle), [Concurrency context](#concurrency-context), [Where it lives](#where-it-lives-and-what-synchronizes) |
| Ingesting budget samples and reset windows | [Limit windows](#limit-windows), [Budget samples](#budget-samples), [Missingness](#missingness), [Privacy](#privacy) |
| Agent-facing telemetry JSON | [Surfaces](#surfaces), [Bounded reads](#bounded-reads-coverage-and-truncation), [Missingness](#missingness) |
| Timing semantics, lifecycle gaps, controlled validation, quality states | Attempt `activeSeconds` vs issue `timing` ([The attempt record](#the-attempt-record)), pause vs interruption ([Lifecycle](#lifecycle)), `provenance`/`endDetection` and [History before capture](#history-before-capture) as quality inputs |
| Calibration and forecasting | `estimateAtStart`, outcomes, `chain`, per-attempt burn and `attribution`, the no-conversion rule ([Units](#units)), resolution caveat |
| Admission policy, ranking, checkpointing, dry runs | Current windows and `resetsAt`, `remainingPercent` with `missing`, `openAttemptsOnAccount`, `attempt_paused` with `checkpoint_before_reset`, milestone pointers to the worklog |
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
3. **Must agent guidance pass a harness session reference on every checkout?**
   Without one, a crash-recovery re-claim cannot be told apart from continuous
   work, and the interruption is invisible. Default: the guidance asks for it and
   the store accepts its absence.
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
   per week. Default: keep everything until measured. The alternative is to
   downsample samples of elapsed windows to their first, last and every change.
