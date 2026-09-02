# CLI

## At a glance

```
staple init [--global <slug>]         staple start|done|cancel|release <ref>
       (repo-local also writes .staple/AGENTS.md, never clobbering an edited one)
staple new <title> [--parent R]       staple block <ref> --owner O --action TEXT
       [--blocked-by R1,R2] [-p prio] staple blocked-by <ref> R1,R2 | --none
staple ls | show <ref> | tree | board staple link <blocker> <blocked>   (cross-ws)
staple inbox [--hub] [--assignee A]   staple doc <ref> <key> [--put f --base N]
staple events [--since N]             staple hub [ls|links|events]
staple open [--port 4400] [--hub]     staple config [show|set|home]
staple migrate [--yes]                staple doctor [--json] [--fix --only <check>]
staple install [status|--rollback]    staple add <path> --yes | discover <root>

staple wait <ref> [--timeout s] [--interval ms]     block until ready or finished
staple events --follow [--since N] [--max N]        stream events as they land
       [--exec CMD]                                 run CMD per event (JSON arg + $STAPLE_EVENT)

staple start <ref> --steal-if-stale <30m|2h|3600>   take over a dead agent's claim
staple release <ref> --if-stale <dur>               free a dead agent's claim
```

`staple help` has the full option list. `checkout` is an alias for `start`, and
`staple ui` is a compatibility alias for `staple open`.

## Workspace vocabulary

Statuses and kinds are per-workspace configuration, not constants. Every
subcommand takes `--json`, and every write prints the full new list — a reorder
is only verifiable against the whole thing.

```bash
staple statuses ls                       # id, category, label, in configured order
staple statuses add awaiting_approval --category gated --after in_review
staple statuses rename todo --label "Ready"
staple statuses recategorize in_review --category gated
staple statuses reorder in_progress,in_review,blocked,todo,backlog,done,cancelled
staple statuses rm on_hold --migrate-to backlog

staple kinds ls | add | rename | reorder | rm     # same verbs, no categories
```

`--category` is required on `add` and is one of `unstarted`, `ready`, `active`,
`review`, `gated`, `blocked`, `done`, `cancelled`. That category is where a
status's behaviour comes from — see [semantics.md](semantics.md#categories--why-a-configurable-status-set-is-still-safe).
`--label` is optional: `awaiting_approval` becomes `Awaiting Approval`.

The configured order is the canonical order everywhere — `board` columns, group
headers, tree sort — so a reorder changes what everyone in the repo sees.

`rm` refuses with exit 4 while issues still carry the status (pass
`--migrate-to`), and with exit 2 when it is the last status of a category staple
writes into.

## Estimates vs actuals

One stored number and a handful of read-time derivations, so you can say what
agentic execution actually cost against the plan-time human figure.

```bash
staple new "Port the claim guard" --estimate 90m   # record it WHEN YOU PLAN
staple status STA-42 in_progress --estimate 2h     # re-estimate
staple status STA-42 backlog --no-estimate         # clear it
```

Durations use the same vocabulary as `--if-stale`: `90s`, `30m`, `2h`, `3d`, or
a bare number of seconds. An estimate must be a positive whole number of
seconds and at most 365 days — `--estimate 0` is refused, because "estimated at
nothing" and "no estimate recorded" are different facts and only one of them
has a dedicated flag.

**Only the estimate is stored.** The actual is `activeSeconds`, reconstructed
at read time by replaying the event log into `in_progress` **intervals** —
entering opens one, leaving closes one. Three things follow, and each was a
real complaint about the earlier two-timestamp version:

- **Blocked and parked time is free.** `in_progress → blocked → in_progress` is
  two intervals, and the week in between is simply not one. No special case
  needed; a `now − startedAt` span had no way to express it.
- **The clock stops when the agents do.** An open interval ends at the holder's
  `lastActivityAt` — the same derivation the stale-claim badge uses — and never
  at `now`. An agent that died on Friday is not several days deeper into its
  estimate by Monday. `countedThrough` reports where the clock stopped.
- **An epic has no stopwatch.** An interval opened by staple's own "a child
  started, so the parent is in progress" flip is excluded. A parent's actual is
  the **aggregation of its children**; `ownActiveSeconds` sits beside it and is
  normally `null`.

The honest limit: this measures an agent's **write cadence**. Twenty silent
minutes before a crash are not counted. Under-counting silence beats billing a
dead process for a weekend — the second error compounds without limit.

`in_review` is measured separately as `reviewSeconds` and never folded into the
actual: waiting on a human reviewer is a queue, not execution. It surfaces only
when nonzero. A workspace imported from another tool, with no usable event log,
falls back to `completedAt − startedAt` with `approximate: true`, which every
surface renders as "approx".

Nothing is cached, and there is deliberately no `active_seconds` column: a
derived reading frozen onto an entity you serialize, hand to an MCP client and
hold for a session is a number that stopped being true the instant it was
written. This is the same rule `claim` follows, and for the same reason — so
timing rides **beside** the issue, never on it:

```bash
staple show STA-42
# status in_progress (v3) · priority high · @claude · held by claude
# claim  held 3h · silent 2m (last activity 2026-09-02T00:40:45Z)
# time   est 2h · ran 3h10m · counted through 2026-09-02T00:40:45Z
```

`--json` and the MCP/HTTP read payloads carry the full object as `timing`, plus
`childrenTiming` keyed by child identifier:

```json
{"timing":{"estimatedSeconds":14400,"ownActiveSeconds":null,"activeSeconds":15000,
  "reviewSeconds":null,"approximate":false,"countedThrough":null,"childCount":3,
  "childrenEstimatedSeconds":12600,"childrenActiveSeconds":15000,
  "childStatusCounts":{"backlog":1,"todo":0,"in_progress":1,"in_review":0,
                       "done":1,"blocked":0,"cancelled":0}},
 "childrenTiming":{"STA-43":{"estimatedSeconds":5400,"activeSeconds":3600,"…":"…"}}}
```

Rollups sum **direct children only**, and each child contributes its own
`activeSeconds` — so a child that is itself a parent contributes its aggregate,
which is exactly the number its row on screen shows. The table adds up, and an
epic-of-epics reports its grandchildren's work rather than zero. Estimates stay
strictly depth-1, because a parent's estimate is a plan for its whole subtree
and adding it to its children's would double-count the plan. A sum is `null` —
never `0` — when no child contributed one.

Every surface takes it: MCP `create_task` / `update_task` via `estimate_seconds`
(explicit `null` clears, absent leaves alone), HTTP `create` / `update` via
`estimateSeconds`, and the CLI as above. `list_tasks` and `inbox` carry the
scalar `estimatedSeconds` but not the rollup object — those shapes exist to
make choosing a task cheap.

## Machine-readable output

`--json` is a global flag on every task command (`ls`, `show`, `inbox`, `board`,
`tree`, `events`, `start`, `done`, `new`, `doc`, …). It emits the store objects
unformatted, so timestamps are full ISO-8601 with a `Z` suffix rather than the
truncated forms the human tables print. `events --json` emits **NDJSON** — one
event object per line. Human output is unchanged when the flag is absent.

Errors under `--json` are a single line of JSON on **stderr**, carrying the same
fields on every surface (the MCP server nests it under an `error` key in its
text block; the UI server adds a legacy `error` alias for `message`):

```json
{"code":"conflict","message":"Checkout refused: …","detail":{"currentStatus":"in_progress","heldBy":"other-agent","blockers":[]},"retryable":false}
```

`retryable` is the branchable bit: only `revision_conflict` is worth retrying.
A checkout conflict means *pick a different task*.

## Exit codes

Exit codes let CI branch without parsing stderr:

| code | meaning | | code | meaning |
|---|---|---|---|---|
| 0 | success | | 4 | `conflict` |
| 1 | unknown error | | 5 | `duplicate` |
| 2 | `validation` | | 6 | `cycle` |
| 3 | `not_found` | | 7 | `revision_conflict` |
| | | | 8 | `timeout` (`wait` only) |
