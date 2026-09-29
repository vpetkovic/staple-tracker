---
title: MCP tools
description: Every tool the staple MCP server offers, grouped by what an agent is doing, with its CLI equivalent and whether it writes.
---

# MCP tools

Use this page to find the tool an agent calls for a job, and the command you would
type for the same thing. The server offers 65 tools, grouped the same way as the
[CLI reference](cli.md). A tool and its command follow the same rules, and most
answer the same object the command prints with `--json`.

1. Add the server once per machine, naming the agent
   ([Connect your agent](connect-your-agent.md) covers Codex and other clients):

   ```bash
   claude mcp add staple -e STAPLE_AGENT=claude -- npx -y staple-cli mcp
   ```

2. Ask your agent to list its staple tools. Each has a description and typed
   arguments; the client shows them.
3. Most tools take `ws` (a workspace slug or prefix) to reach another repository, and
   every write takes `actor` when `STAPLE_AGENT` is not set.

The loop an agent follows, described in
[How an agent works a ticket](working-a-ticket.md):

`next_task` → `checkout_task` → `put_document` (the plan) → `add_comment` as it goes
→ `update_task` to `done` → `events_since` to see what that unblocked.

## Tickets

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `inbox` | What is ready, waiting on a person, or blocked, in pickup order | `staple inbox` | no |
| `list_tasks` | List tickets by status, kind, assignee or text | `staple ls` | no |
| `get_task` | One ticket in full: claim, time, gate, blockers, attempts | `staple show` | no |
| `create_task` | File a ticket, with parent, blockers and estimate | `staple new` | yes |
| `update_task` | Change status or fields; `status: "done"` finishes it | `staple status`, `staple done` | yes |
| `checkout_task` | Claim a ticket and start it | `staple checkout` | yes |
| `release_task` | Give a claim back | `staple release` | yes |
| `add_comment` | Add a comment | `staple comment` | yes |
| `list_comments` | A ticket's comments, oldest first | `staple show` | no |
| `put_document` | Store a plan, worklog or other document on a ticket | `staple doc --put` | yes |
| `get_document` | Read a document, latest or by revision | `staple doc` | no |
| `events_since` | What changed since a point in the event log | `staple events --since` | no |
| `record_attempt_event` | Report a pause, resume, checkpoint or interruption on the ticket you hold | `staple attempt pause` (and `resume`, `milestone`, `interrupt`) | yes |

## Planning

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `set_blocked_by` | Replace a ticket's blockers | `staple blocked-by` | yes |
| `gate_task` | Hold an epic for a person's review | `staple gate` | yes |
| `approve_task` | Release a held epic, or some of its tickets | `staple approve` | yes |
| `request_changes` | Send a held epic back with a note | `staple request-changes` | yes |
| `list_queue` | The pickup plan, and the order agents receive | `staple queue` | no |
| `next_task` | The one ticket to take next, and what it skipped | `staple queue next` | no |
| `enqueue_task` | Add a ticket, epic or milestone to the plan | `staple queue add` | yes |
| `dequeue_task` | Take an entry out of the plan | `staple queue rm` | yes |
| `move_queue_entry` | Move one entry | `staple queue mv` | yes |
| `reorder_queue` | Set the whole order | `staple queue reorder` | yes |
| `prune_queue` | Drop finished entries | `staple queue prune` | yes |
| `list_milestones` | Milestones, with progress | `staple milestone ls` | no |
| `get_milestone` | One milestone: members, goal and pace | `staple milestone show` | no |
| `create_milestone` | Create one, optionally from an epic | `staple milestone new` | yes |
| `update_milestone` | Change dates, description or criteria | `staple milestone set` | yes |
| `mark_milestone_criterion` | Judge one goal criterion met, unmet or unknown, with evidence | `staple milestone criterion` | yes |
| `add_milestone_member` | Add an epic or ticket | `staple milestone add` | yes |
| `remove_milestone_member` | Remove a member | `staple milestone rm` | yes |
| `move_milestone_member` | Move a member, or into another milestone | `staple milestone mv` | yes |
| `reorder_milestone_members` | Set the members' order | `staple milestone reorder` | yes |

## Autopilot runs

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `start_run` | Start working a scope ticket after ticket | `staple run start` | yes |
| `continue_run` | After each ticket: take the next, wait, or stop | `staple run continue` | yes |
| `run_status` | A run, and whether it would stop now | `staple run status` | no |
| `pause_run` | Hold a run | `staple run pause` | yes |
| `resume_run` | Let a held run go on | `staple run resume` | yes |
| `stop_run` | End a run | `staple run stop` | yes |

## Cloud sync

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `cloud_status` | Whether this machine syncs this repository, from local files | `staple cloud` | no |
| `conflict_list` | Fields two machines set differently | `staple cloud conflicts` | no |
| `conflict_resolve` | Settle one conflict | `staple cloud resolve` | yes |

Connecting, disconnecting, automatic sync, backups, revoking and purging have no
tool. They are a person's decisions.

## Several repositories

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `hub_overview` | Every workspace on this machine, and the links between them | `staple hub` | no |
| `cross_link` | Make a ticket wait on a ticket in another repository | `staple link` | yes |
| `cross_unlink` | Remove that link | `staple hub unlink` | yes |
| `hub_unregister` | Drop one workspace from this machine's list | `staple hub unregister` | yes |
| `hub_prune` | Drop entries whose folder is gone; previews unless `apply` | `staple hub prune` | yes |

## Budget and estimates

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `set_estimate` | Change only the estimate; `null` clears it | `staple estimate` | yes |
| `compare_plans` | Labor, estimate coverage and the longest chain of named tickets | `staple compare` | no |
| `forecast` | Work left under a ticket, and what it costs your usage limits | `staple forecast` | no |
| `calibration_cohorts` | How long each kind of work takes against its estimate | `staple calibrate` | no |
| `timing_quality` | How much of the recorded time can be trusted | `staple timing quality` | no |
| `list_attempts` | Every agent session on a ticket | `staple attempts` | no |
| `get_attempt` | One session in detail | `staple attempt <id>` | no |
| `get_budget` | Each account's usage limits and pace | `staple budget` | no |
| `list_budget_samples` | One account's usage readings | `staple budget history` | no |
| `record_budget_sample` | Record a usage reading; refused until a person turns capture on | `staple budget ingest` | yes |
| `forget_budget_samples` | Remove wrong readings; previews unless `confirm: true` | `staple budget forget` | yes |

Turning budget capture on is a person's decision and has no tool
([Budget and estimates](budget-and-estimates.md)).

## Setup and settings

| Tool | What it does | CLI | Writes |
|---|---|---|---|
| `init` | Create a workspace when a tool reports there is none | `staple init` | yes |
| `get_setting` | Read a workspace setting, such as `queue.policy` | `staple settings get` | no |
| `set_setting` | Change a workspace setting | `staple settings set` | yes |
| `list_statuses` | This workspace's statuses | `staple statuses ls` | no |
| `update_statuses` | Add, rename, reorder or remove statuses | `staple statuses add` (and the rest) | yes |
| `list_kinds` | This workspace's kinds | `staple kinds ls` | no |
| `update_kinds` | Add, rename, reorder or remove kinds | `staple kinds add` (and the rest) | yes |

Change settings, statuses, kinds or the queue order only because a person asked.

## When a tool refuses

A refusal is a tool result with `isError` and an object with `code`, `message`,
`detail` and `retryable`. The four an agent meets most:

- `conflict`: someone else has it. Pick a different ticket; do not retry.
- `gated`: a person must approve first. Pick a different ticket.
- `out_of_order`: the plan puts another ticket first. Take `detail.expected[0]`.
- `revision_conflict`: someone changed it since you read it. Read again, then retry.

[Errors and exit codes](errors.md) lists every code.

Going deeper: [the MCP tools in detail](../design/mcp-tools.md) has the argument
and answer shapes.
