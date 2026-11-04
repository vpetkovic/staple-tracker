---
title: How an agent works a ticket
description: The loop every agent follows on a ticket (take, claim, plan, work, checkpoint, finish), with the CLI command and MCP tool for each step.
---

# How an agent works a ticket

This page is the loop an agent follows on one ticket, from taking it to finishing it.
Read it to know what to expect from your agents, what to ask of them, and how to run
the same steps yourself. Each step gives the CLI command and the MCP tool an agent
calls for it.

The examples continue from [Install and first workspace](getting-started.md):
APP-1 "Add a health check endpoint" is ready, and APP-2 waits on it.

## Why agents know the loop

`staple init` writes `.staple/AGENTS.md` into the repository. It teaches this loop and
the rules around it with your workspace's own prefix, so any agent that arrives, in any
harness, learns it from the repository instead of from whoever briefed the last one.
You never have to explain the tracker in a prompt. Edit it freely; `init` never
overwrites it.

## The loop

**1. Ask what to take.** `staple queue next` (MCP `next_task`) answers with the one
ticket to take, and why it passed over any before it.

```text
next     APP-1 (position 1) Add a health check endpoint
```

**2. Claim it.** `staple start APP-1` (MCP `checkout_task`) moves the ticket to
`in_progress` under the agent's name. The claim is atomic: when two agents race for
one ticket, exactly one gets it.

```text
claimed ◐  APP-1     in_progress Add a health check endpoint @claude
```

The loser is told to move on, and it should take a different ticket, never retry:

```text
error(conflict): Checkout refused: status is "in_progress" (held by claude), expected one of todo, backlog, blocked. Pick a different task — do not retry.
```

Right after claiming, the agent comments where the work lives, so the next session
can find it: `staple comment APP-1 "Branch pointer: branch feat/health-check, base 3f2a1bc."`

**3. Write the plan and an estimate.** The plan is stored on the ticket as a document,
not in a scratch file nobody else can find. The estimate is recorded now, before the
work, so it can be compared with what the work took.

```bash
staple doc APP-1 plan --put plan.md     # MCP put_document, key "plan"
staple estimate APP-1 1h                # MCP set_estimate
```

```text
plan @ revision 1
◐  APP-1     in_progress Add a health check endpoint @claude  est none -> 1h
```

**4. Work, and checkpoint as it goes.** Short progress notes go in comments (MCP
`add_comment`). After each step, the agent replaces its worklog, a document with three
sections:

```markdown
## Done
- /healthz route returns 200 (9c8d7e6).

## Next
- Add the build version and a test.

## Files touched
- src/server/health.ts
```

```bash
staple doc APP-1 worklog --put worklog.md   # MCP put_document, key "worklog"
```

```text
worklog @ revision 1
```

The worklog is what makes a ticket resumable. It is written after every step, not
at the end, because the events that end a session early (a usage limit, a killed
terminal) are the same ones that stop a summary being written. See
[Handoff and resume](handoff.md).

**5. Finish with evidence.** `staple done` (MCP `update_task` with status `done`) closes
the ticket with a note of what was run and what passed:

```bash
staple done APP-1 -m "GET /healthz returns 200 with the version; npm test: 42 passed"
```

**6. See what it unblocked.** APP-2 was waiting on APP-1, so it is ready now:

```text
READY (pickup order):
  ◌  APP-2     backlog     Document the endpoint
```

Then the agent goes back to step 1.

## When something gets in the way

- **The ticket turns out to wait on other work.** File or link the blocking ticket
  (`staple blocked-by APP-2 APP-7`), then let the claim go with `staple release APP-2`
  (MCP `release_task`) so the wait reads as blocked, not as work.
- **It needs an answer from you.** The agent keeps its claim and pauses:
  `staple attempt pause APP-2 --reason awaiting_input` (MCP `record_attempt_event`).
- **It needs your sign-off before going further.** That is an
  [approval gate](approval-gates.md).
- **New work turns up.** File it as its own ticket under the same epic instead of
  growing this one. [Plans become tickets](plans-to-tickets.md#6-file-new-work-under-the-same-epic)
  shows how.

## What the agent actually receives

`staple show APP-1` prints everything on the ticket: its status, who holds it, its
dependencies, its documents and its comments.

```text
◇ APP-1 · Add a health check endpoint
status done (v2) · kind task · priority medium · @claude
time   est 1h · ran 2s
blocks:     APP-2(backlog)

documents: plan@r1, worklog@r1

comments:
  [2026-09-29T14:06] claude (user): Branch pointer: branch feat/health-check, base 3f2a1bc.
  [2026-09-29T14:06] claude (agent): GET /healthz returns 200 with the version; npm test: 42 passed
```

An agent reads the same ticket with MCP `get_task`, and `include_documents: true` adds
the plan and worklog in one call. To see exactly what that call returns, open the
ticket in the web UI and choose the **For agents** tab. It shows the payload with and
without documents, and what each costs in tokens, so you can check the ticket says
what you think it says before you hand it over.

## Next

- [Plans become tickets](plans-to-tickets.md): break a feature into tickets like these.
- [Handoff and resume](handoff.md): what happens when a session dies mid-ticket.
- [The pickup queue](queue.md): set the order in which agents take work.
