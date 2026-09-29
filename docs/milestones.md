---
title: Milestones and goals
sidebar_label: Milestones and goals
description: Put a target date and a goal on work from one or more epics, order it, track progress, and mark each goal criterion with evidence.
---

# Milestones and goals

Use a milestone when a set of work has a date or a purpose of its own: a beta, a
release, the end of a quarter. A milestone gathers epics and tickets from anywhere in
the tree without moving them, gives them an order, a target date and a goal, and tells
you how far along it is and whether the goal is met.

The example turns the password reset epic from
[Plans become tickets](plans-to-tickets.md) (APP-1) and the flaky test filed on
[The pickup queue](queue.md) (APP-10) into an "Account recovery beta" due on 30 October.

## 1. Turn milestones on

Milestones are a kind of ticket, and a new workspace does not have the kind yet. Add
it once:

```bash
staple kinds add milestone --label Milestone
```

## 2. Create the milestone with its goal

The goal is a list of criteria: what must be true for the milestone to count as
reached. `--from-epic` makes an epic its first member. `--preview` shows what would
happen and writes nothing:

```bash
staple milestone new "Account recovery beta" --from-epic APP-1 --target 2026-10-30 \
  --criteria "A user can reset a forgotten password from the email link;Reset tokens expire after 30 minutes;The user guide documents the flow" \
  --preview
```

```text
would create  Account recovery beta  (milestone, target 2026-10-30)
  + member  APP-1  at 1
hierarchy changes: none
```

Run it again without `--preview` to create it (MCP `create_milestone`). It becomes
APP-11. Dates are calendar days in UTC; `--start` sets an optional start day, and
`staple milestone set` changes dates and criteria later.

## 3. Add work from anywhere

```bash
staple milestone add APP-11 APP-10        # MCP add_milestone_member
staple milestone mv APP-10 --at 1         # MCP move_milestone_member: the flaky test first
```

Joining a milestone changes nothing about a ticket: it keeps its epic, its
dependencies and its status. The epic's tickets come along with it, and tickets you add
to the epic later join the milestone too. A ticket belongs directly to at most one
milestone; `staple milestone mv <ref> --to <milestone>` moves it to another.

## 4. Put it in the queue

```bash
staple queue add APP-11 --at 1
```

A milestone in the [pickup queue](queue.md) takes one place and expands to its members
in the order you gave them. Reorder the members and agents feel it on their next ask.

## 5. Mark each criterion with evidence

staple never decides on its own that a criterion is met. An agent or a person marks it
and says why (MCP `mark_milestone_criterion`):

```bash
staple milestone criterion APP-11 2 --met --evidence APP-2 -m "The expiry test passes"
staple milestone criterion APP-11 3 --met --evidence APP-5
```

Evidence is a ticket (`APP-2`), a document on a ticket (`APP-2:plan`) or plain text.
A ticket counts only while it is done, so a mark made early waits for the work (below).
If that ticket is reopened, the criterion reads `unknown` until it is done again. If
the criterion is reworded, mark it again. Use `--unmet` with a note to record what is
missing.

## 6. See where it stands

```bash
staple milestone show APP-11      # MCP get_milestone
```

```text
APP-11 · Account recovery beta
state active · status backlog · target 2026-10-30 · start none · revision 3
progress 2/6 33% · 6 leaves
pace     no_estimate: 2/6 leaves done; nothing open is estimated, 31 day(s) to 2026-10-30. (labor 2h, remaining —, partly planned)
goal     1/3 met
   1. unknown A user can reset a forgotten password from the email link
   2. met     Reset tokens expire after 30 minutes  [APP-2]
   3. unknown The user guide documents the flow  [APP-5]  (marked met, but its evidence does not hold yet: APP-5 is backlog, not done)
members
   1. APP-10    backlog     Login test is flaky on CI · bug
   2. APP-1     backlog     Password reset · epic
next     APP-10 (member 1)
```

- **progress** counts the tickets that do the work, each once; epics are not counted
  on top of their tickets, and cancelled work leaves the count.
- **pace** compares the open work's estimates with the days left. Estimate the open
  tickets to get `on_track` or `behind` instead of `no_estimate`.
- **state** is `planned`, `active`, `overdue` (the day after the target), `done` or
  `cancelled`.
- **next** is the ticket an agent would take first inside this milestone.

`staple milestone ls` lists every open milestone on one line each. In the web UI, the
**Milestones** view shows the same, and a milestone's detail shows the goal with its
evidence.

## 7. Sign it off

A milestone closes itself when the last of its work is done, the way an epic does. To
sign it off yourself first, [gate](approval-gates.md) it:

```bash
staple gate APP-11 --owner VP
```

The gate holds the milestone's close until you
[approve it](approval-gates.md#4-decide). Unlike a gate on an epic, it does not hold
the members: agents keep working them.

> [!NOTE]
> Leave this step out if you plan an [autopilot goal run](runs.md#goal-runs-over-a-milestone)
> over the milestone: the run opens its own gate for you. A gate you open yourself
> stops a goal run; approve it, then start a new run.

## Next

- [Autopilot runs](runs.md): let an agent work the milestone until its goal is met.
- [The pickup queue](queue.md): how milestones and epics share one order.
