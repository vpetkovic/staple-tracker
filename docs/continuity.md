# Continuity

What happens after an agent dies mid-task.

## Claims carry liveness

Every held issue carries a `claim`: `heldBy`, `lastActivityAt`, `heldSeconds`,
`idleSeconds`. Those are derived at read time from the checkout plus the newest
event or comment *by that holder* — so a caller can tell a working agent from
one a usage limit killed three hours ago.

`ls` and `show` print `held 2h · silent 45m` on `in_progress` rows, and
`--json` carries the same numbers under `claim`.

## Takeover is explicit and opt-in

```bash
staple checkout STA-42 --steal-if-stale 1h    # take over a dead agent's claim
staple release STA-42 --if-stale 1h           # just free it
```

Over MCP the same two affordances are `checkout_task`'s
`steal_if_idle_seconds` and `release_task`'s `if_idle_seconds`.

Both refuse a fresher holder, by name:

```
Checkout refused: held by opus-x, active 3m ago. Pick a different task.
```

A successful takeover logs `claim_stolen` / `claim_released_stale` with the
previous holder and their last activity, so the audit trail survives.

There is **no sweeper, no daemon, no TTL, and nothing automatic**. A claim
never expires on its own. Staleness is information plus an affordance you
invoke when a human says "continue". Blockers still win: a steal is refused
while dependencies are unresolved, however dead the holder looks.

Gates win too. `--steal-if-stale` cannot route around a review gate above the
issue — checkout is refused with `gated` (exit 9) however dead the holder
looks, because a stale holder and a closed gate are unrelated facts. The
inverse is also true and is why the guard sits *after* the crash-recovery
re-claim: an agent that was already holding a ticket when a gate went up
above it can still resume its own work.

A held claim on work that is really waiting on a person is the failure mode
this whole file exists for, and `staple gate` is the honest way to end it:
parking a parent **clears its claim**, so it stops accruing time and stops
reading as live work somebody should steal. See
[semantics.md](semantics.md#approval-gates).

## A claim change is not a plan change

A live claim is a hard constraint on pickup ([queue.md](queue.md)): a row held
by somebody else is `claimed` in effective order and the next agent is handed
the row after it. Everything on this page therefore moves what agents take —
and **none of it writes to the queue**. A steal, a release and a stale-claim
takeover all change one column on one issue; the effective order is derived on
every read, so the very next `inbox`, `queue` or `next_task` reflects it with
nothing re-queued, nothing recomputed in advance and the plan's `revision`
exactly where it was. Releasing the head hands the head back; stealing it moves
who may take it, not where it sits. That is also why a stale claim never
silently promotes later work permanently: the moment it is freed, the human's
order is back in force. (Pinned by `queue-lifecycle.test.ts` — *"a live claim is
skipped, a steal moves it, and a release hands the head back"* — and across two
processes by `queue-concurrency.test.ts` — *"releasing a stale claim re-derives
the effective order for the next process"*.)

## Waking on someone else's completion

```bash
staple wait STA-42 [--timeout s] [--interval ms]     # block until ready or finished
staple events --follow [--since N] [--max N] [--exec CMD]
```

`wait` lets an orchestrator block on a blocker instead of polling. `--follow
--exec` runs a command per event with the event JSON as the last argument and
in `$STAPLE_EVENT`, so hooks fire the moment `blockers_resolved` /
`children_complete` land. A failing hook is logged, never fatal.

## The takeover drill

Prove the handoff works on your own machine, with two different harnesses:

1. In harness one (say Claude Code), have it `checkout` a task, comment the
   branch pointer, and `put_document … worklog` a *Done / Next / Files touched*
   checkpoint after the **first** step of real work. Then kill the session — no
   release, no goodbye. That is the whole simulation.
2. In harness two (say `codex`), in a fresh thread, say only: **"continue"**.
   It should run `staple inbox` (the row reads `held 2h · silent 2h`),
   `staple checkout <ref> --steal-if-stale 1h`, then `staple show <ref>` plus
   `staple doc <ref> worklog` — and pick up from the `Next` it finds there.
3. Afterwards, check three things: the *artifact* is finished (not just the
   ticket), `staple show <ref>` names the second harness as assignee, and
   `staple events` carries `claim_stolen` with the first harness as
   `previousHolder`. If the second harness had to ask you a question to
   continue, the checkpoint was too thin — that is the drill failing, not the
   agent.

`test/takeover-drill.test.ts` is the executable version of exactly this: agent
`drill-claude` works a scratch repo over the **CLI** and dies mid-task, agent
`drill-codex` finishes it over a real **MCP** server, and its resume is a pure
function of one `get_task` payload — so the test cannot pass on anything the
tracker did not carry.
