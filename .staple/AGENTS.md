# Working this repo with staple

This repo tracks its work in **staple**, a local-first tracker. The workspace is
`staple`; its tasks are identified `STA-1`, `STA-2`, …  State lives in
`.tasks/tasks.db` next to this file. Nothing here is optional politeness — the
protocol below is what makes an interrupted task resumable by whoever comes next.

Read this before you touch the repo. It takes a minute.

## The loop

1. `staple inbox` — what is ready, in pickup order. Blocked work is listed
   separately with the blocker that must land first. Do not invent work that is
   not a task; make a task.
2. `staple checkout STA-42` — atomic claim, moves it to `in_progress`.
   **A conflict means pick a different task. Never retry the same one.** The
   claim is already held; retrying just burns turns. (Exit code 4 / `conflict`.)
3. Write the plan: `staple doc STA-42 plan --put plan.md`. Documents are keyed
   and revisioned — this replaces a scratch `plan.md` nobody else can find.
4. Work. Leave progress as you go: `staple comment STA-42 "…"`.
5. `staple done STA-42 -m "<evidence>"` — evidence, not a victory lap. What you
   ran, what passed, what you deliberately left.
6. `staple events` — see what your completion unblocked (`blockers_resolved`,
   `children_complete`). Then go back to `inbox`.

## Act under one identity, all session

Set `STAPLE_AGENT` (or pass `--agent` / `--author` / MCP `actor`) and **use the
same value you claimed with for the entire session.**

This is not bookkeeping. Liveness is derived from your claim plus the newest
event or comment *by the holder*. Write a comment under a different name and it
does not count as your activity: your own task reads as silent, and you look
stealable to the next agent that walks past. Set it once, at the top:

```bash
export STAPLE_AGENT=your-name
```

## The worklog protocol — checkpoint as you go

Keep a document keyed `worklog` on every task you hold, and **revise it at every
milestone**, not at the end.

```bash
staple doc STA-42 worklog --put worklog.md
staple doc STA-42 worklog              # read the latest
staple doc STA-42 worklog --revisions  # the history, checkpoint by checkpoint
```

Three sections, always:

```markdown
## Done
- Ported the claim guard; `store.checkoutIssue` now CASes on the holder (a1b2c3d).

## Next
- Wire the same guard into the HTTP surface, then re-run `npm run smoke:mcp`.

## Files touched
- src/core/store.ts, src/mcp.ts, test/store-claim.test.ts
```

Reference commit SHAs where the work is real code — a SHA is the only pointer
that survives a rebase of your working tree.

**Why before, not after:** the checkpoint you write *before* the interruption is
the handoff. A summary written at the end never survives a kill, a usage limit,
or a crashed harness — the whole class of events that make a handoff necessary
are exactly the events that prevent you from writing one. Assume every turn is
your last one and the protocol costs you nothing.

## Branch pointer

The task says what; it does not say where. **At checkout, comment where the
physical work lives** — branch, worktree path, and the base commit:

```bash
staple comment STA-42 "Branch pointer: worktree /path/to/wt on branch feat/sta-42, base a1b2c3d."
```

Without it, the next agent has a perfect description of the work and no idea
which of six worktrees contains it.

## Continuity — resuming someone else's interrupted task

Every `in_progress` task shows its claim: `ls` and `show` print
`held 2h · silent 45m`, and `--json` / the MCP `claim` object carry `heldBy`,
`lastActivityAt`, `heldSeconds`, `idleSeconds`. That is how you tell an agent
that is working from one a usage limit killed hours ago.

Taking over is **explicit and opt-in**:

```bash
staple checkout STA-42 --steal-if-stale 2h    # take over a holder silent >= 2h
staple release STA-42 --if-stale 2h           # or just free the claim
```

Durations: `90s`, `30m`, `2h`, `3d`, or a bare number of seconds. A takeover
logs `claim_stolen` / `claim_released_stale` with the previous holder and their
last activity, so the trail shows who took what from whom.

The rules, and they do not bend:

- **Only when a human says "continue."** These flags are affordances for a
  person resuming work, not a policy you apply on your own initiative. Never
  steal because a task looks abandoned and you are idle.
- **Nothing is automatic.** No sweeper, no daemon, no TTL. A claim never expires
  on its own; staleness is information, not a verdict.
- **Blockers still win.** A steal is refused while dependencies are unresolved,
  however dead the holder looks. Stale is not a bypass.
- **A plain checkout of a stale claim is still refused** — by name, with the
  holder's last activity. That refusal is telling you to pick another task, not
  to escalate to `--steal-if-stale`.

When you do resume someone's task, read their `worklog` and their branch pointer
comment first. That is what they left you. Leave the same for the next one.

## Wiring

```bash
claude mcp add staple -e STAPLE_AGENT=your-name -- npx tsx /Users/vpetkovic/VPDrive/Workshop/prototypes/2026-08-30-staple-agent-task-tracker/src/mcp.ts
```

The MCP tools mirror the CLI: `inbox`, `checkout_task` (with
`steal_if_idle_seconds`), `put_document`, `add_comment`, `update_task`,
`release_task` (with `if_idle_seconds`), `events_since`. Writes require an
identity — pass `actor` or set `STAPLE_AGENT`; there is no silent default.

---

*Generated by `staple init`. Edit it freely — re-running `init` will not
overwrite your changes.*
