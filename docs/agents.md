# Agents

## The protocol `init` writes

A repo-local `staple init` also writes **`.staple/AGENTS.md`** — the working
protocol, rendered with that workspace's own slug and identifier prefix, so the
next harness to arrive learns it from the repository instead of from whoever
briefed the last one.

It covers:

- the loop (below);
- the **identity rule** — act under the identity you claimed with, all session,
  or your own writes stop counting as liveness;
- **parents close themselves** — an epic's status follows its children, so the
  last child to land closes it (see [semantics.md](semantics.md)). Nobody has to
  remember to close an epic; what is still owed is the **summary comment**, and
  an explicit `staple done <epic>` remains allowed, idempotent, and immune to
  the derivation afterwards;
- the **worklog convention** — `Done` / `Next` / `Files touched`, revised at
  every milestone. A checkpoint written *before* the interruption is the
  handoff; one written at the end never survives a kill;
- the branch pointer to comment at checkout;
- the **pickup queue rule** — plan order versus effective order, and the three
  non-retryable refusals (below);
- **approval gates** — how a design-first ticket ends (`staple gate <ref>
  --owner <who>`, not a held claim), that the inbox's QUEUED section is never
  pickable, and that checkout of it is refused with `gated`;
- the continuity rules in [continuity.md](continuity.md);
- **attempts and lanes** — yield (`release`) or pause (`staple attempt pause
  <ref> --reason awaiting_input`) when a blocker appears mid-work, so the wait
  reads as `blocked` or `paused` rather than as work; and how an orchestrator
  coordinates without claiming: `staple attempt open <epic> --role orchestrator`
  at the start of a coordination session, `staple attempt end <epic> --role
  orchestrator` at handoff (MCP `record_attempt_event` with `event: "open"` /
  `"end"`). That time is `orchestrationSeconds`, never `workSeconds`
  ([timing-semantics.md](timing-semantics.md#the-orchestrator-lane)).

An existing `AGENTS.md` is **never overwritten** — `init` says it kept it.
`--global` workspaces get no guide: the file exists to be found in a repo, and
`~/.staple/workspaces/` is not one. The MCP `init` tool behaves identically and
returns `guidePath` / `guideWritten`.

Source: `src/core/agents-template.ts`.

It also teaches **the pickup queue rule** ([queue.md](queue.md)), which is the
part an agent is most likely to get wrong because every symptom of getting it
wrong looks like a transient failure: READY is the effective queue rather than a
presentation sort it may re-rank; a queued epic or milestone stands for its open
leaf work and is never a checkout target; `staple queue next` answers before you
claim; and `conflict` (exit 4), `gated` (exit 9) and `out_of_order` (exit 10)
each mean STOP and take what the refusal names — retrying, waiting and
`--steal-if-stale` clear none of the three. The guide also tells an agent not to
reorder the plan and not to send `--override`: both work for it, both record it
as the actor, and both are a human's decision.

## The MCP surface

```bash
claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
```

Any MCP client can launch `npx -y staple-cli mcp` the same way, with
`STAPLE_AGENT` naming the agent. There is no separate MCP binary — `staple mcp`
is the same entrypoint as the CLI.

Fifty-three stdio tools. The loop they exist for:

`inbox` (or `next_task`) → `checkout_task` (a conflict means pick another, never
retry; `out_of_order` means take the one it names) → `put_document` the plan and
`set_estimate` the estimate → work, `add_comment` progress → `update_task` done →
`events_since` to see what your completion unblocked. `cross_link` +
`hub_overview` cover cross-repository dependencies.

### Changing an estimate

**`set_estimate`** `{ref, estimate_seconds}` changes only the estimate. You do
not restate the status, and you do not need the claim: like a status write, any
actor may re-estimate, and the `estimate_changed` event records who.
`estimate_seconds` is required. A number of seconds sets it, `null` clears it,
and omitting or mistyping it is the SDK's `-32602` input-validation error (an
`isError` result), not a clear. It answers the issue plus
`estimateChange: {from, to, changed}`. The identical repeat is a no-op
(`changed: false`, no event, nothing to sync), which is why it is annotated
`idempotentHint: true`. A value that is not an estimate (zero, a fraction, over
365 days) is `validation` with the store's sentence. An unknown ref is
`not_found`. It is the same store method as `staple estimate <ref> <dur>` and
the UI server's `estimate` action ([cli.md](cli.md#changing-an-estimate-staple-estimate)).
`update_task`'s `estimate_seconds` still works, but `set_estimate` is the form
to use.

### The milestone tools

Eight tools over dated, human-ordered plans ([milestones.md](milestones.md)),
usable only in a workspace whose vocabulary has the reserved `milestone` kind —
otherwise every one refuses with `validation` naming `staple kinds add
milestone`. All of them return **one shape**, the same object `staple milestone
show --json` prints and `GET /api/milestone` answers:
`{milestone: {identifier, title, status, kind, assignee, targetDate, startDate,
state, planPosition}, progress: {total, countable, counts, percent, complete},
revision, members: [{identifier, title, kind, status, position, rank, parent,
nestedUnder, addedBy, addedAt, note}], next}`.

- **`list_milestones`** `{all?}` and **`get_milestone`** `{ref}` — read-only.
  A non-milestone `ref` is `validation` naming its kind; unknown is `not_found`.
- **`create_milestone`** `{title?, description?, target_date?, start_date?,
  from_epic?, preview?}`. With `from_epic` the epic becomes the ONE member and
  its children come along by descent — nothing is re-parented. `preview: true`
  writes nothing and returns `{preview: true, milestone: {title, targetDate,
  startDate}, members: [{identifier, position}], hierarchyChanges: []}`; the
  commit returns the view plus `hierarchyChanges: []`, naming the same changes.
- **`update_milestone`** `{ref, target_date?, start_date?}` — the two dates
  only (`YYYY-MM-DD`, UTC calendar days; `null` clears one). Everything else is
  `update_task`.
- **`add_milestone_member`** `{milestone, ref, before? | after? | at?,
  base_revision?, note?}`, **`remove_milestone_member`** `{milestone, ref,
  base_revision?}`, **`move_milestone_member`** `{ref, before? | after? | at? |
  to?, base_revision?}`, **`reorder_milestone_members`** `{milestone, order,
  base_revision?}`. Membership never changes an issue's parent, blockers,
  status or claim. Pass `base_revision` from your last read: a stale one is
  `revision_conflict` (`retryable: true`, `detail.currentRevision`) and the
  order stands. Adding a present member with no position is a replay
  (`replayed: true`, no event); with a position it is a move.

### The gate verbs

Three write tools park work on a human and release it again. All three take
`ref` plus the usual `actor` / `ws`, and all three return the **parent issue
plus its `gate`** — no bespoke result shape, so a caller handles them exactly
like `update_task`.

- **`gate_task`** — `{ref, owner, comment?}`. Moves the parent to
  `awaiting_approval`, clears its claim, and queues every open descendant.
  `owner` is required. Refused on an issue with no children (use status
  `in_review` for a leaf awaiting a human) and while a gate is already
  `pending`; re-gating after `request_changes` is how you resubmit.
  `destructiveHint: true` — it takes a whole subtree out of circulation.
- **`approve_task`** — `{ref, children?, comment?}`. Without `children`: the
  gate resolves, the subtree is released, and the parent is re-derived from its
  children. With `children` (each must be a descendant): only those are
  released and the parent stays parked. `destructiveHint: false` — approving
  only ever widens what may be worked on.
- **`request_changes`** — `{ref, comment}`. `comment` is required and is stored
  as a real comment. The parent returns to `todo` with no automatic
  re-checkout; **the children stay queued.**

**An open gate outranks the automatic close.** A parent normally closes itself
when its last child resolves; one whose gate is `pending` or
`changes_requested` does not, because the review is the remaining work. Answer
the gate and the ordinary rule resumes — `approve_task` on a subtree that has
already finished closes the parent then and there.

None is idempotent: a second whole-gate call is refused rather than absorbed.

The read side carries a **pair**, `gate` and `queuedBy`, as siblings of the
issue on `get_task`, `list_tasks` and every `inbox` entry — the same rule
`claim` and `timing` follow:

- `gate` = `{state, owner, requestedBy, requestedAt, resolvedBy, resolvedAt}`,
  where `state` is `pending | approved | changes_requested`. Non-null means this
  row **holds** a queue. It survives resolution, so a caller re-reading a ticket
  still sees that VP approved it an hour ago.
- `queuedBy` = `{identifier, owner}` — the nearest ancestor holding an active
  gate. Non-null means this row **stands in** a queue, and `checkout_task` on it
  will be refused.

At most one of the two is ever non-null, and which one it is changes the advice
completely: chase the owner, or wait for the row above you.

`inbox` returns three arrays — `ready`, `queued`, `blocked`. An entry in
`queued` with a `gate` and no `queuedBy` *is* the gate; one with `queuedBy` is
behind it. Nothing gated is ever `ready`.

`checkout_task` on a queued issue fails with code **`gated`**, `retryable:
false`, and
`detail: {currentStatus, queuedBy: {identifier, owner}}` — the same triple the
CLI prints and exits `9` on. `steal_if_idle_seconds` does not open it: only the
named human does, via `approve_task`.

The UI server's read routes mirror this exactly, and `/api/agent-context` is
expression-for-expression identical to `get_task`, so the agent-view pane below
shows the gate the agent will actually receive.

### The queue tools

Seven tools over the pickup plan ([queue.md](queue.md)) — an explicit,
human-ordered sequence of what to take next, separate from status, priority and
display grouping.

**Two reads.** **`list_queue`** `{all?, actor?, ws?}` answers
`{revision, entries, effective}`: `entries` is PLAN order — what a human queued,
containers and milestones included — and `effective` is what you actually
receive, with every container expanded depth-first to its open leaf work, the
unqueued band after it in presentation sort, and every row classified
`resolved | gated | blocked | claimed | eligible` with a reason. Every row also
says where it is PLANNED — `milestonePath` (the milestone it belongs to) and
`epicPath` (its ancestor epics), both outermost first and both `[]` when there
is nothing to say — so you can report what you are working towards without a
second lookup.
**`next_task`** `{actor?, ws?}` answers `{revision, next, skipped}`: the one row
you should take and everything it stepped over. Call it before `checkout_task`
and you will never see `out_of_order`.

**Five verbs**, all attributed and all answering the same view:
**`enqueue_task`** `{ref, before?|after?|at?, base_revision?, note?}`,
**`dequeue_task`** `{ref}`, **`move_queue_entry`** `{ref, before?|after?|at?}`,
**`reorder_queue`** `{order}` (every entry, once, atomically) and
**`prune_queue`** (drop the resolved entries). A stale `base_revision` is
refused with `revision_conflict` — the one retryable code a tracker write returns — and the server order
stands. **Reordering the plan is a human's job**: a queue mutation is an
actor-attributed event, so an agent that reorders is visible rather than
forbidden, and you should not reorder work you were told to do.

**`out_of_order` is a THIRD instruction.** With `queue.policy = strict`,
`checkout_task` refuses a row the plan puts later than an eligible one:

```json
{"code":"out_of_order",
 "message":"STA-146 is later in the queue than STA-67, which is ready. Take STA-67, or ask a human to reorder or override.",
 "detail":{"policy":"strict","expected":["STA-67"],"position":14,"expectedPosition":2},
 "retryable":false}
```

A `conflict` means somebody got there first, so pick a different task RIGHT NOW.
A `gated` means a person must act. An `out_of_order` means the work is real,
unclaimed and takeable — just not by you, not yet. **Take
`detail.expected[0]`.** Retrying never clears it; nor does waiting; nor does
`steal_if_idle_seconds`. `checkout_task`'s `override_reason` exists for the
human who decides to step over the plan and is recorded as a `queue_overridden`
event — do not send it on your own initiative, and never to make a refusal go
away.

`inbox`'s READY list is derived from the same resolver, so its order already IS
the effective queue: every entry carries its `position`, and a row the plan
reaches carries `planPosition` too.

### Workspace settings

Two tools read and write the registered workspace settings
([configuration.md](configuration.md#the-settings-registry)). **`get_setting`**
`{key, ws?}` is read-only and answers one value with its provenance —
`{key, scope, value, source, version}`, where `source` is `default` until
someone stores a value and `workspace` after. **`set_setting`**
`{key, value, actor?, ws?}` validates through the registry, logs a
`setting_changed` event with actor, previous and new value, and answers the
same shape with the new value. The first registered control is
**`queue.policy`** (`advisory | strict`, default `advisory`): whether the
pickup queue merely orders work or refuses an out-of-order checkout — read it
before assuming the inbox's order is optional, and change it only because a
human asked. Both tools answer the exact object `staple settings get --json`
prints and `/api/settings` serves under `values`, so no surface disagrees
about a value or where it came from.

### Execution telemetry

Four read-only tools over what execution cost
([execution-telemetry.md](execution-telemetry.md#surfaces)). Each answers the
object the matching CLI command prints with `--json`, because both call one
method:

| Tool | CLI | Returns |
|---|---|---|
| `list_attempts {ref, limit?, cursor?, ws?}` | `staple attempts <ref>` | The issue's attempts, oldest first, each as it reads now: `state`, `outcome` and `endReason` are the effective values, with `storedState` beside them |
| `get_attempt {attempt_id, limit?, cursor?, ws?}` | `staple attempt <id>` | `{attempt, transitions, chain, burn}` |
| `get_budget {account?, reserve?}` | `staple budget` | Per account, each limit's current window, latest sample, `status`, high-water `remainingPercent`, `missing`, and its provisional `pressure` (observed and sustainable pace, ratio, `unsafe`/`within` state, exhaustion and reserve reach at the pace; `safeConcurrency` null until the admission policy) |
| `list_budget_samples {account, since?, limit?, cursor?}` | `staple budget history` | One account's readings, oldest first, each with a derived `regression` flag |

`get_task` carries `attempts: {current, last, count}` beside `claim` and
`timing`: the effectively open attempt, the newest ended one and the number of
attempts, for the worker lane. A held claim with `attempts.current: null` and
`attempts.last.outcome: "interrupted"` means the holder reported an
interruption and has not resumed.

Rules that hold on all four:

- **Bounded.** `limit` defaults to 50 and is clamped to 500. `truncated` is
  stated, never inferred from a full page. `nextCursor` is a keyset position:
  rows added between two pages never shift a page, and a cursor replayed
  against other arguments is refused with `validation`.
- **Coverage.** `coverage: {from, to, itemCount, gaps}` names the span a page
  speaks for and, in `gaps`, the spans nobody was capturing, each with a
  reason: `before_capture_began` for attempts, `stale` (no reading and no
  heartbeat for more than 10 minutes) or `no_sample_yet` for budget readings.
- **Unknown is never 0.** A value that cannot be known is `null` with a reason
  in `missing`. `burn` in particular is `null` with `no_provider_binding` (the
  attempt names no account), `not_on_this_device` (another device opened it,
  and budget data does not replicate), `no_sample_yet`, `source_unavailable`,
  `stale` or `sliding_window`. A measured zero reads `0`.
- **Burn** is, per limit of the attempt's account, the high-water usage at the
  attempt's end minus the usage at its start inside each window instance,
  summed across a reset. A window counts only with a reading inside the
  attempt. Otherwise its delta is `null` with `stale`. A window that began
  inside the attempt starts from `0`, and a moved reset starts from the
  instance it superseded. When no reading precedes the attempt in its window,
  the first reading inside is the start, and `lowerBound: true` says the burn
  is at least that much. The CLI prints it as `≥`. `attribution` is
  `sole_known` only when every count this machine recorded says no other
  attempt ran on the account meanwhile, and `shared` when one did. An unknown
  count gives `null` with a reason. It never claims the usage was the
  attempt's alone.
- **Reads write nothing.** Not the journal, not a stored orphan end and not
  `hub.db`. The attempt tools take `ws`. The budget tools read this machine's
  hub and take none, like `record_budget_sample`.

### Comparing plans

`compare_plans {refs, ws?}` (1 to 20 refs) is `staple compare <ref> ... --json`.
For each named issue it returns:

- `labor`: total labor, with every planned unit counted once. An issue's own
  estimate counts instead of its descendants', never both. A cancelled issue's
  own estimate is excluded, but live work beneath it still counts.
- `coverage`: planned units out of all units, with the unplanned ones named.
- `criticalPath`: the planned path. This is the longest `blockedBy` chain
  inside the subtree, weighted by estimate, with done work included. Blockers
  from outside the subtree are listed separately.
- `remainingPath`: the longest chain over the same graph, with done units weighing 0.
  It can follow a different chain from the planned path.

`overlaps` names a ref that lies inside another ref. `exceedsLabor` flags a
path longer than an own estimate. `partial: true` means a lower bound, never a
silent 0. Use this tool to compare two epics instead of fetching their trees and
adding estimates by hand. For a parent, `get_task` carries the same object as
`planSummary` (null for a leaf). The rules are in
[cli.md](cli.md#comparing-plans-staple-compare).

### Timing quality

`timing_quality {kind?, parent?, since?, include?, exclude?, exclude_reasons?, limit?, cursor?, ws?}`
is `staple timing quality --json`. It answers how much of a population's timing
can be trusted, before you calibrate anything on it:

- Every record has exactly one quality state with its `reasons`. On `get_task`
  they are `timing.quality.work` and `timing.quality.wall`; on an attempt, its
  `quality` beside `effortSeconds`; on a budget sample, reading or burn, its
  `quality` (`provider-unavailable` when the provider does not expose the
  figure, `missing` when capture did not see it).
- Counts and coverage are over the **eligible** population: the done leaves
  in the filter. `ratio.exact` is the estimate ratio over exact records only.
- A record is kept only when its state and the level of every reason it
  carries are kept. `exclude: ["approximate"]` drops every record with an
  approximate reason, reconstructed-and-sparse ones included;
  `include: ["exact"]` is exact records only, the calibration default;
  `include: ["exact", "reconstructed"]` adds clean reconstructed history;
  `exclude_reasons: ["sparse"]` drops records carrying that code. Unknown
  states and codes are refused. Dropped records leave `items` and
  `ratio.admitted`, and `excluded` says how many went. The counts never move,
  and nothing is dropped unless you ask, so `timing-floor` records stay listed.
- The ratio population is the done issues with their own estimate and no
  estimated descendant, so no seconds are summed twice.

The rules are in [cli.md](cli.md#timing-quality-staple-timing-quality).

### Calibration cohorts

`calibration_cohorts {kind?, priority?, parent?, since?, include?, list?, limit?, cursor?, for?, ws?}`
is `staple calibrate --json`. Use it to see how long a class of work takes
against its estimate, from trusted samples only:

- Samples are done issues with their own estimate whose work is `exact`.
  `include: ["reconstructed"]` adds backfilled history as its own set, never
  pooled with exact. Nothing approximate is ever a sample.
- A cohort key is `kind`, `priority`, `workType` (label `type:<x>`), `area`
  (label `area:<x>`) and `model` (pass `--harness` and `--model` on checkout
  so your work lands under the right model). A key with fewer than 5 samples
  falls back to a broader class, and says which and why (`level`, `path`).
- Each cohort gives `samples`, `coverage` with its denominator, the median,
  pooled ratio and range of the ratio, the median `workSeconds`, and
  `rangeConfidence` (how often the range covers the median). `snapshot.id` names the data it
  came from; quote it when you cite a figure.
- Each cohort also gives the ratio's and the work's quantiles (p10 … p90),
  an interval for each and `bounds` for one more sample, aiming at 90%. Read
  `confidence` and `reached` before quoting a range: below 19 samples the
  bounds are the sample range at less than 90%, and the report says so.
  `tail.heavy` means several samples sit far out; `ratio.expected` is then
  clipped at the fences and reads low, and it is never a mean. `floors` lists
  the work under a minute that is never a sample. Check `warnings`
  (`small_sample`, `bounds_below_confidence`, `quantile_below_confidence`,
  `fallback_used`, `heavy_tail`, `floor_dominated`, `floors_excluded`,
  `reconstructed_only`, `no_samples`) before trusting a figure.
- `for: ["STA-42"]` forecasts an issue's duration from the cohort its key
  reads: `seconds` (p10 … p90), `bounds` and `expected`, per evidence set.
  An issue nobody has started matches any model; pass `model` when you know
  the one it will run on. `state: "floor"` means that class's work is mostly
  under a minute (`expected` is the 60-second bound), and `no_estimate` means
  set an estimate first. Quote the forecast with its warnings and the
  snapshot id.
- Along a plan, add only `expected.seconds`. Quantiles and bounds of a chain
  are not the sums of its links' quantiles or bounds.

The rules are in [cli.md](cli.md#calibration-staple-calibrate).

### Forecasts

`forecast {ref, reserve?, account?, model?, ws?}` is `staple forecast <ref> --json`.
Use it before committing to a piece of work, and quote the figures with the
snapshot ids:

- `completion` is how much work is left under `ref`: every plan unit once,
  each from its calibrated duration less the work already done on it.
  `labor.expectedSeconds` adds the units; `path.expectedSeconds` is the longest
  chain of remaining work (effort, not calendar time). Read the band
  (`simulated.band`, 90% under a model that treats units as independent) and
  `confidence.achieved` together: the band is no surer than its classes.
- `partial: true` (or `unknown_units` in `warnings`) means some unit has no
  forecast: estimate it, or say the figure is a lower bound. Units in review
  weigh 0 as work but leave the subtree `settled: false` (`review` lists them):
  do not report such a subtree as finished. `few_admissible` means a unit in
  progress has only a handful of longer samples left to draw from.
- `budget` is this machine's provider limits, never blended into completion:
  per limit, what is left, when it resets, how fast it is going, the work
  rate with its `confidence`, and for this work `remainingAtResetPercent` and
  `reserve.breachProbability` (the work alone, through every window it runs
  in; `withOtherUse` adds the account's other use). Pass `reserve` when you
  have one; without it a provisional 20% applies and `reserve.source` says so.
  A null figure has its reason in `missing`: do not read it as 0 or as room
  to spare, and treat a `low`-confidence breach figure as a guess.

The rules are in [cli.md](cli.md#forecasts-staple-forecast) and
[timing-semantics.md](timing-semantics.md#forecasts).

## Harness ergonomics

All in-protocol, so a harness never needs out-of-band setup:

- **The server starts from any directory.** With no workspace above the working
  directory, tools answer `not_found` *with instructions* instead of crashing
  the connection. The `init` tool creates a workspace headlessly, and every
  workspace tool takes an optional `ws` (hub slug or prefix) to target any
  registered workspace per call.
- **Writes require an identity.** Pass `actor` per call or set `STAPLE_AGENT`.
  There is no silent default: a misconfigured harness fails loudly rather than
  polluting the audit trail with anonymous writes.
- **Replay is explicit.** `add_comment` takes an `idempotency_key`; replayed
  creates and comments come back with `replayed: true`.
- **Tools declare annotations** — 21 read-only, `checkout_task` and `set_estimate` idempotent — and
  return `structuredContent` (arrays wrap as `{items}`).
- **List tools paginate**: `{items, nextCursor, hasMore}` with opaque cursors.
  The telemetry lists answer `{items, truncated, nextCursor, coverage}` instead
  ([below](#execution-telemetry)).
- `get_task` includes cross-workspace blockers and can inline document bodies
  with `include_documents: true`.

## What the agent actually receives

The web UI has an "agent view" pane that renders the exact `get_task` payload
for an issue, both with and without `include_documents`, plus its token cost.
It exists because a human hands over an issue believing the ticket says one
thing while the agent receives a payload that says something slightly
different, and nothing else shows the two side by side.
