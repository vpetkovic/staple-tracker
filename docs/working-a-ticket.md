---
title: How an agent works a ticket
description: The working protocol staple init writes for agents, and the loop it teaches (claim, plan, worklog, done).
---

# How an agent works a ticket

## The protocol `init` writes

A repo-local `staple init` also writes **`.staple/AGENTS.md`** — the working
protocol, rendered with that workspace's own slug and identifier prefix, so the
next harness to arrive learns it from the repository instead of from whoever
briefed the last one.

It covers:

- the loop (below);
- the **identity rule** — act under the identity you claimed with, all session,
  or your own writes stop counting as liveness;
- **parents close themselves** — an epic's status follows its children, so the
  last child to land closes it (see [Epics and dependencies](epics-and-dependencies.md)). Nobody has to
  remember to close an epic; what is still owed is the **summary comment**, and
  an explicit `staple done <epic>` remains allowed, idempotent, and immune to
  the derivation afterwards;
- the **worklog convention** — `Done` / `Next` / `Files touched`, revised at
  every milestone. A checkpoint written *before* the interruption is the
  handoff; one written at the end never survives a kill;
- the branch pointer to comment at checkout;
- the **pickup queue rule** — plan order versus effective order, and the three
  non-retryable refusals (below);
- **approval gates** — how a design-first ticket ends (`staple gate <ref>
  --owner <who>`, not a held claim), that the inbox's QUEUED section is never
  pickable, and that checkout of it is refused with `gated`;
- the continuity rules in [handoff.md](handoff.md);
- **the vocabulary is the workspace's** — read the statuses and kinds
  (`staple statuses ls`, `staple kinds ls`, MCP `list_statuses` / `list_kinds`)
  rather than assuming them, remember that all behaviour keys off the status
  category, and edit the vocabulary only when a human asks;
- **attempts and lanes** — yield (`release`) or pause (`staple attempt pause
  <ref> --reason awaiting_input`) when a blocker appears mid-work, so the wait
  reads as `blocked` or `paused` rather than as work; and how an orchestrator
  coordinates without claiming: `staple attempt open <epic> --role orchestrator`
  at the start of a coordination session, `staple attempt end <epic> --role
  orchestrator` at handoff (MCP `record_attempt_event` with `event: "open"` /
  `"end"` and `role: "orchestrator"`). That time is `orchestrationSeconds`, never `workSeconds`
  ([timing-semantics.md](../design/timing-semantics.md#the-orchestrator-lane));
- **autopilot runs** ([runs.md](runs.md)) — after every ticket, ask
  `staple run continue --json` (MCP `continue_run`) and do what it answers:
  `take` (the ticket is already checked out to you), `wait` or `stop`. The
  three ways a run is worked (the `staple run drive` driver, a stop hook, or
  the agent calling `run continue` itself), and the rules that hold for all
  three: finish before you ask, record a `review:` comment before you hand a
  ticket on, never merge or push to master or main, and stop when told to;
- the **wiring** — `claude mcp add staple … -- staple mcp` and the MCP tools
  that mirror the loop.

An existing `AGENTS.md` is **never overwritten** — `init` says it kept it.
`--global` workspaces get no guide: the file exists to be found in a repo, and
`~/.staple/workspaces/` is not one. The MCP `init` tool behaves identically and
returns `guidePath` / `guideWritten`.

Source: `src/core/agents-template.ts`.

It also teaches **the pickup queue rule** ([queue.md](queue.md)), which is the
part an agent is most likely to get wrong because every symptom of getting it
wrong looks like a transient failure: READY is the effective queue rather than a
presentation sort it may re-rank; a queued epic or milestone stands for its open
leaf work and is never a checkout target; `staple queue next` answers before you
claim; and `conflict` (exit 4), `gated` (exit 9) and `out_of_order` (exit 10)
each mean STOP and take what the refusal names — retrying, waiting and
`--steal-if-stale` clear none of the three. The guide also tells an agent not to
reorder the plan and not to send `--override`: both work for it, both record it
as the actor, and both are a human's decision.

## What the agent actually receives

The web UI has an "agent view" pane that renders the exact `get_task` payload
for an issue, both with and without `include_documents`, plus its token cost.
It exists because a human hands over an issue believing the ticket says one
thing while the agent receives a payload that says something slightly
different, and nothing else shows the two side by side.
