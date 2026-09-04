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

staple gate <ref> --owner O [-m text]               park a PARENT on a human; queue its subtree
staple approve <ref> [--children R1,R2] [-m text]   release the whole queue, or only what you name
staple request-changes <ref> -m text                send it back; the children stay queued
```

`staple help` has the full option list. `checkout` is an alias for `start`, and
`staple ui` is a compatibility alias for `staple open`.

## Workspace vocabulary

Statuses and kinds are per-workspace configuration, not constants. Every
subcommand takes `--json`, and every write prints the full new list — a reorder
is only verifiable against the whole thing.

```bash
staple statuses ls                       # id, category, label, in configured order
staple statuses add needs_qa --category review --after in_review
staple statuses rename todo --label "Ready"
staple statuses recategorize in_review --category gated
staple statuses reorder in_progress,in_review,awaiting_approval,blocked,todo,backlog,done,cancelled
staple statuses rm on_hold --migrate-to backlog

staple kinds ls | add | rename | reorder | rm     # same verbs, no categories
```

`--category` is required on `add` and is one of `unstarted`, `ready`, `active`,
`review`, `gated`, `blocked`, `done`, `cancelled`. That category is where a
status's behaviour comes from — see [semantics.md](semantics.md#categories--why-a-configurable-status-set-is-still-safe).
`--label` is optional: `needs_qa` becomes `Needs Qa`.

The configured order is the canonical order everywhere — `board` columns, group
headers, tree sort — so a reorder changes what everyone in the repo sees.

`rm` refuses with exit 4 while issues still carry the status (pass
`--migrate-to`), and with exit 2 when it is the last status of a category staple
writes into.

## Kinds

Every issue declares a **kind** — `epic`, `task`, `bug`, `chore` or `spike` out
of the box, plus whatever else `staple kinds add` put in this workspace.

```bash
staple new "Login 500s on retry" --kind bug
staple new "Q3 billing rework" --kind epic
staple ls --kind epic                 # only epics
staple ls --kind bug,chore            # comma-separated, like --status
```

The default is `task`, and an unconfigured kind is refused with exit 2 naming
the valid set. **Kind is declared, never derived**: a task that grows subtasks
stays a task until somebody re-declares it (`update_task` over MCP, or the UI).
The one exception was a one-shot backfill in migration 005, which marked every
issue that already had children as an `epic` at upgrade time.

`ls`, `tree` and `inbox` print the kind only when it is *not* `task` — a bare
row is a task — so an epic or a bug stands out without a column of noise on
every other line. `staple show` always names it.

Every kind also has an **appearance** — the web icon it wears, its accessible
label, and the character a terminal prints instead. `staple kinds ls` leads
each row with that terminal fallback (`◆ epic`, `◇ task`, `✱ bug`, `↻ chore`,
`↯ spike`, `⚑ milestone`; `•` for a kind nobody has given a mark), and
`--json` carries the whole record on each row as `appearance:
{ source, value, label, fallback }` — the same record MCP `list_kinds` and
`/api/settings` serve. It is stored as the workspace setting
`kinds.appearance` (see [configuration.md](configuration.md#the-settings-registry));
the CLI only reads it.

`source` names where the web icon comes from, and each source bounds its
`value`:

| `source` | `value` | bound |
| --- | --- | --- |
| `lucide` | a canonical Lucide key (`triangle-alert`) | lowercase words joined by dashes, at most 64 characters |
| `emoji` | an emoji or short Unicode glyph (`🚀`, `→→`) | 1 to 2 **grapheme clusters** (a joined family or a flag is one), at most 32 UTF-16 units, no whitespace or control characters, at least one visible code point |
| `svg` | the sanitiser's **canonical** SVG document | at most 8 KiB, one `<svg>` root with a `viewBox` within ±4096, sanitised as described in [web-ui.md](web-ui.md#custom-glyphs) |
| `none` | `""` | draw the built-in mark |

An `svg` value is accepted only as the sanitiser's own output — a raw document,
however clean, is refused with a sentence saying to sanitise it first, and a
hostile one (a `<script>`, an event handler, an external `href`, an oversized
document) is refused with the reason. So the database, `kinds ls --json`,
`list_kinds` and `/api/settings` never carry anything but canonical, inert
markup, and the human `kinds ls` prints the terminal `fallback`, never the
document. A stored record that no longer validates — one hand-edited on disk,
say — is refused at read with the key in the sentence rather than served.

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
                       "done":1,"blocked":0,"cancelled":0},
  "subtreePlan":{"estimatedSeconds":14400,"source":"own",
                 "descendantsEstimatedSeconds":12600,"contributingCount":2,"totalCount":3}},
 "childrenTiming":{"STA-43":{"estimatedSeconds":5400,"activeSeconds":3600,"…":"…"}}}
```

Rollups sum **direct children only**, and each child contributes its own
`activeSeconds` — so a child that is itself a parent contributes its aggregate,
which is exactly the number its row on screen shows. The table adds up, and an
epic-of-epics reports its grandchildren's work rather than zero. Estimates stay
strictly depth-1 in `childrenEstimatedSeconds`, because a parent's estimate is
a plan for its whole subtree and adding it to its children's would double-count
the plan. A sum is `null` — never `0` — when no child contributed one.

**The recursive plan** is `subtreePlan`, beside that field rather than in its
place, and it survives an epic-of-epics with one rule: an issue contributes its
**own estimate if it has one, otherwise the sum of its children's
contributions** — never both. So a parent's plan and its descendants' plans
cannot both land in one ancestor total, and a middle-level epic nobody
estimated passes its children's plan straight up. The fields:

- `estimatedSeconds` — the **effective (top-down) plan**, the one number an
  ancestor counts this issue as: the own estimate when recorded, otherwise
  `descendantsEstimatedSeconds`, `null` when neither exists.
- `source` — `own`, `descendants` or `none`: which fed `estimatedSeconds`.
- `descendantsEstimatedSeconds` — the **bottom-up plan**, the sum of the
  direct children's effective plans. Kept visible even when an own estimate
  wins, so the 4h epic above, over 3h30m of planned children, shows the
  disagreement instead of one side quietly winning.
- `contributingCount` / `totalCount` — coverage over descendants at **every
  depth**: how many contributed their own estimate to the bottom-up sum, out
  of how many exist. A descendant shadowed by an estimated ancestor beneath
  this issue is not counted — and not lost; it is on its own timing.

A middle epic with no estimate over three leaves at 4h/3h/4h therefore
reports an 11h plan, and its parent includes that 11h whether or not the
middle level was estimated. `staple show` adds one segment per parent:
`plan 11h (from 3 of 3 descendants)` when the plan was inherited, or
`descendants est 11h (3 of 3)` beside `est` when an own estimate wins.

Every surface takes it: MCP `create_task` / `update_task` via `estimate_seconds`
(explicit `null` clears, absent leaves alone), HTTP `create` / `update` via
`estimateSeconds`, and the CLI as above. `list_tasks` and `inbox` carry the
scalar `estimatedSeconds` but not the rollup object — those shapes exist to
make choosing a task cheap.

## Approval gates

A **gate** parks a *parent* on a named human and takes its whole subtree out of
circulation until that person answers. It is the counterpart of `block`: a
blocker waits on other work, a gate waits on a person.

```bash
staple gate <ref> --owner O [-m text]                 park it; every open descendant is queued
staple approve <ref> [--children R1,R2] [-m text]     release the queue — all of it, or only these
staple request-changes <ref> -m text                  send it back; children stay queued
```

- **`gate`** moves the parent to `awaiting_approval` and clears its claim.
  `--owner` is required. Refused on a leaf (`in_review` is the status for a leaf
  waiting on a human) and while a gate is already `pending`; re-gating after
  `request-changes` is allowed, and is how you resubmit.
- **`approve`** with no `--children` resolves the gate, releases the whole
  subtree, and re-derives the parent from its children. With `--children` it
  releases only those refs — which must be descendants — and everything
  underneath them, leaving the parent parked and the gate active.
- **`request-changes`** requires `-m`, and does exactly this: *posts your note as
  a comment on `<ref>`, returns it to todo for the next agent, and keeps the
  queued children parked until you approve.* No automatic re-checkout; the queue
  holds until an `approve` or a fresh gate cycle. The web UI calls this action
  **Send back** and prints that same sentence above the note field. The command
  name is unchanged — the label was the thing that was unclear, not the verb.

### What is actually queued

Four rules decide what a gate holds, and every surface — `inbox`, the checkout
guard, the `[queued: …]` cue on `ls`, and the reviewer's checklist in the web UI
— reads the same answer (STA-154):

- **(a) Only OPEN work is queued.** `done` and `cancelled` issues under a gated
  parent carry no `queuedBy`, are never listed for approval and are never
  counted. Finished work is not being held back from anyone.
- **(b) A parent with nothing open underneath is not queued.** It has nothing to
  release, so approving it would be a no-op. An open **leaf** is still queued —
  it *is* the work.
- **(c) Approving some children releases them and everything under them, at
  once.** They stop reading queued immediately; you do not re-run anything. The
  parent stays parked and the gate stays active.
- **(d) A subtree behind its own inner gate is not yours to release.**
  `queuedBy` names the *nearest* gate, so that decision belongs to whoever holds
  it.

Semantics and the tests that pin each rule are in
[semantics.md](semantics.md#approval-gates).

```console
$ staple gate STA-142 --owner VP -m "Schema plus the three CLI verbs — ok to build on this?"
⊙! STA-142   awaiting_approval Q: approval gates — park a parent for VP review …  [awaiting VP]

$ staple approve STA-142 --children STA-145 -m "Q3 docs can proceed."
⊙! STA-142   awaiting_approval Q: approval gates …  [released STA-145; still awaiting VP]

$ staple request-changes STA-142 -m "Split the queuedBy derivation out."
○! STA-142   todo        Q: approval gates …  [changes requested; children stay queued]

$ staple approve STA-142
◐! STA-142   in_progress Q: approval gates …  [gate approved]
```

`ls` marks both sides of a gate — `[awaiting VP]` on the holder,
`[queued: STA-142/VP]` on the work behind it — and `show` gives the gate its own
lines, printed for a resolved gate too, so the review leaves a trace:

```console
gate:  awaiting VP (requested opus-q3 2026-09-02T22:00:46Z)
queued: behind STA-142, awaiting approval by VP — checkout is refused until then
```

### The QUEUED section of the inbox

`staple inbox` grows a third section between READY and BLOCKED, printed only
when it is non-empty. QUEUED is work a **human** must release; BLOCKED is work
waiting on other **work**. Gate holders are listed first inside the section —
the one row a person can act on should not sit under the three tickets it is
holding — while `--json` and the MCP/HTTP payloads keep the store's ordinary
pickup order.

```console
READY (pickup order):
  ◌! STA-61    backlog     L1: scaffold Docusaurus site (single locale) replacing the POC
QUEUED (waiting on a human — checkout is refused):
  ⊙! STA-142   awaiting_approval Q: approval gates — park a parent for VP review …  [awaiting VP]
  ◐! STA-143   in_progress Q1: gate model in the store … @opus-q1  [awaiting VP on STA-142]
  ◌! STA-144   backlog     Q2: gates in the web UI …  [awaiting VP on STA-142]
BLOCKED:
  ⊘! STA-80    blocked     T: estimates vs actuals …  [waiting on VP: schedule the brainstorm]
```

`inbox --json` is `{"ready":[…],"queued":[…],"blocked":[…],"hasMore":false}`;
every entry carries `gate` and `queuedBy` beside `unresolvedBlockers` and
`claim`. An entry with a `gate` and no `queuedBy` **is** the gate; an entry with
`queuedBy` is standing behind the one it names. `staple inbox --hub` goes
through the hub's unified list and carries no gate cue today — checkout is still
refused, it is just less informative.

### Exit code 9 and the `gated` error

Checkout of a queued issue fails with its own exit code so a shell loop can tell
"take another task" from "wait for a person":

```console
$ staple checkout STA-144
error(gated): STA-144 is queued behind STA-142, awaiting approval by VP. Pick a different task — approval is a human action, not a retry.
$ echo $?
9
```

`--steal-if-stale` does not open it: a stale holder and a closed gate are
unrelated facts. The only thing that clears it is the owner running `approve`.
The `--json` form carries the gate in `detail`, identically on the CLI, MCP and
HTTP surfaces:

```json
{"code":"gated","message":"STA-144 is queued behind STA-142, awaiting approval by VP. Pick a different task — approval is a human action, not a retry.","detail":{"currentStatus":"backlog","queuedBy":{"identifier":"STA-142","owner":"VP"}},"retryable":false}
```

The three write commands emit the parent issue plus its `gate` under `--json`,
so they read like any other write; `approve` adds `releasedChildren`, which is
what distinguishes a partial approval from a whole one:

```json
{"identifier":"STA-142","status":"awaiting_approval","…":"…",
 "gate":{"state":"pending","owner":"VP","requestedBy":"opus-q3",
         "requestedAt":"2026-09-02T22:00:46.381Z","resolvedBy":null,"resolvedAt":null},
 "releasedChildren":["STA-144"]}
```

`gate.state` is `pending | approved | changes_requested`. `ls --json`,
`show --json` and `inbox --json` carry the same `gate` object plus `queuedBy`
(`{identifier, owner}`) as siblings of the issue — never fields *on* it, the
same rule `claim` and `timing` follow. At most one of the pair is ever non-null.

Semantics, and the tests behind each rule, are in
[semantics.md](semantics.md#approval-gates).

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
| | | | 9 | `gated` (a review gate above it is unresolved) |
