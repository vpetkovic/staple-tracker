---
title: Why staple
description: The problem staple solves for development with coding agents, where it came from, and where it fits next to Linear, GitHub and ClickUp.
---

# Why staple

staple gives coding agents a durable, local place for the work: the plan, the
tickets, and where each ticket stands. This page covers the problem it solves, where
it came from, and how it sits next to your team's tracker, so you can decide whether
it fits your project.

## The problem: plans kept in Markdown

Work with agents for a few weeks and a folder like this appears:

```text
docs/plans/
  brainstorm-rate-limits.md
  plan-auth-refactor.md          "blocked until tenant ids land, see plan-multi-tenancy.md"
  plan-multi-tenancy.md          "step 4 depends on plan-auth-refactor.md, step 2"
  plan-multi-tenancy-v2.md       "replaces parts of plan-multi-tenancy.md"
  plan-tenant-billing.md
```

Every brainstorm and implementation plan becomes a Markdown file, and the files
point at each other: one feature depends on another, and the other way round. The
more detailed the plans get, the harder it is to see a milestone, to know what comes
next, or to decide how to approach it. Checkboxes drift because an agent forgot to
tick them. Work found halfway through a plan goes into whichever file was open, or
nowhere.

Then a session ends in the middle of a feature. It hit the five-hour limit, the
weekly quota ran out, or someone closed the terminal. The plan and the task list the
harness kept lived in that session. The next session starts cold: it rereads the
files, guesses which steps are done, and asks you where to pick up.

As the author puts it: "I don’t want Markdown files acting as a backlog, especially
for large features such as integrating multi-tenancy."

## What staple does about it

**Tickets carry the whole context.** A feature becomes an epic, and its steps become
tickets with dependencies between them. The plan is stored on the ticket as a
document, next to the worklog, the comments and the tickets it waits on. An agent
that opens a ticket finds everything it needs there.

```bash
staple new "Multi-tenancy" --kind epic                                # STA-1
staple new "Tenant id on every table" --parent STA-1                   # STA-2
staple new "Scope queries by tenant" --parent STA-1 --blocked-by STA-2 # STA-3
staple doc STA-2 plan --put plan.md
```

**New work goes under the same epic.** When something turns up that the plan did not
foresee, an agent (or you) files it as a ticket under the epic:
`staple new "Tenant-aware rate limits" --parent STA-1`. It shows up in the tree and
the inbox. Nothing depends on someone remembering to edit a file.

**Handoff survives interruption.** An agent claims a ticket with `staple start` and
stores a short *Done / Next / Files touched* worklog after each step. When the
session dies, the ticket still shows who held it and how long it has been silent.
Another session, or another agent in a different harness, takes it over and reads
where to continue:

```bash
staple show STA-2                         # held by claude, silent 2h
staple start STA-2 --steal-if-stale 1h    # take over the dead session's claim
staple doc STA-2 worklog                  # continue from "Next"
```

Takeover is a deliberate step, and it is logged; a claim held on your machine never
expires on its own.
[Handoff and resume](handoff.md) walks through it.

**Local-first.** Each repository keeps its tickets in one SQLite file,
`.staple/staple.db`. There is no account, no server and no network call between an
agent and its next ticket, so there is nothing to wait on and no rate limit to hit.
It works offline, too.
[Cloud sync](cloud-sync.md) is optional, for sharing one workspace between two
machines.

**A person stays in the loop without babysitting.** You set the order agents take
work in with the [pickup queue](queue.md), make work wait for your sign-off with an
[approval gate](approval-gates.md), and follow everything in the local
[web UI](web-ui.md) that `staple open` starts. Two agents cannot hold the same ticket:
the claim is atomic, and the second agent is told to pick a different one.

## Where it came from

staple grew out of daily work with agents: plans died with sessions, two agents took
the same task, and hosted trackers were too slow for an agent's loop. The inspiration was Paperclip AI's inbox, where agents or people file tickets and
agents pick them up. staple has an inbox too, but the focus is different. Agents
claiming work on their own matters less than the tickets themselves being
first-class, so that each one carries the complete context an agent needs to move
the work forward.

## Next to Linear, GitHub and ClickUp

staple does not replace your team's tracker. It is the execution layer: the place
where agents do the work, locally, ticket by ticket. Your team's board stays where
people plan, discuss and report.

| | Your team's tracker | staple |
|---|---|---|
| Used by | People planning and reporting | Agents doing the work, and you watching it |
| Runs | Hosted, over the network | Locally, one file per repository |
| Holds | Features, priorities, discussion | Epics, tickets, plans, worklogs, claims |

Integrations that keep the two in sync are **planned, not shipped**: GitHub Issues,
ClickUp and Linear. Today staple does not read from or write to any of them. You use
it alongside them and carry items across yourself.

## When staple fits, and when it doesn't

staple is a good fit when:

- you build features with coding agents (Claude Code, Codex or any MCP client), and
  a feature spans more than one session;
- you want the next session to resume where a dead one stopped, without asking you;
- several agents work the same repository and must not take the same ticket;
- you want the tracker to work offline, with no account.

It is less of a fit when:

- a single short session finishes each task, so the harness's own to-do list is
  enough;
- your team needs agents to write straight into a shared hosted board today, since
  the GitHub Issues, ClickUp and Linear integrations are not built yet;
- you are looking for a hosted tracker for people, with notifications, permissions
  and reporting. That is what Linear, GitHub and ClickUp are for.

To try it, [Install and first workspace](getting-started.md) takes one repository
from nothing to an agent working a ticket in a few minutes.
