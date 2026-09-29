---
title: Handoff and resume
description: Pick up a ticket after an agent session dies, hits a usage limit or changes hands, exactly where it stopped.
---

# Handoff and resume

Use this page when an agent session ends in the middle of a ticket: it hit the
five-hour limit, the weekly quota ran out, or someone closed the terminal. The ticket
still shows who held it and how long they have been silent, and the worklog says
where to continue. Another session, or another agent in a different harness, takes
it over and carries on.

The example continues [Plans become tickets](plans-to-tickets.md). A later ticket
under the password reset epic, APP-7 "Lock the account after five failed resets", is
in Claude's hands when its session dies. Codex picks
it up.

## 1. Before the interruption: checkpoint as you go

A handoff is only as good as what the last session left. Agents that follow the
protocol (see [How an agent works a ticket](working-a-ticket.md)) leave two things:

- a **branch pointer** comment at claim time:
  `staple comment APP-7 "Branch pointer: branch feat/reset-lockout, base 7d1e2f3."`
- a **worklog** replaced after every step, with *Done*, *Next* and *Files touched*.

Both must be written before the interruption, because an interruption gives no warning.
A summary planned for the end of the session never gets written.

## 2. See which claims have gone quiet

`staple ls` and `staple show` print how long each claim has been held, and how long
since its holder last wrote anything:

```bash
staple ls --status in_progress
```

```text
◆ ◐  APP-1     in_progress Password reset · epic
◇ ◐  APP-7     in_progress Lock the account after five failed resets @claude · held 2m · silent 2m
```

A working agent comments and updates its worklog, so its *silent* stays short.
A dead session goes on being silent. Agents read the same numbers from the `claim`
object in MCP `get_task`. In a real handoff the silence is usually hours; this
example uses minutes.

## 3. Take over the claim

A plain claim is refused while someone else holds the ticket:

```text
error(conflict): Checkout refused: status is "in_progress" (held by claude), expected one of todo, backlog, blocked. Pick a different task — do not retry.
```

To take it over, say how long the holder must have been silent:

```bash
# MCP: checkout_task with steal_if_idle_seconds
staple start APP-7 --steal-if-stale 2m
```

```text
stole ◐  APP-7     in_progress Lock the account after five failed resets @codex (was claude, silent 2m)
```

If the holder has written anything within that time, the takeover is refused by name,
so a live agent is never pushed off its work:

```text
error(conflict): Checkout refused: held by claude, active 0s ago. Pick a different task.
```

The takeover is on the record. `staple events` shows who took what from whom:

```text
64  2026-09-29T14:10:09  claim_stolen  {"identifier":"APP-7","previousHolder":"claude",…,"previousIdleSeconds":126,…}
```

## 4. Continue from the worklog

The new holder reads the ticket and the worklog, and picks up at *Next*:

```bash
staple show APP-7            # MCP get_task, include_documents: true
staple doc APP-7 worklog     # MCP get_document, key "worklog"
```

```text
## Done
- Failed-attempt counter on the reset form (b7c8d9e).

## Next
- Lock after the fifth failure and email the owner.
```

The branch pointer comment says where the code is. From here it is the ordinary
[loop](working-a-ticket.md).

## Just saying "continue"

With the protocol in the repository, a new session needs no briefing. In Claude Code,
Codex or any connected agent, say:

> continue

The agent reads the inbox, lists the claims in progress (`staple ls --status
in_progress`), finds the silent one, takes it over, reads the worklog and carries on. If it has to ask you where to start, the last worklog was too thin.
That is worth fixing in the protocol, not in the prompt.

## Free a claim without taking it

To hand a dead session's ticket back to the queue instead of working it yourself:

```bash
staple release APP-7 --if-stale 2h    # MCP release_task with if_idle_seconds
```

The ticket returns to `todo` and the next agent to ask takes it.

## What staple never does on its own

- **Nothing expires.** No timer frees a claim. Silence is information, and takeover
  is a step someone chooses. Agents are told to take over only when a person asks
  them to continue, never because a ticket looks abandoned.
- **Dependencies and gates still apply.** A takeover is refused while the ticket
  waits on unfinished work or on an [approval gate](approval-gates.md), however long
  the holder has been silent.
- **A claim covers this machine.** Another computer that shares the workspace through
  [cloud sync](cloud-sync.md) can hold the same ticket at the same time, unless the
  agent takes a lease with `staple cloud lease acquire APP-7`.

Durations take `90s`, `30m`, `2h`, `3d` or a number of seconds.

## Next

- [How an agent works a ticket](working-a-ticket.md): the loop, and the worklog in it.
- [Autopilot runs](runs.md): one agent works a scope ticket after ticket.
- [Cloud sync](cloud-sync.md): hand work between two machines.
