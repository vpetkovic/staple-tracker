---
title: Epics and dependencies
description: Group work under epics, say what waits on what, park work on a person, and read what is ready to pick up.
---

# Epics and dependencies

Use this page to shape work so agents can tell what to do next: group tickets under an
epic, say which ticket waits on which, and mark work that waits on a person. staple
works out the rest: what is ready, what is blocked and on what, and when an epic is
finished.

The examples continue the password reset epic from
[Plans become tickets](plans-to-tickets.md): APP-1 is the epic, and APP-2 to APP-6 are its
tickets.

## 1. Pick a kind for each ticket

Every ticket has a kind. A new workspace has five:

```text
◆ epic                 Epic
◇ task                 Task
✱ bug                  Bug
↻ chore                Chore
↯ spike                Spike
```

An **epic** groups work; the others are work an agent takes. Kinds are labels, so add
your own when they help you read the board:

```bash
staple kinds add incident --label Incident     # MCP update_kinds
```

Then `staple new "…" --kind incident` files one (MCP `create_task` with `kind`).

One kind is special: `milestone`, which you add once to turn on
[milestones](milestones.md).

## 2. Put tickets under an epic

`--parent` puts a ticket under an epic (MCP `create_task` with `parent`). Any ticket
can have children, and epics can sit under epics.

You never set an epic's status by hand. It reports what its tickets are doing: in
progress while one of them is, in review when that is where they stand, back to
backlog when nothing is in flight, and blocked when everything open under it is
blocked. It closes itself as done when the last ticket is done (cancelled if every
ticket was cancelled). `queue next` hands out the tickets, never the epic.

## 3. Say what waits on what

`--blocked-by` on `staple new`, or `staple blocked-by` later (MCP `set_blocked_by`),
sets the tickets that must finish first. It replaces the whole list each time:

```bash
staple blocked-by APP-5 APP-3,APP-4,APP-6    # APP-5 now waits on all three
staple blocked-by APP-5 --none               # APP-5 waits on nothing
```

A blocked ticket stays out of the ready list and cannot be claimed. It becomes ready
by itself when its blockers are done, and the agent that was waiting is told.
Dependencies may cross epics, but not form a loop: a loop is refused.

## 4. Read what is ready

```bash
staple inbox        # MCP inbox
```

```text
READY (pickup order):
  ◐  APP-1     in_progress Password reset · epic
  ◐  APP-2     in_progress Issue single-use reset tokens @claude
BLOCKED:
  ⊘  APP-6     blocked     Rate-limit reset requests per address  [VP must Confirm the per-address limit]
  ◌  APP-3     backlog     Send the reset email  [waiting on APP-2]
  ◌  APP-4     backlog     Reset form sets the new password  [waiting on APP-2]
  ◌  APP-5     backlog     Document the reset flow  [waiting on APP-3, APP-4, APP-6]
```

Every blocked row says what it waits on. `staple tree` shows the same tickets as a
tree, and the web UI's Graph view draws the dependencies.

## 5. Park work on a person

Some work waits on a decision rather than on a ticket. Block it on a named person, with
what they need to do:

```bash
staple block APP-6 --owner VP --action "Confirm the per-address limit"
```

```text
⊘  APP-6     blocked     Rate-limit reset requests per address  [unblock: VP → Confirm the per-address limit]
```

An agent does the same with MCP `update_task`: status `blocked` with `unblock_owner`
and `unblock_action`. This kind of block never clears by itself. When the person has
answered, move the ticket back: `staple status APP-6 todo`.

> [!TIP]
> If the wait is really on other work, file that work as a ticket and use
> `blocked-by` instead. A dependency clears itself when the work is done; a block on a
> person waits until someone remembers to lift it.

For "look at this before agents go on", use an [approval gate](approval-gates.md):
it holds a whole epic until you approve it.

## Statuses

| Status | Means |
|---|---|
| `backlog`, `todo` | not started; `todo` is ready to take |
| `in_progress` | an agent holds it |
| `in_review` | finished, waiting for a person to look |
| `awaiting_approval` | held by an [approval gate](approval-gates.md) |
| `blocked` | waiting on a person, with who and what |
| `done`, `cancelled` | finished |

`staple statuses ls` prints your workspace's list. You can rename, add and reorder
statuses; each belongs to a fixed category, which is what staple reads, so renaming
`done` changes nothing about how it behaves. The [CLI reference](cli.md#kinds) has
the commands.

## Next

- [Approval gates](approval-gates.md): hold an epic for your review.
- [The pickup queue](queue.md): decide which epic agents take first.
- [Milestones and goals](milestones.md): put a date and a goal on one or more epics.
