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
                                      staple hub unregister <slug|prefix> | prune | unlink
staple open [--port 4400] [--hub]     staple config [show|set|home]
staple migrate [--yes]                staple doctor [--json] [--fix --only <check>]
staple install [status|--rollback]    staple add <path> --yes | discover <root>
staple settings [get <key>|set <key> <value>]       this workspace's registered settings

staple wait <ref> [--timeout s] [--interval ms]     block until ready or finished
staple events --follow [--since N] [--max N]        stream events as they land
       [--exec CMD]                                 run CMD per event (JSON arg + $STAPLE_EVENT);
                                                    on a synchronized workspace this includes the
                                                    status and blocker events other devices'
                                                    changes re-emit here (payload.deviceId)

staple estimate <ref> <dur> | <ref> --clear         change only the estimate (no status to restate)
staple compare <ref> [<ref> ...]                    total labor, estimate coverage and critical path
                                                    of named issues, with no tree dump
staple forecast <ref> [--reserve P]                 remaining labor and chain from calibrated durations,
                                                    and apart, what the work costs each provider limit

staple start <ref> --steal-if-stale <30m|2h|3600>   take over a dead agent's claim
staple release <ref> --if-stale <dur>               free a dead agent's claim
staple start|done|cancel|status|estimate|release … --agent A   who acts; else $STAPLE_AGENT, else $USER
staple <any write> … --ack-renumber                 write through a number sync renumbered here
                                                    (docs/sync.md, "A number that moved under a caller")

staple gate <ref> --owner O [-m text]               park a PARENT on a human; queue its subtree
staple approve <ref> [--children R1,R2] [-m text]   release the whole queue, or only what you name
staple request-changes <ref> -m text                send it back; the children stay queued

staple milestone ls | show <ref>                    dated, ordered plans (needs the `milestone` kind)
staple milestone new <title> [--target D] [--from-epic R] [--preview]
staple milestone add|rm <milestone> <ref> [--base N] | mv <ref> --to M | reorder M <r1,r2>

staple queue [--all] [--effective]                  the plan, and the order agents receive
staple queue next [--actor A]                       the one row to take, and what it skipped
staple queue add|rm <ref> [--at N] [--base N] | mv <ref> --at N | reorder <r1,r2> | prune
staple checkout <ref> --override -m <why>           take a row out of turn, on the record

staple budget ingest --source claude-statusline [--tee] [--account A]   a status-line reading (stdin)
staple budget ingest --source codex-rollout <file> [--account A]        a Codex rollout's readings
staple budget ingest --source manual --account A --limit-key K --used P [--resets-at T]
staple budget capture on|off | bind --source S --account A | unbind | bindings
staple budget setup [--claude-account A] [--codex-account B] [--yes]   one consent: capture, bindings, wrapper, watcher
staple budget unsetup [--yes] | status | collect [--max-files N]

staple attempt pause|resume|milestone|interrupt <ref> [--reason R] [-m label] [--role R | --attempt ID]
                                                    report on the attempt you hold
staple attempt open|end <ref> --role orchestrator   coordinate an issue without claiming it (orchestrationSeconds)
staple attempt reconstruct                          rebuild attempts from events recorded before them
staple attempts <ref> [--limit N] [--cursor C]      every attempt on the issue, as it reads now
staple attempt <attempt-id>                         one attempt: transitions, chain, budget burn
staple budget [--account A] [--reserve P]           each account's current windows, remaining budget and pressure
staple budget history --account A [--since T]       one account's readings, with capture gaps
staple checkout|status|done ... [--harness H --harness-session ID] [--model M] [--account A] [--attempt-key K]
staple release|status|done ... --outcome failed --reason R   only the agent says it failed
```

`staple help` has the full option list. `checkout` is an alias for `start`, and
`staple ui` is a compatibility alias for `staple open`.

## The machine registry

`staple init` adds a row to `~/.staple/hub.db`; three verbs take one back out.

```bash
staple hub ls                              # what is registered, and whether its file is there
staple hub unregister <slug|prefix>        # drop ONE row, releasing its prefix
staple hub prune                           # preview every row whose path is gone
staple hub prune --yes                     # …and remove them
staple hub unlink <blocker> <blocked>      # drop ONE cross-workspace link
```

**Unregistering removes a registry row and nothing else.** The workspace
database and every file beside it are left untouched — byte-for-byte, not merely
present — so nothing is lost by unregistering a workspace you still want. The
prefix it held becomes available again for the next workspace that derives the
same base.

**A workspace that is still on disk will register itself again.** The hub is
*derived* state: the authoritative slug and prefix live in the workspace file,
and the next staple command run inside that repository re-registers it from
them. Unregister is for tidying the registry, not for hiding a workspace from
it. For the rows it is really for — scratch directories that have since been
deleted — there is nothing left to re-register, so `prune` is permanent.

`prune` previews by default: it prints the rows it would remove, writes nothing,
exits 0, and names the command that would do it. Only `--yes` removes anything.
A row is a candidate only when its recorded file is absent; a workspace that is
present is never touched, whichever of macOS's two spellings its path uses.

Cross-workspace links are the one thing that can refuse an unregistration.
A link naming a workspace the hub no longer knows would report as an
unresolvable blocker, which the readiness rule treats as *blocked* — so the
issue on the other side would be blocked permanently with nothing to explain
why. Rather than dangle it or delete it silently, staple refuses and lists the
links (exit 4, `conflict`). Two ways forward: remove them individually with
`staple hub unlink`, or pass `--with-links` to remove them along with the
registration. `staple hub prune` applies the same rule per row — an encumbered
dead row is *kept and reported* while the rest are removed, so one stubborn
entry cannot block the whole cleanup.

The same three verbs are on MCP as `hub_unregister`, `hub_prune` (which previews
unless you pass `apply`) and `cross_unlink`.

`staple doctor` is read-only. Its `schema` check names the database schema, the
running build's schema (and whether that build is a checkout, a bundle or an
installed runtime), the launcher's selected runtime, and the config schema; on a
mismatch it prints ONE repair command under `REPAIRS`, derived from what
`staple install` accepts, and previews whether the next open migrates the
database and where the snapshot goes. Under `--json` the reason is
`data.code` (`database_newer_than_runtime`, `config_newer_than_runtime`,
`selected_runtime_older_than_database`, `migration_pending`, or `null`). See
`docs/migration.md`.

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

## Workspace settings

Registered workspace settings (see
[configuration.md](configuration.md#the-settings-registry)) have the
workspace twin of `config`: `settings` reads and writes the values this
workspace stores, never the machine's `config.json`.

```bash
staple settings                          # every registered value:  key = value  (source)
staple settings get queue.policy         # queue.policy = advisory  (default)
staple settings set queue.policy strict  # queue.policy = strict  (workspace)
staple settings get queue.policy --json  # {"key":"queue.policy","scope":"workspace","value":"strict","source":"workspace","version":1}
```

`source` says where the effective value came from — `default` until someone
sets it, `workspace` after. `--json` prints the same object `/api/settings`
serves and the `get_setting` tool answers. A value the schema refuses
(`queue.policy` takes `advisory` or `strict`) exits 2 naming the key; a global
key exits 2 naming `staple config set`. Every write is attributed to
`STAPLE_AGENT` and logged as a `setting_changed` event with the previous and
new value.

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
label, and the character a terminal prints instead. `ls`, `tree` and `show`
**lead each row with that terminal fallback**, one character then a space, so a
kind is legible without colour and `staple ls | grep '^◆'` is the epic filter:

```
◆ ◌  STA-31    backlog     Q3 billing rework · epic
  ◇ ◌! STA-66  backlog     Split the invoice job
✱ ⊘  STA-72    blocked     Login 500s on retry · bug
```

`show` leads its header line and its child rows the same way. The confirmation
lines of the write commands (`new`, `done`, `status`, `checkout`, `release`,
`block`) and the `inbox`/`board` sections are deliberately left bare: they
render one known ticket, not a list to scan, and their column offsets are a
de-facto contract. `staple kinds ls` leads
each row with that terminal fallback (`◆ epic`, `◇ task`, `✱ bug`, `↻ chore`,
`↯ spike`, `⚑ milestone`; `•` for a kind nobody has given a mark), and
`--json` carries the whole record on each row as `appearance:
{ source, value, label, fallback }` — the same record MCP `list_kinds` and
`/api/settings` serve. It is stored as the workspace setting
`kinds.appearance` (see [configuration.md](configuration.md#the-settings-registry));
the CLI only reads it. `staple show --json` carries the resolved record for the
issue's own kind as `kindAppearance`, beside the string `kind` — the same record,
joined once, so a consumer that draws a ticket need not fetch the vocabulary to
do it. List rows do not repeat it: an appearance belongs to the kind, not to the
issue.

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

`kinds rm milestone` is the one removal `--migrate-to` cannot force: it is
refused with exit 2 naming every milestone that still owns members or dates
(clear them with `staple milestone rm` and `staple milestone set --target none`
first) — see [milestones.md](milestones.md).

## Milestones

A milestone is a dated, human-ordered plan that may contain epics and tasks
from anywhere in the tree **without moving them** — the full contract is
[milestones.md](milestones.md). It is an ordinary issue of the reserved
`milestone` kind, which is not seeded: run `staple kinds add milestone --label
Milestone` once per workspace, or every command below is refused with exit 2
naming that command.

```bash
staple milestone new "October cut" --target 2026-10-31 --from-epic STA-66 --preview
staple milestone new "October cut" --target 2026-10-31 --from-epic STA-66
staple milestone add STA-190 STA-146                 # appended
staple milestone add STA-190 STA-68 --before STA-66  # pulled forward; also --after R, --at N
staple milestone mv STA-68 --after STA-146           # or --to <milestone> to move it out
staple milestone reorder STA-190 STA-68,STA-66,STA-146 --base 3
staple milestone rm STA-190 STA-146
staple milestone set STA-190 --start 2026-10-01 --target none
staple milestone ls [--all]                          # --all includes done and cancelled
staple milestone show STA-190
```

- **`--from-epic` adds the epic as the one member.** Its children come along
  by descent — through progress and through the queue — and are never copied
  in, so the epic's hierarchy is the milestone's structure and nothing is
  re-parented. `--preview` prints the exact plan (`+ member STA-66 at 1`,
  `hierarchy changes: none`) and writes nothing; the commit makes exactly those
  changes. The title defaults to the epic's.
- **Membership is not hierarchy.** `add` changes nothing about the member —
  parent, depth, blockers, status, claim, gate — and `staple tree` is
  unchanged. An issue is a direct member of at most one milestone; adding it to
  a second is refused naming the first, and `mv --to` is the move. A milestone
  cannot be a member.
- **Dates are UTC calendar days**, `YYYY-MM-DD`, inclusive: a target of
  `2026-10-31` is due by the end of that day and overdue from the next UTC
  midnight. `none` clears one. `set` takes only the dates; title, description,
  assignee and status are edited with the ordinary commands.
- **Order is durable and independent** — a column, not a sort; priority,
  creation time and tree position never reorder it. `show` prints the members
  revision; `--base N` on `add`/`rm`/`mv`/`reorder` refuses a stale one with
  exit 7 (`revision_conflict`, retryable) and leaves the order standing. Without
  `--base` the CLI writes blind.
- **Progress counts each leaf once**: `done/countable percent` over the leaves
  reachable from the members, a parent never counted, a task reached through
  its epic and as a direct member counted once, cancelled leaves out of the
  denominator. `state` is derived — `done`, `cancelled`, `overdue`, `active`,
  `planned` — never stored.
- A non-milestone given where a milestone is expected is exit 2 naming its
  kind (`STA-66 is an epic, not a milestone.`); an unknown reference is exit 3;
  `rm` of a non-member is exit 3.

`--json` on every subcommand prints the one shape MCP and the UI server
return: `{milestone, progress, revision, members, next}` — see
[milestones.md](milestones.md#operations-by-surface).

## The pickup queue

An explicit, human-ordered plan of what agents pick up next, separate from
status, priority and display grouping — the full contract is
[queue.md](queue.md). Nothing is seeded and nothing changes until somebody
queues something: an empty plan leaves `inbox` exactly as it was.

```bash
staple queue add STA-66                      # appended; an epic or a milestone is fine
staple queue add STA-146 --before STA-66     # also --after R, --at N (1-based plan position)
staple queue mv STA-146 --at 1 --base 4
staple queue reorder STA-31,STA-66,STA-146 --base 5
staple queue rm STA-31
staple queue prune                           # drop the done and cancelled entries
staple queue                                 # PLAN order, expansions indented
staple queue --effective                     # EFFECTIVE order, with the eligibility column
staple queue next --actor codex-1            # what to take, and what it stepped over
```

- **Two orders, both shown.** `queue` prints PLAN order — the rows a human put
  there — with each queued container's expansion indented under it and a
  `→ n eligibility` cue giving every leaf its effective position. `--effective`
  prints the order an AGENT receives. A container is never a row an agent can
  take: a queued epic expands depth-first to its open leaf work, and a
  milestone expands to its members in membership order. `--effective` adds a
  `path` column — the milestone the row is planned under, then its ancestor
  epics — which `--json` carries as `milestonePath` and `epicPath` on every row.
- **The plan is a prefix, not a filter.** Everything not queued follows the plan
  in the ordinary presentation sort, so unqueued work is still work — just
  later. `--all` keeps resolved entries visible; by default they are hidden and
  `prune` removes them.
- **Every row is classified, and none is dropped**: `resolved`, `gated`,
  `blocked`, `claimed`, else `eligible` — the first that matches, with a reason.
  A blocker, a gate, a live claim and a resolved status refuse exactly as they
  always have; rank cannot lift any of them.
- **Order is durable and independent** — nothing about it derives from priority,
  `created_at` or the configured status order. `queue` prints the revision;
  `--base N` on any mutation refuses a stale one with exit 7
  (`revision_conflict`, retryable) and leaves the order standing. Without
  `--base` the CLI writes blind, which is the human's own risk to take.
- **`queue.policy` decides whether the plan BINDS agents.** `advisory` (the
  default, `staple settings get queue.policy`) orders and explains and never
  refuses. Under `strict`, an agent claiming a row later than an eligible one is
  refused with exit 10 and `out_of_order`, and the refusal names what to take:

  ```json
  {"code":"out_of_order","message":"STA-146 is later in the queue than STA-67, which is ready. Take STA-67, or ask a human to reorder or override.","detail":{"policy":"strict","expected":["STA-67"],"position":14,"expectedPosition":2},"retryable":false}
  ```

  It is not a `conflict` (somebody got there first — pick another *now*) and not
  `gated` (a person must act) but a third instruction: *the plan says something
  else comes first*. Retrying never clears it; taking `expected[0]` does.
- **A human may step over the plan, on the record.** `staple checkout <ref>
  --override -m "<why>"` skips ONLY the order check — blockers, gates and live
  claims still refuse — and writes a `queue_overridden` event with the actor,
  the reason and the rows it displaced. The reason is mandatory: `--override`
  without `-m` is exit 2. The plan is unchanged, so the displaced row is still
  the head for the next agent.

- **Diagnostics.** `staple doctor` carries a read-only `queue` check: the plan's
  revision and entry count, plus a warning for the two states no listing can
  show — an entry whose issue no longer exists (every listing joins to `issues`,
  so such a row is invisible and still holds a rank) and an exhausted rank gap,
  where the next insert renumbers the whole plan in its own transaction. Neither
  is repairable with `--fix`.

`staple queue --help` prints the same distinction at command level: which of the
two orders each subcommand shows or edits, the classification ladder, and the
four refusal codes. `--json` on every subcommand prints the one shape MCP and
the UI server return: `{revision, entries, effective}`, with `queue next`
answering `{revision, next, skipped}` — see
[queue.md](queue.md#operations-by-surface).

## Estimates vs actuals

One stored number and a handful of read-time derivations, so you can say what
agentic execution actually cost against the plan-time human figure.

```bash
staple new "Port the claim guard" --estimate 90m   # record it WHEN YOU PLAN
staple estimate STA-42 2h                          # re-estimate, whatever the status
staple estimate STA-42 --clear                     # clear it
```

Durations use the same vocabulary as `--if-stale`: `90s`, `30m`, `2h`, `3d`, or
a bare number of seconds. An estimate must be a positive whole number of
seconds and at most 365 days — `staple estimate STA-42 0` is refused, because
"estimated at nothing" and "no estimate recorded" are different facts and only
one of them has a dedicated flag.

### Changing an estimate: `staple estimate`

`staple estimate <ref> <dur>` sets the estimate and `staple estimate <ref>
--clear` removes it. Nothing else about the issue moves: not the status, not
the claim, not the attempt ledger. An attempt keeps the `estimateAtStart` it
read when it opened.

- **No status to restate.** Earlier the only way to re-estimate was a status
  write that repeated the current status (`staple status STA-42 in_progress
  --estimate 2h`). That still works exactly as before, and a status move can
  still carry `--estimate` in the same write. But an estimate-only change has
  one documented form, and it is this verb.
- **Shell-safe.** Only the literal `--clear` erases. `staple estimate STA-42
  "$EST"` with `EST` unset passes an empty string, which is refused.
  `staple estimate STA-42 $EST` unquoted passes nothing, which is also refused.
  A duration and `--clear` together are refused rather than resolved by
  precedence. Every refusal is `validation`, exit 2, and writes nothing.
- **Idempotent.** The write is an absolute set. Repeating it with the value the
  issue already has writes nothing: no event, no sync operation, no
  `updatedAt` bump. The answer says `"changed": false`. There is no
  idempotency key because a repeat cannot compound.
- **Who may.** Anyone a status write allows, which is any actor. The claim
  holder is not required, and a gated or resolved issue can be re-estimated,
  just as a same-status write could. The `estimate_changed` event (`from`,
  `to`, the actor) records who changed what. It is the same event, with the
  same payload, that a status write carrying `--estimate` emits.

Success under `--json` is the issue as `show` prints it, plus `estimateChange`:

```json
{"id":"…","identifier":"STA-42","status":"in_progress","estimatedSeconds":7200,"…":"…",
 "estimateChange":{"from":5400,"to":7200,"changed":true}}
```

`from` and `to` are seconds, and `null` means no estimate. On a repeat,
`from` equals `to` and `changed` is `false`. Refusals use the usual error
envelope on stderr (see [Machine-readable output](#machine-readable-output)):

| refusal | code | exit |
|---|---|---|
| no duration and no `--clear`, or an extra argument | `validation` | 2 |
| `""`, or a duration it cannot parse (`<dur> must be a duration like 90s, …`) | `validation` | 2 |
| `0`, a fraction of a second, or more than 365 days (the store's sentence) | `validation` | 2 |
| a duration together with `--clear` | `validation` | 2 |
| no such issue | `not_found` | 3 |

```json
{"code":"validation","message":"usage: staple estimate <ref> <dur> | staple estimate <ref> --clear (no duration given; an estimate is only cleared by --clear)","retryable":false}
```

MCP `set_estimate` and the UI server's `estimate` action call the same store
method and answer the same shape. MCP `set_estimate` takes `{ref,
estimate_seconds}`, and `estimate_seconds` is required: a number sets, `null`
clears, and omitting it is a schema error, not a clear. The HTTP action takes
`{type: "estimate", ref, estimateSeconds}`. A missing key or `""` is refused
with HTTP 409 and `validation`.

Refusals carry the same `code`, `message` and `retryable` on every surface,
each in that surface's usual wrapper: the CLI's single stderr line under
`--json`, the MCP tool result's `isError` text block, and the UI server's JSON
body with its HTTP status. One refusal comes from somewhere else. A missing or
mistyped `estimate_seconds` on MCP (absent, a string) is rejected by the MCP
SDK's input-schema check before the store runs. That refusal is a `-32602`
invalid-params error. The SDK returns it as an `isError` tool result whose text
starts `MCP error -32602: Input validation error`, not as a staple
`validation` envelope.

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
actual: waiting on a human reviewer is a queue, not execution. An open review
interval runs to the read instant, because a queue's clock does not stop while
nobody writes. It surfaces only when nonzero. A workspace imported from another tool, with no usable event log,
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
                 "descendantsEstimatedSeconds":12600,"contributingCount":2,
                 "unplannedCount":1,"totalCount":3}},
 "childrenTiming":{"STA-43":{"estimatedSeconds":5400,"activeSeconds":3600,"…":"…"}}}
```

The same object also carries the effort and elapsed fields of
[timing-semantics.md](timing-semantics.md#where-the-numbers-appear): `workSeconds`
(agent work from worker attempts, the estimate ratio's actual, the same on every
device), `ownWorkSeconds`, `orchestrationSeconds`, `leadSeconds`,
`estimateRatio`, the `wall` partition of elapsed time into buckets, `quality`, and
`missing` with the reason each null field is null.

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
estimated passes its children's plan straight up. A **cancelled** issue's own
estimate contributes nothing: it owes no work. Cancelling a parent does not
cancel its children, though, so a cancelled issue with live issues beneath it
passes their plan up like an unestimated parent would. Only a subtree that is
cancelled throughout drops out entirely. `done` work still counts, because it
was part of the plan. This rule is certified: a test suite pins it on
adversarial trees (an estimated parent over estimated children, mixed partial
subtrees, twelve levels of nesting, done and cancelled descendants, a cancelled
parent over open children, a leaf moved between parents, and two devices
writing the same tree through sync). The fields:

- `estimatedSeconds` — the **effective (top-down) plan**, the one number an
  ancestor counts this issue as: the own estimate when recorded, otherwise
  `descendantsEstimatedSeconds`, `null` when neither exists.
- `source` — `own`, `descendants` or `none`: which fed `estimatedSeconds`.
- `descendantsEstimatedSeconds` — the **bottom-up plan**, the sum of the
  direct children's contributions, under the cancellation rule above. Kept visible
  even when an own estimate wins, so the 4h epic above, over 3h30m of planned
  children, shows the disagreement instead of one side quietly winning.
- `contributingCount` / `unplannedCount` — **coverage over plan units**. A
  unit is a live (not cancelled) issue with its own estimate (everything
  beneath it is inside that unit), or a live issue with no estimate and no live
  work beneath it (an unplanned unit). An unestimated issue with live work
  beneath it is a container, not a unit, and so is a cancelled one.
  `contributingCount` counts the planned units at every depth, `unplannedCount`
  the unplanned ones, and coverage is `contributingCount` of
  `contributingCount + unplannedCount`. A fully planned tree therefore reads
  n of n however deep its estimates sit. A descendant shadowed by an estimated
  ancestor beneath this issue is covered by that ancestor, not counted, and
  still on its own timing.
- `totalCount` — descendants at any depth, whatever their status, shadowed and
  cancelled ones included.

A middle epic with no estimate over three leaves at 4h/3h/4h therefore
reports an 11h plan, and its parent includes that 11h whether or not the
middle level was estimated. `staple show` adds one segment per parent:
`plan 11h (3 of 3 units planned)` when the plan was inherited, or
`descendants est 11h (3 of 3 units planned)` beside `est` when an own estimate
wins, then the three lines of the certified plan below.

Every surface takes it at creation: MCP `create_task` via `estimate_seconds`,
HTTP `create` via `estimateSeconds`, and `staple new --estimate`. Every surface
changes it with the explicit write above: `staple estimate`, MCP `set_estimate`
and HTTP `estimate`. (MCP `update_task` and HTTP `update` also still accept it,
where an explicit `null` clears and an absent key leaves it alone.) `list_tasks` and `inbox` carry the
scalar `estimatedSeconds` but not the rollup object — those shapes exist to
make choosing a task cheap.

### Comparing plans: `staple compare`

`staple compare <ref> [<ref> ...]` (MCP `compare_plans {refs}`, HTTP
`GET /api/compare?ref=A&ref=B`) reports, for up to 20 named issues, the figures
a planner needs to compare epics, with no tree in the output. All three
surfaces call one store method and answer one payload:

```bash
staple compare STA-42 STA-50
# STA-42 · Sync epic (epic, in_progress)
#   labor ≥10h (descendants) · 4 of 5 units planned · 1 cancelled · unplanned STA-47
#   planned path ≥9h · STA-44 > STA-45 > STA-46 · partial: unplanned_units · 1 of 1 outside blockers open (STA-45 <- STA-50)
#   remaining path ≥5h · STA-45 > STA-46 · partial: unplanned_units
# STA-50 · Other epic (epic, backlog)
#   labor 6h (own) · 1 of 1 units planned
#   planned path 6h · STA-50
#   remaining path 6h · STA-50
```

Durations print in days of 24 hours: `5d5h` is 125 hours of labor, not five
working days. The JSON is in seconds.

- **`labor`** is total labor: `timing.subtreePlan`, the certified rollup
  above, never recomputed. Every planned unit is counted once. `source` is
  `own` when the issue's own estimate is the figure (with `descendantsSeconds`,
  the bottom-up sum, beside it) and `descendants` when it is the sum of the
  units beneath. `≥` marks a `descendants` sum with unplanned units. A
  cancelled issue named directly reports what is live beneath it, not its own
  estimate.
- **`coverage`** is `{planned, unplanned, units, partial, unplannedRefs,
  cancelled}` over plan units. For an issue with live work beneath it,
  `planned` and `unplanned` are `subtreePlan`'s `contributingCount` and
  `unplannedCount`. An issue with no live work beneath it (no children, or
  every descendant cancelled) is its own single unit here, while its
  `subtreePlan` counts no descendant units at all. `cancelled` counts the
  issues beneath whose own status is cancelled. `unplannedRefs` lists at most
  20. An unplanned unit is never counted as 0: `partial` is true and the
  figures are lower bounds.
- **`criticalPath`** is the **planned path**: the longest chain of
  `blockedBy` edges between units inside the subtree, every unit weighted by
  its estimate, done ones included, so parallel branches take the max rather
  than adding. It is how long the plan takes end to end at the least, not a
  forecast. It is built from the units beneath the issue, even when the
  issue's own estimate is the labor figure, and `exceedsLabor: true` says the
  path is longer than that own estimate. An edge between two issues becomes an
  edge between their units: an issue inside a unit stands for that unit, and a
  container for all of its units, through a start and a finish node of its
  own, so an edge between two large containers stays one edge. Edges inside
  one unit, edges to the named issue itself, edges between an issue and its
  own ancestor, and edges touching a cancelled issue shape nothing. `seconds`
  is null with `no_plan` when no unit is planned, and `chain` is then empty.
  `partial` with `unplanned_units` means some unit has no estimate. An
  unplanned unit on the chain shows `seconds: null`, unknown rather than 0.
  `chain` lists at most 100 steps, and `chainLength` gives the true length.
- **`remainingPath`** has the same shape: the longest chain over the same
  graph, with every `done` unit weighing 0 and left off `chain`. It is
  recomputed, so it can follow a different chain from the planned path once
  the planned chain's units are done. It measures what is left of the plan. A
  unit in progress still weighs its full estimate. It is 0 when every unit is
  done, and null with `no_plan` when open units remain and none of them is
  planned. A done unit with no estimate is no gap in what remains.
- **Blockers outside the subtree** are listed in `criticalPath.crossSubtreeBlockers`
  (`{blocked, blocker, blockerStatus, resolved}`, unresolved first, at most 20,
  with `crossSubtreeBlockerCount` and `unresolvedCrossSubtreeBlockerCount`).
  They are never folded into a path: an unresolved one is work that cannot
  start until something outside ends. Cross-workspace blockers stay on
  `get_task`'s `crossBlockers`.
- **Cycles.** The tracker refuses a direct dependency cycle, but units can
  still form one: a container blocks an issue that blocks one of the
  container's own children, or two devices each add one half of a loop before
  they sync. The paths break such a cycle at the edge that closes it, in
  identifier order, so every device breaks it the same way. The units on it
  are listed in `criticalPath.cycle`, `missing` gains `dependency_cycle` and
  the paths are `partial`. The walk never loops.
- **`overlaps`** names every compared issue that lies inside another compared
  issue (`{ref, within}`). Its labor is already part of the other's, so never
  add the two.

`show --json`, MCP `get_task`, HTTP `/api/issue` and `/api/agent-context`
carry the same object as `planSummary` for a parent: `compare`'s entry for that
issue without `ref`, `title`, `kind` and `status`. It is `null` for an issue
with no children, whose plan is its own estimate on `timing`. `staple show`
prints it as the `labor`, `planned path` and `remaining path` lines once
something beneath is planned.

### Timing quality: `staple timing quality`

Every record that carries a timing figure has exactly one quality state, with
the reasons that produced it ([timing-semantics.md](timing-semantics.md#quality-states)).
`show --json` carries it as `timing.quality.work` and `timing.quality.wall`, each
`{state, inputs, reasons}`, and every attempt as `effortSeconds` with its
`quality`. `staple timing quality` (MCP `timing_quality`, HTTP
`GET /api/timing/quality`) counts those states over a population, for
analytics that has to decide which records to trust. All three surfaces call
one store method and answer one payload:

```bash
staple timing quality --kind task --exclude approximate
# 163 eligible (done leaves) of 215 issues · kind task · not eligible: 0 parents, 46 open, 6 cancelled
# work   exact 3 (1.8%) · timing-floor 0 (0.0%) · approximate 2 (1.2%) · reconstructed 154 (94.5%) · missing 4 (2.5%)
#        reasons: never_started 4, reconstructed 154, sparse 29
# wall   exact 156 (95.7%) · approximate 3 (1.8%) · missing 4 (2.5%)
# ratio  exact 0.231 over 3 of 107 (work 2h18m / est 10h)
#        admitted [exact,timing-floor,reconstructed,missing] 0.088 over 87 of 107 (work 1d7h / est 14d16h)
# excluded 29 records: approximate 2, reconstructed 27 (carrying reconstructed 27, sparse 29)
# STA-42    reconstructed work 3m7s (reconstructed) · wall exact  Surface error details through MCP
# more: --cursor eyJrIjoidCIs...
```

- **Work states**, highest precedence first: `missing` (no figure: never
  started, no worker attempt, no child measured), `reconstructed` (backfilled
  by `staple attempt reconstruct`), `approximate` (`sparse`, `capture_gap`,
  `contested`, `partial`, `orphan_provisional`, `end_unbounded`,
  `clock_skew`), `timing-floor` (under 60 seconds) and `exact`. `reasons`
  lists every reason that holds, so a reconstructed record that is also sparse
  reads `["reconstructed", "sparse"]`. Wall states are `missing`,
  `approximate` and `exact`.
- **Eligible** is the denominator of every coverage figure: the leaves in the
  filter that are resolved `done`. Parents are counted apart, because a
  parent's work is its children's sum, as are open and cancelled leaves
  (`population.notEligible`). Coverage is `counts[state] / eligible`. It is
  null with `no_eligible_records` when nothing is eligible, never 0.
- **Ratio.** `ratio.total` is the done issues with their own estimate and no
  live estimated descendant: every estimated done leaf, and a done parent
  whose estimate is the only one in its subtree (`ratio.parents` counts them).
  `ratio.exact` is `Σ workSeconds / Σ estimatedSeconds` over the exact ones,
  the definition every per-issue `estimateRatio` uses. `ratio.admitted` is the
  same sum over the records the selection keeps.
- **Selecting is explicit.** Every reason sits at the level of the state it
  produces (`sparse` and the other approximate inputs at approximate,
  `timing_floor` at timing-floor, and so on), and a record is kept only when
  its state and the level of every reason it carries are kept.
  `--include S[,S]` names the states kept (default all), `--exclude S[,S]`
  removes states, and `--exclude-reason R[,R]` drops every record carrying a
  reason code whatever its state. So `--exclude approximate` also drops a
  reconstructed record that is sparse, `--include exact` is exact records
  only, and `--include exact,reconstructed` adds reconstructed records with
  nothing approximate, missing or under a minute about them. Dropped records
  leave `items` and `ratio.admitted`, and `excluded` counts them by state and
  by the reasons they carried. The counts and coverage never change. Nothing is
  dropped by default, so `timing-floor` records stay listed. A state outside
  the five, `provider-unavailable` included, and a reason code outside the
  closed set are refused. Every list flag takes commas and can be repeated.
- **Filters.** `--kind K[,K]`, `--parent REF` (every issue beneath it) and
  `--since T` (resolved at or after an ISO instant, or that long ago: `7d`).
  With `--since`, open issues fall outside the filter.
- **Bounded.** `items` are the eligible records admitted by the exclusion,
  oldest resolution first, `--limit` 50 by default and at most 500, with a
  keyset `--cursor`, as for the other telemetry lists. `truncated` is stated.

### Calibration: `staple calibrate`

`staple calibrate` (MCP `calibration_cohorts`, HTTP `GET /api/calibration`)
groups trusted samples into cohorts and says how long work of each class took
against its estimate ([timing-semantics.md](timing-semantics.md#calibration-cohorts)).
All three surfaces call one store method and answer one payload:

```bash
staple calibrate --kind task --include reconstructed --for STA-42
# snapshot calibration2:aac4071dafc5ebf89486599fe72d2c37 · kind task
# 109 eligible (done, own estimate) of 215 issues · minimum 5 samples per cohort
# exact         5 samples (4.6% of 109) in 1 cohorts · not samples: approximate 2, reconstructed 102
# reconstructed 84 samples (77.1% of 109) in 4 cohorts · not samples: exact 5, approximate 2, reconstructed 18
# exact         kind=task priority=high workType=unknown area=unknown model=unknown · 5 own
#               kind=task priority=high workType=unknown area=unknown model=unknown: n 5 (6.9% of 72) · ratio median 0.179, range 0.146–0.515, pooled 0.214 · work median 44m37s · bounds_below_confidence
#               ratio p10 0.146 p25 0.149 p50 0.179 p75 0.256 p90 0.256 · bounds 0.146–0.515 (66.7%, below target) · expected 0.214 (pooled) · tail ok (0 beyond the fences)
# reconstructed kind=task priority=high workType=unknown area=unknown model=unknown · 52 own
#               kind=task priority=high workType=unknown area=unknown model=unknown: n 52 (72.2% of 72) · ratio median 0.081, range 0.025–0.174, pooled 0.079 · work median 18m29s · reconstructed_only
#               ratio p10 0.042 p25 0.053 p50 0.081 p75 0.116 p90 0.142 · bounds 0.028–0.163 (92.5%) · expected 0.079 (pooled) · tail ok (0 beyond the fences)
# ...
# forecast      STA-42 exact · est 6h · kind=task priority=high workType=unknown area=unknown model=unknown n 5 → p50 1h4m, p10–p90 52m28s–1h32m · bounds 52m28s–3h5m (66.7%, below target) · expected 1h17m (pooled) · bounds_below_confidence
# forecast      STA-42 reconstructed · est 6h · kind=task priority=high workType=unknown area=unknown model=unknown n 52 → p50 29m2s, p10–p90 15m8s–51m · bounds 10m1s–58m38s (92.5%) · expected 28m37s (pooled) · reconstructed_only
```

- **Samples.** The population is the ratio population of
  [timing quality](#timing-quality-staple-timing-quality): done issues with
  their own estimate and no live estimated descendant. A sample is one whose
  work is `exact`. Approximate, timing-floor and missing records are never
  samples; they stay in every denominator and are counted under `excluded`.
  `--include reconstructed` adds backfilled history (reconstructed records with
  nothing approximate, missing or under a minute about them) as a **separate
  set** with its own cohorts. It is never pooled with `exact`, and the exact
  set reads the same with or without it. Any other `--include` value is refused.
- **The estimate.** Each sample divides `workSeconds` by the first reading of
  its own estimate (`estimateAtStart`) among the worker attempts on the issue
  behind its work, so a re-estimate made after the work started cannot flatter
  it, and otherwise by the current estimate. `estimate.source` says which
  (`at_start`, `current`), and `estimate.missing.atStart` why there was no
  reading (`parent` for a parent data point, `no_worker_attempt`,
  `not_recorded` when every attempt read none, as reconstructed ones do,
  `not_own`).
- **Cohort key.** `kind`, `priority`, `workType`, `area` and `model`.
  `workType` and `area` come from labels: `type:<x>` and `area:<x>` (the prefix
  matched without case, the value lowercased; several values join with `+`).
  `model` is the `--model` named with `--harness` by the worker attempts behind
  `workSeconds` (for a parent, its counted children's: never a cancelled
  child's, never a non-leaf's own). A dimension with no value reads `unknown`.
- **Fallback.** A key with fewer than 5 samples reads a broader class: without
  model, then without area, then without work type, then kind alone, then the
  whole set. `path` lists every level tried with its sample count, `level` and
  `class` say which was read (dropped dimensions are `*`), and `fallback` is
  `none`, `below_minimum` or `below_minimum_everywhere` (then the whole set is
  read, with the warning `small_sample`). A level where timing-floor members
  outnumber the samples, and the two make 5, also stops the walk: that class
  is floor-dominated. Each `path` step counts `samples` and `floors`.
- **Per cohort.** `samples`; `coverage` (`samples / eligible`, the
  denominator named: the population members in the class, whatever their
  quality); the lower median, the pooled ratio (`Σ work / Σ estimate`) and the
  range (`min`, `max`) of the ratio and of `workSeconds`; `rangeConfidence`
  (`1 − 2 × 0.5ⁿ`, how often that range covers the median: 0.9375 at n = 5); how many samples used each estimate source; up to 20
  member refs with the total; and the members of the class left out, by state
  and reason.
- **Ranges.** `ratio` and `workSeconds` each carry `quantiles` (`p10`, `p25`,
  `p50`, `p75`, `p90`: the lower quantile, index `floor(p × (n − 1))`, never
  interpolated), `intervals` (for each quantile, the order-statistic interval
  that covers the class's true quantile) and `bounds` (where one more sample
  falls). Each interval is `{lower, upper, ranks, confidence, reached}`: the
  target is 90%, and one that cannot reach it is the sample range with the
  confidence it does reach, `reached: false`. Bounds reach 90% from 19 samples
  and the median's interval from 5; p10 and p90 need 22. Null with no sample.
- **Heavy tails.** `tail` tests `ln(ratio)` from 10 samples, with the
  standard median: a sample is an outlier past 3.5 robust deviations
  (modified z-score over the MAD) and more than 5% from the median, and the
  cohort is heavy when at least 3 samples, and 5% of them, are. It reports the
  outliers each way, the share, the `fences` and `fenceClippedPooled`.
  `ratio.expected` is `{value, method}`: the pooled ratio, or for a heavy tail
  the pooled ratio with each sample's ratio clipped at the fences
  (`fence_clipped_pooled`). Never a mean. The clipped figure reads low on the
  class it is used for.
- **Floors.** `floors` lists the class's timing-floor members (work under 60
  seconds, never samples): `count`, `share` of floors and samples, `dominated`
  (more floors than samples, and at least 5 of the two), and up to 20 refs.
- **Warnings.** A closed list, in this order: `small_sample` (under 5
  samples), `bounds_below_confidence` (under 19), `quantile_below_confidence`
  (a quantile's interval under 90%: p10 and p90 need 22), `fallback_used` (a
  class broader than the first level tried), `heavy_tail`, `floor_dominated`,
  `floors_excluded` (some floors, not dominating: the samples read long),
  `reconstructed_only` (the reconstructed set) and `no_samples`.
- **Forecasts.** `--for REF` (repeat, or a comma list; up to `--limit`) adds
  `forecasts`, one per issue and per evidence set, in the order asked. Each
  one reads the issue's key by the sample rules, except that an issue nobody
  has started has no model to match: its model reads `*` and its walk starts
  without the model. `--model M` pins the model of every forecast in the read.
  The key resolves to a class as the listing does, and the forecast multiplies
  the issue's own current estimate: `seconds` (p10 … p90), `bounds`, and
  `expected` (`{seconds, ratio, method}`). `state` is `ratio`, `floor` (a
  floor-dominated class, with or without an estimate: the work is expected
  under 60 seconds, with no seconds or bounds and `expected` the 60-second
  `floor_bound`), `no_samples` or `no_estimate`, with the reason in
  `missing.seconds`. The class read (`cohort`) and its warnings come with it.
  A forecast does not change `snapshot.id`.
- **Along a path, only `expected` adds.** Sum `expected.seconds` across a
  chain for its expected duration. Do not sum quantiles or bounds: the p90 of a
  chain is not the sum of its links' p90s, and summed bounds are no bound at
  any stated confidence. A sum over heavy-tailed classes inherits the clipped
  figure's low bias. The rules and a worked example are
  in [timing-semantics.md](timing-semantics.md#confidence-ranges).
- **Snapshot.** `snapshot.id` identifies the data the report was computed
  from. The same data gives the same id on every device, in any order and at
  any later instant (a relative `--since` is hashed as written); a changed
  sample, estimate, label, model or selection changes it. Pages and `--samples` of the same data share it.
- **Lists.** Cohorts by default, one row per full key observed among the
  samples, by set then key; `--samples` lists the samples instead, by set then
  oldest resolution first. `--limit` 50 by default and at most 500, with a
  keyset `--cursor`. Filters: `--kind`, `--priority`, `--parent REF` and
  `--since T`, applied before any cohort is formed.

### Forecasts: `staple forecast`

`staple forecast <ref>` (MCP `forecast`, HTTP `GET /api/forecast?ref=`)
forecasts the work left under an issue and, apart from it, what that work
costs this machine's provider limits
([timing-semantics.md](timing-semantics.md#forecasts)). All three surfaces call
one store method and answer one payload, `{asOf, subject, filter, snapshot,
method, completion, budget}`:

```bash
staple forecast STA-42
# STA-42 · Sync epic (epic, in_progress) · snapshot forecast2:0f3c9a8e7d6b5a4c3b2a19087f6e5d4c over calibration2:1a2b3c4d5e6f708192a3b4c5d6e7f809
# completion  25 units · 10 done · 1 awaiting review · 14 to forecast, 14 known
#   labor     expected 15h9m · p10–p90 13h56m–20h22m · 90% band 13h12m–21h23m · plan 5d5h (descendants)
#   path      expected 8h35m · STA-44 > STA-45 > STA-47 > STA-50 > STA-51 > STA-52 > STA-53 · p10–p90 7h11m–12h21m · 90% band 6h49m–13h12m · 1 outside blockers open
#   confidence medium · bounds reach 71.4% of 90.0% · bounds_below_confidence, awaiting_review · warnings bounds_below_confidence, quantile_below_confidence, fallback_used, awaiting_review, independent_draws, unresolved_outside_blockers
# budget      this machine · reserve 20.0% (provisional default, until the admission policy defines one) · work 15h9m, serial from now
#   anthropic/personal-max five_hour: 58.0% left · resets 2026-09-26T00:53:11.000Z (in 2h59m)
#       pace 12.00%/h over 3 readings · runs out in 4h50m (after reset)
#       work rate 12.00%/work-hour over 1 attempts in 1 spans (1h) · confidence low (small_sample) · other use input_missing (time_outside_attempts)
#       the work uses 182.0% (p10–p90 167.2%–244.5% · 90% band 158.5%–256.7%) · at the reset 22.0% left (p10–p90 22.0%–22.0% · 90% band 22.0%–22.0%)
#       P(it runs past the reset) 100.0% · windows p50 4, p90 5 · P(it alone uses a window up) 0.0%
#       P(under the 20.0% provisional reserve) work alone 0.0% through the work, 0.0% this window · with other use input_missing · confidence low
#   openai/codex-plus codex.primary: 55.0% left · resets 2026-09-26T00:53:11.000Z (in 2h59m)
#       pace 26.32%/h over 2 readings · runs out in 2h5m (before reset)
#       work rate input_missing (attempt_burn)
#       the work input_missing (work_rate)
```

- **Completion.** The certified plan's units beneath `<ref>` (a leaf is its
  own unit, `subject.scope: "unit"`), each forecast from the duration
  `staple calibrate --for` reads for it (the `exact` set, unfiltered) and the
  work already done on it: the calibrated expected figure for a unit nobody
  has worked, and once work has started, the mean of what the class's longer
  samples leave (`conditional_mean`). Done units weigh 0; units in review or
  gated weigh 0 as work and are listed under `review` (their wait and any
  rework are not forecast), and the subtree reads `settled: false` until they
  are done. A unit with no samples, no estimate, or worked past every sample
  of its class is unknown, never 0, and turns the sums `partial` (shown `≥`).
  `--model M` pins every unit's model, as `calibrate --model` does.
- **Unit or subtree.** The units are the certified rollup's, so a parent with
  its own estimate is one unit at that estimate inside its epic, and a
  container of what is live beneath it when named alone: the same work can
  read 2h as a unit of its epic and 1h forecast alone. `subject.scope` says
  which question was answered.
- **Labor and path.** `labor` adds the units' remaining work; `path` is the
  longest dependency chain of it (effort along the chain, not calendar time),
  with `chain`, the outside blockers and a `plan` block repeating the certified
  estimates for reference. Each has `expectedSeconds` (the figures that add)
  and `simulated` (`mean`, `p10`, `p50`, `p90`, and the 90% `band`, p5 to p95),
  from 2 000 draws of every unit's class sample ratios with a fixed seed: the
  same data reads the same figures everywhere.
- **Confidence.** `confidence.achieved` is the lowest prediction-bounds
  confidence of the classes drawn from (a band cannot be surer than its
  classes), `label` is `high`, `medium` or `low` with `reasons` (never `high`
  while a review is open), and `warnings` carries the units' calibration
  warnings and `unknown_units`, `beyond_class_range`, `overrun`,
  `few_admissible`, `awaiting_review`, `independent_draws`,
  `dependency_cycle`, `unresolved_outside_blockers`.
- **Budget.** Machine-local, per account (`--account A` for one) and limit:
  the high-water `remainingPercent`, `resetsAt`, `windowSeconds`, `pace`
  (%/hour over the current window's readings) and `exhaustion` at that pace;
  `workRate` (%/work-hour: the limit's rise over the union of this
  workspace's attempt spans in the window, per hour of their work, so
  concurrent attempts are not counted twice, with its own bootstrap band and
  a `confidence`: sparse readings at a span's edges and another session's
  readings inside a span make it `low`, and the rate prefers the spans nobody
  else touched); `otherUse` (%/hour outside those spans, from at least 30
  minutes and 2 readings there, with its own confidence); and for the
  remaining labor run serially from now, through the reset and the windows
  after it, `work` (`consumedPercent`, `beforeResetPercent`,
  `remainingAtResetPercent`, `outlastsResetProbability`, `windows`,
  `exhaustionProbability`) and `reserve`.
- **The reserve.** `reserve.breachProbability` is the share of draws in which
  the work alone leaves less than the reserve at the reset of any window it
  runs in (`scope: "through_the_work"`, `basis: "work_alone"`);
  `currentWindowBreachProbability` checks the current reset only;
  `withOtherUse` adds the account's other use for the hours the work is not
  running (the work rate already holds the rest). `--reserve P` takes a percent
  of each limit (`20` or `20%`). Without it a **provisional default of 20%**
  applies until the admission policy defines the protected reserve, and
  `source: "provisional_default"` says so on the budget and on every limit.
  Anything outside 0 to 100 is refused.
- **Unknown is never 0.** A stale reading (over 10 minutes old), an elapsed or
  sliding window, a limit with no attempt span, or unknown labor reads null
  with the reason in `missing` (and `missingInputs` for `input_missing`). With
  no budget on the machine, `accounts` is empty with `missing.accounts`.
- **Snapshot.** `snapshot.id` identifies the completion inputs over
  `snapshot.calibration.id` (`staple calibrate`'s unfiltered id): the same on
  every device. `snapshot.budget.id` identifies this machine's budget data at
  `asOf`, which every projection is measured from.

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

## Provider budget

Provider usage readings, recorded on this machine so a scheduler can reason
about subscription windows. The contract is
[execution-telemetry.md](execution-telemetry.md): limit windows, budget
samples, missingness. Samples live in the staple home's `hub.db` and never
replicate, and ingestion makes no network request. Capture is opt-in and each
harness home is bound to an account label first
([configuration.md](configuration.md#budget-capture-and-source-bindings)).

```bash
staple budget capture on
staple budget bind --source claude-statusline --account personal-max
staple budget ingest --source claude-statusline --tee | my-statusline      # in the statusLine command
staple budget ingest --source codex-rollout ~/.codex/sessions/2026/09/24/rollout-….jsonl
staple budget ingest --source manual --account personal-max --provider anthropic \
  --limit-key five_hour --used 37.5 --resets-at 3h                         # read off /usage
```

- **`--tee`** writes the status-line input back to stdout byte for byte, before
  `budget`'s own arguments are parsed, so staple can sit in front of the status
  line you already use and a mistyped flag still leaves the status line intact.
  Nothing else goes to stdout, and a refusal goes to stderr. A runtime that
  predates `budget` (after `staple install --rollback`, say) rejects the command
  itself and echoes nothing, so a `--tee` pipeline would blank the status line.
  A wiring that survives any runtime hands staple a copy and never depends on
  it for output:

  ```bash
  # statusLine command; my-statusline is the status line you already had
  f=$(mktemp); cat >| "$f"; exec 3<"$f" 4<"$f"; rm -f "$f"; unset f; staple budget ingest --source claude-statusline <&3 >/dev/null 2>&1 & exec 0<&4 3<&- 4<&-; my-statusline
  ```

  A plain command list rather than a `bash -c '…'`, so `my-statusline` runs in
  the same shell Claude Code already gives it (under `sh` or `zsh`, `echo`
  reads `\033` as an escape, where a nested bash would print it literally).
  `>|` because `mktemp` has already created the file and a shell with
  `set -C` (noclobber) refuses `>` onto it.

  Both readers open the file before it is unlinked, so nothing is left in the
  temp directory and neither reader can lose it to the other. Nothing waits on
  staple: the status line appears as soon as `my-statusline` exits, while the
  ingestion finishes in the background with its own copy of the input.
- **What is stored is what was reported.** `usedPercent` keeps fractions and
  values above 100; `remainingPercent = max(0, 100 − usedPercent)` and
  `exceeded = usedPercent ≥ 100`. A missing value is `null` with a reason in
  `missing`, never `0`, and a source with no reading stores no row.
- **Resets are instants.** Epoch seconds are converted exactly
  (`resetsAtSource: "observed_absolute"`); a duration such as `3h` is added to
  the capture instant (a Codex line's own timestamp) and marked
  `derived_from_relative`, with `confidence: "low"`.
- **A reading is stored when it is news**: when it differs from the latest one
  of the same window and harness session, when its reset moved by more than
  120 seconds, or, as `heartbeat: true`, when that latest one is over 300
  seconds old. A replay stores nothing twice.
- **Codex forks**: the parent's history a forked rollout starts with is skipped
  (`reason: "fork_copied"`), only as the file's leading run.

`--json` prints `{source, provider, accountRef, accountSource, outcomes,
storedCount, skipped}`, the same object the MCP tool `record_budget_sample`
returns. Each outcome is `{stored: true, sample}` or `{stored: false, reason}`
with `reason` one of `unchanged`, `fork_copied`, `not_reported_by_source`,
`parse_error`. Refusals use the existing envelope: `validation` (exit 2) with
`detail.reason` `capture_disabled` or `no_binding_configured`. A manual reading
typed at the CLI is the operator's own and is accepted with capture off; the
same reading sent by an agent through `record_budget_sample` is refused
(`capture_disabled`) until the operator runs `staple budget capture on`.

### Automatic collection

One explicit consent turns on everything above and keeps it running
([execution-telemetry.md](execution-telemetry.md#automatic-collection)):

```bash
staple budget setup --claude-account personal-max --codex-account codex-plus      # prints the plan, changes nothing (exit 2)
staple budget setup --claude-account personal-max --codex-account codex-plus --yes
staple budget status                                                              # sources, wrapper, watcher, problems
staple budget collect                                                             # one watcher run, by hand
staple budget unsetup --yes                                                       # reverse exactly what setup did
```

- **`setup`** turns capture on, binds the Claude config directory
  (`--claude-config-dir`, default `CLAUDE_CONFIG_DIR` or `~/.claude`) and the
  Codex home (`--codex-home`, default `CODEX_HOME` or `~/.codex`), puts the
  status-line wrapper in front of the `statusLine` command `settings.json`
  already has, and on macOS loads a launch agent that runs `budget collect`
  every `--interval` minutes (default 5). An account already bound to a home
  is reused when its flag is left out; a harness with neither is skipped.
  `--no-statusline` and `--no-watcher` leave those parts alone. Without `--yes`
  a plan that would change something is refused with exit 2 and the plan
  (`detail.plan` with `--json`); an already-set-up machine prints "nothing to
  change" and exits 0. Each step reads `+` (will change), `=` (already so),
  `-` (skipped, with why) or `!` (refused: nothing at all is changed, for
  example a `settings.json` that is not valid JSON or not writable, or a watcher
  another staple home already loaded). Every edit is computed and checked when
  the plan is made, so apply does not stop half way for a reason the plan could
  have seen. If the outside world still fails it (launchctl, say), the refusal
  names the step and what was already applied, and `unsetup --yes` reverses it.
- **The wrapper** is the rollback-safe recipe above as a plain POSIX command
  list, marked `: staple-statusline-wrapper/v2;` and ending in your original
  command, verbatim:

  ```bash
  : staple-statusline-wrapper/v2; __stf=$(mktemp); cat >| "$__stf"; exec 3<"$__stf" 4<"$__stf"; rm -f "$__stf"; unset __stf; '/Users/me/.local/bin/staple' budget ingest --source claude-statusline --config-dir '/Users/me/.claude' <&3 >/dev/null 2>&1 & exec 0<&4 3<&- 4<&-; my-statusline
  ```

  It is not wrapped in another shell: the shell Claude Code runs the status
  line with runs your command exactly as before (`echo "\033[32m…"` means
  the same thing to it), and nothing needs bash. A version-1 wrapper (the same
  script inside `bash -c '…'`) is still recognised; `setup` upgrades it and
  `unsetup` removes it. `settings.json` is copied to
  `~/.staple/backups/claude-settings/` first, and only the `command` string
  changes. A symlinked `settings.json` is followed: the file it points at is
  edited and the link stays a link. A read-only file or directory is refused.
  A status line that already runs `staple budget ingest` is not wrapped twice.
  With no status line at all, the wrapper records readings and prints nothing.
- **`collect`** ingests the rollouts under each bound Codex home's `sessions/`
  that are new or have grown since the last run, newest first, at most
  `--max-files` (default 100) per run. A grown file is read from where the
  last read stopped when its first bytes are unchanged and any leading run of
  fork copies has ended; otherwise it is read whole. One run at a time: a
  second run while one holds `~/.staple/telemetry/collect.lock` returns
  `skippedReason: "locked"` and reads nothing. `--quiet` prints nothing but
  failures, which is how the agent runs it. The agent's `PATH` is the node
  setup ran under, then `/opt/homebrew/bin` and `/usr/local/bin`. Off macOS, schedule it yourself:
  `*/5 * * * * ~/.local/bin/staple budget collect --quiet` (`crontab -e`).
- **`unsetup`** restores the original `statusLine` byte for byte, unloads and
  deletes the agent, and puts capture and the bindings back as they were before
  setup, unless you changed them since. Capture goes back off even if bindings
  were added since (they stay, recording nothing). Stored readings are kept.
- **`status`** `--json` is `{budgetCapture, bindings, sources, statusline,
  watcher, setup, problems}`: each source's `lastReading` (`observedAt`,
  `recordedAt`, `ageSeconds`), each wrapper's `state` (`installed`,
  `hand_wrapped`, `not_installed`, `missing_file`, `invalid_json`,
  `unsupported`), the watcher's `installed`, `loaded`, `lastRun` and
  `lastError`, and `problems` as `{code, message}`, among them
  `watcher_foreign` (another home's agent holds the label; the message names
  the `launchctl bootout` that frees it) and `watcher_node_missing` (no node on
  the agent's `PATH`).

The web UI server exposes the same methods: `GET /api/budget/collection` (the
status), `POST /api/budget/collection/plan` (`{action: "setup"|"unsetup",
…options}`, answering `{plan, consent}`), `/setup` and `/unsetup`, and
`/collect`. Options are `claudeAccount`, `codexAccount`, `claudeConfigDir`,
`codexHome`, `statusline`, `watcher` and `intervalMinutes`. The consent is tied
to the plan that was shown, in the pattern of the cloud connect consent: the
plan route mints a single-use ticket (`{id, digest, expiresAt}`, five
minutes) and keeps the options server-side, and `/setup` or `/unsetup` takes
only `{consent: id, digest}`. Without one they answer 400 and change nothing;
an expired or used ticket is 404; a wrong digest, a ticket for the other
action, or a plan that no longer reads the same (`plan_changed`) is 409. The
routes are machine-local and never trigger a sync.

### Reading budget and attempts back

```bash
staple budget                                   # every account, each limit's current window
staple budget --account personal-max --json
staple budget --reserve 30                      # pressure against a 30% reserve
staple budget history --account personal-max --since 2h --limit 100
staple attempts STA-42                          # every attempt on the issue, oldest first
staple attempt 0b6f2c1e-6d0a-4f7e-9d38-2f3b8a1c9e44 --json
```

- **`staple budget`** shows each limit's current window with its latest
  reading, `status` (`current` or `elapsed`) and the high-water
  `remainingPercent`: the highest usage seen in the window so far, which is
  the conservative figure when concurrent sessions report caches of different
  ages. Once a window resets nothing carries forward: the limit reads
  `null` with `window_elapsed` until a new reading arrives. A bound account
  with no readings reads `no_sample_yet`. An account with no ingestion path
  reads `source_unavailable`. Neither is shown as 0. `stale: true` means the
  latest reading's value is over 10 minutes old, judged on `observedAt`, which
  is also how `budget history` finds its gaps.
- **Pressure.** Every limit also carries `pressure`, PROVISIONAL until the
  admission policy defines it ([execution-telemetry.md](execution-telemetry.md#pressure)).
  Measured: `observed` (the window's pace, `%/hour` of wall clock),
  `lastReadingAgeSeconds`, `secondsToReset`. Forecast:
  `sustainablePercentPerHour` = `(remaining − reserve) / hours to reset`,
  `ratio` = observed / sustainable, `state` `unsafe` at 1 or over (or when the
  remaining figure is already at or under the reserve) and `within` below,
  `exhaustion` and `reserveReach` at the pace, and `confidence` with its
  warnings. `safeConcurrency` is always `null` (`policy_not_defined`).
  `--reserve P` (`20` or `20%`) sets the reserve; without it a provisional
  20% applies, and `reserve.source` says which. The human output adds one
  line per limit: `pace 4%/h  sustainable 16.6%/h  pressure x0.24 WITHIN`.
- **`staple budget history`** lists one account's readings oldest first by
  `observedAt`, each with a derived `regression` flag. `--since` takes an
  instant or a duration meaning that long ago.
- **`staple attempts <ref>`** lists the issue's attempts, oldest first, each as
  it reads now. An attempt whose claim was cleared or moved by a path that ran
  no side effect (an applied remote operation, a status recategorized, a hand
  edit) reads `state: "ended"`, `outcome: "orphaned"`, with the row's own
  value in `storedState`. `show` prints a summary line and `show --json`
  carries `attempts: {current, last, count}`.
- **`staple attempt <attempt-id>`** prints one attempt with its transitions,
  its chain (the attempts linked by `resumesAttemptId`) and its burn, per limit,
  from this machine's readings.

The lists are bounded: `--limit` defaults to 50 and is clamped to 500. With
`--json` they print `{items, truncated, nextCursor, coverage}`. `truncated` is
stated rather than inferred from a full page. Pass `nextCursor` back as
`--cursor` with the same other arguments. The cursor is a keyset position, so
rows added between pages never shift a page. `coverage.gaps` lists the spans no
capture ran in, each with a reason. These are the payloads the MCP tools
`get_budget`, `list_budget_samples`, `list_attempts` and `get_attempt` return
([agents.md](agents.md#execution-telemetry)).

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

`retryable` is the branchable bit. Among the tracker's own failures only
`revision_conflict` is worth retrying. A checkout conflict means *pick a different task*.
Among cloud sync failures, `rate_limited`, `unavailable` and `offline` are
retryable, and nothing else is.

A cloud sync failure carries the service's own code, from the taxonomy in
[sync.md](sync.md#error-taxonomy): `auth`, `forbidden`, `revoked` and the rest,
never the nearest store code. `detail.cloudCode` and `detail.retryable` repeat
the code and the bit. They are there for scripts written before the code was true, and
they always agree with the top level:

```json
{"code":"offline","message":"Could not reach https://sync.example.com (TypeError). Local work is unaffected; nothing was sent and nothing was changed.","detail":{"endpoint":"https://sync.example.com","cloudCode":"offline","retryable":true},"retryable":true}
```

Until STA-251 the code was folded into a store code and only `detail` held the
truth. `auth`, `forbidden`, `revoked`, `cursor_invalid`, `payload_too_large`,
`schema_ahead` and `protocol_unsupported` were `validation` (exit 2).
`epoch_changed`, `rate_limited`, `unavailable` and `offline` were a
non-retryable `conflict` (exit 4). A script that branched on those two exit
codes for a cloud command should branch on the codes below instead.

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
| | | | 10 | `out_of_order` (the plan says something else comes first) |

Cloud sync failures (`staple cloud …`, `staple hub registry …`) use 2, 3 and 4 for the
three codes they share with the tracker, and these for the rest:

| code | meaning | retry? |
|---|---|---|
| 11 | `auth`: missing or invalid credential. Re-connect | no |
| 12 | `forbidden`: not a member, or a consent the service or this machine lacks | no |
| 13 | `revoked`: this device was revoked. Re-connect | no |
| 14 | `epoch_changed`: the timeline moved again during recovery | no |
| 15 | `cursor_invalid`: a stored position the service cannot read | no |
| 16 | `payload_too_large`: a batch or one row is over the service's cap | no |
| 17 | `schema_ahead`: data written by a newer staple. Upgrade | no |
| 18 | `protocol_unsupported`: this build and the service share no protocol. Upgrade | no |
| 19 | `rate_limited`: `detail.retryAfter` says how long | **yes** |
| 20 | `unavailable`: a transient service failure | **yes** |
| 21 | `offline`: the service could not be reached. Local work continues | **yes** |

Test for exactly those three. Don't use a range check such as `-ge 19`. Codes above 21
are not staple's: the installed launcher exits 70 when no runtime is installed, and a
signal gives 128+n (130 for Ctrl-C). A loop that retried on those would spin for ever
on a broken install:

```sh
staple cloud sync
case $? in
  19|20|21) echo "try again later" ;;
esac
```
