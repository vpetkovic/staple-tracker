---
title: The pickup queue
sidebar_label: Pickup queue
description: Set the order agents take work in, see what comes next and why, and choose whether that order is advice or a rule.
---

# The pickup queue

Use the queue to tell agents what comes first. Without it, agents take ready work by
status and priority. With it, you put epics, milestones and single tickets in the order
you want them done, and every agent that asks what to take next gets the first ticket
in that order it can actually work.

The examples use the password reset epic (APP-1) from
[Plans become tickets](plans-to-tickets.md), plus an audit log epic (APP-7, with APP-8
and APP-9, which waits on APP-8) and a flaky test (APP-10), filed the same way.

## 1. Queue work in order

```bash
staple queue add APP-10     # the flaky test first
staple queue add APP-1      # then password reset
staple queue add APP-7      # then the audit log
```

MCP: `enqueue_task`. In the web UI, open the **Queue** view and use *Queue a task,
epic or milestone…*, or a row's `⋯` menu.

## 2. Read the order

```bash
staple queue        # MCP list_queue
```

```text
queue revision 3
  1  APP-10    backlog     Login test is flaky on CI                      → 1   eligible
  2  APP-1     backlog     Password reset                                 container (4)
      APP-6     Rate-limit reset requests per address          → 2   eligible
      APP-3     Send the reset email                           → 3   eligible
      APP-4     Reset form sets the new password               → 4   eligible
      APP-5     Document the reset flow                        → 5   blocked APP-3, APP-4, APP-6
  3  APP-7     backlog     Audit log                                      container (2)
      APP-8     Record sign-ins                                → 6   eligible
      APP-9     Show the audit log to admins                   → 7   blocked APP-8
```

The numbers on the left are your plan. An epic or milestone in the plan stands for the
open tickets under it, listed beneath it; agents are handed those tickets, never the epic.
The `→` numbers are the order agents actually receive, and the word after each says whether
a ticket can be taken now.

The queue never lifts a blocker, a gate or another agent's claim. A blocked ticket
keeps its place and is skipped until it is free. Work you did not queue still counts:
it comes after everything you queued.

## 3. Ask what is next

```bash
staple queue next                  # MCP next_task
staple queue next --scope APP-7    # only inside one epic or milestone
```

```text
next     APP-10 (position 1) Login test is flaky on CI
```

This is what agents ask before they claim anything. When the answer passes over
tickets, it says why: held by another agent, blocked, or waiting on a gate.

## 4. Change the order

```bash
staple queue mv APP-7 --before APP-1    # MCP move_queue_entry
staple queue rm APP-10                  # MCP dequeue_task
staple queue prune                      # MCP prune_queue: drop finished entries
```

In the Queue view, drag rows or use Alt-↑ and Alt-↓. Finished work stays in the plan,
skipped, until you prune it, so a ticket that is reopened gets its old place back.

Leave the plan to people: `.staple/AGENTS.md` tells agents to follow the queue, not
edit it.

## 5. Choose advisory or strict

The queue has two policies:

- **Advisory** (the default): the queue orders the ready list and answers
  `queue next`, but an agent can still claim any ready ticket. Use it while you are
  the one steering, and the order is a strong hint.
- **Strict**: claiming a ticket is refused while an earlier ticket in your plan can be
  taken. Use it when several agents work unattended and the order matters, for
  example when later work builds on earlier work in ways the dependencies do not
  capture.

```bash
staple settings set queue.policy strict     # MCP set_setting
```

Under strict, an agent that reaches past the plan gets exit code 10 and the ticket to
take instead:

```text
error(out_of_order): APP-3 is later in the queue than APP-10, which is ready. Take APP-10, or ask a human to reorder or override.
```

A queue with nothing in it refuses nothing, even under strict.

## 6. Take something out of turn

When you need one ticket done now, you do not have to reorder the plan. Claim it with
a reason:

```bash
staple checkout APP-3 --override -m "The email provider trial ends Friday"
```

The claim goes through, the reason is recorded on the ticket, and the plan is
unchanged: the next agent still gets APP-10 first. An override never gets past a
blocker, a gate or another agent's claim.

## Next

- [Milestones and goals](milestones.md): queue a dated plan that spans several epics.
- [Autopilot runs](runs.md): let one agent work the queue ticket after ticket.
- [Configuration](configuration.md): the `queue.policy` setting.
